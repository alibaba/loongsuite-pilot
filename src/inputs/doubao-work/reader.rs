//! Incremental, bounded native Doubao sources. Raw content never enters checkpoints.
use super::budget::{DoubaoWorkBudget, DoubaoWorkError};
use super::content::{
    append_native_content_row, NativeAssignment, NativeCallContent, NativeContent,
};
use super::execution::{parse_native_execution, NativeExecution};
use super::native::{append_native_graph_row, NativeEdge, NativeGraph};
use super::rounds::native_demand_fingerprint;
use super::util::{native_id, numeric_id, parse_time_ms, uuid};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::fs::{self, File};

const CHUNK: usize = 64 * 1024;
const WINDOW: usize = 2 * 1024 * 1024;
const MAX_CALLS: usize = 4096;
type Result<T> = std::result::Result<T, DoubaoWorkError>;
type Diagnostic = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct NativeReaderOptions {
    pub sessions_root: Option<String>,
    pub user_data_root: Option<String>,
    pub snapshot_root: Option<String>,
    pub max_cache_bytes: Option<usize>,
    pub max_files: Option<usize>,
    pub ttl_ms: Option<u64>,
    pub diagnostic: Option<Diagnostic>,
}
#[derive(Clone, Debug, Default)]
pub struct NativeReaderStats {
    pub body_read_bytes: u64,
    pub parsed_rows: u64,
    pub cache_hits: u64,
    pub resets: u64,
    pub evictions: u64,
    pub retained_bytes: usize,
    pub files: usize,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Trajectory,
    Assignment,
    Snapshot,
}
#[derive(Clone, PartialEq)]
struct Stamp {
    identity: String,
    size: u64,
    modified: Option<SystemTime>,
    changed: (i64, i64),
}
struct Row {
    index: usize,
    bytes: usize,
    value: Arc<Value>,
    demand: Option<String>,
}
#[derive(Default)]
struct ActorState {
    rows: VecDeque<Row>,
    row_count: usize,
    bytes: usize,
    content: NativeContent,
    content_invalid: bool,
    graph_invalid: bool,
    call_count: usize,
    call_bytes: usize,
    creation_calls: HashSet<String>,
    edges: IndexMap<String, NativeEdge>,
    user_demands: IndexMap<String, VecDeque<usize>>,
}
struct CurrentAssignment {
    time_ms: Option<i64>,
    chunks: String,
    bytes: usize,
    overflow: bool,
}
struct Source {
    kind: Kind,
    conversation: String,
    actor: String,
    stamp: Stamp,
    offset: u64,
    committed: u64,
    buffer: Vec<u8>,
    ready: bool,
    first: Vec<u8>,
    tail: Vec<u8>,
    version: u64,
    created_at: SystemTime,
    last_active: SystemTime,
    state: Option<ActorState>,
    chunks: Vec<u8>,
    execution: Option<NativeExecution>,
    assignments: VecDeque<NativeAssignment>,
    first_assignment: Option<NativeAssignment>,
    assignment_bytes: usize,
    first_assignment_bytes: usize,
    current_assignment: Option<CurrentAssignment>,
    parse_failure: Option<String>,
}
pub struct DoubaoWorkNativeReader {
    options: NativeReaderOptions,
    files: IndexMap<PathBuf, Source>,
    graphs: IndexMap<String, (Vec<u64>, Arc<NativeGraph>)>,
    active: HashSet<String>,
    sequence: u64,
    reported: HashSet<String>,
    counters: NativeReaderStats,
    #[cfg(test)]
    execution_scans: u64,
    #[cfg(test)]
    next_stat_error: Option<std::io::ErrorKind>,
}
impl DoubaoWorkNativeReader {
    pub fn new(options: NativeReaderOptions) -> Self {
        Self {
            options,
            files: IndexMap::new(),
            graphs: IndexMap::new(),
            active: HashSet::new(),
            sequence: 0,
            reported: HashSet::new(),
            counters: NativeReaderStats::default(),
            #[cfg(test)]
            execution_scans: 0,
            #[cfg(test)]
            next_stat_error: None,
        }
    }
    #[cfg(test)]
    pub(super) fn execution_scan_count(&self) -> u64 {
        self.execution_scans
    }
    #[cfg(test)]
    pub(super) fn fail_next_stat(&mut self, kind: std::io::ErrorKind) {
        self.next_stat_error = Some(kind);
    }
    #[cfg(test)]
    pub(super) fn configured_roots(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.options.sessions_root.as_deref(),
            self.options.user_data_root.as_deref(),
            self.options.snapshot_root.as_deref(),
        )
    }
    pub fn begin_cycle(&mut self, active: HashSet<String>) -> Result<()> {
        self.active = active;
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_millis(
                self.options.ttl_ms.unwrap_or(15 * 60_000),
            ))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let keys: Vec<_> = self
            .files
            .iter()
            .filter(|(_, s)| {
                !self.active.contains(&s.conversation) && s.last_active.max(s.created_at) < cutoff
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.evict(&key);
        }
        self.bound(None, None)
    }
    pub fn clear(&mut self) {
        self.files.clear();
        self.graphs.clear();
    }
    pub fn stats(&self) -> NativeReaderStats {
        NativeReaderStats {
            retained_bytes: self.retained_bytes(),
            files: self.files.len(),
            ..self.counters.clone()
        }
    }
    pub async fn graph(
        &mut self,
        conversation: &str,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<Option<Arc<NativeGraph>>> {
        if !native_id(conversation) {
            return Ok(None);
        }
        self.active.insert(conversation.to_owned());
        let Some(sessions) = self.sessions(conversation).await? else {
            return Ok(None);
        };
        let folder = sessions.join(conversation).join("agents");
        let canonical_sessions = fs::canonicalize(&sessions).await?;
        let allowed = fs::canonicalize(&folder).await?;
        if !strictly_within(&allowed, &canonical_sessions) {
            return Err(invalid("Unsafe native conversation directory"));
        }
        let mut actors = Vec::new();
        let mut entries = fs::read_dir(&folder).await?;
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && !kind.is_symlink() && native_id(&name) {
                actors.push(name);
            }
        }
        if actors.len() > 64 {
            self.diagnostic("agent_capacity");
            return Ok(None);
        }
        let mains: Vec<_> = actors.iter().filter(|s| is_main(s)).collect();
        if mains.len() != 1 {
            return Ok(None);
        }
        let main = mains[0].clone();
        let mut sources = Vec::new();
        let mut assignments = Vec::new();
        for actor in &actors {
            let system = folder.join(actor).join("system");
            for (name, kind, keys) in [
                ("assignment.md", Kind::Assignment, &mut assignments),
                ("trajectory.jsonl", Kind::Trajectory, &mut sources),
            ] {
                let file = system.join(name);
                match self
                    .load(&file, &allowed, kind, conversation, actor, &main, budget)
                    .await
                {
                    Ok(()) => keys.push(file),
                    Err(e) if missing(&e) => (),
                    Err(e) => return Err(e),
                }
            }
        }
        if !sources
            .iter()
            .any(|k| self.files.get(k).is_some_and(|s| s.actor == main))
        {
            return Ok(None);
        }
        let versions: Vec<_> = sources
            .iter()
            .chain(&assignments)
            .map(|k| self.files[k].version)
            .collect();
        if let Some((old, graph)) = self.graphs.get(conversation) {
            if old == &versions {
                return Ok(Some(Arc::clone(graph)));
            }
        }
        let mut graph = NativeGraph {
            main,
            edges: IndexMap::new(),
            content: Some(NativeContent::default()),
        };
        let mut user_rows = IndexMap::new();
        let mut calls = 0;
        let mut unavailable = false;
        for key in &sources {
            let source = &self.files[key];
            let state = source.state.as_ref().expect("trajectory state");
            if state.graph_invalid {
                self.diagnostic("invalid_native_record");
                return Ok(None);
            }
            unavailable |= state.content_invalid;
            for (id, edge) in &state.edges {
                if let Some(prior) = graph.edges.get(id) {
                    if serde_json::to_value(prior)? != serde_json::to_value(edge)? {
                        return Ok(None);
                    }
                }
                graph.edges.insert(id.clone(), edge.clone());
            }
            let content = graph.content.as_mut().unwrap();
            for (id, call) in &state.content.calls {
                unavailable |= content.calls.contains_key(id);
                calls += 1;
                if calls > MAX_CALLS {
                    unavailable = true;
                } else {
                    content.calls.insert(id.clone(), call.clone());
                }
            }
            content.transcripts.insert(
                source.actor.clone(),
                state.rows.iter().map(|r| Arc::clone(&r.value)).collect(),
            );
            content.transcript_offsets.insert(
                source.actor.clone(),
                state.rows.front().map_or(state.row_count, |r| r.index),
            );
            content
                .source_versions
                .insert(source.actor.clone(), source.version.to_string());
            content.source_bytes.insert(
                source.actor.clone(),
                state.bytes * 3 + state.call_bytes + state.rows.len() * 256,
            );
            if let Some(answer) = state.content.last_answers.get(&source.actor) {
                content
                    .last_answers
                    .insert(source.actor.clone(), answer.clone());
            }
            user_rows.insert(
                source.actor.clone(),
                state
                    .user_demands
                    .iter()
                    .map(|(key, rows)| (key.clone(), rows.iter().copied().collect()))
                    .collect(),
            );
        }
        for key in assignments {
            let source = &self.files[&key];
            let content = graph.content.as_mut().unwrap();
            content
                .assignments
                .insert(source.actor.clone(), assignment_values(source));
            content
                .source_versions
                .entry(source.actor.clone())
                .or_default()
                .push_str(&format!(":{}", source.version));
        }
        if calls > MAX_CALLS {
            self.diagnostic("call_index_capacity");
        }
        if unavailable {
            self.diagnostic("content_index_unavailable");
            graph.content = None;
        } else {
            graph.content.as_mut().unwrap().user_rows = Some(Arc::new(user_rows));
        }
        let graph = Arc::new(graph);
        self.graphs
            .insert(conversation.to_owned(), (versions, Arc::clone(&graph)));
        self.bound(Some(conversation), None)?;
        Ok(Some(graph))
    }
    pub async fn executions(
        &mut self,
        conversation: &str,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<Vec<NativeExecution>> {
        #[cfg(test)]
        {
            self.execution_scans += 1;
        }

        let Some(root) = self.options.snapshot_root.as_ref() else {
            return Ok(Vec::new());
        };
        if !numeric_id(conversation) {
            return Ok(Vec::new());
        }
        let allowed = fs::canonicalize(root).await?;
        let mut accounts = Vec::new();
        let mut entries = fs::read_dir(&allowed).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type().await?;
            if kind.is_dir() && !kind.is_symlink() && numeric_id(&name) {
                accounts.push(name);
            }
        }
        if accounts.len() > 8 {
            self.diagnostic("snapshot_account_capacity");
            return Err(invalid("Native execution account limit exceeded"));
        }
        let mut result: IndexMap<String, NativeExecution> = IndexMap::new();
        let mut files = 0;
        for account in accounts {
            let folder = allowed.join(account).join(conversation);
            match safe_directory(&folder, &allowed).await {
                Ok(()) => (),
                Err(e) if missing(&e) => continue,
                Err(e) => return Err(e),
            }
            let mut entries = fs::read_dir(&folder).await?;
            let mut executions = Vec::new();
            while let Some(entry) = entries.next_entry().await? {
                let kind = entry.file_type().await?;
                if kind.is_symlink() {
                    return Err(invalid("Unsafe native execution directory"));
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if kind.is_dir() && uuid(&name) {
                    executions.push(name);
                }
            }
            if executions.len() > 128 {
                self.diagnostic("execution_capacity");
                return Err(invalid("Native execution count limit exceeded"));
            }
            for execution in executions {
                let dir = folder.join(&execution);
                safe_directory(&dir, &allowed).await?;
                let mut entries = fs::read_dir(&dir).await?;
                let mut records = Vec::new();
                while let Some(entry) = entries.next_entry().await? {
                    let kind = entry.file_type().await?;
                    if kind.is_symlink() {
                        return Err(invalid("Unsafe native execution record"));
                    }
                    records.push((
                        entry.path(),
                        entry.file_name().to_string_lossy().into_owned(),
                        kind.is_file(),
                    ));
                }
                if records.len() > 64 {
                    self.diagnostic("snapshot_record_capacity");
                    return Err(invalid("Native execution record limit exceeded"));
                }
                for (path, name, regular) in records {
                    let Some(actor) = name.strip_suffix(".json").filter(|s| native_id(s)) else {
                        continue;
                    };
                    if !regular {
                        continue;
                    }
                    files += 1;
                    if files > 128 {
                        self.diagnostic("snapshot_file_capacity");
                        return Err(invalid("Native execution file limit exceeded"));
                    }
                    self.load(
                        &path,
                        &allowed,
                        Kind::Snapshot,
                        conversation,
                        actor,
                        "",
                        budget,
                    )
                    .await?;
                    let Some(value) = &self.files[&path].execution else {
                        continue;
                    };
                    if value.execution_key != execution
                        || value.conversation_id != conversation
                        || value.agent_id != actor
                    {
                        return Err(invalid("Native execution path identity mismatch"));
                    }
                    if let Some(prior) = result.get(&value.execution_key) {
                        if serde_json::to_value(prior)? != serde_json::to_value(value)? {
                            return Err(invalid("Conflicting native execution identity"));
                        }
                    }
                    result.insert(value.execution_key.clone(), value.clone());
                }
            }
        }
        self.bound(Some(conversation), None)?;
        Ok(result.into_values().collect())
    }
    async fn sessions(&self, conversation: &str) -> Result<Option<PathBuf>> {
        if let Some(root) = &self.options.sessions_root {
            return Ok(Some(PathBuf::from(root)));
        }
        let Some(root) = &self.options.user_data_root else {
            return Ok(None);
        };
        let root = fs::canonicalize(root).await?;
        let mut entries = fs::read_dir(&root).await?;
        let mut profiles = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "Default"
                || name
                    .strip_prefix("Profile ")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            {
                let kind = entry.file_type().await?;
                if !kind.is_dir() || kind.is_symlink() {
                    return Ok(None);
                }
                profiles.push(name);
            }
        }
        if profiles.len() > 16 {
            return Ok(None);
        }
        let mut matches = Vec::new();
        for profile in profiles {
            let sessions = root
                .join(profile)
                .join(".doubaowork/agent_mode/workspace/.sessions");
            match safe_directory(&sessions.join(conversation), &root).await {
                Ok(()) => matches.push(sessions),
                Err(e) if missing(&e) => (),
                Err(e) => return Err(e),
            }
        }
        Ok(if matches.len() == 1 {
            matches.pop()
        } else {
            None
        })
    }
    #[allow(clippy::too_many_arguments)]
    async fn load(
        &mut self,
        file: &Path,
        allowed: &Path,
        kind: Kind,
        conversation: &str,
        actor: &str,
        main: &str,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<()> {
        #[cfg(test)]
        if let Some(kind) = self.next_stat_error.take() {
            return Err(std::io::Error::new(kind, "injected temporary source stat failure").into());
        }
        let path_stat = fs::symlink_metadata(file).await?;
        if !path_stat.is_file()
            || path_stat.file_type().is_symlink()
            || !strictly_within(&fs::canonicalize(file).await?, allowed)
        {
            return Err(invalid("Unsafe native source"));
        }
        let mut handle = File::open(file).await?;
        let stamp = stamp_of(&handle).await?;
        if !metadata_matches(&path_stat, &handle.metadata().await?) {
            return Err(deferred("source_changed"));
        }
        if kind == Kind::Snapshot && stamp.size > WINDOW as u64 {
            self.diagnostic("snapshot_byte_capacity");
            return Err(invalid("Native execution read limit exceeded"));
        }
        if let Some(source) = self.files.get_mut(file) {
            if source.stamp == stamp {
                if let Some(message) = &source.parse_failure {
                    return Err(invalid(message));
                }
                if source.ready {
                    let now = SystemTime::now();
                    if self.active.contains(conversation) {
                        source.last_active = now;
                    }
                    self.counters.cache_hits += 1;
                    return Ok(());
                }
            }
        }
        if budget.exhausted() {
            return Err(deferred("cycle_budget"));
        }
        // A budget deferral while checking anchors must retain the old cursor.
        let reset = if let Some(old) = self.files.get(file) {
            if old.stamp != stamp {
                !(old.parse_failure.is_none()
                    && kind != Kind::Snapshot
                    && old.stamp.identity == stamp.identity
                    && stamp.size > old.stamp.size
                    && anchors_match(old, &mut handle, budget).await?)
            } else {
                false
            }
        } else {
            false
        };
        let mut source = self.files.shift_remove(file);
        if reset {
            self.counters.resets += 1;
            self.graphs.shift_remove(conversation);
            source = None;
        }
        let mut source = source.unwrap_or_else(|| {
            self.sequence += 1;
            let now = SystemTime::now();
            Source {
                kind,
                conversation: conversation.to_owned(),
                actor: actor.to_owned(),
                stamp: stamp.clone(),
                offset: 0,
                committed: 0,
                buffer: Vec::new(),
                ready: false,
                first: Vec::new(),
                tail: Vec::new(),
                version: self.sequence,
                created_at: now,
                last_active: if self.active.contains(conversation) {
                    now
                } else {
                    SystemTime::UNIX_EPOCH
                },
                state: (kind == Kind::Trajectory).then(ActorState::default),
                chunks: Vec::new(),
                execution: None,
                assignments: VecDeque::new(),
                first_assignment: None,
                assignment_bytes: 0,
                first_assignment_bytes: 0,
                current_assignment: None,
                parse_failure: None,
            }
        });
        source.stamp = stamp.clone();
        let now = SystemTime::now();
        source.ready = false;
        if self.active.contains(conversation) {
            source.last_active = now;
        }
        let outcome = self
            .load_source(&mut source, &mut handle, &stamp, main, budget)
            .await;
        if let Err(DoubaoWorkError::Json(e)) = &outcome {
            source.parse_failure = Some(e.to_string());
            self.diagnostic("invalid_native_json");
        }
        // Capacity rejection discards this conversation rather than retaining an over-budget body.
        if !matches!(&outcome, Err(DoubaoWorkError::Invalid(s)) if s == "Doubao native cache capacity exceeded")
        {
            self.files.insert(file.to_path_buf(), source);
        }
        outcome
    }
    async fn load_source(
        &mut self,
        source: &mut Source,
        handle: &mut File,
        stamp: &Stamp,
        main: &str,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<()> {
        loop {
            if source.kind != Kind::Snapshot {
                self.lines(source, main, budget).await?;
            }
            if source.offset >= stamp.size {
                break;
            }
            if budget.exhausted() {
                return Err(deferred("cycle_budget"));
            }
            let length = CHUNK
                .min((stamp.size - source.offset) as usize)
                .min(budget.remaining_bytes() as usize);
            let mut buffer = vec![0; length];
            let count = budget
                .read(handle, &mut buffer, length, source.offset, false)
                .await?;
            if count == 0 {
                return Err(deferred("source_changed"));
            }
            buffer.truncate(count);
            self.counters.body_read_bytes += count as u64;
            if source.first.len() < 64 {
                source
                    .first
                    .extend_from_slice(&buffer[..count.min(64 - source.first.len())]);
            }
            source.tail.extend_from_slice(&buffer);
            if source.tail.len() > 64 {
                source.tail.drain(..source.tail.len() - 64);
            }
            source.offset += count as u64;
            self.sequence += 1;
            source.version = self.sequence;
            self.graphs.shift_remove(&source.conversation);
            if source.kind == Kind::Snapshot {
                source.chunks.extend(buffer);
            } else {
                source.buffer.extend(buffer);
            }
            self.bound(Some(&source.conversation), Some(source))?;
        }
        if &stamp_of(handle).await? != stamp {
            return Err(deferred("source_changed"));
        }
        if source.kind == Kind::Snapshot {
            let value = super::util::parse_json(&String::from_utf8_lossy(&source.chunks))?;
            source.execution = parse_native_execution(&value);
            source.chunks.clear();
            source.chunks.shrink_to_fit();
            budget.parsed(stamp.size);
            self.counters.parsed_rows += 1;
        } else if source.kind == Kind::Trajectory && !source.buffer.is_empty() {
            return Err(deferred("partial_line"));
        }
        debug_assert!(source.committed <= source.offset);
        source.ready = true;
        Ok(())
    }
    async fn lines(
        &mut self,
        source: &mut Source,
        main: &str,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<()> {
        let mut from = 0;
        let result: Result<()> = async {
            while from < source.buffer.len() {
                let Some(relative) = source.buffer[from..].iter().position(|b| *b == b'\n') else {
                    if source.buffer.len() - from > WINDOW {
                        self.diagnostic("record_byte_capacity");
                        return Err(invalid("Native record limit exceeded"));
                    }
                    break;
                };
                if budget.exhausted() {
                    return Err(deferred("cycle_budget"));
                }
                let end = from + relative;
                let bytes = end + 1 - from;
                if bytes > WINDOW {
                    self.diagnostic("record_byte_capacity");
                    return Err(invalid("Native record limit exceeded"));
                }
                let line = String::from_utf8_lossy(&source.buffer[from..end]);
                if source.kind == Kind::Trajectory {
                    if !line.is_empty() {
                        let value = super::util::parse_json(&line)?;
                        let reasons = append_row(
                            source.state.as_mut().unwrap(),
                            &source.actor,
                            main,
                            value,
                            bytes,
                        );
                        for reason in reasons {
                            self.diagnostic(reason);
                        }
                    }
                } else {
                    let line = format!("{line}\n");
                    if assignment_line(source, &line) {
                        self.diagnostic("assignment_window");
                    }
                }
                from = end + 1;
                source.committed += bytes as u64;
                budget.parsed(bytes as u64);
                self.counters.parsed_rows += 1;
                budget.yield_if_needed().await;
            }
            Ok(())
        }
        .await;
        if from != 0 {
            source.buffer.drain(..from);
        }
        result
    }
    fn retained_bytes(&self) -> usize {
        self.files.values().map(source_bytes).sum()
    }
    fn bound(&mut self, protected: Option<&str>, extra: Option<&Source>) -> Result<()> {
        let limit = self.options.max_cache_bytes.unwrap_or(64 * 1024 * 1024);
        let max_files = self.options.max_files.unwrap_or(512);
        let over = |this: &Self| {
            this.files.len() + usize::from(extra.is_some()) > max_files
                || this.retained_bytes() + extra.map_or(0, source_bytes) > limit
        };
        if !over(self) {
            return Ok(());
        }
        let mut ordered: Vec<_> = self
            .files
            .iter()
            .filter(|(_, s)| Some(s.conversation.as_str()) != protected)
            .map(|(k, s)| {
                (
                    k.clone(),
                    self.active.contains(&s.conversation),
                    s.last_active,
                    s.created_at,
                )
            })
            .collect();
        ordered.sort_by_key(|(_, active, last, created)| (*active, *last, *created));
        for (key, _, _, _) in ordered {
            self.evict(&key);
            if !over(self) {
                return Ok(());
            }
        }
        if over(self) {
            let keys: Vec<_> = self
                .files
                .iter()
                .filter(|(_, s)| Some(s.conversation.as_str()) == protected)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys {
                self.evict(&key);
            }
            self.diagnostic("cache_capacity");
            return Err(invalid("Doubao native cache capacity exceeded"));
        }
        Ok(())
    }
    fn evict(&mut self, key: &Path) {
        if let Some(source) = self.files.shift_remove(key) {
            self.graphs.shift_remove(&source.conversation);
            self.counters.evictions += 1;
        }
    }
    fn diagnostic(&mut self, reason: &str) {
        if self.reported.insert(reason.to_owned()) {
            if let Some(callback) = &self.options.diagnostic {
                callback(reason);
            }
        }
    }
}
fn append_row(
    state: &mut ActorState,
    actor: &str,
    main: &str,
    value: Value,
    bytes: usize,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    let index = state.row_count;
    state.row_count += 1;
    if !value.is_object() {
        state.graph_invalid = true;
        return reasons;
    }
    if !state.graph_invalid
        && !append_native_graph_row(
            main,
            actor,
            &value,
            &mut state.creation_calls,
            &mut state.edges,
        )
    {
        state.graph_invalid = true;
    }
    if state.creation_calls.len() > MAX_CALLS || state.edges.len() > 64 {
        state.graph_invalid = true;
    }
    let ids: Vec<String> = if value["role"] == "assistant" {
        value["tool_calls"]
            .as_array()
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|c| c["id"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        value["tool_call_id"]
            .as_str()
            .map(|s| vec![s.to_owned()])
            .unwrap_or_default()
    };
    let before: usize = ids
        .iter()
        .map(|id| call_bytes(state.content.calls.get(id)))
        .sum();
    if !state.content_invalid
        && !append_native_content_row(
            &mut state.content,
            actor,
            &value,
            index,
            state.rows.front().is_some_and(|r| r.index > 0),
        )
    {
        state.content_invalid = true;
    }
    if value["role"] == "assistant" {
        state.call_count += value["tool_calls"].as_array().map_or(0, Vec::len);
    }
    let after: usize = ids
        .iter()
        .map(|id| call_bytes(state.content.calls.get(id)))
        .sum();
    state.call_bytes = state.call_bytes.saturating_sub(before) + after;
    let demand = (value["role"] == "user")
        .then(|| value["content"].as_str())
        .flatten()
        .filter(|s| s.encode_utf16().count() <= 64 * 1024)
        .map(native_demand_fingerprint);
    if let Some(key) = &demand {
        state
            .user_demands
            .entry(key.clone())
            .or_default()
            .push_back(index);
    }
    state.rows.push_back(Row {
        index,
        bytes,
        value: Arc::new(value),
        demand,
    });
    state.bytes += bytes;
    if state.bytes > WINDOW {
        reasons.push("content_window");
    }
    while state.bytes > WINDOW && state.rows.len() > 1 {
        trim(state);
    }
    if state.call_count > MAX_CALLS {
        let calls: Vec<_> = state.content.calls.keys().cloned().collect();
        let cutoff = calls
            .get(calls.len().saturating_sub(MAX_CALLS * 3 / 4))
            .and_then(|id| state.content.calls.get(id))
            .map_or(index, |c| c.record_index);
        while state.rows.front().is_some_and(|r| r.index < cutoff) {
            trim(state);
        }
        for id in calls {
            if state
                .content
                .calls
                .get(&id)
                .is_some_and(|c| c.record_index < cutoff)
            {
                if let Some(call) = state.content.calls.shift_remove(&id) {
                    state.call_bytes = state.call_bytes.saturating_sub(call_bytes(Some(&call)));
                    state.call_count = state.call_count.saturating_sub(1);
                }
            }
        }
        reasons.push("content_window");
    }
    reasons
}
fn trim(state: &mut ActorState) {
    let Some(row) = state.rows.pop_front() else {
        return;
    };
    state.bytes -= row.bytes;
    if let Some(key) = &row.demand {
        if let Some(indices) = state.user_demands.get_mut(key) {
            indices.pop_front();
            if indices.is_empty() {
                state.user_demands.shift_remove(key);
            }
        }
    }
    if let Some(calls) = row.value["tool_calls"].as_array() {
        for id in calls.iter().filter_map(|c| c["id"].as_str()) {
            let Some(call) = state
                .content
                .calls
                .get_mut(id)
                .filter(|c| c.record_index == row.index)
            else {
                continue;
            };
            state.call_bytes = state.call_bytes.saturating_sub(call_bytes(Some(call)));
            if call.result_index.is_some() {
                state.content.calls.shift_remove(id);
                state.call_count = state.call_count.saturating_sub(1);
            } else {
                call.arguments = None;
                call.result = None;
                state.call_bytes += call_bytes(Some(call));
            }
        }
    }
    if row.value["role"] == "tool" {
        if let Some(id) = row.value["tool_call_id"].as_str() {
            if state.content.calls.get(id).is_some_and(|c| {
                c.result_index == Some(row.index)
                    && c.record_index < state.rows.front().map_or(state.row_count, |r| r.index)
            }) {
                if let Some(call) = state.content.calls.shift_remove(id) {
                    state.call_bytes = state.call_bytes.saturating_sub(call_bytes(Some(&call)));
                    state.call_count = state.call_count.saturating_sub(1);
                }
            }
        }
    }
}
fn call_bytes(call: Option<&NativeCallContent>) -> usize {
    call.map_or(0, |c| {
        (c.arguments.as_ref().map_or(0, String::len) + c.result.as_ref().map_or(0, String::len)) * 2
            + 256
    })
}
fn current_assignment(source: &Source, tail: &str) -> Option<NativeAssignment> {
    let current = source.current_assignment.as_ref()?;
    if current.overflow {
        return None;
    }
    let time_ms = current.time_ms?;
    let text = format!("{}{tail}", current.chunks).trim().to_owned();
    (!text.is_empty() && text.len() <= 64 * 1024).then_some(NativeAssignment { time_ms, text })
}
fn assignment_line(source: &mut Source, line: &str) -> bool {
    let header = line.strip_prefix("## [").and_then(|s| {
        s.strip_suffix("] 需求\n")
            .or_else(|| s.strip_suffix("] 需求\r\n"))
    });
    if let Some(time) = header.filter(|s| !s.is_empty() && !s.contains([']', '\r', '\n'])) {
        if let Some(previous) = current_assignment(source, "") {
            let bytes = previous.text.len() * 2 + 64;
            if source.first_assignment.is_none() {
                source.first_assignment = Some(previous.clone());
                source.first_assignment_bytes = bytes;
            }
            source.assignments.push_back(previous);
            source.assignment_bytes += bytes;
            if source.assignments.len() > 512 {
                if let Some(old) = source.assignments.pop_front() {
                    source.assignment_bytes -= old.text.len() * 2 + 64;
                }
                source.current_assignment = Some(CurrentAssignment {
                    time_ms: parse_time_ms(time),
                    chunks: String::new(),
                    bytes: 0,
                    overflow: false,
                });
                return true;
            }
        }
        source.current_assignment = Some(CurrentAssignment {
            time_ms: parse_time_ms(time),
            chunks: String::new(),
            bytes: 0,
            overflow: false,
        });
    } else if let Some(current) = &mut source.current_assignment {
        current.bytes += line.len();
        if current.bytes > WINDOW {
            current.overflow = true;
            current.chunks.clear();
            current.chunks.shrink_to_fit();
        } else {
            current.chunks.push_str(line);
        }
    }
    false
}
fn assignment_values(source: &Source) -> Vec<NativeAssignment> {
    let mut values: Vec<_> = source.assignments.iter().cloned().collect();
    if let Some(first) = &source.first_assignment {
        if !values
            .iter()
            .any(|v| v.time_ms == first.time_ms && v.text == first.text)
        {
            values.insert(0, first.clone());
        }
    }
    if let Some(current) = current_assignment(source, &String::from_utf8_lossy(&source.buffer)) {
        values.push(current);
    }
    values
}
fn source_bytes(source: &Source) -> usize {
    source.buffer.len()
        + source.chunks.len()
        + 512
        + source
            .state
            .as_ref()
            .map_or(0, |s| s.bytes * 3 + s.rows.len() * 256 + s.call_bytes)
        + source
            .current_assignment
            .as_ref()
            .filter(|c| !c.overflow)
            .map_or(0, |c| c.bytes * 2)
        + source.assignment_bytes
        + source.first_assignment_bytes
}
async fn anchors_match(
    source: &Source,
    handle: &mut File,
    budget: &mut DoubaoWorkBudget<'_>,
) -> Result<bool> {
    for (expected, position) in [
        (&source.first, 0),
        (&source.tail, source.offset - source.tail.len() as u64),
    ] {
        if expected.is_empty() {
            continue;
        }
        let mut actual = vec![0; expected.len()];
        let count = budget
            .read(handle, &mut actual, expected.len(), position, false)
            .await?;
        if count != expected.len() || &actual != expected {
            return Ok(false);
        }
    }
    Ok(true)
}
async fn stamp_of(handle: &File) -> Result<Stamp> {
    let standard = handle.try_clone().await?.into_std().await;
    let identity = crate::utils::file_identity::identity_from_open(&standard)?;
    let meta = standard.metadata()?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (meta.ctime(), meta.ctime_nsec())
    };
    #[cfg(windows)]
    let changed = windows_change_stamp(&standard)?;
    Ok(Stamp {
        identity: format!(
            "{}:{}:{}",
            identity.dev, identity.ino, identity.birthtime_ms
        ),
        size: identity.size,
        modified: meta.modified().ok(),
        changed,
    })
}
#[cfg(windows)]
fn windows_change_stamp(file: &std::fs::File) -> std::io::Result<(i64, i64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
    };
    let mut info = std::mem::MaybeUninit::<FILE_BASIC_INFO>::zeroed();
    // SAFETY: File owns the live handle; the output buffer has the exact
    // FILE_BASIC_INFO layout and size required by FileBasicInfo.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful call initializes the entire FILE_BASIC_INFO.
    let info = unsafe { info.assume_init() };
    // LastWriteTime can be restored by a producer. ChangeTime still witnesses
    // a same-size rewrite, preventing reuse of stale native content.
    Ok((info.ChangeTime, info.CreationTime))
}
fn metadata_matches(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    if a.len() != b.len() || a.modified().ok() != b.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev()
            || a.ino() != b.ino()
            || a.ctime() != b.ctime()
            || a.ctime_nsec() != b.ctime_nsec()
        {
            return false;
        }
    }
    true
}
async fn safe_directory(folder: &Path, allowed: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(folder).await?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || !strictly_within(&fs::canonicalize(folder).await?, allowed)
    {
        return Err(invalid("Unsafe native directory"));
    }
    Ok(())
}
fn strictly_within(path: &Path, allowed: &Path) -> bool {
    path != allowed && path.starts_with(allowed)
}
fn is_main(s: &str) -> bool {
    s.strip_prefix("m_")
        .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric()))
}
fn invalid(s: &str) -> DoubaoWorkError {
    DoubaoWorkError::Invalid(s.to_owned())
}
fn deferred(s: &str) -> DoubaoWorkError {
    DoubaoWorkError::Deferred(s.to_owned())
}
fn missing(e: &DoubaoWorkError) -> bool {
    matches!(e,DoubaoWorkError::Io(e) if e.kind()==std::io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::super::budget::DoubaoWorkBudgetOptions;
    use super::*;
    use serde_json::json;
    const CID: &str = "12345678";
    const ACTOR: &str = "m_main";
    const EPOCH: i64 = 1_800_000_000_000;
    fn budget(bytes: u64, records: u64) -> DoubaoWorkBudget<'static> {
        DoubaoWorkBudget::new(
            DoubaoWorkBudgetOptions {
                bytes,
                records,
                milliseconds: 1000,
            },
            None,
        )
    }
    fn full_budget() -> DoubaoWorkBudget<'static> {
        budget(8 * 1024 * 1024, 4096)
    }
    fn options(root: &Path) -> NativeReaderOptions {
        NativeReaderOptions {
            sessions_root: Some(root.to_string_lossy().into_owned()),
            ..Default::default()
        }
    }
    fn serialized(rows: &[Value]) -> Vec<u8> {
        rows.iter()
            .flat_map(|r| format!("{}\n", serde_json::to_string(r).unwrap()).into_bytes())
            .collect()
    }
    fn assignment(text: &str) -> String {
        format!(
            "## [{}] 需求\n{text}\n",
            chrono::DateTime::from_timestamp_millis(EPOCH + 1)
                .unwrap()
                .to_rfc3339()
        )
    }
    async fn save(root: &Path, cid: &str, rows: &[Value]) -> PathBuf {
        let system = root.join(cid).join("agents").join(ACTOR).join("system");
        fs::create_dir_all(&system).await.unwrap();
        let file = system.join("trajectory.jsonl");
        fs::write(&file, serialized(rows)).await.unwrap();
        fs::write(system.join("assignment.md"), assignment("CURRENT"))
            .await
            .unwrap();
        file
    }
    async fn drain(reader: &mut DoubaoWorkNativeReader, cid: &str, bytes: u64) -> Arc<NativeGraph> {
        for _ in 0..100 {
            match reader.graph(cid, &mut budget(bytes, 4096)).await {
                Ok(Some(graph)) => return graph,
                Err(DoubaoWorkError::Deferred(reason)) if reason == "cycle_budget" => (),
                other => panic!(
                    "unexpected drain outcome: {}",
                    match other {
                        Ok(_) => "no graph".to_owned(),
                        Err(e) => e.to_string(),
                    }
                ),
            }
        }
        panic!("native reader did not drain within 100 bounded cycles")
    }
    #[tokio::test]
    async fn unchanged_sources_share_graph_and_do_not_read_or_parse_again() {
        let temp = tempfile::tempdir().unwrap();
        save(temp.path(),CID,&[
            json!({"role":"assistant","tool_calls":[{"id":"one","function":{"name":"Read","arguments":{"file_path":"synthetic.txt"}}}]}),
            json!({"role":"tool","tool_call_id":"one","content":"visible result中文"}),
            json!({"role":"assistant","content":"FINAL"})
        ]).await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        let content = graph.content.as_ref().unwrap();
        assert_eq!(
            content.calls["one"].result.as_deref(),
            Some("visible result中文")
        );
        assert_eq!(content.assignments[ACTOR][0].text, "CURRENT");
        let before = reader.stats();
        for _ in 0..10 {
            let next = reader
                .graph(CID, &mut full_budget())
                .await
                .unwrap()
                .unwrap();
            assert!(Arc::ptr_eq(&graph, &next));
        }
        let after = reader.stats();
        assert_eq!(after.body_read_bytes, before.body_read_bytes);
        assert_eq!(after.parsed_rows, before.parsed_rows);
        assert_eq!(after.cache_hits - before.cache_hits, 20);
    }
    #[tokio::test]
    async fn partial_utf8_line_waits_without_rereading_then_only_parses_new_record() {
        use tokio::io::AsyncWriteExt;
        let temp = tempfile::tempdir().unwrap();
        let file = save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"OLD"})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        drain(&mut reader, CID, 256 * 1024).await;
        let line = serialized(&[json!({"role":"assistant","content":"中文追加"})]);
        let split = line
            .windows("中".len())
            .position(|s| s == "中".as_bytes())
            .unwrap()
            + 1;
        let mut handle = fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .await
            .unwrap();
        handle.write_all(&line[..split]).await.unwrap();
        handle.flush().await.unwrap();
        assert!(
            matches!(reader.graph(CID,&mut full_budget()).await,Err(DoubaoWorkError::Deferred(s)) if s=="partial_line")
        );
        let before = reader.stats();
        assert!(
            matches!(reader.graph(CID,&mut full_budget()).await,Err(DoubaoWorkError::Deferred(s)) if s=="partial_line")
        );
        assert_eq!(reader.stats().body_read_bytes, before.body_read_bytes);
        handle.write_all(&line[split..]).await.unwrap();
        handle.flush().await.unwrap();
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        assert_eq!(
            graph.content.as_ref().unwrap().transcripts[ACTOR]
                .last()
                .unwrap()["content"],
            "中文追加"
        );
        assert_eq!(reader.stats().parsed_rows - before.parsed_rows, 1);
        assert_eq!(
            reader.stats().body_read_bytes - before.body_read_bytes,
            (line.len() - split) as u64
        );
    }
    #[tokio::test]
    async fn same_size_replacement_and_truncate_regrow_reset_native_state() {
        for mode in ["same-size", "replacement", "truncate-regrow"] {
            let temp = tempfile::tempdir().unwrap();
            let file = save(
                temp.path(),
                CID,
                &[json!({"role":"assistant","content":"OLD!"})],
            )
            .await;
            let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
            drain(&mut reader, CID, 256 * 1024).await;
            let old = std::fs::metadata(&file).unwrap();
            #[cfg(windows)]
            let old_change = windows_change_stamp(&std::fs::File::open(&file).unwrap()).unwrap();
            #[cfg(windows)]
            if mode == "same-size" {
                // NTFS change-time observations can share a clock tick. Make
                // this fixture's change witness distinct while restoring mtime
                // exactly below; all content/reset assertions remain unchanged.
                tokio::time::sleep(Duration::from_millis(32)).await;
            }
            if mode == "replacement" {
                fs::rename(&file, file.with_extension("saved"))
                    .await
                    .unwrap();
            }
            let mut rows = vec![json!({"role":"assistant","content":"NEW!"})];
            if mode == "truncate-regrow" {
                rows.push(json!({"role":"assistant","content":"longer new tail"}));
            }
            fs::write(&file, serialized(&rows)).await.unwrap();
            if mode == "same-size" {
                let handle = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
                handle
                    .set_times(std::fs::FileTimes::new().set_modified(old.modified().unwrap()))
                    .unwrap();
                drop(handle);
                assert_eq!(
                    std::fs::metadata(&file).unwrap().modified().unwrap(),
                    old.modified().unwrap()
                );
                #[cfg(windows)]
                assert_ne!(
                    windows_change_stamp(&std::fs::File::open(&file).unwrap()).unwrap(),
                    old_change,
                    "the restored-mtime fixture must expose a distinct change-time witness"
                );
            }
            let graph = drain(&mut reader, CID, 256 * 1024).await;
            let transcript = &graph.content.as_ref().unwrap().transcripts[ACTOR];
            assert_eq!(transcript[0]["content"], "NEW!", "mode={mode}");
            assert!(transcript.iter().all(|r| r["content"] != "OLD!"));
            assert_eq!(reader.stats().resets, 1, "mode={mode}");
        }
    }
    #[tokio::test]
    async fn record_budget_resumes_from_committed_line_without_reparse() {
        let temp = tempfile::tempdir().unwrap();
        let rows: Vec<_> = (0..100)
            .map(|i| json!({"role":"assistant","content":format!("answer-{i}")}))
            .collect();
        let file = save(temp.path(), CID, &rows).await;
        // No assignment means a single source owns this precise record budget.
        fs::remove_file(file.with_file_name("assignment.md"))
            .await
            .unwrap();
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        for count in [7, 14, 21] {
            assert!(
                matches!(reader.graph(CID,&mut budget(1024*1024,7)).await,Err(DoubaoWorkError::Deferred(s)) if s=="cycle_budget")
            );
            assert_eq!(reader.stats().parsed_rows, count);
        }
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        assert_eq!(
            graph.content.as_ref().unwrap().transcripts[ACTOR].len(),
            100
        );
        assert_eq!(reader.stats().parsed_rows, 100);
        assert_eq!(
            reader.stats().body_read_bytes,
            fs::metadata(&file).await.unwrap().len()
        );
    }
    #[tokio::test]
    async fn anchor_budget_deferral_retains_old_cursor_and_ancestry() {
        use tokio::io::AsyncWriteExt;
        let temp = tempfile::tempdir().unwrap();
        let file = save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"old-answer".repeat(12)})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        drain(&mut reader, CID, 256 * 1024).await;
        let before = reader.stats();
        let mut handle = fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .await
            .unwrap();
        let appended = serialized(&[json!({"role":"assistant","content":"new-answer"})]);
        handle.write_all(&appended).await.unwrap();
        handle.flush().await.unwrap();
        // First anchor spends all 64 bytes; second must defer without dropping the cursor.
        assert!(
            matches!(reader.graph(CID,&mut budget(64,4096)).await,Err(DoubaoWorkError::Deferred(s)) if s=="cycle_budget")
        );
        assert_eq!(reader.stats().files, before.files);
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        assert_eq!(graph.content.as_ref().unwrap().transcripts[ACTOR].len(), 2);
        assert_eq!(reader.stats().resets, 0);
        assert_eq!(
            reader.stats().body_read_bytes - before.body_read_bytes,
            appended.len() as u64
        );
    }
    #[tokio::test]
    async fn execution_cache_discards_private_body_and_invalidates_failed_parse() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("snapshots");
        let key = "00000000-0000-4000-8000-000000000001";
        let directory = root.join("123").join(CID).join(key);
        fs::create_dir_all(&directory).await.unwrap();
        let file = directory.join("s_child.json");
        let mut execution = json!({"executionKey":key,"conversationId":CID,"queryMessageId":"00000000-0000-4000-8000-000000000002","agentId":"s_child","agentType":"sub_agent","sandboxId":"box","startedAtMs":EPOCH,"endedAtMs":EPOCH+1000});
        fs::write(
            &file,
            serde_json::to_vec(
                &json!({"execution":execution,"fileContents":"PRIVATE_BODY".repeat(90_000)}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            snapshot_root: Some(root.to_string_lossy().into_owned()),
            ..Default::default()
        });
        let values = reader.executions(CID, &mut full_budget()).await.unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].ended_at_ms, EPOCH + 1000);
        let before = reader.stats();
        assert!(before.retained_bytes < 4096);
        for _ in 0..10 {
            assert_eq!(
                reader.executions(CID, &mut full_budget()).await.unwrap()[0].ended_at_ms,
                EPOCH + 1000
            );
        }
        assert_eq!(reader.stats().body_read_bytes, before.body_read_bytes);
        assert_eq!(reader.stats().parsed_rows, before.parsed_rows);
        execution["endedAtMs"] = json!(EPOCH + 1001);
        fs::write(
            &file,
            serde_json::to_vec(&json!({"execution":execution})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            reader.executions(CID, &mut full_budget()).await.unwrap()[0].ended_at_ms,
            EPOCH + 1001
        );
        fs::write(&file, b"{half").await.unwrap();
        assert!(reader.executions(CID, &mut full_budget()).await.is_err());
        let failed = reader.stats();
        assert!(reader.executions(CID, &mut full_budget()).await.is_err());
        assert_eq!(reader.stats().body_read_bytes, failed.body_read_bytes);
        fs::write(
            &file,
            serde_json::to_vec(&json!({"execution":execution})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            reader
                .executions(CID, &mut full_budget())
                .await
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn growth_beyond_two_mib_keeps_early_creation_edges_and_recent_demands() {
        let temp = tempfile::tempdir().unwrap();
        let mut rows = vec![
            json!({"role":"assistant","tool_calls":[{"id":"create-one","function":{"name":"create_agent","arguments":{"task":"synthetic"}}}]}),
            json!({"role":"tool","tool_call_id":"create-one","content":"create_agent ok\nagent_id: s_child\nparent_id: main_agent\nthread_id: 123\n"}),
        ];
        rows.extend((0..220).map(|i|json!({"role":if i%2==0{"user"}else{"assistant"},"content":format!("{i}{}","x".repeat(16_000))})));
        rows.push(json!({"role":"user","content":"CURRENT"}));
        rows.push(
            json!({"role":"assistant","content":"parallel","tool_calls":[
                {"id":"one","function":{"name":"Read","arguments":{"file_path":"one"}}},
                {"id":"two","function":{"name":"Read","arguments":{"file_path":"two"}}}
            ]}),
        );
        rows.push(json!({"role":"tool","tool_call_id":"two","content":"second"}));
        rows.push(json!({"role":"tool","tool_call_id":"one","content":"first"}));
        rows.push(json!({"role":"assistant","content":"FINAL"}));
        let file = save(temp.path(), CID, &rows).await;
        let old_time = chrono::DateTime::from_timestamp_millis(EPOCH - 1000)
            .unwrap()
            .to_rfc3339();
        let tasks = format!("## [{old_time}] 需求\nOLD\n{}", assignment("CURRENT"));
        fs::write(file.with_file_name("assignment.md"), &tasks)
            .await
            .unwrap();
        let bytes = fs::metadata(&file).await.unwrap().len()
            + fs::metadata(file.with_file_name("assignment.md"))
                .await
                .unwrap()
                .len();
        assert!(bytes > WINDOW as u64);
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 128 * 1024).await;
        assert!(graph.edges.contains_key("s_child"));
        let content = graph.content.as_ref().unwrap();
        assert!(content.transcript_offsets[ACTOR] > 0);
        assert_eq!(
            content.transcripts[ACTOR].last().unwrap()["content"],
            "FINAL"
        );
        let demand = native_demand_fingerprint("CURRENT");
        assert_eq!(
            content.find_user_rows(ACTOR, &demand),
            Some([222].as_slice())
        );
        assert!(reader.reported.contains("content_window"));
        assert_eq!(reader.stats().body_read_bytes, bytes);
        assert!(reader.stats().retained_bytes < 8 * 1024 * 1024);
        let full = super::super::content::parse_native_content(
            &IndexMap::from([(
                ACTOR.to_owned(),
                String::from_utf8(serialized(&rows)).unwrap(),
            )]),
            &IndexMap::from([(ACTOR.to_owned(), tasks)]),
        )
        .unwrap()
        .unwrap();
        let call_ids = vec!["one".to_owned(), "two".to_owned()];
        let end_nano = (i128::from(EPOCH + 5000) * 1_000_000).to_string();
        let expected = super::super::rounds::reconstruct_native_rounds(
            Some(&full),
            ACTOR,
            EPOCH,
            &end_nano,
            &call_ids,
            "client_request",
        )
        .unwrap();
        let actual = super::super::rounds::reconstruct_native_rounds(
            Some(content),
            ACTOR,
            EPOCH,
            &end_nano,
            &call_ids,
            "client_request",
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&actual).unwrap(),
            serde_json::to_value(&expected).unwrap()
        );
        assert_eq!(actual.rounds.len(), 2);
        let before = reader.stats();
        let tail = serialized(&[
            json!({"role":"user","content":"NEXT"}),
            json!({"role":"assistant","content":"NEXT_FINAL"}),
        ]);
        use tokio::io::AsyncWriteExt;
        let mut append = fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .await
            .unwrap();
        append.write_all(&tail).await.unwrap();
        append.flush().await.unwrap();
        let next = drain(&mut reader, CID, 128 * 1024).await;
        assert!(next.edges.contains_key("s_child"));
        assert_eq!(reader.stats().parsed_rows - before.parsed_rows, 2);
    }
    #[tokio::test]
    async fn cache_capacity_protects_active_entries_and_evicts_rejected_source() {
        let temp = tempfile::tempdir().unwrap();
        for cid in ["1", "2", "3"] {
            save(
                temp.path(),
                cid,
                &[json!({"role":"assistant","content":"FINAL"})],
            )
            .await;
        }
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            max_files: Some(4),
            ..options(temp.path())
        });
        drain(&mut reader, "1", 256 * 1024).await;
        reader.begin_cycle(HashSet::from(["2".to_owned()])).unwrap();
        drain(&mut reader, "2", 256 * 1024).await;
        drain(&mut reader, "3", 256 * 1024).await;
        assert!(reader.stats().files <= 4);
        let before = reader.stats().body_read_bytes;
        drain(&mut reader, "2", 256 * 1024).await;
        assert_eq!(reader.stats().body_read_bytes, before);
        let mut tiny = DoubaoWorkNativeReader::new(NativeReaderOptions {
            max_cache_bytes: Some(10),
            ..options(temp.path())
        });
        assert!(
            matches!(tiny.graph("1",&mut full_budget()).await,Err(DoubaoWorkError::Invalid(s)) if s.contains("capacity"))
        );
        assert!(tiny.stats().retained_bytes <= 10);
        assert!(tiny.reported.contains("cache_capacity"));
    }
    #[tokio::test]
    async fn inactive_ttl_expiry_does_not_expire_active_sources() {
        let temp = tempfile::tempdir().unwrap();
        for cid in ["1", "2"] {
            save(
                temp.path(),
                cid,
                &[json!({"role":"assistant","content":"FINAL"})],
            )
            .await;
        }
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            ttl_ms: Some(1000),
            ..options(temp.path())
        });
        drain(&mut reader, "1", 256 * 1024).await;
        drain(&mut reader, "2", 256 * 1024).await;
        let old = SystemTime::now() - Duration::from_secs(2);
        for source in reader.files.values_mut() {
            source.last_active = old;
            source.created_at = old;
        }
        reader.begin_cycle(HashSet::from(["2".to_owned()])).unwrap();
        assert_eq!(reader.stats().files, 2);
        assert!(reader.files.values().all(|s| s.conversation == "2"));
    }
    #[tokio::test]
    async fn duplicate_conversation_in_distinct_profiles_is_not_cross_account_reused() {
        let temp = tempfile::tempdir().unwrap();
        let default = temp
            .path()
            .join("Default/.doubaowork/agent_mode/workspace/.sessions");
        let other = temp
            .path()
            .join("Profile 1/.doubaowork/agent_mode/workspace/.sessions");
        save(
            &default,
            CID,
            &[json!({"role":"assistant","content":"ACCOUNT_A"})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            user_data_root: Some(temp.path().to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert_eq!(
            drain(&mut reader, CID, 256 * 1024)
                .await
                .content
                .as_ref()
                .unwrap()
                .transcripts[ACTOR][0]["content"],
            "ACCOUNT_A"
        );
        save(
            &other,
            CID,
            &[json!({"role":"assistant","content":"ACCOUNT_B"})],
        )
        .await;
        let before = reader.stats();
        assert!(reader
            .graph(CID, &mut full_budget())
            .await
            .unwrap()
            .is_none());
        assert_eq!(reader.stats().body_read_bytes, before.body_read_bytes);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn replaced_source_symlink_is_rejected_and_missing_source_recovers() {
        let temp = tempfile::tempdir().unwrap();
        let file = save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"FINAL"})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        drain(&mut reader, CID, 256 * 1024).await;
        let saved = file.with_extension("saved");
        fs::rename(&file, &saved).await.unwrap();
        assert!(reader
            .graph(CID, &mut full_budget())
            .await
            .unwrap()
            .is_none());
        std::os::unix::fs::symlink(&saved, &file).unwrap();
        assert!(
            matches!(reader.graph(CID,&mut full_budget()).await,Err(DoubaoWorkError::Invalid(s)) if s.contains("Unsafe"))
        );
        fs::remove_file(&file).await.unwrap();
        fs::rename(&saved, &file).await.unwrap();
        let before = reader.stats().body_read_bytes;
        assert_eq!(drain(&mut reader, CID, 256 * 1024).await.main, ACTOR);
        assert_eq!(
            reader.stats().body_read_bytes - before,
            fs::metadata(&file).await.unwrap().len()
        );
        let restored = reader.stats().body_read_bytes;
        assert_eq!(drain(&mut reader, CID, 256 * 1024).await.main, ACTOR);
        assert_eq!(reader.stats().body_read_bytes, restored);
    }
    #[tokio::test]
    async fn oversized_snapshot_rejects_before_body_read() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp
            .path()
            .join("123")
            .join(CID)
            .join("00000000-0000-4000-8000-000000000001");
        fs::create_dir_all(&directory).await.unwrap();
        fs::write(directory.join("s_child.json"), vec![b' '; WINDOW + 1])
            .await
            .unwrap();
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            snapshot_root: Some(temp.path().to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert!(
            matches!(reader.executions(CID,&mut full_budget()).await,Err(DoubaoWorkError::Invalid(s)) if s.contains("limit"))
        );
        assert_eq!(reader.stats().body_read_bytes, 0);
    }
    #[tokio::test]
    async fn zero_time_budget_defers_before_native_body_read() {
        let temp = tempfile::tempdir().unwrap();
        save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"FINAL"})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let mut expired = DoubaoWorkBudget::new(
            DoubaoWorkBudgetOptions {
                milliseconds: 0,
                ..Default::default()
            },
            None,
        );
        assert!(
            matches!(reader.graph(CID,&mut expired).await,Err(DoubaoWorkError::Deferred(s)) if s=="cycle_budget")
        );
        assert_eq!(reader.stats().body_read_bytes, 0);
    }
    #[tokio::test]
    async fn snapshot_accounts_cannot_supply_conflicting_execution_identity() {
        let temp = tempfile::tempdir().unwrap();
        let key = "00000000-0000-4000-8000-000000000001";
        for (account, ended) in [("123", EPOCH + 1), ("456", EPOCH + 2)] {
            let directory = temp.path().join(account).join(CID).join(key);
            fs::create_dir_all(&directory).await.unwrap();
            fs::write(directory.join("s_child.json"),serde_json::to_vec(&json!({"execution":{
                "executionKey":key,"conversationId":CID,"queryMessageId":"00000000-0000-4000-8000-000000000002",
                "agentId":"s_child","agentType":"sub_agent","sandboxId":"box","startedAtMs":EPOCH,"endedAtMs":ended
            }})).unwrap()).await.unwrap();
        }
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            snapshot_root: Some(temp.path().to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert!(
            matches!(reader.executions(CID,&mut full_budget()).await,Err(DoubaoWorkError::Invalid(s)) if s=="Conflicting native execution identity")
        );
    }
    #[tokio::test]
    async fn account_and_actor_count_limits_reject_before_native_body_reads() {
        let temp = tempfile::tempdir().unwrap();
        for account in 0..9 {
            fs::create_dir_all(temp.path().join(account.to_string()))
                .await
                .unwrap();
        }
        let mut reader = DoubaoWorkNativeReader::new(NativeReaderOptions {
            snapshot_root: Some(temp.path().to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert!(
            matches!(reader.executions(CID,&mut full_budget()).await,Err(DoubaoWorkError::Invalid(s)) if s.contains("account limit"))
        );
        assert_eq!(reader.stats().body_read_bytes, 0);
        let sessions = temp.path().join("sessions");
        save(
            &sessions,
            CID,
            &[json!({"role":"assistant","content":"FINAL"})],
        )
        .await;
        for actor in 0..64 {
            fs::create_dir_all(sessions.join(CID).join("agents").join(format!("s_{actor}")))
                .await
                .unwrap();
        }
        let mut reader = DoubaoWorkNativeReader::new(options(&sessions));
        assert!(reader
            .graph(CID, &mut full_budget())
            .await
            .unwrap()
            .is_none());
        assert!(reader.reported.contains("agent_capacity"));
        assert_eq!(reader.stats().body_read_bytes, 0);
    }
    #[tokio::test]
    async fn assignment_window_keeps_original_first_and_last_literal_bodies() {
        let temp = tempfile::tempdir().unwrap();
        let file = save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"FINAL"})],
        )
        .await;
        let mut tasks = String::new();
        for n in 0..520 {
            let time = chrono::DateTime::from_timestamp_millis(EPOCH + n)
                .unwrap()
                .to_rfc3339();
            tasks.push_str(&format!("## [{time}] 需求\nliteral body {n}\n"));
        }
        fs::write(file.with_file_name("assignment.md"), &tasks)
            .await
            .unwrap();
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        let assignments = &graph.content.as_ref().unwrap().assignments[ACTOR];
        assert_eq!(assignments.len(), 514);
        assert_eq!(assignments.first().unwrap().text, "literal body 0");
        assert_eq!(assignments.last().unwrap().text, "literal body 519");
        assert!(reader.reported.contains("assignment_window"));
    }
    #[tokio::test]
    async fn lone_surrogate_native_text_is_repaired_without_dropping_the_record() {
        let temp = tempfile::tempdir().unwrap();
        let file = save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"placeholder"})],
        )
        .await;
        let raw=concat!(
            "{\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"one\",\"function\":{\"name\":\"Read\",\"arguments\":{\"file_path\":\"synthetic.txt\"}}}]}\n",
            "{\"role\":\"tool\",\"tool_call_id\":\"one\",\"content\":\"visible result\\ud800中文\"}\n",
            "{\"role\":\"assistant\",\"content\":\"FINAL\"}\n"
        );
        fs::write(&file, raw.as_bytes()).await.unwrap();
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        let content = graph.content.as_ref().unwrap();
        assert_eq!(
            content.calls["one"].result.as_deref(),
            Some("visible result\u{fffd}中文")
        );
        assert_eq!(content.transcripts[ACTOR].len(), 3);
        assert_eq!(
            content.transcripts[ACTOR][1]["content"],
            "visible result\u{fffd}中文"
        );
        assert_eq!(content.last_answers[ACTOR].text, "FINAL");
        let full = super::super::content::parse_native_content(
            &IndexMap::from([(ACTOR.to_owned(), raw.to_owned())]),
            &IndexMap::from([(ACTOR.to_owned(), assignment("CURRENT"))]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(content.calls["one"].result, full.calls["one"].result);
        assert_eq!(reader.stats().parsed_rows, 5); // 3 JSONL rows plus 2 assignment lines.
    }
    #[tokio::test]
    async fn user_demand_index_uses_utf16_units_without_changing_source_byte_budgets() {
        let temp = tempfile::tempdir().unwrap();
        let demand = "中".repeat(32 * 1024);
        assert!(demand.len() > 64 * 1024);
        assert_eq!(demand.encode_utf16().count(), 32 * 1024);
        let file = save(
            temp.path(),
            CID,
            &[
                json!({"role":"user","content":demand}),
                json!({"role":"assistant","content":"FINAL"}),
            ],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        let content = graph.content.as_ref().unwrap();
        assert_eq!(
            content.find_user_rows(ACTOR, &native_demand_fingerprint(&demand)),
            Some([0].as_slice())
        );
        assert_eq!(
            reader.stats().body_read_bytes,
            fs::metadata(&file).await.unwrap().len()
                + fs::metadata(file.with_file_name("assignment.md"))
                    .await
                    .unwrap()
                    .len()
        );
        assert!(content
            .find_user_rows(ACTOR, &native_demand_fingerprint("unrelated"))
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn temporary_stat_failure_preserves_cached_content_and_recovery_needs_no_body_read() {
        let temp = tempfile::tempdir().unwrap();
        save(
            temp.path(),
            CID,
            &[json!({"role":"assistant","content":"FINAL"})],
        )
        .await;
        let mut reader = DoubaoWorkNativeReader::new(options(temp.path()));
        let graph = drain(&mut reader, CID, 256 * 1024).await;
        let before = reader.stats();
        reader.fail_next_stat(std::io::ErrorKind::PermissionDenied);
        let error = reader.graph(CID, &mut full_budget()).await.unwrap_err();
        assert_eq!(
            error.as_io().unwrap().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let restored = drain(&mut reader, CID, 256 * 1024).await;
        assert!(Arc::ptr_eq(&graph, &restored));
        assert_eq!(reader.stats().body_read_bytes, before.body_read_bytes);
        assert_eq!(reader.stats().parsed_rows, before.parsed_rows);
    }
}
