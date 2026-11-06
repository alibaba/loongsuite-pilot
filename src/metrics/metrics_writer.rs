//! Periodic L1/L2 JSONL mirrors and alarm drains.
//!
//! `send_status`, `send_running_status`, and `send_alarm` go through
//! `crate::internal::sender`, which is a no-op unless the `proprietary` feature
//! is enabled.

use crate::internal::sender::{send_alarm, send_running_status, send_status};
use crate::metrics::alarm_manager::AlarmManager;
use crate::metrics::disk_usage_sampler::{
    DiskUsageSampler, DiskUsageSamplerOptions, DiskUsageSnapshot, DISK_USAGE_STALE_MS,
};
use crate::metrics::metrics_collector::{
    DataflowSnapshot, L1Metrics, MetricsCollector, MetricsCollectorOptions,
};
use crate::metrics::runtime_health::RuntimeProbe;
use crate::metrics::trace_runtime::TraceRuntimeSnapshot;
use crate::types::{AgentsConfig, SlsEndpoint};
use crate::utils::{
    append_line, create_logger, ensure_dir, flatten_to_strings, get_today_date_string,
    ProcessLivenessProbe,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DATAFLOW_INTERVAL: Duration = Duration::from_millis(600_000);
const ALARM_FLUSH_INTERVAL: Duration = Duration::from_millis(30_000);
const CPU_THRESHOLD_PERCENT: f64 = 80.0;
const CPU_ALARM_CONSECUTIVE_SAMPLES: u32 = 3;
const MEMORY_SOFT_THRESHOLD_MB: f64 = 512.0;
const MEMORY_HARD_THRESHOLD_MB: f64 = 1024.0;
const MEMORY_CRITICAL_THRESHOLD_MB: f64 = 2048.0;
const MEMORY_SOFT_ALARM_CONSECUTIVE_SAMPLES: u32 = 3;
const PROCESS_RESOURCE_ALARM_COOLDOWN_MS: i64 = 3_600_000;
const INFRA_ALARM_COOLDOWN_MS: i64 = 3_600_000;
const DISK_USAGE_SOFT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const DISK_USAGE_CRITICAL_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const DISK_USAGE_ALARM_COOLDOWN_MS: i64 = 3_600_000;

struct MemoryTier {
    name: &'static str,
    threshold_mb: f64,
    level: &'static str,
    rank: u8,
}

pub type TraceSnapshotProvider =
    Arc<dyn Fn() -> Result<Vec<TraceRuntimeSnapshot>, String> + Send + Sync>;

struct WriterInner {
    collector: MetricsCollector,
    alarm_manager: Option<AlarmManager>,
    user_id_alarm_emitted: bool,
    startup_alarm_emitted: bool,
    cpu_high_samples: u32,
    memory_high_samples: u32,
    memory_high_samples_tier: Option<&'static str>,
    last_memory_alarm: Option<(i64, u8)>,
    last_process_alarm_at: HashMap<String, i64>,
    last_infra_alarm_at: HashMap<String, i64>,
    disk_high_samples: u32,
    last_disk_sample_at: Option<i64>,
    last_disk_alarm_at: HashMap<String, i64>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
}

pub struct MetricsWriter {
    logs_dir: PathBuf,
    hook_spool: Arc<Mutex<super::HookMetricsSpool>>,
    cycle_gate: Arc<tokio::sync::Mutex<()>>,
    inner: Arc<Mutex<WriterInner>>,
    sampler: Arc<DiskUsageSampler>,
    get_snapshot: Arc<dyn Fn() -> Result<DataflowSnapshot, String> + Send + Sync>,
    get_trace: Option<TraceSnapshotProvider>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

pub struct MetricsWriterOptions {
    pub data_dir: String,
    pub version: String,
    pub user_id: String,
    pub canary_policy: String,
    pub get_snapshot: Arc<dyn Fn() -> Result<DataflowSnapshot, String> + Send + Sync>,
    pub get_trace_runtime_snapshot: Option<TraceSnapshotProvider>,
    pub alarm_manager: Option<AlarmManager>,
    pub agents_config: AgentsConfig,
    pub sls_endpoints: Vec<SlsEndpoint>,
    pub cms_workspace: String,
    pub auto_update_enabled: bool,
    pub updater_liveness: Option<ProcessLivenessProbe>,
    pub runtime_probe: Option<RuntimeProbe>,
    pub now_ms: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}

impl MetricsWriterOptions {
    pub fn new(
        data_dir: impl Into<String>,
        version: impl Into<String>,
        user_id: impl Into<String>,
        get_snapshot: impl Fn() -> DataflowSnapshot + Send + Sync + 'static,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            version: version.into(),
            user_id: user_id.into(),
            canary_policy: String::new(),
            get_snapshot: Arc::new(move || Ok(get_snapshot())),
            get_trace_runtime_snapshot: None,
            alarm_manager: None,
            agents_config: AgentsConfig::new(),
            sls_endpoints: Vec::new(),
            cms_workspace: String::new(),
            auto_update_enabled: true,
            updater_liveness: None,
            runtime_probe: None,
            now_ms: None,
        }
    }
}

impl MetricsWriter {
    pub fn new(opts: MetricsWriterOptions) -> Self {
        let now_ms = opts
            .now_ms
            .clone()
            .unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis()));
        let inner = Arc::new(Mutex::new(WriterInner {
            collector: MetricsCollector::from_options(MetricsCollectorOptions {
                version: opts.version,
                user_id: opts.user_id,
                data_dir: opts.data_dir.clone(),
                canary_policy: opts.canary_policy,
                sls_endpoints: opts.sls_endpoints,
                cms_workspace: opts.cms_workspace,
                auto_update_enabled: opts.auto_update_enabled,
                updater_liveness: opts.updater_liveness,
                now_ms: Some(Arc::clone(&now_ms)),
                cpu_usage: None,
                runtime_probe: opts.runtime_probe,
                agents_config: opts.agents_config,
            }),
            alarm_manager: opts.alarm_manager,
            user_id_alarm_emitted: false,
            startup_alarm_emitted: false,
            cpu_high_samples: 0,
            memory_high_samples: 0,
            memory_high_samples_tier: None,
            last_memory_alarm: None,
            last_process_alarm_at: HashMap::new(),
            last_infra_alarm_at: HashMap::new(),
            disk_high_samples: 0,
            last_disk_sample_at: None,
            last_disk_alarm_at: HashMap::new(),
            now_ms,
        }));
        let callback_inner = Arc::clone(&inner);
        let sampler = Arc::new(DiskUsageSampler::new(
            DiskUsageSamplerOptions::new(&opts.data_dir),
            Arc::new(move |sample| {
                if let Ok(mut guard) = callback_inner.lock() {
                    guard.observe_disk(sample);
                }
            }),
        ));
        Self {
            logs_dir: Path::new(&opts.data_dir).join("logs").join("metric_alarm"),
            cycle_gate: Arc::new(tokio::sync::Mutex::new(())),
            hook_spool: Arc::new(Mutex::new(super::HookMetricsSpool::new(Path::new(
                &opts.data_dir,
            )))),
            inner,
            sampler,
            get_snapshot: opts.get_snapshot,
            get_trace: opts.get_trace_runtime_snapshot,
            tasks: Mutex::new(Vec::new()),
        }
    }

    pub async fn start(&self) {
        self.start_with_intervals(DATAFLOW_INTERVAL, ALARM_FLUSH_INTERVAL)
            .await;
    }

    async fn start_with_intervals(
        &self,
        dataflow_interval: Duration,
        alarm_flush_interval: Duration,
    ) {
        ensure_dir(&self.logs_dir.to_string_lossy()).await;
        self.sampler.start();
        let writer = self.share();
        let dataflow = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(dataflow_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                writer.write_dataflow().await;
            }
        });
        self.tasks.lock().expect("tasks").push(dataflow);
        if self.inner.lock().expect("writer").alarm_manager.is_some() {
            let writer = self.share();
            let alarms = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(alarm_flush_interval);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    writer.write_alarms().await;
                }
            });
            self.tasks.lock().expect("tasks").push(alarms);
        }
        self.write_dataflow().await;
        create_logger("MetricsWriter").info("metrics-writer started", None);
    }

    pub async fn stop(&self) {
        self.sampler.stop();
        for task in self.tasks.lock().expect("tasks").drain(..) {
            task.abort();
        }
        self.write_dataflow().await;
        self.write_alarms().await;
        create_logger("MetricsWriter").info("metrics-writer stopped", None);
    }

    fn share(&self) -> Arc<Shared> {
        Arc::new(Shared {
            logs_dir: self.logs_dir.clone(),
            hook_spool: Arc::clone(&self.hook_spool),
            cycle_gate: Arc::clone(&self.cycle_gate),
            inner: Arc::clone(&self.inner),
            sampler: Arc::clone(&self.sampler),
            get_snapshot: Arc::clone(&self.get_snapshot),
            get_trace: self.get_trace.clone(),
        })
    }

    async fn write_dataflow(&self) {
        self.share().write_dataflow().await;
    }

    pub async fn write_l1(&self) {
        let _ = self.share().write_l1(None).await;
    }

    pub async fn write_l2(&self) {
        let _ = self.share().write_l2(None).await;
    }

    pub async fn write_alarms(&self) {
        self.share().write_alarms().await;
    }

    pub fn check_thresholds(&self, cpu: &str, mem: &str) {
        self.inner
            .lock()
            .expect("writer")
            .check_thresholds(cpu, mem);
    }

    pub fn observe_disk_sample(&self, sample: DiskUsageSnapshot) {
        self.inner.lock().expect("writer").observe_disk(sample);
    }

    pub fn sampler(&self) -> &Arc<DiskUsageSampler> {
        &self.sampler
    }
}

struct Shared {
    logs_dir: PathBuf,
    hook_spool: Arc<Mutex<super::HookMetricsSpool>>,
    cycle_gate: Arc<tokio::sync::Mutex<()>>,
    inner: Arc<Mutex<WriterInner>>,
    sampler: Arc<DiskUsageSampler>,
    get_snapshot: Arc<dyn Fn() -> Result<DataflowSnapshot, String> + Send + Sync>,
    get_trace: Option<TraceSnapshotProvider>,
}

impl Shared {
    async fn write_dataflow(self: &Arc<Self>) {
        // Aborting a scheduling timer must not cancel a cycle already writing
        // native files. The final shutdown cycle waits for this owned operation.
        let writer = Arc::clone(self);
        let result = tokio::spawn(async move { writer.collect_and_write().await }).await;
        let result = result.unwrap_or_else(|error| Err(format!("metrics cycle failed: {error}")));
        if let Err(err) = result {
            let mut meta = Map::new();
            meta.insert("error".into(), Value::String(err));
            create_logger("MetricsWriter").warn("dataflow metrics snapshot failed", Some(&meta));
        }
    }

    async fn collect_and_write(&self) -> Result<(), String> {
        let _cycle = self.cycle_gate.lock().await;
        let snapshot = (self.get_snapshot)()?;
        // 两类指标均尝试写出，但任一失败必须反馈给上层诊断。
        let l1 = self.write_l1(Some(&snapshot)).await;
        let l2 = self.write_l2(Some(&snapshot)).await;
        l1.and(l2)
    }

    async fn write_l1(&self, shared: Option<&DataflowSnapshot>) -> Result<(), String> {
        let snapshot = match shared {
            Some(snapshot) => snapshot.clone(),
            None => (self.get_snapshot)()?,
        };
        let mut metrics = self
            .inner
            .lock()
            .expect("writer")
            .collector
            .collect_l1(&snapshot);
        let disk = self.sampler.get_snapshot();
        metrics.metric_json.disk_dir_status = Some(disk.status.as_str().to_string());
        if let Some(scan_ms) = disk.scan_ms {
            metrics.metric_json.disk_dir_scan_ms = Some(scan_ms.to_string());
        }
        if let (Some(sampled_at), Some(data_bytes), Some(logs_bytes)) =
            (disk.sampled_at, disk.data_bytes, disk.logs_bytes)
        {
            metrics.metric_json.disk_data_bytes = Some(data_bytes.to_string());
            metrics.metric_json.disk_logs_bytes = Some(logs_bytes.to_string());
            metrics.metric_json.disk_dir_sampled_at = Some(iso_millis(sampled_at));
        }
        {
            let mut inner = self.inner.lock().expect("writer");
            inner.check_thresholds(&metrics.cpu, &metrics.mem);
            inner.check_user_id();
            inner.check_startup_mode(&metrics);
            inner.check_infra_health();
        }
        let flat = flatten_to_strings(&as_map(&metrics));
        dispatch_status("pilot_status", &flat)?;
        let _ = dispatch_running(&flat);
        self.write_trace_runtime(&metrics);
        let path = self
            .logs_dir
            .join(format!("pilot-metrics-{}.jsonl", get_today_date_string()));
        append_line(
            &path.to_string_lossy(),
            &serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".into()),
        )
        .await;
        Ok(())
    }

    fn write_trace_runtime(&self, metrics: &L1Metrics) {
        let Some(get_trace) = &self.get_trace else {
            return;
        };
        let snapshots = match get_trace() {
            Ok(snapshots) => snapshots,
            Err(err) => {
                warn_trace(&err);
                return;
            }
        };
        for snapshot in snapshots {
            let mut body = match serde_json::to_value(&snapshot) {
                Ok(Value::Object(map)) => map,
                _ => Map::new(),
            };
            body.insert("schema_version".into(), Value::from(2));
            body.insert("record_type".into(), Value::String("snapshot".into()));
            body.insert(
                "buffer_scope".into(),
                Value::String("pending_conversion".into()),
            );
            body.insert("version".into(), Value::String(metrics.version.clone()));
            body.insert("run_id".into(), Value::String(metrics.run_id.clone()));
            body.insert(
                "instance_id".into(),
                Value::String(metrics.instance_id.clone()),
            );
            body.insert("user_id".into(), Value::String(metrics.user_id.clone()));
            body.insert("__time__".into(), Value::from(metrics.time));
            if let Err(err) = dispatch_status("pilot_trace_runtime", &flatten_to_strings(&body)) {
                warn_trace(&err);
            }
        }
    }

    async fn write_l2(&self, shared: Option<&DataflowSnapshot>) -> Result<(), String> {
        let snapshot = match shared {
            Some(snapshot) => snapshot.clone(),
            None => (self.get_snapshot)()?,
        };
        let timings = self.hook_spool.lock().expect("hook spool").drain();
        let Some(l2) = self
            .inner
            .lock()
            .expect("writer")
            .collector
            .collect_l2_with_hook_timings(&snapshot, &timings)
        else {
            return Ok(());
        };
        for row in &l2.agents {
            dispatch_status("pilot_pipeline", &flatten_to_strings(&as_map(row)))?;
        }
        for row in &l2.inputs {
            dispatch_status("pilot_pipeline", &flatten_to_strings(&as_map(row)))?;
        }
        for row in &l2.flushers {
            dispatch_status("pilot_pipeline", &flatten_to_strings(&as_map(row)))?;
        }
        for row in &l2.hooks {
            dispatch_status("pilot_pipeline", &flatten_to_strings(&as_map(row)))?;
        }
        let date = get_today_date_string();
        for row in &l2.hooks {
            append_line(
                &self
                    .logs_dir
                    .join(format!("pilot-hook-metrics-{date}.jsonl"))
                    .to_string_lossy(),
                &serde_json::to_string(row).unwrap_or_else(|_| "{}".into()),
            )
            .await;
        }
        for row in &l2.agents {
            append_line(
                &self
                    .logs_dir
                    .join(format!("pilot-agent-metrics-{date}.jsonl"))
                    .to_string_lossy(),
                &serde_json::to_string(row).unwrap_or_else(|_| "{}".into()),
            )
            .await;
        }
        for row in &l2.inputs {
            append_line(
                &self
                    .logs_dir
                    .join(format!("pilot-input-metrics-{date}.jsonl"))
                    .to_string_lossy(),
                &serde_json::to_string(row).unwrap_or_else(|_| "{}".into()),
            )
            .await;
        }
        for row in &l2.flushers {
            append_line(
                &self
                    .logs_dir
                    .join(format!("pilot-flusher-metrics-{date}.jsonl"))
                    .to_string_lossy(),
                &serde_json::to_string(row).unwrap_or_else(|_| "{}".into()),
            )
            .await;
        }
        Ok(())
    }

    async fn write_alarms(&self) {
        let entries = {
            let inner = self.inner.lock().expect("writer");
            let Some(manager) = &inner.alarm_manager else {
                return;
            };
            manager.serialize()
        };
        if entries.is_empty() {
            return;
        }
        for entry in &entries {
            let _ = dispatch_alarm(&flatten_to_strings(&as_map(entry)));
        }
        let path = self
            .logs_dir
            .join(format!("pilot-alarms-{}.jsonl", get_today_date_string()));
        for entry in &entries {
            append_line(
                &path.to_string_lossy(),
                &serde_json::to_string(entry).unwrap_or_else(|_| "{}".into()),
            )
            .await;
        }
    }
}

fn warn_trace(err: &str) {
    let mut meta = Map::new();
    meta.insert("error".into(), Value::String(err.to_string()));
    create_logger("MetricsWriter").warn("Trace runtime snapshot failed", Some(&meta));
}

fn as_map<T: Serialize>(value: &T) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn dispatch_status(topic: &str, data: &indexmap::IndexMap<String, String>) -> Result<(), String> {
    #[cfg(test)]
    if let Some(message) = crate::internal::injected_error(topic) {
        return Err(message);
    }
    send_status(topic, data);
    Ok(())
}

fn dispatch_running(data: &indexmap::IndexMap<String, String>) -> Result<(), String> {
    send_running_status(data);
    Ok(())
}

fn dispatch_alarm(data: &indexmap::IndexMap<String, String>) -> Result<(), String> {
    send_alarm("pilot_alarm", data);
    Ok(())
}

fn iso_millis(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

fn classify_memory_threshold(mem_mb: f64) -> Option<MemoryTier> {
    if mem_mb > MEMORY_CRITICAL_THRESHOLD_MB {
        Some(MemoryTier {
            name: "critical",
            threshold_mb: MEMORY_CRITICAL_THRESHOLD_MB,
            level: "3",
            rank: 3,
        })
    } else if mem_mb > MEMORY_HARD_THRESHOLD_MB {
        Some(MemoryTier {
            name: "hard",
            threshold_mb: MEMORY_HARD_THRESHOLD_MB,
            level: "2",
            rank: 2,
        })
    } else if mem_mb > MEMORY_SOFT_THRESHOLD_MB {
        Some(MemoryTier {
            name: "soft",
            threshold_mb: MEMORY_SOFT_THRESHOLD_MB,
            level: "2",
            rank: 1,
        })
    } else {
        None
    }
}

impl WriterInner {
    fn now(&self) -> i64 {
        (self.now_ms)()
    }

    fn check_thresholds(&mut self, cpu: &str, mem: &str) {
        if self.alarm_manager.is_none() {
            return;
        }
        self.check_cpu(cpu.parse::<f64>().ok());
        self.check_memory(mem.parse::<f64>().ok());
    }

    fn observe_disk(&mut self, sample: DiskUsageSnapshot) {
        if self.alarm_manager.is_none() {
            return;
        }
        let now = self.now();
        let valid = sample.status == crate::metrics::disk_usage_sampler::DiskUsageStatus::Ok
            && sample.data_bytes.is_some()
            && sample
                .logs_bytes
                .is_some_and(|logs| sample.data_bytes.is_some_and(|data| logs <= data))
            && sample
                .sampled_at
                .is_some_and(|sampled| sampled <= now && now - sampled <= DISK_USAGE_STALE_MS);
        if !valid {
            self.disk_high_samples = 0;
            self.last_disk_sample_at = None;
            return;
        }
        let data_bytes = sample.data_bytes.unwrap_or(0);
        let logs_bytes = sample.logs_bytes.unwrap_or(0);
        let sampled_at = sample.sampled_at.unwrap_or(0);
        if self
            .last_disk_sample_at
            .is_some_and(|last| sampled_at <= last)
        {
            return;
        }
        if self.last_disk_sample_at.is_none()
            || sampled_at - self.last_disk_sample_at.unwrap_or(0) > DISK_USAGE_STALE_MS
        {
            self.disk_high_samples = 0;
        }
        self.last_disk_sample_at = Some(sampled_at);
        if data_bytes <= DISK_USAGE_SOFT_BYTES {
            self.disk_high_samples = 0;
            return;
        }
        self.disk_high_samples += 1;
        let critical = data_bytes > DISK_USAGE_CRITICAL_BYTES;
        if !critical && self.disk_high_samples < 2 {
            return;
        }
        let level = if critical { "3" } else { "2" };
        if let Some(last) = self.last_disk_alarm_at.get(level) {
            if now - last < DISK_USAGE_ALARM_COOLDOWN_MS {
                return;
            }
        }
        self.last_disk_alarm_at.insert(level.to_string(), now);
        let threshold = if critical {
            DISK_USAGE_CRITICAL_BYTES
        } else {
            DISK_USAGE_SOFT_BYTES
        };
        if let Some(manager) = &self.alarm_manager {
            manager.record(
                "DISK_USAGE_ALARM",
                level,
                &format!(
                    "Pilot directory usage {data_bytes} bytes (logs {logs_bytes} bytes) exceeds {threshold} bytes; sampled_at={}",
                    iso_millis(sampled_at)
                ),
                None,
            );
        }
    }

    fn check_cpu(&mut self, cpu_percent: Option<f64>) {
        let Some(cpu_percent) = cpu_percent.filter(|value| value.is_finite()) else {
            self.cpu_high_samples = 0;
            return;
        };
        if cpu_percent <= CPU_THRESHOLD_PERCENT {
            self.cpu_high_samples = 0;
            return;
        }
        self.cpu_high_samples += 1;
        if self.cpu_high_samples < CPU_ALARM_CONSECUTIVE_SAMPLES {
            return;
        }
        self.record_process_alarm(
            "PROCESS_CPU_ALARM",
            "2",
            &format!("CPU usage {cpu_percent}% exceeds {CPU_THRESHOLD_PERCENT}% for {} consecutive samples", self.cpu_high_samples),
            "cpu",
        );
    }

    fn check_memory(&mut self, mem_mb: Option<f64>) {
        let Some(mem_mb) = mem_mb.filter(|value| value.is_finite()) else {
            self.reset_memory();
            return;
        };
        let Some(tier) = classify_memory_threshold(mem_mb) else {
            self.reset_memory();
            return;
        };
        if self.memory_high_samples_tier != Some(tier.name) {
            self.memory_high_samples_tier = Some(tier.name);
            self.memory_high_samples = 1;
        } else {
            self.memory_high_samples += 1;
        }
        let enough = if tier.name == "soft" {
            self.memory_high_samples >= MEMORY_SOFT_ALARM_CONSECUTIVE_SAMPLES
        } else {
            true
        };
        if !enough {
            return;
        }
        let now = self.now();
        if let Some((at, rank)) = self.last_memory_alarm {
            if now - at < PROCESS_RESOURCE_ALARM_COOLDOWN_MS && tier.rank <= rank {
                return;
            }
        }
        self.last_memory_alarm = Some((now, tier.rank));
        let sample_word = if self.memory_high_samples == 1 {
            "sample"
        } else {
            "samples"
        };
        if let Some(manager) = &self.alarm_manager {
            manager.record(
                "PROCESS_MEMORY_ALARM",
                tier.level,
                &format!(
                    "Memory usage {mem_mb}MB exceeds {} threshold {}MB ({} consecutive {} {sample_word})",
                    tier.name, tier.threshold_mb as i64, self.memory_high_samples, tier.name
                ),
                None,
            );
        }
    }

    fn reset_memory(&mut self) {
        self.memory_high_samples = 0;
        self.memory_high_samples_tier = None;
    }

    fn record_process_alarm(
        &mut self,
        alarm_type: &str,
        level: &str,
        message: &str,
        cooldown_key: &str,
    ) {
        let Some(manager) = &self.alarm_manager else {
            return;
        };
        let now = self.now();
        if let Some(last) = self.last_process_alarm_at.get(cooldown_key) {
            if now - last < PROCESS_RESOURCE_ALARM_COOLDOWN_MS {
                return;
            }
        }
        self.last_process_alarm_at
            .insert(cooldown_key.to_string(), now);
        manager.record(alarm_type, level, message, None);
    }

    fn check_user_id(&mut self) {
        if self.alarm_manager.is_none() || self.user_id_alarm_emitted {
            return;
        }
        let user_id = self.collector.user_id().to_string();
        if regex::Regex::new(r"^\{.*\}$")
            .ok()
            .is_some_and(|pattern| pattern.is_match(&user_id))
        {
            self.user_id_alarm_emitted = true;
            if let Some(manager) = &self.alarm_manager {
                manager.record(
                    "USER_ID_FORMAT_ALARM",
                    "1",
                    &format!("userId \"{user_id}\" contains braces, expected plain number like \"123456\""),
                    None,
                );
            }
        }
    }

    fn check_startup_mode(&mut self, metrics: &L1Metrics) {
        if self.alarm_manager.is_none() || self.startup_alarm_emitted {
            return;
        }
        if metrics.init_type == "nohup" || metrics.init_type == "unknown" {
            self.startup_alarm_emitted = true;
            let init_type = metrics.init_type.clone();
            if let Some(manager) = &self.alarm_manager {
                manager.record(
                    "DEGRADED_STARTUP_ALARM",
                    "2",
                    &format!("Service started without autostart registration (init_type={init_type}), will not survive reboot"),
                    None,
                );
            }
        }
    }

    fn check_infra_health(&mut self) {
        if self.alarm_manager.is_none() {
            return;
        }
        let Some(health) = self.collector.last_infra_health().cloned() else {
            return;
        };
        if health.updater_consecutive_failures >= 2 {
            self.record_infra(
                "UPDATER_NOT_RUNNING_ALARM",
                "3",
                "Updater process is not running, automatic updates will not be applied",
            );
        }
        if !health.current_version_valid {
            self.record_infra(
                "BROKEN_VERSION_POINTER_ALARM",
                "2",
                "Version pointer (current) references a non-existent directory, service will fail on restart",
            );
        }
        if !health.runtime_bin_valid {
            let detail = format!(
                "原生二进制或发行资源无效，重启可能失败：{}",
                health.runtime_diagnostic.as_deref().unwrap_or("未知原因")
            );
            self.record_infra("INVALID_RUNTIME_BIN_ALARM", "2", &detail);
        }
    }

    fn record_infra(&mut self, alarm_type: &str, level: &str, message: &str) {
        let Some(manager) = &self.alarm_manager else {
            return;
        };
        let now = self.now();
        let last = self
            .last_infra_alarm_at
            .get(alarm_type)
            .copied()
            .unwrap_or(0);
        if now - last < INFRA_ALARM_COOLDOWN_MS {
            return;
        }
        self.last_infra_alarm_at.insert(alarm_type.to_string(), now);
        manager.record(alarm_type, level, message, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::internal::{clear_sends, inject_send_error, recorded_sends};
    use crate::metrics::alarm_manager::AlarmManager;
    use crate::metrics::disk_usage_sampler::DiskUsageStatus;
    use crate::metrics::metrics_collector::DataflowSnapshot;
    use crate::metrics::trace_runtime::TraceRuntimeSnapshot;
    use indexmap::IndexMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    pub(super) fn snapshot() -> DataflowSnapshot {
        let mut inputs = IndexMap::new();
        inputs.insert(
            "test-input".into(),
            crate::metrics::metrics_collector::InputSnapshot {
                raw_read_calls: 2,
                raw_read_bytes: 2048,
                raw_in_records: 7,
                raw_in_bytes: 1536,
                raw_in_max_batch_bytes: 1024,
                raw_in_max_record_bytes: 512,
                raw_backlog_bytes_max: 1024,
                parse_success_records: 6,
                parse_failed_records: 1,
                read_duration_ms: 4.0,
                process_duration_ms: 8.0,
                in_events: 5,
                in_bytes: 1024,
                last_poll_time: "2026-05-19 10:00:00".into(),
                start_time: "2026-05-19 09:00:00".into(),
                collection_method: "polling".into(),
                agent: "test-agent".into(),
                running: true,
                ..crate::metrics::metrics_collector::InputSnapshot::default()
            },
        );
        let mut flushers = IndexMap::new();
        flushers.insert(
            "sls:main".into(),
            crate::metrics::metrics_collector::FlusherEndpointStats {
                kind: "sls".into(),
                project: "proj-a".into(),
                logstore: "store-a".into(),
                mode: "sls".into(),
                bytes_basis: "measured".into(),
                in_entries: 10,
                in_bytes: 2048,
                out_entries: 9,
                out_bytes: 1900,
                out_failed: 1,
                total_delay_ms: 500,
                last_flush_time: "2026-05-19 10:00:00".into(),
                start_time: "2026-05-19 09:00:00".into(),
            },
        );
        DataflowSnapshot {
            in_events_total: 12,
            in_bytes_total: 2048,
            inputs,
            flushers,
            input_idle_minutes: IndexMap::new(),
        }
    }

    fn make_writer(dir: &std::path::Path, alarm: Option<AlarmManager>) -> MetricsWriter {
        let mut opts =
            MetricsWriterOptions::new(dir.to_string_lossy().into_owned(), "2.0.0", "u1", snapshot);
        opts.alarm_manager = alarm;
        MetricsWriter::new(opts)
    }

    #[tokio::test]
    async fn hook_spool_drains_into_pipeline_and_its_own_mirror_once() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        super::super::record_hook_timing(dir.path(), "codex", "stop", 40.0);
        super::super::record_hook_timing(dir.path(), "codex", "stop", 120.0);
        let writer = make_writer(dir.path(), None);
        writer.write_l2().await;
        writer.write_l2().await;
        let rows: Vec<_> = recorded_sends()
            .into_iter()
            .filter(|send| {
                send.topic == "pilot_pipeline"
                    && send.fields.get("type").is_some_and(|kind| kind == "hook")
            })
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fields["calls"], "2");
        assert_eq!(rows[0].fields["total_duration_ms"], "160");
        assert_eq!(rows[0].fields["max_duration_ms"], "120");
        let path = dir.path().join("logs/metric_alarm").join(format!(
            "pilot-hook-metrics-{}.jsonl",
            get_today_date_string()
        ));
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let local: Value = serde_json::from_str(text.trim()).unwrap();
        for key in [
            "type",
            "agent",
            "hook_event",
            "calls",
            "total_duration_ms",
            "max_duration_ms",
            "user_id",
            "window_ms",
            "run_id",
            "instance_id",
            "hostname",
            "ip",
        ] {
            assert_eq!(local[key].as_str().unwrap(), rows[0].fields[key]);
        }
        assert_eq!(local["__time__"].to_string(), rows[0].fields["__time__"]);
        assert!(super::super::HookMetricsSpool::new(dir.path())
            .drain()
            .is_empty());
    }

    #[tokio::test]
    async fn writes_l1_and_sends_pilot_status() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("logs")).unwrap();
        let writer = make_writer(dir.path(), None);
        writer.start().await;
        let metric_dir = dir.path().join("logs").join("metric_alarm");
        let file = std::fs::read_dir(&metric_dir)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("pilot-metrics-")
            })
            .unwrap();
        let text = std::fs::read_to_string(file.path()).unwrap();
        let entry: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(entry["version"], "2.0.0");
        assert_eq!(entry["user_id"], "u1");
        assert_eq!(entry["metric_json"]["agent_count"], "1");
        assert!(entry["metric_json"].get("raw_in_records").is_none());
        assert_eq!(entry["capture_message_disabled_agents"], "");
        let status = recorded_sends()
            .into_iter()
            .find(|send| send.topic == "pilot_status")
            .unwrap();
        assert_eq!(
            status.fields.get("version").map(String::as_str),
            Some("2.0.0")
        );
        assert!(!status.fields.contains_key("__topic__"));
        assert!(recorded_sends().iter().all(|send| ![
            "pilot_input_detail",
            "pilot_flusher_detail",
            "pilot_alarm_metric"
        ]
        .contains(&send.topic.as_str())));
        writer.stop().await;
    }

    #[tokio::test]
    async fn dataflow_reports_errors_without_suppressing_the_other_metric_level() {
        let dir = tempfile::tempdir().unwrap();
        for (topic, surviving_topic) in [
            ("pilot_status", "pilot_pipeline"),
            ("pilot_pipeline", "pilot_status"),
        ] {
            clear_sends();
            inject_send_error(topic, "fixture-output-failure");
            let writer = make_writer(dir.path(), None);
            assert_eq!(
                writer.share().collect_and_write().await.unwrap_err(),
                "fixture-output-failure"
            );
            assert!(recorded_sends()
                .iter()
                .any(|send| send.topic == surviving_topic));
        }
        clear_sends();
    }

    #[tokio::test]
    async fn sends_one_pipeline_row_per_agent_input_and_flusher() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        let writer = make_writer(dir.path(), None);
        writer.write_l2().await;
        let rows: Vec<_> = recorded_sends()
            .into_iter()
            .filter(|send| send.topic == "pilot_pipeline")
            .collect();
        assert_eq!(
            rows.iter()
                .map(|row| row.fields.get("type").map(String::as_str))
                .collect::<Vec<_>>(),
            vec![Some("agent"), Some("input"), Some("flusher")]
        );
        assert_eq!(
            rows[0].fields.get("agent").map(String::as_str),
            Some("test-agent")
        );
        assert_eq!(
            rows[0].fields.get("in_events").map(String::as_str),
            Some("5")
        );
        assert!(!rows[0].fields.contains_key("raw_in_records"));
        assert_eq!(
            rows[1].fields.get("input_name").map(String::as_str),
            Some("test-input")
        );
        assert_eq!(
            rows[1].fields.get("raw_read_bytes").map(String::as_str),
            Some("2048")
        );
        assert_eq!(
            rows[2].fields.get("flusher").map(String::as_str),
            Some("sls")
        );
        assert_eq!(
            rows[2].fields.get("out_entries").map(String::as_str),
            Some("9")
        );
        clear_sends();
        writer.write_l2().await;
        let drained: Vec<_> = recorded_sends()
            .into_iter()
            .filter(|send| send.topic == "pilot_pipeline")
            .collect();
        assert_eq!(
            drained[0].fields.get("in_events").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            drained[2].fields.get("out_entries").map(String::as_str),
            Some("0")
        );
    }

    #[tokio::test]
    async fn reports_trace_runtime_with_process_identity() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        let row = TraceRuntimeSnapshot {
            agent_type: "codex".into(),
            pending_buffers: 1,
            pending_records: 2,
            pending_logical_bytes: 100,
            pending_unmeasured_records: 0,
            largest_buffer_logical_bytes: 100,
            largest_buffer_records: 2,
            largest_buffer_age_ms: 60_000,
            largest_buffer_turn_id: Some("turn".into()),
            largest_buffer_session_id: Some("session".into()),
            oldest_buffer_age_ms: 60_000,
            resident_records: None,
            resident_payload_bytes: None,
            spilled_buffers: None,
            spilled_records: None,
            removed_buffers_total: 3,
            removed_logical_bytes_total: 400,
            removed_unmeasured_records_total: 0,
            converter_calls_total: 3,
            converter_duration_ms_total: 12,
            converter_failed_total: 0,
        };
        let mut opts = MetricsWriterOptions::new(
            dir.path().to_string_lossy().into_owned(),
            "test",
            "u1",
            snapshot,
        );
        opts.get_trace_runtime_snapshot = Some(Arc::new(move || Ok(vec![row.clone()])));
        let writer = MetricsWriter::new(opts);
        writer.write_l1().await;
        let sends = recorded_sends();
        let status = sends
            .iter()
            .find(|send| send.topic == "pilot_status")
            .unwrap();
        let trace = sends
            .iter()
            .find(|send| send.topic == "pilot_trace_runtime")
            .unwrap();
        assert_eq!(
            trace.fields.get("schema_version").map(String::as_str),
            Some("2")
        );
        assert_eq!(
            trace.fields.get("record_type").map(String::as_str),
            Some("snapshot")
        );
        assert_eq!(
            trace.fields.get("buffer_scope").map(String::as_str),
            Some("pending_conversion")
        );
        assert_eq!(
            trace.fields.get("agent_type").map(String::as_str),
            Some("codex")
        );
        assert_eq!(
            trace
                .fields
                .get("removed_buffers_total")
                .map(String::as_str),
            Some("3")
        );
        assert_eq!(trace.fields.get("run_id"), status.fields.get("run_id"));
        assert!(!trace.fields.contains_key("window_ms"));
    }

    #[tokio::test]
    async fn isolates_trace_snapshot_failures() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        let mut opts = MetricsWriterOptions::new(
            dir.path().to_string_lossy().into_owned(),
            "test",
            "u1",
            snapshot,
        );
        opts.get_trace_runtime_snapshot = Some(Arc::new(|| Err("snapshot unavailable".into())));
        let writer = MetricsWriter::new(opts);
        writer.start().await;
        writer.stop().await;
        assert!(
            std::fs::read_dir(dir.path().join("logs").join("metric_alarm"))
                .unwrap()
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("pilot-metrics-")
                })
        );
        clear_sends();
        inject_send_error("pilot_trace_runtime", "send unavailable");
        let mut opts = MetricsWriterOptions::new(
            dir.path().join("second").to_string_lossy(),
            "test",
            "u1",
            snapshot,
        );
        opts.get_trace_runtime_snapshot = Some(Arc::new(|| {
            Ok(vec![TraceRuntimeSnapshot {
                agent_type: "codex".into(),
                pending_buffers: 0,
                pending_records: 0,
                pending_logical_bytes: 0,
                pending_unmeasured_records: 0,
                largest_buffer_logical_bytes: 0,
                largest_buffer_records: 0,
                largest_buffer_age_ms: 0,
                largest_buffer_turn_id: None,
                largest_buffer_session_id: None,
                oldest_buffer_age_ms: 0,
                resident_records: None,
                resident_payload_bytes: None,
                spilled_buffers: None,
                spilled_records: None,
                removed_buffers_total: 0,
                removed_logical_bytes_total: 0,
                removed_unmeasured_records_total: 0,
                converter_calls_total: 0,
                converter_duration_ms_total: 0,
                converter_failed_total: 0,
            }])
        }));
        let writer = MetricsWriter::new(opts);
        writer.start().await;
        writer.stop().await;
        clear_sends();
    }

    #[test]
    fn debounces_memory_and_cpu_alarms() {
        let dir = tempfile::tempdir().unwrap();
        let alarm = AlarmManager::new("127.0.0.1", "2.0.0", "test-user");
        let writer = make_writer(dir.path(), Some(alarm));
        writer.check_thresholds("0", "600");
        writer.check_thresholds("0", "620");
        assert!(writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize()
            .iter()
            .all(|entry| entry.alarm_type != "PROCESS_MEMORY_ALARM"));
        // serialize cleared nothing if none matched, but it clears all. Re-record the third sample on a fresh manager.
        let alarm = AlarmManager::new("127.0.0.1", "2.0.0", "test-user");
        let writer = make_writer(dir.path(), Some(alarm));
        writer.check_thresholds("0", "600");
        writer.check_thresholds("0", "620");
        writer.check_thresholds("0", "640");
        let entries = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        let memory = entries
            .iter()
            .find(|entry| entry.alarm_type == "PROCESS_MEMORY_ALARM")
            .unwrap();
        assert_eq!(memory.alarm_level, "2");
        assert!(memory.alarm_message.contains("soft threshold 512MB"));
        assert!(memory.alarm_message.contains("3 consecutive soft samples"));

        let alarm = AlarmManager::new("127.0.0.1", "2.0.0", "test-user");
        let writer = make_writer(dir.path(), Some(alarm));
        writer.check_thresholds("81", "128");
        writer.check_thresholds("81", "128");
        writer.check_thresholds("81", "128");
        let entries = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        let cpu = entries
            .iter()
            .find(|entry| entry.alarm_type == "PROCESS_CPU_ALARM")
            .unwrap();
        assert!(cpu.alarm_message.contains("CPU usage 81% exceeds 80%"));
        assert!(cpu.alarm_message.contains("3 consecutive samples"));
    }

    #[test]
    fn disk_usage_thresholds_and_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000_000_000_000));
        let clock_fn = clock.clone();
        let mut opts = MetricsWriterOptions::new(
            dir.path().to_string_lossy().into_owned(),
            "1.2.0",
            "test-user",
            DataflowSnapshot::default,
        );
        opts.alarm_manager = Some(AlarmManager::new("127.0.0.1", "1.2.0", "test-user"));
        opts.now_ms = Some(Arc::new(move || clock_fn.load(Ordering::SeqCst)));
        let writer = MetricsWriter::new(opts);
        let gib = 1024u64.pow(3);
        let sample = |bytes: u64, at: i64, status: DiskUsageStatus| DiskUsageSnapshot {
            status,
            data_bytes: Some(bytes),
            logs_bytes: Some(gib.min(bytes)),
            sampled_at: Some(at),
            scan_ms: Some(2000),
        };
        writer.observe_disk_sample(sample(
            6 * gib,
            clock.load(Ordering::SeqCst),
            DiskUsageStatus::Ok,
        ));
        assert!(writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize()
            .is_empty());
        clock.fetch_add(10 * 60_000, Ordering::SeqCst);
        writer.observe_disk_sample(sample(
            6 * gib,
            clock.load(Ordering::SeqCst),
            DiskUsageStatus::Ok,
        ));
        let alarms = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        assert_eq!(alarms[0].alarm_type, "DISK_USAGE_ALARM");
        assert_eq!(alarms[0].alarm_level, "2");
        clock.fetch_add(10 * 60_000, Ordering::SeqCst);
        writer.observe_disk_sample(sample(
            11 * gib,
            clock.load(Ordering::SeqCst),
            DiskUsageStatus::Ok,
        ));
        let critical = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        assert_eq!(critical[0].alarm_level, "3");
        assert!(critical[0].alarm_message.contains("logs"));
    }

    #[tokio::test]
    async fn records_degraded_startup_and_broken_pointer() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("init-type"), "nohup").unwrap();
        std::fs::write(dir.path().join("current"), "missing").unwrap();
        let alarm = AlarmManager::new("127.0.0.1", "2.0.0", "test-user");
        let writer = make_writer(dir.path(), Some(alarm));
        writer.write_l1().await;
        let entries = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        assert!(entries
            .iter()
            .any(|entry| entry.alarm_type == "DEGRADED_STARTUP_ALARM"
                && entry.alarm_message.contains("nohup")));
        assert!(entries
            .iter()
            .any(|entry| entry.alarm_type == "BROKEN_VERSION_POINTER_ALARM"));
    }

    #[tokio::test]
    async fn native_runtime_alarm_preserves_cooldown_without_node_alarm() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000_000_000_000));
        let clock_fn = Arc::clone(&clock);
        let mut opts = MetricsWriterOptions::new(
            dir.path().to_string_lossy(),
            "1.2.0",
            "fixture",
            DataflowSnapshot::default,
        );
        opts.auto_update_enabled = false;
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: dir.path().join("missing-native-binary"),
            cache_dir: Some(dir.path().to_path_buf()),
        });
        opts.alarm_manager = Some(AlarmManager::new("127.0.0.1", "1.2.0", "fixture"));
        opts.now_ms = Some(Arc::new(move || clock_fn.load(Ordering::SeqCst)));
        let writer = MetricsWriter::new(opts);
        for emit in [true, false, true] {
            writer.write_l1().await;
            let entries = writer
                .inner
                .lock()
                .unwrap()
                .alarm_manager
                .as_ref()
                .unwrap()
                .serialize();
            let native: Vec<_> = entries
                .iter()
                .filter(|entry| entry.alarm_type == "INVALID_RUNTIME_BIN_ALARM")
                .collect();
            assert_eq!(native.len(), usize::from(emit));
            if emit {
                assert_eq!(native[0].alarm_level, "2");
                assert!(native[0].alarm_message.contains("原生二进制"));
            }
            assert!(entries
                .iter()
                .all(|entry| entry.alarm_type != "INVALID_NODE_BIN_ALARM"));
            if !emit {
                clock.fetch_add(INFRA_ALARM_COOLDOWN_MS, Ordering::SeqCst);
            }
        }
        assert!(!dir.path().join("node-bin").exists());
    }

    #[tokio::test]
    async fn does_not_alarm_startup_for_launchd_or_updater_during_grace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("init-type"), "launchd").unwrap();
        let alarm = AlarmManager::new("127.0.0.1", "2.0.0", "test-user");
        let writer = make_writer(dir.path(), Some(alarm));
        writer.write_l1().await;
        let entries = writer
            .inner
            .lock()
            .unwrap()
            .alarm_manager
            .as_ref()
            .unwrap()
            .serialize();
        assert!(entries
            .iter()
            .all(|entry| entry.alarm_type != "DEGRADED_STARTUP_ALARM"));
        assert!(entries
            .iter()
            .all(|entry| entry.alarm_type != "UPDATER_NOT_RUNNING_ALARM"));
    }

    #[tokio::test]
    async fn publishes_pending_disk_status_without_byte_gauges() {
        clear_sends();
        let dir = tempfile::tempdir().unwrap();
        let writer = make_writer(dir.path(), None);
        writer.write_l1().await;
        let status = recorded_sends()
            .into_iter()
            .find(|send| send.topic == "pilot_status")
            .unwrap();
        let metric: Value =
            serde_json::from_str(status.fields.get("metric_json").unwrap()).unwrap();
        assert_eq!(metric["disk_dir_status"], "pending");
        assert!(metric.get("disk_data_bytes").is_none());
    }
}

#[cfg(test)]
#[path = "metrics_writer_migration_tests.rs"]
mod migration_contract_tests;

#[cfg(test)]
#[path = "disk_monitor_history_contract_tests.rs"]
mod disk_monitor_history_contract_tests;

#[cfg(test)]
#[path = "metrics_writer_history_contract_tests.rs"]
mod writer_history_contract_tests;
