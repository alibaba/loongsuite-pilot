use super::*;
use crate::core::{assemble_config, ConfigSources};
use crate::types::{AgentActivityEntry, AgentConfig, AgentEventName, ClientType};
use serde_json::json;

fn config(root: &Path) -> AnalyticsConfig {
    let env = HashMap::new();
    let file = json!({
        "dataDir": root,
        "userId": "sdk-fixture",
        "jsonl": {
            "enabled": true,
            "outputDir": root.join("configured-output")
        },
        "dashboard": { "enabled": true },
        "statusBar": { "enabled": true },
        "autoUpdate": { "enabled": true }
    });
    let mut config = assemble_config(
        Some(&file),
        None,
        &ConfigSources {
            env: &env,
            platform: crate::utils::Platform::current(),
            hostname: "sdk-fixture",
            config_path: "isolated-sdk-config.json",
            global_poll_ms: None,
        },
    )
    .unwrap();
    for client in ClientType::ALL {
        config.agents.insert(
            client.as_str().into(),
            AgentConfig {
                enabled: Some(false),
                ..Default::default()
            },
        );
    }
    for listener in config.listeners.values_mut() {
        listener.enabled = false;
    }
    config
}

fn output(root: &Path) -> Arc<dyn BaseFlusher> {
    Arc::new(JsonlFlusher::new(
        serde_json::from_value(json!({
            "enabled": true,
            "outputDir": root.join("host-output"),
            "rotateDaily": false,
            "maxFileSizeMb": 1
        }))
        .unwrap(),
    ))
}

#[tokio::test]
async fn embedded_runtime_reuses_collector_output_without_host_services() {
    let temp = tempfile::tempdir().unwrap();
    // A host-owned install record is irrelevant to the embedded collector.
    let report = temp.path().join("last-hook-install.json");
    std::fs::write(&report, "host-owned-invalid-record").unwrap();
    let options = CollectorRuntimeOptions::embedded(
        temp.path().to_string_lossy().into_owned(),
        output(temp.path()),
    )
    .unwrap();
    let runtime =
        Arc::new(Orchestrator::with_runtime_options(config(temp.path()), options).unwrap());
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    runtime.on_event(move |event| captured.lock().unwrap().push(event));
    tokio::time::timeout(Duration::from_secs(5), runtime.start())
        .await
        .unwrap()
        .unwrap();

    assert!(*runtime.running.lock().unwrap());
    assert!(runtime.deployment.lock().unwrap().is_none());
    assert!(runtime.workers.lock().unwrap().is_none());
    assert!(runtime.hook_watchdog.lock().unwrap().is_none());
    assert!(runtime.updater_watchdog.lock().unwrap().is_none());
    assert!(runtime.signal_task.lock().unwrap().is_none());
    assert!(runtime.dashboard.lock().unwrap().is_none());
    assert!(runtime.status_bar.lock().unwrap().is_none());
    assert!(runtime.interceptor.lock().unwrap().is_none());
    assert!(runtime.metrics.lock().unwrap().is_none());
    assert!(runtime.pipeline.lock().unwrap().is_none());
    assert!(runtime.sls.lock().unwrap().is_none());
    assert!(runtime.otlp.lock().unwrap().is_none());
    assert!(runtime.inputs.get_active_input_ids().is_empty());

    runtime
        .input_manager()
        .flush_prepared_entries(vec![AgentActivityEntry {
            event_id: "embedded-output".into(),
            time_unix_nano: "1700000000000000000".into(),
            event_name: Some(AgentEventName::Other),
            agent_type: "qoder".into(),
            session_id: "sdk-session".into(),
            ..Default::default()
        }])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), runtime.stop())
        .await
        .unwrap();
    assert!(!*runtime.running.lock().unwrap());
    assert!(!temp.path().join("configured-output").exists());
    assert_eq!(
        std::fs::read_to_string(report).unwrap(),
        "host-owned-invalid-record"
    );
    let rows: Vec<serde_json::Value> = std::fs::read_dir(temp.path().join("host-output"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .map(|path| std::fs::read_to_string(path).unwrap())
        .flat_map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["event.id"], "embedded-output");
    let events = events.lock().unwrap();
    assert_eq!(events.first(), Some(&OrchestratorEvent::Starting));
    assert_eq!(events.last(), Some(&OrchestratorEvent::Stopped));
}

#[test]
fn embedded_runtime_requires_explicit_absolute_directories() {
    let temp = tempfile::tempdir().unwrap();
    assert!(CollectorRuntimeOptions::embedded("relative-assets", output(temp.path())).is_err());
    let options = CollectorRuntimeOptions::embedded(
        temp.path().to_string_lossy().into_owned(),
        output(temp.path()),
    )
    .unwrap();
    let mut config = config(temp.path());
    config.data_dir = "relative-data".into();
    assert!(Orchestrator::with_runtime_options(config, options).is_err());
    assert!(!temp.path().join("host-output").exists());
}
