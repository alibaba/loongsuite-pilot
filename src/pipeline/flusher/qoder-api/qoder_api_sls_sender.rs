//! Single-buffer webtracking sender for the Qoder API pipeline.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::utils::{build_user_agent, create_logger};
use serde_json::json;

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

fn logger() -> crate::utils::BoundLogger {
    create_logger("QoderApiSlsSender")
}

pub struct QoderApiSlsSender {
    transport: SlsTransportConfig,
    config_name: String,
    failed_log_dir: String,
    user_agent: String,
    hostname: String,
    buffer: std::sync::Mutex<Vec<HashMap<String, String>>>,
    flushing: AtomicBool,
    sink: Arc<dyn SlsSink>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl QoderApiSlsSender {
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
        let hostname = hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| "unknown".into());
        Self {
            transport: SlsTransportConfig {
                endpoint,
                project: flusher.project.clone(),
                logstore: flusher.logstore.clone(),
            },
            config_name: config_name.to_string(),
            failed_log_dir: failed_log_dir.to_string(),
            user_agent: build_user_agent(data_dir),
            hostname,
            buffer: std::sync::Mutex::new(Vec::new()),
            flushing: AtomicBool::new(false),
            sink: sink.unwrap_or_else(|| Arc::new(RealSlsSink)),
            task: std::sync::Mutex::new(None),
        }
    }

    pub fn start(self: &Arc<Self>) {
        if self.task.lock().unwrap().is_some() {
            return;
        }
        let this = Arc::clone(self);
        *self.task.lock().unwrap() = Some(tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(DEFAULT_FLUSH_INTERVAL_MS));
            interval.tick().await;
            loop {
                interval.tick().await;
                this.flush().await;
            }
        }));
    }

    pub fn enqueue(&self, rows: &[HashMap<String, String>]) -> bool {
        if self.buffer_size() >= MAX_BUFFER_SIZE {
            logger().warn(
                "buffer full, rejecting enqueue",
                Some(&map(&[("configName", json!(self.config_name.clone()))])),
            );
            return false;
        }
        self.buffer.lock().unwrap().extend(rows.iter().cloned());
        true
    }

    pub fn is_backpressured(&self) -> bool {
        self.buffer_size() >= HIGH_WATERMARK
    }

    pub fn buffer_size(&self) -> usize {
        self.buffer.lock().unwrap().len()
    }

    pub async fn flush(&self) {
        if self.flushing.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.buffer.lock().unwrap().is_empty() {
            self.flushing.store(false, Ordering::SeqCst);
            return;
        }
        loop {
            let (tasks, slice_end) = {
                let buffer = self.buffer.lock().unwrap();
                if buffer.is_empty() {
                    break;
                }
                let slice_end = buffer.len().min(DEFAULT_BATCH_SIZE * FLUSH_CONCURRENCY);
                let mut tasks = Vec::new();
                let mut offset = 0;
                while offset < slice_end {
                    let end = (offset + DEFAULT_BATCH_SIZE).min(slice_end);
                    tasks.push(buffer[offset..end].to_vec());
                    offset = end;
                }
                (tasks, slice_end)
            };
            let mut has_failure = false;
            for batch in &tasks {
                let mut tags = HashMap::new();
                tags.insert("__hostname__".into(), self.hostname.clone());
                tags.insert("pipeline_type".into(), "qoder-api".into());
                match self
                    .sink
                    .post_webtracking(
                        &self.transport,
                        batch.clone(),
                        PostOptions {
                            topic: self.config_name.clone(),
                            source: self.hostname.clone(),
                            tags,
                            user_agent: self.user_agent.clone(),
                        },
                    )
                    .await
                {
                    Ok(()) => {}
                    Err(error) => {
                        has_failure = true;
                        self.sink
                            .persist_failed(
                                &self.failed_log_dir,
                                &self.config_name,
                                FailContext {
                                    mode: "webtracking".into(),
                                    project: self.transport.project.clone(),
                                    logstore: self.transport.logstore.clone(),
                                    kind: self.config_name.clone(),
                                    batch_count: batch.len(),
                                    batch_bytes: estimate_string_record_bytes(batch),
                                },
                                error,
                            )
                            .await;
                    }
                }
            }
            {
                let mut buffer = self.buffer.lock().unwrap();
                let drain = slice_end.min(buffer.len());
                buffer.drain(0..drain);
            }
            if has_failure {
                break;
            }
        }
        self.flushing.store(false, Ordering::SeqCst);
    }

    pub async fn shutdown(self: &Arc<Self>) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        for _ in 0..3 {
            if self.buffer_size() == 0 {
                break;
            }
            self.flush().await;
        }
    }
}

fn map(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}
