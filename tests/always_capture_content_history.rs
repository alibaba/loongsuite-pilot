//! Historical content contracts through the actual manager, native converter,
//! fanout and on-disk JSONL. SLS/HTTP contract sinks are controlled, as in TS.
use async_trait::async_trait;
use loongsuite_pilot::core::InputManager;
use loongsuite_pilot::flushers::{
    BaseFlusher, FlushError, JsonlFlusher, MultiFlusher, OtlpTraceFlusher, ReadableSpan,
    TraceExporter,
};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
struct Capture(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
#[derive(Default)]
struct Events(Mutex<Vec<AgentActivityEntry>>);
#[async_trait]
impl BaseFlusher for Events {
    fn name(&self) -> &str {
        "controlled-event-contract"
    }
    async fn send(&self, entry: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.send_batch(vec![entry], None).await
    }
    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.0.lock().unwrap().extend(entries);
        Ok(())
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
fn turn(content: &str) -> Vec<AgentActivityEntry> {
    let common = json!({"user.id":"test-user","gen_ai.agent.type":"claude-code","gen_ai.provider.name":"anthropic",
        "gen_ai.session.id":"test-session","gen_ai.turn.id":"test-turn","gen_ai.step.id":"test-step",
        "gen_ai.request.model":"test-model","git.repo":"synthetic/repo","git.branch":"fixture"});
    [
        json!({"time_unix_nano":"1700000000000000000","event.id":"request","event.name":"llm.request",
            "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":content}]}],
            "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":content}]}],
            "gen_ai.system_instructions":[{"type":"text","content":format!("system {content}")}],
            "gen_ai.tool.definitions":[{"type":"function","name":"test_tool","description":content,"parameters":{}}]}),
        json!({"time_unix_nano":"1700000000100000000","event.id":"tool-call","event.name":"tool.call",
            "gen_ai.tool.name":"test_tool","gen_ai.tool.call.id":"test-call","gen_ai.tool.call.arguments":{"text":content}}),
        json!({"time_unix_nano":"1700000000200000000","event.id":"tool-result","event.name":"tool.result",
            "gen_ai.tool.name":"test_tool","gen_ai.tool.call.id":"test-call","gen_ai.tool.call.result":{"text":content}}),
        json!({"time_unix_nano":"1700000000300000000","event.id":"response","event.name":"llm.response",
            "gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.input_tokens":5,"gen_ai.usage.output_tokens":3,
            "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":content}]}]})
    ].into_iter().map(|v|{let mut base=common.as_object().unwrap().clone();base.extend(v.as_object().unwrap().clone());serde_json::from_value(Value::Object(base)).unwrap()}).collect()
}
fn trace(root: &Path, spans: Arc<Mutex<Vec<ReadableSpan>>>) -> OtlpTraceFlusher {
    let capture = Arc::new(Capture(spans));
    OtlpTraceFlusher::with_parts(
        serde_json::from_value(json!({
            "enabled":true,"endpoints":[{"name":"controlled","endpoint":"http://127.0.0.1:1"}],
            "protocol":"http/protobuf","serviceName":"always-capture-test","dataDir":root,
            "captureMessageContent":false,"turnIdleTimeoutMs":0
        }))
        .unwrap(),
        None,
        Some(Arc::new(move |_| capture.clone() as Arc<dyn TraceExporter>)),
        None,
    )
    .unwrap()
}
fn assert_spans(spans: &[ReadableSpan], sentinel: &str) {
    let llm = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect::<Vec<_>>();
    let tool = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("TOOL")))
        .collect::<Vec<_>>();
    assert_eq!(llm.len(), 1);
    assert_eq!(tool.len(), 1);
    for key in [
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
        "gen_ai.tool.definitions",
    ] {
        assert!(
            llm[0].attributes[key].to_string().contains(sentinel),
            "missing {key}"
        );
    }
    for key in ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"] {
        assert!(
            tool[0].attributes[key].to_string().contains(sentinel),
            "missing {key}"
        );
    }
    assert_eq!(
        llm[0].attributes["gen_ai.usage.input_tokens"].as_f64(),
        Some(5.0)
    );
    assert_eq!(
        llm[0].attributes["gen_ai.usage.output_tokens"].as_f64(),
        Some(3.0)
    );
}
async fn child(mode: Option<&str>, name: &str) {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let mut c = tokio::process::Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", name, "--nocapture"])
        .env_clear()
        .env("PILOT_CAPTURE_HISTORY_CHILD", "1")
        .env("OTEL_SEMCONV_STABILITY_OPT_IN", "http")
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("CODEX_HOME", home.join("codex"))
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .env("GIT_CONFIG_GLOBAL", home.join("no-git"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("PATH", home.join("no-runtimes"))
        .current_dir(&home)
        .kill_on_drop(true);
    if let Some(mode) = mode {
        c.env("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", mode);
    }
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PATHEXT",
    ] {
        if let Some(v) = std::env::var_os(key) {
            c.env(key, v);
        }
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), c.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "mode {mode:?}:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[tokio::test]
async fn l81_all_seven_inherited_capture_modes_export_complete_real_trace_content() {
    if std::env::var_os("PILOT_CAPTURE_HISTORY_CHILD").is_none() {
        let name = std::thread::current().name().unwrap().to_owned();
        for mode in [
            None,
            Some(""),
            Some("NO_CONTENT"),
            Some("EVENT_ONLY"),
            Some("SPAN_ONLY"),
            Some("SPAN_AND_EVENT"),
            Some("invalid"),
        ] {
            child(mode, &name).await;
        }
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let spans = Arc::new(Mutex::new(Vec::new()));
    let flusher = trace(root.path(), spans.clone());
    flusher
        .send_batch(turn("content-sentinel"), None)
        .await
        .unwrap();
    flusher.shutdown().await.unwrap();
    assert_eq!(
        std::env::var("OTEL_SEMCONV_STABILITY_OPT_IN").unwrap(),
        "http,gen_ai_latest_experimental"
    );
    assert_spans(&spans.lock().unwrap(), "content-sentinel");
}
#[tokio::test]
async fn l107_actual_manager_fanout_masks_secrets_but_keeps_content_in_jsonl_events_and_native_spans(
) {
    if std::env::var_os("PILOT_CAPTURE_HISTORY_CHILD").is_none() {
        let name = std::thread::current().name().unwrap().to_owned();
        child(Some("NO_CONTENT"), &name).await;
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let spans = Arc::new(Mutex::new(Vec::new()));
    let trace = Arc::new(trace(root.path(), spans.clone()));
    let directory = root.path().join("output");
    let jsonl = Arc::new(JsonlFlusher::new(
        serde_json::from_value(
            json!({"enabled":true,"outputDir":directory,"rotateDaily":false,"maxFileSizeMb":1}),
        )
        .unwrap(),
    ));
    let sls = Arc::new(Events::default());
    let http = Arc::new(Events::default());
    let output = Arc::new(MultiFlusher::new(vec![
        jsonl,
        sls.clone(),
        http.clone(),
        trace,
    ]));
    output.start().await.unwrap();
    let manager = InputManager::new();
    manager.set_agents_config(
        &serde_json::from_value(json!({"claude-code":{"captureMessageContent":false}})).unwrap(),
    );
    manager.set_mask_config(
        serde_json::from_value(json!({"mode":"all","types":[],"replacementMode":"placeholder"}))
            .unwrap(),
    );
    manager.set_flusher(output.clone());
    let api = "sk-1234567890abcdefghijklmnop";
    manager
        .flush_prepared_entries(turn(&format!("ordinary-content {api}")))
        .await
        .unwrap();
    output.shutdown().await.unwrap();
    let mut disk = Vec::<Value>::new();
    for file in std::fs::read_dir(&directory).unwrap() {
        let file = file.unwrap();
        disk.extend(
            std::fs::read_to_string(file.path())
                .unwrap()
                .lines()
                .map(|s| serde_json::from_str::<Value>(s).unwrap()),
        );
    }
    assert_eq!(disk.len(), 4);
    let mut event_sets = vec![serde_json::to_string(&disk).unwrap()];
    for sink in [sls, http] {
        let entries = sink.0.lock().unwrap();
        assert_eq!(entries.len(), 4);
        event_sets.push(serde_json::to_string(&*entries).unwrap());
    }
    for text in event_sets {
        assert!(text.contains("ordinary-content"));
        assert!(text.contains("[APIKEY_MASKED]"));
        assert!(!text.contains(api));
    }
    let spans = spans.lock().unwrap();
    assert_spans(&spans, "ordinary-content");
    let text =
        serde_json::to_string(&spans.iter().map(|s| &s.attributes).collect::<Vec<_>>()).unwrap();
    assert!(text.contains("[APIKEY_MASKED]"));
    assert!(!text.contains(api));
}
