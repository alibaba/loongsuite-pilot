//! DSH session JSONL collector. Port of `dsh-log-input.ts`.
//!
//! Cross-line request state is restored from byte offsets. Prompt text stays
//! in the session file and is not written into the checkpoint.

use std::collections::HashMap;
use std::fs::File;

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::inputs::base::{CommittedInputBatch, InputRuntimeAccumulator, InputRuntimeDelta};

mod scanner;
use scanner::{read_chunk, scan_lines, ScanOptions, TailStamp};
type DeltaListener = Arc<dyn Fn(&InputRuntimeDelta) + Send + Sync>;
use crate::inputs::dsh::{
    new_state, parse_dsh_request_header, transform_dsh_record_entries, DshEventAggregatorState,
};
use crate::inputs::rest_support::{
    box_collect, box_hook, glob_match, is_unreadable_io, PollLoop, SessionInputOptions,
};
use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::{
    create_logger, directory_exists, ensure_dir, resolve_home, resolve_poll_interval_ms,
    BoundLogger, DEFAULT_POLL_INTERVAL_MS,
};

const DEFAULT_SESSION_DIR: &str = "~/.loongsuite-pilot/logs/dsh";
const DEFAULT_FILE_PATTERN: &str = "dsh-*.jsonl";
const DSH_STATE_VERSION: i64 = 1;
const READ_BUDGET_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 2 * READ_BUDGET_BYTES;
const READ_CHUNK_BYTES: u64 = 256 * 1024;
const LEGACY_SCAN_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone)]
struct DshFileRuntimeState {
    aggregator: DshEventAggregatorState,
    inode: u64,
    dev: u64,
    bound_session_id: Option<String>,
    active_turn_start_offset: Option<u64>,
    last_header_offset: Option<u64>,
    incomplete_tail: Option<TailStamp>,
}

pub struct DshLogInput {
    id: &'static str,
    session_dir: String,
    file_pattern: String,
    state_store: Arc<StateStore>,
    logger: BoundLogger,
    poll: PollLoop,
    file_states: Arc<Mutex<HashMap<String, DshFileRuntimeState>>>,
    discovery_complete: Arc<Mutex<bool>>,
    warned: Arc<Mutex<std::collections::VecDeque<String>>>,
    cycle: Arc<tokio::sync::Mutex<()>>,
    delta_listeners: Arc<Mutex<Vec<DeltaListener>>>,
}

impl DshLogInput {
    pub(crate) fn runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        crate::inputs::base::InputRuntimeInfo {
            poll_interval_ms: self.poll.interval_ms(),
            source_paths: vec![self.session_dir.clone()],
        }
    }

    pub fn new(opts: SessionInputOptions) -> Self {
        let logger = create_logger("DshLogInput");
        let state_store = Arc::clone(&opts.state_store);
        let poll_ms = resolve_poll_interval_ms(opts.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
        Self {
            id: "dsh-log",
            session_dir: opts
                .session_dir
                .unwrap_or_else(|| resolve_home(DEFAULT_SESSION_DIR)),
            file_pattern: opts
                .file_pattern
                .unwrap_or_else(|| DEFAULT_FILE_PATTERN.to_string()),
            state_store: opts.state_store,
            logger: logger.clone(),
            poll: PollLoop::new(poll_ms, logger, state_store),
            file_states: Arc::new(Mutex::new(HashMap::new())),
            discovery_complete: Arc::new(Mutex::new(true)),
            warned: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            cycle: Arc::new(tokio::sync::Mutex::new(())),
            delta_listeners: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn id(&self) -> &'static str {
        self.id
    }

    pub fn agent_type(&self) -> ClientType {
        ClientType::Dsh
    }

    pub fn collection_method(&self) -> crate::types::CollectionMethod {
        crate::types::CollectionMethod::SessionFilePolling
    }

    pub fn session_dir(&self) -> &str {
        &self.session_dir
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home(DEFAULT_SESSION_DIR)).await
    }

    pub fn watch_paths() -> Vec<String> {
        vec![resolve_home(DEFAULT_SESSION_DIR)]
    }

    pub fn running(&self) -> bool {
        self.poll.running()
    }

    pub fn on_entries<F>(&self, listener: F)
    where
        F: Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
    {
        self.poll.on_entries(listener);
    }

    pub async fn start(&self) {
        let handle = self.share();
        let handle_collect = Arc::clone(&handle);
        self.poll
            .start(
                box_hook(|| async {}),
                box_collect(move || {
                    let handle = Arc::clone(&handle_collect);
                    async move { handle.collect_entries().await }
                }),
                box_hook(|| async {}),
            )
            .await;
    }

    pub async fn stop(&self) {
        self.poll.stop().await;
    }

    fn share(&self) -> Arc<DshRuntime> {
        Arc::new(self.runtime())
    }

    pub fn on_runtime_delta<F>(&self, listener: F)
    where
        F: Fn(&InputRuntimeDelta) + Send + Sync + 'static,
    {
        self.delta_listeners
            .lock()
            .expect("runtime listeners")
            .push(Arc::new(listener));
    }

    pub async fn discover_session_files(&self) -> Vec<String> {
        self.runtime().discover_session_files().await
    }

    pub async fn collect_entries(&self) -> Result<Vec<AgentActivityEntry>, String> {
        self.runtime().collect_entries().await
    }

    fn runtime(&self) -> DshRuntime {
        DshRuntime {
            id: self.id,
            session_dir: self.session_dir.clone(),
            file_pattern: self.file_pattern.clone(),
            state_store: Arc::clone(&self.state_store),
            logger: self.logger.clone(),
            file_states: Arc::clone(&self.file_states),
            discovery_complete: Arc::clone(&self.discovery_complete),
            warned: Arc::clone(&self.warned),
            cycle: Arc::clone(&self.cycle),
            delta_listeners: Arc::clone(&self.delta_listeners),
        }
    }
}

struct DshRuntime {
    id: &'static str,
    session_dir: String,
    file_pattern: String,
    state_store: Arc<StateStore>,
    logger: BoundLogger,
    file_states: Arc<Mutex<HashMap<String, DshFileRuntimeState>>>,
    discovery_complete: Arc<Mutex<bool>>,
    warned: Arc<Mutex<std::collections::VecDeque<String>>>,
    cycle: Arc<tokio::sync::Mutex<()>>,
    delta_listeners: Arc<Mutex<Vec<DeltaListener>>>,
}

impl DshRuntime {
    async fn discover_session_files(&self) -> Vec<String> {
        let mut dir = match tokio::fs::read_dir(&self.session_dir).await {
            Ok(dir) => dir,
            Err(err) => {
                *self.discovery_complete.lock().expect("discovery") = false;
                if is_unreadable_io(&err) {
                    self.diagnose(&self.session_dir, "session directory").await;
                } else if err.kind() != std::io::ErrorKind::NotFound {
                    let mut meta = Map::new();
                    meta.insert(
                        "sessionDir".to_string(),
                        Value::String(self.session_dir.clone()),
                    );
                    meta.insert("error".to_string(), Value::String(err.to_string()));
                    self.logger
                        .warn("failed to discover dsh event logs", Some(&meta));
                }
                return Vec::new();
            }
        };
        *self.discovery_complete.lock().expect("discovery") = true;
        let mut files = Vec::new();
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_file() && glob_match(&self.file_pattern, &name) {
                files.push(
                    Path::new(&self.session_dir)
                        .join(name)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
        files.sort();
        files
    }

    async fn collect_entries(&self) -> Result<Vec<AgentActivityEntry>, String> {
        let _guard = self.cycle.lock().await;
        let started = InputRuntimeAccumulator::now();
        let mut observations = InputRuntimeAccumulator::new();
        let result = self.collect_observed(&mut observations).await;
        let delta = observations.finish(InputRuntimeAccumulator::now() - started);
        let listeners = self
            .delta_listeners
            .lock()
            .expect("runtime listeners")
            .clone();
        for listener in listeners {
            listener(&delta);
        }
        result
    }

    async fn collect_observed(
        &self,
        observations: &mut InputRuntimeAccumulator,
    ) -> Result<Vec<AgentActivityEntry>, String> {
        let files = self.discover_session_files().await;
        let mut entries = Vec::new();
        for file_path in &files {
            match self.process_dsh_file(file_path, observations).await {
                Ok(batch) => entries.extend(batch),
                Err(err) if err == "unreadable" => {
                    self.diagnose(file_path, "event file").await;
                }
                Err(err) => return Err(err),
            }
        }
        if *self.discovery_complete.lock().expect("discovery") {
            let present: std::collections::HashSet<&str> =
                files.iter().map(String::as_str).collect();
            let prefix = format!("{}:", self.id);
            for key in self.state_store.keys() {
                let Some(file_path) = key.strip_prefix(&prefix) else {
                    continue;
                };
                if !present.contains(file_path) {
                    self.state_store.delete(&key);
                    self.file_states
                        .lock()
                        .expect("file states")
                        .remove(file_path);
                }
            }
        }
        Ok(entries)
    }

    async fn process_dsh_file(
        &self,
        file_path: &str,
        observations: &mut InputRuntimeAccumulator,
    ) -> Result<Vec<AgentActivityEntry>, String> {
        let mut file = match File::open(file_path) {
            Ok(file) => file,
            Err(error) if is_unreadable_io(&error) => return Err("unreadable".to_string()),
            Err(_) => return Ok(Vec::new()),
        };
        let identity = crate::utils::file_identity::identity_from_open(&file)
            .map_err(|error| error.to_string())?;
        self.process_opened_dsh_file(file_path, &mut file, &identity, observations)
            .await
    }

    async fn process_opened_dsh_file(
        &self,
        file_path: &str,
        file: &mut File,
        identity: &crate::utils::file_identity::OpenedFileIdentity,
        observations: &mut InputRuntimeAccumulator,
    ) -> Result<Vec<AgentActivityEntry>, String> {
        let inode = identity.ino;
        let stamp = TailStamp::from_open(file).map_err(|error| error.to_string())?;
        let size = stamp.size;
        let state_key = format!("{}:{file_path}", self.id);
        let persisted = self.state_store.get(&state_key);
        let extra = persisted.extra().unwrap_or(Value::Null);
        let persisted_inode = extra.get("inode").and_then(value_u64);
        let persisted_dev = extra.get("dev").and_then(value_u64);
        let mut offset = self.state_store.get_offset(&state_key).max(0.0) as u64;
        let replaced = (persisted_inode.is_some() && persisted_inode != Some(inode))
            || (persisted_dev.is_some() && persisted_dev != Some(identity.dev));
        let truncated = offset > 0 && size < offset;
        if replaced || truncated {
            let mut meta_log = Map::new();
            meta_log.insert("file".to_owned(), Value::String(file_path.to_owned()));
            meta_log.insert("recorded".to_owned(), Value::from(offset));
            meta_log.insert("actual".to_owned(), Value::from(size));
            meta_log.insert("replaced".to_owned(), Value::Bool(replaced));
            self.logger.info(
                "dsh event file replaced or truncated, resetting state",
                Some(&meta_log),
            );
            offset = 0;
            self.file_states
                .lock()
                .expect("file states")
                .remove(file_path);
            self.update_checkpoint(&state_key, 0, identity, None, None);
        }
        let discarding = (!replaced && !truncated)
            .then(|| extra.get("dshDiscardedLineStartOffset").and_then(value_u64))
            .flatten()
            .filter(|start| *start <= 9_007_199_254_740_991 && *start < offset);
        let mut runtime = self
            .file_states
            .lock()
            .expect("file states")
            .get(file_path)
            .cloned();
        if runtime
            .as_ref()
            .is_none_or(|state| state.inode != inode || state.dev != identity.dev)
        {
            runtime = Some(
                self.restore_runtime(
                    file_path,
                    file,
                    &state_key,
                    identity,
                    discarding.unwrap_or(offset),
                    observations,
                )
                .await,
            );
        }
        let mut runtime = runtime.expect("runtime");
        observations.observe_backlog(size.saturating_sub(offset));
        if size <= offset || runtime.incomplete_tail.as_ref() == Some(&stamp) {
            self.update_checkpoint(&state_key, offset, identity, Some(&runtime), discarding);
            self.file_states
                .lock()
                .expect("file states")
                .insert(file_path.to_owned(), runtime);
            return Ok(Vec::new());
        }
        runtime.incomplete_tail = None;
        let mut entries = Vec::new();
        let mut batch = CommittedInputBatch {
            bytes: 0,
            records: 0,
            parse_success_records: 0,
            parse_failed_records: 0,
            max_record_bytes: 0,
        };
        let result = scan_lines(
            file,
            offset,
            size.min(offset.saturating_add(READ_BUDGET_BYTES)),
            observations,
            ScanOptions {
                extended_end: Some(size.min(offset.saturating_add(MAX_RECORD_BYTES))),
                discarded_line_start: discarding,
            },
            |line, line_offset, record_bytes| {
                if line.is_some_and(|line| line.trim().is_empty()) {
                    return true;
                }
                batch.records += 1;
                batch.max_record_bytes = batch.max_record_bytes.max(record_bytes);
                let Some(line) = line else {
                    batch.parse_failed_records += 1;
                    self.logger.warn(
                        "oversized dsh session line skipped",
                        Some(
                            &serde_json::json!({"file":file_path,"recordBytes":record_bytes})
                                .as_object()
                                .unwrap()
                                .clone(),
                        ),
                    );
                    return true;
                };
                match serde_json::from_str::<Value>(line) {
                    Ok(record) if record.is_object() => {
                        batch.parse_success_records += 1;
                        entries.extend(self.process_record(
                            &record,
                            file_path,
                            line_offset,
                            &mut runtime,
                        ));
                    }
                    _ => {
                        batch.parse_failed_records += 1;
                        self.logger.warn(
                            "invalid dsh session JSON",
                            Some(
                                &serde_json::json!({"file":file_path,"lineOffset":line_offset})
                                    .as_object()
                                    .unwrap()
                                    .clone(),
                            ),
                        );
                    }
                }
                true
            },
        )
        .map_err(|error| {
            if is_unreadable_io(&error) {
                "unreadable".to_owned()
            } else {
                error.to_string()
            }
        })?;
        if result.read_end == size && result.offset < size {
            runtime.incomplete_tail = Some(stamp);
        }
        batch.bytes = result.offset.saturating_sub(offset);
        observations.observe_committed_batch(batch);
        self.update_checkpoint(
            &state_key,
            result.offset,
            identity,
            Some(&runtime),
            result.discarded_line_start,
        );
        self.file_states
            .lock()
            .expect("file states")
            .insert(file_path.to_owned(), runtime);
        Ok(entries)
    }

    async fn restore_runtime(
        &self,
        file_path: &str,
        file: &mut File,
        state_key: &str,
        identity: &crate::utils::file_identity::OpenedFileIdentity,
        offset: u64,
        observations: &mut InputRuntimeAccumulator,
    ) -> DshFileRuntimeState {
        let extra = self
            .state_store
            .get(state_key)
            .extra()
            .unwrap_or(Value::Null);
        let mut runtime = DshFileRuntimeState {
            aggregator: new_state(),
            inode: identity.ino,
            dev: identity.dev,
            bound_session_id: extra
                .get("dshBoundSessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            active_turn_start_offset: None,
            last_header_offset: None,
            incomplete_tail: None,
        };
        let has_header_offset = extra_has(&extra, "dshLastHeaderOffset");
        if let Some(header_offset) = extra.get("dshLastHeaderOffset").and_then(value_u64) {
            let header_record = if header_offset < offset {
                read_record_at_offset(file, header_offset, offset, observations)
            } else {
                None
            };
            if header_record
                .as_ref()
                .and_then(|record| record.as_object())
                .is_none_or(|record| !restore_header(record, header_offset, &mut runtime))
            {
                let mut meta = Map::new();
                meta.insert("file".to_string(), Value::String(file_path.to_string()));
                meta.insert("headerOffset".to_string(), Value::from(header_offset));
                self.logger.warn(
                    "invalid dsh last-header checkpoint; dropping cached header",
                    Some(&meta),
                );
            }
        } else if !has_header_offset && offset > 0 {
            if let Some((header_offset, record)) = find_legacy_last_header(
                file,
                offset,
                runtime.bound_session_id.as_deref(),
                observations,
            ) {
                if let Some(record) = record.as_object() {
                    restore_header(record, header_offset, &mut runtime);
                }
            }
        }
        let replay_start =
            if extra.get("dshStateVersion").and_then(Value::as_i64) == Some(DSH_STATE_VERSION) {
                extra.get("dshActiveTurnStartOffset").and_then(value_u64)
            } else if offset > 0 && !extra_has(&extra, "dshActiveTurnStartOffset") {
                find_legacy_active_turn_start(file, offset, observations)
            } else {
                None
            };
        if let Some(replay_start) = replay_start {
            if replay_start < offset {
                let _ = scan_lines(
                    file,
                    replay_start,
                    offset,
                    observations,
                    ScanOptions::default(),
                    |line, line_offset, _| {
                        let Some(line) = line.filter(|line| !line.trim().is_empty()) else {
                            return true;
                        };
                        match serde_json::from_str::<Value>(line) {
                            Ok(record) => {
                                let _ = self.process_record(
                                    &record,
                                    file_path,
                                    line_offset,
                                    &mut runtime,
                                );
                            }
                            Err(error) => {
                                self.logger.warn(
                                    "invalid dsh replay line",
                                    Some(&serde_json::json!({"file":file_path,"error":error.to_string()})
                                        .as_object().unwrap().clone()),
                                );
                            }
                        }
                        true
                    },
                );
            }
        }
        runtime
    }

    fn process_record(
        &self,
        record: &Value,
        file_path: &str,
        line_offset: u64,
        runtime: &mut DshFileRuntimeState,
    ) -> Vec<AgentActivityEntry> {
        let object = record.as_object();
        let sid = object
            .and_then(|record| record.get("sid"))
            .and_then(Value::as_str)
            .filter(|sid| !sid.is_empty());
        if let Some(sid) = sid {
            if runtime.bound_session_id.is_none() {
                runtime.bound_session_id = Some(sid.to_string());
            }
            if runtime.bound_session_id.as_deref() != Some(sid) {
                let mut meta = Map::new();
                meta.insert("file".to_string(), Value::String(file_path.to_string()));
                meta.insert(
                    "expectedSessionId".to_string(),
                    Value::String(runtime.bound_session_id.clone().unwrap_or_default()),
                );
                meta.insert(
                    "actualSessionId".to_string(),
                    Value::String(sid.to_string()),
                );
                self.logger.warn(
                    "dsh session id changed within one event file; skipping record",
                    Some(&meta),
                );
                return Vec::new();
            }
        }
        let record_type = object
            .and_then(|record| record.get("type"))
            .and_then(Value::as_str);
        if record_type == Some("turn/start") && sid.is_some() {
            runtime.active_turn_start_offset = Some(line_offset);
        }
        if sid.is_some() {
            if let Some(object) = object {
                if parse_dsh_request_header(object).is_some() {
                    runtime.last_header_offset = Some(line_offset);
                }
            }
        }
        let entries =
            transform_dsh_record_entries(record, ClientType::Dsh, &mut runtime.aggregator);
        if record_type == Some("turn/end") {
            runtime.active_turn_start_offset = None;
        }
        entries
    }

    fn update_checkpoint(
        &self,
        state_key: &str,
        offset: u64,
        identity: &crate::utils::file_identity::OpenedFileIdentity,
        runtime: Option<&DshFileRuntimeState>,
        discarded_line_start: Option<u64>,
    ) {
        let current = self.state_store.get(state_key);
        let previous = current.extra().unwrap_or(Value::Null);
        let active = runtime
            .and_then(|state| state.active_turn_start_offset)
            .map(Value::from)
            .unwrap_or(Value::Null);
        let header = runtime
            .and_then(|state| state.last_header_offset)
            .map(Value::from)
            .unwrap_or(Value::Null);
        let session = runtime
            .and_then(|state| state.bound_session_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null);
        let discarded = discarded_line_start.map(Value::from).unwrap_or(Value::Null);
        if current.last_offset().unwrap_or(0.0) == offset as f64
            && previous.get("inode").and_then(value_u64) == Some(identity.ino)
            && previous
                .get("dev")
                .and_then(value_u64)
                .is_none_or(|dev| dev == identity.dev)
            && previous.get("dshStateVersion").and_then(Value::as_i64) == Some(DSH_STATE_VERSION)
            && previous.get("dshActiveTurnStartOffset") == Some(&active)
            && previous.get("dshLastHeaderOffset") == Some(&header)
            && previous.get("dshBoundSessionId") == Some(&session)
            && previous
                .get("dshDiscardedLineStartOffset")
                .unwrap_or(&Value::Null)
                == &discarded
        {
            return;
        }
        self.state_store.update(
            state_key,
            InputStatePatch {
                last_offset: Some(offset as f64),
                extra: Some(serde_json::json!({
                    "inode":identity.ino,"dev":identity.dev,"dshStateVersion":DSH_STATE_VERSION,
                    "dshActiveTurnStartOffset":active,"dshLastHeaderOffset":header,
                    "dshBoundSessionId":session,"dshDiscardedLineStartOffset":discarded,
                })),
                ..Default::default()
            },
        );
    }

    async fn diagnose(&self, target_path: &str, kind: &str) {
        let key = format!("{kind}:{target_path}");
        {
            let mut warned = self.warned.lock().expect("warned");
            if warned.iter().any(|existing| existing == &key) {
                return;
            }
            if warned.len() >= 512 {
                warned.pop_front();
            }
            warned.push_back(key);
        }
        let mut meta = Map::new();
        meta.insert("path".to_string(), Value::String(target_path.to_string()));
        meta.insert("kind".to_string(), Value::String(kind.to_string()));
        self.logger.warn(
            &format!("ownership-mismatch: cannot read {kind} (EACCES)"),
            Some(&meta),
        );
    }
}

fn restore_header(
    record: &Map<String, Value>,
    line_offset: u64,
    runtime: &mut DshFileRuntimeState,
) -> bool {
    let sid = record
        .get("sid")
        .and_then(Value::as_str)
        .filter(|sid| !sid.is_empty());
    let Some(header) = parse_dsh_request_header(record) else {
        return false;
    };
    let Some(sid) = sid else {
        return false;
    };
    if runtime
        .bound_session_id
        .as_deref()
        .is_some_and(|bound| bound != sid)
    {
        return false;
    }
    if runtime.bound_session_id.is_none() {
        runtime.bound_session_id = Some(sid.to_string());
    }
    runtime.last_header_offset = Some(line_offset);
    runtime.aggregator.last_known_header = Some(header);
    true
}

fn read_record_at_offset(
    file: &mut File,
    line_offset: u64,
    committed_offset: u64,
    observations: &mut InputRuntimeAccumulator,
) -> Option<Value> {
    let mut record = None;
    scan_lines(
        file,
        line_offset,
        committed_offset.min(line_offset.saturating_add(MAX_RECORD_BYTES)),
        observations,
        ScanOptions::default(),
        |line, _, _| {
            record = line
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .filter(Value::is_object);
            false
        },
    )
    .ok()?;
    record
}

fn find_legacy_last_header(
    file: &mut File,
    offset: u64,
    bound_session_id: Option<&str>,
    observations: &mut InputRuntimeAccumulator,
) -> Option<(u64, Value)> {
    let start = offset.saturating_sub(LEGACY_SCAN_BYTES);
    let data = read_at(file, start, (offset - start) as usize, observations).ok()?;
    let mut cursor = 0usize;
    if start > 0 {
        let newline = data.iter().position(|byte| *byte == b'\n')?;
        cursor = newline + 1;
    }
    let mut last = None;
    while cursor < data.len() {
        let Some(rel) = data[cursor..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let newline = cursor + rel;
        let line_offset = start + cursor as u64;
        if let Ok(record) = serde_json::from_slice::<Value>(&data[cursor..newline]) {
            let sid = record
                .get("sid")
                .and_then(Value::as_str)
                .filter(|sid| !sid.is_empty());
            if record
                .as_object()
                .is_some_and(|object| parse_dsh_request_header(object).is_some())
                && sid.is_some()
                && bound_session_id.is_none_or(|bound| Some(bound) == sid)
            {
                last = Some((line_offset, record));
            }
        }
        cursor = newline + 1;
    }
    last
}

fn find_legacy_active_turn_start(
    file: &mut File,
    offset: u64,
    observations: &mut InputRuntimeAccumulator,
) -> Option<u64> {
    let start = offset.saturating_sub(LEGACY_SCAN_BYTES);
    let data = read_at(file, start, (offset - start) as usize, observations).ok()?;
    let mut cursor = 0usize;
    if start > 0 {
        let newline = data.iter().position(|byte| *byte == b'\n')?;
        cursor = newline + 1;
    }
    let mut last: Option<(&str, u64)> = None;
    while cursor < data.len() {
        let Some(rel) = data[cursor..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let newline = cursor + rel;
        let line_offset = start + cursor as u64;
        if let Ok(record) = serde_json::from_slice::<Value>(&data[cursor..newline]) {
            if let Some(kind) = record.get("type").and_then(Value::as_str) {
                if kind == "turn/start" || kind == "turn/end" {
                    last = Some((
                        if kind == "turn/start" {
                            "turn/start"
                        } else {
                            "turn/end"
                        },
                        line_offset,
                    ));
                }
            }
        }
        cursor = newline + 1;
    }
    last.and_then(|(kind, offset)| (kind == "turn/start").then_some(offset))
}

fn read_at(
    file: &mut File,
    offset: u64,
    len: usize,
    observations: &mut InputRuntimeAccumulator,
) -> std::io::Result<Vec<u8>> {
    let mut buffer = vec![0; len];
    let mut filled = 0;
    while filled < len {
        let read = read_chunk(
            file,
            &mut buffer[filled..],
            offset + filled as u64,
            observations,
        )?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(buffer)
}

fn extra_has(extra: &Value, key: &str) -> bool {
    extra
        .as_object()
        .is_some_and(|object| object.contains_key(key))
}

fn value_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
                .map(|n| n as u64)
        })
}

pub async fn ensure_dsh_log_dir(dir: &str) {
    ensure_dir(dir).await;
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::inputs::rest_support::entry_json;

    fn prefix(sid: &str, provider: &str, prompt: &str) -> Vec<Value> {
        vec![
            json!({"type": "turn/start", "sid": sid, "time": 1, "data": {"turn": 1}}),
            json!({"type": "step/start", "sid": sid, "time": 2, "data": {"turn": 1, "step": 1}}),
            json!({"type": "user/message", "sid": sid, "time": 3, "data": {"content": [{"type": "text", "text": prompt}]}}),
            json!({"type": "request/header", "sid": sid, "time": 4, "data": {"header": {"config": {"provider": provider, "model": format!("{provider}-model")}, "system": format!("{provider}-system")}}}),
            json!({"type": "request/context", "sid": sid, "time": 5, "data": {"provider": provider, "model": format!("{provider}-model")}}),
        ]
    }

    fn append(path: &std::path::Path, records: &[Value]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }

    async fn make_input(dir: &std::path::Path, store: Arc<StateStore>) -> DshLogInput {
        store.load().await;
        DshLogInput::new(SessionInputOptions {
            state_store: store,
            session_dir: Some(dir.to_string_lossy().to_string()),
            file_pattern: None,
            poll_interval_ms: Some(60_000),
        })
    }

    #[tokio::test]
    async fn collects_embedded_stream_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("input-state.json");
        let file = dir.path().join("dsh-session-a.jsonl");
        append(&file, &prefix("session-a", "provider-a", "private-prompt"));
        let store = Arc::new(StateStore::new(&state_path));
        let first = make_input(dir.path(), Arc::clone(&store)).await;
        first.collect_entries().await.unwrap();
        store.save().await.unwrap();

        let message = json!({
            "type": "assistant/message",
            "sid": "session-a",
            "time": 11,
            "data": {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "response-1",
                    "source": { "provider": "provider-a", "model": "provider-a-model" },
                    "content": [{ "type": "text", "text": "answer-1" }]
                },
                "usage": { "inputTokens": 10, "outputTokens": 5 },
                "stream": [
                    { "type": "chunk", "time": 7, "chunk": { "type": "block-start", "index": 0, "blockType": "text" } },
                    { "type": "text-chunks", "time0": 8, "index": 0, "dt": [1], "texts": ["answer", "-1"] },
                    { "type": "chunk", "time": 10, "chunk": { "type": "finish", "reason": { "kind": "tool-calls" } } }
                ]
            }
        });
        append(&file, &[message]);
        let store = Arc::new(StateStore::new(&state_path));
        let second = make_input(dir.path(), Arc::clone(&store)).await;
        let entries = second.collect_entries().await.unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|entry| {
                entry_json(entry)["event.name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert_eq!(
            names,
            vec!["llm.request".to_string(), "llm.response".to_string()]
        );
        assert_eq!(entry_json(&entries[0])["time_unix_nano"], "5000000");
        assert_eq!(
            entry_json(&entries[1])["gen_ai.response.time_to_first_token"].as_f64(),
            Some(3_000_000.0)
        );
        assert_eq!(
            entry_json(&entries[1])["gen_ai.response.finish_reasons"],
            json!(["tool_calls"])
        );
        let input = entry_json(&entries[0])["gen_ai.input.messages"].to_string();
        assert!(input.contains("private-prompt"));
        assert!(!input.contains("answer-1"));
        store.save().await.unwrap();
        let persisted = std::fs::read_to_string(&state_path).unwrap();
        assert!(!persisted.contains("private-prompt"));
    }

    #[tokio::test]
    async fn does_not_advance_past_a_partial_final_record() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dsh-session-a.jsonl");
        let record =
            json!({"type": "turn/start", "sid": "session-a", "time": 1, "data": {"turn": 1}});
        std::fs::write(&file, format!("{record}")).unwrap();
        let store = Arc::new(StateStore::new(dir.path().join("state.json")));
        let input = make_input(dir.path(), Arc::clone(&store)).await;
        assert!(input.collect_entries().await.unwrap().is_empty());
        let key = format!("dsh-log:{}", file.display());
        assert_eq!(store.get_offset(&key), 0.0);
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        writeln!(handle).unwrap();
        let _ = input.collect_entries().await.unwrap();
        assert!(store.get_offset(&key) > 0.0);
    }
    mod identity_tests {
        include!("identity_tests.rs");
    }
    mod history_contracts {
        include!("history_contracts.rs");
    }
    mod main553_contracts {
        include!("main553_history.rs");
    }
}
