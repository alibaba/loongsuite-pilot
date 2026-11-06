//! 规则工具正式 CLI：隔离 HOME/PATH，只连接测试 loopback HTTP。

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(root: &Path, args: &[&str]) -> Output {
    let capture = tempfile::tempdir().unwrap();
    let out = capture.path().join("out");
    let err = capture.path().join("err");
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .arg("update-validation-rules")
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root.join("no-runtimes"))
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out).unwrap())
        .stderr(fs::File::create(&err).unwrap());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child =
        loongsuite_pilot::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(start.elapsed() < Duration::from_secs(40), "规则 CLI 超时");
        std::thread::sleep(Duration::from_millis(10));
    };
    let read = |path| {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .unwrap()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 1024 * 1024);
        bytes
    };
    Output {
        status,
        stdout: read(out),
        stderr: read(err),
    }
}

fn spec() -> String {
    let mut spec = String::from("\u{feff}# 公共部分\r\n## Attributes\r\n| gen_ai.session.id | 会话 | string | id | 可选 |\r\n## Resources\r\n| service.name | 服务 | string | pilot | 必须 |\r\n");
    for (name, kind) in [
        ("Chain", "CHAIN"),
        ("Retriever", "RETRIEVER"),
        ("Reranker", "RERANKER"),
        ("LLM", "LLM"),
        ("Embedding", "EMBEDDING"),
        ("Tool", "TOOL"),
        ("Agent", "AGENT"),
        ("Task", "TASK"),
        ("Entry", "ENTRY"),
        ("ReAct Step", "STEP"),
    ] {
        spec.push_str(&format!(
            "# {name}\r\n## Attributes\r\n| gen_ai.span.kind | 类型 | string | {kind} | 必须 |\r\n"
        ));
    }
    spec.push_str("## Mapping\n| `gen_ai.span.kind` | `gen_ai.operation.name` | Description |\n| --- | --- | --- |\n| LLM | chat; generate_content | 模型 |\n");
    spec
}

#[test]
fn strict_cli_generates_full_rules_and_diff_never_writes() {
    let root = tempfile::Builder::new()
        .prefix("规则 空格🚀")
        .tempdir()
        .unwrap();
    let input = root.path().join("规范.md");
    let output = root.path().join("rules.json");
    fs::write(&input, spec()).unwrap();
    let args = [
        "--spec-file",
        input.to_str().unwrap(),
        "-o",
        output.to_str().unwrap(),
        "--strict",
    ];
    let mut diff = args.to_vec();
    diff.push("--diff");
    let result = invoke(root.path(), &diff);
    assert!(result.status.success(), "{result:?}");
    assert!(!output.exists());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    let result = invoke(root.path(), &args);
    assert!(result.status.success(), "{result:?}");
    let before = fs::read(&output).unwrap();
    let rules: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(rules["version"], "1.1");
    assert_eq!(rules["spanKinds"].as_object().unwrap().len(), 10);
    assert_eq!(
        rules["commonAttributes"]["must"],
        json!([{"key":"gen_ai.session.id","type":"string"}])
    );
    assert_eq!(rules["operationKindMapping"]["chat"], "LLM");
    assert_eq!(
        rules["spanKinds"]["STEP"]["constraints"][0],
        json!({"rule":"exactly_one_child_of_kind","kind":"LLM"})
    );
    assert_eq!(
        rules["spanKinds"]["AGENT"]["aggregation"]["gen_ai.usage.total_tokens"],
        json!({"rule":"sum","source":"LLM","scope":"own_agent_execution_excluding_delegated_agents"})
    );
    for value in rules["messageSchemas"].as_object().unwrap().values() {
        let relative = value.as_str().unwrap().strip_prefix("$ref:").unwrap();
        assert!(Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(relative)
            .is_file());
    }
    let modified = fs::metadata(&output).unwrap().modified().unwrap();
    let result = invoke(root.path(), &diff);
    assert!(result.status.success(), "{result:?}");
    assert!(String::from_utf8_lossy(&result.stdout).contains("0 项规则差异"));
    assert_eq!(fs::read(&output).unwrap(), before);
    assert_eq!(fs::metadata(&output).unwrap().modified().unwrap(), modified);
    assert_eq!(fs::read_to_string(&input).unwrap(), spec());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn invalid_spec_and_existing_rules_preserve_files_and_exit_codes() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("spec.md");
    let output = root.path().join("rules.json");
    fs::write(&output, "{\"sentinel\":true}\n").unwrap();
    let args = [
        "--spec-file",
        input.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
        "--strict",
    ];
    assert_eq!(invoke(root.path(), &args).status.code(), Some(2));
    for contents in [
        "",
        "<html>登录页</html>",
        "# LLM\n## Attributes\n| model | 模型 | string | x | 必须 |\n",
        "# LLM\n## Attributes\n| secret | 原文不能泄露 | int | 0 | 未知 |\n",
    ] {
        fs::write(&input, contents).unwrap();
        let result = invoke(root.path(), &args);
        assert_eq!(result.status.code(), Some(1), "{result:?}");
        assert!(!String::from_utf8_lossy(&result.stderr).contains("原文不能泄露"));
        assert_eq!(
            fs::read_to_string(&output).unwrap(),
            "{\"sentinel\":true}\n"
        );
    }
    fs::write(&input, spec()).unwrap();
    for corrupt in ["broken json", "[]"] {
        fs::write(&output, corrupt).unwrap();
        assert_eq!(invoke(root.path(), &args).status.code(), Some(1));
        assert_eq!(fs::read_to_string(&output).unwrap(), corrupt);
    }
    assert_eq!(
        invoke(
            root.path(),
            &[
                "--spec-file",
                input.to_str().unwrap(),
                "-o",
                input.to_str().unwrap()
            ]
        )
        .status
        .code(),
        Some(1)
    );
    assert_eq!(fs::read_to_string(&input).unwrap(), spec());
    let missing_parent = root.path().join("absent/rules.json");
    let result = invoke(
        root.path(),
        &[
            "--spec-file",
            input.to_str().unwrap(),
            "-o",
            missing_parent.to_str().unwrap(),
            "--diff",
        ],
    );
    assert!(result.status.success(), "{result:?}");
    assert!(!root.path().join("absent").exists());
    for args in [vec!["--spec-file"], vec!["--unknown"], vec!["--diff=true"]] {
        assert_eq!(invoke(root.path(), &args).status.code(), Some(2));
    }
    assert!(invoke(root.path(), &["--help"]).status.success());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

fn server(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/spec?test-token=never-print-this",
        listener.local_addr().unwrap()
    );
    let thread = std::thread::spawn(move || {
        let start = Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        start.elapsed() < Duration::from_secs(10),
                        "没有收到规则请求"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 512];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0 && request.len() < 8192);
            request.extend_from_slice(&buffer[..n]);
        }
        // 超限拒绝时客户端可以提前关闭。
        let _ = stream.write_all(&response);
    });
    (url, thread)
}

#[test]
fn http_source_supports_gzip_and_rejects_status_size_and_secret_echoes() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("rules.json");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(spec().as_bytes()).unwrap();
    let body = encoder.finish().unwrap();
    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    response.extend_from_slice(&body);
    let (url, thread) = server(response);
    let result = invoke(
        root.path(),
        &[
            "--spec-url",
            &url,
            "-o",
            output.to_str().unwrap(),
            "--strict",
        ],
    );
    thread.join().unwrap();
    assert!(result.status.success(), "{result:?}");
    let before = fs::read(&output).unwrap();
    let mut oversized = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
    oversized.resize(oversized.len() + 16 * 1024 * 1024 + 1, b'x');
    for response in [
        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n".to_vec(),
        oversized,
    ] {
        let (url, thread) = server(response);
        let result = invoke(
            root.path(),
            &["--spec-url", &url, "-o", output.to_str().unwrap()],
        );
        thread.join().unwrap();
        assert_eq!(result.status.code(), Some(1), "{result:?}");
        assert!(!String::from_utf8_lossy(&result.stdout).contains("never-print-this"));
        assert!(!String::from_utf8_lossy(&result.stderr).contains("never-print-this"));
        assert_eq!(fs::read(&output).unwrap(), before);
    }
    for url in [
        "file:///secret",
        "https://user:never-print-this@example.invalid",
        "not a URL",
    ] {
        let result = invoke(
            root.path(),
            &["--spec-url", url, "-o", output.to_str().unwrap()],
        );
        assert_eq!(result.status.code(), Some(1));
        assert!(!String::from_utf8_lossy(&result.stderr).contains("never-print-this"));
        assert_eq!(fs::read(&output).unwrap(), before);
    }
}

#[cfg(unix)]
#[test]
fn output_links_are_rejected_and_existing_private_mode_is_preserved() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("spec.md");
    let output = root.path().join("rules.json");
    let linked = root.path().join("linked.json");
    fs::write(&input, spec()).unwrap();
    fs::write(&output, "{}").unwrap();
    fs::set_permissions(&output, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&output, &linked).unwrap();
    let result = invoke(
        root.path(),
        &[
            "--spec-file",
            input.to_str().unwrap(),
            "-o",
            linked.to_str().unwrap(),
        ],
    );
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(fs::read(&output).unwrap(), b"{}");
    let result = invoke(
        root.path(),
        &[
            "--spec-file",
            input.to_str().unwrap(),
            "-o",
            output.to_str().unwrap(),
        ],
    );
    assert!(result.status.success(), "{result:?}");
    assert_eq!(
        fs::metadata(&output).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
