//! Native hook CLI -> real loopback interceptor -> native verdict persistence.
use loongsuite_pilot::interceptor::{
    adapters::wrap_host_reason,
    daemon::{
        create_interceptor_server, write_runtime, InterceptorServerOptions, RuntimeWriteOptions,
    },
    interceptor_access_log_path, interceptor_runtime_path,
    rules::{builtin_rules, RuleEngine},
    write_interceptor_access_log, AccessLogLimits, HookEventName, ToolInterceptPhase,
    ToolVerdictAction, ToolVerdictKey, ToolVerdictStore,
};
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::Path,
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

async fn hook(root: &Path, agent: &str, payload: &str) -> Output {
    let input = root.join("stdin.json");
    let stdout = root.join("stdout");
    let stderr = root.join("stderr");
    fs::write(&input, payload).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    command
        .args(["interceptor", "hook", "--agent", agent])
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root.join("data"))
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.join("cache"))
        .env("PATH", root.join("no-runtimes"))
        .stdin(Stdio::from(fs::File::open(input).unwrap()))
        .stdout(Stdio::from(fs::File::create(&stdout).unwrap()))
        .stderr(Stdio::from(fs::File::create(&stderr).unwrap()));
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = CandidateChild::spawn(&mut command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "native interceptor hook timed out"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    for file in [&stdout, &stderr] {
        assert!(fs::metadata(file).unwrap().len() < 1024 * 1024);
    }
    Output {
        status,
        stdout: fs::read(stdout).unwrap(),
        stderr: fs::read(stderr).unwrap(),
    }
}

fn success(output: &Output) {
    assert!(
        output.status.success(),
        "native hook exit={:?}",
        output.status.code()
    );
}

#[tokio::test]
async fn native_hook_uses_real_http_identity_rules_protocols_and_checkpoint_without_runtimes() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("no-runtimes")).unwrap();
    let data = root.path().join("data");
    let data_text = data.to_string_lossy().into_owned();
    let access = interceptor_access_log_path(Some(&data_text));
    let store = Arc::new(ToolVerdictStore::new(
        data.join("interceptor/tool-verdicts.json"),
    ));
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let server = create_interceptor_server(InterceptorServerOptions {
        version: "native-integration".into(),
        engine: RuleEngine::new(builtin_rules(), HashSet::from(["apiKey".into()])),
        write_access_log: Some(Arc::new({
            let access = access.clone();
            move |entry| {
                write_interceptor_access_log(&entry, Some(&access), AccessLogLimits::default())
            }
        })),
        write_tool_verdict: Some(Arc::new({
            let store = store.clone();
            move |key, action| store.put(&key, action, chrono::Utc::now().timestamp_millis())
        })),
        emit_blocked_prompt: Some(Arc::new({
            let emitted = emitted.clone();
            move |entry| emitted.lock().unwrap().push(entry)
        })),
    });
    let port = server.listen(0).await.unwrap();
    write_runtime(&RuntimeWriteOptions {
        data_dir: Some(&data_text),
        port,
        version: "native-integration",
        git_commit: Some("fixture"),
    })
    .await
    .unwrap();
    let secret = "sk-1234567890ABCDEFGHIJKLMN";
    let allow = hook(
        root.path(),
        "qoder",
        &json!({
            "hook_event_name":"UserPromptSubmit","prompt":"ordinary prompt","session_id":"s1"
        })
        .to_string(),
    )
    .await;
    success(&allow);
    assert!(allow.stdout.is_empty());

    for (agent, decision) in [
        ("qoder", "block"),
        ("qodercli", "deny"),
        ("qwen-work-cn", "block"),
    ] {
        let output = hook(
            root.path(),
            agent,
            &json!({
                "hook_event_name":"UserPromptSubmit","prompt":secret,"session_id":"s1"
            })
            .to_string(),
        )
        .await;
        success(&output);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            value,
            json!({
                "decision":decision,
                "reason":wrap_host_reason(HookEventName::UserPromptSubmit,Some("[APIKEY_BLOCKED]"))
            })
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    }
    let tool = hook(
        root.path(),
        "openclaw",
        &json!({
            "openclaw_hook":"before_tool_call","sessionId":"s2","toolCallId":"call-1",
            "toolName":"exec","params":{"command":secret}
        })
        .to_string(),
    )
    .await;
    success(&tool);
    assert_eq!(
        serde_json::from_slice::<Value>(&tool.stdout).unwrap(),
        json!({
            "block":true,
            "blockReason":wrap_host_reason(HookEventName::PreToolUse,Some("[APIKEY_BLOCKED]"))
        })
    );
    let key = ToolVerdictKey {
        session_id: Some("s2".into()),
        tool_use_id: "call-1".into(),
        phase: ToolInterceptPhase::PreToolUse,
    };
    let now = chrono::Utc::now().timestamp_millis();
    assert_eq!(store.get(&key, now), Some(ToolVerdictAction::Block));
    store.dump(now).unwrap();
    let restored = ToolVerdictStore::new(data.join("interceptor/tool-verdicts.json"));
    restored.restore(now);
    assert_eq!(restored.get(&key, now), Some(ToolVerdictAction::Block));
    {
        let entries = emitted.lock().unwrap();
        // Desktop and CLI prompts emit one synthetic event each; office and tool hooks do not.
        assert_eq!(entries.len(), 2);
    }

    let runtime = interceptor_runtime_path(Some(&data_text));
    let saved = fs::read(&runtime).unwrap();
    let mut mismatch: Value = serde_json::from_slice(&saved).unwrap();
    mismatch["pid"] = json!(u64::from(std::process::id()) + 1);
    fs::write(&runtime, mismatch.to_string()).unwrap();
    let output = hook(
        root.path(),
        "qoder",
        &json!({
            "hook_event_name":"UserPromptSubmit","prompt":secret,"session_id":"s1"
        })
        .to_string(),
    )
    .await;
    success(&output);
    assert!(output.stdout.is_empty());
    fs::remove_file(&runtime).unwrap();
    let output = hook(root.path(),"qodercli",&json!({
        "hook_event_name":"PreToolUse","tool_use_id":"missing-runtime","tool_input":{"command":secret}
    }).to_string()).await;
    success(&output);
    assert!(output.stdout.is_empty());
    assert_eq!(
        store.get(
            &ToolVerdictKey {
                session_id: None,
                tool_use_id: "missing-runtime".into(),
                phase: ToolInterceptPhase::PreToolUse
            },
            chrono::Utc::now().timestamp_millis()
        ),
        None
    );
    let output = hook(root.path(), "qoder", "{").await;
    success(&output);
    assert!(output.stdout.is_empty());
    let access = fs::read_to_string(access).unwrap();
    assert!(!access.contains(secret));
    let records: Vec<Value> = access
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(records
        .iter()
        .any(|entry| entry["result"]["error"] == "daemon identity mismatch"));
    assert!(records
        .iter()
        .any(|entry| entry["result"]["error"] == "interceptor runtime missing"));
    assert!(records
        .iter()
        .any(|entry| entry["result"]["error"] == "failed to parse host stdin"));
    assert!(records
        .iter()
        .any(|entry| entry["result"]["action"] == "block"));
    server.close().await;
}

#[tokio::test]
async fn native_hook_empty_config_and_stopped_server_fail_open_without_runtimes() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir(root.path().join("no-runtimes")).unwrap();
    let config = data.join("config.json");
    fs::write(&config, "{\"interceptor\":{}}\n").unwrap();
    let config = loongsuite_pilot::interceptor::load_interceptor_config(config.to_str()).await;
    let rules = loongsuite_pilot::interceptor::resolve_enabled_rule_ids(&config);
    assert!(rules.is_empty());
    let server = create_interceptor_server(InterceptorServerOptions {
        version: "native-empty-config".into(),
        engine: RuleEngine::new(builtin_rules(), rules),
        write_access_log: Some(Arc::new(|_| {})),
        write_tool_verdict: Some(Arc::new(|_, _| {
            panic!("prompt must not write tool verdict")
        })),
        emit_blocked_prompt: Some(Arc::new(|_| panic!("empty config must not emit a block"))),
    });
    let port = server.listen(0).await.unwrap();
    let data_text = data.to_string_lossy().into_owned();
    write_runtime(&RuntimeWriteOptions {
        data_dir: Some(&data_text),
        port,
        version: "native-empty-config",
        git_commit: None,
    })
    .await
    .unwrap();
    let runtime = interceptor_runtime_path(Some(&data_text));
    let before = fs::read(&runtime).unwrap();
    // Even a credential-shaped prompt is allowed when switches are empty.
    let payload = json!({
        "hook_event_name":"UserPromptSubmit",
        "prompt":"sk-1234567890ABCDEFGHIJKLMN"
    })
    .to_string();
    let allowed = hook(root.path(), "qoder", &payload).await;
    success(&allowed);
    assert!(allowed.stdout.is_empty());
    server.close().await;
    // Retain the real runtime file: exercise a failed connection rather than
    // the separate missing-runtime early return.
    let down = hook(root.path(), "qoder", &payload).await;
    success(&down);
    assert!(down.stdout.is_empty());
    assert_eq!(fs::read(runtime).unwrap(), before);
    assert!(!data.join("interceptor/tool-verdicts.json").exists());
    let access = fs::read_to_string(interceptor_access_log_path(Some(&data_text))).unwrap();
    let entries: Vec<Value> = access
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["result"]["action"], "fail-open");
    assert!(entries[0]["result"]["error"]
        .as_str()
        .is_some_and(|error| !error.is_empty()));
    assert!(!access.contains("sk-1234567890ABCDEFGHIJKLMN"));
}
