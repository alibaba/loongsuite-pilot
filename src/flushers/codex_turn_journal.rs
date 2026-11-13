//! Pending native Codex turns and metadata-only export acknowledgements.
//! File names, group hashes and schema are compatible with main's Node journal.
use crate::types::AgentActivityEntry;
use anyhow::{ensure, Context, Result};
use indexmap::{IndexMap, IndexSet};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, Take};
use tokio::sync::Mutex;

const MAX_ACKNOWLEDGED_TURNS: usize = 10_000;
const DEFAULT_PENDING_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct CodexJournalCapacity;

impl std::fmt::Display for CodexJournalCapacity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Codex pending trace journal capacity exhausted")
    }
}
impl std::error::Error for CodexJournalCapacity {}

fn max_pending_bytes() -> u64 {
    std::env::var("LOONGSUITE_CODEX_PENDING_MAX_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
        .unwrap_or(DEFAULT_PENDING_BYTES)
}
const JOURNAL_BATCH_BYTES: usize = 1024 * 1024;
const JOURNAL_SCAN_BYTES: usize = 64 * 1024;

pub fn codex_turn_journal_group_key(entry: &AgentActivityEntry) -> String {
    let parts = (&entry.user_id, &entry.session_id, entry.turn_id.as_deref());
    hex::encode(Sha256::digest(
        serde_json::to_vec(&parts).expect("string tuple serializes"),
    ))
}

pub fn is_journaled_codex_entry(entry: &AgentActivityEntry) -> bool {
    entry.agent_type == "codex"
        && !entry.session_id.is_empty()
        && entry
            .turn_id
            .as_deref()
            .is_some_and(|turn| !turn.is_empty())
        && !entry.event_id.is_empty()
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Default)]
struct JournalState {
    initialized: HashSet<String>,
    acknowledgements: Option<IndexMap<String, SystemTime>>,
}

pub struct CodexTurnJournal {
    dir: PathBuf,
    acknowledgement_limit: usize,
    max_pending_bytes: u64,
    state: Mutex<JournalState>,
}

/// Compatibility reader for callers that need a complete turn for conversion.
pub struct CodexJournalReplay {
    batches: CodexJournalBatchReplay,
}

/// One bounded batch from a retained turn. A single oversized event is indivisible.
#[derive(Debug)]
pub struct CodexJournalBatch {
    pub key: String,
    pub entries: Vec<AgentActivityEntry>,
    pub last: bool,
}

pub struct CodexJournalBatchReplay {
    journal: Arc<CodexTurnJournal>,
    files: VecDeque<(String, PathBuf)>,
    active: Option<PendingTurnReader>,
}

struct PendingTurnReader {
    key: String,
    reader: BufReader<Take<tokio::fs::File>>,
    seen: HashSet<String>,
    pending: Option<(AgentActivityEntry, usize)>,
}

impl CodexTurnJournal {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            acknowledgement_limit: MAX_ACKNOWLEDGED_TURNS,
            max_pending_bytes: max_pending_bytes(),
            state: Mutex::new(JournalState::default()),
        }
    }

    /// Mirrors the source Number option: only positive JavaScript safe integers
    /// are accepted. Normal production callers retain the 10,000-ACK bound.
    pub fn with_acknowledgement_limit(
        dir: impl Into<PathBuf>,
        acknowledgement_limit: f64,
    ) -> Result<Self> {
        ensure!(
            acknowledgement_limit.is_finite()
                && acknowledgement_limit.fract() == 0.0
                && (1.0..=9_007_199_254_740_991.0).contains(&acknowledgement_limit),
            "acknowledgementLimit must be a positive safe integer"
        );
        let mut journal = Self::new(dir);
        journal.acknowledgement_limit = acknowledgement_limit as usize;
        Ok(journal)
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("codex-turn-{key}.jsonl"))
    }
    fn done_file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("codex-done-{key}.json"))
    }

    async fn ensure_dir(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700)).await?;
        }
        Ok(())
    }

    async fn load_acknowledgements(&self, state: &mut JournalState) -> Result<()> {
        if state.acknowledgements.is_some() {
            return Ok(());
        }
        let mut acknowledged = IndexMap::new();
        if let Some(mut directory) = read_directory(&self.dir).await? {
            while let Some(entry) = directory.next_entry().await? {
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Some(key) = name
                    .strip_prefix("codex-done-")
                    .and_then(|name| name.strip_suffix(".json"))
                    .filter(|key| valid_key(key))
                else {
                    continue;
                };
                if !entry.file_type().await?.is_file() {
                    continue;
                }
                let bytes = tokio::fs::read(entry.path()).await?;
                let Ok(metadata) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                if metadata["version"] == 1 && metadata["key"] == key {
                    acknowledged.insert(key.to_owned(), entry.metadata().await?.modified()?);
                }
            }
        }
        state.acknowledgements = Some(acknowledged);
        self.trim_acknowledgements(state).await
    }

    pub async fn append(&self, entries: &[AgentActivityEntry]) -> Result<()> {
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        let mut groups: IndexMap<String, Vec<&AgentActivityEntry>> = IndexMap::new();
        for entry in entries
            .iter()
            .filter(|entry| is_journaled_codex_entry(entry))
        {
            let key = codex_turn_journal_group_key(entry);
            if !state
                .acknowledgements
                .as_ref()
                .expect("loaded")
                .contains_key(&key)
            {
                groups.entry(key).or_default().push(entry);
            }
        }
        if groups.is_empty() {
            return Ok(());
        }
        self.ensure_dir().await?;
        let mut encoded = IndexMap::new();
        let mut batch_bytes = 0_u64;
        for (key, group) in groups {
            let mut bytes = Vec::new();
            for entry in group {
                serde_json::to_writer(&mut bytes, entry)?;
                bytes.push(b'\n');
            }
            batch_bytes = batch_bytes.saturating_add(bytes.len() as u64);
            encoded.insert(key, bytes);
        }
        let mut usage = 0_u64;
        let mut old = false;
        let mut files = tokio::fs::read_dir(&self.dir).await?;
        while let Some(file) = files.next_entry().await? {
            let name = file.file_name();
            if !name
                .to_str()
                .and_then(|name| name.strip_prefix("codex-turn-"))
                .and_then(|name| name.strip_suffix(".jsonl"))
                .is_some_and(valid_key)
            {
                continue;
            }
            let metadata = match file.metadata().await {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            usage = usage.saturating_add(metadata.len());
            old |= metadata
                .modified()
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 7 * 86_400);
        }
        if usage.saturating_add(batch_bytes) > self.max_pending_bytes {
            return Err(CodexJournalCapacity.into());
        }
        if old {
            crate::utils::create_logger("CodexTurnJournal").warn(
                "Codex pending journal backlog exceeds seven days; retaining pending events",
                None,
            );
        }
        for (key, bytes) in encoded {
            let file = self.file(&key);
            if !state.initialized.contains(&key) {
                repair_tail(&file).await?;
                state.initialized.insert(key.clone());
            }
            let result = async {
                let mut options = std::fs::OpenOptions::new();
                options.create(true).append(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut handle = tokio::fs::OpenOptions::from(options).open(&file).await?;
                handle.write_all(&bytes).await?;
                // Tokio File can buffer outstanding blocking writes; acceptance
                // requires their result, not merely a scheduled write.
                handle.flush().await?;
                private_file(&file).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if result.is_err() {
                state.initialized.remove(&key);
            }
            result.context("Codex pending turn append failed")?;
        }
        Ok(())
    }

    pub async fn load(self: &Arc<Self>, key: Option<&str>) -> Result<CodexJournalReplay> {
        Ok(CodexJournalReplay {
            batches: self.load_batches(key).await?,
        })
    }

    /// Read retained turns without materializing all their JSON text or events.
    /// Reopening a key creates an independent reader, including for policy preflight.
    pub async fn load_batches(
        self: &Arc<Self>,
        key: Option<&str>,
    ) -> Result<CodexJournalBatchReplay> {
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        let mut files = Vec::new();
        if let Some(key) = key {
            if valid_key(key) {
                match tokio::fs::symlink_metadata(self.file(key)).await {
                    Ok(meta) if meta.is_file() => files.push((key.to_owned(), self.file(key))),
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        } else if let Some(mut directory) = read_directory(&self.dir).await? {
            while let Some(entry) = directory.next_entry().await? {
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Some(key) = name
                    .strip_prefix("codex-turn-")
                    .and_then(|name| name.strip_suffix(".jsonl"))
                    .filter(|key| valid_key(key))
                else {
                    continue;
                };
                if entry.file_type().await?.is_file() {
                    files.push((key.to_owned(), entry.path()));
                }
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(CodexJournalBatchReplay {
            journal: Arc::clone(self),
            files: files.into(),
            active: None,
        })
    }

    pub async fn is_acknowledged(&self, entry: &AgentActivityEntry) -> Result<bool> {
        if !is_journaled_codex_entry(entry) {
            return Ok(false);
        }
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        Ok(state
            .acknowledgements
            .as_ref()
            .expect("loaded")
            .contains_key(&codex_turn_journal_group_key(entry)))
    }

    pub async fn acknowledge(&self, entries: &[AgentActivityEntry]) -> Result<()> {
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        let keys: IndexSet<_> = entries
            .iter()
            .filter(|entry| is_journaled_codex_entry(entry))
            .map(codex_turn_journal_group_key)
            .collect();
        if keys.is_empty() {
            return Ok(());
        }
        self.ensure_dir().await?;
        for key in keys {
            if !state
                .acknowledgements
                .as_ref()
                .expect("loaded")
                .contains_key(&key)
            {
                let temporary = self
                    .dir
                    .join(format!(".codex-done-{}.tmp", uuid::Uuid::new_v4()));
                let result = async {
                    let mut options = std::fs::OpenOptions::new();
                    options.create_new(true).write(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut file = tokio::fs::OpenOptions::from(options)
                        .open(&temporary)
                        .await?;
                    file.write_all(&serde_json::to_vec(
                        &serde_json::json!({"version":1,"key":key}),
                    )?)
                    .await?;
                    file.flush().await?;
                    drop(file);
                    tokio::fs::rename(&temporary, self.done_file(&key)).await?;
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if result.is_err() {
                    let _ = tokio::fs::remove_file(&temporary).await;
                }
                result?;
                state
                    .acknowledgements
                    .as_mut()
                    .expect("loaded")
                    .insert(key.clone(), SystemTime::now());
            }
            // Publish the acknowledgement before deleting pending content.
            remove_if_present(&self.file(&key)).await?;
            state.initialized.remove(&key);
        }
        self.trim_acknowledgements(&mut state).await
    }

    pub async fn remove_entries(&self, entries: &[AgentActivityEntry]) -> Result<()> {
        let keys: IndexSet<_> = entries
            .iter()
            .filter(|entry| is_journaled_codex_entry(entry))
            .map(codex_turn_journal_group_key)
            .collect();
        let mut state = self.state.lock().await;
        for key in keys {
            remove_if_present(&self.file(&key)).await?;
            state.initialized.remove(&key);
        }
        Ok(())
    }

    pub async fn remove_key(&self, key: &str) -> Result<()> {
        if !valid_key(key) {
            return Ok(());
        }
        let mut state = self.state.lock().await;
        remove_if_present(&self.file(key)).await?;
        state.initialized.remove(key);
        Ok(())
    }

    async fn trim_acknowledgements(&self, state: &mut JournalState) -> Result<()> {
        let acknowledgements = state.acknowledgements.as_mut().expect("loaded");
        let excess = acknowledgements
            .len()
            .saturating_sub(self.acknowledgement_limit);
        if excess == 0 {
            return Ok(());
        }
        let mut oldest: Vec<_> = acknowledgements
            .iter()
            .map(|(key, time)| (key.clone(), *time))
            .collect();
        oldest.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        for (key, _) in oldest.into_iter().take(excess) {
            // A crash can leave content behind its ACK. Keep the ACK when
            // residual cleanup fails, or it could become replayable again.
            remove_if_present(&self.file(&key)).await?;
            state.initialized.remove(&key);
            remove_if_present(&self.done_file(&key)).await?;
            acknowledgements.shift_remove(&key);
        }
        Ok(())
    }
}

impl CodexJournalReplay {
    pub async fn next_group(&mut self) -> Result<Option<Vec<AgentActivityEntry>>> {
        let mut group = Vec::new();
        while let Some(batch) = self.batches.next_batch().await? {
            group.extend(batch.entries);
            if batch.last && !group.is_empty() {
                return Ok(Some(group));
            }
        }
        Ok(None)
    }
}

impl CodexJournalBatchReplay {
    pub async fn next_batch(&mut self) -> Result<Option<CodexJournalBatch>> {
        let mut state = self.journal.state.lock().await;
        self.journal.load_acknowledgements(&mut state).await?;
        loop {
            if self.active.is_none() {
                let Some((key, path)) = self.files.pop_front() else {
                    return Ok(None);
                };
                if state
                    .acknowledgements
                    .as_ref()
                    .expect("loaded")
                    .contains_key(&key)
                {
                    continue;
                }
                let mut file = match tokio::fs::File::open(&path).await {
                    Ok(file) => file,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                let length = complete_length(&mut file).await?;
                if length == 0 {
                    continue;
                }
                file.seek(std::io::SeekFrom::Start(0)).await?;
                self.active = Some(PendingTurnReader {
                    key,
                    reader: BufReader::new(file.take(length)),
                    seen: HashSet::new(),
                    pending: None,
                });
            }
            let active = self.active.as_mut().expect("active turn");
            let mut entries = Vec::new();
            let mut bytes = 0;
            loop {
                let (entry, size) = match active.pending.take() {
                    Some(pending) => pending,
                    None => {
                        let mut line = Vec::new();
                        if active.reader.read_until(b'\n', &mut line).await? == 0 {
                            let key = active.key.clone();
                            self.active = None;
                            return Ok(Some(CodexJournalBatch {
                                key,
                                entries,
                                last: true,
                            }));
                        }
                        // The committed-length bound excludes an incomplete tail.
                        // Also reject a file externally truncated during this read.
                        if line.pop() != Some(b'\n') {
                            continue;
                        }
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        let text = String::from_utf8_lossy(&line);
                        let Ok(entry) = serde_json::from_str::<AgentActivityEntry>(&text) else {
                            continue;
                        };
                        if !is_journaled_codex_entry(&entry)
                            || codex_turn_journal_group_key(&entry) != active.key
                            || !active.seen.insert(entry.event_id.clone())
                        {
                            continue;
                        }
                        (entry, text.len())
                    }
                };
                if !entries.is_empty() && bytes + size > JOURNAL_BATCH_BYTES {
                    active.pending = Some((entry, size));
                    return Ok(Some(CodexJournalBatch {
                        key: active.key.clone(),
                        entries,
                        last: false,
                    }));
                }
                entries.push(entry);
                bytes += size;
            }
        }
    }
}

async fn read_directory(path: &Path) -> Result<Option<tokio::fs::ReadDir>> {
    match tokio::fs::read_dir(path).await {
        Ok(directory) => Ok(Some(directory)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn remove_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Locate the last committed newline with bounded backward reads.
async fn complete_length(file: &mut tokio::fs::File) -> Result<u64> {
    let mut end = file.metadata().await?.len();
    let mut buffer = vec![0u8; JOURNAL_SCAN_BYTES];
    while end > 0 {
        let start = end.saturating_sub(buffer.len() as u64);
        let length = (end - start) as usize;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        file.read_exact(&mut buffer[..length]).await?;
        if let Some(index) = buffer[..length].iter().rposition(|b| *b == b'\n') {
            return Ok(start + index as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

async fn repair_tail(path: &Path) -> Result<()> {
    let mut file = match tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let length = complete_length(&mut file).await?;
    if length != file.metadata().await?.len() {
        file.set_len(length).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, turn: &str) -> AgentActivityEntry {
        serde_json::from_value(json!({
            "event.id":id,"event.name":"gen_ai.model.request","time_unix_nano":"1000000",
            "user.id":"user-1","gen_ai.agent.type":"codex","gen_ai.session.id":"child-session",
            "gen_ai.turn.id":turn,"gen_ai.agent.parent.invocation.id":"incoming"
        }))
        .unwrap()
    }

    async fn read(
        journal: &Arc<CodexTurnJournal>,
        key: Option<&str>,
    ) -> Vec<Vec<AgentActivityEntry>> {
        let mut replay = journal.load(key).await.unwrap();
        let mut groups = Vec::new();
        while let Some(group) = replay.next_group().await.unwrap() {
            groups.push(group);
        }
        groups
    }

    #[test]
    fn group_hash_matches_node_utf8_array_protocol() {
        let mut record = entry("event", "turn\"\n");
        record.user_id = "user-你好".into();
        record.session_id = "session/🚀".into();
        assert_eq!(
            codex_turn_journal_group_key(&record),
            "7a525c8b69b11423ef63b7dff7c01500ddb76ead8836fe4694f4f5c67e109381"
        );
    }

    #[tokio::test]
    async fn codex_quota_rejects_a_whole_batch_and_recovers_after_capacity_returns() {
        let root = tempfile::tempdir().unwrap();
        let mut journal = CodexTurnJournal::new(root.path());
        let first = entry("first", "first");
        let second = entry("second", "second");
        journal.max_pending_bytes = (serde_json::to_vec(&first)
            .unwrap()
            .len()
            .max(serde_json::to_vec(&second).unwrap().len())
            + 1) as u64;
        journal.append(std::slice::from_ref(&first)).await.unwrap();
        let failure = journal
            .append(std::slice::from_ref(&second))
            .await
            .unwrap_err();
        assert!(failure.is::<CodexJournalCapacity>());
        assert!(!journal
            .file(&codex_turn_journal_group_key(&second))
            .exists());
        journal
            .acknowledge(std::slice::from_ref(&first))
            .await
            .unwrap();
        journal.append(std::slice::from_ref(&second)).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_append_and_restart_preserve_user_session_turn_and_first_event_identity() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let mut records = vec![
            entry("a", "turn"),
            entry("b", "turn"),
            entry("c", "turn-2"),
            entry("d", "turn"),
            entry("e", "turn"),
        ];
        records[3].session_id = "session-2".into();
        records[4].user_id = "user-2".into();
        let (a, b) = tokio::join!(journal.append(&records), journal.append(&records[..1]));
        a.unwrap();
        b.unwrap();
        let restarted = Arc::new(CodexTurnJournal::new(root.path()));
        let groups = read(&restarted, None).await;
        assert_eq!(groups.len(), 4);
        let mut all: Vec<_> = groups.into_iter().flatten().collect();
        all.sort_by(|a, b| a.event_id.cmp(&b.event_id));
        assert_eq!(all, records);
    }

    #[tokio::test]
    async fn lazy_replay_reads_later_group_after_yield_and_ignores_acknowledged_groups() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let mut records: Vec<_> = (0..70)
            .map(|i| entry(&format!("event-{i}"), &format!("turn-{i}")))
            .collect();
        journal.append(&records).await.unwrap();
        records.sort_by_key(codex_turn_journal_group_key);
        let mut replay = journal.load(None).await.unwrap();
        let first = replay.next_group().await.unwrap().unwrap();
        journal.acknowledge(&first).await.unwrap();
        let mut changed = records[1].clone();
        changed.event_id = "written-after-yield".into();
        tokio::fs::write(
            journal.file(&codex_turn_journal_group_key(&changed)),
            format!("{}\n", serde_json::to_string(&changed).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(
            replay.next_group().await.unwrap().unwrap()[0].event_id,
            "written-after-yield"
        );
        assert!(
            read(&journal, Some(&codex_turn_journal_group_key(&first[0])))
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn incomplete_tail_is_excluded_and_repaired_before_append_even_across_scan_chunks() {
        for partial in [b"{partial".to_vec(), vec![b'x'; 20_000]] {
            let root = tempfile::tempdir().unwrap();
            let first = entry("first", "turn");
            let journal = Arc::new(CodexTurnJournal::new(root.path()));
            journal.append(std::slice::from_ref(&first)).await.unwrap();
            let path = journal.file(&codex_turn_journal_group_key(&first));
            let mut file = tokio::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .await
                .unwrap();
            file.write_all(&partial).await.unwrap();
            file.flush().await.unwrap();
            drop(file);
            let restarted = Arc::new(CodexTurnJournal::new(root.path()));
            assert_eq!(read(&restarted, None).await, vec![vec![first.clone()]]);
            let second = entry("second", "turn");
            restarted
                .append(std::slice::from_ref(&second))
                .await
                .unwrap();
            assert_eq!(read(&restarted, None).await, vec![vec![first, second]]);
        }
    }

    #[tokio::test]
    async fn rejects_foreign_groups_and_malformed_lines_without_losing_complete_records() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let valid = entry("valid", "turn");
        let mut foreign = valid.clone();
        foreign.agent_type = "openclaw".into();
        let mut missing = valid.clone();
        missing.turn_id = None;
        journal
            .append(&[valid.clone(), foreign.clone(), missing])
            .await
            .unwrap();
        let mut wrong_group = valid.clone();
        wrong_group.user_id = "other-user".into();
        let mut no_id = valid.clone();
        no_id.event_id.clear();
        let path = journal.file(&codex_turn_journal_group_key(&valid));
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap();
        file.write_all(
            format!(
                "bad json\n{}\n{}\n{}\n",
                serde_json::to_string(&wrong_group).unwrap(),
                serde_json::to_string(&no_id).unwrap(),
                serde_json::to_string(&foreign).unwrap()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        file.flush().await.unwrap();
        drop(file);
        // The source uses a valid foreign record here, so accepting arbitrary
        // filenames must fail even when their JSON and Codex fields are valid.
        let unrelated = entry("foreign", "turn");
        tokio::fs::write(
            root.path().join("unrelated.jsonl"),
            format!("{}\n", serde_json::to_string(&unrelated).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(read(&journal, None).await, vec![vec![valid]]);
        assert!(read(&journal, Some("../unrelated")).await.is_empty());
    }

    #[tokio::test]
    async fn private_acknowledgements_suppress_restart_and_cannot_be_undone_by_generic_removal() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let mut record = entry("exported", "turn");
        record.input_messages = Some(
            json!([{"role":"user","parts":[{"type":"text","content":"body-must-not-enter-ack"}]}]),
        );
        journal.append(std::slice::from_ref(&record)).await.unwrap();
        assert!(!journal.is_acknowledged(&record).await.unwrap());
        journal
            .acknowledge(std::slice::from_ref(&record))
            .await
            .unwrap();
        let key = codex_turn_journal_group_key(&record);
        let ack = tokio::fs::read(journal.done_file(&key)).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&ack).unwrap(),
            json!({"version":1,"key":key})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(journal.done_file(&key))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let restarted = Arc::new(CodexTurnJournal::new(root.path()));
        assert!(restarted.is_acknowledged(&record).await.unwrap());
        restarted
            .append(std::slice::from_ref(&record))
            .await
            .unwrap();
        restarted
            .remove_entries(std::slice::from_ref(&record))
            .await
            .unwrap();
        assert!(restarted.is_acknowledged(&record).await.unwrap());
        assert!(read(&restarted, None).await.is_empty());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn ack_before_crash_hides_residual_content_and_removal_without_ack_allows_replay() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let record = entry("exported", "turn");
        journal.append(std::slice::from_ref(&record)).await.unwrap();
        let key = codex_turn_journal_group_key(&record);
        tokio::fs::write(
            journal.done_file(&key),
            serde_json::to_vec(&json!({"version":1,"key":key})).unwrap(),
        )
        .await
        .unwrap();
        let restarted = Arc::new(CodexTurnJournal::new(root.path()));
        assert!(read(&restarted, None).await.is_empty());
        let before = tokio::fs::read(journal.file(&key)).await.unwrap();
        restarted
            .append(&[entry("source-replay", "turn")])
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(journal.file(&key)).await.unwrap(), before);
        let other = entry("other", "other-turn");
        restarted
            .append(std::slice::from_ref(&other))
            .await
            .unwrap();
        restarted
            .remove_key(&codex_turn_journal_group_key(&other))
            .await
            .unwrap();
        restarted.remove_key("../unrelated").await.unwrap();
        restarted
            .append(std::slice::from_ref(&other))
            .await
            .unwrap();
        assert_eq!(read(&restarted, None).await, vec![vec![other]]);
    }

    #[tokio::test]
    async fn failed_append_does_not_poison_serial_queue() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("journal");
        std::fs::write(&blocked, "not a directory").unwrap();
        let journal = Arc::new(CodexTurnJournal::new(&blocked));
        assert!(journal.append(&[entry("failed", "turn")]).await.is_err());
        std::fs::remove_file(&blocked).unwrap();
        let record = entry("recovered", "turn");
        journal.append(std::slice::from_ref(&record)).await.unwrap();
        assert_eq!(read(&journal, None).await, vec![vec![record]]);
    }

    #[tokio::test]
    async fn ack_cap_removes_residual_before_forgetting_proof_and_preserves_ack_on_cleanup_failure()
    {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let root = tempfile::tempdir().unwrap();
            // main #565: three existing ACKs plus the fourth acknowledgement
            // exercise the original eviction policy without 10,000 real files.
            let limit = 3;
            let crashed = entry("crashed", "old-turn");
            let oldest = codex_turn_journal_group_key(&crashed);
            for key in
                std::iter::once(oldest.clone()).chain((0..limit - 1).map(|i| format!("{i:064x}")))
            {
                tokio::fs::write(
                    root.path().join(format!("codex-done-{key}.json")),
                    serde_json::to_vec(&json!({"version":1,"key":key})).unwrap(),
                )
                .await
                .unwrap();
            }
            let oldest_file = root.path().join(format!("codex-done-{oldest}.json"));
            std::fs::OpenOptions::new()
                .write(true)
                .open(&oldest_file)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH)
                .unwrap();
            let journal = Arc::new(
                CodexTurnJournal::with_acknowledgement_limit(root.path(), limit as f64).unwrap(),
            );
            tokio::fs::write(
                journal.file(&oldest),
                format!("{}\n", serde_json::to_string(&crashed).unwrap()),
            )
            .await
            .unwrap();
            let latest = entry("latest", "latest-turn");
            journal
                .acknowledge(std::slice::from_ref(&latest))
                .await
                .unwrap();
            assert!(!oldest_file.exists() && !journal.file(&oldest).exists());
            let reloaded = Arc::new(
                CodexTurnJournal::with_acknowledgement_limit(root.path(), limit as f64).unwrap(),
            );
            assert!(read(&reloaded, None).await.is_empty());
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), limit);
            let blocked_key = format!("{0:064x}", 0);
            let blocked_ack = journal.done_file(&blocked_key);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&blocked_ack)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH)
                .unwrap();
            tokio::fs::create_dir(journal.file(&blocked_key))
                .await
                .unwrap();
            let restarted = Arc::new(
                CodexTurnJournal::with_acknowledgement_limit(root.path(), limit as f64).unwrap(),
            );
            assert!(restarted
                .acknowledge(&[entry("next", "next-turn")])
                .await
                .is_err());
            assert!(blocked_ack.exists());
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &tokio::fs::read(blocked_ack).await.unwrap()
                )
                .unwrap(),
                json!({"version":1,"key":blocked_key})
            );
            assert!(restarted.is_acknowledged(&latest).await.unwrap());
        })
        .await
        .expect("source15s ACK retention budget");
    }
    fn assert_main565_invalid_limit(limit: f64) {
        let error = CodexTurnJournal::with_acknowledgement_limit("unused", limit)
            .err()
            .expect("original invalid limit must be rejected");
        assert_eq!(
            error.to_string(),
            "acknowledgementLimit must be a positive safe integer"
        );
    }

    #[test]
    fn main565_rejects_zero_acknowledgement_limit() {
        assert_main565_invalid_limit(0.0);
    }

    #[test]
    fn main565_rejects_negative_acknowledgement_limit() {
        assert_main565_invalid_limit(-1.0);
    }

    #[test]
    fn main565_rejects_fractional_acknowledgement_limit() {
        assert_main565_invalid_limit(1.5);
    }

    #[test]
    fn main565_rejects_infinite_acknowledgement_limit() {
        assert_main565_invalid_limit(f64::INFINITY);
    }

    #[tokio::test]
    async fn native_input_multi_flusher_holds_shared_checkpoint_until_prefix_is_on_disk() {
        use crate::checkpoints::StateStore;
        use crate::core::{InputManager, LiveInput};
        use crate::flushers::{
            BaseFlusher, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter,
        };
        use crate::inputs::codex_transcript::{CodexTranscriptInput, CodexTranscriptInputOptions};
        use crate::types::JsonlFlusherConfig;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;
        struct Capture(Arc<AtomicUsize>);
        #[async_trait::async_trait]
        impl TraceExporter for Capture {
            async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
                self.0.fetch_add(spans.len(), Ordering::SeqCst);
                Ok(())
            }
            async fn shutdown(&self) {}
        }
        async fn within<T>(stage: &str, future: impl std::future::Future<Output = T>) -> T {
            tokio::time::timeout(Duration::from_secs(4), future)
                .await
                .unwrap_or_else(|_| panic!("native checkpoint chain did not settle at {stage}"))
        }
        for delegated in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let session_dir = root.path().join("sessions");
            tokio::fs::create_dir(&session_dir).await.unwrap();
            let rollout = session_dir.join("rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
            // Keep an actual empty live source in the initial directory scan.
            // Later bytes must exercise journal acceptance, not race the OS's
            // directory-mtime publication for a newly created file.
            tokio::fs::write(&rollout, "").await.unwrap();
            let key = format!("codex-transcript:{}", rollout.to_string_lossy());
            let state_path = root.path().join("state.json");
            let state = Arc::new(StateStore::new(&state_path));
            state.set_offset(&key, 0.0);
            state.set_offset("unrelated-input", 0.0);
            state.save().await.unwrap();
            let manager = Arc::new(InputManager::new());
            manager.set_state_store(Arc::clone(&state));
            manager.set_user_id("synthetic-user");
            let journal = Arc::new(CodexTurnJournal::new(root.path().join("journal")));
            let exports = Arc::new(AtomicUsize::new(0));
            let capture = Arc::new(Capture(Arc::clone(&exports)));
            let weak = Arc::downgrade(&manager);
            let trace=Arc::new(OtlpTraceFlusher::with_parts(
            serde_json::from_value(json!({"enabled":true,"protocol":"http/protobuf","serviceName":"checkpoint-fixture",
                "endpoints":[{"name":"capture","endpoint":"http://127.0.0.1:4318","compression":"none"}],
                "dataDir":root.path(),"turnIdleTimeoutMs":0})).unwrap(),None,
            Some(Arc::new(move |_|Arc::clone(&capture) as Arc<dyn TraceExporter>)),None
        ).unwrap().with_codex_journal(Arc::clone(&journal),move |entries|Ok(weak.upgrade().unwrap().prepare_restored_entries(entries))));
            let jsonl = Arc::new(JsonlFlusher::new(JsonlFlusherConfig {
                enabled: true,
                output_dir: root.path().join("output").to_string_lossy().into_owned(),
                rotate_daily: false,
                max_file_size_mb: 100.into(),
            }));
            jsonl.start().await.unwrap();
            // Restore must finish before taking the journal lock; otherwise this
            // would test startup restoration instead of new source acceptance.
            within("trace startup", trace.start()).await.unwrap();
            manager.set_flusher(Arc::new(MultiFlusher::new(vec![
                jsonl.clone(),
                trace.clone(),
            ])));
            let input = Arc::new(CodexTranscriptInput::new(CodexTranscriptInputOptions {
                state_store: Arc::clone(&state),
                session_dir: Some(session_dir.to_string_lossy().into_owned()),
                wakeup_dir: Some(root.path().join("wakeups").to_string_lossy().into_owned()),
                span_context_dir: Some(
                    root.path()
                        .join("span-contexts")
                        .to_string_lossy()
                        .into_owned(),
                ),
                poll_interval_ms: Some(60000),
                multimodal: None,
            }));
            let (running, start, stop) =
                (Arc::clone(&input), Arc::clone(&input), Arc::clone(&input));
            manager.register_input(LiveInput::new(
                "codex-transcript",
                "codex",
                "session-file-polling",
                move || running.collector_running(),
                move || {
                    let input = Arc::clone(&start);
                    Box::pin(async move { input.start().await })
                },
                move || {
                    let input = Arc::clone(&stop);
                    Box::pin(async move {
                        input.stop().await.unwrap();
                    })
                },
            ));
            let weak = Arc::downgrade(&manager);
            input.on_entries(move |entries| {
                if let Some(manager) = weak.upgrade() {
                    manager.bind_entries("codex-transcript", entries.to_vec());
                }
            });
            within("input startup", manager.start_input("codex-transcript")).await;
            // Startup is ready before its checkpoint IO; establish the empty
            // source metadata baseline before testing new-prefix acceptance.
            within("empty startup checkpoint", state.save())
                .await
                .unwrap();
            let before = tokio::fs::read(&state_path).await.unwrap();
            let held = journal.state.lock().await;
            let record = |time: &str, kind: &str, payload: serde_json::Value| {
                json!({"timestamp":time,"type":kind,"payload":payload}).to_string()
            };
            let prefix=[
            record("2026-08-07T02:00:00Z","session_meta",json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","thread_source":"user","model_provider":"openai"})),
            record("2026-08-07T02:00:01Z","turn_context",json!({"turn_id":"prefix","model":"gpt-test"})),
            record("2026-08-07T02:00:01.010Z","event_msg",json!({"type":"task_started","turn_id":"prefix"})),
            record("2026-08-07T02:00:01.020Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":"three waves"}]})),
            record("2026-08-07T02:00:04Z","event_msg",json!({"type":"agent_message","phase":"commentary","message":"first wave"})),
            record("2026-08-07T02:00:05Z","response_item",json!({"type":"function_call","call_id":"tool-one","name":"exec_command","arguments":r#"{"cmd":"pwd"}"#})),
            record("2026-08-07T02:00:06Z","response_item",json!({"type":"function_call_output","call_id":"tool-one","output":r#""/tmp/project""#})),
            record("2026-08-07T02:00:06Z","event_msg",json!({"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}})),
            record("2026-08-07T02:00:07Z","event_msg",json!({"type":"agent_message","phase":"commentary","message":"next wave"})),
        ].join("\n")+"\n";
            let expected_tool = if delegated { "spawn-a" } else { "tool-one" };
            let prefix = if delegated {
                [
                record("2026-08-07T02:00:00Z","session_meta",json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-08-07T02:00:00Z","thread_source":"user","model_provider":"openai"})),
                record("2026-08-07T02:00:01Z","turn_context",json!({"turn_id":"p1","model":"gpt-test"})),
                record("2026-08-07T02:00:01.010Z","event_msg",json!({"type":"task_started","turn_id":"p1"})),
                record("2026-08-07T02:00:01.020Z","response_item",json!({"type":"message","role":"user","content":[{"type":"input_text","text":"delegate"}]})),
                record("2026-08-07T02:00:02Z","response_item",json!({"type":"function_call","call_id":"spawn-a","name":"spawn_agent","arguments":r#"{"message":"child-a"}"#})),
                record("2026-08-07T02:00:02.010Z","response_item",json!({"type":"function_call_output","call_id":"spawn-a","output":r#"{"agent_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","nickname":"Fixture"}"#})),
                record("2026-08-07T02:00:03.010Z","event_msg",json!({"type":"token_count","info":{"last_token_usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"cached_input_tokens":0}}})),
            ].join("\n")+"\n"
            } else {
                prefix
            };
            tokio::fs::write(&rollout, prefix).await.unwrap();
            let cycling = Arc::clone(&input);
            let cycling_state = Arc::clone(&state);
            let cycling_key = key.clone();
            let mut cycle = tokio::spawn(async move {
                // A manual cycle may join the initial empty startup cycle.
                // Drive the source until this new rollout has actually been read.
                loop {
                    cycling.run_cycle().await;
                    if cycling_state.get(&cycling_key).last_offset().unwrap_or(0.0) > 0.0 {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            });
            within("source offset before journal acceptance", async {
                while state.get(&key).last_offset().unwrap_or(0.0) <= 0.0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await;
            assert!(!state.is_persisted(&key, None));
            state.set_offset("unrelated-input", 9.0);
            within("unrelated checkpoint save", state.save())
                .await
                .unwrap();
            let original: serde_json::Value = serde_json::from_slice(&before).unwrap();
            let pending: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
            assert_eq!(pending[key.as_str()], original[key.as_str()]);
            assert_eq!(pending["unrelated-input"]["lastOffset"], 9.0);
            let saving = Arc::clone(&state);
            let mut save = tokio::spawn(async move { saving.save_for("codex-transcript").await });
            assert!(
                tokio::time::timeout(Duration::from_millis(25), &mut save)
                    .await
                    .is_err(),
                "Codex checkpoint saved before journal acceptance"
            );
            assert!(!cycle.is_finished());
            assert_eq!(exports.load(Ordering::SeqCst), 0);
            if delegated {
                let fresh = Arc::new(CodexTurnJournal::new(root.path().join("journal")));
                assert!(
                    read(&fresh, None).await.is_empty(),
                    "fresh journal reader saw an unaccepted spawn prefix"
                );
            }
            // The in-memory journal mutex is real storage serialization. Releasing
            // it permits the real append/file flush, then acceptance, then save.
            drop(held);
            within("source acceptance after journal unlock", &mut cycle)
                .await
                .unwrap();
            within("shared checkpoint save", &mut save)
                .await
                .unwrap()
                .unwrap();
            let groups = read(&journal, None).await;
            let pending: Vec<_> = groups.into_iter().flatten().collect();
            assert!(pending
                .iter()
                .any(|entry| entry.tool_call_id.as_deref() == Some(expected_tool)));
            assert!(pending
                .iter()
                .any(|entry| entry.event_name == Some(crate::types::AgentEventName::LlmResponse)));
            assert!(pending.iter().all(|entry| entry.turn_end != Some(true)));
            assert!(!pending.is_empty());
            assert!(!journal.is_acknowledged(&pending[0]).await.unwrap());
            let disk: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
            assert!(disk[key.as_str()]["lastOffset"].as_f64().unwrap() > 0.0);
            assert_eq!(disk["unrelated-input"]["lastOffset"], 9.0);
            let native_file = journal.file(&codex_turn_journal_group_key(&pending[0]));
            assert!(tokio::fs::metadata(native_file).await.unwrap().len() > 0);
            within("input shutdown", manager.stop_all()).await;
            within("trace shutdown", trace.shutdown()).await.unwrap();
            jsonl.shutdown().await.unwrap();
            assert_eq!(
                exports.load(Ordering::SeqCst),
                0,
                "unfinished prefix was fabricated into a completed trace"
            );
        }
    }
}

#[cfg(test)]
#[path = "codex_turn_journal_main_tests.rs"]
mod main_tests;

#[cfg(test)]
#[path = "codex_turn_journal_stream_tests.rs"]
mod stream_tests;
