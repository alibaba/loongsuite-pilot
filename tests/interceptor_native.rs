//! Retired native commands must never fall back to the old HTTP interceptor.
use loongsuite_pilot::interceptor::{
    daemon::{
        create_interceptor_server, write_runtime, InterceptorServerOptions, RuntimeWriteOptions,
    },
    interceptor_runtime_path,
    rules::{builtin_rules, RuleEngine},
};
use loongsuite_pilot::utils::candidate_process::CandidateChild;
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    path::Path,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

async fn hook(root: &Path, binary: &str, agent: &str, payload: &str) -> Output {
    let input = root.join("stdin.json");
    let stdout = root.join("stdout");
    let stderr = root.join("stderr");
    fs::write(&input, payload).unwrap();
    let mut command = Command::new(binary);
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
async fn retired_hook_commands_ignore_an_active_http_interceptor() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let data_text = data.to_string_lossy();
    fs::create_dir(root.path().join("no-runtimes")).unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let server = create_interceptor_server(InterceptorServerOptions {
        version: "native-interceptor-retirement".into(),
        engine: RuleEngine::new(builtin_rules(), HashSet::from(["apiKey".into()])),
        write_access_log: Some(Arc::new({
            let requests = requests.clone();
            move |_| {
                requests.fetch_add(1, Ordering::Relaxed);
            }
        })),
        write_tool_verdict: None,
        emit_blocked_prompt: None,
    });
    let port = server.listen(0).await.unwrap();
    write_runtime(&RuntimeWriteOptions {
        data_dir: Some(&data_text),
        port,
        version: "native-interceptor-retirement",
        git_commit: None,
    })
    .await
    .unwrap();
    let runtime = interceptor_runtime_path(Some(&data_text));
    let descriptor = fs::read(&runtime).unwrap();
    let payload = json!({
        "hook_event_name": "UserPromptSubmit",
        "prompt": "sk-1234567890ABCDEFGHIJKLMN",
        "session_id": "s1"
    })
    .to_string();
    let full = env!("CARGO_BIN_EXE_loongsuite-pilot");
    let thin = env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook");
    for (binary, agent) in [
        (full, "qoder"),
        (thin, "qodercli"),
        (full, "qwen-work-cn"),
        (full, "openclaw"),
    ] {
        let output = hook(root.path(), binary, agent, &payload).await;
        success(&output);
        assert!(output.stdout.is_empty(), "{agent}");
    }
    assert_eq!(requests.load(Ordering::Relaxed), 0);
    assert_eq!(fs::read(runtime).unwrap(), descriptor);
    server.close().await;
}
