//! Exact old Doubao structure/time matrices through the shipped Rust CLI.
//! The original only called its structure/time validators. CLI schema/semantic
//! checks also run, and are kept separate from those original selected checks.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/doubao-strict-semantics-original.json"
    ))
    .unwrap()
}
fn native(root: &Path, rows: &Value) -> Value {
    let bytes = rows
        .as_array()
        .unwrap()
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(root.join("input.jsonl"), &bytes).unwrap();
    fs::write(
        root.join("rules.json"),
        include_bytes!("../../docs/trace-validation-rules.json"),
    )
    .unwrap();
    let out = root.join("stdout");
    let err = root.join("stderr");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_xtask"));
    cmd.args([
        "validate-trace",
        "-i",
        "input.jsonl",
        "-r",
        "rules.json",
        "-f",
        "json",
    ])
    .current_dir(root)
    .env_clear()
    .env("HOME", root)
    .env("USERPROFILE", root)
    .env("PATH", root.join("no-runtimes"))
    .stdin(Stdio::null())
    .stdout(fs::File::create(&out).unwrap())
    .stderr(fs::File::create(&err).unwrap());
    for k in ["SystemRoot", "WINDIR"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("original default 5s test budget");
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    assert!(
        matches!(status.code(), Some(0 | 1)),
        "{}",
        String::from_utf8_lossy(&fs::read(err).unwrap())
    );
    let result: Value = serde_json::from_slice(&fs::read(out).unwrap()).unwrap();
    assert_eq!(fs::read_to_string(root.join("input.jsonl")).unwrap(), bytes);
    result
}
fn exact(index: usize) {
    let root = tempfile::tempdir().unwrap();
    let fixture = fixture();
    for check in fixture["cases"][index]["checks"].as_array().unwrap() {
        let report = native(root.path(), &check["rows"]);
        let checks: Vec<_> = report["traces"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|t| t["checks"].as_array().unwrap())
            .collect();
        if let Some(expected) = check.get("expectContains") {
            assert!(
                checks.iter().any(|c| expected
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(k, v)| c.get(k) == Some(v))),
                "{}",
                &report
            );
        } else {
            assert_eq!(check["expectNoErrors"], true);
            let prefix = format!("{}.", check["kind"].as_str().unwrap());
            let errors: Vec<_> = checks
                .iter()
                .filter(|c| {
                    c["id"].as_str().unwrap().starts_with(&prefix) && c["status"] == "error"
                })
                .collect();
            assert!(errors.is_empty(), "{}", &report);
        }
    }
}
#[test]
fn native_doubao_receipt_metadata_does_not_exempt_a_tool_from_step_ownership() {
    exact(0)
}
#[test]
fn native_doubao_local_fragment_and_sandbox_metadata_do_not_create_agent_delegation() {
    exact(1);
    exact(2)
}
#[test]
fn native_doubao_tool_fragment_does_not_relax_asynchronous_containment() {
    exact(3)
}
#[test]
fn native_doubao_real_react_round_and_background_delegation_keep_structure_and_timing_valid() {
    exact(4)
}
