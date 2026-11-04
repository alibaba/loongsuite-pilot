//! Collector-owned Qoder native transcript source. No subprocess collector and
//! no conversation bodies in checkpoints: only bounded semantic ranges survive.
use super::prompt_ownership::{
    QoderOwnershipCursor, QoderOwnershipSearch, QoderPromptOwnershipResolver,
};
use super::transcript_scanner::{
    self as scanner, FileVersion, PendingLine, ScanBudget, ScanMetrics, ScanOptions,
};
use crate::hook_process::{
    build_collected_transcript_turn, qoder_has_cn_terminal, qoder_is_control_user_row,
    qoder_is_real_user_prompt, qoder_legacy_retry_lock_path, resolve_collected_qoder_user_id,
    with_qoder_wakeup_lock, CollectedTranscriptTurnContext,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashSet;
use std::collections::VecDeque;
use std::fs::ReadDir;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
#[path = "transcript_process_birth.rs"]
mod process_birth;
#[cfg(test)]
type OwnerPidProbe = Arc<dyn Fn(u32) -> Result<(), i32> + Send + Sync>;
const MAX_SOURCES: usize = 64;
const MAX_CONTEXTS: usize = 256;
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_NOTICES: usize = 16 * 1024;
const MAX_TURN_RECORDS: usize = 8192;
const MAX_TAILS: usize = 256;
#[derive(Clone, Debug, Default)]
pub struct TranscriptMetrics {
    pub reads: Vec<scanner::ReadObservation>,
    pub bytes_read: u64,
    pub records_parsed: u64,
    pub source_files_opened: u64,
    pub peak_cached_bytes: usize,
}
#[derive(Clone, Debug)]
pub struct TranscriptBatch {
    pub records: Vec<Value>,
    pub state: Value,
    pub changed: bool,
    pub metrics: TranscriptMetrics,
}
#[derive(Clone)]
struct ActiveRows {
    start: u64,
    end: u64,
    rows: Vec<Value>,
    bytes: usize,
}
struct LineScan {
    end: u64,
    options: ScanOptions,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct DirectoryVersion {
    modified: u128,
    changed: (i64, i64),
    inventory: Option<Vec<String>>,
    notice_versions: Option<Vec<FileVersion>>,
}
fn notice_attribute_version(path: &Path) -> std::io::Result<FileVersion> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        // Metadata notices need only attributes here. The bounded JSON snapshot
        // below remains the authority for receipt contents; no body is read.
        std::fs::OpenOptions::new().access_mode(0x80).open(path)?
    };
    #[cfg(not(windows))]
    let file = scanner::open_regular(path)?;
    scanner::version(&file)
}
fn directory_version(path: &Path, inspect_inventory: bool) -> std::io::Result<DirectoryVersion> {
    #[cfg(unix)]
    let (metadata, changed) = {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path)?;
        let changed = (metadata.ctime(), metadata.ctime_nsec());
        (metadata, changed)
    };
    #[cfg(windows)]
    let (metadata, changed) = {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };
        // Directory handle, FILE_READ_ATTRIBUTES only; no transcript read.
        let directory = std::fs::OpenOptions::new()
            .access_mode(0x80)
            .custom_flags(0x0200_0000)
            .open(path)?;
        let metadata = directory.metadata()?;
        let mut info = FILE_BASIC_INFO::default();
        // SAFETY: live owned directory handle and exact API output layout.
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                FileBasicInfo,
                (&mut info as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        // Creation time is not ctime on Windows. Native ChangeTime records the
        // directory generation when last-write timestamps happen to be equal.
        (metadata, (info.ChangeTime, 0))
    };
    // Directory clocks are hints on every filesystem; coarse clocks or restored
    // mtimes can identify different generations equally. Publication coalesces the
    // same watermark/context into one filename, so both its bounded inventory
    // and notice attribute generations must participate even before any ACK.
    let mut notice_versions = None;
    let inventory = if inspect_inventory {
        let mut entries = Vec::new();
        for (index, entry) in std::fs::read_dir(path)?.enumerate() {
            if index >= MAX_CONTEXTS {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "too-many-contexts",
                ));
            }
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry.file_name().to_string_lossy().ends_with(".json")
            {
                entries.push((
                    entry.file_name().to_string_lossy().into_owned(),
                    notice_attribute_version(&entry.path())?,
                ));
            }
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        let (names, versions): (Vec<_>, Vec<_>) = entries.into_iter().unzip();
        notice_versions = Some(versions);
        Some(names)
    } else {
        None
    };
    Ok(DirectoryVersion {
        inventory,
        notice_versions,
        modified: metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        changed,
    })
}
struct Metadata {
    version: DirectoryVersion,
    source: Value,
    contexts: Vec<Value>,
    bytes: usize,
}
struct Collector {
    data_dir: PathBuf,
    agent_id: String,
    root: PathBuf,
    discovery: Option<ReadDir>,
    pending: VecDeque<PathBuf>,
    cache: IndexMap<String, ActiveRows>,
    cache_size: usize,
    metadata: IndexMap<PathBuf, Metadata>,
    metadata_bytes: usize,
    tails: IndexMap<PathBuf, PendingLine>,
    warned: IndexMap<String, i64>,
    cleanup_rotation: usize,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    cycle_peak: usize,
    owner_budget: usize,
    prompt_budget: usize,
    owner_chosen: Option<String>,
    prompt_chosen: Option<String>,
    owner_pending: IndexSet<String>,
    owner_inspections: IndexMap<String, u64>,
    prompt_inspections: IndexMap<String, u64>,
    inspection_sequence: u64,
    legacy_owners: IndexMap<PathBuf, (FileVersion, bool, i64)>,
    #[cfg(test)]
    owner_pid_probe: Option<OwnerPidProbe>,
    #[cfg(test)]
    directory_inventory: bool,
    resolver: Arc<dyn QoderPromptOwnershipResolver>,
    last: Option<(Value, bool, Result<TranscriptBatch, String>)>,
    scan_bytes: usize,
    max_turn_bytes: usize,
    cache_limit: usize,
    stable_ms: i64,
    settle_ms: i64,
}
pub struct QoderTranscriptSource {
    inner: tokio::sync::Mutex<Collector>,
    stopped: Arc<AtomicBool>,
    completed: AtomicU64,
}
fn digest(v: &Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(v).expect("JSON Value serializes"),
    ))
}
fn number(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn optional_number(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn mtime(v: &FileVersion) -> f64 {
    v.modified as f64 / 1_000_000.0
}
#[cfg(test)]
type AfterMetadataRead = Box<dyn FnMut(&Path)>;
#[cfg(test)]
thread_local! {static METADATA_READ_FAULT:std::cell::RefCell<Option<AfterMetadataRead>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
struct MetadataReadFaultGuard;
#[cfg(test)]
impl Drop for MetadataReadFaultGuard {
    fn drop(&mut self) {
        METADATA_READ_FAULT.with(|f| *f.borrow_mut() = None)
    }
}
#[cfg(test)]
fn inject_metadata_read_fault(f: impl FnMut(&Path) + 'static) -> MetadataReadFaultGuard {
    METADATA_READ_FAULT.with(|slot| {
        assert!(slot.borrow().is_none());
        *slot.borrow_mut() = Some(Box::new(f));
    });
    MetadataReadFaultGuard
}
fn snapshot(path: &Path, limit: usize) -> anyhow::Result<(Value, FileVersion)> {
    let mut f = scanner::open_regular(path)?;
    let version = scanner::version(&f)?;
    if version.size > limit as u64 {
        anyhow::bail!("Qoder metadata exceeds limit")
    };
    let mut bytes = Vec::new();
    f.by_ref().take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        anyhow::bail!("Qoder metadata grew past limit")
    };
    let value = serde_json::from_slice(&bytes)?;
    #[cfg(test)]
    METADATA_READ_FAULT.with(|fault| {
        if let Some(hook) = fault.borrow_mut().as_mut() {
            hook(path)
        }
    });
    Ok((value, version))
}
fn valid_source(v: &Value, agent: &str, key: &str) -> bool {
    v["schema"] == 1
        && text(v, "key") == key
        && text(v, "agentId") == agent
        && v.get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|s| s.encode_utf16().count() <= 512)
        && Path::new(text(v, "transcriptPath")).is_absolute()
        && optional_number(v, "observedSize").is_some()
        && digest(&json!([v["sessionId"], v["transcriptPath"]])) == key
}
fn notice_name(s: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^\d+-(?:SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd)-[a-f0-9]{24}\.json$").unwrap()
    });
    RE.is_match(s)
}
fn notice_version(v: &Value, s: &FileVersion) -> String {
    if let Some(id) = v
        .get("observationId")
        .and_then(Value::as_str)
        .filter(|x| x.encode_utf16().count() <= 128)
    {
        format!("id:{id}")
    } else {
        format!(
            "stat:{}",
            digest(&json!([s.ino, s.size, mtime(s), s.changed]))
        )
    }
}
fn event(v: &Value) -> &str {
    if text(v, "type") == "progress" {
        v.pointer("/data/hookEvent")
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        ""
    }
}
impl QoderTranscriptSource {
    pub fn new(
        data_dir: PathBuf,
        agent_id: String,
        resolver: Arc<dyn QoderPromptOwnershipResolver>,
    ) -> Self {
        let root = data_dir
            .join("state/qoder-transcripts")
            .join(&agent_id)
            .join("sources");
        Self {
            inner: tokio::sync::Mutex::new(Collector {
                data_dir,
                agent_id,
                root,
                discovery: None,
                pending: VecDeque::new(),
                cache: IndexMap::new(),
                cache_size: 0,
                metadata: IndexMap::new(),
                metadata_bytes: 0,
                tails: IndexMap::new(),
                warned: IndexMap::new(),
                cleanup_rotation: 0,
                clock: Arc::new(now),
                cycle_peak: 0,
                owner_budget: 1,
                prompt_budget: 1,
                owner_chosen: None,
                prompt_chosen: None,
                owner_pending: IndexSet::new(),
                owner_inspections: IndexMap::new(),
                prompt_inspections: IndexMap::new(),
                inspection_sequence: 0,
                legacy_owners: IndexMap::new(),
                #[cfg(test)]
                owner_pid_probe: None,
                #[cfg(test)]
                directory_inventory: true,
                resolver,
                last: None,
                scan_bytes: scanner::SCAN_BYTES,
                max_turn_bytes: scanner::MAX_TURN_BYTES,
                cache_limit: scanner::CACHE_BYTES,
                stable_ms: 250,
                settle_ms: 5000,
            }),
            stopped: Arc::new(AtomicBool::new(false)),
            completed: AtomicU64::new(0),
        }
    }
    pub fn start(&self) {
        self.stopped.store(false, Ordering::SeqCst);
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut c) = self.inner.try_lock() {
            c.clear();
        }
    }
    pub async fn read(
        &self,
        state: Option<&Value>,
        persisted: bool,
    ) -> anyhow::Result<TranscriptBatch> {
        let state = state
            .filter(|s| s.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let observed = self.completed.load(Ordering::SeqCst);
        let mut c = self.inner.lock().await;
        if observed != self.completed.load(Ordering::SeqCst) {
            if let Some((prior, was_persisted, result)) = &c.last {
                if *prior == state && *was_persisted == persisted {
                    return result.clone().map_err(anyhow::Error::msg);
                }
            }
        }
        tokio::task::yield_now().await;
        let result = if self.stopped.load(Ordering::SeqCst) {
            c.clear();
            Ok(TranscriptBatch {
                records: Vec::new(),
                state: state.clone(),
                changed: false,
                metrics: TranscriptMetrics::default(),
            })
        } else if !persisted && state.as_object().is_some_and(|m| !m.is_empty()) {
            Ok(TranscriptBatch {
                records: Vec::new(),
                state: state.clone(),
                changed: false,
                metrics: TranscriptMetrics::default(),
            })
        } else {
            if persisted {
                c.acknowledge(&state, &self.stopped);
            }
            c.collect_once(&state, &self.stopped)
                .await
                .map_err(|e| e.to_string())
        };
        let result = if self.stopped.load(Ordering::SeqCst) {
            c.clear();
            Ok(TranscriptBatch {
                records: Vec::new(),
                state: state.clone(),
                changed: false,
                metrics: TranscriptMetrics::default(),
            })
        } else {
            result
        };
        c.last = Some((state, persisted, result.clone()));
        self.completed.fetch_add(1, Ordering::SeqCst);
        result.map_err(anyhow::Error::msg)
    }
}
impl Collector {
    fn time(&self) -> i64 {
        (self.clock)()
    }
    fn clear(&mut self) {
        self.cache.clear();
        self.cache_size = 0;
        self.metadata.clear();
        self.metadata_bytes = 0;
        self.tails.clear();
        self.owner_pending.clear();
        self.owner_inspections.clear();
        self.prompt_inspections.clear();
        self.legacy_owners.clear();
        self.discovery = None;
        self.pending.clear();
        self.last = None;
    }
    fn report(&mut self, key: &str, reason: &str) {
        let id = format!("{key}:{reason}");
        if self
            .warned
            .get(&id)
            .is_some_and(|t| self.time() - t < 60000)
        {
            return;
        }
        if self.warned.len() >= 1024 {
            self.warned.shift_remove_index(0);
        }
        self.warned.insert(id, self.time());
        let fields = json!({"source":key,"reason":reason});
        crate::utils::create_logger("QoderTranscriptSource")
            .warn("Qoder transcript collection deferred", fields.as_object());
    }
    fn sources(&mut self) -> anyhow::Result<()> {
        if !self.pending.is_empty() {
            return Ok(());
        }
        if self.discovery.is_none() {
            match std::fs::read_dir(&self.root) {
                Ok(d) => self.discovery = Some(d),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.into()),
            }
        }
        for _ in 0..MAX_SOURCES {
            let Some(item) = self.discovery.as_mut().and_then(Iterator::next) else {
                self.discovery = None;
                break;
            };
            let item = item?;
            let n = item.file_name();
            let Some(name) = n.to_str() else { continue };
            if item.file_type()?.is_dir()
                && name.len() == 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                self.pending.push_back(item.path());
            }
        }
        Ok(())
    }
    fn metadata_for(&mut self, dir: &Path) -> anyhow::Result<(Value, Vec<Value>)> {
        let events = dir.join("events");
        #[cfg(not(test))]
        let inspect_inventory = true;
        #[cfg(test)]
        let inspect_inventory = self.directory_inventory;
        let version = directory_version(&events, inspect_inventory)?;
        // Names and notice attributes disambiguate equal mtime/ctime hints within
        // the existing bounded metadata budget; no transcript body is read here.
        if let Some(m) = self.metadata.get(dir) {
            if m.version == version {
                return Ok((m.source.clone(), m.contexts.clone()));
            }
        }
        let source = if let Some(m) = self.metadata.get(dir) {
            m.source.clone()
        } else {
            snapshot(&dir.join("source.json"), MAX_NOTICES)?.0
        };
        let mut contexts = vec![source.clone()];
        for entry in std::fs::read_dir(&events)?.take(MAX_CONTEXTS) {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || !entry.file_name().to_string_lossy().ends_with(".json")
            {
                continue;
            }
            let (mut v, s) = snapshot(&entry.path(), MAX_NOTICES)?;
            if !valid_source(&v, &self.agent_id, text(&source, "key")) {
                anyhow::bail!("invalid-context")
            };
            v["receipt"] =
                json!({"name":entry.file_name().to_string_lossy(),"version":notice_version(&v,&s)});
            contexts.push(v);
        }
        contexts.sort_by(|a, b| {
            number(a, "observedSize")
                .cmp(&number(b, "observedSize"))
                .then_with(|| number(a, "observedAt").cmp(&number(b, "observedAt")))
        });
        let inventory_bytes = version.inventory.as_ref().map_or(0, |names| {
            names
                .iter()
                .map(|name| name.len() + std::mem::size_of::<String>())
                .sum::<usize>()
                + std::mem::size_of::<Vec<String>>()
        }) + version.notice_versions.as_ref().map_or(0, |versions| {
            versions.len() * std::mem::size_of::<FileVersion>()
                + std::mem::size_of::<Vec<FileVersion>>()
        });
        let bytes = serde_json::to_vec(&json!([source, contexts]))?.len() + inventory_bytes;
        if let Some(prior) = self.metadata.shift_remove(dir) {
            self.metadata_bytes -= prior.bytes;
        }
        while self.metadata_bytes + bytes > MAX_METADATA_BYTES && !self.metadata.is_empty() {
            if let Some((_, old)) = self.metadata.shift_remove_index(0) {
                self.metadata_bytes -= old.bytes;
            }
        }
        if bytes <= MAX_METADATA_BYTES {
            self.metadata.insert(
                dir.to_owned(),
                Metadata {
                    version,
                    source: source.clone(),
                    contexts: contexts.clone(),
                    bytes,
                },
            );
            self.metadata_bytes += bytes;
        }
        Ok((source, contexts))
    }
    fn drop_metadata(&mut self, directory: &Path) {
        if let Some(prior) = self.metadata.shift_remove(directory) {
            self.metadata_bytes -= prior.bytes;
        }
    }
    fn acknowledge(&mut self, state: &Value, stopped: &AtomicBool) {
        let Some(state) = state.as_object() else {
            return;
        };
        let keys = state.keys().collect::<Vec<_>>();
        if keys.is_empty() {
            return;
        }
        let start = self.cleanup_rotation % keys.len();
        self.cleanup_rotation = (start + keys.len().min(MAX_SOURCES)) % keys.len();
        for key in keys
            .iter()
            .cycle()
            .skip(start)
            .take(keys.len().min(MAX_SOURCES))
        {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            if key.len() != 64
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                continue;
            }
            let Some(receipts) = state[*key].get("receipts").and_then(Value::as_array) else {
                continue;
            };
            let dir = self.root.join(*key);
            for receipt in receipts.iter().take(MAX_CONTEXTS) {
                let name = text(receipt, "name");
                if !notice_name(name) {
                    continue;
                }
                let file = dir.join("events").join(name);
                let Ok((v, version)) = snapshot(&file, MAX_NOTICES) else {
                    continue;
                };
                if notice_version(&v, &version) != text(receipt, "version") {
                    // A same-path publication may leave directory clock/name
                    // hints unchanged. Never keep its former cached context.
                    self.drop_metadata(&dir);
                    continue;
                }
                let revalidated = with_qoder_wakeup_lock(&dir, 0, || {
                    // Revalidate the exact receipt and complete metadata payload
                    // under the publication gate. An unchanged observation may
                    // acquire different filesystem timestamps without new data.
                    let (current, current_version) = snapshot(&file, MAX_NOTICES)?;
                    if current == v
                        && notice_version(&current, &current_version) == text(receipt, "version")
                    {
                        std::fs::remove_file(&file)?;
                    }
                    Ok(())
                });
                if matches!(revalidated, Ok(Some(()))) {
                    // The gate either removed the exact old receipt or found
                    // a changed payload. Refresh metadata in either case;
                    // transcript rows, checkpoints and ACK predicates stay put.
                    self.drop_metadata(&dir);
                }
            }
        }
    }
    async fn collect_once(
        &mut self,
        state: &Value,
        stopped: &AtomicBool,
    ) -> anyhow::Result<TranscriptBatch> {
        let mut next = state.clone();
        let mut records = Vec::new();
        let mut budget = ScanBudget {
            remaining: self.scan_bytes as i64,
            metrics: ScanMetrics::default(),
        };
        self.sources()?;
        self.owner_budget = 1;
        self.prompt_budget = 1;
        self.cycle_peak = self.cache_size;
        self.prompt_chosen = self
            .pending
            .iter()
            .filter_map(|p| p.file_name()?.to_str())
            .filter(|key| next[*key].get("initialOwnership").is_some())
            .min_by_key(|key| self.prompt_inspections.get(*key).copied().unwrap_or(0))
            .map(str::to_owned);
        self.owner_chosen = self
            .pending
            .iter()
            .filter_map(|p| p.file_name()?.to_str())
            .filter(|key| self.owner_pending.contains(*key))
            .min_by_key(|key| self.owner_inspections.get(*key).copied().unwrap_or(0))
            .map(str::to_owned);
        if let Some(key) = self.prompt_chosen.clone() {
            self.mark_inspection(&key, true)
        }
        if let Some(key) = self.owner_chosen.clone() {
            self.mark_inspection(&key, false)
        }
        while budget.remaining > 0 && records.len() < 4096 && !stopped.load(Ordering::SeqCst) {
            let Some(directory) = self.pending.pop_front() else {
                break;
            };
            let key = directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let result: anyhow::Result<()> = async {
                let (source, observed) = self.metadata_for(&directory)?;
                if !valid_source(&source, &self.agent_id, &key) {
                    anyhow::bail!("invalid-source")
                };
                let file = PathBuf::from(text(&source, "transcriptPath"));
                let stat = scanner::version(&scanner::open_regular(&file)?)?;
                if self.legacy_worker_alive(&file, &key)? {
                    return Ok(());
                }
                if let Some(supplied) = source
                    .get("suppliedPath")
                    .and_then(Value::as_str)
                    .filter(|v| *v != text(&source, "transcriptPath"))
                {
                    if self.legacy_worker_alive(Path::new(supplied), &key)? {
                        return Ok(());
                    }
                }
                let contexts = observed
                    .into_iter()
                    .filter(|c| optional_number(c, "inode").is_none_or(|i| i == stat.ino))
                    .collect::<Vec<_>>();
                if contexts.is_empty() {
                    return Ok(());
                }
                let old = next.get(&key).cloned();
                let mut cp = old.clone().unwrap_or(Value::Null);
                let saved = cp.get("receipts").and_then(Value::as_array);
                let pending_stop = contexts.iter().any(|context| {
                    text(context, "event") == "Stop"
                        && context.get("receipt").is_some_and(|receipt| {
                            !saved.is_some_and(|receipts| receipts.contains(receipt))
                        })
                });
                // A new Stop can precede a same-size rewrite whose filesystem
                // timestamps collide. Until completed, keep retrying the bounded
                // witness; checking it once would miss a later transcript write.
                let check_fingerprint =
                    old.as_ref().is_some_and(|o| o.get("fingerprint").is_some())
                        && (cp.get("fileVersion") != Some(&serde_json::to_value(&stat)?)
                            || pending_stop);
                let rewritten = if check_fingerprint {
                    let witness_bytes = number(&cp, "offset").min(128) * 2;
                    if budget.remaining < witness_bytes as i64 {
                        return Ok(());
                    }
                    !self.matches_fingerprint(&file, &cp, &mut budget)?
                } else {
                    false
                };
                if old.is_none()
                    || number(&cp, "inode") != stat.ino
                    || stat.size < number(&cp, "offset")
                    || rewritten
                {
                    cp = self.initialize(&source, &contexts, &stat, old.is_none())?;
                    if old.is_some() {
                        cp["recoveryReason"] = json!("truncated")
                    };
                    self.drop_cache(&key);
                    self.tails.shift_remove(&file);
                }
                if cp
                    .get("unresolvedPrompt")
                    .is_some_and(|v| v.get("reason").is_none())
                    && cp.get("initialOwnership").is_none()
                    && cp.get("backfill").is_none()
                    && number(&cp, "committedOffset") == 0
                    && cp["activeStart"].is_null()
                    && contexts.iter().any(|c| {
                        text(c, "event") == "UserPromptSubmit"
                            && !text(c, "requestSetId").is_empty()
                    })
                {
                    cp["bootstrapEnd"] = cp["unresolvedPrompt"]["through"].clone();
                }
                let batch = self
                    .scan_source(&source, &contexts, &mut cp, &stat, &mut budget, stopped)
                    .await?;
                if stopped.load(Ordering::SeqCst) {
                    anyhow::bail!("stopped")
                }
                if old.as_ref().is_none_or(|o| o["offset"] != cp["offset"])
                    || rewritten
                    || cp.get("fingerprint").is_none()
                {
                    cp["fingerprint"] =
                        json!(self.fingerprint(&file, number(&cp, "offset"), &mut budget)?);
                }
                let after = scanner::version(&scanner::open_regular(&file)?)?;
                if after.ino != stat.ino
                    || after.dev != stat.dev
                    || after.size < number(&cp, "offset")
                    || (after.size == stat.size && after != stat)
                {
                    anyhow::bail!("source-changed-during-read")
                }
                cp["fileVersion"] = serde_json::to_value(&stat)?;
                let advanced = old.as_ref().is_none_or(|o| {
                    o["committedOffset"] != cp["committedOffset"]
                        || o["inode"] != cp["inode"]
                        || ((o.get("initialOwnership").is_some() || o.get("backfill").is_some())
                            && cp.get("initialOwnership").is_none()
                            && cp.get("backfill").is_none())
                }) || rewritten;
                let saved = cp
                    .get("receipts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let committed = number(&cp, "committedOffset");
                cp["receipts"] = Value::Array(
                    contexts
                        .iter()
                        .filter(|c| {
                            let Some(r) = c.get("receipt") else {
                                return false;
                            };
                            saved.contains(r)
                                || (advanced
                                    && !cp.get("unresolvedPrompt").is_some_and(|u| {
                                        number(c, "observedSize") <= number(u, "through")
                                    })
                                    && number(c, "observedSize") <= committed
                                    && (!["UserPromptSubmit", "SessionStart"]
                                        .contains(&text(c, "event"))
                                        || number(c, "observedSize") < committed))
                        })
                        .map(|c| c["receipt"].clone())
                        .collect(),
                );
                next[&key] = cp;
                records.extend(batch);
                Ok(())
            }
            .await;
            if let Err(error) = result {
                self.drop_cache(&key);
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let reason = if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                    e.kind() == std::io::ErrorKind::InvalidInput
                        && e.to_string() == "JSONL source is not a regular file"
                }) {
                    "not-regular-file".to_owned()
                } else {
                    error.to_string()
                };
                self.report(&key, &reason);
            }
        }
        let changed = next != *state;
        Ok(TranscriptBatch {
            records,
            state: next,
            changed,
            metrics: TranscriptMetrics {
                bytes_read: budget.metrics.bytes_read,
                records_parsed: budget.metrics.records_parsed,
                source_files_opened: budget.metrics.source_files_opened,
                peak_cached_bytes: self.cycle_peak,
                reads: budget.metrics.reads,
            },
        })
    }
    fn drop_cache(&mut self, key: &str) {
        if let Some(old) = self.cache.shift_remove(key) {
            self.cache_size -= old.bytes;
        }
    }
    fn remember(&mut self, key: &str, value: ActiveRows) -> anyhow::Result<()> {
        self.drop_cache(key);
        if value.bytes == 0 {
            return Ok(());
        }
        if value.bytes > self.max_turn_bytes {
            anyhow::bail!("turn-byte-limit")
        };
        while self.cache_size + value.bytes > self.cache_limit && !self.cache.is_empty() {
            if let Some((_, old)) = self.cache.shift_remove_index(0) {
                self.cache_size -= old.bytes;
            }
        }
        self.cache_size += value.bytes;
        self.cycle_peak = self.cycle_peak.max(self.cache_size);
        self.cache.insert(key.to_owned(), value);
        Ok(())
    }
    fn fingerprint(
        &self,
        file: &Path,
        offset: u64,
        budget: &mut ScanBudget,
    ) -> anyhow::Result<String> {
        let mut f = scanner::open_regular(file)?;
        budget.metrics.source_files_opened += 1;
        let mut buffers = Vec::new();
        for at in [0, offset.saturating_sub(128)] {
            let mut body = vec![0; 128.min(offset as usize)];
            f.seek(SeekFrom::Start(at))?;
            let started = std::time::Instant::now();
            let n = f.read(&mut body)?;
            budget.metrics.reads.push(scanner::ReadObservation {
                bytes: n as u64,
                requested: body.len() as u64,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
            });
            body.truncate(n);
            budget.metrics.bytes_read += n as u64;
            budget.remaining -= n as i64;
            buffers.push(STANDARD.encode(body));
        }
        Ok(digest(&json!(buffers)))
    }
    fn matches_fingerprint(
        &self,
        file: &Path,
        cp: &Value,
        budget: &mut ScanBudget,
    ) -> anyhow::Result<bool> {
        Ok(text(cp, "fingerprint") == self.fingerprint(file, number(cp, "offset"), budget)?)
    }
    fn initialize(
        &self,
        source: &Value,
        contexts: &[Value],
        stat: &FileVersion,
        migrate: bool,
    ) -> anyhow::Result<Value> {
        let anchor = contexts
            .iter()
            .map(|c| number(c, "observedSize"))
            .min()
            .unwrap_or(stat.size)
            .min(stat.size);
        let mut cp = json!({"inode":stat.ino,"device":stat.dev,"offset":0,"committedOffset":0,"activeStart":null,"hasUser":false,"recoveryReason":"missing-cursor","terminal":false,"stableSize":null,"stableMtime":null,"stableAt":null,"anchorSize":anchor,"bootstrapEnd":null,"skipToPrompt":contexts.first().is_some_and(|v|["UserPromptSubmit","SessionStart"].contains(&text(v,"event")))});
        if migrate {
            let session = hex::encode(Sha256::digest(text(source, "sessionId").as_bytes()));
            let paths = [
                self.data_dir
                    .join("state/hooks")
                    .join(format!("{}-line-records/{session}.json", self.agent_id)),
                self.data_dir
                    .join("state/hooks")
                    .join(format!("{}-line-records.json", self.agent_id)),
                self.data_dir
                    .join("hooks")
                    .join(format!(".line_records.{}.json", self.agent_id)),
            ];
            for path in paths {
                let Ok((v, _)) = snapshot(&path, 1024 * 1024) else {
                    continue;
                };
                let r = if v.get("transcript_path").is_some() {
                    &v
                } else {
                    v.get(text(source, "transcriptPath"))
                        .or_else(|| v.get(text(source, "suppliedPath")))
                        .unwrap_or(&Value::Null)
                };
                if text(r, "session_id") == text(source, "sessionId")
                    && (r.get("transcript_path").is_none()
                        || [text(source, "transcriptPath"), text(source, "suppliedPath")]
                            .contains(&text(r, "transcript_path")))
                {
                    if let Some(target) = optional_number(r, "last_line_count") {
                        cp["migration"] = json!({"target":target,"seen":0});
                        cp["recoveryReason"] = json!("incremental");
                        return Ok(cp);
                    }
                }
            }
        }
        if let Some(target) = contexts
            .iter()
            .filter_map(|c| optional_number(c, "legacyTriggerLine"))
            .min()
        {
            cp["findAnchorLine"] = json!({"target":target,"seen":0})
        } else {
            cp["bootstrapEnd"] = json!(anchor)
        }
        Ok(cp)
    }
    fn find_bootstrap(
        &mut self,
        source: &Value,
        contexts: &[Value],
        cp: &mut Value,
        budget: &mut ScanBudget,
    ) -> anyhow::Result<bool> {
        let end = number(cp, "bootstrapEnd");
        if end == 0 {
            cp["offset"] = json!(0);
            cp["bootstrapEnd"] = Value::Null;
            return Ok(true);
        }
        let window = optional_number(cp, "bootstrapWindow")
            .unwrap_or((1024 * 1024).min(self.scan_bytes) as u64)
            .min(self.max_turn_bytes as u64);
        let start = end.saturating_sub(window);
        let mut f = scanner::open_regular(Path::new(text(source, "transcriptPath")))?;
        budget.metrics.source_files_opened += 1;
        let mut bytes = vec![0; (end - start) as usize];
        f.seek(SeekFrom::Start(start))?;
        let started = std::time::Instant::now();
        let read = f.read(&mut bytes)?;
        budget.metrics.reads.push(scanner::ReadObservation {
            bytes: read as u64,
            requested: bytes.len() as u64,
            duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        });
        bytes.truncate(read);
        budget.metrics.bytes_read += read as u64;
        budget.remaining -= read as i64;
        let complete_end = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |i| start + i as u64 + 1);
        let mut right = bytes.iter().rposition(|b| *b == b'\n');
        while let Some(r) = right {
            let left = bytes[..r]
                .iter()
                .rposition(|b| *b == b'\n')
                .map_or(0, |i| i + 1);
            if left == 0 && start > 0 {
                break;
            }
            if let Ok(row) = serde_json::from_slice::<Value>(&bytes[left..r]) {
                if flag(cp, "skipToPrompt")
                    && (text(&row, "type") == "last-prompt"
                        || ["Stop", "SessionEnd"].contains(&event(&row)))
                {
                    if let Some(prompt) = contexts.iter().find(|c| {
                        text(c, "event") == "UserPromptSubmit"
                            && !text(c, "requestSetId").is_empty()
                    }) {
                        cp["initialOwnership"] = json!({"requestSetId":prompt["requestSetId"],"anchorEnd":complete_end,"offset":0,"seen":0,"candidate":null});
                    }
                    cp["unresolvedPrompt"] = json!({"through":complete_end});
                    cp["offset"] = json!(complete_end);
                    cp["bootstrapEnd"] = Value::Null;
                    cp["bootstrapWindow"] = Value::Null;
                    self.report(text(source, "key"), "initial-prompt-owner-unavailable");
                    return Ok(true);
                }
                if qoder_is_real_user_prompt(&row) {
                    cp["offset"] = json!(start + left as u64);
                    cp["committedOffset"] = cp["offset"].clone();
                    cp["bootstrapEnd"] = Value::Null;
                    cp["bootstrapWindow"] = Value::Null;
                    return Ok(true);
                }
            }
            if left == 0 {
                break;
            }
            right = Some(left - 1);
        }
        if start == 0 {
            cp["offset"] = json!(0);
            cp["bootstrapEnd"] = Value::Null;
            return Ok(true);
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let next_end = newline.map_or(end, |i| start + i as u64 + 1);
        if next_end == end {
            if window >= self.max_turn_bytes as u64 {
                cp["unresolvedPrompt"] =
                    json!({"through":end,"reason":"bootstrap-record-byte-limit"});
                cp["bootstrapEnd"] = Value::Null;
                cp["bootstrapWindow"] = Value::Null;
                if newline.is_some() {
                    cp["offset"] = json!(complete_end);
                    self.quarantine(
                        source,
                        cp,
                        start,
                        complete_end,
                        "bootstrap-record-byte-limit",
                    );
                } else {
                    cp["offset"] = json!(start);
                    let f = scanner::open_regular(Path::new(text(source, "transcriptPath")))?;
                    let pending = PendingLine {
                        start,
                        position: end,
                        version: scanner::version(&f)?,
                        witness: bytes[bytes.len().saturating_sub(64)..].to_vec(),
                        oversized: true,
                        final_tried: true,
                    };
                    cp["pendingLine"] = serde_json::to_value(pending)?;
                    self.report(text(source, "key"), "bootstrap-record-byte-limit");
                }
                return Ok(true);
            }
            cp["bootstrapWindow"] = json!((window * 2).min(self.max_turn_bytes as u64));
        } else {
            cp["bootstrapEnd"] = json!(next_end);
            cp["bootstrapWindow"] = Value::Null;
        }
        Ok(false)
    }
    fn quarantine(&mut self, source: &Value, cp: &mut Value, start: u64, end: u64, reason: &str) {
        let r = json!({"start":start,"end":end,"reason":reason});
        let mut ranges = cp
            .get("quarantines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !ranges.contains(&r) {
            ranges.push(r);
            if ranges.len() > 32 {
                ranges.remove(0);
            }
        }
        cp["quarantines"] = json!(ranges);
        if flag(cp, "hasUser") {
            cp["incomplete"] = json!(true)
        }
        self.report(text(source, "key"), reason);
    }
    fn clear_active(cp: &mut Value) {
        for key in [
            "activeStart",
            "contextFloor",
            "terminalAt",
            "stableSize",
            "stableMtime",
            "stableAt",
        ] {
            cp[key] = Value::Null
        }
        cp["hasUser"] = json!(false);
        cp["terminal"] = json!(false);
        for key in [
            "incomplete",
            "retainedEnd",
            "turnTruncated",
            "activeRequestSetId",
        ] {
            cp.as_object_mut().unwrap().remove(key);
        }
    }
    fn build(
        &mut self,
        source: &Value,
        contexts: &[Value],
        cp: &mut Value,
        value: &ActiveRows,
        end: u64,
        terminal: &str,
    ) -> Vec<Value> {
        if !flag(cp, "hasUser") || value.rows.is_empty() {
            return Vec::new();
        }
        let fallback = json!({"cwd":source["cwd"],"desktop":source["desktop"]});
        let selected = contexts
            .iter()
            .rev()
            .find(|c| {
                !text(cp, "activeRequestSetId").is_empty()
                    && text(c, "requestSetId") == text(cp, "activeRequestSetId")
            })
            .or_else(|| {
                contexts.iter().rev().find(|c| {
                    number(c, "observedSize") <= end
                        && (number(c, "observedSize") > number(cp, "activeStart")
                            || (number(c, "observedSize")
                                >= optional_number(cp, "contextFloor")
                                    .unwrap_or(number(cp, "activeStart"))
                                && ["UserPromptSubmit", "SessionStart"]
                                    .contains(&text(c, "event"))))
                })
            })
            .unwrap_or(&fallback);
        let first = value
            .rows
            .iter()
            .find(|r| qoder_is_real_user_prompt(r))
            .cloned()
            .unwrap_or(Value::Null);
        let turn = digest(&json!([
            self.agent_id,
            source["sessionId"],
            source["transcriptPath"],
            cp["inode"],
            cp["activeStart"],
            first
        ]));
        let empty = Map::new();
        let span = selected
            .get("spanAttributes")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let resource = selected
            .get("resourceAttributes")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let filtered = value
            .rows
            .iter()
            .filter(|r| !qoder_is_control_user_row(r))
            .cloned()
            .collect::<Vec<_>>();
        let user_identity = selected
            .get("userIdentity")
            .filter(|identity| !identity.is_null())
            .or_else(|| source.get("userIdentity"));
        let runtime_user = resolve_collected_qoder_user_id(&self.data_dir);
        let mut records = build_collected_transcript_turn(
            &filtered,
            CollectedTranscriptTurnContext {
                agent_id: &self.agent_id,
                session_id: text(source, "sessionId"),
                turn_id: &turn,
                runtime_user: &runtime_user,
                cwd: selected
                    .get("cwd")
                    .and_then(Value::as_str)
                    .or_else(|| source.get("cwd").and_then(Value::as_str)),
                user_name: user_identity
                    .and_then(|identity| identity.get("name"))
                    .and_then(Value::as_str),
                user_email: user_identity
                    .and_then(|identity| identity.get("email"))
                    .and_then(Value::as_str),
                agent_name: selected.get("agentName").and_then(Value::as_str),
                span_attributes: span,
                resource_attributes: resource,
            },
        );
        for (index, r) in records.iter_mut().enumerate() {
            r["event.id"] = json!(digest(&json!([
                turn,
                index,
                r["event.name"],
                r.get("gen_ai.tool.call.id")
            ])));
            r["agent.transcript.cursor_mode"] =
                json!(if text(cp, "recoveryReason") == "incremental" {
                    "incremental"
                } else {
                    "bootstrap"
                });
            r["agent.transcript.cursor_reason"] =
                json!(cp.get("recoveryReason").unwrap_or(&json!("incremental")));
            r["agent.transcript.cursor_batch_id"] = json!(turn);
            r["agent.transcript.terminal_source"] = json!(terminal);
            if flag(cp, "incomplete") {
                r["agent.transcript_incomplete"] = json!(true);
                if r["event.name"] == "llm.response"
                    && r.get("agent.stop_reason").is_none()
                    && r.pointer("/gen_ai.response.finish_reasons/0") == Some(&json!("end_turn"))
                {
                    r.as_object_mut()
                        .unwrap()
                        .remove("gen_ai.response.finish_reasons");
                    if let Some(messages) = r
                        .get_mut("gen_ai.output.messages")
                        .and_then(Value::as_array_mut)
                    {
                        for message in messages {
                            if let Some(m) = message.as_object_mut() {
                                m.remove("finish_reason");
                            }
                        }
                    }
                }
            }
        }
        cp["recoveryReason"] = json!("incremental");
        records
    }
    fn scan(
        &mut self,
        source: &Value,
        cp: &mut Value,
        request: LineScan,
        budget: &mut ScanBudget,
        stopped: &AtomicBool,
        mut emit: impl FnMut(scanner::Line) -> bool,
    ) -> anyhow::Result<()> {
        let LineScan { end, options } = request;
        let path = PathBuf::from(text(source, "transcriptPath"));
        let prior = cp
            .get("pendingLine")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .or_else(|| self.tails.shift_remove(&path));
        let batch = scanner::scan_lines(
            &path,
            number(cp, "offset")..end,
            &options,
            prior,
            budget,
            stopped,
            &mut emit,
        )?;
        if let Some(pending) = batch.pending {
            if self.tails.len() >= MAX_TAILS {
                self.tails.shift_remove_index(0);
            }
            self.tails.insert(path, pending.clone());
            cp["pendingLine"] = serde_json::to_value(pending)?;
        } else {
            cp.as_object_mut().unwrap().remove("pendingLine");
            self.tails.shift_remove(&path);
        }
        Ok(())
    }
    fn rows_for(
        &mut self,
        source: &Value,
        cp: &Value,
        budget: &mut ScanBudget,
        stopped: &AtomicBool,
    ) -> anyhow::Result<Option<ActiveRows>> {
        let Some(start) = optional_number(cp, "activeStart") else {
            return Ok(Some(ActiveRows {
                start: 0,
                end: number(cp, "offset"),
                rows: Vec::new(),
                bytes: 0,
            }));
        };
        let key = text(source, "key");
        let mut value = self
            .cache
            .get(key)
            .filter(|v| v.start == start && v.end <= number(cp, "offset"))
            .cloned()
            .unwrap_or(ActiveRows {
                start,
                end: start,
                rows: Vec::new(),
                bytes: 0,
            });
        let end = optional_number(cp, "retainedEnd").unwrap_or(number(cp, "offset"));
        if value.end < end {
            let mut cursor = json!({"offset":value.end});
            let ranges = cp
                .get("quarantines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    let why = match text(r, "reason") {
                        "record-byte-limit" => "record-byte-limit",
                        "invalid-json-line" => "invalid-json-line",
                        "turn-byte-limit" => "turn-byte-limit",
                        "turn-record-limit" => "turn-record-limit",
                        _ => "bootstrap-record-byte-limit",
                    };
                    Some((
                        optional_number(r, "start")?,
                        optional_number(r, "end")?,
                        why,
                    ))
                })
                .collect();
            let max_turn_bytes = self.max_turn_bytes;
            self.scan(
                source,
                &mut cursor,
                LineScan {
                    end,
                    options: ScanOptions {
                        allow_final: true,
                        max_record_bytes: self.max_turn_bytes,
                        skip_ranges: ranges,
                        ..Default::default()
                    },
                },
                budget,
                stopped,
                |line| {
                    value.end = line.end;
                    if let Some(row) = line.row {
                        value.bytes += line.bytes as usize;
                        value.rows.push(row);
                    }
                    value.bytes <= max_turn_bytes
                },
            )?;
            if value.bytes > self.max_turn_bytes {
                anyhow::bail!("turn-byte-limit")
            };
            self.remember(key, value.clone())?;
            if value.end < end {
                return Ok(None);
            }
        }
        Ok(Some(value))
    }
    async fn scan_source(
        &mut self,
        source: &Value,
        contexts: &[Value],
        cp: &mut Value,
        stat: &FileVersion,
        budget: &mut ScanBudget,
        stopped: &AtomicBool,
    ) -> anyhow::Result<Vec<Value>> {
        let mut records = Vec::new();
        for property in ["migration", "findAnchorLine"] {
            if cp.get(property).is_none() {
                continue;
            }
            let target = number(&cp[property], "target");
            let mut seen = number(&cp[property], "seen");
            let mut end = number(cp, "offset");
            if target > seen {
                self.scan(
                    source,
                    cp,
                    LineScan {
                        end: stat.size,
                        options: ScanOptions {
                            count_only: true,
                            legacy_count_final: property == "migration",
                            max_record_bytes: self.max_turn_bytes,
                            ..Default::default()
                        },
                    },
                    budget,
                    stopped,
                    |line| {
                        seen += 1;
                        end = line.end;
                        seen < target
                    },
                )?;
            }
            cp["offset"] = json!(end);
            cp[property]["seen"] = json!(seen);
            if seen < target && end < stat.size {
                return Ok(records);
            }
            if seen < target {
                cp["offset"] = json!(0);
                cp["recoveryReason"] = json!("truncated");
                cp["bootstrapEnd"] = cp["anchorSize"].clone();
            } else if property == "findAnchorLine" {
                cp["anchorSize"] = cp["offset"].clone();
                cp["bootstrapEnd"] = cp["offset"].clone();
                cp["offset"] = json!(0);
            } else {
                cp["committedOffset"] = cp["offset"].clone();
            }
            cp.as_object_mut().unwrap().remove(property);
            if budget.remaining <= 0 {
                return Ok(records);
            }
        }
        if !cp["bootstrapEnd"].is_null() && !self.find_bootstrap(source, contexts, cp, budget)? {
            return Ok(records);
        }
        if cp.get("initialOwnership").is_some() {
            self.find_owned_prompt(source, cp, stat, budget, stopped)
                .await?;
        }
        if let Some(mut backfill) = cp.get("backfill").cloned() {
            let mut recovery_source = source.clone();
            recovery_source["key"] = json!(format!("{}:backfill", text(source, "key")));
            let mut end_stat = stat.clone();
            end_stat.size = number(&backfill, "end");
            records.extend(
                Box::pin(self.scan_source(
                    &recovery_source,
                    contexts,
                    &mut backfill,
                    &end_stat,
                    budget,
                    stopped,
                ))
                .await?,
            );
            if number(&backfill, "offset") >= end_stat.size && backfill["activeStart"].is_null() {
                cp["committedOffset"] = json!(number(cp, "committedOffset").max(end_stat.size));
                cp.as_object_mut().unwrap().remove("backfill");
                cp.as_object_mut().unwrap().remove("unresolvedPrompt");
                self.drop_cache(text(&recovery_source, "key"));
            } else {
                cp["backfill"] = backfill;
            }
        }
        let time = self.time();
        if number(cp, "stableSize") != stat.size || cp["stableMtime"] != json!(mtime(stat)) {
            cp["stableSize"] = json!(stat.size);
            cp["stableMtime"] = json!(mtime(stat));
            cp["stableAt"] = json!(time)
        }
        let stable = time - cp["stableAt"].as_i64().unwrap_or(time) >= self.stable_ms;
        let ready = stable
            && flag(cp, "terminal")
            && time - cp["terminalAt"].as_i64().unwrap_or(time) >= self.settle_ms;
        if number(cp, "offset") == stat.size
            && !cp["activeStart"].is_null()
            && !ready
            && !flag(cp, "sealedBoundary")
        {
            return Ok(records);
        }
        let Some(mut value) = self.rows_for(source, cp, budget, stopped)? else {
            return Ok(records);
        };
        let options = ScanOptions {
            allow_final: stable,
            max_record_bytes: self.max_turn_bytes,
            ..Default::default()
        };
        // The scanner callback is synchronous and bounded. All semantic mutations
        // and events remain staged until post-read generation checks succeed.
        let file = PathBuf::from(text(source, "transcriptPath"));
        let prior = cp
            .get("pendingLine")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .or_else(|| self.tails.shift_remove(&file));
        let mut turns = 0;
        let batch = scanner::scan_lines(
            &file,
            number(cp, "offset")..stat.size,
            &options,
            prior,
            budget,
            stopped,
            |line| {
                if let Some(reason) = line.quarantine {
                    self.quarantine(source, cp, line.start, line.end, reason)
                }
                let row = line.row;
                let prompt = row.as_ref().is_some_and(qoder_is_real_user_prompt);
                let floor = number(cp, "committedOffset").max(number(cp, "nativeStopOffset"));
                if row.as_ref().is_some_and(|r| event(r) == "Stop") {
                    cp["nativeStopOffset"] = json!(line.end)
                }
                if prompt && flag(cp, "hasUser") {
                    records.extend(self.build(
                        source,
                        contexts,
                        cp,
                        &value,
                        line.start,
                        "next-prompt",
                    ));
                    cp["committedOffset"] = json!(line.start);
                    Self::clear_active(cp);
                    value = ActiveRows {
                        start: line.start,
                        end: line.start,
                        rows: Vec::new(),
                        bytes: 0,
                    };
                    turns += 1;
                }
                if prompt && cp["activeStart"].is_null() {
                    cp["activeStart"] = json!(line.start);
                    cp["contextFloor"] = json!(floor);
                    value.start = line.start;
                }
                if !cp["activeStart"].is_null() {
                    if let Some(r) = row.as_ref().filter(|_| !flag(cp, "turnTruncated")) {
                        let reason = if value.rows.len() >= MAX_TURN_RECORDS {
                            Some("turn-record-limit")
                        } else if value.bytes + line.bytes as usize > self.max_turn_bytes {
                            Some("turn-byte-limit")
                        } else {
                            None
                        };
                        if let Some(reason) = reason {
                            cp["turnTruncated"] = json!(true);
                            cp["retainedEnd"] = json!(line.start);
                            self.quarantine(source, cp, line.start, line.end, reason);
                        } else {
                            value.rows.push(r.clone());
                            value.bytes += line.bytes as usize;
                        }
                    }
                    if prompt {
                        cp["hasUser"] = json!(true)
                    }
                    if row.as_ref().is_some_and(|r| {
                        event(r) == "Stop" || qoder_has_cn_terminal(std::slice::from_ref(r))
                    }) {
                        if !flag(cp, "terminal") {
                            cp["terminalAt"] = json!(self.time())
                        }
                        cp["terminal"] = json!(true)
                    }
                }
                cp["offset"] = json!(line.end);
                value.end = line.end;
                if row
                    .as_ref()
                    .is_some_and(|r| text(r, "type") == "last-prompt" || event(r) == "SessionEnd")
                    && flag(cp, "hasUser")
                {
                    let terminal = if row
                        .as_ref()
                        .is_some_and(|r| text(r, "type") == "last-prompt")
                    {
                        "last-prompt"
                    } else {
                        "session-end"
                    };
                    records.extend(self.build(source, contexts, cp, &value, line.end, terminal));
                    cp["committedOffset"] = json!(line.end);
                    Self::clear_active(cp);
                    value = ActiveRows {
                        start: 0,
                        end: line.end,
                        rows: Vec::new(),
                        bytes: 0,
                    };
                    turns += 1;
                }
                turns < 32 && records.len() < 4096 && !stopped.load(Ordering::SeqCst)
            },
        )?;
        if let Some(pending) = batch.pending {
            if pending.position - pending.start > self.max_turn_bytes as u64 {
                if flag(cp, "hasUser") {
                    cp["incomplete"] = json!(true)
                }
                self.report(text(source, "key"), "record-byte-limit");
            }
            if self.tails.len() >= MAX_TAILS {
                self.tails.shift_remove_index(0);
            }
            self.tails.insert(file, pending.clone());
            cp["pendingLine"] = serde_json::to_value(pending)?;
        } else {
            cp.as_object_mut().unwrap().remove("pendingLine");
            self.tails.shift_remove(&file);
        }
        if flag(cp, "hasUser")
            && !flag(cp, "terminal")
            && optional_number(cp, "nativeStopOffset").is_none()
            && value.rows.iter().any(|r| text(r, "type") == "assistant")
            && contexts.iter().any(|c| {
                text(c, "event") == "Stop"
                    && number(c, "observedSize") > number(cp, "activeStart")
                    && number(c, "observedSize") <= number(cp, "offset")
            })
        {
            cp["terminal"] = json!(true);
            cp["terminalAt"] = json!(self.time());
        }
        if !cp["activeStart"].is_null()
            && flag(cp, "terminal")
            && number(cp, "offset") == stat.size
            && (cp["stableSize"] != json!(stat.size) || cp["stableMtime"] != json!(mtime(stat)))
        {
            cp["stableSize"] = json!(stat.size);
            cp["stableMtime"] = json!(mtime(stat));
            cp["stableAt"] = json!(self.time());
        }
        if !cp["activeStart"].is_null()
            && number(cp, "offset") == stat.size
            && (flag(cp, "sealedBoundary")
                || (flag(cp, "terminal")
                    && self.time() - cp["stableAt"].as_i64().unwrap_or(self.time())
                        >= self.stable_ms
                    && self.time() - cp["terminalAt"].as_i64().unwrap_or(self.time())
                        >= self.settle_ms))
        {
            let terminal = if flag(cp, "sealedBoundary") {
                "next-prompt-backfill"
            } else {
                "stable-terminal-eof"
            };
            records.extend(self.build(
                source,
                contexts,
                cp,
                &value,
                number(cp, "offset"),
                terminal,
            ));
            cp["committedOffset"] = cp["offset"].clone();
            Self::clear_active(cp);
            value = ActiveRows {
                start: 0,
                end: number(cp, "offset"),
                rows: Vec::new(),
                bytes: 0,
            };
        }
        self.remember(text(source, "key"), value)?;
        Ok(records)
    }
    async fn find_owned_prompt(
        &mut self,
        source: &Value,
        cp: &mut Value,
        stat: &FileVersion,
        budget: &mut ScanBudget,
        stopped: &AtomicBool,
    ) -> anyhow::Result<bool> {
        if self.prompt_budget == 0
            || self
                .prompt_chosen
                .as_deref()
                .is_some_and(|key| key != text(source, "key"))
        {
            return Ok(false);
        }
        self.prompt_budget -= 1;
        self.mark_inspection(text(source, "key"), true);
        let mut pending = cp["initialOwnership"].clone();
        let cursor = pending
            .get("dbCursor")
            .and_then(|v| serde_json::from_value::<QoderOwnershipCursor>(v.clone()).ok());
        let mut search = pending
            .get("dbSearch")
            .and_then(|v| serde_json::from_value::<QoderOwnershipSearch>(v.clone()).ok())
            .unwrap_or_default();
        let proof = self
            .resolver
            .resolve(
                &self.agent_id,
                text(source, "sessionId"),
                text(&pending, "requestSetId"),
                cursor.as_ref(),
                &mut search,
            )
            .await;
        pending["dbSearch"] = serde_json::to_value(search)?;
        let Some(proof) = proof.filter(|p| p.rows.len() <= 256) else {
            self.report(text(source, "key"), "initial-prompt-owner-unavailable");
            cp["initialOwnership"] = pending;
            return Ok(false);
        };
        if proof.reset == Some(true) {
            pending["offset"] = json!(0);
            pending["seen"] = json!(0);
            pending["candidate"] = Value::Null;
            pending.as_object_mut().unwrap().remove("dbCursor");
            pending.as_object_mut().unwrap().remove("pendingLine");
            cp["initialOwnership"] = pending;
            return Ok(false);
        }
        let mut index = 0;
        let mut invalid = false;
        let mut quarantines = Vec::new();
        let mut scan_cursor = pending.clone();
        self.scan(source,
&mut scan_cursor,
LineScan{end:stat.size,options:ScanOptions{max_record_bytes:self.max_turn_bytes,..Default::default()}},
budget,
stopped,
|line|{
 if let Some(reason)=line.quarantine{quarantines.push((line.start,line.end,reason));pending["offset"]=json!(line.end);return true}
 if let Some(row)=line.row.as_ref().filter(|r|qoder_is_real_user_prompt(r)){let at=chrono::DateTime::parse_from_rfc3339(text(row,"timestamp")).ok().map(|d|d.timestamp_millis()as f64);let proof_row=proof.rows.get(index);let valid=proof_row.zip(at).is_some_and(|(r,t)|r.at.is_finite()&&(t-r.at).abs()<=5000.0&&r.request_id.encode_utf16().count()<=512&&r.at>pending.pointer("/dbCursor/at").and_then(Value::as_f64).unwrap_or(0.0));if !valid{invalid=true;return false}let r=proof_row.unwrap();if r.request_id==text(&pending,"requestSetId"){pending["candidate"]=json!(line.start)}pending["lastUserOffset"]=json!(line.start);pending["dbCursor"]=json!({"at":r.at,"requestId":r.request_id,"inventoryId":proof.inventory_id});pending["seen"]=json!(number(&pending,"seen")+1);index+=1;}
 pending["offset"]=json!(line.end);true
 })?;
        if let Some(t) = scan_cursor.get("pendingLine") {
            pending["pendingLine"] = t.clone()
        } else {
            pending.as_object_mut().unwrap().remove("pendingLine");
        }
        for (start, end, reason) in quarantines {
            self.quarantine(source, &mut pending, start, end, reason);
        }
        if invalid
            || number(&pending, "offset") < stat.size
            || index < proof.rows.len()
            || !proof.complete
            || pending["candidate"].is_null()
        {
            self.report(text(source, "key"), "initial-prompt-owner-pending");
            cp["initialOwnership"] = pending;
            return Ok(false);
        }
        if number(&pending, "candidate") < number(&pending, "anchorEnd") {
            cp["backfill"] = json!({"inode":stat.ino,"offset":pending["candidate"],"committedOffset":pending["candidate"],"activeStart":null,"hasUser":false,"bootstrapEnd":null,"recoveryReason":"initial-prompt-recovery","activeRequestSetId":pending["requestSetId"],"end":pending["anchorEnd"],"sealedBoundary":number(&pending,"lastUserOffset")>=number(&pending,"anchorEnd")});
        }
        cp.as_object_mut().unwrap().remove("initialOwnership");
        if cp.get("backfill").is_none() {
            cp.as_object_mut().unwrap().remove("unresolvedPrompt");
        }
        self.tails
            .shift_remove(Path::new(text(source, "transcriptPath")));
        Ok(true)
    }

    fn mark_inspection(&mut self, key: &str, prompt: bool) {
        self.inspection_sequence += 1;
        let map = if prompt {
            &mut self.prompt_inspections
        } else {
            &mut self.owner_inspections
        };
        map.shift_remove(key);
        if map.len() >= MAX_TAILS {
            map.shift_remove_index(0);
        }
        map.insert(key.to_owned(), self.inspection_sequence);
    }
    fn owner_process_alive(&self, pid: u32) -> bool {
        #[cfg(test)]
        if let Some(probe) = &self.owner_pid_probe {
            // The same production normalization used by the native Unix and
            // Windows zero-signal probes; only the OS result is fault-injected.
            return crate::utils::pid_utils::process_alive_from_kill(probe(pid));
        }
        crate::utils::is_process_alive(pid)
    }
    fn legacy_worker_alive(&mut self, transcript: &Path, key: &str) -> anyhow::Result<bool> {
        let lock = qoder_legacy_retry_lock_path(&self.data_dir, transcript);
        let (value, stat) = match snapshot(&lock, MAX_NOTICES) {
            Ok(v) => v,
            Err(_) => {
                self.owner_pending.shift_remove(key);
                let Ok(f) = scanner::open_regular(&lock) else {
                    return Ok(false);
                };
                let stat = scanner::version(&f)?;
                return Ok(self.time() as f64 - mtime(&stat) < 1000.0);
            }
        };
        let pid = optional_number(&value, "pid").filter(|p| *p > 0 && *p <= u32::MAX as u64);
        let acquired = value
            .get("startedAt")
            .and_then(Value::as_f64)
            .filter(|t| t.is_finite());
        let Some((pid, acquired)) = pid.zip(acquired) else {
            self.owner_pending.shift_remove(key);
            return Ok(self.time() as f64 - mtime(&stat) < 1000.0);
        };
        if !self.owner_process_alive(pid as u32) {
            self.owner_pending.shift_remove(key);
            return Ok(false);
        }
        if self.time() as f64 - acquired <= 60000.0 {
            self.owner_pending.shift_remove(key);
            return Ok(true);
        }
        if let Some((v, alive, checked)) = self.legacy_owners.get(&lock) {
            if *v == stat && (!alive || self.time() - checked < 5000) {
                let alive = *alive;
                self.owner_pending.shift_remove(key);
                return Ok(alive);
            }
        }
        if !self.owner_pending.contains(key) && self.owner_pending.len() >= MAX_TAILS {
            if let Some(old) = self.owner_pending.iter().next().cloned() {
                self.owner_pending.shift_remove(&old);
            }
        }
        self.owner_pending.insert(key.to_owned());
        if self.owner_budget == 0
            || self
                .owner_chosen
                .as_deref()
                .is_some_and(|chosen| chosen != key)
        {
            return Ok(true);
        }
        self.owner_budget = 0;
        self.owner_pending.shift_remove(key);
        self.mark_inspection(key, false);
        let born = process_birth::birth_ms(pid as u32);
        let alive = born.is_none_or(|at| at <= acquired + 1000.0);
        if self.legacy_owners.len() >= MAX_TAILS {
            self.legacy_owners.shift_remove_index(0);
        }
        self.legacy_owners.insert(lock, (stat, alive, self.time()));
        self.report(
            key,
            if !alive {
                "legacy-lock-pid-reused"
            } else if born.is_some() {
                "legacy-worker-still-active"
            } else {
                "legacy-owner-unverified"
            },
        );
        Ok(alive)
    }
}

#[cfg(test)]
#[path = "transcript_source_history.rs"]
mod history_contracts;
