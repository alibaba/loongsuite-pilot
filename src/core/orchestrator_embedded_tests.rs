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
async fn embedded_opencode_uses_sdk_and_links_native_session_before_privacy() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let history = root.join("logs/opencode");
    let correlate = root.join("acp-correlate");
    std::fs::create_dir_all(&history).unwrap();
    std::fs::create_dir_all(&correlate).unwrap();
    let log = history.join(format!(
        "opencode-{}.jsonl",
        crate::utils::get_today_date_string()
    ));
    std::fs::File::create(&log).unwrap();
    let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    let parent = "00f067aa0ba902b7";
    let relation = json!({
        "type": "turn",
        "sessionId": "native-session",
        "contentPrefix": "synthetic prefix",
        "traceparent": format!("00-{trace}-{parent}-01")
    });
    std::fs::write(
        correlate.join("native-session.jsonl"),
        format!("{relation}\n"),
    )
    .unwrap();
    let mut config = config(&root);
    let opencode = config.agents.get_mut("opencode").unwrap();
    opencode.enabled = Some(true);
    opencode.capture_message_content = Some(false);
    let listener = config.listeners.get_mut("opencode-log").unwrap();
    listener.enabled = true;
    listener.poll_interval = 35;
    config.upstream_link.enabled = true;
    let options = CollectorRuntimeOptions::embedded(root.to_string_lossy(), output(&root)).unwrap();
    let runtime = Arc::new(Orchestrator::with_runtime_options(config, options).unwrap());
    runtime.start().await.unwrap();
    let input = runtime.inputs.get_input("opencode-log").unwrap();
    assert_eq!(input.collection_method, "sdk-hosted");
    assert_eq!(
        input.runtime_info().unwrap().source_paths,
        [history.to_string_lossy()]
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while !input.running() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let checkpoint_dir = root.join("state/standalone-opencode-sdk/outbox");
    assert!(checkpoint_dir.join("delivery.sqlite").is_file());
    let event = json!({
        "event.id": "fixture-opencode-input",
        "event.name": "other",
        "gen_ai.agent.type": "opencode",
        "gen_ai.session.id": "native-session",
        "gen_ai.turn.id": "native-turn",
        "agent.pilot.invocation.session.id": "external-session",
        "gen_ai.input.messages_delta": [
            {"role": "user", "parts": [{"type": "text", "content": "synthetic prefix with private text"}]}
        ],
        "time_unix_nano": "1780000000000000000"
    });
    std::fs::write(&log, format!("{event}\n")).unwrap();
    let delivered = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(row) = std::fs::read_dir(root.join("host-output"))
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|file| file.path().extension().is_some_and(|ext| ext == "jsonl"))
                .filter_map(|file| std::fs::read_to_string(file.path()).ok())
                .flat_map(|body| {
                    body.lines()
                        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                        .collect::<Vec<_>>()
                })
                .find(|row| row["event.id"] == "fixture-opencode-input")
            {
                break row;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    runtime.stop().await;
    let row = delivered.expect("embedded SDK did not deliver OpenCode event");
    assert_eq!(row["gen_ai.session.id"], "external-session");
    assert_eq!(row["trace_id"], trace);
    assert_eq!(row["parent_span_id"], parent);
    assert!(row.get("gen_ai.input.messages_delta").is_none());
    assert!(row
        .get(crate::sdk::hook_history::PRIVACY_POLICY_FIELD)
        .is_none());
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
    assert!(runtime.qoder_hooks.lock().unwrap().is_none());
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
