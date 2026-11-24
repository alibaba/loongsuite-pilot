use super::budget::{DoubaoWorkBudget as Budget, DoubaoWorkError as Error, Result};
use super::chat_format::{self as format, MAX_RECORD};
use super::util::identifier;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const BLOCK: u64 = 32 * 1024;
const LIMIT: usize = 16 * 1024 * 1024;
const CONTENT_LIMIT: usize = 512 * 1024;
const DIRECTORY: &str = "chrome_doubao-chat_0.indexeddb.leveldb";

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Chat {
    pub local_id: String,
    pub send_id: String,
    pub receive_id: String,
    pub conversation: String,
    pub query_ms: i64,
    pub input: String,
    pub output: String,
    pub finished: bool,
    pub model_id: Option<String>,
}

#[derive(Default)]
struct Store {
    removed_at: Option<u64>,
    tasks: IndexMap<String, (u64, Option<Chat>)>,
}

#[derive(Default)]
struct Source {
    identity: String,
    offset: u64,
    witness: Vec<u8>,
    modified: Option<std::time::SystemTime>,
    partial: Vec<u8>,
    table: Vec<u8>,
    blocks: std::collections::VecDeque<(usize, usize)>,
    stores: BTreeMap<Vec<u8>, Store>,
    damaged: bool,
}

pub(super) struct ChatReader {
    root: PathBuf,
    sources: IndexMap<PathBuf, Source>,
}

impl ChatReader {
    pub(super) fn new(root: &str) -> Self {
        Self {
            root: root.into(),
            sources: IndexMap::new(),
        }
    }

    pub(super) fn clear(&mut self) {
        self.sources.clear();
    }

    pub(super) async fn find(
        &mut self,
        session: &str,
        budget: &mut Budget<'_>,
    ) -> Result<Option<Chat>> {
        let paths = chat_paths(&self.root)?;
        let present: HashSet<_> = paths.iter().collect();
        self.sources.retain(|path, _| present.contains(path));
        for path in &paths {
            let mut source = self.sources.shift_remove(path).unwrap_or_default();
            let available = LIMIT.saturating_sub(self.sources.values().map(Source::memory).sum());
            let result = source.scan(path, budget, session, available).await;
            self.sources.insert(path.clone(), source);
            if let Err(error) = result {
                if error.reason().is_some() || error.as_io().is_some() {
                    return Err(error);
                }
            }
        }
        let mut observations: BTreeMap<_, &(u64, Option<Chat>)> = BTreeMap::new();
        let mut deletions = BTreeMap::new();
        for (path, source) in &self.sources {
            let mut recovered = !source.damaged;
            for (key, store) in &source.stores {
                let identity = (path.parent().expect("database parent"), key.as_slice());
                if let Some(sequence) = store.removed_at {
                    deletions
                        .entry(identity)
                        .and_modify(|old: &mut u64| *old = (*old).max(sequence))
                        .or_insert(sequence);
                }
                let Some(task) = store.tasks.get(session) else {
                    continue;
                };
                recovered |= task.1.is_some();
                match observations.get(&identity) {
                    Some(previous) if task.0 < previous.0 => {}
                    Some(previous) if task.0 == previous.0 && task.1 != previous.1 => {
                        return Ok(None)
                    }
                    _ => {
                        observations.insert(identity, task);
                    }
                }
            }
            if !recovered {
                return Err(Error::invalid("Doubao chat source needs fresh evidence"));
            }
        }
        let mut result: Option<&Chat> = None;
        for (identity, (sequence, task)) in observations {
            if deletions
                .get(&identity)
                .is_some_and(|deleted| deleted >= sequence)
            {
                continue;
            }
            if let Some(task) = task {
                if result.is_some_and(|previous| previous != task) {
                    return Ok(None);
                }
                result = Some(task);
            }
        }
        Ok(result.cloned())
    }
}

fn chat_paths(root: &Path) -> Result<Vec<PathBuf>> {
    let metadata = match std::fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || crate::utils::runtime_paths::runtime_metadata(root).is_err() {
        return Err(Error::invalid("invalid Doubao chat profile root"));
    }
    let mut paths = Vec::new();
    let mut profiles = 0;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name != "Default" && !name.strip_prefix("Profile ").is_some_and(decimal) {
            continue;
        }
        if !entry.file_type()?.is_dir() {
            continue;
        }
        profiles += 1;
        if profiles > 16 {
            return Err(Error::invalid("Doubao chat profile capacity exceeded"));
        }
        let indexed = entry.path().join("IndexedDB");
        let directory = indexed.join(DIRECTORY);
        let mut missing = false;
        for dir in [entry.path(), indexed, directory.clone()] {
            match std::fs::symlink_metadata(&dir) {
                Ok(metadata) if metadata.is_dir() => {
                    if crate::utils::runtime_paths::runtime_metadata(&dir).is_err() {
                        return Err(Error::invalid("linked Doubao chat database directory"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                    break;
                }
                _ => return Err(Error::invalid("invalid Doubao chat database directory")),
            }
        }
        if missing {
            continue;
        }
        for source in std::fs::read_dir(directory)? {
            let source = source?;
            let name = source.file_name();
            let Some((number, extension)) = name.to_str().and_then(|name| name.rsplit_once('.'))
            else {
                continue;
            };
            if !decimal(number)
                || !matches!(extension, "ldb" | "log")
                || !source.file_type()?.is_file()
            {
                continue;
            }
            if paths.len() >= 32 {
                return Err(Error::invalid("Doubao chat file capacity exceeded"));
            }
            paths.push(source.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

impl Source {
    async fn scan(
        &mut self,
        path: &Path,
        budget: &mut Budget<'_>,
        wanted: &str,
        capacity: usize,
    ) -> Result<()> {
        let canonical = path.canonicalize()?;
        crate::utils::runtime_paths::runtime_metadata(path).map_err(std::io::Error::other)?;
        let standard = std::fs::File::open(&canonical)?;
        if crate::utils::file_identity::path_from_opened_file(&standard)?.canonicalize()?
            != canonical
        {
            return Err(Error::invalid("Doubao chat source changed during open"));
        }
        let before = crate::utils::file_identity::identity_from_open(&standard)?;
        let metadata = standard.metadata()?;
        let identity = before.checkpoint_key();
        let modified = metadata.modified().ok();
        let mut file = tokio::fs::File::from_std(standard);
        let table = path.extension().is_some_and(|ext| ext == "ldb");
        if self.identity != identity
            || before.size < self.offset
            || (table && self.modified != modified)
        {
            *self = Self {
                identity,
                modified,
                ..Self::default()
            };
        }
        if !self.witness.is_empty() && self.modified != modified {
            let mut witness = vec![0; self.witness.len()];
            let position = self.offset - witness.len() as u64;
            read_exact(budget, &mut file, &mut witness, position).await?;
            if witness != self.witness {
                let identity = std::mem::take(&mut self.identity);
                *self = Self {
                    identity,
                    ..Self::default()
                };
            }
        }
        if table {
            if before.size > MAX_RECORD as u64 || before.size as usize > capacity {
                return Err(Error::deferred("chat_cache_capacity"));
            }
            let result = self
                .scan_table(&mut file, before.size, budget, wanted, capacity)
                .await;
            if result.as_ref().is_err_and(|error| error.reason().is_none()) {
                self.damaged = true;
                self.stores.clear();
                self.table.clear();
                self.blocks.clear();
            }
            return result;
        }
        let result = self
            .scan_wal(&mut file, before.size, budget, wanted, capacity)
            .await;
        if self.offset > 0 && budget.remaining_bytes() >= 32 {
            let len = self.offset.min(32) as usize;
            let mut witness = vec![0; len];
            if budget
                .read(&mut file, &mut witness, len, self.offset - len as u64, true)
                .await
                .ok()
                == Some(len)
            {
                self.witness = witness;
                self.modified = modified;
            } else {
                self.witness.clear();
            }
        } else if self.witness.len() as u64 > self.offset {
            self.witness.clear();
        }
        result
    }

    async fn scan_table(
        &mut self,
        file: &mut tokio::fs::File,
        end: u64,
        budget: &mut Budget<'_>,
        wanted: &str,
        capacity: usize,
    ) -> Result<()> {
        while self.offset < end {
            let mut block = vec![0u8; (end - self.offset).min(64 * 1024) as usize];
            read_exact(budget, file, &mut block, self.offset).await?;
            self.offset += block.len() as u64;
            self.table.extend_from_slice(&block);
            if self.offset == end {
                self.blocks = format::table_index(&self.table)?.into();
            }
        }
        while let Some(handle) = self.blocks.front().copied() {
            if budget.exhausted() {
                return Err(Error::deferred("cycle_budget"));
            }
            format::table_records(&self.table, handle, |key, value, sequence| {
                consume(&mut self.stores, key, value, sequence, wanted)
            })?;
            self.blocks.pop_front();
            self.reduce(wanted, capacity);
            budget.record(1, 1);
            budget.yield_if_needed().await;
        }
        self.table = Vec::new();
        Ok(())
    }

    async fn scan_wal(
        &mut self,
        file: &mut tokio::fs::File,
        end: u64,
        budget: &mut Budget<'_>,
        wanted: &str,
        capacity: usize,
    ) -> Result<()> {
        while self.offset < end {
            let block_end = end.min(self.offset / BLOCK * BLOCK + BLOCK);
            let len = (block_end - self.offset) as usize;
            if len < 7 {
                if block_end.is_multiple_of(BLOCK) {
                    self.offset = block_end;
                    continue;
                }
                break;
            }
            let mut block = vec![0; len];
            let started = self.offset;
            read_exact(budget, file, &mut block, started).await?;
            let mut cursor = &block[..];
            while cursor.len() >= 7 && !budget.exhausted() {
                let size = u16::from_le_bytes([cursor[4], cursor[5]]) as usize;
                let kind = cursor[6];
                if kind == 0 && size == 0 {
                    self.offset = block_end;
                    break;
                }
                let Some((record, rest)) = cursor.split_at_checked(7 + size) else {
                    if !block_end.is_multiple_of(BLOCK) {
                        return Ok(());
                    }
                    self.offset = block_end;
                    self.invalidate_wal();
                    break;
                };
                cursor = rest;
                self.offset = started + (len - rest.len()) as u64;
                let crc = u32::from_le_bytes(record[..4].try_into().unwrap());
                if !format::checked_crc(crc, &[&record[6..]])
                    || !matches!(kind, 1..=4)
                    || (matches!(kind, 3 | 4) && self.partial.is_empty())
                    || self.partial.len().saturating_add(size) > MAX_RECORD.min(capacity)
                {
                    self.invalidate_wal();
                    continue;
                }
                if kind == 1 || kind == 2 {
                    self.partial.clear();
                }
                let payload = &record[7..];
                let result = if kind == 1 {
                    format::write_batch(payload, |key, value, sequence| {
                        consume(&mut self.stores, key, value, sequence, wanted)
                    })
                } else {
                    self.partial.extend_from_slice(payload);
                    if kind == 4 {
                        let batch = std::mem::take(&mut self.partial);
                        format::write_batch(&batch, |key, value, sequence| {
                            consume(&mut self.stores, key, value, sequence, wanted)
                        })
                    } else {
                        Ok(())
                    }
                };
                if result.is_err() {
                    self.invalidate_wal();
                }
                self.reduce(wanted, capacity);
                budget.record(1, 1);
                budget.yield_if_needed().await;
            }
            if self.offset == started && budget.exhausted() {
                return Err(Error::deferred("cycle_budget"));
            }
            if cursor.len() < 7 && block_end.is_multiple_of(BLOCK) {
                self.offset = block_end;
            }
        }
        Ok(())
    }

    fn invalidate_wal(&mut self) {
        self.damaged = true;
        self.partial = Vec::new();
        self.stores.clear();
    }

    fn memory(&self) -> usize {
        self.partial.len()
            + self.table.len()
            + self
                .stores
                .values()
                .map(|store| {
                    store
                        .tasks
                        .values()
                        .map(|(_, task)| {
                            512 + task
                                .as_ref()
                                .map_or(0, |task| task.input.len() + task.output.len())
                        })
                        .sum::<usize>()
                })
                .sum::<usize>()
    }

    fn reduce(&mut self, wanted: &str, capacity: usize) {
        while self.memory() > capacity {
            let Some(store) = self
                .stores
                .values_mut()
                .find(|store| store.tasks.keys().any(|id| id != wanted))
            else {
                break;
            };
            let idle = store.tasks.keys().find(|id| *id != wanted).cloned();
            if let Some(id) = idle {
                store.tasks.shift_remove(&id);
            }
        }
    }
}

async fn read_exact(
    budget: &mut Budget<'_>,
    file: &mut tokio::fs::File,
    bytes: &mut [u8],
    position: u64,
) -> Result<()> {
    let len = bytes.len();
    if budget.remaining_bytes() < len as u64 {
        return Err(Error::deferred("cycle_budget"));
    }
    if budget.read(file, bytes, len, position, false).await? != len {
        return Err(Error::deferred("source_refresh"));
    }
    Ok(())
}

fn is_task_key(key: &[u8]) -> bool {
    let Some(header) = key.first() else {
        return false;
    };
    let store = 2 + usize::from(header >> 5);
    let index = store + 1 + usize::from((header >> 2) & 7);
    let string = index + 1 + usize::from(header & 3);
    if key.len() <= string + 1
        || !key[1..store].iter().any(|byte| *byte != 0)
        || !key[store..index].iter().any(|byte| *byte != 0)
        || key[index] != 1
        || key[index + 1..string].iter().any(|byte| *byte != 0)
        || key[string] != 1
    {
        return false;
    }
    let mut tail = &key[string + 1..];
    let Ok(len) = format::varint(&mut tail) else {
        return false;
    };
    if len > 256 || len * 2 != tail.len() {
        return false;
    }
    let Ok(name) = String::from_utf16(
        &tail
            .as_chunks::<2>()
            .0
            .iter()
            .map(|unit| u16::from_be_bytes([unit[0], unit[1]]))
            .collect::<Vec<_>>(),
    ) else {
        return false;
    };
    name.strip_prefix("im-sdk:user:")
        .and_then(|name| name.strip_suffix(":default-chat-im-protocol-store"))
        .is_some_and(decimal)
}

fn consume(
    stores: &mut BTreeMap<Vec<u8>, Store>,
    key: &[u8],
    data: &[u8],
    seq: u64,
    wanted: &str,
) -> Result<()> {
    if !is_task_key(key) {
        return Ok(());
    }
    if stores.len() >= 128 && !stores.contains_key(key) {
        return Err(Error::invalid("Doubao chat task store limit"));
    }
    let store = stores.entry(key.to_vec()).or_default();
    let Some(values) = format::chat_values(data)? else {
        store.removed_at = Some(store.removed_at.map_or(seq, |old| old.max(seq)));
        store.tasks.retain(|_, (sequence, _)| *sequence > seq);
        return Ok(());
    };
    for (id, value) in values {
        if store.removed_at.is_some_and(|removed| removed >= seq)
            || store
                .tasks
                .get(&id)
                .is_some_and(|(previous, _)| *previous > seq)
        {
            continue;
        }
        let chat = project(&id, &value);
        if store
            .tasks
            .get(&id)
            .is_some_and(|(previous, value)| *previous == seq && *value != chat)
        {
            return Err(Error::invalid("conflicting Doubao chat sequence"));
        }
        store.tasks.insert(id, (seq, chat));
    }
    while store.tasks.len() > 128 {
        if let Some(key) = store
            .tasks
            .keys()
            .find(|key| key.as_str() != wanted)
            .cloned()
        {
            store.tasks.shift_remove(&key);
        } else {
            break;
        }
    }
    Ok(())
}

fn one_message(value: &Value) -> Option<&Value> {
    let object = value.as_object()?;
    (object.len() == 1)
        .then(|| object.values().next())
        .flatten()
}

fn text_blocks(value: &Value) -> Option<String> {
    let blocks = value.as_array()?;
    if blocks.is_empty() || blocks.len() > 128 {
        return None;
    }
    let mut output = String::new();
    for (index, block) in blocks.iter().enumerate() {
        if block["block_type"].as_u64() != Some(10_000) {
            return None;
        }
        let text = block.pointer("/content/text_block/text")?.as_str()?;
        if output
            .len()
            .saturating_add(text.len())
            .saturating_add(usize::from(index > 0))
            > CONTENT_LIMIT
        {
            return None;
        }
        if index > 0 {
            output.push('\n');
        }
        output.push_str(text);
    }
    Some(output)
}

fn project(session: &str, task: &Value) -> Option<Chat> {
    let options = task.pointer("/requestQuery/syncTask/option")?;
    let query_ms = options["create_time_ms"].as_i64()?;
    let sent = one_message(&task["sentMessages"])?;
    let received = one_message(&task["receivedMessages"])?;
    if options["agent_mode"].as_u64() != Some(2)
        || options
            .get("conversation_mode")
            .is_some_and(|mode| mode.as_u64() != Some(1))
        || [
            &task["sessionId"],
            &options["unique_key"],
            &sent["sessionId"],
            &received["sessionId"],
        ]
        .iter()
        .any(|id| id.as_str() != Some(session))
    {
        return None;
    }
    let a = &sent["extra"];
    let b = &received["extra"];
    let send_id = identifier(a.get("message_id"))?;
    let conversation = identifier(b.get("conversation_id"))?;
    if a["user_type"].as_u64() != Some(1)
        || b["user_type"].as_u64() != Some(2)
        || b["reply_id"].as_str() != Some(&send_id)
        || a["conversation_id"].as_str() != Some(&conversation)
    {
        return None;
    }
    let ext = &b["ext"];
    let blocks = &b["content_blocks_v2"];
    Some(Chat {
        local_id: identifier(sent.get("uniqueId"))?,
        send_id,
        receive_id: identifier(b.get("message_id"))?,
        conversation,
        query_ms,
        input: text_blocks(&a["content_blocks_v2"])?,
        output: text_blocks(blocks)?,
        finished: ext["is_finish"].as_str() == Some("1")
            && blocks
                .as_array()?
                .iter()
                .all(|block| block["is_finish"] == true),
        model_id: identifier(ext.get("model_id")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn joins_incremental_wal_and_compressed_table_and_honors_tombstones() {
        let home = tempfile::tempdir().unwrap();
        let level = home.path().join("Default/IndexedDB").join(DIRECTORY);
        std::fs::create_dir_all(&level).unwrap();
        let path = level.join("000001.log");
        let first = include_bytes!("chat-fixtures/partial.log.bin");
        let final_part = include_bytes!("chat-fixtures/finished.log.bin");
        std::fs::write(&path, first).unwrap();
        let mut reader = ChatReader::new(home.path().to_str().unwrap());
        let probe = async |reader: &mut ChatReader| {
            let mut budget = Budget::new(Default::default(), None);
            reader
                .find("synthetic-chat-turn", &mut budget)
                .await
                .unwrap()
        };
        assert!(!probe(&mut reader).await.unwrap().finished);
        let mut bytes = first.to_vec();
        bytes.extend_from_slice(&final_part[..final_part.len() - 5]);
        std::fs::write(&path, &bytes).unwrap();
        assert!(!probe(&mut reader).await.unwrap().finished);
        bytes.extend_from_slice(&final_part[final_part.len() - 5..]);
        std::fs::write(&path, &bytes).unwrap();
        let finished = probe(&mut reader).await.unwrap();
        assert!(finished.finished);
        assert_eq!(finished.input, "UTF-16 中文🚀");
        assert_eq!(finished.output, "FINAL OUTPUT");

        std::fs::write(
            level.join("000002.ldb"),
            include_bytes!("chat-fixtures/snapshot.ldb.bin"),
        )
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(probe(&mut reader).await.unwrap(), finished);
        let mut restarted = ChatReader::new(home.path().to_str().unwrap());
        assert_eq!(probe(&mut restarted).await.unwrap(), finished);
        std::fs::write(
            level.join("000003.log"),
            include_bytes!("chat-fixtures/deleted.log.bin"),
        )
        .unwrap();
        assert!(probe(&mut restarted).await.is_none());
    }
}
