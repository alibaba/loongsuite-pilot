//! Actual EventLog conversion → embedded enricher → all exporters/debug/failure.
use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::types::{AgentActivityEntry, AgentEventName, OtlpTraceFlusherConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

type Captured = Arc<Mutex<HashMap<String, Vec<ReadableSpan>>>>;
struct Exporter {
    name: String,
    failed: bool,
    captured: Captured,
}
#[async_trait]
impl TraceExporter for Exporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.captured
            .lock()
            .unwrap()
            .entry(self.name.clone())
            .or_default()
            .extend(spans);
        if self.failed {
            Err("synthetic backend failure".into())
        } else {
            Ok(())
        }
    }
    async fn shutdown(&self) {}
}
fn records() -> Vec<AgentActivityEntry> {
    let mut entries: Vec<AgentActivityEntry> =
        include_str!("unit/flushers/otlp-trace-flusher/fixtures/cp5-events.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    for entry in &mut entries {
        if entry.event_name == Some(AgentEventName::ToolCall) {
            entry
                .extra
                .insert("gen_ai.skill.name".into(), json!("builtin"));
        }
    }
    entries
}
fn flusher(root: &Path, paths: Vec<String>, captured: Captured) -> OtlpTraceFlusher {
    let config: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"serviceName":"test","protocol":"http/protobuf","dataDir":root,
        "debug":true,"turnIdleTimeoutMs":0,"spanEnricherPaths":paths,
        "endpoints":[
            {"name":"primary","endpoint":"http://127.0.0.1:4318"},
            {"name":"secondary","endpoint":"http://127.0.0.1:4319","serviceName":"managed"},
            {"name":"failed","endpoint":"http://127.0.0.1:4320"}
        ]
    }))
    .unwrap();
    OtlpTraceFlusher::with_parts_and_enricher_worker(
        config,
        None,
        Some(Arc::new(move |options| {
            Arc::new(Exporter {
                name: options.name.clone(),
                failed: options.name == "failed",
                captured: captured.clone(),
            })
        })),
        None,
        Some(env!("CARGO_BIN_EXE_loongsuite-pilot").into()),
    )
    .unwrap()
}
async fn rows(root: &Path, folder: &str) -> Vec<Value> {
    let mut files = tokio::fs::read_dir(root.join("logs").join(folder))
        .await
        .unwrap();
    let mut rows = Vec::new();
    while let Some(file) = files.next_entry().await.unwrap() {
        assert_eq!(file.path().extension().unwrap(), "jsonl");
        rows.extend(
            tokio::fs::read_to_string(file.path())
                .await
                .unwrap()
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_str::<Value>(line).unwrap()),
        );
    }
    rows
}

#[tokio::test]
async fn native_esm_enrichment_reaches_real_conversion_all_services_debug_and_failed_records() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("skill.mjs");
    tokio::fs::write(&path,r#"export default{enrich(span,context){
        const a=span.attributes;
        if(a['gen_ai.span.kind']!=='TOOL')return;
        if(!a['gen_ai.tool.call.arguments']||!a['gen_ai.tool.call.result'])throw new Error('Missing tool content');
        return{'gen_ai.skill.name':a['gen_ai.skill.name']+':'+a['gen_ai.tool.name'],
            'test.service':context.serviceName,'test.agent':context.agentType};
    }};"#).await.unwrap();
    let captured: Captured = Arc::new(Mutex::new(HashMap::new()));
    let flusher = flusher(
        root.path(),
        vec![path.to_string_lossy().into_owned()],
        captured.clone(),
    );
    flusher.send_batch(records(), None).await.unwrap();
    flusher.flush().await.unwrap();
    flusher.shutdown().await.unwrap();
    {
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 3);
        for (name, spans) in captured.iter() {
            assert_eq!(spans.len(), 10, "{name}");
            let tools: Vec<_> = spans
                .iter()
                .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
                .collect();
            assert_eq!(tools.len(), 2);
            for tool in tools {
                assert_eq!(
                    tool.attributes["gen_ai.skill.name"],
                    format!(
                        "builtin:{}",
                        tool.attributes["gen_ai.tool.name"].as_str().unwrap()
                    )
                );
                assert_eq!(
                    tool.attributes["test.service"],
                    if name == "secondary" {
                        "managed-openclaw"
                    } else {
                        "test-openclaw"
                    }
                );
                assert_eq!(tool.attributes["test.agent"], "openclaw");
                assert!(tool.ended);
                assert!(tool.duration[0] > 0 || tool.duration[1] > 0);
            }
            assert!(spans
                .iter()
                .filter(|span| span.attributes.get("gen_ai.span.kind") != Some(&json!("TOOL")))
                .all(|span| !span.attributes.contains_key("gen_ai.skill.name")));
        }
    }
    for (folder, expected) in [("otlp-debug", 20), ("otlp-failed", 10)] {
        let rows = rows(root.path(), folder).await;
        assert_eq!(rows.len(), expected, "{folder}");
        let tools: Vec<_> = rows
            .iter()
            .filter(|row| row["attributes"]["gen_ai.span.kind"] == "TOOL")
            .collect();
        assert!(!tools.is_empty());
        assert!(tools
            .iter()
            .all(|tool| tool["attributes"]["gen_ai.skill.name"]
                .as_str()
                .unwrap()
                .starts_with("builtin:")));
        assert!(tools
            .iter()
            .all(|tool| tool["attributes"]["test.agent"] == "openclaw"));
    }
}

#[tokio::test]
async fn bad_or_unsupported_modules_do_not_disable_real_trace_export_or_expose_plugin_exceptions() {
    let root = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for(name,source)in[
        ("throw","export default{enrich(){throw new Error('SYNTHETIC_PRIVATE_ENRICHER_EXCEPTION');}};"),
        // Explicitly a failure-isolation test, not a claim of Node API compatibility.
        ("unsupported","import fs from 'node:fs';export default{enrich(){return {unsupported:true};}};"),
        ("healthy","export default{enrich(s,c){if(s.attributes['gen_ai.span.kind']==='TOOL')return{'test.healthy':true,'test.service':c.serviceName};}};")
    ]{
        let path=root.path().join(format!("{name}.mjs"));tokio::fs::write(&path,source).await.unwrap();paths.push(path.to_string_lossy().into_owned());
    }
    let captured: Captured = Arc::new(Mutex::new(HashMap::new()));
    let flusher = flusher(root.path(), paths, captured.clone());
    flusher.send_batch(records(), None).await.unwrap();
    flusher.shutdown().await.unwrap();
    {
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 3);
        for spans in captured.values() {
            assert_eq!(spans.len(), 10);
            assert!(spans
                .iter()
                .filter(|span| span.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
                .all(|span| span.attributes["test.healthy"] == true));
        }
    }
    for folder in ["otlp-debug", "otlp-failed"] {
        let rows = rows(root.path(), folder).await;
        assert!(!rows.is_empty());
        assert!(!serde_json::to_string(&rows)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_ENRICHER_EXCEPTION"));
        assert!(rows
            .iter()
            .all(|row| row["attributes"].get("unsupported").is_none()));
    }
}
