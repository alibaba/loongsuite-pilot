//! Copilot CLI transcript/native OTel collection with a durable source index.
#[cfg(test)]
mod disk_governance_tests;
#[cfg(test)]
mod disk_pressure_tests;
#[cfg(test)]
mod history_policy_tests;
mod interaction_parser;
mod source_index;
use crate::checkpoints::StateStore;
use crate::inputs::base::{HostedInput, InputBody, InputRuntime, InputRuntimeDelta};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{
    resolve_home, write_text_file_atomic, AtomicTextWriteOptions, ExpectedFileState,
    DEFAULT_POLL_INTERVAL_MS,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use source_index::CopilotSourceIndex;
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

pub struct CopilotLogInputOptions {
    pub state_store: Arc<StateStore>,
    pub data_dir: PathBuf,
    pub session_dir: Option<PathBuf>,
    pub otel_dir: Option<PathBuf>,
    pub poll_interval_ms: Option<u64>,
    pub native_grace_ms: Option<u64>,
    pub history_start_time_ms: Option<u64>,
}
struct Shared {
    index: Option<CopilotSourceIndex>,
    queued: Vec<String>,
    history_start: Option<i64>,
}
pub struct CopilotLogBody {
    data_dir: PathBuf,
    session_dir: PathBuf,
    otel_dir: PathBuf,
    wakeup_dir: PathBuf,
    native_grace_ms: u64,
    initial_history_start: Option<u64>,
    shared: Arc<Mutex<Shared>>,
    host: Mutex<Option<Weak<HostedInput<CopilotLogBody>>>>,
    watcher: Mutex<Option<CopilotWakeupWatcher>>,
}
pub struct CopilotLogInput {
    pub inner: Arc<HostedInput<CopilotLogBody>>,
}
fn copilot_home() -> PathBuf {
    std::env::var_os("COPILOT_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(resolve_home("~/.copilot")))
}
impl CopilotLogInput {
    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        self.inner.runtime.runtime_info()
    }

    /// Apply validated collector exclusions before any collection or upload.
    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }

    pub fn new(options: CopilotLogInputOptions) -> Self {
        let body = CopilotLogBody {
            session_dir: options
                .session_dir
                .unwrap_or_else(|| copilot_home().join("session-state")),
            otel_dir: options
                .otel_dir
                .unwrap_or_else(|| options.data_dir.join("state/copilot/otel")),
            wakeup_dir: options.data_dir.join("state/copilot/session-wakeups"),
            data_dir: options.data_dir,
            native_grace_ms: options.native_grace_ms.unwrap_or(30_000),
            initial_history_start: options.history_start_time_ms,
            host: Mutex::new(None),
            watcher: Mutex::new(None),
            shared: Arc::new(Mutex::new(Shared {
                index: None,
                queued: Vec::new(),
                history_start: None,
            })),
        };
        let inner = HostedInput::new(
            body,
            "CopilotLogInput",
            options.state_store,
            Some(
                options
                    .poll_interval_ms
                    .filter(|interval| *interval > 0)
                    .unwrap_or(DEFAULT_POLL_INTERVAL_MS),
            ),
        );
        *inner.body.host.lock().expect("Copilot host") = Some(Arc::downgrade(&inner));
        Self { inner }
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }
    pub async fn start(&self) -> std::result::Result<(), String> {
        self.inner.start().await
    }
    pub async fn stop(&self) -> std::result::Result<(), String> {
        self.inner.stop().await
    }
    pub async fn run_cycle(&self) {
        self.inner.run_cycle().await;
    }
    pub fn on_entries(&self, callback: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.inner.on_entries(callback);
    }
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }
    pub async fn check_availability() -> bool {
        tokio::fs::metadata(copilot_home())
            .await
            .is_ok_and(|metadata| metadata.is_dir())
    }
    pub fn watch_paths() -> Vec<String> {
        vec![copilot_home().to_string_lossy().into_owned()]
    }
}
impl CopilotLogBody {
    async fn apply_history_policy(&self) -> Result<()> {
        if self
            .shared
            .lock()
            .expect("Copilot state")
            .history_start
            .is_some()
        {
            return Ok(());
        }
        let shared = self.shared.clone();
        let index_path = self.data_dir.join("state/copilot/source-index.sqlite");
        let indexed = tokio::task::spawn_blocking(move || -> Result<Option<i64>> {
            let mut shared = shared.lock().expect("Copilot state");
            if shared.index.is_none() {
                shared.index = Some(CopilotSourceIndex::open(&index_path)?);
            }
            shared
                .index
                .as_ref()
                .expect("opened index")
                .history_start_time()
        })
        .await??;
        let policy = self.data_dir.join("state/copilot/collection-policy.json");
        let raw = match tokio::fs::read_to_string(&policy).await {
            Ok(raw) => Some(raw),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("Cannot read Copilot collection policy"),
        };
        let start = if let Some(raw) = raw {
            let value: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
                .context("Invalid Copilot collection policy; historical boundary preserved")?;
            anyhow::ensure!(
                value["schema"] == 1,
                "Invalid Copilot collection policy schema"
            );
            let start = value["historyStartTimeMs"]
                .as_i64()
                .filter(|start| *start >= 0)
                .context("Invalid Copilot historical boundary")?;
            anyhow::ensure!(
                indexed.is_none_or(|indexed| indexed == start),
                "Copilot policy disagrees with source index"
            );
            start
        } else {
            let start = indexed
                .or_else(|| {
                    self.initial_history_start
                        .and_then(|start| i64::try_from(start).ok())
                })
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis().max(0));
            anyhow::ensure!(
                self.initial_history_start
                    .is_none_or(|value| i64::try_from(value).is_ok()),
                "Copilot history boundary is outside the supported range"
            );
            write_text_file_atomic(
                &policy.to_string_lossy(),
                &format!("{}\n", json!({"schema":1,"historyStartTimeMs":start})),
                &AtomicTextWriteOptions {
                    expected: Some(ExpectedFileState::Missing),
                    mode: Some(0o600),
                    backup_path: None,
                },
            )
            .await?;
            start
        };
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut shared = shared.lock().expect("Copilot state");
            shared
                .index
                .as_mut()
                .context("Copilot source index is not open")?
                .apply_history_policy(start)?;
            shared.history_start = Some(start);
            Ok(())
        })
        .await??;
        Ok(())
    }
}
fn list_sources(session_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(session_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files.push(entry.path().join("events.jsonl"));
        }
    }
    files.sort();
    Ok(files)
}
fn collect_sources(
    index: &CopilotSourceIndex,
    session_dir: &Path,
    otel_dir: &Path,
    wakeup_dir: &Path,
    grace: u64,
) -> Result<(Vec<String>, Vec<AgentActivityEntry>)> {
    let files = match list_sources(session_dir) {
        Ok(files) => files,
        Err(_) => return Ok((Vec::new(), Vec::new())),
    };
    index.prune_deleted_sessions(&files)?;
    let mut otel_files = BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(otel_dir) {
        for entry in entries.flatten() {
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("jsonl")
            {
                otel_files.insert(entry.path());
            }
        }
    }
    let mut marker_sessions = HashSet::new();
    let mut native_sessions = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(wakeup_dir) {
        for entry in entries.flatten() {
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
            {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(marker) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let Some(session) = marker.get("session_id").and_then(Value::as_str) else {
                continue;
            };
            marker_sessions.insert(session.to_owned());
            if let Some(file) = marker
                .get("otel_file")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .filter(|file| file.is_absolute())
            {
                native_sessions.insert(session.to_owned());
                otel_files.insert(file);
            }
        }
    }
    for file in &files {
        if index.ingest(file, "event").is_err() {
            crate::utils::create_logger("CopilotLogInput")
                .warn("Copilot source unavailable; checkpoint retained", None);
        }
    }
    for file in otel_files {
        if index.ingest(&file, "span").is_err() {
            crate::utils::create_logger("CopilotLogInput").warn(
                "Copilot native source unavailable; retaining source state",
                None,
            );
        }
    }
    index.restore_deferred_spans()?;
    for pending in index.pending()? {
        if !index.is_eligible(&pending.session, &pending.id)? {
            continue;
        }
        let require_otel =
            native_sessions.contains(&pending.session) || index.has_native(&pending.session)?;
        let source = index.load(&pending.session, &pending.id)?;
        if !require_otel
            && !marker_sessions.contains(&pending.session)
            && !pending.id.starts_with("summary:")
        {
            let closed =
                !interaction_parser::parse_interactions(&source.events, &[], false).is_empty();
            if !closed
                || index.awaiting_native(
                    &pending.session,
                    &pending.id,
                    chrono::Utc::now().timestamp_millis(),
                    i64::try_from(grace).unwrap_or(i64::MAX),
                )?
                || index.has_unread_source()?
            {
                continue;
            }
        }
        let key = format!("copilot:{}:{}", pending.session, pending.id);
        if let Some(mut batch) =
            interaction_parser::parse_interactions(&source.events, &source.spans, require_otel)
                .into_iter()
                .find(|batch| batch.key == key && !batch.records.is_empty())
        {
            for entry in &mut batch.records {
                entry.extra.insert(
                    "gen_ai.copilot.telemetry.source".into(),
                    json!(if require_otel {
                        "native-otel"
                    } else {
                        "transcript-only"
                    }),
                );
            }
            return Ok((vec![key], batch.records));
        }
    }
    Ok((Vec::new(), Vec::new()))
}
#[async_trait]
impl InputBody for CopilotLogBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "copilot-log"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::CopilotCli
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }
    async fn on_start(&self, _rt: &InputRuntime) -> Result<()> {
        tokio::fs::create_dir_all(&self.wakeup_dir).await?;
        self.apply_history_policy().await?;
        if let Some(host) = self.host.lock().expect("Copilot host").clone() {
            let watcher = spawn_copilot_wakeup_watcher(&self.wakeup_dir, host);
            *self.watcher.lock().expect("Copilot watcher") = Some(watcher);
        }
        Ok(())
    }
    async fn collect(&self, rt: &InputRuntime) -> Result<Vec<AgentActivityEntry>> {
        self.apply_history_policy().await?;
        let legacy: Vec<_> = rt
            .state_store
            .keys()
            .into_iter()
            .filter(|key| key.starts_with("copilot-log:v2:"))
            .map(|key| {
                let keys = rt
                    .state_store
                    .get(&key)
                    .extra()
                    .and_then(|extra| extra.get("interactions").cloned())
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect::<Vec<_>>();
                (key, keys)
            })
            .collect();
        let shared = self.shared.clone();
        let session_dir = self.session_dir.clone();
        let otel_dir = self.otel_dir.clone();
        let wakeup_dir = self.wakeup_dir.clone();
        let grace = self.native_grace_ms;
        let imported: Vec<_> = legacy.iter().map(|(key, _)| key.clone()).collect();
        let entries = tokio::task::spawn_blocking(move || -> Result<Vec<AgentActivityEntry>> {
            let mut shared = shared.lock().expect("Copilot state");
            shared.queued.clear();
            let index = shared
                .index
                .as_ref()
                .context("Copilot source index is not open")?;
            for (_, keys) in legacy {
                index.mark_delivered(&keys)?;
            }
            let (keys, entries) =
                collect_sources(index, &session_dir, &otel_dir, &wakeup_dir, grace)?;
            shared.queued = keys;
            Ok(entries)
        })
        .await??;
        for key in imported {
            rt.state_store.delete(&key);
        }
        Ok(entries)
    }
    async fn on_entries_queued(&self, rt: &InputRuntime) -> Result<()> {
        if rt.state_store.save_failed() {
            return Ok(());
        }
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut shared = shared.lock().expect("Copilot state");
            let index = shared
                .index
                .as_ref()
                .context("Copilot source index is not open")?;
            index.mark_delivered(&shared.queued)?;
            shared.queued.clear();
            Ok(())
        })
        .await??;
        Ok(())
    }
    async fn on_stop(&self, _rt: &InputRuntime) -> Result<()> {
        let watcher = self.watcher.lock().expect("Copilot watcher").take();
        if let Some(watcher) = watcher {
            watcher.stop().await;
        }
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || {
            let mut shared = shared.lock().expect("Copilot state");
            shared.index.take();
            shared.history_start = None;
            shared.queued.clear();
        })
        .await?;
        Ok(())
    }
}

/// Lifetime-owned wakeup listener. Linux watches kernel events; other platforms
/// observe only the atomic marker directory generation, without reading bodies.
struct CopilotWakeupWatcher {
    task: tokio::task::JoinHandle<()>,
}
impl CopilotWakeupWatcher {
    async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Drop for CopilotWakeupWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn spawn_copilot_wakeup_watcher(
    directory: &Path,
    host: Weak<HostedInput<CopilotLogBody>>,
) -> CopilotWakeupWatcher {
    #[cfg(target_os = "linux")]
    if let Some(watcher) = spawn_copilot_inotify(directory, host.clone()) {
        return watcher;
    }
    let directory = directory.to_owned();
    let task = tokio::spawn(async move {
        let mut previous = None;
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop {
            interval.tick().await;
            let generation = tokio::fs::metadata(&directory)
                .await
                .ok()
                .and_then(|metadata| metadata.modified().ok());
            if generation != previous {
                previous = generation;
                let Some(host) = host.upgrade() else {
                    break;
                };
                host.request_collection();
            }
        }
    });
    CopilotWakeupWatcher { task }
}
#[cfg(target_os = "linux")]
fn spawn_copilot_inotify(
    directory: &Path,
    host: Weak<HostedInput<CopilotLogBody>>,
) -> Option<CopilotWakeupWatcher> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let directory = CString::new(directory.as_os_str().as_bytes()).ok()?;
    let raw = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if raw < 0 {
        return None;
    }
    // OwnedFd closes the descriptor on every registration/error/abort path.
    let file = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe {
        libc::inotify_add_watch(
            file.as_raw_fd(),
            directory.as_ptr(),
            libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_MODIFY,
        )
    } < 0
    {
        return None;
    }
    let file = unsafe {
        tokio::io::unix::AsyncFd::register_with_interest(file, tokio::io::Interest::READABLE)
    }
    .ok()?;
    let task = tokio::spawn(async move {
        loop {
            let mut guard = match file.readable().await {
                Ok(guard) => guard,
                Err(_) => break,
            };
            let mut bytes = [0u8; 4096];
            match guard.try_io(|file| {
                let size = unsafe {
                    libc::read(
                        file.get_ref().as_raw_fd(),
                        bytes.as_mut_ptr().cast(),
                        bytes.len(),
                    )
                };
                if size < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(size)
                }
            }) {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => {
                    let Some(host) = host.upgrade() else {
                        break;
                    };
                    host.request_collection();
                }
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(Err(_)) => break,
                Err(_) => continue,
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    Some(CopilotWakeupWatcher { task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentEventName;

    #[tokio::test]
    async fn atomic_hook_marker_triggers_collection_and_listener_restarts_and_stops() {
        let root = tempfile::tempdir().unwrap();
        let session_dir = root.path().join("sessions");
        let data = root.path().join("data");
        let otel_dir = data.join("state/copilot/otel");
        tokio::fs::create_dir_all(session_dir.join("session-test"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(&otel_dir).await.unwrap();
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: Arc::new(StateStore::new(root.path().join("checkpoint.json"))),
            data_dir: data.clone(),
            session_dir: Some(session_dir.clone()),
            otel_dir: Some(otel_dir.clone()),
            poll_interval_ms: Some(60_000),
            native_grace_ms: Some(0),
            history_start_time_ms: Some(0),
        });
        let (sender, mut received) = tokio::sync::mpsc::unbounded_channel();
        input.on_entries(move |entries| {
            let _ = sender.send(entries.to_vec());
        });
        input.start().await.unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/copilot/conversation.json"
        ))
        .unwrap();
        let lines = |values: &Value| {
            values
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        tokio::fs::write(
            session_dir.join("session-test/events.jsonl"),
            lines(&fixture["events"]),
        )
        .await
        .unwrap();
        tokio::fs::write(otel_dir.join("native.jsonl"), lines(&fixture["spans"]))
            .await
            .unwrap();
        let wakeup = data.join("state/copilot/session-wakeups");
        tokio::fs::write(wakeup.join("draft"), r#"{"session_id":"session-test"}"#)
            .await
            .unwrap();
        tokio::fs::rename(wakeup.join("draft"), wakeup.join("session.json"))
            .await
            .unwrap();
        let entries = tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .expect("atomic marker did not wake native input")
            .unwrap();
        assert!(!entries.is_empty());
        let task = input
            .inner
            .body
            .watcher
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .task
            .abort_handle();
        input.stop().await.unwrap();
        assert!(task.is_finished());
        input.start().await.unwrap();
        let task = input
            .inner
            .body
            .watcher
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .task
            .abort_handle();
        assert!(!task.is_finished());
        input.stop().await.unwrap();
        assert!(task.is_finished());
        assert!(
            received.try_recv().is_err(),
            "restart replayed a delivered interaction"
        );
    }

    #[tokio::test]
    async fn dropping_an_idle_listener_aborts_without_a_filesystem_event() {
        let root = tempfile::tempdir().unwrap();
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: Arc::new(StateStore::new(root.path().join("checkpoint.json"))),
            data_dir: root.path().join("data"),
            session_dir: Some(root.path().join("sessions")),
            otel_dir: None,
            poll_interval_ms: Some(60_000),
            native_grace_ms: Some(0),
            history_start_time_ms: Some(0),
        });
        let directory = root.path().join("markers");
        tokio::fs::create_dir(&directory).await.unwrap();
        let watcher = spawn_copilot_wakeup_watcher(&directory, Arc::downgrade(&input.inner));
        let task = watcher.task.abort_handle();
        drop(watcher);
        tokio::time::timeout(Duration::from_secs(1), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn installed_input_correlates_native_sources_and_restores_delivery_and_history_boundary()
    {
        let root = tempfile::tempdir().unwrap();
        let session_dir = root.path().join("sessions");
        let data = root.path().join("data");
        let otel_dir = data.join("state/copilot/otel");
        tokio::fs::create_dir_all(session_dir.join("session-test"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(&otel_dir).await.unwrap();
        let store = Arc::new(StateStore::new(root.path().join("checkpoint.json")));
        let input = CopilotLogInput::new(CopilotLogInputOptions {
            state_store: store,
            data_dir: data.clone(),
            session_dir: Some(session_dir.clone()),
            otel_dir: Some(otel_dir.clone()),
            poll_interval_ms: Some(60_000),
            native_grace_ms: Some(0),
            history_start_time_ms: Some(0),
        });
        let collected = Arc::new(Mutex::new(Vec::new()));
        let capture = collected.clone();
        input.on_entries(move |entries| capture.lock().unwrap().extend_from_slice(entries));
        input.start().await.unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/copilot/conversation.json"
        ))
        .unwrap();
        let lines = |values: &Value| {
            values
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        tokio::fs::write(
            session_dir.join("session-test/events.jsonl"),
            lines(&fixture["events"]),
        )
        .await
        .unwrap();
        tokio::fs::write(otel_dir.join("native.jsonl"), lines(&fixture["spans"]))
            .await
            .unwrap();
        input.run_cycle().await;
        let first = collected.lock().unwrap().clone();
        assert!(!first.is_empty());
        assert!(first.iter().any(
            |entry| entry.event_name == Some(AgentEventName::LlmResponse)
                && entry.total_tokens == Some(110)
        ));
        assert!(first.iter().all(
            |entry| entry.get("gen_ai.copilot.telemetry.source") == Some(&json!("native-otel"))
        ));
        input.run_cycle().await;
        assert_eq!(collected.lock().unwrap().len(), first.len());
        input.stop().await.unwrap();
        input.start().await.unwrap();
        input.run_cycle().await;
        input.stop().await.unwrap();
        assert_eq!(collected.lock().unwrap().len(), first.len());
        let policy: Value = serde_json::from_str(
            &tokio::fs::read_to_string(data.join("state/copilot/collection-policy.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(policy["historyStartTimeMs"], 0);
    }
}

#[cfg(test)]
mod final_spans_main_tests;
