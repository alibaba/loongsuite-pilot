//! Exercise the complete runtime writer, in addition to SDK callback monitoring.
use loongsuite_pilot::metrics::{DataflowSnapshot, MetricsWriter, MetricsWriterOptions};
use std::time::{Duration, Instant};

#[tokio::test]
async fn complete_runtime_writes_real_process_resources() {
    // A minimal optimized writer may have less than two MiB of resident code.
    // Touch and retain a known working set so RSS accuracy is tested directly.
    const RESIDENT_BYTES: usize = 16 * 1024 * 1024;
    let resident = vec![std::hint::black_box(1_u8); RESIDENT_BYTES];
    std::hint::black_box(&resident);
    let root = tempfile::tempdir().unwrap();
    let mut options = MetricsWriterOptions::new(
        root.path().to_string_lossy(),
        "native-test",
        "native-test",
        DataflowSnapshot::default,
    );
    options.auto_update_enabled = false;
    let writer = MetricsWriter::new(options);
    writer.write_l1().await;
    let until = Instant::now() + sysinfo::MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_millis(100);
    let mut value = 1_u64;
    while Instant::now() < until {
        value = std::hint::black_box(value.wrapping_mul(6364136223846793005).wrapping_add(1));
    }
    std::hint::black_box(value);
    writer.write_l1().await;
    let directory = root.path().join("logs/metric_alarm");
    let path = std::fs::read_dir(directory)
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("pilot-metrics-")
        })
        .unwrap()
        .path();
    let text = std::fs::read_to_string(path).unwrap();
    let row: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    let cpu = row["cpu"].as_str().unwrap().parse::<f64>().unwrap();
    let memory = row["mem"].as_str().unwrap().parse::<f64>().unwrap();
    assert!(
        cpu.is_finite() && cpu > 0.0,
        "busy CPU must be observed: {row}"
    );
    assert!(memory > 1.0, "RSS must reflect the process: {row}");
    assert!(
        memory >= (RESIDENT_BYTES / 1_048_576) as f64,
        "RSS must include the retained resident allocation: {row}"
    );
    #[cfg(not(target_os = "linux"))]
    {
        assert_eq!(row["metric_json"]["cpu_available"], "true");
        assert_eq!(row["metric_json"]["mem_available"], "true");
        assert_eq!(
            row["metric_json"]["process_resource_metrics_basis"],
            "sysinfo_self_process"
        );
        assert!(row.get("mem_heap").is_none());
        assert!(!row["os_detail"].as_str().unwrap().contains("unknown"));
    }
    std::hint::black_box(resident);
}
