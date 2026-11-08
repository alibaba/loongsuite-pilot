//! Instance-owned monitoring. No global telemetry sender or ambient source scan.
use super::{outbox::Outbox, policy::Init};
use crate::metrics::{
    AlarmManager, DataflowSnapshot, DiskUsageSampler, DiskUsageSamplerOptions,
    FlusherEndpointStats, MetricsCollector, MetricsCollectorOptions, MetricsWriter,
    MetricsWriterOptions,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub(super) struct Monitoring {
    metrics: MetricsCollector,
    resources: Arc<MetricsWriter>,
    disk: Arc<DiskUsageSampler>,
    runtime: Option<tokio::runtime::Runtime>,
    last_resource_check: Option<Instant>,
    scope: Arc<crate::utils::source_access::SourceScope>,
}
struct RestoreScope(Option<Arc<crate::utils::source_access::SourceScope>>);
impl Drop for RestoreScope {
    fn drop(&mut self) {
        crate::utils::source_access::install(self.0.take());
    }
}
impl Monitoring {
    pub fn new(init: &Init, queue: &Outbox) -> anyhow::Result<Self> {
        let scope = crate::utils::source_access::SourceScope::new(
            vec![init.data_dir.clone()],
            16384,
            64 * 1024 * 1024,
        );
        scope.set_log(init.data_dir.join("monitor.log"));
        let _restore = RestoreScope(crate::utils::source_access::current());
        crate::utils::source_access::install(Some(scope.clone()));
        let thread_scope = scope.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .on_thread_start(move || {
                crate::utils::source_access::install(Some(thread_scope.clone()))
            })
            .on_thread_stop(|| crate::utils::source_access::install(None))
            .build()?;
        let mut options = MetricsCollectorOptions::new(
            env!("CARGO_PKG_VERSION"),
            &init.user_id,
            init.data_dir.to_string_lossy(),
        );
        options.auto_update_enabled = false;
        let mut metrics = MetricsCollector::from_options(options);
        let identity = metrics.collect_l1(&DataflowSnapshot::default());
        *queue.identity.write().unwrap() =
            json!({"user_id":init.user_id,"ip":identity.ip,"ver":env!("CARGO_PKG_VERSION")});
        let mut options = MetricsWriterOptions::new(
            init.data_dir.to_string_lossy(),
            env!("CARGO_PKG_VERSION"),
            &init.user_id,
            DataflowSnapshot::default,
        );
        options.auto_update_enabled = false;
        options.alarm_manager = Some(AlarmManager::new(
            &identity.ip,
            env!("CARGO_PKG_VERSION"),
            &init.user_id,
        ));
        let resources = Arc::new(MetricsWriter::new(options));
        let weak = Arc::downgrade(&resources);
        let mut options = DiskUsageSamplerOptions::new(init.data_dir.to_string_lossy());
        options.additional_directories = vec![
            "sources".into(),
            "outbox".into(),
            "hook-requests-cloud".into(),
            "hook-requests-local".into(),
        ];
        let disk = Arc::new(DiskUsageSampler::new(
            options,
            Arc::new(move |sample| {
                if let Some(resources) = weak.upgrade() {
                    resources.observe_disk_sample(sample);
                }
            }),
        ));
        runtime.block_on(async {
            disk.start();
        });
        Ok(Self {
            metrics,
            resources,
            disk,
            runtime: Some(runtime),
            last_resource_check: None,
            scope,
        })
    }
    pub fn enter_scope(&self) {
        crate::utils::source_access::install(Some(self.scope.clone()));
    }
    pub fn collect(
        &mut self,
        mut flow: DataflowSnapshot,
        snapshot: Value,
        queue: &Outbox,
    ) -> Vec<Vec<u8>> {
        self.scope.reset();
        let last_ack = queue.last_ack_ms.load(Ordering::SeqCst);
        flow.flushers.insert(
            "cloud-callback".into(),
            FlusherEndpointStats {
                kind: "callback".into(),
                in_entries: queue.accepted_events.load(Ordering::SeqCst) as i64,
                in_bytes: queue.accepted_bytes.load(Ordering::SeqCst) as i64,
                out_entries: queue.acked_events.load(Ordering::SeqCst) as i64,
                out_bytes: queue.acked_bytes.load(Ordering::SeqCst) as i64,
                out_failed: queue.retries.load(Ordering::SeqCst) as i64,
                total_delay_ms: queue
                    .total_delay_ms
                    .load(Ordering::SeqCst)
                    .min(i64::MAX as u64) as i64,
                start_time: queue.start_time.clone(),
                last_flush_time: chrono::DateTime::from_timestamp_millis(
                    last_ack.min(i64::MAX as u64) as i64,
                )
                .filter(|_| last_ack > 0)
                .map(|t| t.to_rfc3339())
                .unwrap_or_default(),
                ..Default::default()
            },
        );
        let mut l1 = serde_json::to_value(self.metrics.collect_l1(&flow)).expect("L1 metrics");
        let disk = self.disk.get_snapshot();
        l1["metric_json"]["disk_dir_status"] = json!(disk.status.as_str());
        if let Some(ms) = disk.scan_ms {
            l1["metric_json"]["disk_dir_scan_ms"] = json!(ms.to_string());
        }
        if let (Some(at), Some(data), Some(logs)) =
            (disk.sampled_at, disk.data_bytes, disk.logs_bytes)
        {
            l1["metric_json"]["disk_data_bytes"] = json!(data.to_string());
            l1["metric_json"]["disk_logs_bytes"] = json!(logs.to_string());
            l1["metric_json"]["disk_dir_sampled_at"] =
                json!(chrono::DateTime::from_timestamp_millis(at)
                    .map(|v| v.to_rfc3339())
                    .unwrap_or_default());
        }
        // Preserve the full Pilot resource-alarm cadence and debounce semantics.
        if self
            .last_resource_check
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(600))
        {
            self.resources.check_thresholds(
                l1["cpu"].as_str().unwrap_or(""),
                l1["mem"].as_str().unwrap_or(""),
            );
            self.last_resource_check = Some(Instant::now());
        }
        for alarm in self.resources.drain_resource_alarms() {
            queue.retain_alarm(serde_json::to_value(alarm).expect("resource alarm"));
        }
        for key in [
            "updater_pid_alive",
            "runtime_bin_valid",
            "current_version_valid",
            "rollback_available",
            "version_count",
            "init_type",
        ] {
            l1[key] = json!("not-applicable");
        }
        l1["event.name"] = json!("pilot.metrics.l1");
        l1["metrics_scope"] = json!("host_process");
        l1["metric_json"]["mem_heap_available"] = json!("false");
        l1["metric_json"]["mem_heap_basis"] = json!("not-applicable-native-runtime");
        l1["metric_json"]["callback_duration_ms_total"] =
            json!((queue.callback_duration_us.load(Ordering::SeqCst) as f64 / 1000.0).to_string());
        let mut rows = vec![
            l1.clone(),
            json!({"event.name":"pilot.monitoring","snapshot":snapshot}),
        ];
        let timings = std::mem::take(&mut *queue.hook_timings.lock().unwrap());
        if let Some(l2) = self.metrics.collect_l2_with_hook_timings(&flow, &timings) {
            let mut l2 = serde_json::to_value(l2).expect("L2 metrics");
            l2["event.name"] = json!("pilot.metrics.l2");
            if let Some(hooks) = l2["hooks"].as_array_mut() {
                for row in hooks {
                    if let Some((channel, event)) = row["hook_event"]
                        .as_str()
                        .and_then(|s| s.split_once(':'))
                        .map(|(a, b)| (a.to_string(), b.to_string()))
                    {
                        row["hook_event"] = json!(event);
                        row["hook_channel"] = json!(channel);
                    }
                    row["timing_scope"] = json!("sdk_verdict");
                }
            }
            rows.push(l2);
        }
        rows.extend(queue.token_rows());
        rows.extend(queue.trace_rows());
        rows.into_iter()
            .map(|mut row| {
                for key in ["version", "user_id", "instance_id", "run_id", "__time__"] {
                    if row.get(key).is_none() {
                        row[key] = l1[key].clone();
                    }
                }
                serde_json::to_vec(&row).expect("monitoring JSON")
            })
            .collect()
    }
    pub fn pause(&self, stopping: &AtomicBool) {
        for _ in 0..10 {
            if stopping.load(Ordering::SeqCst) {
                break;
            }
            self.runtime
                .as_ref()
                .expect("monitor runtime")
                .block_on(async {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                });
        }
    }
}
impl Drop for Monitoring {
    fn drop(&mut self) {
        self.disk.stop();
        // Default Runtime drop waits for blocking file work; never time out unload.
        drop(self.runtime.take());
        crate::utils::source_access::install(None);
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::Delivery;
    use super::*;
    #[test]
    fn sdk_monitoring_reuses_resource_alarms_disk_and_hook_fields_with_real_scope() {
        let root = tempfile::tempdir().unwrap();
        let init: Init = serde_json::from_value(
            json!({"data_dir":root.path(),"resource_dir":root.path(),"user_id":"monitor-test"}),
        )
        .unwrap();
        let queue = Outbox::open(&root.path().join("outbox"), Delivery::default()).unwrap();
        let mut monitor = Monitoring::new(&init, &queue).unwrap();
        std::fs::create_dir_all(root.path().join("sources")).unwrap();
        std::fs::write(
            root.path().join("sources/checkpoint.json"),
            "{\"cursor\":42}",
        )
        .unwrap();
        monitor.runtime.as_ref().unwrap().block_on(async {
            monitor.disk.sample().await;
        });
        queue.record_hook("qoder", "cloud:PreToolUse", 12.75);
        for _ in 0..3 {
            monitor.resources.check_thresholds("90", "2049");
        }
        let rows = monitor.collect(DataflowSnapshot::default(), json!({}), &queue);
        let rows: Vec<Value> = rows
            .iter()
            .map(|b| serde_json::from_slice(b).unwrap())
            .collect();
        let l1 = rows
            .iter()
            .find(|r| r["event.name"] == "pilot.metrics.l1")
            .unwrap();
        assert_eq!(l1["metrics_scope"], "host_process");
        assert_eq!(l1["init_type"], "not-applicable");
        assert_eq!(l1["metric_json"]["disk_dir_status"], "ok");
        assert!(
            l1["metric_json"]["disk_data_bytes"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > 12
        );
        let l2 = rows
            .iter()
            .find(|r| r["event.name"] == "pilot.metrics.l2")
            .unwrap();
        assert_eq!(l2["hooks"][0]["calls"], "1");
        assert_eq!(l2["hooks"][0]["total_duration_ms"], "13");
        let alarms: Vec<Value> = queue
            .alarm_batch()
            .iter()
            .map(|a| serde_json::from_str(&a.1).unwrap())
            .collect();
        assert!(alarms
            .iter()
            .any(|r| r["alarm_type"] == "PROCESS_CPU_ALARM"));
        assert!(alarms
            .iter()
            .any(|r| r["alarm_type"] == "PROCESS_MEMORY_ALARM"));
        assert!(alarms.iter().all(|r| r["user_id"] == "monitor-test"
            && r["ver"] == env!("CARGO_PKG_VERSION")
            && r["__time__"].is_i64()));
        assert!(
            rows.iter()
                .any(|r| r["event.name"] == "pilot.trace_runtime"
                    && r["converter_available"] == false)
        );
    }
}
