mod events;
mod media;
mod sqlite;
mod transcript;

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use events::{Progress, Session};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlite::Snapshot;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use transcript::Transcript;

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};

const STATE: &str = "antigravityCheckpoint";
const CAPACITY: usize = 16;
const BOOTSTRAP_LIMIT: usize = 8_192;

pub(crate) struct AntigravityInput {
    pub(crate) inner: Arc<HostedInput<AntigravityBody>>,
}

pub(crate) struct AntigravityBody {
    client: ClientType,
    root: PathBuf,
    historical: bool,
    media: Mutex<Option<media::Policy>>,
    host: std::sync::OnceLock<Weak<HostedInput<Self>>>,
    watch: Mutex<Option<notify::RecommendedWatcher>>,
    pending: Mutex<Option<Checkpoint>>,
    cache: Arc<Mutex<Cache>>,
}

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Checkpoint {
    schema: u8,
    seeded: bool,
    sessions: BTreeMap<String, Progress>,
    pending_seed_session_ids: Vec<String>,
}

#[derive(Default)]
struct Cache {
    sessions: HashMap<String, Cached>,
    position: Option<String>,
}

#[derive(Default)]
struct Cached {
    written: Option<Stamp>,
    next_audit: i64,
    last_access: i64,
    snapshot: Snapshot,
    transcript: Transcript,
}

#[derive(Clone, PartialEq)]
struct Stamp {
    database: Fingerprint,
    wal: Option<Fingerprint>,
    transcript: Option<Fingerprint>,
}

#[derive(Clone, PartialEq)]
struct Fingerprint {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl Fingerprint {
    fn read(path: &Path) -> Result<Option<Self>> {
        match std::fs::symlink_metadata(path) {
            Ok(info) if info.is_file() => {
                crate::utils::runtime_paths::runtime_metadata(path)?;
                Ok(Some(Self {
                    len: info.len(),
                    modified: info.modified().ok(),
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(_) => anyhow::bail!("unexpected Antigravity source type"),
            Err(error) => Err(error.into()),
        }
    }
}

impl AntigravityInput {
    pub(crate) fn new(client: ClientType, state: Arc<StateStore>, poll: Option<u64>) -> Self {
        Self::with_root(client, state, poll, Self::root(client), false)
    }

    fn with_root(
        client: ClientType,
        state: Arc<StateStore>,
        poll: Option<u64>,
        root: PathBuf,
        historical: bool,
    ) -> Self {
        let body = AntigravityBody {
            client,
            root,
            historical,
            media: Mutex::new(None),
            host: std::sync::OnceLock::new(),
            watch: Mutex::new(None),
            pending: Mutex::new(None),
            cache: Arc::new(Mutex::new(Cache::default())),
        };
        let inner = HostedInput::new(
            body,
            "AntigravityInput",
            state,
            poll.or(Some(crate::utils::DEFAULT_ANTIGRAVITY_POLL_INTERVAL_MS)),
        );
        let _ = inner.body.host.set(Arc::downgrade(&inner));
        Self { inner }
    }

    pub(crate) fn with_multimodal(
        self,
        policy: Option<(
            Arc<crate::multimodal::MultimodalProcessor>,
            crate::types::AgentMultimodalConfig,
        )>,
    ) -> Self {
        if let Some((processor, configuration)) = policy {
            let mut roots = configuration.allowed_root_paths.unwrap_or_default();
            roots.push(
                self.inner
                    .body
                    .root
                    .join("brain")
                    .to_string_lossy()
                    .into_owned(),
            );
            *self.inner.body.media.lock().unwrap() = Some(media::Policy {
                processor,
                roots,
                mode: configuration.upload_mode,
            });
        }
        self
    }

    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        let mut info = self.inner.runtime.runtime_info();
        info.source_paths = Self::watch_paths(self.inner.agent_type());
        info
    }

    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }

    pub(crate) fn collector_running(&self) -> bool {
        self.inner.running()
    }
    pub(crate) async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }
    pub(crate) async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub(crate) fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    fn root(client: ClientType) -> PathBuf {
        crate::utils::resolve_home(&format!("~/.gemini/{}", client.as_str())).into()
    }

    pub(crate) fn watch_paths(client: ClientType) -> Vec<String> {
        let root = Self::root(client);
        [root.clone(), root.join("conversations")]
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }

    pub(crate) async fn available(client: ClientType) -> bool {
        tokio::fs::symlink_metadata(Self::root(client))
            .await
            .is_ok_and(|info| info.is_dir())
    }
}

#[async_trait]
impl InputBody for AntigravityBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().into()])
    }

    fn id(&self) -> &str {
        self.client.as_str()
    }
    fn agent_type(&self) -> ClientType {
        self.client
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SqlitePolling
    }

    async fn on_start(&self, _: &InputRuntime) -> Result<()> {
        use notify::Watcher;
        let Some(weak) = self.host.get().cloned() else {
            return Ok(());
        };
        let handle = tokio::runtime::Handle::current();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if event.kind.is_access()
                        || !event.paths.iter().any(|path| {
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| {
                                    name.ends_with(".db") || name.ends_with(".db-wal")
                                })
                        })
                    {
                        return;
                    }
                    if let Some(host) = weak.upgrade() {
                        let _guard = handle.enter();
                        host.request_collection();
                    }
                }
            })?;
        if watcher
            .watch(
                &self.root.join("conversations"),
                notify::RecursiveMode::NonRecursive,
            )
            .is_ok()
        {
            *self.watch.lock().unwrap() = Some(watcher);
        }
        Ok(())
    }

    async fn on_stop(&self, _: &InputRuntime) -> Result<()> {
        self.watch.lock().unwrap().take();
        *self.cache.lock().unwrap() = Cache::default();
        self.pending.lock().unwrap().take();
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> Result<Vec<AgentActivityEntry>> {
        self.pending.lock().unwrap().take();
        let old = rt
            .state()
            .extra()
            .and_then(|extra| extra.get(STATE).cloned())
            .and_then(|value| serde_json::from_value::<Checkpoint>(value).ok())
            .unwrap_or_default();
        let root = self.root.clone();
        let client = self.client;
        let current = old.clone();
        let cache = self.cache.clone();
        let historical = self.historical;
        let media = self.media.lock().unwrap().clone();
        let allow_media = media
            .as_ref()
            .map_or((false, false), |policy| policy.directions());
        let batch = tokio::task::spawn_blocking(move || {
            scan(
                &root,
                client,
                historical,
                current,
                &mut cache.lock().unwrap(),
                allow_media,
            )
        })
        .await??;
        if !batch.failures.is_empty() {
            rt.logger.warn(
                "Antigravity source is unavailable; retaining collection progress",
                json!({"sources":batch.failures.len()}).as_object(),
            );
        }
        let mut entries: Vec<AgentActivityEntry> = rt.with_workspace_policy(|policy| {
            batch
                .entries
                .into_iter()
                .filter_map(|(paths, entries)| {
                    if policy.enabled()
                        && (paths.is_empty() || paths.iter().any(|path| policy.excludes(path)))
                    {
                        None
                    } else {
                        Some(entries)
                    }
                })
                .flatten()
                .collect()
        });
        for entry in &mut entries {
            media::enrich(entry, media.as_ref()).await;
            if let Some(workspace) = entry.workspace_path.clone() {
                let context = json!({"agent.antigravity.cwd":workspace});
                let _ = crate::normalization::enrich_canonical_entry_with_git(
                    entry,
                    context.as_object().expect("workspace context"),
                    "antigravity",
                )
                .await;
            }
        }
        if batch.checkpoint != old {
            *self.pending.lock().unwrap() = Some(batch.checkpoint);
        }
        Ok(entries)
    }

    async fn on_entries_queued(&self, rt: &InputRuntime) -> Result<()> {
        if let Some(checkpoint) = self.pending.lock().unwrap().take() {
            rt.update_state(InputStatePatch {
                extra: Some(json!({ (STATE): checkpoint })),
                ..InputStatePatch::default()
            });
        }
        Ok(())
    }
}

struct Batch {
    checkpoint: Checkpoint,
    entries: Vec<(Vec<String>, Vec<AgentActivityEntry>)>,
    failures: Vec<serde_json::Map<String, serde_json::Value>>,
}

fn scan(
    root: &Path,
    client: ClientType,
    historical: bool,
    mut state: Checkpoint,
    cache: &mut Cache,
    media: (bool, bool),
) -> Result<Batch> {
    let directory = root.join("conversations");
    if matches!(std::fs::symlink_metadata(&directory), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(Batch {
            checkpoint: state,
            entries: Vec::new(),
            failures: Vec::new(),
        });
    }
    ensure!(
        crate::utils::runtime_paths::runtime_metadata(root)?.is_dir(),
        "invalid Antigravity data root"
    );
    ensure!(
        crate::utils::runtime_paths::runtime_metadata(&directory)?.is_dir(),
        "invalid Antigravity conversations directory"
    );
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(&directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".db")) else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        ensure!(
            ids.len() < BOOTSTRAP_LIMIT,
            "Antigravity conversation inventory capacity"
        );
        ids.push(id.to_owned());
    }
    ids.sort_unstable();
    if !state.seeded {
        if !historical {
            for id in &ids {
                state.sessions.entry(id.clone()).or_default().seed_pending();
            }
        }
        state.schema = 1;
        state.seeded = true;
    }
    for id in std::mem::take(&mut state.pending_seed_session_ids) {
        state.sessions.entry(id).or_default().seed_pending();
    }
    let mut entries = Vec::new();
    let mut failures = Vec::new();
    let now = chrono::Utc::now().timestamp_millis();
    let cursor = cache
        .position
        .as_ref()
        .map_or(0, |id| ids.partition_point(|value| value <= id));
    let mut scanned = 0;
    for id in ids[cursor..].iter().chain(&ids[..cursor]) {
        if scanned == CAPACITY {
            break;
        }
        cache.position = Some(id.clone());
        let db = directory.join(format!("{id}.db"));
        let transcript = root
            .join("brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl");
        let stamp = || -> Result<Stamp> {
            Ok(Stamp {
                database: Fingerprint::read(&db)?.context("Antigravity database disappeared")?,
                wal: Fingerprint::read(&directory.join(format!("{id}.db-wal")))?,
                transcript: Fingerprint::read(&transcript)?,
            })
        };
        let stamp = match stamp() {
            Ok(stamp) => stamp,
            Err(_) => {
                failures.push(
                    json!({"reason":"source_metadata"})
                        .as_object()
                        .unwrap()
                        .clone(),
                );
                continue;
            }
        };
        let cached = cache.sessions.entry(id.clone()).or_default();
        let audit = cached.next_audit <= now;
        if cached.written.as_ref() == Some(&stamp)
            && !audit
            && !cached.snapshot.more
            && !cached.transcript.more
        {
            continue;
        }
        scanned += 1;
        cached.last_access = now;
        let known = state.sessions.get(id).cloned().unwrap_or_default();
        let mut progress = known.clone();
        let result = (|| -> Result<Vec<AgentActivityEntry>> {
            let changed = cached.transcript.scan(&transcript)?;
            cached.snapshot.scan(&db, &changed, audit)?;
            if cached.snapshot.more || cached.transcript.more {
                return Ok(Vec::new());
            }
            let session = Session {
                client,
                id,
                db: &cached.snapshot,
                steps: cached.transcript.rows(),
                now,
                media,
            };
            Ok(session.collect(&mut progress))
        })();
        match result {
            Ok(found) => {
                let more = cached.snapshot.more || cached.transcript.more;
                cached.written = Some(stamp);
                // Poll incomplete rows again even when the underlying file size remains stable.
                cached.next_audit = now + if more { 0 } else { 30_000 };
                if progress != known {
                    state.sessions.insert(id.clone(), progress);
                }
                if !known.baseline() && !found.is_empty() {
                    entries.push((cached.snapshot.roots.clone(), found));
                }
            }
            Err(_) => {
                cached.next_audit = now + 15_000;
                failures.push(json!({"reason":"source_read"}).as_object().unwrap().clone());
            }
        }
        if cache.sessions.len() > CAPACITY {
            if let Some(oldest) = cache
                .sessions
                .iter()
                .filter(|(name, _)| *name != id)
                .min_by_key(|(_, value)| value.last_access)
                .map(|(key, _)| key.clone())
            {
                cache.sessions.remove(&oldest);
            }
        }
    }
    Ok(Batch {
        checkpoint: state,
        entries,
        failures,
    })
}

fn valid_id(id: &str) -> bool {
    id != "conversation_summaries"
        && !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    // A real SQLite database, original Antigravity field numbers, and a
    // companion transcript. No installed client or account is required.
    #[test]
    fn baseline_and_restart_keep_token_usage_and_trace_ids_without_replay() {
        for client in [ClientType::Antigravity, ClientType::AntigravityCli] {
            let root = tempfile::tempdir().unwrap();
            let conversations = root.path().join("conversations");
            std::fs::create_dir_all(&conversations).unwrap();
            let logs = root.path().join("brain/session/.system_generated/logs");
            std::fs::create_dir_all(&logs).unwrap();
            let db = Connection::open(conversations.join("session.db")).unwrap();
            db.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);").unwrap();
            let transcript = logs.join("transcript.jsonl");
            let rollout = |idx: i64| {
                format!(
                "{{\"step_index\":{idx},\"type\":\"USER_INPUT\",\"content\":\"query\",\"created_at\":\"2026-11-24T03:00:00.000Z\"}}\n{{\"step_index\":{},\"type\":\"PLANNER_RESPONSE\",\"content\":\"answer\",\"created_at\":\"2026-11-24T03:00:01.000Z\"}}\n", idx+1)
            };
            // steps.metadata.9 = usage; models/tokens/message IDs use native field tags.
            let usage = |id: u8| {
                [
                    0x4a, 13, 0x10, 17, 0x18, 9, 0x20, 3, 0x28, 2, 0x48, 4, 0x5a, 1, id,
                ]
            };
            let first = rollout(0);
            std::fs::write(&transcript, &first).unwrap();
            db.execute("INSERT INTO steps VALUES (1, ?1)", [usage(b'a').as_slice()])
                .unwrap();
            let mut cache = Cache::default();
            let first_batch = scan(
                root.path(),
                client,
                false,
                Checkpoint::default(),
                &mut cache,
                (false, false),
            )
            .unwrap();
            assert!(first_batch.entries.is_empty());
            assert_eq!(
                first_batch.checkpoint.sessions["session"]
                    .emitted_usage_keys
                    .len(),
                2
            );

            std::fs::write(&transcript, format!("{first}{}", rollout(2))).unwrap();
            db.execute("INSERT INTO steps VALUES (3, ?1)", [usage(b'b').as_slice()])
                .unwrap();
            let saved: Checkpoint =
                serde_json::from_slice(&serde_json::to_vec(&first_batch.checkpoint).unwrap())
                    .unwrap();
            let next = scan(
                root.path(),
                client,
                false,
                saved,
                &mut Cache::default(),
                (false, false),
            )
            .unwrap();
            let entries = &next.entries[0].1;
            assert_eq!(entries.len(), 3);
            let response = entries
                .iter()
                .find(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmResponse))
                .unwrap();
            assert_eq!(response.input_tokens, Some(22));
            assert_eq!(response.output_tokens, Some(9));
            assert!(entries
                .iter()
                .all(|entry| entry.agent_type == client.as_str()
                    && entry.trace_id == response.trace_id));
            let recovered = scan(
                root.path(),
                client,
                false,
                next.checkpoint,
                &mut Cache::default(),
                (false, false),
            )
            .unwrap();
            assert!(recovered.entries.is_empty());
        }
    }

    #[test]
    fn transcript_ignores_oversize_line_and_replaces_provisional_eof() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            [
                vec![b'x'; 4 * 1024 * 1024 + 1],
                b"\n{\"step_index\":1,\"type\":\"USER_INPUT\",\"content\":\"one\"}".to_vec(),
            ]
            .concat(),
        )
        .unwrap();
        let mut transcript = Transcript::default();
        for _ in 0..6 {
            transcript.scan(&path).unwrap();
        }
        assert_eq!(
            transcript.rows().get(&1).unwrap().content.as_deref(),
            Some("one")
        );
        std::fs::write(
            &path,
            b"{\"step_index\":1,\"type\":\"USER_INPUT\",\"content\":\"two\"}\n",
        )
        .unwrap();
        transcript.scan(&path).unwrap();
        assert_eq!(
            transcript.rows().get(&1).unwrap().content.as_deref(),
            Some("two")
        );
    }
}
