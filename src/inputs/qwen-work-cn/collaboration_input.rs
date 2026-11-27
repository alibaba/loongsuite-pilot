use super::collaboration_parser::{self, SOURCE};
use crate::checkpoints::{InputStatePatch, StateStore};
use crate::inputs::base::{
    HostedInput, InputBody, InputRuntime, InputRuntimeDelta, InputRuntimeInfo, WorkspacePolicy,
};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::file_identity::{identity_from_open, path_from_opened_file};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::Mutex;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_READS_PER_CYCLE: usize = 2;
const MAX_SCAN_STEPS: usize = 128;
const MAX_TURNS_PER_CYCLE: usize = 100;
const MAX_COMPLETED: usize = 50_000;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_FILES: usize = 256;

pub(crate) struct QwenWorkCnCollaborationInput(
    pub(crate) Arc<HostedInput<CollaborationBody>>,
    String,
);

impl QwenWorkCnCollaborationInput {
    pub(crate) fn new(
        root: PathBuf,
        included: Option<&[String]>,
        state_store: Arc<StateStore>,
        poll_interval_ms: Option<u64>,
    ) -> Self {
        let source_path = root.to_string_lossy().into_owned();
        let input = HostedInput::new(
            CollaborationBody {
                root,
                included: included.map(|items| items.iter().cloned().collect()),
                state: Mutex::new(CollectorState::default()),
            },
            "QwenWorkCNCollaborationInput",
            state_store,
            poll_interval_ms,
        );
        Self(input, source_path)
    }

    pub(crate) fn collector_runtime_info(&self) -> InputRuntimeInfo {
        let mut info = self.0.runtime.runtime_info();
        info.source_paths.push(self.1.clone());
        info
    }

    pub(crate) fn set_collector_workspace_policy(&self, policy: WorkspacePolicy) {
        self.0.runtime.set_workspace_policy(policy);
    }

    pub(crate) fn collector_running(&self) -> bool {
        self.0.running()
    }

    pub(crate) async fn start(&self) -> Result<(), String> {
        self.0.start().await
    }

    pub(crate) async fn stop(&self) -> Result<(), String> {
        self.0.stop().await
    }

    pub(crate) fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.0.on_entries(on_entries);
        self.0.on_runtime_delta(on_delta);
    }

    pub(crate) fn bind_sdk_collector(
        &self,
        on_entries: impl Fn(Vec<AgentActivityEntry>) + Send + Sync + 'static,
        on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.0.set_owned_entries_handler(on_entries);
        self.0.on_runtime_delta(on_delta);
    }
}

pub(crate) fn resolve_root() -> PathBuf {
    let home = PathBuf::from(crate::utils::resolve_home("~"));
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .filter(|path| !path.is_empty())
            .map_or_else(|| home.join("AppData/Roaming"), PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map_or_else(|| home.join(".config"), PathBuf::from)
    };
    base.join("QwenWorkCN/data/collaboration")
}

pub(crate) struct CollaborationBody {
    root: PathBuf,
    included: Option<HashSet<String>>,
    state: Mutex<CollectorState>,
}

#[derive(Default)]
struct CollectorState {
    scan: Option<DirectoryScan>,
    cache: VecDeque<(PathBuf, FileStamp)>,
    warnings: HashSet<&'static str>,
    pending: Option<Pending>,
}

struct Pending {
    progress: Option<Checkpoint>,
    cache: Vec<(PathBuf, FileStamp)>,
}

impl CollectorState {
    fn warn_once(&mut self, rt: &InputRuntime, kind: &'static str, text: &str) {
        if self.warnings.insert(kind) {
            rt.warn(text, None);
        }
    }

    fn accept(&mut self, pending: Pending, rt: &InputRuntime) {
        for (file, stamp) in pending.cache {
            self.cache.retain(|(saved, _)| saved != &file);
            self.cache.push_back((file, stamp));
            if self.cache.len() > MAX_CACHED_FILES {
                self.cache.pop_front();
            }
        }
        if let Some(progress) = pending.progress {
            rt.update_state(InputStatePatch {
                extra: Some(json!({"collaboration": progress})),
                ..InputStatePatch::default()
            });
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    version: u8,
    since_ms: i64,
    completed: BTreeMap<String, i64>,
}

pub(crate) fn has_usable_collaboration_cursor(state: &crate::checkpoints::InputState) -> bool {
    state
        .extra()
        .and_then(|mut extra| {
            serde_json::from_value::<Checkpoint>(extra.get_mut("collaboration")?.take()).ok()
        })
        .is_some_and(|checkpoint| checkpoint.version == 1 && checkpoint.since_ms >= 0)
}

struct DirectoryScan {
    root: Arc<PathBuf>,
    environments: tokio::fs::ReadDir,
    accounts: Option<tokio::fs::ReadDir>,
    pending_paths: VecDeque<PathBuf>,
}

enum ScanStep {
    Candidate(PathBuf),
    Empty,
    Done,
}

impl DirectoryScan {
    async fn new(root: &Path) -> io::Result<Self> {
        crate::utils::source_access::check(root)?;
        let root = tokio::fs::canonicalize(root).await?;
        crate::utils::source_access::check(&root)?;
        let environments = tokio::fs::read_dir(&root).await?;
        Ok(Self {
            root: Arc::new(root),
            environments,
            accounts: None,
            pending_paths: VecDeque::new(),
        })
    }

    async fn step(&mut self) -> io::Result<ScanStep> {
        if let Some(path) = self.pending_paths.pop_front() {
            return Ok(ScanStep::Candidate(path));
        }
        if let Some(accounts) = self.accounts.as_mut() {
            if let Some(account) = accounts.next_entry().await? {
                if account.file_type().await?.is_dir() {
                    let account = account.path();
                    crate::utils::source_access::check(&account)?;
                    let channel = account.join("channel-v1");
                    if tokio::fs::symlink_metadata(&channel)
                        .await
                        .is_ok_and(|meta| meta.is_dir())
                    {
                        self.pending_paths.push_back(channel.join("state.json"));
                    }
                    self.pending_paths.push_back(account.join("state.json"));
                }
            } else {
                self.accounts = None;
            }
            return Ok(ScanStep::Empty);
        }
        let Some(environment) = self.environments.next_entry().await? else {
            return Ok(ScanStep::Done);
        };
        if environment.file_type().await?.is_dir() {
            let path = environment.path();
            crate::utils::source_access::check(&path)?;
            self.accounts = Some(tokio::fs::read_dir(path).await?);
        }
        Ok(ScanStep::Empty)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    identity: String,
    size: u64,
    modified: SystemTime,
    change_time: (i64, i64),
}

fn open_stamp(root: &Path, path: &Path) -> anyhow::Result<(File, FileStamp)> {
    anyhow::ensure!(
        std::fs::symlink_metadata(path)?.is_file(),
        "source is not a regular file"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = if crate::utils::source_access::current().is_some() {
        crate::utils::source_access::open(path)?
    } else {
        options.open(path)?
    };
    anyhow::ensure!(
        path_from_opened_file(&file)?.starts_with(root),
        "source is outside the collaboration directory"
    );
    let identity = identity_from_open(&file)?;
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let change_time = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime(), metadata.ctime_nsec())
    };
    #[cfg(not(unix))]
    let change_time = (0, 0);
    Ok((
        file,
        FileStamp {
            identity: identity.checkpoint_key(),
            size: metadata.len(),
            modified: metadata.modified()?,
            change_time,
        },
    ))
}

enum Snapshot {
    None,
    TooLarge,
    Changed(FileStamp, Vec<u8>),
}

fn read_snapshot(root: &Path, path: &Path, cached: Option<&FileStamp>) -> anyhow::Result<Snapshot> {
    let (file, stamp) = match open_stamp(root, path) {
        Ok(value) => value,
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            return Ok(Snapshot::None);
        }
        Err(error) => return Err(error),
    };
    if cached == Some(&stamp) {
        return Ok(Snapshot::None);
    }
    let read_limit = crate::utils::source_access::read_limit(MAX_FILE_BYTES as usize) as u64;
    if stamp.size > read_limit {
        return Ok(Snapshot::TooLarge);
    }
    let mut bytes = Vec::with_capacity(stamp.size as usize);
    file.take(stamp.size + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 == stamp.size && open_stamp(root, path)?.1 == stamp,
        "collaboration snapshot changed"
    );
    Ok(Snapshot::Changed(stamp, bytes))
}

#[async_trait]
impl InputBody for CollaborationBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![SOURCE.into()])
    }

    fn id(&self) -> &str {
        SOURCE
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QwenWorkCN
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        let saved = rt.state().extra();
        if saved
            .as_ref()
            .and_then(|extra| extra.get("collaboration"))
            .is_none()
        {
            self.state.lock().await.accept(
                Pending {
                    progress: Some(Checkpoint {
                        version: 1,
                        since_ms: chrono::Utc::now().timestamp_millis(),
                        completed: BTreeMap::new(),
                    }),
                    cache: Vec::new(),
                },
                rt,
            );
        }
        Ok(())
    }

    async fn on_stop(&self, _: &InputRuntime) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        state.scan = None;
        state.cache.clear();
        state.pending = None;
        Ok(())
    }

    async fn on_entries_queued(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        if let Some(pending) = state.pending.take() {
            state.accept(pending, rt);
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut state = self.state.lock().await;
        state.pending = None;
        let saved = rt.state().extra().unwrap_or_default();
        let checkpoint = saved.get("collaboration").cloned().unwrap_or_default();
        let mut progress = match serde_json::from_value::<Checkpoint>(checkpoint) {
            Ok(progress) if progress.version == 1 && progress.since_ms >= 0 => progress,
            _ => {
                state.warn_once(
                    rt,
                    "checkpoint",
                    "Unsupported collaboration checkpoint; preserving source progress",
                );
                return Ok(Vec::new());
            }
        };
        if self.included.as_ref().is_some_and(HashSet::is_empty) {
            return Ok(Vec::new());
        }
        if state.scan.is_none() {
            match DirectoryScan::new(&self.root).await {
                Ok(scan) => state.scan = Some(scan),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(_) => {
                    state.warn_once(
                        rt,
                        "scan",
                        "Collaboration directory is unreadable; will retry",
                    );
                    return Ok(Vec::new());
                }
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        let observed = (i128::from(now) * 1_000_000).to_string();
        let cutoff = progress.since_ms.max(now - RETENTION_MS);
        let before = progress.completed.len();
        progress.completed.retain(|_, time| *time >= cutoff);
        let pruned = progress.completed.len() != before;
        if pruned {
            progress.since_ms = cutoff;
        }
        let mut cache = Vec::new();
        let mut entries = Vec::new();
        let mut reads = 0;
        for _ in 0..MAX_SCAN_STEPS {
            let scan = state.scan.as_mut().expect("scan started");
            let file = match scan.step().await {
                Ok(ScanStep::Candidate(file)) => file,
                Ok(ScanStep::Empty) => continue,
                Ok(ScanStep::Done) => {
                    state.scan = None;
                    break;
                }
                Err(_) => {
                    state.warn_once(
                        rt,
                        "scan",
                        "Part of the collaboration directory is unreadable; will retry",
                    );
                    continue;
                }
            };
            let root = Arc::clone(&scan.root);
            let read_file = file.clone();
            let cached = state
                .cache
                .iter()
                .find(|(saved, _)| saved == &file)
                .map(|(_, stamp)| stamp.clone());
            let scope = crate::utils::source_access::current();
            let result = tokio::task::spawn_blocking(move || {
                struct Restore(Option<Arc<crate::utils::source_access::SourceScope>>);
                impl Drop for Restore {
                    fn drop(&mut self) {
                        crate::utils::source_access::install(self.0.take());
                    }
                }
                let _restore = Restore(crate::utils::source_access::current());
                crate::utils::source_access::install(scope);
                read_snapshot(&root, &read_file, cached.as_ref())
            })
            .await?;
            let (stamp, bytes) = match result {
                Ok(Snapshot::None) => continue,
                Ok(Snapshot::Changed(stamp, bytes)) => (stamp, bytes),
                Ok(Snapshot::TooLarge) => {
                    state.warn_once(
                        rt,
                        "size",
                        "Collaboration state exceeds the configured read limit; retaining source progress",
                    );
                    continue;
                }
                Err(_) => {
                    state.warn_once(
                        rt,
                        "read",
                        "Collaboration state changed during reading; will retry",
                    );
                    continue;
                }
            };
            reads += 1;
            let snapshot = serde_json::from_slice::<Value>(&bytes);
            let parsed = snapshot.as_ref().ok().and_then(|snapshot| {
                collaboration_parser::turns(snapshot, self.included.as_ref(), &observed).ok()
            });
            if let Some(turns) = parsed {
                let mut complete = true;
                for turn in turns {
                    if turn.completed_at_ms < cutoff || progress.completed.contains_key(&turn.key) {
                        continue;
                    }
                    if entries.len() == MAX_TURNS_PER_CYCLE * 2
                        || progress.completed.len() >= MAX_COMPLETED
                    {
                        complete = false;
                        state.warn_once(
                            rt,
                            "capacity",
                            "Collaboration collection is backlogged; will retry",
                        );
                        break;
                    }
                    progress.completed.insert(turn.key, turn.completed_at_ms);
                    entries.extend(turn.entries);
                }
                if complete {
                    cache.push((file, stamp));
                }
            } else {
                state.warn_once(
                    rt,
                    "format",
                    "Unsupported collaboration state format; will retry",
                );
            }
            if reads >= MAX_READS_PER_CYCLE || entries.len() >= MAX_TURNS_PER_CYCLE * 2 {
                break;
            }
        }
        state.pending = Some(Pending {
            progress: (pruned || !entries.is_empty()).then_some(progress),
            cache,
        });
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as SyncMutex;

    fn fixture(start: i64, conversation: &str, sender: &str, reply_id: &str) -> Value {
        json!({
            "version":1,
            "accounts":{
                "account":{
                    "userId":"owner",
                    "orgId":"org",
                    "messages":{
                        "prompt":{
                            "messageId":"prompt", "conversationId":conversation, "text":"synthetic prompt",
                            "createdAt":{"seconds":start,"nanos":1},
                            "sender":{"id":sender,"type":"HUMAN"}
                        },
                        reply_id:{
                            "messageId":reply_id,"conversationId":conversation,"replyToMessageId":"prompt",
                            "sender":{"id":"agent","type":"AGENT"},"cardRef":{"cardId":"card"}
                        }
                    },
                    "cards":{
                        "card":{
                            "cardId":"card","resourceState":"AVAILABLE","contentStatus":"FINAL",
                            "messageLink":{"cid":conversation,"messageId":reply_id},
                            "terminalAt":{"seconds":start + 1,"nanos":0},"content":"synthetic result"
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn collaboration_enforces_account_scope_permission_and_terminal_card() {
        let current = 1_790_000_000;
        let source = fixture(current, "allowed", "owner", "reply");
        let allowed = HashSet::from(["allowed".to_owned()]);
        let entries = collaboration_parser::turns(&source, Some(&allowed), "0")
            .unwrap()
            .next()
            .unwrap()
            .entries;
        assert!(entries.iter().all(|entry| entry.is_qwen_collaboration()
            && entry.get("loongsuite.observation.scope") == Some(&json!("agent_turn"))));
        assert_eq!(entries[0].turn_start, Some(true));
        assert_eq!(entries[1].turn_end, Some(true));
        assert_eq!(entries[0].turn_id, entries[1].turn_id);
        assert_ne!(entries[0].event_id, entries[1].event_id);
        let serialized = serde_json::to_value(&entries[1]).unwrap();
        assert!(serialized.get("gen_ai.response.model").is_none());
        assert!(serialized.get("gen_ai.usage.input_tokens").is_none());

        let denied = HashSet::from(["different".to_owned()]);
        assert!(collaboration_parser::turns(&source, Some(&denied), "0")
            .unwrap()
            .next()
            .is_none());
        let observer = fixture(current, "allowed", "another-user", "reply");
        assert!(collaboration_parser::turns(&observer, None, "0")
            .unwrap()
            .next()
            .is_none());
        let mut revoked = source.clone();
        revoked["accounts"]["account"]["attention"] =
            json!({"denied": {"[\"allowed\",\"\"]":true}});
        assert!(collaboration_parser::turns(&revoked, None, "0")
            .unwrap()
            .next()
            .is_none());
        let mut partial = source;
        partial["accounts"]["account"]["cards"]["card"]["partial"] = json!(true);
        assert!(collaboration_parser::turns(&partial, None, "0")
            .unwrap()
            .next()
            .is_none());
    }

    #[tokio::test]
    async fn collaboration_reads_channel_and_legacy_without_replaying_checkpointed_turns() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("collaboration");
        let account = root.join("test-environment/account");
        let channel = account.join("channel-v1");
        std::fs::create_dir_all(&channel).unwrap();
        let now = chrono::Utc::now().timestamp();
        std::fs::write(
            channel.join("state.json"),
            fixture(now + 1, "allowed", "owner", "first").to_string(),
        )
        .unwrap();
        std::fs::write(
            account.join("state.json"),
            fixture(now - 10, "allowed", "owner", "historical").to_string(),
        )
        .unwrap();
        let checkpoint = sandbox.path().join("progress.json");
        let store = Arc::new(StateStore::new(&checkpoint));
        let input =
            QwenWorkCnCollaborationInput::new(root.clone(), None, Arc::clone(&store), Some(60_000));
        let seen = Arc::new(SyncMutex::new(Vec::new()));
        let subscriber = Arc::clone(&seen);
        input.bind_collector(
            move |entries| subscriber.lock().unwrap().extend_from_slice(entries),
            |_| {},
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
        store.save().await.unwrap();
        let first: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.event_id.clone())
            .collect();
        assert_eq!(first.len(), 2);

        let store = Arc::new(StateStore::new(&checkpoint));
        store.load().await;
        std::fs::write(
            account.join("state.json"),
            fixture(now + 2, "allowed", "owner", "second").to_string(),
        )
        .unwrap();
        let input = QwenWorkCnCollaborationInput::new(root, None, store, Some(60_000));
        let subscriber = Arc::clone(&seen);
        input.bind_collector(
            move |entries| subscriber.lock().unwrap().extend_from_slice(entries),
            |_| {},
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
        let restarted = seen.lock().unwrap();
        assert_eq!(restarted.len(), 4);
        assert!(restarted[2..]
            .iter()
            .all(|entry| !first.contains(&entry.event_id)));
    }

    #[tokio::test]
    async fn failed_sdk_accept_freezes_progress_and_restart_replays_same_events() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("collaboration");
        let account = root.join("environment/account");
        std::fs::create_dir_all(&account).unwrap();
        let now = chrono::Utc::now().timestamp();
        std::fs::write(
            account.join("state.json"),
            fixture(now + 1, "allowed", "owner", "first").to_string(),
        )
        .unwrap();
        let checkpoint = sandbox.path().join("checkpoint.json");
        let store = Arc::new(StateStore::new(&checkpoint));
        store.update(
            SOURCE,
            InputStatePatch {
                extra: Some(json!({"collaboration": {
                    "version": 1, "sinceMs": (now - 1) * 1000, "completed": {}
                }})),
                ..Default::default()
            },
        );
        store.save().await.unwrap();
        let input =
            QwenWorkCnCollaborationInput::new(root.clone(), None, Arc::clone(&store), Some(60_000));
        let seen = Arc::new(SyncMutex::new(Vec::new()));
        let subscriber = Arc::clone(&seen);
        input.bind_collector(
            move |entries| {
                subscriber.lock().unwrap().push(
                    entries
                        .iter()
                        .map(|entry| entry.event_id.clone())
                        .collect::<Vec<_>>(),
                )
            },
            |_| {},
        );
        let attempts = Arc::new(AtomicUsize::new(0));
        let accept_attempts = Arc::clone(&attempts);
        input.0.set_cycle_hooks(
            Arc::new(|| Box::pin(async { Ok(()) })),
            Arc::new(move || {
                let attempt = accept_attempts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if attempt == 0 {
                        anyhow::bail!("simulated outbox failure");
                    }
                    Ok(())
                })
            }),
        );
        input.start().await.unwrap();
        input.0.run_cycle().await;
        assert!(
            store.save_failed_for(SOURCE),
            "failed acceptance must freeze mutated progress"
        );
        input.stop().await.unwrap();

        let store = Arc::new(StateStore::new(&checkpoint));
        store.load().await;
        let restarted = QwenWorkCnCollaborationInput::new(root, None, store, Some(60_000));
        let subscriber = Arc::clone(&seen);
        restarted.bind_collector(
            move |entries| {
                subscriber.lock().unwrap().push(
                    entries
                        .iter()
                        .map(|entry| entry.event_id.clone())
                        .collect::<Vec<_>>(),
                )
            },
            |_| {},
        );
        restarted.start().await.unwrap();
        restarted.0.run_cycle().await;
        restarted.stop().await.unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.len(),
            2,
            "only the rejected and recovered batches should be observed"
        );
        assert_eq!(seen[0].len(), 2);
        assert_eq!(seen[0], seen[1], "retry must keep stable event IDs");
    }

    #[cfg(unix)]
    #[test]
    fn collaboration_sdk_source_rejects_symlinks_outside_authorized_root() {
        use std::os::unix::fs::symlink;

        struct Restore(Option<Arc<crate::utils::source_access::SourceScope>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                crate::utils::source_access::install(self.0.take());
            }
        }
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("collaboration");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let outside = sandbox.path().join("outside.json");
        std::fs::write(&outside, b"{}").unwrap();
        let link = root.join("state.json");
        symlink(&outside, &link).unwrap();
        let _restore = Restore(crate::utils::source_access::current());
        crate::utils::source_access::install(Some(crate::utils::source_access::SourceScope::new(
            vec![root.clone()],
            4,
            1024,
        )));
        assert!(read_snapshot(&root, &link, None).is_err());
    }
}
