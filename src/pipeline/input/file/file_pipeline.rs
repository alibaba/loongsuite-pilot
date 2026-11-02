//! File tail → SLS pipeline.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::utils::{create_logger, ensure_dir};
use serde_json::{json, Map, Value};

use super::super::super::flusher::file::file_sls_sender::FileSlsSender;
use super::super::super::types::{FileCheckpoint, FilePipelineOptions, Pipeline, WakeEvent};
use super::file_tailer::{glob_to_regex, FileTailer};
use super::file_watcher::{extract_parent_dirs, FileWatcher};

const DEFAULT_POLL_INTERVAL_MS: u64 = 1_000;
const RESCAN_INTERVAL_MS: i64 = 30_000;
const READ_TIME_SLICE_MS: i64 = 50;
const SIGNATURE_BYTES: u64 = 1024;

pub struct FilePipeline {
    opts: FilePipelineOptions,
    tailer: tokio::sync::Mutex<FileTailer>,
    sender: Arc<FileSlsSender>,
    watcher: FileWatcher,
    state_store: StateStore,
    state_file_path: String,
    running: std::sync::atomic::AtomicBool,
    polling: std::sync::atomic::AtomicBool,
    pending_lines: std::sync::Mutex<HashMap<String, Vec<String>>>,
    last_rescan: std::sync::Mutex<i64>,
    pattern_matchers: Vec<(String, regex::Regex)>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl FilePipeline {
    pub fn new(opts: FilePipelineOptions) -> Result<Self, String> {
        let input = opts
            .config
            .inputs
            .first()
            .ok_or_else(|| "FilePipeline expects input_file".to_string())?;
        let super::super::super::types::PipelineInputConfig::File(input) = input else {
            return Err(format!(
                "FilePipeline expects input_file, got {}",
                input.type_name()
            ));
        };
        let flusher = opts
            .config
            .flushers
            .first()
            .ok_or_else(|| "missing flusher".to_string())?;
        let sender = Arc::new(FileSlsSender::new(
            flusher,
            &opts.config.config_name,
            &opts.failed_log_dir,
            &opts.data_dir,
            opts.sink.clone(),
        ));
        let pattern_matchers = input
            .file_paths
            .iter()
            .map(|pattern| {
                let dir = Path::new(pattern)
                    .parent()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".into());
                let name = Path::new(pattern)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                (dir, glob_to_regex(name))
            })
            .collect();
        let state_file_path = Path::new(&opts.state_dir)
            .join(format!("{}.json", opts.config.config_name))
            .to_string_lossy()
            .to_string();
        let tailer = FileTailer::new_with_encoding(
            input.file_paths.clone(),
            input.max_dir_search_depth.unwrap_or(0),
            input.file_encoding.as_deref(),
        );
        Ok(Self {
            opts,
            tailer: tokio::sync::Mutex::new(tailer),
            sender,
            watcher: FileWatcher::new(),
            state_store: StateStore::new(&state_file_path),
            state_file_path,
            running: std::sync::atomic::AtomicBool::new(false),
            polling: std::sync::atomic::AtomicBool::new(false),
            pending_lines: std::sync::Mutex::new(HashMap::new()),
            last_rescan: std::sync::Mutex::new(0),
            pattern_matchers,
            task: std::sync::Mutex::new(None),
        })
    }

    fn matches(&self, file_path: &str) -> bool {
        let dir = Path::new(file_path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = Path::new(file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        self.pattern_matchers
            .iter()
            .any(|(pattern_dir, regex)| dir == *pattern_dir && regex.is_match(name))
    }

    async fn poll_cycle(self: &Arc<Self>) {
        if !self.running.load(std::sync::atomic::Ordering::SeqCst)
            || self.polling.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let mut files = HashSet::new();
        for file in self.watcher.dirty_files() {
            if self.matches(&file) {
                files.insert(file);
            }
        }
        for file in self.tailer.lock().await.active_files() {
            if self.matches(&file) {
                files.insert(file);
            }
        }
        let now = now_ms();
        if now - *self.last_rescan.lock().unwrap() >= RESCAN_INTERVAL_MS {
            *self.last_rescan.lock().unwrap() = now;
            for file in self.tailer.lock().await.discover_files() {
                files.insert(file);
            }
        }
        for file_path in files {
            if !self.running.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let pending = self.pending_lines.lock().unwrap().get(&file_path).cloned();
            if let Some(pending) = pending {
                if !self.sender.enqueue(&pending, &file_path) {
                    self.watcher.add_dirty(&file_path);
                    self.tailer.lock().await.check_rotation(&file_path).await;
                    continue;
                }
                self.pending_lines.lock().unwrap().remove(&file_path);
            }
            if self.sender.is_backpressured() {
                self.tailer.lock().await.check_rotation(&file_path).await;
                self.watcher.add_dirty(&file_path);
                continue;
            }
            let slice_start = now_ms();
            let mut has_more = true;
            while has_more && now_ms() - slice_start < READ_TIME_SLICE_MS {
                let mut result = self
                    .tailer
                    .lock()
                    .await
                    .read_new_lines(&file_path, None)
                    .await;
                has_more = result.has_more;
                self.apply_policy(&mut result.lines);
                if !result.lines.is_empty() && !self.sender.enqueue(&result.lines, &file_path) {
                    self.pending_lines
                        .lock()
                        .unwrap()
                        .insert(file_path.clone(), result.lines);
                    self.watcher.add_dirty(&file_path);
                    break;
                }
            }
            if has_more {
                self.watcher.add_dirty(&file_path);
            }
        }
        self.tailer.lock().await.cleanup_stale_readers();
        self.save_checkpoints().await;
        let _ = self.state_store.save().await;
        self.polling
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    fn apply_policy(&self, lines: &mut Vec<String>) {
        let Some(policy) = &self.opts.workspace_policy else {
            return;
        };
        let mut policy = policy.lock().unwrap();
        if !policy.enabled() {
            return;
        }
        let records: Vec<Option<Map<String, Value>>> = lines
            .iter()
            .map(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .and_then(|value| match value {
                        Value::Object(map) => Some(map),
                        _ => None,
                    })
            })
            .collect();
        let present: Vec<Map<String, Value>> =
            records.iter().filter_map(|record| record.clone()).collect();
        let agent = format!("file:{}", self.opts.config.config_name);
        policy.filter(&present, &agent);
        let agent = format!("file:{}", self.opts.config.config_name);
        let kept: Vec<String> = lines
            .iter()
            .enumerate()
            .filter(|(index, _)| {
                records[*index].is_none()
                    || policy.allows(records[*index].as_ref().unwrap(), &agent)
            })
            .map(|(_, line)| line.clone())
            .collect();
        *lines = kept;
    }

    async fn load_checkpoints(&self) {
        for key in self.state_store.keys() {
            let Some(file_path) = parse_checkpoint_key_or_legacy(&key) else {
                continue;
            };
            if !self.matches(&file_path) {
                continue;
            }
            let state = self.state_store.get(&key);
            let Some(offset) = state.last_offset() else {
                continue;
            };
            let Some(extra) = state.extra().and_then(|value| value.as_object().cloned()) else {
                continue;
            };
            if extra.get("inode").is_none() {
                continue;
            }
            let checkpoint = FileCheckpoint {
                offset: offset as u64,
                inode: json_u64(extra.get("inode")),
                dev: json_u64(extra.get("dev")),
                signature_hash: extra
                    .get("signatureHash")
                    .or_else(|| extra.get("signature"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                signature_size: json_u64(extra.get("signatureSize")).max(SIGNATURE_BYTES),
                last_update_time: json_u64(extra.get("lastUpdateTime")) as i64,
                cache: extra
                    .get("cache")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            };
            if checkpoint.last_update_time == 0 {
                // keep zero so tailer substitutes now only when the field was missing; a stored 0 is unlikely
            }
            self.tailer
                .lock()
                .await
                .init_reader_from_checkpoint(&file_path, &checkpoint)
                .await;
        }
    }

    async fn save_checkpoints(&self) {
        let checkpoints = self.tailer.lock().await.all_reader_checkpoints();
        let current: HashSet<String> = checkpoints.keys().cloned().collect();
        for (key, checkpoint) in checkpoints {
            self.state_store.update(
                &key,
                InputStatePatch {
                    last_offset: Some(checkpoint.offset as f64),
                    extra: Some(json!({
                        "inode": checkpoint.inode,
                        "dev": checkpoint.dev,
                        "signatureHash": checkpoint.signature_hash,
                        "signatureSize": checkpoint.signature_size,
                        "lastUpdateTime": checkpoint.last_update_time,
                        "cache": checkpoint.cache,
                    })),
                    ..InputStatePatch::default()
                },
            );
        }
        for key in self.state_store.keys() {
            if !current.contains(&key) {
                self.state_store.delete(&key);
            }
        }
    }
}

#[async_trait::async_trait]
impl Pipeline for FilePipeline {
    async fn start(&self) {
        // FilePipeline::start needs Arc. See `FilePipelineHandle`.
    }
    async fn stop(&self) {}
}

pub struct FilePipelineHandle {
    inner: Arc<FilePipeline>,
}

impl FilePipelineHandle {
    pub fn new(opts: FilePipelineOptions) -> Result<Self, String> {
        Ok(Self {
            inner: Arc::new(FilePipeline::new(opts)?),
        })
    }

    pub async fn start(&self) {
        if self
            .inner
            .running
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(parent) = Path::new(&self.inner.state_file_path).parent() {
            ensure_dir(&parent.to_string_lossy()).await;
        }
        self.inner.state_store.load().await;
        self.inner.load_checkpoints().await;
        let input = self.inner.opts.config.inputs.first();
        if let Some(super::super::super::types::PipelineInputConfig::File(input)) = input {
            self.inner
                .watcher
                .watch(&extract_parent_dirs(&input.file_paths));
        }
        self.inner.sender.start();
        self.inner.clone().poll_cycle().await;
        let this = Arc::clone(&self.inner);
        let task = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(DEFAULT_POLL_INTERVAL_MS));
            interval.tick().await;
            loop {
                interval.tick().await;
                this.clone().poll_cycle().await;
            }
        });
        *self.inner.task.lock().unwrap() = Some(task);
        create_logger(&format!(
            "FilePipeline:{}",
            self.inner.opts.config.config_name
        ))
        .info(
            "started",
            Some(&map_one("configName", &self.inner.opts.config.config_name)),
        );
    }

    pub async fn stop(&self) {
        if !self
            .inner
            .running
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(task) = self.inner.task.lock().unwrap().take() {
            task.abort();
        }
        self.inner.watcher.close();
        let pending = std::mem::take(&mut *self.inner.pending_lines.lock().unwrap());
        for (file_path, lines) in pending {
            self.inner.sender.enqueue(&lines, &file_path);
        }
        self.inner.sender.shutdown().await;
        self.inner.save_checkpoints().await;
        let _ = self.inner.state_store.save().await;
    }

    pub async fn handle_wake(&self, _event: WakeEvent) {
        if !self.inner.running.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        self.inner.tailer.lock().await.refresh_reader_timestamps();
        self.inner.watcher.rewatch();
        *self.inner.last_rescan.lock().unwrap() = 0;
        self.inner.save_checkpoints().await;
        let _ = self.inner.state_store.save().await;
        self.inner.clone().poll_cycle().await;
    }
}

pub fn parse_checkpoint_key(key: &str) -> Option<String> {
    parse_checkpoint_key_or_legacy(key)
}

pub fn parse_checkpoint_key_or_legacy(key: &str) -> Option<String> {
    let Some(last) = key.rfind('*') else {
        return Some(key.to_string());
    };
    let second = key[..last].rfind('*')?;
    Some(key[..second].to_string())
}

fn json_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|number| number as u64))
        })
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map_one(key: &str, value: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(key.into(), Value::String(value.into()));
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::sls_transport::RecordingSink;
    use crate::pipeline::types::{
        FileInputConfig, PipelineConfig, PipelineInputConfig, PipelineSlsFlusherConfig,
    };
    use crate::pipeline::workspace_policy::WorkspacePolicy;

    fn config(log_dir: &Path) -> PipelineConfig {
        PipelineConfig {
            config_name: "test-pipeline".into(),
            inputs: vec![PipelineInputConfig::File(FileInputConfig {
                file_paths: vec![log_dir.join("*.log").to_string_lossy().to_string()],
                file_encoding: Some("utf8".into()),
                max_dir_search_depth: Some(0),
                allowing_included_by_multi_configs: None,
            })],
            flushers: vec![PipelineSlsFlusherConfig {
                endpoint: "cn-hangzhou.log.aliyuncs.com".into(),
                project: "test-project".into(),
                logstore: "test-logstore".into(),
                region: None,
                aliuid: None,
                telemetry_type: None,
            }],
            raw: Value::Null,
        }
    }

    #[test]
    fn parses_checkpoint_keys() {
        assert_eq!(
            parse_checkpoint_key_or_legacy("/tmp/file_test/data.log*16777229*425807574").as_deref(),
            Some("/tmp/file_test/data.log")
        );
        assert_eq!(
            parse_checkpoint_key_or_legacy("/tmp/my app/data.log*1*2").as_deref(),
            Some("/tmp/my app/data.log")
        );
        assert_eq!(
            parse_checkpoint_key_or_legacy("/tmp/file_test/data.log").as_deref(),
            Some("/tmp/file_test/data.log")
        );
        assert!(parse_checkpoint_key_or_legacy("/tmp/data.log*123").is_none());
    }

    #[tokio::test]
    async fn collects_lines_and_persists_checkpoint_keys() {
        let root = std::env::temp_dir().join(format!("file-pipeline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let log_dir = root.join("logs");
        let state_dir = root.join("state");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "hello\nworld\n").unwrap();
        let sink = Arc::new(RecordingSink::default());
        let pipeline = FilePipelineHandle::new(FilePipelineOptions {
            workspace_policy: None,
            config: config(&log_dir),
            state_dir: state_dir.to_string_lossy().to_string(),
            failed_log_dir: root.join("failed").to_string_lossy().to_string(),
            data_dir: root.join("data").to_string_lossy().to_string(),
            sink: Some(sink.clone()),
        })
        .unwrap();
        pipeline.start().await;
        pipeline.stop().await;
        let posts = sink.posts.lock().unwrap();
        let contents: Vec<String> = posts
            .iter()
            .flat_map(|(_, logs, _)| logs.iter().filter_map(|row| row.get("content").cloned()))
            .collect();
        assert!(contents.iter().any(|line| line == "hello"), "{contents:?}");
        assert!(contents.iter().any(|line| line == "world"));
        drop(posts);
        let state_file = state_dir.join("test-pipeline.json");
        let state: Value =
            serde_json::from_str(&std::fs::read_to_string(&state_file).unwrap()).unwrap();
        let keys: Vec<&String> = state.as_object().unwrap().keys().collect();
        assert!(!keys.is_empty());
        for key in keys {
            let parts: Vec<&str> = key.split('*').collect();
            assert_eq!(parts.len(), 3);
            assert!(parts[0].ends_with("app.log"));
            assert!(parts[2].parse::<u64>().unwrap() > 0);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn filters_workspace_records() {
        let root =
            std::env::temp_dir().join(format!("file-pipeline-privacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let log_dir = root.join("logs");
        let state_dir = root.join("state");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(state_dir).unwrap();
        let log_file = log_dir.join("privacy.log");
        std::fs::write(&log_file, [
            serde_json::json!({"session_id": "blocked", "content": "early secret"}).to_string(),
            serde_json::json!({"session_id": "blocked", "cwd": "/private-project", "content": "secret"}).to_string(),
            serde_json::json!({"session_id": "unknown", "content": "allowed"}).to_string(),
            "plain unknown workspace".into(),
        ].join("\n") + "\n").unwrap();
        let policy = WorkspacePolicy::new(&["/private-project".into()], None).unwrap();
        let sink = Arc::new(RecordingSink::default());
        let pipeline = FilePipelineHandle::new(FilePipelineOptions {
            workspace_policy: Some(Arc::new(std::sync::Mutex::new(policy))),
            config: config(&log_dir),
            state_dir: root.join("state").to_string_lossy().to_string(),
            failed_log_dir: root.join("failed").to_string_lossy().to_string(),
            data_dir: root.join("data").to_string_lossy().to_string(),
            sink: Some(sink.clone()),
        })
        .unwrap();
        pipeline.start().await;
        pipeline.stop().await;
        let sent = format!("{:?}", sink.posts.lock().unwrap());
        assert!(sent.contains("allowed"));
        assert!(sent.contains("plain unknown workspace"));
        assert!(!sent.contains("secret"));
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
#[path = "file_pipeline_history_tests.rs"]
mod history_tests;
