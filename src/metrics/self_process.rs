//! Instance-owned native sampling shared by the complete runtime and SDK.
use super::L1Metrics;
use std::time::Instant;

pub(super) struct SelfProcess {
    system: sysinfo::System,
    primed_at: Instant,
}

impl SelfProcess {
    pub fn new() -> Self {
        let mut value = Self {
            system: sysinfo::System::new(),
            primed_at: Instant::now(),
        };
        value.refresh();
        value.primed_at = Instant::now();
        value
    }

    fn refresh(&mut self) {
        // Request CPU and RSS for this process only, without environment or command lines.
        self.system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(std::process::id())]),
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory(),
        );
    }

    pub fn apply(&mut self, row: &mut L1Metrics, custom_cpu: bool) {
        self.refresh();
        let process = self
            .system
            .process(sysinfo::Pid::from_u32(std::process::id()));
        // CPU requires an observation interval; an unavailable sample is not zero usage.
        let cpu = process.map(|p| p.cpu_usage()).filter(|v| {
            v.is_finite() && self.primed_at.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
        });
        let mem = process.map(|p| p.memory()).filter(|v| *v > 0);
        if !custom_cpu {
            row.cpu = cpu.map(|v| v.to_string()).unwrap_or_default();
        }
        row.mem = mem
            .map(|v| v.div_ceil(1_048_576).to_string())
            .unwrap_or_default();
        row.mem_heap.clear();
        row.metric_json.cpu_available = Some((custom_cpu || cpu.is_some()).to_string());
        row.metric_json.mem_available = Some(mem.is_some().to_string());
        row.metric_json.mem_heap_available = Some("false".into());
        row.metric_json.process_resource_metrics_basis = Some("sysinfo_self_process".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{DataflowSnapshot, MetricsCollector};
    use std::time::Duration;

    #[test]
    fn native_resources_report_rss_and_busy_cpu_without_fabricated_warmup() {
        let root = tempfile::tempdir().unwrap();
        let mut collector = MetricsCollector::new(
            "test",
            "native-resource-test",
            root.path().to_string_lossy(),
        );
        let mut row = collector.collect_l1(&DataflowSnapshot::default());
        let mut process = SelfProcess::new();
        process.primed_at = Instant::now() + Duration::from_secs(60);
        process.apply(&mut row, false);
        let json = serde_json::to_value(&row).unwrap();
        assert!(row.mem.parse::<f64>().unwrap() > 1.0);
        assert_eq!(row.metric_json.cpu_available.as_deref(), Some("false"));
        assert!(json.get("cpu").is_none() && json.get("mem_heap").is_none());
        process.primed_at = Instant::now();
        let until =
            Instant::now() + sysinfo::MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_millis(50);
        let mut value = 1_u64;
        while Instant::now() < until {
            value = std::hint::black_box(value.wrapping_mul(6364136223846793005).wrapping_add(1));
        }
        std::hint::black_box(value);
        process.apply(&mut row, false);
        assert_eq!(row.metric_json.cpu_available.as_deref(), Some("true"));
        assert!(row.cpu.parse::<f64>().unwrap() > 0.0);
        row.cpu = "42".into();
        process.apply(&mut row, true);
        assert_eq!(row.cpu, "42", "preserve injected CPU probes");
    }
}
