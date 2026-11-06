//! Durable pending Doubao request/execution facts and metadata-only acknowledgements.
//! This namespace is independent of the compatible Codex journal.
use crate::normalization::{entry_from_map, entry_to_object};
use crate::types::AgentActivityEntry;
use anyhow::{Context, Result};
use indexmap::{IndexMap, IndexSet};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

const MAX_ACKNOWLEDGED_TURNS: usize = 10_000;
/// A journal-level resource boundary, independent of per-poll/source budgets.
pub const DOUBAO_PENDING_GROUP_MAX_BYTES: usize = 64 * 1024 * 1024;
const ACK_MAX_BYTES: usize = 4096;

struct LimitedPayload(Vec<u8>);
impl std::io::Write for LimitedPayload {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > DOUBAO_PENDING_GROUP_MAX_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Doubao pending group exceeds 64 MiB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Preserve immutable facts and fill only missing/null/empty-string fields.
/// Live buffering and restart reconstruction intentionally use this same rule.
pub(crate) fn merge_facts(
    existing: &AgentActivityEntry,
    incoming: &AgentActivityEntry,
) -> AgentActivityEntry {
    let mut merged = entry_to_object(existing);
    for (key, value) in entry_to_object(incoming) {
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        if merged
            .get(&key)
            .is_none_or(|old| old.is_null() || old.as_str() == Some(""))
        {
            merged.insert(key, value);
        }
    }
    entry_from_map(merged)
}

async fn read_bounded(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    if file.metadata().await?.len() > limit as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Doubao journal file exceeds its byte limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Doubao journal grew beyond its byte limit",
        ));
    }
    Ok(bytes)
}

/// The same request/execution identities used by the native Doubao converter.
/// They deliberately do not use Codex user/session/turn grouping.
pub(crate) fn trace_identity(entry: &AgentActivityEntry) -> Option<String> {
    if entry.agent_type != "doubao-work"
        || entry
            .get("loongsuite.doubao_work.trace_role")
            .and_then(serde_json::Value::as_str)
            == Some("log_only")
    {
        return None;
    }
    if entry
        .get("loongsuite.doubao_work.observation_scope")
        .and_then(serde_json::Value::as_str)
        == Some("native_sandbox_execution")
    {
        if let Some(id) = entry
            .get("loongsuite.doubao_work.native_execution_id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            })
        {
            return Some(format!("doubao-local-execution:{id}"));
        }
    }
    entry
        .trace_id
        .as_deref()
        .filter(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(|trace| format!("doubao-request:{trace}"))
}

pub fn doubao_turn_journal_group_key(entry: &AgentActivityEntry) -> String {
    hex::encode(Sha256::digest(
        trace_identity(entry).unwrap_or_default().as_bytes(),
    ))
}

fn valid_entry(entry: &AgentActivityEntry) -> bool {
    !entry.event_id.is_empty() && trace_identity(entry).is_some()
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

pub struct DoubaoTurnJournal {
    dir: PathBuf,
    state: Mutex<JournalState>,
}

pub struct DoubaoJournalReplay {
    journal: Arc<DoubaoTurnJournal>,
    files: VecDeque<(String, PathBuf)>,
}

impl DoubaoTurnJournal {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            state: Mutex::new(JournalState::default()),
        }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("doubao-turn-{key}.jsonl"))
    }
    fn done_file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("doubao-done-{key}.json"))
    }

    async fn ensure_dir(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.dir).await?;
        let metadata = tokio::fs::symlink_metadata(&self.dir).await?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "Doubao journal directory is not a private ordinary directory"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700)).await?;
        }
        Ok(())
    }

    async fn load_acknowledgements(&self, state: &mut JournalState) -> Result<()> {
        match tokio::fs::symlink_metadata(&self.dir).await {
            Ok(metadata) => anyhow::ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "Doubao journal directory is not an ordinary directory"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
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
                    .strip_prefix("doubao-done-")
                    .and_then(|name| name.strip_suffix(".json"))
                    .filter(|key| valid_key(key))
                else {
                    continue;
                };
                if !entry.file_type().await?.is_file() {
                    continue;
                }
                let bytes = read_bounded(&entry.path(), ACK_MAX_BYTES).await?;
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
        anyhow::ensure!(
            entries.iter().all(valid_entry),
            "Doubao pending fact lacks a stable request/execution identity"
        );
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        let mut groups: IndexMap<String, Vec<&AgentActivityEntry>> = IndexMap::new();
        for entry in entries.iter().filter(|entry| valid_entry(entry)) {
            let key = doubao_turn_journal_group_key(entry);
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
        for (key, group) in groups {
            let file = self.file(&key);
            if let Ok(metadata) = tokio::fs::symlink_metadata(&file).await {
                anyhow::ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "Doubao pending file is not an ordinary file"
                );
            }
            if !state.initialized.contains(&key) {
                repair_tail(&file).await?;
                state.initialized.insert(key.clone());
            }
            let result = async {
                if let Ok(metadata) = tokio::fs::symlink_metadata(&file).await {
                    anyhow::ensure!(
                        metadata.is_file() && !metadata.file_type().is_symlink(),
                        "Doubao pending file is not an ordinary file"
                    );
                }
                let mut payload = LimitedPayload(Vec::new());
                for entry in group {
                    serde_json::to_writer(&mut payload, entry)?;
                    payload.write_all(b"\n")?;
                }
                let previous_size = match tokio::fs::metadata(&file).await {
                    Ok(metadata) => metadata.len(),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
                    Err(error) => return Err(error.into()),
                };
                anyhow::ensure!(
                    previous_size <= DOUBAO_PENDING_GROUP_MAX_BYTES as u64
                        && payload.0.len() as u64
                            <= DOUBAO_PENDING_GROUP_MAX_BYTES as u64 - previous_size,
                    "Doubao pending group exceeds 64 MiB; accepted pending facts retained"
                );
                let mut options = std::fs::OpenOptions::new();
                options.create(true).append(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
                }
                let mut handle = tokio::fs::OpenOptions::from(options).open(&file).await?;
                handle.write_all(&payload.0).await?;
                // Tokio File can buffer outstanding blocking writes; acceptance
                // requires their result, not merely a scheduled write.
                handle.flush().await?;
                handle.sync_data().await?;
                sync_directory(&self.dir).await?;
                private_file(&file).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if result.is_err() {
                state.initialized.remove(&key);
            }
            result.context("Doubao pending turn append failed")?;
        }
        Ok(())
    }

    pub async fn load(self: &Arc<Self>, key: Option<&str>) -> Result<DoubaoJournalReplay> {
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
                    .strip_prefix("doubao-turn-")
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
        Ok(DoubaoJournalReplay {
            journal: Arc::clone(self),
            files: files.into(),
        })
    }

    pub async fn is_acknowledged(&self, entry: &AgentActivityEntry) -> Result<bool> {
        if !valid_entry(entry) {
            return Ok(false);
        }
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        Ok(state
            .acknowledgements
            .as_ref()
            .expect("loaded")
            .contains_key(&doubao_turn_journal_group_key(entry)))
    }

    pub async fn acknowledge(&self, entries: &[AgentActivityEntry]) -> Result<()> {
        let mut state = self.state.lock().await;
        self.load_acknowledgements(&mut state).await?;
        let keys: IndexSet<_> = entries
            .iter()
            .filter(|entry| valid_entry(entry))
            .map(doubao_turn_journal_group_key)
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
                    .join(format!(".doubao-done-{}.tmp", uuid::Uuid::new_v4()));
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
                    file.sync_all().await?;
                    drop(file);
                    tokio::fs::rename(&temporary, self.done_file(&key)).await?;
                    sync_directory(&self.dir).await?;
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
            .filter(|entry| valid_entry(entry))
            .map(doubao_turn_journal_group_key)
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
            .saturating_sub(MAX_ACKNOWLEDGED_TURNS);
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

impl DoubaoJournalReplay {
    pub async fn next_group(&mut self) -> Result<Option<Vec<AgentActivityEntry>>> {
        let mut state = self.journal.state.lock().await;
        self.journal.load_acknowledgements(&mut state).await?;
        while let Some((key, file)) = self.files.pop_front() {
            if state
                .acknowledgements
                .as_ref()
                .expect("loaded")
                .contains_key(&key)
            {
                continue;
            }
            let bytes = match read_bounded(&file, DOUBAO_PENDING_GROUP_MAX_BYTES).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let complete = bytes
                .iter()
                .rposition(|b| *b == b'\n')
                .map_or(0, |index| index + 1);
            let text = String::from_utf8_lossy(&bytes[..complete]);
            let mut unique: IndexMap<String, AgentActivityEntry> = IndexMap::new();
            for line in text.lines() {
                let entry = serde_json::from_str::<AgentActivityEntry>(line)
                    .context("malformed complete Doubao pending fact")?;
                anyhow::ensure!(
                    valid_entry(&entry) && doubao_turn_journal_group_key(&entry) == key,
                    "Doubao pending fact does not match its request/execution"
                );
                if let Some(existing) = unique.get_mut(&entry.event_id) {
                    *existing = merge_facts(existing, &entry);
                } else {
                    unique.insert(entry.event_id.clone(), entry);
                }
            }
            if !unique.is_empty() {
                return Ok(Some(unique.into_values().collect()));
            }
        }
        Ok(None)
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
    let size = file.metadata().await?.len();
    anyhow::ensure!(
        size <= DOUBAO_PENDING_GROUP_MAX_BYTES as u64,
        "Doubao pending group exceeds 64 MiB; refusing tail repair"
    );
    if size == 0 {
        return Ok(());
    }
    file.seek(std::io::SeekFrom::End(-1)).await?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last).await?;
    if last[0] == b'\n' {
        return Ok(());
    }
    let mut end = size;
    let mut buffer = [0u8; 8192];
    while end > 0 {
        let start = end.saturating_sub(buffer.len() as u64);
        let length = (end - start) as usize;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        file.read_exact(&mut buffer[..length]).await?;
        if let Some(index) = buffer[..length].iter().rposition(|b| *b == b'\n') {
            file.set_len(start + index as u64 + 1).await?;
            return Ok(());
        }
        end = start;
    }
    file.set_len(0).await?;
    Ok(())
}

async fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        tokio::fs::File::open(path).await?.sync_all().await?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: &str) -> AgentActivityEntry {
        serde_json::from_value(json!({
            "event.name":"other","event.id":id,"user.id":"synthetic",
            "time_unix_nano":"1800000000000000000","gen_ai.agent.type":"doubao-work",
            "gen_ai.session.id":"same-session","gen_ai.turn.id":"same-turn",
            "trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "loongsuite.doubao_work.observation_scope":"client_message"
        }))
        .unwrap()
    }
    async fn pending(journal: &Arc<DoubaoTurnJournal>) -> Vec<Vec<AgentActivityEntry>> {
        let mut replay = journal.load(None).await.unwrap();
        let mut groups = vec![];
        while let Some(group) = replay.next_group().await.unwrap() {
            groups.push(group);
        }
        groups
    }

    #[tokio::test]
    async fn request_and_native_execution_use_independent_namespaces_without_touching_codex_files()
    {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(DoubaoTurnJournal::new(root.path()));
        let request = record("request");
        let mut native = request.clone();
        native.event_id = "native".into();
        native.extra.insert(
            "loongsuite.doubao_work.observation_scope".into(),
            json!("native_sandbox_execution"),
        );
        native.extra.insert(
            "loongsuite.doubao_work.native_execution_id".into(),
            json!("execution_1"),
        );
        assert_ne!(
            doubao_turn_journal_group_key(&request),
            doubao_turn_journal_group_key(&native)
        );
        let codex = root.path().join("codex-turn-existing.jsonl");
        tokio::fs::write(&codex, b"existing Codex journal bytes")
            .await
            .unwrap();
        journal
            .append(&[request.clone(), native.clone()])
            .await
            .unwrap();
        assert_eq!(pending(&journal).await.len(), 2);
        journal.acknowledge(&[request]).await.unwrap();
        let groups = pending(&journal).await;
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0][0].event_id, "native");
        assert_eq!(
            tokio::fs::read(&codex).await.unwrap(),
            b"existing Codex journal bytes"
        );
    }

    #[tokio::test]
    async fn fresh_journal_repairs_unaccepted_tail_and_deduplicates_replayed_event_ids() {
        let root = tempfile::tempdir().unwrap();
        let first = Arc::new(DoubaoTurnJournal::new(root.path()));
        let a = record("first");
        first.append(std::slice::from_ref(&a)).await.unwrap();
        let key = doubao_turn_journal_group_key(&a);
        let path = first.file(&key);
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap();
        file.write_all(b"{\"event.id\":\"unfinished").await.unwrap();
        file.flush().await.unwrap();
        drop(file);
        drop(first);
        let fresh = Arc::new(DoubaoTurnJournal::new(root.path()));
        fresh.append(&[a.clone(), record("second")]).await.unwrap();
        let groups = pending(&fresh).await;
        assert_eq!(groups.len(), 1);
        assert_eq!(
            groups[0]
                .iter()
                .map(|e| e.event_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        fresh.acknowledge(&groups[0]).await.unwrap();
        assert!(pending(&fresh).await.is_empty());
        let ack: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(fresh.done_file(&key)).await.unwrap()).unwrap();
        assert_eq!(ack, json!({"version":1,"key":key}));
        assert!(!path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(fresh.done_file(&key))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn invalid_identity_corrupt_complete_lines_and_failed_ack_cannot_fabricate_acceptance() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(DoubaoTurnJournal::new(root.path()));
        let mut invalid = record("invalid");
        invalid.trace_id = None;
        assert!(journal.append(&[invalid]).await.is_err());
        let valid = record("valid");
        journal.append(std::slice::from_ref(&valid)).await.unwrap();
        let key = doubao_turn_journal_group_key(&valid);
        tokio::fs::create_dir(journal.done_file(&key))
            .await
            .unwrap();
        assert!(journal
            .acknowledge(std::slice::from_ref(&valid))
            .await
            .is_err());
        assert!(journal.file(&key).is_file());
        tokio::fs::remove_dir(journal.done_file(&key))
            .await
            .unwrap();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(journal.file(&key))
            .await
            .unwrap();
        file.write_all(b"{broken complete record}\n").await.unwrap();
        file.flush().await.unwrap();
        drop(file);
        let mut replay = journal.load(None).await.unwrap();
        assert!(replay.next_group().await.is_err());
        assert!(!journal.is_acknowledged(&valid).await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_journal_directory_and_pending_file_do_not_modify_external_bytes() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        std::fs::create_dir(&external).unwrap();
        let linked = root.path().join("linked");
        symlink(&external, &linked).unwrap();
        let a = record("first");
        assert!(DoubaoTurnJournal::new(linked)
            .append(std::slice::from_ref(&a))
            .await
            .is_err());
        assert_eq!(std::fs::read_dir(&external).unwrap().count(), 0);
        let dir = root.path().join("ordinary");
        std::fs::create_dir(&dir).unwrap();
        let journal = DoubaoTurnJournal::new(&dir);
        let target = root.path().join("target");
        std::fs::write(
            &target,
            b"unchanged external bytes without a complete newline",
        )
        .unwrap();
        symlink(&target, journal.file(&doubao_turn_journal_group_key(&a))).unwrap();
        assert!(journal.append(&[a]).await.is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"unchanged external bytes without a complete newline"
        );
    }
}

#[cfg(test)]
mod bounded_tests {
    use super::*;
    use serde_json::json;
    fn record() -> AgentActivityEntry {
        serde_json::from_value(json!({
            "event.id":"bounded","event.name":"other","time_unix_nano":"1800000000000000000",
            "gen_ai.agent.type":"doubao-work","gen_ai.session.id":"synthetic",
            "trace_id":"cccccccccccccccccccccccccccccccc",
            "loongsuite.doubao_work.observation_scope":"client_message",
            "fixture.padding":""
        }))
        .unwrap()
    }
    #[tokio::test]
    async fn exact_group_byte_limit_is_readable_and_extra_append_preserves_the_accepted_group() {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(DoubaoTurnJournal::new(root.path().join("pending")));
        let mut row = record();
        let base = serde_json::to_vec(&row).unwrap().len() + 1;
        let padding = DOUBAO_PENDING_GROUP_MAX_BYTES - base;
        row.extra
            .insert("fixture.padding".into(), json!("x".repeat(padding)));
        journal.append(std::slice::from_ref(&row)).await.unwrap();
        let key = doubao_turn_journal_group_key(&row);
        let path = journal.file(&key);
        assert_eq!(
            tokio::fs::metadata(&path).await.unwrap().len(),
            DOUBAO_PENDING_GROUP_MAX_BYTES as u64
        );
        let mut small = record();
        small.event_id = "cannot-fit".into();
        assert!(journal.append(&[small]).await.is_err());
        assert_eq!(
            tokio::fs::metadata(&path).await.unwrap().len(),
            DOUBAO_PENDING_GROUP_MAX_BYTES as u64
        );
        let mut replay = journal.load(None).await.unwrap();
        let group = replay.next_group().await.unwrap().unwrap();
        assert_eq!(group.len(), 1);
        assert_eq!(
            group[0].extra["fixture.padding"].as_str().unwrap().len(),
            padding
        );
        assert!(!journal.is_acknowledged(&row).await.unwrap());
        let other = DoubaoTurnJournal::new(root.path().join("over-limit"));
        row.extra
            .insert("fixture.padding".into(), json!("x".repeat(padding + 1)));
        assert!(other.append(&[row]).await.is_err());
        assert!(!other.file(&key).exists());
    }
    #[tokio::test]
    async fn oversized_sparse_pending_file_and_ack_metadata_fail_before_unbounded_reads_or_tail_repair(
    ) {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(DoubaoTurnJournal::new(root.path().join("pending")));
        let row = record();
        journal.append(std::slice::from_ref(&row)).await.unwrap();
        let key = doubao_turn_journal_group_key(&row);
        let path = journal.file(&key);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(DOUBAO_PENDING_GROUP_MAX_BYTES as u64 + 1)
            .unwrap();
        let mut replay = journal.load(None).await.unwrap();
        assert!(replay.next_group().await.is_err());
        drop(journal);
        let fresh = Arc::new(DoubaoTurnJournal::new(path.parent().unwrap()));
        assert!(fresh.append(std::slice::from_ref(&row)).await.is_err());
        assert_eq!(
            std::fs::metadata(path).unwrap().len(),
            DOUBAO_PENDING_GROUP_MAX_BYTES as u64 + 1
        );
        let ack_root = root.path().join("ack");
        tokio::fs::create_dir(&ack_root).await.unwrap();
        let ack = ack_root.join(format!("doubao-done-{key}.json"));
        let mut bytes = serde_json::to_vec(&json!({"version":1,"key":key})).unwrap();
        bytes.resize(ACK_MAX_BYTES, b' ');
        tokio::fs::write(&ack, &bytes).await.unwrap();
        assert!(DoubaoTurnJournal::new(&ack_root)
            .is_acknowledged(&row)
            .await
            .unwrap());
        bytes.push(b' ');
        tokio::fs::write(&ack, &bytes).await.unwrap();
        assert!(DoubaoTurnJournal::new(&ack_root)
            .is_acknowledged(&row)
            .await
            .is_err());
    }
}
