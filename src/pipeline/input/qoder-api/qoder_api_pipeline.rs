//! Qoder API poll loop: collect rows, enqueue, then advance the window.

use std::sync::Arc;

use crate::utils::create_logger;

use super::super::super::flusher::qoder_api::qoder_api_sls_sender::QoderApiSlsSender;
use super::super::super::sls_transport::{
    estimate_string_record_bytes, FailContext, RealSlsSink, SlsSink,
};
use super::super::super::types::{Pipeline, QoderApiPipelineOptions, WakeEvent};
use super::qoder_api_client::QoderApiClient;
use super::qoder_api_input::QoderApiInput;

const DEFAULT_INTERVAL_SECONDS: u64 = 300;
const DEFAULT_BACKFILL_DAYS: u64 = 7;
const DEFAULT_API_BASE: &str = "https://api.qoder.com";

pub struct QoderApiPipeline {
    opts: QoderApiPipelineOptions,
    input: std::sync::Mutex<Option<Arc<QoderApiInput>>>,
    sender: std::sync::Mutex<Option<Arc<QoderApiSlsSender>>>,
    running: std::sync::atomic::AtomicBool,
    polling: std::sync::atomic::AtomicBool,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl QoderApiPipeline {
    pub fn new(opts: QoderApiPipelineOptions) -> Self {
        Self {
            opts,
            input: std::sync::Mutex::new(None),
            sender: std::sync::Mutex::new(None),
            running: std::sync::atomic::AtomicBool::new(false),
            polling: std::sync::atomic::AtomicBool::new(false),
            task: std::sync::Mutex::new(None),
        }
    }

    async fn poll(self: &Arc<Self>) {
        if !self.running.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let fatal = self
            .input
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|input| input.has_fatal_auth_error());
        if fatal {
            create_logger(&format!(
                "QoderApiPipeline:{}",
                self.opts.config.config_name
            ))
            .warn("skipping cycle: fatal auth error previously detected", None);
            return;
        }
        if self.polling.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let input = self.input.lock().unwrap().clone();
        let rows = if let Some(input) = input {
            input.collect().await
        } else {
            Vec::new()
        };
        if !rows.is_empty() {
            let allowed = if let Some(policy) = &self.opts.workspace_policy {
                policy
                    .lock()
                    .unwrap()
                    .filter_string_rows(rows.clone(), "qoder-api")
            } else {
                rows.clone()
            };
            let accepted = allowed.is_empty()
                || self
                    .sender
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|sender| sender.enqueue(&allowed));
            if accepted {
                let input = self.input.lock().unwrap().clone();
                if let Some(input) = input {
                    input.confirm_cycle().await;
                }
            } else if let Some(flusher) = self.opts.config.flushers.first() {
                let context = FailContext {
                    mode: "webtracking".into(),
                    project: flusher.project.clone(),
                    logstore: flusher.logstore.clone(),
                    kind: self.opts.config.config_name.clone(),
                    batch_count: rows.len(),
                    batch_bytes: estimate_string_record_bytes(&rows),
                };
                if let Some(sink) = &self.opts.sink {
                    sink.persist_failed(
                        &self.opts.failed_log_dir,
                        &self.opts.config.config_name,
                        context,
                        "sender buffer full, window not advanced".into(),
                    )
                    .await;
                } else {
                    RealSlsSink
                        .persist_failed(
                            &self.opts.failed_log_dir,
                            &self.opts.config.config_name,
                            context,
                            "sender buffer full, window not advanced".into(),
                        )
                        .await;
                }
            }
        }
        self.polling
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl Pipeline for QoderApiPipeline {
    async fn start(&self) {}
    async fn stop(&self) {}
}

impl QoderApiPipeline {
    pub async fn start_handle(self: &Arc<Self>) -> Result<(), String> {
        if self.running.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let input = match self.opts.config.inputs.first() {
            Some(super::super::super::types::PipelineInputConfig::QoderApi(input)) => input,
            _ => return Err("QoderApiPipeline expects input_qoder_api".into()),
        };
        let flusher = self
            .opts
            .config
            .flushers
            .first()
            .ok_or_else(|| "missing flusher".to_string())?;
        let client = QoderApiClient::new(
            input.api_base.as_deref().unwrap_or(DEFAULT_API_BASE),
            &input.api_key,
            &input.org_id,
            None,
        )?;
        let interval = input.interval.unwrap_or(DEFAULT_INTERVAL_SECONDS);
        let backfill = input.backfill_days.unwrap_or(DEFAULT_BACKFILL_DAYS);
        *self.input.lock().unwrap() = Some(Arc::new(QoderApiInput::new(
            client,
            &input.org_id,
            &self.opts.config.config_name,
            &self.opts.state_dir,
            backfill,
        )));
        let sender = Arc::new(QoderApiSlsSender::new(
            flusher,
            &self.opts.config.config_name,
            &self.opts.failed_log_dir,
            &self.opts.data_dir,
            self.opts.sink.clone(),
        ));
        sender.start();
        *self.sender.lock().unwrap() = Some(sender);
        let this = Arc::clone(self);
        *self.task.lock().unwrap() = Some(tokio::spawn(async move {
            let mut interval_timer =
                tokio::time::interval(std::time::Duration::from_secs(interval.max(1)));
            interval_timer.tick().await;
            loop {
                interval_timer.tick().await;
                this.poll().await;
            }
        }));
        self.poll().await;
        Ok(())
    }

    pub async fn stop_handle(self: &Arc<Self>) {
        if !self
            .running
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        let sender = self.sender.lock().unwrap().clone();
        if let Some(sender) = sender {
            sender.shutdown().await;
        }
    }

    pub async fn handle_wake_handle(self: &Arc<Self>, _event: WakeEvent) {
        if self.running.load(std::sync::atomic::Ordering::SeqCst) {
            self.poll().await;
        }
    }
}
