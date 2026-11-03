//! Real collector construction supplies the real flusher snapshot to MetricsWriter.
use super::*;
use crate::flushers::CodexTurnJournal;
use crate::internal::{clear_sends, recorded_sends};
use serde_json::json;

#[tokio::test]
async fn actual_orchestrator_metrics_writer_emits_spill_gauges_and_omits_unjournaled_gauges() {
    let root = tempfile::tempdir().unwrap();
    let env = HashMap::new();
    let file = json!({"dataDir":root.path(),"dashboard":{"enabled":false},
        "autoUpdate":{"enabled":false},"jsonl":{"enabled":false}});
    let config = super::super::config_loader::assemble_config(
        Some(&file),
        None,
        &super::super::config_loader::ConfigSources {
            env: &env,
            platform: crate::utils::Platform::current(),
            hostname: "spill-runtime-fixture",
            config_path: "spill-runtime-fixture.json",
            global_poll_ms: None,
        },
    )
    .unwrap();
    let orch = Orchestrator::new(config);
    let otlp_cfg: crate::types::OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"serviceName":"spill-runtime-fixture","protocol":"http/protobuf",
        "endpoints":[{"name":"test","endpoint":"http://unused:4318","headers":{}}],
        "dataDir":root.path(),"turnIdleTimeoutMs":0
    }))
    .unwrap();
    let journal = Arc::new(CodexTurnJournal::new(root.path().join("pending")));
    let durable = Arc::new(
        OtlpTraceFlusher::new(otlp_cfg.clone())
            .unwrap()
            .with_codex_journal(journal, Ok),
    );
    let entry: AgentActivityEntry = serde_json::from_value(json!({
        "event.name":"llm.request","event.id":"prefix","user.id":"owner",
        "gen_ai.agent.type":"codex","gen_ai.session.id":"session","gen_ai.turn.id":"turn",
        "gen_ai.input.messages":"x".repeat(9*1024*1024)
    }))
    .unwrap();
    durable.send(entry.clone(), Some(1.0)).await.unwrap();
    *orch.otlp.lock().unwrap() = Some(durable.clone());
    clear_sends();
    let writer = orch.metrics_writer(
        "2.0.0",
        Arc::new(AlarmManager::new("127.0.0.1", "2.0.0", "fixture")),
    );
    writer.write_l1().await;
    let sent = recorded_sends();
    let row = &sent
        .iter()
        .find(|row| row.topic == "pilot_trace_runtime")
        .unwrap()
        .fields;
    for (key, value) in [
        ("pending_records", "1"),
        ("pending_logical_bytes", "1"),
        ("resident_records", "0"),
        ("resident_payload_bytes", "0"),
        ("spilled_buffers", "1"),
        ("spilled_records", "1"),
        ("schema_version", "2"),
        ("buffer_scope", "pending_conversion"),
    ] {
        assert_eq!(row.get(key).map(String::as_str), Some(value), "{key}");
    }
    assert!(!row.values().any(|v| v.contains(&"x".repeat(128))));
    // Construct a distinct unjournaled flusher: with_codex_journal is a shared-inner
    // builder, so cloning the durable instance would preserve its journal.
    let unjournaled = Arc::new(OtlpTraceFlusher::new(otlp_cfg).unwrap());
    unjournaled.send(entry, None).await.unwrap();
    *orch.otlp.lock().unwrap() = Some(unjournaled);
    clear_sends();
    let writer = orch.metrics_writer(
        "2.0.0",
        Arc::new(AlarmManager::new("127.0.0.1", "2.0.0", "fixture")),
    );
    writer.write_l1().await;
    let sent = recorded_sends();
    let row = &sent
        .iter()
        .find(|row| row.topic == "pilot_trace_runtime")
        .unwrap()
        .fields;
    for key in [
        "resident_records",
        "resident_payload_bytes",
        "spilled_buffers",
        "spilled_records",
    ] {
        assert!(
            !row.contains_key(key),
            "{key} must be omitted without durable Codex journal"
        );
    }
}
