//! Buffered webtracking sender for file pipelines.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::utils::{build_user_agent, create_logger, local_ip};
use serde_json::{json, Map, Value};

use super::super::super::sls_transport::{
    estimate_string_record_bytes, FailContext, PostOptions, RealSlsSink, SlsSink,
    SlsTransportConfig,
};
use super::super::super::types::PipelineSlsFlusherConfig;

const DEFAULT_FLUSH_INTERVAL_MS: u64 = 2_000;
const DEFAULT_BATCH_SIZE: usize = 4_000;
const MAX_BUFFER_SIZE: usize = 64_000;
const HIGH_WATERMARK: usize = 32_000;
const FLUSH_CONCURRENCY: usize = 8;
const SHUTDOWN_WAIT_TIMEOUT_MS: u64 = 30_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("FileSlsSender")
}

pub struct FileSlsSender {
    transport: SlsTransportConfig,
    failed_log_dir: String,
    config_name: String,
    buckets: std::sync::Mutex<HashMap<String, Vec<HashMap<String, String>>>>,
    flushing: AtomicBool,
    user_agent: String,
    sink: Arc<dyn SlsSink>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl FileSlsSender {
    pub fn new(
        flusher: &PipelineSlsFlusherConfig,
        config_name: &str,
        failed_log_dir: &str,
        data_dir: &str,
        sink: Option<Arc<dyn SlsSink>>,
    ) -> Self {
        let endpoint = if flusher.endpoint.starts_with("http://")
            || flusher.endpoint.starts_with("https://")
        {
            flusher.endpoint.clone()
        } else {
            format!("https://{}", flusher.endpoint)
        };
        Self {
            transport: SlsTransportConfig {
                endpoint,
                project: flusher.project.clone(),
                logstore: flusher.logstore.clone(),
            },
            failed_log_dir: failed_log_dir.to_string(),
            config_name: config_name.to_string(),
            buckets: std::sync::Mutex::new(HashMap::new()),
            flushing: AtomicBool::new(false),
            user_agent: build_user_agent(data_dir),
            sink: sink.unwrap_or_else(|| Arc::new(RealSlsSink)),
            task: std::sync::Mutex::new(None),
        }
    }

    pub fn start(self: &Arc<Self>) {
        if self.task.lock().unwrap().is_some() {
            return;
        }
        let this = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(DEFAULT_FLUSH_INTERVAL_MS));
            interval.tick().await;
            loop {
                interval.tick().await;
                this.flush().await;
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    pub fn enqueue(&self, lines: &[String], file_path: &str) -> bool {
        if self.buffer_size() >= MAX_BUFFER_SIZE {
            logger().warn(
                "buffer full, rejecting enqueue",
                Some(&meta(&[
                    ("configName", json!(self.config_name.clone())),
                    ("bufferSize", json!(self.buffer_size())),
                ])),
            );
            return false;
        }
        let mut buckets = self.buckets.lock().unwrap();
        let bucket = buckets.entry(file_path.to_string()).or_default();
        for line in lines {
            let mut row = HashMap::new();
            row.insert("content".into(), line.clone());
            bucket.push(row);
        }
        true
    }

    pub fn is_backpressured(&self) -> bool {
        self.buffer_size() >= HIGH_WATERMARK
    }

    pub async fn flush(&self) {
        if self.flushing.swap(true, Ordering::SeqCst) {
            return;
        }
        let files: Vec<String> = self.buckets.lock().unwrap().keys().cloned().collect();
        for file_path in files {
            let mut failed = false;
            while self.bucket_len(&file_path) > 0 && !failed {
                let bucket = self
                    .buckets
                    .lock()
                    .unwrap()
                    .get(&file_path)
                    .cloned()
                    .unwrap_or_default();
                let slice_end = bucket.len().min(DEFAULT_BATCH_SIZE * FLUSH_CONCURRENCY);
                let mut tasks = Vec::new();
                let mut offset = 0;
                while offset < slice_end {
                    let end = (offset + DEFAULT_BATCH_SIZE).min(slice_end);
                    tasks.push(bucket[offset..end].to_vec());
                    offset = end;
                }
                let mut results = Vec::new();
                for batch in &tasks {
                    let mut tags = HashMap::new();
                    tags.insert("__path__".into(), file_path.clone());
                    results.push(
                        self.sink
                            .post_webtracking(
                                &self.transport,
                                batch.clone(),
                                PostOptions {
                                    topic: self.config_name.clone(),
                                    source: local_ip().to_string(),
                                    tags,
                                    user_agent: self.user_agent.clone(),
                                },
                            )
                            .await,
                    );
                }
                let mut sent = 0usize;
                let mut has_failure = false;
                for (index, result) in results.into_iter().enumerate() {
                    if result.is_ok() {
                        sent += tasks[index].len();
                    } else {
                        has_failure = true;
                        let error = result.err().unwrap_or_else(|| "unknown".into());
                        logger().error(
                            "flush failed, persisting to failed log",
                            Some(&meta(&[
                                ("configName", json!(self.config_name.clone())),
                                ("filePath", json!(file_path.clone())),
                                ("count", json!(tasks[index].len())),
                                ("error", json!(error.clone())),
                            ])),
                        );
                        self.sink
                            .persist_failed(
                                &self.failed_log_dir,
                                &self.config_name,
                                FailContext {
                                    mode: "webtracking".into(),
                                    project: self.transport.project.clone(),
                                    logstore: self.transport.logstore.clone(),
                                    kind: self.config_name.clone(),
                                    batch_count: tasks[index].len(),
                                    batch_bytes: estimate_string_record_bytes(&tasks[index]),
                                },
                                error,
                            )
                            .await;
                    }
                }
                {
                    let mut buckets = self.buckets.lock().unwrap();
                    if let Some(bucket) = buckets.get_mut(&file_path) {
                        let drain = slice_end.min(bucket.len());
                        bucket.drain(0..drain);
                    }
                    if buckets
                        .get(&file_path)
                        .is_some_and(|bucket| bucket.is_empty())
                    {
                        buckets.remove(&file_path);
                    }
                }
                if has_failure {
                    failed = true;
                }
                if sent > 0 {
                    logger().debug(
                        "flush batch sent",
                        Some(&meta(&[
                            ("configName", json!(self.config_name.clone())),
                            ("count", json!(sent)),
                        ])),
                    );
                }
            }
        }
        self.flushing.store(false, Ordering::SeqCst);
    }

    pub async fn shutdown(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        let start = std::time::Instant::now();
        while self.flushing.load(Ordering::SeqCst)
            && start.elapsed().as_millis() < SHUTDOWN_WAIT_TIMEOUT_MS as u128
        {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        for _ in 0..3 {
            if self.buffer_size() == 0 {
                break;
            }
            self.flush().await;
        }
        if self.buffer_size() > 0 {
            let mut remaining = Vec::new();
            for bucket in self.buckets.lock().unwrap().values() {
                remaining.extend(bucket.clone());
            }
            self.buckets.lock().unwrap().clear();
            self.sink
                .persist_failed(
                    &self.failed_log_dir,
                    &self.config_name,
                    FailContext {
                        mode: "webtracking".into(),
                        project: self.transport.project.clone(),
                        logstore: self.transport.logstore.clone(),
                        kind: self.config_name.clone(),
                        batch_count: remaining.len(),
                        batch_bytes: estimate_string_record_bytes(&remaining),
                    },
                    "shutdown drain incomplete".into(),
                )
                .await;
        }
    }

    pub fn buffer_size(&self) -> usize {
        self.buckets
            .lock()
            .unwrap()
            .values()
            .map(|bucket| bucket.len())
            .sum()
    }

    fn bucket_len(&self, file_path: &str) -> usize {
        self.buckets
            .lock()
            .unwrap()
            .get(file_path)
            .map(|bucket| bucket.len())
            .unwrap_or(0)
    }
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::sls_transport::RecordingSink;
    use crate::pipeline::types::PipelineSlsFlusherConfig;

    fn sender(sink: Arc<RecordingSink>) -> (FileSlsSender, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let sender = FileSlsSender::new(
            &PipelineSlsFlusherConfig {
                endpoint: "cn-hangzhou.log.aliyuncs.com".into(),
                project: "test-project".into(),
                logstore: "test-logstore".into(),
                region: None,
                aliuid: None,
                telemetry_type: None,
            },
            "test-config",
            root.path().join("failed").to_str().unwrap(),
            root.path().join("data").to_str().unwrap(),
            Some(sink),
        );
        (sender, root)
    }

    #[tokio::test]
    async fn enqueue_flush_and_backpressure() {
        let sink = Arc::new(RecordingSink::default());
        let (sender, _root) = sender(Arc::clone(&sink));
        assert_eq!(sender.buffer_size(), 0);
        assert!(sender.enqueue(
            &["line1".into(), "line2".into(), "line3".into()],
            "/tmp/test.log"
        ));
        assert_eq!(sender.buffer_size(), 3);
        assert!(!sender.is_backpressured());
        sender.flush().await;
        let posts = sink.posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0.project, "test-project");
        assert_eq!(posts[0].0.logstore, "test-logstore");
        assert_eq!(posts[0].0.endpoint, "https://cn-hangzhou.log.aliyuncs.com");
        assert_eq!(posts[0].1.len(), 3);
        drop(posts);
    }

    #[tokio::test]
    async fn flush_posts_the_enqueued_lines() {
        let sink = Arc::new(RecordingSink::default());
        let (sender, _root) = sender(Arc::clone(&sink));
        sender.enqueue(&["line1".into(), "line2".into()], "/tmp/test.log");
        sender.flush().await;
        let posts = sink.posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(
            posts[0].1[0].get("content").map(String::as_str),
            Some("line1")
        );
        assert_eq!(
            posts[0].1[1].get("content").map(String::as_str),
            Some("line2")
        );
        assert_eq!(posts[0].2.topic, "test-config");
    }

    #[tokio::test]
    async fn empty_flush_and_failure_persist() {
        let sink = Arc::new(RecordingSink::default());
        let (sender, _root) = sender(Arc::clone(&sink));
        sender.flush().await;
        assert!(sink.posts.lock().unwrap().is_empty());
        *sink.fail_posts.lock().unwrap() = true;
        sender.enqueue(&["line1".into()], "/tmp/test.log");
        sender.flush().await;
        let persists = sink.persists.lock().unwrap();
        assert_eq!(persists.len(), 1);
        assert_eq!(persists[0].mode, "webtracking");
        assert_eq!(persists[0].project, "test-project");
        assert_eq!(persists[0].logstore, "test-logstore");
        assert_eq!(persists[0].kind, "test-config");
        assert_eq!(persists[0].batch_count, 1);
        assert!(persists[0].batch_bytes > 0);
    }

    #[tokio::test]
    async fn shutdown_flushes_remaining() {
        let sink = Arc::new(RecordingSink::default());
        let (sender, _root) = sender(Arc::clone(&sink));
        let sender = Arc::new(sender);
        sender.start();
        sender.enqueue(&["line1".into()], "/tmp/test.log");
        sender.shutdown().await;
        assert!(!sink.posts.lock().unwrap().is_empty());
        assert_eq!(sender.buffer_size(), 0);
    }

    #[test]
    fn buffer_size_counts_across_files() {
        let sink = Arc::new(RecordingSink::default());
        let (sender, _root) = sender(sink);
        assert_eq!(sender.buffer_size(), 0);
        sender.enqueue(&["a".into(), "b".into()], "/tmp/a.log");
        assert_eq!(sender.buffer_size(), 2);
        sender.enqueue(&["c".into()], "/tmp/b.log");
        assert_eq!(sender.buffer_size(), 3);
    }
    include!("file_sls_sender_history_tests.rs");
}
