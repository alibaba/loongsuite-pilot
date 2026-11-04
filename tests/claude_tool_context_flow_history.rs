//! Exact four historical flows through the deployed shell, native hook and OTLP.
//! The downstream receiver is an actual independent Bash CLI, requiring no Node.
#![cfg(unix)]
use async_trait::async_trait;
use loongsuite_pilot::core::{CorrelationStore, TraceLinker};
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
const TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const UPSTREAM: &str = "00f067aa0ba902b7";
const STATE: &str = "vendor=value,tenant=O'Reilly";
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn isolated(c: &mut tokio::process::Command, root: &Path) {
    c.env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("CODEX_HOME", root.join("codex"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env("GIT_CONFIG_GLOBAL", root.join("no-git"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("PATH", root.join("no-runtimes"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
}
async fn finish(c: &mut tokio::process::Command, input: Option<&Value>) -> Output {
    let mut child = c.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
        stdin.write_all(input.to_string().as_bytes()).await.unwrap();
    }
    drop(stdin);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "status={} stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}
fn binding(root: &Path) -> PathBuf {
    let hooks = root.join("hooks");
    std::fs::create_dir_all(hooks.join("shared")).unwrap();
    for file in ["claude-code-loongsuite-pilot-hook.sh", "shared/native.sh"] {
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("assets/hooks")
                .join(file),
            hooks.join(file),
        )
        .unwrap();
    }
    std::fs::write(
        hooks.join("pilot-bin"),
        format!("{}\n", env!("CARGO_BIN_EXE_loongsuite-pilot")),
    )
    .unwrap();
    hooks
}
struct Capture(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
async fn export(root: &Path, entries: Vec<AgentActivityEntry>) -> Vec<ReadableSpan> {
    let spans = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::new(Capture(spans.clone()));
    let f=OtlpTraceFlusher::with_parts(serde_json::from_value(json!({"enabled":true,"endpoints":[{"name":"capture","endpoint":"http://127.0.0.1:1"}],"protocol":"http/protobuf","serviceName":"flow-test","dataDir":root,"turnIdleTimeoutMs":0})).unwrap(),None,Some(Arc::new(move |_|capture.clone() as Arc<dyn TraceExporter>)),None).unwrap();
    f.send_batch(entries, None).await.unwrap();
    f.flush().await.unwrap();
    f.shutdown().await.unwrap();
    let out = spans.lock().unwrap().clone();
    out
}
async fn flow(mode: u8) {
    let root = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let r = root.path();
    let data = r.join("data");
    std::fs::create_dir(&data).unwrap();
    let hooks = binding(r);
    std::fs::write(data.join("config.json"),json!({"upstreamLink":{"enabled":true,"propagateToTools":mode!=3,"generateTraceWhenMissing":mode==1 || mode==2}}).to_string()).unwrap();
    let resources = match mode {
        0 => "team=O'Reilly,deployment.environment.name=prod",
        1 => "team=infra,deployment.environment.name=staging",
        2 => "team=acp",
        _ => "",
    };
    let prompt = if mode == 2 {
        "run the ACP downstream demo cli"
    } else {
        "run the downstream demo cli"
    };
    let correlate = data.join("acp-correlate");
    std::fs::create_dir(&correlate).unwrap();
    if mode == 2 {
        std::fs::write(correlate.join("flow-session.jsonl"),format!("{}\n",json!({"type":"turn","sessionId":"flow-session","contentHash":loongsuite_pilot::utils::content_hash::content_hash(prompt),"contentPrefix":prompt,"traceparent":"00-dddddddddddddddddddddddddddddddd-eeeeeeeeeeeeeeee-01"}))).unwrap();
    }
    let receiver = r.join("user's receiver.sh");
    let output = r.join("demo output").join("received-context");
    std::fs::create_dir(output.parent().unwrap()).unwrap();
    // No environment echo from the test: this distinct process reads its own
    // environment after Bash has interpreted the actual hook replacement.
    std::fs::write(&receiver,r#"set -eu
out="$2"
valid=false
if [[ "${TRACEPARENT-}" =~ ^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$ ]] && [[ "${BASH_REMATCH[1]}" != 00000000000000000000000000000000 && "${BASH_REMATCH[2]}" != 0000000000000000 ]]; then valid=true; fi
printf '%s\0' "${TRACEPARENT-}" "${TRACESTATE-}" "${OTEL_RESOURCE_ATTRIBUTES-}" "$valid" > "$out"
printf 'downstream received context\n'
if [[ "$valid" != true && "${3-}" != --allow-missing ]]; then exit 2; fi
"#).unwrap();
    let original = format!(
        "/bin/bash {} --output {}{}",
        quote(receiver.to_str().unwrap()),
        quote(output.to_str().unwrap()),
        if mode >= 2 { " --allow-missing" } else { "" }
    );
    let tool = json!({"command":original,"description":"run downstream trace receiver","timeout":5000,"run_in_background":false});
    let payload = json!({"session_id":"flow-session","prompt_id":"prompt-1","cwd":r,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"toolu_demo_cli","tool_input":tool});
    let mut c = tokio::process::Command::new("/bin/bash");
    isolated(&mut c, r);
    c.arg(hooks.join("claude-code-loongsuite-pilot-hook.sh"))
        .arg("pre-tool-use")
        .env("LOONGSUITE_PILOT_DATA_DIR", &data);
    if mode == 0 || mode == 3 {
        c.env("TRACEPARENT", format!("00-{TRACE}-{UPSTREAM}-01"))
            .env("TRACESTATE", STATE);
    }
    if !resources.is_empty() {
        c.env("LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES", resources);
    }
    let hook = finish(&mut c, Some(&payload)).await;
    let response: Value = serde_json::from_slice(&hook.stdout).unwrap();
    let updated = response.pointer("/hookSpecificOutput/updatedInput");
    if mode == 3 {
        assert_eq!(response, json!({}));
        assert!(updated.is_none());
    } else {
        assert!(updated.is_some(), "{response}");
        for key in ["description", "timeout", "run_in_background"] {
            assert_eq!(updated.unwrap()[key], tool[key]);
        }
    }
    let effective = updated.unwrap_or(&tool)["command"].as_str().unwrap();
    // Inherited decoys are deliberately removed, as in the original simulator.
    // Only the real hook command can introduce any of the three carriers.
    let mut run = tokio::process::Command::new("/bin/bash");
    isolated(&mut run, r);
    run.args(["-c", effective]);
    let downstream = finish(&mut run, None).await;
    let raw = std::fs::read(&output).unwrap();
    let parts = raw
        .split(|b| *b == 0)
        .take(4)
        .map(|v| String::from_utf8(v.to_vec()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(parts.len(), 4);
    let traceparent = &parts[0];
    let state = &parts[1];
    let attrs = &parts[2];
    if mode >= 2 {
        assert!(traceparent.is_empty());
        assert!(state.is_empty());
        assert_eq!(parts[3], "false");
        assert_eq!(attrs, resources);
        if mode == 3 {
            return;
        }
    } else {
        assert_eq!(parts[3], "true");
        assert_eq!(attrs, resources);
        assert_eq!(state, if mode == 0 { STATE } else { "" });
        assert_eq!(traceparent.len(), 55);
        assert_eq!(&traceparent[53..], "01");
        assert_ne!(&traceparent[36..52], UPSTREAM);
        if mode == 0 {
            assert_eq!(&traceparent[3..35], TRACE);
        }
    }
    let transcript = r.join("transcript.jsonl");
    let rows = [
        json!({"type":"user","timestamp":"2026-07-31T02:00:00.000Z","promptId":"prompt-1","message":{"content":[{"type":"text","text":prompt}]}}),
        json!({"type":"assistant","timestamp":"2026-07-31T02:00:01.000Z","message":{"id":"msg_demo_1","content":[{"type":"tool_use","id":"toolu_demo_cli","name":"Bash","input":tool}],"usage":{"input_tokens":10,"output_tokens":5},"stop_reason":"tool_use"}}),
        json!({"type":"user","timestamp":"2026-07-31T02:00:01.100Z","promptId":"prompt-1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_demo_cli","content":String::from_utf8(downstream.stdout).unwrap().trim()}]}}),
        json!({"type":"assistant","timestamp":"2026-07-31T02:00:02.000Z","message":{"id":"msg_demo_2","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":2},"stop_reason":"end_turn"}}),
    ];
    std::fs::write(
        &transcript,
        rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    let mut stop = tokio::process::Command::new("/bin/bash");
    isolated(&mut stop, r);
    stop.arg(hooks.join("claude-code-loongsuite-pilot-hook.sh"))
        .arg("stop")
        .env("LOONGSUITE_PILOT_DATA_DIR", &data);
    if mode == 0 {
        stop.env("TRACEPARENT", format!("00-{TRACE}-{UPSTREAM}-01"))
            .env("TRACESTATE", STATE);
    }
    let out=finish(&mut stop,Some(&json!({"session_id":"flow-session","prompt_id":"prompt-1","stop_reason":"end_turn","transcript_path":transcript}))).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap(),
        json!({})
    );
    let logs = data.join("logs/claude-code");
    let mut records = Vec::<AgentActivityEntry>::new();
    for file in std::fs::read_dir(&logs).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|v| v == "jsonl") {
            for line in std::fs::read_to_string(path).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
    }
    assert!(!records.is_empty());
    let raw = records
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect::<Vec<_>>();
    for event in ["tool.call", "tool.result"] {
        let row = raw
            .iter()
            .find(|v| v["event.name"] == event && v["gen_ai.tool.call.id"] == "toolu_demo_cli")
            .unwrap();
        if mode != 2 {
            assert_eq!(row["span_id"], traceparent[36..52]);
        }
    }
    TraceLinker::with_retry(CorrelationStore::new(correlate), 0, 0)
        .stamp(&mut records)
        .await;
    let expected = if mode == 2 {
        "dddddddddddddddddddddddddddddddd"
    } else {
        &traceparent[3..35]
    };
    assert!(
        records
            .iter()
            .all(|v| serde_json::to_value(v).unwrap()["trace_id"] == expected),
        "{records:?}"
    );
    if mode == 2 {
        let entry = records
            .iter()
            .map(|v| serde_json::to_value(v).unwrap())
            .find(|v| v["event.name"] == "other")
            .unwrap();
        assert_eq!(entry["parent_span_id"], "eeeeeeeeeeeeeeee");
        return;
    }
    let spans = export(&data, records).await;
    let tool_span = spans
        .iter()
        .find(|s| {
            s.name == "execute_tool Bash"
                && s.attributes.get("gen_ai.tool.call.id") == Some(&json!("toolu_demo_cli"))
        })
        .unwrap();
    assert_eq!(tool_span.trace_id, expected);
    assert_eq!(tool_span.span_id, traceparent[36..52]);
    if mode == 0 {
        let mut llm = spans
            .iter()
            .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
            .collect::<Vec<_>>();
        llm.sort_by_key(|s| s.start_time);
        assert_eq!(llm.len(), 2);
        let input: Value =
            serde_json::from_str(llm[1].attributes["gen_ai.input.messages"].as_str().unwrap())
                .unwrap();
        let input = input.as_array().unwrap();
        let assistant = input
            .iter()
            .position(|m| {
                m["role"] == "assistant"
                    && m["parts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|p| p["type"] == "tool_call" && p["id"] == "toolu_demo_cli")
            })
            .unwrap();
        let result =
            input
                .iter()
                .position(|m| {
                    m["role"] == "tool"
                        && m["parts"].as_array().unwrap().iter().any(|p| {
                            p["type"] == "tool_call_response" && p["id"] == "toolu_demo_cli"
                        })
                })
                .unwrap();
        assert!(result > assistant);
        assert!(input[assistant]["parts"].as_array().unwrap().contains(
            &json!({"type":"tool_call","id":"toolu_demo_cli","name":"Bash","arguments":tool})
        ));
    }
}
#[tokio::test]
async fn l58_actual_shell_downstream_stop_linker_otlp_preserve_parent_and_order() {
    flow(0).await;
}
#[tokio::test]
async fn l289_generated_local_trace_and_resources_reach_real_downstream_and_otlp() {
    flow(1).await;
}
#[tokio::test]
async fn l449_acp_context_is_not_competed_with_locally_and_resources_still_propagate() {
    flow(2).await;
}
#[tokio::test]
async fn l585_disabled_propagation_does_not_inject_hidden_inherited_context() {
    flow(3).await;
}
