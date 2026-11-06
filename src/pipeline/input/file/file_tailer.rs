//! Tail local files, including rename and copytruncate rotation.
//!
//! Port of `src/pipeline/input/file/file-tailer.ts`. Signatures are MD5 of the
//! first 1024 bytes. Offsets are byte offsets. Decoding follows FileEncoding.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::utils::create_logger;
use crate::utils::file_identity::identity_from_open;
use serde_json::{json, Map, Value};

#[path = "file_encoding.rs"]
mod encoding;
use encoding::FileEncoding;

use super::super::super::digest::md5_hex;
use super::super::super::types::{DevInode, FileCheckpoint, FileReaderState};

const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILES_PER_CYCLE: usize = 100;
const SIGNATURE_BYTES: usize = 1024;
const MAX_READER_QUEUE_LENGTH: usize = 20;
const READER_TIMEOUT_MS: i64 = 3_600_000;
const MAX_CACHE_BYTES: usize = 1024 * 1024;

fn logger() -> crate::utils::BoundLogger {
    create_logger("FileTailer")
}

#[derive(Clone, Debug)]
pub struct ReadResult {
    pub lines: Vec<String>,
    pub checkpoint: FileCheckpoint,
    pub has_more: bool,
}

pub struct FileTailer {
    file_paths: Vec<String>,
    max_dir_search_depth: u32,
    encoding: FileEncoding,
    reader_queues: HashMap<String, Vec<FileReaderState>>,
}

impl FileTailer {
    pub fn new(file_paths: Vec<String>, max_dir_search_depth: u32) -> Self {
        Self::new_with_encoding(file_paths, max_dir_search_depth, None)
    }

    pub fn new_with_encoding(
        file_paths: Vec<String>,
        max_dir_search_depth: u32,
        encoding: Option<&str>,
    ) -> Self {
        Self {
            file_paths,
            max_dir_search_depth,
            encoding: FileEncoding::parse(encoding),
            reader_queues: HashMap::new(),
        }
    }

    pub fn discover_files(&self) -> Vec<String> {
        let mut result = Vec::new();
        for pattern in &self.file_paths {
            result.extend(match_glob(pattern, self.max_dir_search_depth));
            if result.len() >= MAX_FILES_PER_CYCLE {
                break;
            }
        }
        result.truncate(MAX_FILES_PER_CYCLE);
        result
    }

    pub async fn init_reader_from_checkpoint(
        &mut self,
        file_path: &str,
        checkpoint: &FileCheckpoint,
    ) -> bool {
        let observed = match observe_file(Path::new(file_path)).await {
            Ok(observed) => observed,
            Err(_) => {
                logger().info(
                    "checkpoint file no longer exists, skipping",
                    Some(&meta_file(file_path)),
                );
                return false;
            }
        };
        let (dev, ino) = (observed.dev, observed.ino);
        if dev != checkpoint.dev || ino != checkpoint.inode {
            logger().info(
                "checkpoint dev/inode mismatch, skipping",
                Some(&meta_file(file_path)),
            );
            return false;
        }
        if !checkpoint.signature_hash.is_empty() {
            let Ok(current) = compute_file_signature(file_path, dev, ino) else {
                return false;
            };
            if !current.is_empty() && current != checkpoint.signature_hash {
                logger().info(
                    "inode reused (signature mismatch), discarding checkpoint",
                    Some(&meta_file(file_path)),
                );
                return false;
            }
        }
        let reader = FileReaderState {
            file_path: file_path.to_string(),
            dev_inode: DevInode {
                dev: checkpoint.dev,
                ino: checkpoint.inode,
            },
            offset: checkpoint.offset,
            signature_hash: checkpoint.signature_hash.clone(),
            last_update_time: if checkpoint.last_update_time == 0 {
                now_ms()
            } else {
                checkpoint.last_update_time
            },
            cache: checkpoint.cache.clone(),
            deleted: false,
            deleted_time: 0,
        };
        self.reader_queues
            .entry(file_path.to_string())
            .or_default()
            .push(reader);
        true
    }

    pub fn active_files(&self) -> Vec<String> {
        self.reader_queues.keys().cloned().collect()
    }

    pub fn checkpoints(&self) -> HashMap<String, FileCheckpoint> {
        let mut result = HashMap::new();
        for (file_path, queue) in &self.reader_queues {
            if let Some(latest) = queue.last() {
                result.insert(file_path.clone(), reader_to_checkpoint(latest));
            }
        }
        result
    }

    pub fn all_reader_checkpoints(&self) -> HashMap<String, FileCheckpoint> {
        let mut result = HashMap::new();
        for (file_path, queue) in &self.reader_queues {
            for reader in queue {
                let key = format!(
                    "{file_path}*{}*{}",
                    reader.dev_inode.dev, reader.dev_inode.ino
                );
                result.insert(key, reader_to_checkpoint(reader));
            }
        }
        result
    }

    pub async fn read_new_lines(
        &mut self,
        file_path: &str,
        checkpoint: Option<&FileCheckpoint>,
    ) -> ReadResult {
        if let Some(checkpoint) = checkpoint {
            if !self.reader_queues.contains_key(file_path) {
                self.init_reader_from_checkpoint(file_path, checkpoint)
                    .await;
            }
        }
        if self
            .reader_queues
            .get(file_path)
            .map(|queue| queue.is_empty())
            .unwrap_or(true)
        {
            let observed = match observe_file(Path::new(file_path)).await {
                Ok(observed) => observed,
                Err(_) => return empty_result(),
            };
            let (dev, ino) = (observed.dev, observed.ino);
            let reader = FileReaderState {
                file_path: file_path.to_string(),
                dev_inode: DevInode { dev, ino },
                offset: 0,
                signature_hash: match compute_file_signature(file_path, dev, ino) {
                    Ok(sig) => sig,
                    Err(_) => return empty_result(),
                },
                last_update_time: now_ms(),
                cache: String::new(),
                deleted: false,
                deleted_time: 0,
            };
            self.reader_queues
                .insert(file_path.to_string(), vec![reader]);
        }
        self.detect_rotation(file_path).await;
        self.process_queue(file_path).await
    }

    pub async fn check_rotation(&mut self, file_path: &str) {
        if self
            .reader_queues
            .get(file_path)
            .map(|queue| queue.is_empty())
            .unwrap_or(true)
        {
            return;
        }
        self.detect_rotation(file_path).await;
    }

    pub fn refresh_reader_timestamps(&mut self) {
        let now = now_ms();
        for queue in self.reader_queues.values_mut() {
            for reader in queue {
                reader.last_update_time = now;
                if reader.deleted {
                    reader.deleted_time = now;
                }
            }
        }
    }

    pub fn cleanup_stale_readers(&mut self) {
        let now = now_ms();
        let keys: Vec<String> = self.reader_queues.keys().cloned().collect();
        for key in keys {
            let Some(queue) = self.reader_queues.get_mut(&key) else {
                continue;
            };
            queue.retain(|reader| {
                if reader.deleted
                    && now - reader.deleted_time > READER_TIMEOUT_MS
                    && now - reader.last_update_time > READER_TIMEOUT_MS
                {
                    return false;
                }
                if !reader.deleted && now - reader.last_update_time > READER_TIMEOUT_MS {
                    return false;
                }
                true
            });
            if queue.is_empty() {
                self.reader_queues.remove(&key);
            }
        }
    }

    async fn detect_rotation(&mut self, file_path: &str) {
        let observed = match observe_file(Path::new(file_path)).await {
            Ok(observed) => observed,
            Err(_) => {
                if let Some(latest) = self
                    .reader_queues
                    .get_mut(file_path)
                    .and_then(|queue| queue.last_mut())
                {
                    if !latest.deleted {
                        latest.deleted = true;
                        latest.deleted_time = now_ms();
                    }
                }
                return;
            }
        };
        let (dev, ino) = (observed.dev, observed.ino);
        let size = observed.size;
        let latest = match self
            .reader_queues
            .get(file_path)
            .and_then(|queue| queue.last())
        {
            Some(reader) => reader.clone(),
            None => return,
        };
        if latest.dev_inode.ino != ino || latest.dev_inode.dev != dev {
            logger().info(
                "inode changed (rename rotation detected)",
                Some(&meta_file(file_path)),
            );
            let Ok(sig) = compute_file_signature(file_path, dev, ino) else {
                return;
            };
            if let Some(latest) = self
                .reader_queues
                .get_mut(file_path)
                .and_then(|queue| queue.last_mut())
            {
                latest.deleted = true;
                latest.deleted_time = now_ms();
            }
            let new_reader = FileReaderState {
                file_path: file_path.to_string(),
                dev_inode: DevInode { dev, ino },
                offset: 0,
                signature_hash: sig,
                last_update_time: now_ms(),
                cache: String::new(),
                deleted: false,
                deleted_time: 0,
            };
            if let Some(queue) = self.reader_queues.get_mut(file_path) {
                queue.push(new_reader);
                while queue.len() > MAX_READER_QUEUE_LENGTH {
                    let evicted = queue.remove(0);
                    logger().warn(
                        "reader queue overflow, evicting oldest reader",
                        Some(&map_pairs(&[
                            ("file", json!(file_path)),
                            ("evictedInode", json!(evicted.dev_inode.ino)),
                            ("evictedOffset", json!(evicted.offset)),
                        ])),
                    );
                }
            }
        } else if size < latest.offset {
            logger().info(
                "file truncated (copytruncate rotation)",
                Some(&meta_file(file_path)),
            );
            let Ok(sig) = compute_file_signature(file_path, dev, ino) else {
                return;
            };
            if let Some(latest) = self
                .reader_queues
                .get_mut(file_path)
                .and_then(|queue| queue.last_mut())
            {
                latest.offset = 0;
                latest.signature_hash = sig;
                latest.cache.clear();
                latest.last_update_time = now_ms();
            }
        }
    }

    async fn process_queue(&mut self, file_path: &str) -> ReadResult {
        loop {
            let Some(reader) = self
                .reader_queues
                .get(file_path)
                .and_then(|queue| queue.first())
                .cloned()
            else {
                self.reader_queues.remove(file_path);
                return empty_result();
            };
            let read_path = if reader.deleted {
                find_file_by_dev_inode(
                    Path::new(file_path).parent().unwrap_or(Path::new("")),
                    &reader.dev_inode,
                )
                .await
            } else {
                Some(reader.file_path.clone())
            };
            let Some(read_path) = read_path else {
                if reader.deleted && now_ms() - reader.deleted_time > READER_TIMEOUT_MS {
                    if let Some(queue) = self.reader_queues.get_mut(file_path) {
                        queue.remove(0);
                    }
                    continue;
                }
                break;
            };
            let (lines, has_more) = match read_from_reader(
                &read_path,
                file_path,
                &mut self.reader_queues,
                &self.encoding,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    logger().warn(
                        "file read deferred",
                        Some(&map_pairs(&[
                            ("file", json!(read_path)),
                            ("error", json!(error.to_string())),
                        ])),
                    );
                    return ReadResult {
                        lines: Vec::new(),
                        checkpoint: self
                            .reader_queues
                            .get(file_path)
                            .and_then(|queue| queue.last())
                            .map(reader_to_checkpoint)
                            .unwrap_or_else(|| reader_to_checkpoint(&reader)),
                        has_more: false,
                    };
                }
            };
            let updated_reader = self
                .reader_queues
                .get(file_path)
                .and_then(|queue| queue.first())
                .cloned()
                .unwrap_or(reader);
            let deleted = self
                .reader_queues
                .get(file_path)
                .and_then(|queue| queue.first())
                .map(|reader| reader.deleted)
                .unwrap_or(false);
            if lines.is_empty() && !has_more && deleted {
                if let Some(queue) = self.reader_queues.get_mut(file_path) {
                    queue.remove(0);
                }
                continue;
            }
            let removed_front = !has_more && deleted;
            if removed_front {
                if let Some(queue) = self.reader_queues.get_mut(file_path) {
                    queue.remove(0);
                }
            }
            let queue_len = self
                .reader_queues
                .get(file_path)
                .map(|queue| queue.len())
                .unwrap_or(0);
            let latest = self
                .reader_queues
                .get(file_path)
                .and_then(|queue| queue.last())
                .cloned()
                .unwrap_or(updated_reader);
            let has_unprocessed = if removed_front {
                queue_len > 0
            } else {
                queue_len > 1
            };
            return ReadResult {
                lines,
                checkpoint: reader_to_checkpoint(&latest),
                has_more: has_more || has_unprocessed,
            };
        }
        // The unavailable generation cannot be drained. Match the frozen
        // processQueue contract: clear it so the next poll can start the live file.
        self.reader_queues.remove(file_path);
        empty_result()
    }
}

async fn read_from_reader(
    read_path: &str,
    queue_key: &str,
    queues: &mut HashMap<String, Vec<FileReaderState>>,
    encoding: &FileEncoding,
) -> std::io::Result<(Vec<String>, bool)> {
    read_from_reader_with_open(read_path, queue_key, queues, encoding, |path| {
        std::fs::File::open(path)
    })
    .await
}

async fn read_from_reader_with_open(
    read_path: &str,
    queue_key: &str,
    queues: &mut HashMap<String, Vec<FileReaderState>>,
    encoding: &FileEncoding,
    open: impl FnOnce(&str) -> std::io::Result<std::fs::File>,
) -> std::io::Result<(Vec<String>, bool)> {
    // Identity, size and bytes all belong to this same open handle. A path
    // replacement after rotation detection must not advance the prior reader.
    let mut file = open(read_path)?;
    let identity = identity_from_open(&file)?;
    let Some(reader) = queues.get(queue_key).and_then(|queue| queue.first()) else {
        return Ok((Vec::new(), false));
    };
    if identity.dev != reader.dev_inode.dev || identity.ino != reader.dev_inode.ino {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file identity changed before read",
        ));
    }
    let reader_offset = reader.offset;
    let size = identity.size;
    if size <= reader_offset {
        return Ok((Vec::new(), false));
    }
    let read_size = (size - reader_offset).min(MAX_READ_BYTES) as usize;
    file.seek(SeekFrom::Start(reader_offset))?;
    let mut buf = vec![0u8; read_size];
    let read = file.read(&mut buf)?;
    buf.truncate(read);
    let text = encoding.decode(&buf)?;
    let Some(reader) = queues
        .get_mut(queue_key)
        .and_then(|queue| queue.first_mut())
    else {
        return Ok((Vec::new(), false));
    };
    let Some(last_newline) = text.rfind('\n') else {
        let new_cache = format!("{}{text}", reader.cache);
        if encoding.byte_length(&new_cache) > MAX_CACHE_BYTES {
            logger().warn("cache overflow, discarding", Some(&meta_file(read_path)));
            reader.cache.clear();
        } else {
            reader.cache = new_cache;
        }
        reader.offset += read as u64;
        reader.last_update_time = now_ms();
        return Ok((Vec::new(), size > reader.offset));
    };
    let complete = format!("{}{}", reader.cache, &text[..last_newline]);
    reader.cache = text[last_newline + 1..].to_string();
    let lines: Vec<String> = complete
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    reader.offset += read as u64;
    reader.last_update_time = now_ms();
    Ok((lines, size > reader.offset))
}

async fn find_file_by_dev_inode(dir: &Path, dev_inode: &DevInode) -> Option<String> {
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !entry
            .file_type()
            .await
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        if let Ok(observed) = observe_file(&path).await {
            let (dev, ino) = (observed.dev, observed.ino);
            if dev == dev_inode.dev && ino == dev_inode.ino {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn reader_to_checkpoint(reader: &FileReaderState) -> FileCheckpoint {
    FileCheckpoint {
        offset: reader.offset,
        inode: reader.dev_inode.ino,
        dev: reader.dev_inode.dev,
        signature_hash: reader.signature_hash.clone(),
        signature_size: SIGNATURE_BYTES as u64,
        last_update_time: reader.last_update_time,
        cache: reader.cache.clone(),
    }
}

fn empty_result() -> ReadResult {
    ReadResult {
        lines: Vec::new(),
        checkpoint: FileCheckpoint {
            offset: 0,
            inode: 0,
            dev: 0,
            signature_hash: String::new(),
            signature_size: SIGNATURE_BYTES as u64,
            last_update_time: now_ms(),
            cache: String::new(),
        },
        has_more: false,
    }
}

fn compute_file_signature(file_path: &str, dev: u64, ino: u64) -> std::io::Result<String> {
    let mut file = match std::fs::File::open(file_path) {
        Ok(file) => file,
        // Frozen source treats unavailable signatures as unknown, not a mismatch.
        Err(_) => return Ok(String::new()),
    };
    let identity = identity_from_open(&file)?;
    if identity.dev != dev || identity.ino != ino {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file identity changed before signature",
        ));
    }
    let mut buf = [0u8; SIGNATURE_BYTES];
    let read = file.read(&mut buf).unwrap_or(0);
    Ok(if read == 0 {
        String::new()
    } else {
        md5_hex(&buf[..read])
    })
}

fn match_glob(pattern: &str, max_depth: u32) -> Vec<String> {
    let path = Path::new(pattern);
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    if !dir.exists() {
        return Vec::new();
    }
    let file_pattern = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let regex = glob_to_regex(file_pattern);
    let mut results = Vec::new();
    collect_files(dir, &regex, 0, max_depth, &mut results);
    results.sort();
    results
}

fn collect_files(
    dir: &Path,
    regex: &regex::Regex,
    depth: u32,
    max_depth: u32,
    results: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if results.len() >= MAX_FILES_PER_CYCLE {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = entry.file_type().ok();
        if kind.as_ref().is_some_and(|kind| kind.is_file()) && regex.is_match(&name) {
            results.push(path.to_string_lossy().to_string());
        } else if kind.as_ref().is_some_and(|kind| kind.is_dir()) && depth < max_depth {
            collect_files(&path, regex, depth + 1, max_depth, results);
        }
    }
}

pub fn glob_to_regex(pattern: &str) -> regex::Regex {
    let mut escaped = String::new();
    for ch in pattern.chars() {
        if ".+^${}()|[]\\".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    let regex_str = escaped.replace('*', "[^/]*");
    regex::Regex::new(&format!("^{regex_str}$"))
        .unwrap_or_else(|_| regex::Regex::new("^$").unwrap())
}

struct FileObservation {
    dev: u64,
    ino: u64,
    size: u64,
}

async fn observe_file(path: &Path) -> std::io::Result<FileObservation> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = tokio::fs::metadata(path).await?;
        if !meta.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "not a file",
            ));
        }
        Ok(FileObservation {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.len(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)?;
        let identity = identity_from_open(&file)?;
        Ok(FileObservation {
            dev: identity.dev,
            ino: identity.ino,
            size: identity.size,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn meta_file(file: &str) -> Map<String, Value> {
    map_pairs(&[("file", json!(file))])
}

fn map_pairs(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[allow(dead_code)]
fn _path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("file-tailer-")
            .tempdir()
            .unwrap()
    }

    #[test]
    fn discovers_matching_files_and_respects_depth() {
        let temporary = temp_dir();
        let dir = temporary.path();
        std::fs::write(dir.join("app.log"), "data").unwrap();
        std::fs::write(dir.join("error.log"), "data").unwrap();
        std::fs::write(dir.join("readme.txt"), "data").unwrap();
        let tailer = FileTailer::new(vec![dir.join("*.log").to_string_lossy().to_string()], 0);
        let files = tailer.discover_files();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| file.ends_with(".log")));
        assert!(FileTailer::new(vec!["/nonexistent/dir/*.log".into()], 0)
            .discover_files()
            .is_empty());
        let sub = dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.log"), "data").unwrap();
        let files = tailer.discover_files();
        assert_eq!(files.len(), 2);
    }

    #[tokio::test]
    async fn reads_lines_checkpoints_and_rotations() {
        let temporary = temp_dir();
        let dir = temporary.path();
        let file = dir.join("test.log");
        std::fs::write(&file, "line1\nline2\nline3\n").unwrap();
        let path = file.to_string_lossy().to_string();
        let mut tailer = FileTailer::new(vec![path.clone()], 0);
        let first = tailer.read_new_lines(&path, None).await;
        assert_eq!(first.lines, vec!["line1", "line2", "line3"]);
        assert!(first.checkpoint.offset > 0);
        assert!(first.checkpoint.inode > 0);
        assert!(!first.has_more);

        std::fs::write(&file, "line1\nincomplete").unwrap();
        let mut tailer = FileTailer::new(vec![path.clone()], 0);
        let partial = tailer.read_new_lines(&path, None).await;
        assert_eq!(partial.lines, vec!["line1"]);
        std::fs::write(&file, "line1\nincomplete_now_done\nline3\n").unwrap();
        // Same inode, larger file. The previous read consumed "line1\n" and cached "incomplete".
        // Rewriting the whole file is a truncate if the new size is smaller than the offset, or a
        // continuation if larger. The vitest case rewrites with writeFileSync which truncates then
        // writes. Node keeps the same inode. Our reader offset is past "line1\nincomplete" only if
        // the second write is larger. Recreate the exact sequence on a fresh tailer:
        let mut tailer = FileTailer::new(vec![path.clone()], 0);
        std::fs::write(&file, "line1\nincomplete").unwrap();
        assert_eq!(
            tailer.read_new_lines(&path, None).await.lines,
            vec!["line1"]
        );
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        handle.write_all(b"_rest_of_line\nnext\n").unwrap();
        assert_eq!(
            tailer.read_new_lines(&path, None).await.lines,
            vec!["incomplete_rest_of_line", "next"]
        );

        let missing = FileTailer::new(vec![], 0)
            .read_new_lines("/nonexistent/file.log", None)
            .await;
        assert!(missing.lines.is_empty() && !missing.has_more);

        let app = dir.join("app.log");
        std::fs::write(&app, "old_line1\nold_line2\n").unwrap();
        let app_path = app.to_string_lossy().to_string();
        let mut tailer = FileTailer::new(vec![app_path.clone()], 0);
        let first = tailer.read_new_lines(&app_path, None).await;
        std::fs::write(&app, "new_line1\n").unwrap();
        let second = tailer.read_new_lines(&app_path, None).await;
        assert_eq!(second.lines, vec!["new_line1"]);
        assert!(second.checkpoint.offset < first.checkpoint.offset);

        std::fs::write(&app, "line1\nline2\n").unwrap();
        let mut tailer = FileTailer::new(vec![app_path.clone()], 0);
        let first = tailer.read_new_lines(&app_path, None).await;
        std::fs::rename(&app, dir.join("app.log.1")).unwrap();
        std::fs::write(&app, "new_line1\nnew_line2\n").unwrap();
        let second = tailer.read_new_lines(&app_path, None).await;
        assert_eq!(second.lines, vec!["new_line1", "new_line2"]);
        assert_ne!(second.checkpoint.inode, first.checkpoint.inode);

        let mut restored = FileTailer::new(vec![path.clone()], 0);
        std::fs::write(&file, "line1\nline2\nline3\n").unwrap();
        let mut source = FileTailer::new(vec![path.clone()], 0);
        let first = source.read_new_lines(&path, None).await;
        assert!(
            restored
                .init_reader_from_checkpoint(&path, &first.checkpoint)
                .await
        );
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        handle.write_all(b"line4\n").unwrap();
        assert_eq!(
            restored.read_new_lines(&path, None).await.lines,
            vec!["line4"]
        );
        assert!(
            !FileTailer::new(vec![], 0)
                .init_reader_from_checkpoint("/nonexistent/file.log", &first.checkpoint)
                .await
        );
    }
}

#[cfg(test)]
#[path = "file_tailer_history_tests.rs"]
mod history_tests;
