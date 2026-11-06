//! Assertions ported from immutable ef8953de tests/unit/hooks/claude-code/hook-processor.test.mjs.
//! Real native hook child; all paths/configs are temporary, exporter is in memory.
use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("data")).unwrap();
        Self { _temp: temp, root }
    }
    fn data(&self) -> PathBuf {
        self.root.join("data")
    }
    fn transcript(&self, sid: &str, rows: &[Value]) -> PathBuf {
        write_rows(
            &self.root.join("transcripts").join(format!("{sid}.jsonl")),
            rows,
        )
    }
    fn child(&self, sid: &str, id: &str, rows: &[Value]) -> PathBuf {
        write_rows(
            &self
                .root
                .join("transcripts")
                .join(sid)
                .join("subagents")
                .join(format!("agent-{id}.jsonl")),
            rows,
        )
    }
    fn start(&self, command: &str, payload: Value, extra: &[(&str, &str)]) -> Running {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        cmd.args(["hook-process", "claude-code", command])
            .current_dir(&self.root)
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("LOCALAPPDATA", self.root.join("localappdata"))
            .env("XDG_CONFIG_HOME", self.root.join("xdg-config"))
            .env("XDG_DATA_HOME", self.root.join("xdg-data"))
            .env("XDG_CACHE_HOME", self.root.join("xdg-cache"))
            .env("CODEX_HOME", self.root.join("codex"))
            .env("CLAUDE_CONFIG_DIR", self.root.join("claude"))
            .env("CURSOR_AGENT_HOME", self.root.join("cursor"))
            .env("QODER_USER_DATA_DIR", self.root.join("qoder"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.data().join("config.json"),
            )
            .env("LOONGSUITE_PILOT_DATA_DIR", self.data())
            .env("LOONGSUITE_PILOT_CACHE_DIR", self.root.join("cache"))
            .env("PATH", self.root.join("no-runtimes"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        for (key, value) in extra {
            cmd.env(key, value);
        }
        let mut child = CandidateChild::spawn(&mut cmd).unwrap();
        let stdout = capture(child.take_stdout().unwrap());
        let stderr = capture(child.take_stderr().unwrap());
        child
            .take_stdin()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        Running {
            child,
            stdout,
            stderr,
        }
    }
    fn run(&self, command: &str, payload: Value) {
        self.run_env(command, payload, &[]);
    }
    fn run_env(&self, command: &str, payload: Value, extra: &[(&str, &str)]) -> Output {
        finish(self.start(command, payload, extra))
    }
    fn stop(&self, sid: &str, path: &Path) {
        self.run(
            "stop",
            json!({"session_id":sid,"transcript_path":path,"stop_reason":"end_turn"}),
        );
    }
    fn records(&self) -> Vec<Value> {
        read_jsonl(&self.data().join("logs/claude-code"))
    }
    fn responses(&self) -> Vec<Value> {
        self.records()
            .into_iter()
            .filter(|r| r["event.name"] == "llm.response")
            .collect()
    }
    fn state(&self, sid: &str) -> Value {
        serde_json::from_slice(
            &fs::read(
                self.data()
                    .join("state/claude-code/sessions")
                    .join(format!("{sid}.json")),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn intercept(&self, sid: &str, id: &str, payload: Value) -> PathBuf {
        let path = self
            .data()
            .join("intercept/claude-code")
            .join(sid)
            .join(format!("{id}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, payload.to_string()).unwrap();
        path
    }
    fn attempt(&self, sid: &str, id: &str, patch: Value) -> PathBuf {
        let mut body = json!({"schema_version":1,"session_id":sid,"attempt_id":id,
            "client_request_id":format!("client-{id}"),"request_hash":"a".repeat(64),
            "model":"claude-test","start_time_unix_nano":"1780541853000000000",
            "end_time_unix_nano":"1780541853100000000","duration_ns":100000000,
            "outcome":"http_error","status_code":529,"error_type":"overloaded_error",
            "request_id":format!("req-{id}"),"response_id":null,"ttft_ns":null});
        body.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let path = self
            .data()
            .join("intercept/claude-code")
            .join(sid)
            .join("attempts")
            .join(format!("{id}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body.to_string()).unwrap();
        path
    }
    fn complete(&self, sid: &str, id: &str, path: &Path, child: &Path) {
        self.run("subagent-stop",json!({"session_id":sid,"agent_id":id,"agent_type":"general-purpose","transcript_path":path,"agent_transcript_path":child}));
    }
}
struct Running {
    child: CandidateChild,
    stdout: std::thread::JoinHandle<(Vec<u8>, bool)>,
    stderr: std::thread::JoinHandle<(Vec<u8>, bool)>,
}
fn capture(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0; 8192];
        let mut overflow = false;
        loop {
            let n = pipe.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            let accepted = n.min((1024 * 1024usize).saturating_sub(bytes.len()));
            bytes.extend_from_slice(&chunk[..accepted]);
            overflow |= accepted != n;
        }
        (bytes, overflow)
    })
}
fn finish(mut running: Running) -> Output {
    let start = Instant::now();
    let status = loop {
        if let Some(status) = running.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "native hook timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(running.child);
    let (stdout, stdout_overflow) = running.stdout.join().unwrap();
    let (stderr, stderr_overflow) = running.stderr.join().unwrap();
    assert!(
        !stdout_overflow && !stderr_overflow,
        "hook output exceeded 1 MiB"
    );
    let output = Output {
        status,
        stdout,
        stderr,
    };
    assert!(
        output.status.success(),
        "status={:?}, stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<_> = stdout.lines().collect();
    assert_eq!(lines.len(), 1, "one hook response");
    assert!(serde_json::from_str::<Value>(lines[0]).unwrap().is_object());
    output
}
fn write_rows(path: &Path, rows: &[Value]) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    path.to_path_buf()
}
fn read_jsonl(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .map(Result::unwrap)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    paths.sort();
    paths
        .iter()
        .flat_map(|p| {
            fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).unwrap())
                .collect::<Vec<_>>()
        })
        .collect()
}
fn prompt(time: &str, text: &str) -> Value {
    json!({"type":"user","timestamp":time,"message":{"content":[{"type":"text","text":text}]}})
}
fn answer(id: &str, time: &str, text: &str) -> Value {
    json!({"type":"assistant","timestamp":time,"message":{"id":id,"model":"claude-test","content":[{"type":"text","text":text}],"usage":{"input_tokens":7,"output_tokens":3},"stop_reason":"end_turn"}})
}
fn basic() -> Vec<Value> {
    vec![
        prompt("2026-06-04T02:57:32.000Z", "list files"),
        json!({"type":"assistant","timestamp":"2026-06-04T02:57:49.000Z","message":{"id":"msg_1","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":100,"output_tokens":50},"stop_reason":"tool_use"}}),
        json!({"type":"user","timestamp":"2026-06-04T02:57:49.200Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"a.txt"}]}}),
        answer("msg_2", "2026-06-04T02:57:52.000Z", "done"),
    ]
}
fn simple() -> Vec<Value> {
    vec![
        prompt("2026-06-04T02:57:32.000Z", "retry please"),
        answer("msg_ok", "2026-06-04T02:57:36.000Z", "done"),
    ]
}
fn api_error() -> Vec<Value> {
    vec![
        json!({"type":"user","timestamp":"2026-09-16T03:43:03.998Z","promptId":"prompt-api-error","message":{"role":"user","content":"trigger error"}}),
        json!({"type":"assistant","timestamp":"2026-09-16T03:46:02.445Z","isApiErrorMessage":true,"apiErrorStatus":529,"error":"server_error","requestId":"req-error-11","message":{"id":"synthetic-error-message","model":"<synthetic>","content":[{"type":"text","text":"private upstream detail"}],"usage":{"input_tokens":0,"output_tokens":0},"stop_reason":"stop_sequence"}}),
    ]
}
fn parent(agents: &[(&str, &str)], background: bool) -> Vec<Value> {
    let tools: Vec<_> = agents.iter().enumerate().map(|(i,(_,kind))|json!({"type":"tool_use","id":format!("agent_call_{}",i+1),"name":"Agent","input":{"subagent_type":kind,"run_in_background":background}})).collect();
    let mut rows = vec![
        prompt("2026-06-04T02:57:32.000Z", "delegate this task"),
        json!({"type":"assistant","timestamp":"2026-06-04T02:57:35.000Z","message":{"id":"msg_parent_1","content":tools,"usage":{"input_tokens":10,"output_tokens":5},"stop_reason":"tool_use"}}),
    ];
    for (i, (id, kind)) in agents.iter().enumerate() {
        let mut result = json!({"agentId":id,"agentType":kind});
        if background {
            result["status"] = json!("async_launched");
            result["isAsync"] = json!(true);
        }
        rows.push(json!({"type":"user","timestamp":"2026-06-04T02:57:36.000Z","toolUseResult":result,"message":{"content":[{"type":"tool_result","tool_use_id":format!("agent_call_{}",i+1),"content":"delegated task completed"}]}}));
    }
    rows.push(answer("msg_parent_2", "2026-06-04T02:57:40.000Z", "done"));
    rows
}
fn child_rows() -> Vec<Value> {
    vec![
        prompt("2026-06-04T02:57:35.100Z", "child prompt"),
        answer("msg_child", "2026-06-04T02:57:35.900Z", "child answer"),
    ]
}
fn events<'a>(records: &'a [Value], name: &str) -> Vec<&'a Value> {
    records.iter().filter(|r| r["event.name"] == name).collect()
}
fn response<'a>(records: &'a [Value], id: &str) -> &'a Value {
    records
        .iter()
        .find(|r| r["event.name"] == "llm.response" && r["gen_ai.response.id"] == id)
        .unwrap_or_else(|| panic!("missing response {id}: {records:?}"))
}
fn stale(path: &Path) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7200)))
        .unwrap();
}
fn empty_array(value: &Value) {
    assert!(value.is_null() || value.as_array().is_some_and(Vec::is_empty));
}
fn valid_span(value: &Value) {
    let s = value.as_str().unwrap();
    assert_eq!(s.len(), 16);
    assert!(s
        .bytes()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_ne!(s, "0000000000000000");
}

struct MemoryExporter(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait]
impl TraceExporter for MemoryExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}
fn export(f: &Fixture, records: &[Value]) -> Vec<ReadableSpan> {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let sink = captured.clone();
    let config: OtlpTraceFlusherConfig = serde_json::from_value(json!({
        "enabled":true,"endpoints":[{"name":"memory","endpoint":"http://127.0.0.1:1"}],
        "protocol":"http/protobuf","serviceName":"test-pilot","dataDir":f.data()
    }))
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let flusher = OtlpTraceFlusher::with_parts(
            config,
            None,
            Some(Arc::new(move |_| Arc::new(MemoryExporter(sink.clone())))),
            None,
        )
        .unwrap();
        let entries: Vec<AgentActivityEntry> = records
            .iter()
            .cloned()
            .map(|r| serde_json::from_value(r).unwrap())
            .collect();
        flusher.send_batch(entries, None).await.unwrap();
        flusher.flush().await.unwrap();
        flusher.shutdown().await.unwrap();
    });
    Arc::try_unwrap(captured).unwrap().into_inner().unwrap()
}
fn llms(spans: &[ReadableSpan]) -> Vec<&ReadableSpan> {
    spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") == Some(&json!("LLM")))
        .collect()
}
fn parents_healthy(spans: &[ReadableSpan]) {
    let parents: Vec<_> = spans
        .iter()
        .filter(|s| s.attributes.get("gen_ai.span.kind") != Some(&json!("LLM")))
        .collect();
    assert!(!parents.is_empty());
    for s in parents {
        assert_ne!(s.status.get("code"), Some(&json!(2)));
        assert!(!s.attributes.contains_key("error.type"));
    }
}

#[test]
fn intercept_full_match_enriches_both_events_and_deletes_files() {
    let f = Fixture::new();
    let path = f.transcript("s", &basic());
    let system = json!([{"type":"text","content":"You are a Claude agent."},{"type":"text","content":"CLAUDE.md content here."}]);
    let files: Vec<_> = [("msg_1",1234567890u64),("msg_2",2222222222)].iter().map(|(id,ttft)|f.intercept("s",id,json!({"session_id":"s","response_id":id,"ttft_ns":ttft,"system_instructions":system}))).collect();
    f.stop("s", &path);
    let records = f.records();
    assert_eq!(events(&records, "llm.request").len(), 2);
    assert_eq!(events(&records, "llm.response").len(), 2);
    for request in events(&records, "llm.request") {
        assert_eq!(request["gen_ai.system_instructions"], system);
    }
    assert_eq!(
        response(&records, "msg_1")["gen_ai.response.time_to_first_token"],
        1234567890u64
    );
    assert_eq!(
        response(&records, "msg_2")["gen_ai.response.time_to_first_token"],
        2222222222u64
    );
    for file in files {
        assert!(!file.exists());
    }
}
#[test]
fn intercept_minted_span_ids_are_claimed_and_invalid_ids_get_distinct_local_fallbacks() {
    for valid in [true, false] {
        let f = Fixture::new();
        let path = f.transcript("s", &basic());
        let ids = if valid {
            ["aaaaaaaaaaaaaaa1", "bbbbbbbbbbbbbbb2"]
        } else {
            ["not-a-span-id", "0000000000000000"]
        };
        for (i, id) in ["msg_1", "msg_2"].iter().enumerate() {
            f.intercept(
                "s",
                id,
                json!({"session_id":"s","response_id":id,"ttft_ns":i+1,"llm_span_id":ids[i]}),
            );
        }
        f.stop("s", &path);
        let records = f.records();
        let llm: Vec<_> = records
            .iter()
            .filter(|r| r["event.name"] == "llm.request" || r["event.name"] == "llm.response")
            .collect();
        assert_eq!(llm.len(), 4);
        for event in llm {
            let i = usize::from(event["gen_ai.response.id"] == "msg_2");
            if valid {
                assert_eq!(event["span_id"], ids[i]);
            } else {
                valid_span(&event["span_id"]);
            }
            assert_ne!(event["span_id"], event["parent_span_id"]);
        }
        for id in ["msg_1", "msg_2"] {
            let request = events(&records, "llm.request")
                .into_iter()
                .find(|r| r["gen_ai.response.id"] == id)
                .unwrap();
            assert_eq!(request["span_id"], response(&records, id)["span_id"]);
        }
        assert_ne!(
            response(&records, "msg_1")["span_id"],
            response(&records, "msg_2")["span_id"]
        );
    }
}
#[test]
fn retries_claim_their_physical_span_ids_and_export_independently() {
    for shared in [false, true] {
        let f = Fixture::new();
        let path = f.transcript("s", &simple());
        let mut files = Vec::new();
        for (id, start, end, span) in [
            (
                "retry-1",
                "1780541853000000000",
                "1780541853100000000",
                "ccccccccccccccc3",
            ),
            (
                "retry-2",
                "1780541853200000000",
                "1780541853300000000",
                "zzzz",
            ),
        ] {
            let mut patch = json!({"start_time_unix_nano":start,"end_time_unix_nano":end,"llm_span_id":span,"client_request_id":if id=="retry-1" {json!("client-retry-1")}else{Value::Null}});
            if shared {
                patch["request_id"] = json!("req-shared");
            }
            files.push(f.attempt("s", id, patch));
        }
        files.push(f.attempt("s","success",json!({"start_time_unix_nano":"1780541853400000000","end_time_unix_nano":"1780541853500000000","llm_span_id":"ddddddddddddddd4","outcome":"success","status_code":200,"error_type":null,"client_request_id":null,"request_id":if shared {"req-shared"} else {"req-success"},"response_id":"msg_ok"})));
        f.stop("s", &path);
        let records = f.records();
        let responses = events(&records, "llm.response");
        assert_eq!(events(&records, "llm.request").len(), 3);
        assert_eq!(responses.len(), 3);
        assert_eq!(
            responses
                .iter()
                .map(|r| r["gen_ai.response.id"].clone())
                .collect::<Vec<_>>(),
            json!(["attempt:retry-1", "attempt:retry-2", "msg_ok"])
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!(responses[0]["span_id"], "ccccccccccccccc3");
        valid_span(&responses[1]["span_id"]);
        assert_ne!(responses[1]["span_id"], responses[0]["span_id"]);
        assert_eq!(responses[2]["span_id"], "ddddddddddddddd4");
        for (i, r) in responses.iter().enumerate() {
            assert_eq!(
                r["gen_ai.response.finish_reasons"],
                if i < 2 {
                    json!(["error"])
                } else {
                    json!(["stop"])
                }
            );
            assert_eq!(
                r["gen_ai.request.id"],
                if shared {
                    json!("req-shared")
                } else {
                    json!(["req-retry-1", "req-retry-2", "req-success"][i])
                }
            );
            for key in [
                "gen_ai.request.attempt",
                "agent.client_request_id",
                "error.message",
            ] {
                assert!(r.get(key).is_none());
            }
            if i < 2 {
                assert_eq!(r["error.type"], "overloaded_error");
                assert_eq!(r["http.response.status_code"], 529);
                assert_ne!(r["gen_ai.turn.end"], true);
            }
        }
        for file in files {
            assert!(!file.exists());
        }
        let spans = export(&f, &records);
        let llm = llms(&spans);
        assert_eq!(llm.len(), 3);
        assert_eq!(
            llm.iter().map(|s| &s.span_id).collect::<HashSet<_>>().len(),
            3
        );
        for (i, s) in llm.iter().enumerate() {
            assert_eq!(
                s.attributes["gen_ai.response.id"],
                responses[i]["gen_ai.response.id"]
            );
            assert_eq!(
                s.attributes["gen_ai.request.id"],
                responses[i]["gen_ai.request.id"]
            );
            if i < 2 {
                assert_eq!(s.status["code"], 2);
                assert_eq!(s.attributes["http.response.status_code"], 529);
            } else {
                assert_ne!(s.status["code"], 2);
                assert!(!s.attributes.contains_key("error.type"));
            }
        }
        parents_healthy(&spans);
    }
}
#[test]
fn partial_network_errors_use_physical_end_preserve_content_and_replay_once() {
    for error in ["aborted", "typeerror"] {
        let f = Fixture::new();
        let mut rows = simple();
        rows[1] = answer("msg_partial", "2026-06-04T02:57:34.000Z", "partial answer");
        rows[1]["message"]["stop_reason"] = Value::Null;
        let path = f.transcript("s", &rows);
        let file=f.attempt("s","partial-failed",json!({"outcome":"network_error","error_type":error,"status_code":200,"response_id":"msg_partial","start_time_unix_nano":"1780541853000000000","end_time_unix_nano":"1780541855100000000"}));
        f.stop("s", &path);
        let records = f.records();
        let responses = events(&records, "llm.response");
        assert_eq!(events(&records, "llm.request").len(), 1);
        assert_eq!(responses.len(), 1);
        let r = responses[0];
        assert_eq!(r["gen_ai.response.id"], "msg_partial");
        assert_eq!(r["gen_ai.request.id"], "req-partial-failed");
        assert_eq!(r["error.type"], error);
        assert_eq!(r["http.response.status_code"], 200);
        assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
        assert_eq!(r["gen_ai.turn.end"], true);
        assert_eq!(r["time_unix_nano"], "1780541855100000000");
        let output = r["gen_ai.output.messages"].as_array().unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["role"], "assistant");
        let parts = output[0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["content"], "partial answer");
        assert!(!file.exists());
        f.stop("s", &path);
        assert_eq!(f.records(), records);
        let spans = export(&f, &records);
        let llm = llms(&spans);
        assert_eq!(llm.len(), 1);
        assert_eq!(llm[0].status["code"], 2);
        assert_eq!(llm[0].attributes["error.type"], error);
        assert_eq!(llm[0].attributes["http.response.status_code"], 200);
        assert_eq!(
            llm[0].attributes["gen_ai.response.finish_reasons"],
            json!(["error"])
        );
        assert!(llm[0].attributes["gen_ai.output.messages"]
            .to_string()
            .contains("partial answer"));
        assert_eq!(llm[0].start_time, [1780541853, 0]);
        assert_eq!(llm[0].end_time, [1780541855, 100000000]);
        parents_healthy(&spans);
    }
}
#[test]
fn missing_hash_and_overlapping_groups_only_consume_exact_success_anchor() {
    for overlap in [false, true] {
        let f = Fixture::new();
        let path = f.transcript("s", &simple());
        let first=f.attempt("s","fail-1",json!({"request_hash":if overlap {json!("a".repeat(64))}else{Value::Null},"end_time_unix_nano":if overlap {"1780541854300000000"}else{"1780541853100000000"}}));
        let second=f.attempt("s","fail-2",json!({"request_hash":if overlap {json!("a".repeat(64))}else{Value::Null},"start_time_unix_nano":if overlap {"1780541854000000000"}else{"1780541853200000000"},"end_time_unix_nano":if overlap {"1780541854200000000"}else{"1780541853300000000"}}));
        let success=f.attempt("s","success",json!({"request_hash":if overlap {json!("a".repeat(64))}else{Value::Null},"outcome":"success","status_code":200,"error_type":null,"response_id":"msg_ok","start_time_unix_nano":"1780541854400000000","end_time_unix_nano":"1780541855000000000"}));
        f.stop("s", &path);
        let responses = f.responses();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["gen_ai.request.id"], "req-success");
        assert!(responses[0].get("error.type").is_none());
        assert!(first.exists() && second.exists());
        assert!(!success.exists());
    }
}
#[test]
fn ambiguous_request_ids_do_not_guess_even_for_same_hash() {
    for same in [true, false] {
        let f = Fixture::new();
        let path = f.transcript("s", &api_error());
        let mut files = Vec::new();
        for (id, start, end, hash, error) in [
            (
                "one",
                "1789530184000000000",
                "1789530184100000000",
                "a",
                "aborted",
            ),
            (
                "two",
                "1789530184200000000",
                "1789530184300000000",
                if same { "a" } else { "b" },
                "typeerror",
            ),
        ] {
            files.push(f.attempt("s",id,json!({"request_id":"req-error-11","outcome":"network_error","error_type":error,"status_code":200,"request_hash":hash.repeat(64),"start_time_unix_nano":start,"end_time_unix_nano":end})));
        }
        f.run("stop-failure",json!({"session_id":"s","transcript_path":path,"hook_event_name":"StopFailure","error":"server_error"}));
        let records = f.records();
        let responses = events(&records, "llm.response");
        assert_eq!(responses.len(), 1);
        let r = responses[0];
        assert_eq!(r["gen_ai.request.id"], "req-error-11");
        assert_eq!(r["error.type"], "server_error");
        assert_eq!(r["http.response.status_code"], 529);
        assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
        assert_eq!(r["time_unix_nano"], "1789530362445000000");
        for file in files {
            assert!(file.exists());
        }
        let spans = export(&f, &records);
        let llm = llms(&spans);
        assert_eq!(llm.len(), 1);
        assert_eq!(llm[0].status["code"], 2);
        assert_eq!(llm[0].attributes["error.type"], "server_error");
        assert_eq!(llm[0].attributes["http.response.status_code"], 529);
    }
}
#[test]
fn terminal_failed_attempt_is_not_duplicated_and_only_final_ends_turn() {
    let f = Fixture::new();
    let path = f.transcript("s", &api_error());
    for (id, start, end) in [
        ("one", "1789530184000000000", "1789530184100000000"),
        ("two", "1789530184200000000", "1789530184300000000"),
        ("three", "1789530184400000000", "1789530184500000000"),
    ] {
        let mut patch = json!({"start_time_unix_nano":start,"end_time_unix_nano":end});
        if id == "three" {
            patch["request_id"] = json!("req-error-11");
        }
        f.attempt("s", id, patch);
    }
    f.run("stop-failure",json!({"session_id":"s","transcript_path":path,"hook_event_name":"StopFailure","error":"server_error"}));
    let responses = f.responses();
    assert_eq!(responses.len(), 3);
    for (i, r) in responses.iter().enumerate() {
        assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
        assert_eq!(r["gen_ai.turn.end"] == true, i == 2);
    }
    assert_eq!(responses[2]["gen_ai.request.id"], "req-error-11");
}
#[test]
fn stop_failure_waits_for_transcript_flush_race() {
    let f = Fixture::new();
    let path = f.transcript("s", &[]);
    fs::write(&path, "").unwrap();
    let child=f.start("stop-failure",json!({"session_id":"s","transcript_path":path,"hook_event_name":"StopFailure","error":"server_error"}),&[]);
    std::thread::sleep(Duration::from_millis(250));
    write_rows(&path, &api_error());
    finish(child);
    let responses = f.responses();
    assert_eq!(responses.len(), 1);
    assert_eq!(
        responses[0]["gen_ai.response.finish_reasons"],
        json!(["error"])
    );
    assert_eq!(responses[0]["gen_ai.turn.end"], true);
    assert_eq!(responses[0]["gen_ai.request.id"], "req-error-11");
    assert_eq!(responses[0]["http.response.status_code"], 529);
}
#[test]
fn intercept_absent_partial_malformed_and_orphan_lifetimes() {
    for mode in ["absent", "partial", "malformed", "stale", "fresh"] {
        let f = Fixture::new();
        let path = f.transcript("s", &basic());
        let mut orphan = None;
        if mode == "partial" {
            f.intercept("s","msg_1",json!({"session_id":"s","response_id":"msg_1","ttft_ns":999000000,"system_instructions":[{"type":"text","content":"system"}]}));
        }
        if mode == "malformed" {
            let file = f.intercept("s", "broken", json!({}));
            fs::write(file, "{not json").unwrap();
            f.attempt("s","broken",json!({"start_time_unix_nano":"not-a-timestamp","end_time_unix_nano":"also-invalid"}));
        }
        if mode == "stale" || mode == "fresh" {
            let file=f.intercept("s","orphan",json!({"session_id":"s","response_id":"orphan","ttft_ns":100,"system_instructions":[]}));
            if mode == "stale" {
                stale(&file);
            }
            orphan = Some(file);
        }
        f.stop("s", &path);
        let records = f.records();
        assert!(!events(&records, "llm.request").is_empty());
        assert!(!events(&records, "llm.response").is_empty());
        for request in events(&records, "llm.request") {
            if mode == "partial" && request["gen_ai.response.id"] == "msg_1" {
                assert_eq!(
                    request["gen_ai.system_instructions"],
                    json!([{"type":"text","content":"system"}])
                );
            } else {
                assert!(request.get("gen_ai.system_instructions").is_none());
            }
        }
        for response in events(&records, "llm.response") {
            if mode == "partial" && response["gen_ai.response.id"] == "msg_1" {
                assert_eq!(response["gen_ai.response.time_to_first_token"], 999000000);
            } else {
                assert!(response
                    .get("gen_ai.response.time_to_first_token")
                    .is_none());
            }
        }
        if let Some(file) = orphan {
            assert_eq!(file.exists(), mode == "fresh");
        }
    }
}
#[test]
fn unanchored_failures_are_untouched_inside_and_outside_turn() {
    let f = Fixture::new();
    let mut rows = api_error();
    rows[0] = prompt("2026-06-04T02:57:32.000Z", "trigger error");
    rows[0]["promptId"] = json!("p-bound");
    rows[1]["timestamp"] = json!("2026-06-04T02:57:36.000Z");
    rows[1].as_object_mut().unwrap().remove("requestId");
    rows[1]["message"]["model"] = json!("claude-test");
    let path = f.transcript("s", &rows);
    let files=[f.attempt("s","previous",json!({"start_time_unix_nano":"1780541850000000000","end_time_unix_nano":"1780541850100000000"})),f.attempt("s","current",json!({}))];
    f.run(
        "stop-failure",
        json!({"session_id":"s","transcript_path":path,"error":"server_error"}),
    );
    let responses = f.responses();
    assert_eq!(responses.len(), 1);
    assert!(responses[0].get("gen_ai.request.id").is_none());
    assert_eq!(responses[0]["error.type"], "server_error");
    for file in files {
        assert!(file.exists());
    }
}
#[test]
fn stale_attempts_reap_across_sessions_and_on_empty_transcript_return() {
    for empty in [false, true] {
        let f = Fixture::new();
        let rows = if empty { vec![] } else { basic() };
        let path = f.transcript("s", &rows);
        if empty {
            fs::write(&path, "").unwrap();
        }
        let other = if empty { "s" } else { "abandoned" };
        let file = f.attempt(other, "stale", json!({}));
        stale(&file);
        f.stop("s", &path);
        assert!(!file.exists());
        if !empty {
            assert!(!f.data().join("intercept/claude-code/abandoned").exists());
        }
    }
}

#[test]
fn background_subagent_defers_then_exports_complete_chain_once_with_contained_times() {
    let f = Fixture::new();
    let path = f.transcript("s", &parent(&[("child", "general-purpose")], true));
    let child=f.child("s","child",&[
        prompt("2026-06-04T02:57:35.100Z","run background command"),
        json!({"type":"assistant","timestamp":"2026-06-04T02:57:35.900Z","message":{"id":"msg_child_first","content":[{"type":"tool_use","id":"child_bash","name":"Bash","input":{"command":"echo done"}}],"usage":{"input_tokens":7,"output_tokens":2},"stop_reason":"tool_use"}})
    ]);
    f.stop("s", &path);
    assert!(f.records().is_empty());
    assert_eq!(
        f.state("s")["pending_subagent_turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut tail = answer(
        "msg_child_final",
        "2026-06-04T03:07:37.000Z",
        "background child completed",
    );
    tail["message"]["usage"]["output_tokens"] = json!(4);
    let appended = [
        json!({"type":"user","timestamp":"2026-06-04T03:07:36.100Z","message":{"content":[{"type":"tool_result","tool_use_id":"child_bash","content":"done"}]}}),
        tail,
    ];
    let mut file = fs::OpenOptions::new().append(true).open(&child).unwrap();
    for row in appended {
        writeln!(file, "{row}").unwrap();
    }
    drop(file);
    f.complete("s", "child", &path, &child);
    let records = f.records();
    assert_eq!(
        events(&records, "tool.call")
            .iter()
            .filter(|r| r["gen_ai.tool.call.id"] == "agent_call_1")
            .count(),
        1
    );
    let final_response = response(&records, "msg_child_final");
    assert_eq!(final_response["gen_ai.usage.output_tokens"], 4);
    assert!(final_response["gen_ai.output.messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "assistant"
            && m["parts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["type"] == "text" && p["content"] == "background child completed")));
    empty_array(&f.state("s")["pending_subagent_turns"]);
    f.complete("s", "child", &path, &child);
    assert_eq!(f.records(), records);
    assert!(f.state("s")["completed_subagents"].get("child").is_none());
    let spans = export(&f, &records);
    let tool = spans
        .iter()
        .find(|s| s.name == "execute_tool Agent")
        .unwrap();
    let agent = spans
        .iter()
        .find(|s| {
            s.name == "invoke_agent general-purpose"
                && s.attributes.get("gen_ai.agent.scope") == Some(&json!("subagent"))
        })
        .unwrap();
    let step = spans
        .iter()
        .find(|s| Some(&s.span_id) == tool.parent_span_id.as_ref())
        .unwrap();
    assert_eq!(agent.parent_span_id.as_deref(), Some(tool.span_id.as_str()));
    assert!(agent.end_time <= tool.end_time);
    assert!(tool.end_time <= step.end_time);
    for (key, value) in [
        ("gen_ai.turn.id", json!("s:t1")),
        ("gen_ai.agent.scope", json!("subagent")),
        ("gen_ai.agent.depth", json!(1)),
        ("gen_ai.agent.parent.id", json!("s")),
        ("gen_ai.subagent.parent_tool_call.id", json!("agent_call_1")),
    ] {
        assert_eq!(agent.attributes.get(key), Some(&value));
    }
    assert!(agent.attributes["gen_ai.output.messages"]
        .to_string()
        .contains("background child completed"));
    assert_eq!(
        spans
            .iter()
            .map(|s| &s.span_id)
            .collect::<HashSet<_>>()
            .len(),
        spans.len()
    );
}
#[test]
fn subagent_completion_before_parent_stop_keeps_one_complete_chain() {
    let f = Fixture::new();
    let path = f.transcript("s", &parent(&[("child", "general-purpose")], true));
    let child = f.child("s", "child", &child_rows());
    f.complete("s", "child", &path, &child);
    assert!(f.records().is_empty());
    f.stop("s", &path);
    let records = f.records();
    assert_eq!(
        events(&records, "tool.call")
            .iter()
            .filter(|r| r["gen_ai.tool.call.id"] == "agent_call_1")
            .count(),
        1
    );
    assert_eq!(
        response(&records, "msg_child")["gen_ai.agent.scope"],
        "subagent"
    );
    empty_array(&f.state("s")["pending_subagent_turns"]);
    assert!(f.state("s")["completed_subagents"].get("child").is_none());
}
#[test]
fn multiple_background_completions_do_not_reintroduce_stale_markers() {
    let f = Fixture::new();
    let path = f.transcript(
        "s",
        &parent(&[("first", "general-purpose"), ("second", "Explore")], true),
    );
    let first = f.child("s", "first", &child_rows());
    let mut second_rows = child_rows();
    second_rows[1]["message"]["id"] = json!("msg_child_second");
    let second = f.child("s", "second", &second_rows);
    f.stop("s", &path);
    assert!(f.records().is_empty());
    f.complete("s", "first", &path, &first);
    assert!(f.records().is_empty());
    assert!(f.state("s")["completed_subagents"].get("first").is_none());
    f.complete("s", "first", &path, &first);
    assert!(f.state("s")["completed_subagents"].get("first").is_none());
    f.run("subagent-stop",json!({"session_id":"s","agent_id":"second","agent_type":"Explore","transcript_path":path,"agent_transcript_path":second}));
    let records = f.records();
    assert_eq!(
        events(&records, "tool.call")
            .iter()
            .filter(|r| r["gen_ai.tool.name"] == "Agent")
            .count(),
        2
    );
    assert_eq!(
        events(&records, "llm.response")
            .iter()
            .filter(|r| r["gen_ai.agent.scope"] == "subagent")
            .count(),
        2
    );
    empty_array(&f.state("s")["pending_subagent_turns"]);
    assert_eq!(f.state("s")["completed_subagents"], json!({}));
}
#[test]
fn child_records_inherit_parent_chain_and_keep_real_request_boundaries() {
    let f = Fixture::new();
    let path = f.transcript("s", &parent(&[("child", "general-purpose")], false));
    f.child("s", "child", &child_rows());
    f.stop("s", &path);
    let records = f.records();
    let tool = events(&records, "tool.call")
        .into_iter()
        .find(|r| r["gen_ai.tool.call.id"] == "agent_call_1")
        .unwrap();
    assert_eq!(tool["gen_ai.tool.name"], "Agent");
    let requests = events(&records, "llm.request");
    assert_eq!(requests.len(), 3);
    let child_request = requests
        .iter()
        .find(|r| r["gen_ai.agent.scope"] == "subagent")
        .unwrap();
    assert_eq!(child_request["time_unix_nano"], "1780541855900000000");
    for request in requests {
        let response = events(&records, "llm.response")
            .into_iter()
            .find(|r| r["span_id"] == request["span_id"])
            .unwrap();
        let start = request["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        let end = response["time_unix_nano"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        assert!(start > 0 && start <= end);
    }
    let children: Vec<_> = records
        .iter()
        .filter(|r| r["gen_ai.agent.scope"] == "subagent")
        .collect();
    assert!(!children.is_empty());
    for r in children {
        assert_eq!(r["trace_id"], tool["trace_id"]);
        assert_eq!(r["gen_ai.session.id"], "s");
        assert_eq!(r["gen_ai.turn.id"], tool["gen_ai.turn.id"]);
        assert_eq!(r["gen_ai.agent.depth"], 1);
        assert_eq!(r["gen_ai.agent.id"], "child");
        assert_eq!(r["gen_ai.agent.name"], "general-purpose");
        assert_eq!(r["gen_ai.subagent.parent_tool_call.id"], "agent_call_1");
    }
}
#[test]
fn child_retries_keep_ownership_across_parent_interleaving_and_hash_groups() {
    for interleaved in [false, true] {
        let f = Fixture::new();
        let path = f.transcript("s", &parent(&[("child", "general-purpose")], false));
        f.child("s", "child", &child_rows());
        let child_hash = if interleaved {
            "c".repeat(64)
        } else {
            "a".repeat(64)
        };
        let parent_hash = if interleaved {
            "p".repeat(64)
        } else {
            "a".repeat(64)
        };
        f.attempt("s","parent-first",json!({"start_time_unix_nano":if interleaved {"1780541855400000000"}else{"1780541854000000000"},"end_time_unix_nano":if interleaved {"1780541855500000000"}else{"1780541855000000000"},"outcome":"success","status_code":200,"error_type":null,"request_hash":parent_hash,"response_id":"msg_parent_1","request_id":"req-parent-1"}));
        f.attempt("s","child-retry",json!({"start_time_unix_nano":"1780541855200000000","end_time_unix_nano":"1780541855300000000","request_hash":child_hash}));
        f.attempt("s","child-success",json!({"start_time_unix_nano":if interleaved {"1780541855600000000"}else{"1780541855400000000"},"end_time_unix_nano":"1780541855900000000","outcome":"success","status_code":200,"error_type":null,"request_hash":child_hash,"response_id":"msg_child","request_id":"req-child-2"}));
        f.attempt("s","parent-final",json!({"start_time_unix_nano":"1780541857000000000","end_time_unix_nano":"1780541860000000000","outcome":"success","status_code":200,"error_type":null,"request_hash":parent_hash,"response_id":"msg_parent_2","request_id":"req-parent-2"}));
        f.stop("s", &path);
        let records = f.records();
        let retry = response(&records, "attempt:child-retry");
        assert_eq!(retry["gen_ai.agent.scope"], "subagent");
        assert_eq!(retry["gen_ai.agent.id"], "child");
        assert_eq!(retry["gen_ai.request.id"], "req-child-retry");
        assert_eq!(retry["error.type"], "overloaded_error");
        assert_eq!(retry["http.response.status_code"], 529);
        assert_eq!(retry["gen_ai.response.finish_reasons"], json!(["error"]));
        let child_responses: Vec<_> = events(&records, "llm.response")
            .into_iter()
            .filter(|r| r["gen_ai.agent.scope"] == "subagent" && r["gen_ai.agent.id"] == "child")
            .collect();
        assert_eq!(child_responses.len(), 2);
        assert!(response(&records, "msg_child").get("error.type").is_none());
    }
}
#[test]
fn background_child_terminal_error_owns_anchored_retries_without_claiming_unanchored_parent() {
    let f = Fixture::new();
    let mut rows = parent(&[("child", "general-purpose")], true);
    *rows.last_mut().unwrap() = json!({"type":"assistant","timestamp":"2026-06-04T02:57:37.000Z","isApiErrorMessage":true,"apiErrorStatus":503,"error":"server_error","message":{"id":"msg_parent_error","model":"claude-test","content":[{"type":"text","text":"parent failed"}],"stop_reason":"stop_sequence"}});
    let path = f.transcript("s", &rows);
    let child=f.child("s","child",&[
        prompt("2026-06-04T02:57:35.100Z","child task"),
        json!({"type":"assistant","timestamp":"2026-06-04T02:57:38.000Z","isApiErrorMessage":true,"apiErrorStatus":429,"error":"rate_limit_error","requestId":"req-child-terminal","message":{"id":"msg_child_error","model":"claude-test","content":[{"type":"text","text":"child failed"}],"stop_reason":"stop_sequence"}})]);
    let mut parent_files = Vec::new();
    let mut child_files = Vec::new();
    for (id, start, end) in [
        (
            "parent-unanchored-1",
            "1780541855150000000",
            "1780541855180000000",
        ),
        (
            "parent-unanchored-2",
            "1780541855400000000",
            "1780541855500000000",
        ),
    ] {
        parent_files.push(f.attempt("s",id,json!({"request_hash":"b".repeat(64),"error_type":"server_error","status_code":503,"start_time_unix_nano":start,"end_time_unix_nano":end})));
    }
    for (id, start, end) in [
        (
            "child-anchored-retry",
            "1780541855200000000",
            "1780541855300000000",
        ),
        (
            "child-anchored-final",
            "1780541855600000000",
            "1780541855800000000",
        ),
    ] {
        let mut patch = json!({"request_hash":"c".repeat(64),"error_type":"rate_limit_error","status_code":429,"start_time_unix_nano":start,"end_time_unix_nano":end});
        if id.ends_with("final") {
            patch["request_id"] = json!("req-child-terminal");
        }
        child_files.push(f.attempt("s", id, patch));
    }
    f.run("stop-failure",json!({"session_id":"s","transcript_path":path,"error":"server_error","hook_event_name":"StopFailure"}));
    assert!(f.records().is_empty());
    assert_eq!(
        f.state("s")["pending_subagent_turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for file in &parent_files {
        assert!(file.exists());
    }
    f.complete("s", "child", &path, &child);
    let records = f.records();
    let responses = events(&records, "llm.response");
    assert_eq!(responses.len(), 4);
    let children: Vec<_> = responses
        .iter()
        .filter(|r| r["gen_ai.agent.scope"] == "subagent")
        .collect();
    assert_eq!(children.len(), 2);
    assert_eq!(
        children
            .iter()
            .map(|r| r["gen_ai.response.id"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("attempt:child-anchored-retry"),
            json!("msg_child_error")
        ]
    );
    assert_eq!(
        children
            .iter()
            .map(|r| r["gen_ai.request.id"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("req-child-anchored-retry"),
            json!("req-child-terminal")
        ]
    );
    for r in children {
        assert_eq!(r["gen_ai.agent.id"], "child");
        assert_eq!(r["gen_ai.subagent.parent_tool_call.id"], "agent_call_1");
        assert_eq!(r["error.type"], "rate_limit_error");
        assert_eq!(r["http.response.status_code"], 429);
        assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
    }
    let failed_parent = response(&records, "msg_parent_error");
    assert_eq!(failed_parent["error.type"], "server_error");
    assert_eq!(failed_parent["http.response.status_code"], 503);
    assert_eq!(failed_parent["time_unix_nano"], "1780541857000000000");
    assert!(failed_parent.get("gen_ai.request.id").is_none());
    for file in parent_files {
        assert!(file.exists());
    }
    for file in child_files {
        assert!(!file.exists());
    }
    f.complete("s", "child", &path, &child);
    assert_eq!(f.records(), records);
    let spans = export(&f, &records);
    let llm = llms(&spans);
    assert_eq!(llm.len(), 4);
    let success = llm
        .iter()
        .find(|s| s.attributes.get("gen_ai.response.id") == Some(&json!("msg_parent_1")))
        .unwrap();
    assert_ne!(success.status["code"], 2);
    assert!(!success.attributes.contains_key("error.type"));
    let failed_parent = llm
        .iter()
        .find(|s| s.attributes.get("gen_ai.response.id") == Some(&json!("msg_parent_error")))
        .unwrap();
    assert_eq!(failed_parent.status["code"], 2);
    assert_eq!(failed_parent.attributes["error.type"], "server_error");
    assert_eq!(failed_parent.attributes["http.response.status_code"], 503);
    let failed_children: Vec<_> = llm
        .iter()
        .filter(|s| s.attributes.get("error.type") == Some(&json!("rate_limit_error")))
        .collect();
    assert_eq!(failed_children.len(), 2);
    for s in failed_children {
        assert_eq!(s.attributes["gen_ai.agent.scope"], "subagent");
        assert_eq!(s.status["code"], 2);
    }
    let tool = spans
        .iter()
        .find(|s| s.name == "execute_tool Agent")
        .unwrap();
    let agent = spans
        .iter()
        .find(|s| {
            s.attributes.get("gen_ai.span.kind") == Some(&json!("AGENT"))
                && s.attributes.get("gen_ai.agent.scope") == Some(&json!("subagent"))
        })
        .unwrap();
    assert_eq!(agent.parent_span_id.as_deref(), Some(tool.span_id.as_str()));
    parents_healthy(&spans);
}
#[test]
fn invalid_child_transcript_reports_parse_error_without_breaking_parent() {
    let f = Fixture::new();
    let path = f.transcript("s", &parent(&[("broken", "general-purpose")], false));
    f.child("s","broken",&[json!({"type":"assistant","timestamp":"2026-06-04T02:57:35.100Z","message":{"id":"msg_broken","content":[null]}})]);
    f.stop("s", &path);
    let records = f.records();
    assert!(events(&records, "tool.call")
        .iter()
        .any(|r| r["gen_ai.tool.call.id"] == "agent_call_1"));
    assert!(!records
        .iter()
        .any(|r| r["gen_ai.agent.scope"] == "subagent"));
    let errors = read_jsonl(&f.data().join("logs/claude-code/errors"));
    assert!(errors
        .iter()
        .any(|r| r["stage"] == "subagent_transcript_parse" && r["error.type"] == "parse_failed"));
}
#[test]
fn traversal_and_empty_child_ids_never_escape_but_unicode_ids_resolve() {
    for id in ["../../../outside", "", "分析者"] {
        let f = Fixture::new();
        let path = f.transcript("s", &parent(&[(id, "general-purpose")], false));
        if id == "分析者" {
            f.child(
                "s",
                id,
                &[answer("msg_unicode", "2026-06-04T02:57:35.100Z", "完成")],
            );
        } else if id.contains('/') {
            write_rows(
                &f.root.join("transcripts/s/outside.jsonl"),
                &[answer(
                    "msg_outside",
                    "2026-06-04T02:57:35.100Z",
                    "must not be read",
                )],
            );
        }
        f.stop("s", &path);
        let records = f.records();
        assert_eq!(
            records
                .iter()
                .any(|r| r["gen_ai.agent.scope"] == "subagent"),
            id == "分析者"
        );
        if id == "分析者" {
            assert!(records
                .iter()
                .any(|r| r["gen_ai.agent.scope"] == "subagent" && r["gen_ai.agent.id"] == id));
        }
        assert!(!serde_json::to_string(&records)
            .unwrap()
            .contains("must not be read"));
    }
}
#[test]
fn background_bash_reserves_span_and_preserves_launch_result() {
    let f = Fixture::new();
    fs::write(f.data().join("config.json"),json!({"upstreamLink":{"enabled":true,"propagateToTools":true,"generateTraceWhenMissing":false}}).to_string()).unwrap();
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let pre=f.run_env("pre-tool-use",json!({"session_id":"s","tool_name":"Bash","tool_use_id":"tu_1","tool_input":{"command":"my-cli --serve","run_in_background":true}}),&[("TRACEPARENT",traceparent)]);
    let output: Value = serde_json::from_slice(&pre.stdout).unwrap();
    let updated = &output["hookSpecificOutput"]["updatedInput"];
    assert_eq!(updated["run_in_background"], true);
    let command = updated["command"].as_str().unwrap();
    let token = command
        .split("TRACEPARENT='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    let parts: Vec<_> = token.split('-').collect();
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[1], "4bf92f3577b34da6a3ce929d0e0e4736");
    valid_span(&json!(parts[2]));
    let mut rows = basic();
    rows[1]["message"]["content"][0]["input"] =
        json!({"command":"my-cli --serve","run_in_background":true});
    rows[2]["toolUseResult"] = json!({"backgroundTaskId":"bg-task-1"});
    rows[2]["message"]["content"][0]["content"] =
        json!("Command running in background with ID: bg-task-1");
    let path = f.transcript("s", &rows);
    f.run_env(
        "stop",
        json!({"session_id":"s","stop_reason":"end_turn","transcript_path":path}),
        &[("TRACEPARENT", traceparent)],
    );
    let records = f.records();
    let call = events(&records, "tool.call")
        .into_iter()
        .find(|r| r["gen_ai.tool.call.id"] == "tu_1")
        .unwrap();
    let result = events(&records, "tool.result")
        .into_iter()
        .find(|r| r["gen_ai.tool.call.id"] == "tu_1")
        .unwrap();
    assert_eq!(call["span_id"], parts[2]);
    assert_eq!(result["span_id"], parts[2]);
    assert_eq!(
        call["gen_ai.tool.call.arguments"]["run_in_background"],
        true
    );
    assert!(result["gen_ai.tool.call.result"]
        .as_str()
        .unwrap()
        .contains("bg-task-1"));
}
#[test]
fn multiple_tools_survive_end_turn_and_pairs_keep_declaring_step_and_span() {
    for count in [2, 3] {
        let f = Fixture::new();
        let mut rows = vec![prompt("2026-06-04T02:57:32.000Z", "complex task")];
        if count == 2 {
            rows.push(json!({"type":"assistant","timestamp":"2026-06-04T02:57:49.000Z","message":{"id":"msg_tools","content":[{"type":"tool_use","id":"t0","name":"Read","input":{}},{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{"input_tokens":100,"output_tokens":50},"stop_reason":"tool_use"}}));
            for i in 0..count {
                rows.push(json!({"type":"user","timestamp":format!("2026-06-04T02:57:5{i}.500Z"),"message":{"content":[{"type":"tool_result","tool_use_id":format!("t{i}"),"content":format!("r{i}")}]}}));
            }
        } else {
            rows.push(json!({"type":"assistant","timestamp":"2026-06-04T02:57:49.000Z","message":{"id":"msg_tools","content":[{"type":"thinking","thinking":"reading three files"}]}}));
            for i in 0..count {
                rows.push(json!({"type":"assistant","timestamp":format!("2026-06-04T02:57:5{i}.000Z"),"message":{"id":"msg_tools","content":[{"type":"tool_use","id":format!("t{i}"),"name":"Read","input":{}}],"usage":{"input_tokens":100,"output_tokens":50},"stop_reason":"tool_use"}}));
                rows.push(json!({"type":"user","timestamp":format!("2026-06-04T02:57:5{i}.500Z"),"message":{"content":[{"type":"tool_result","tool_use_id":format!("t{i}"),"content":format!("r{i}")}]}}));
            }
        }
        rows.push(answer("msg_final", "2026-06-04T02:57:55.000Z", "all done"));
        let path = f.transcript("s", &rows);
        f.stop("s", &path);
        let records = f.records();
        let calls = events(&records, "tool.call");
        let results = events(&records, "tool.result");
        assert_eq!(calls.len(), count);
        assert_eq!(results.len(), count);
        for call in calls {
            let result = results
                .iter()
                .find(|r| r["gen_ai.tool.call.id"] == call["gen_ai.tool.call.id"])
                .unwrap();
            assert!(call["gen_ai.step.id"].as_str().unwrap().contains(":s1"));
            assert!(result["gen_ai.step.id"].as_str().unwrap().contains(":s1"));
            assert_eq!(call["span_id"], result["span_id"]);
        }
    }
}
#[test]
fn basic_records_have_valid_hex_trace_and_agentteams_only_allowed_resources() {
    let f = Fixture::new();
    let path = f.transcript("s", &basic());
    f.run_env(
        "stop",
        json!({"session_id":"s","transcript_path":path}),
        &[
            ("AGENTTEAMS_REMOTE_MANAGED", "1"),
            ("AGENTTEAMS_RUNTIME", "claude-code"),
            ("AGENTTEAMS_WORKER_NAME", "local-worker"),
            ("AGENTTEAMS_INSTANCE_ID", "example-instance"),
            ("AGENTTEAMS_TOKEN", "should-not-leak"),
            ("AGENTTEAMS_TEAM_NAME", "local-worker-test"),
            ("AGENTTEAMS_ROLE", "worker"),
        ],
    );
    let records = f.records();
    assert!(records.len() >= 4);
    let mut traces = HashSet::new();
    for r in &records {
        assert_eq!(r["gen_ai.session.id"], "s");
        assert_eq!(r["gen_ai.agent.type"], "claude-code");
        let trace = r["trace_id"].as_str().unwrap();
        assert_eq!(trace.len(), 32);
        assert!(trace
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        traces.insert(trace);
        for key in [
            "agentteams.remote.managed",
            "agentteams.runtime",
            "agentteams.worker.name",
            "agentteams.instance.id",
            "agentteams.token",
            "agentteams.team.name",
            "agentteams.role",
        ] {
            assert!(r.get(key).is_none());
        }
        assert_eq!(
            r["resourceAttributes"],
            json!({"agentteams.worker.name":"local-worker","agentteams.instance.id":"example-instance"})
        );
        assert_eq!(r["gen_ai.agent.name"], "local-worker");
    }
    assert_eq!(traces.len(), 1);
    for event in ["llm.request", "llm.response", "tool.call", "tool.result"] {
        assert!(!events(&records, event).is_empty());
    }
}
#[test]
fn missing_session_creates_no_session_files_and_synthetic_replay_stays_empty() {
    let f = Fixture::new();
    f.run("stop", json!({"stop_reason":"end_turn"}));
    let sessions = f.data().join("state/claude-code/sessions");
    assert!(!sessions.exists() || fs::read_dir(sessions).unwrap().next().is_none());
    let rows = [
        json!({"type":"user","timestamp":"2026-06-04T02:57:30.000Z","promptId":"p1","isMeta":true,"message":{"content":[{"type":"text","text":"Continue from where you left off."}]}}),
        json!({"type":"assistant","timestamp":"2026-06-04T02:57:31.000Z","message":{"id":"synthetic_1","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}],"usage":{"input_tokens":0,"output_tokens":0},"stop_reason":"end_turn"}}),
    ];
    let path = f.transcript("s", &rows);
    f.stop("s", &path);
    assert!(f.state("s")["transcript_offset"].as_u64().unwrap() > 0);
    assert!(f.records().is_empty());
    f.stop("s", &path);
    assert!(f.records().is_empty());
}
