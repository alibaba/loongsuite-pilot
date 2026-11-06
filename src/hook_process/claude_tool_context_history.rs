use super::*;
use std::collections::BTreeSet;
const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const UPSTREAM: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
fn fixture() -> (tempfile::TempDir, Env) {
    let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let env = Env::from([(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.path().to_string_lossy().into_owned(),
    )]);
    (root, env)
}
fn hex(value: &str, size: usize) {
    assert_eq!(value.len(), size);
    assert!(value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}
fn upstream_env(env: &mut Env) {
    env.insert("TRACEPARENT".into(), UPSTREAM.into());
    env.insert("TRACESTATE".into(), "vendor=value".into());
}
#[test]
fn l72_idempotent_reservation_preserves_unsampled_flags_and_tracestate() {
    let (_root, mut env) = fixture();
    upstream_env(&mut env);
    let first = reserve_tool_context(&env, "sid-1", "", "tool-1", false).unwrap();
    let second = reserve_tool_context(&env, "sid-1", "", "tool-1", false).unwrap();
    hex(&first.span_id, 16);
    assert_eq!(
        first.traceparent,
        format!("00-{TRACE_ID}-{}-00", first.span_id)
    );
    assert_eq!(first.tracestate.as_deref(), Some("vendor=value"));
    assert_eq!(first.span_id, second.span_id);
}
#[test]
fn l94_full_bash_replacement_retains_other_fields_and_quotes_tracestate() {
    let (_root, mut env) = fixture();
    upstream_env(&mut env);
    env.insert("TRACESTATE".into(), "vendor=value'quoted".into());
    let c = reserve_tool_context(&env, "sid-2", "", "tool-2", false).unwrap();
    let updated=build_bash_updated_input(Some(&json!({"command":"printf hello | sed s/h/H/","description":"pipeline","timeout":1234,"run_in_background":true})),Some(&c.traceparent),c.tracestate.as_deref(),None).unwrap();
    assert_eq!(updated["description"], "pipeline");
    assert_eq!(updated["timeout"], 1234);
    assert_eq!(updated["run_in_background"], true);
    let command = updated["command"].as_str().unwrap();
    assert!(command.contains(&format!("export TRACEPARENT='{}'", c.traceparent)));
    assert!(command.contains("export TRACESTATE='vendor=value'\\''quoted'"));
    assert!(!command.contains("OTEL_RESOURCE_ATTRIBUTES"));
    assert!(command.ends_with("printf hello | sed s/h/H/"));
}
#[test]
fn l118_local_prompt_trace_has_distinct_tool_parents_and_durable_seed() {
    let (_root, env) = fixture();
    let a = reserve_tool_context(&env, "sid-local", "prompt-1", "tool-1", true).unwrap();
    let b = reserve_tool_context(&env, "sid-local", "prompt-1", "tool-2", true).unwrap();
    hex(&a.trace_id, 32);
    assert_eq!(a.trace_id, b.trace_id);
    assert_ne!(a.span_id, b.span_id);
    assert_eq!(a.traceparent, format!("00-{}-{}-01", a.trace_id, a.span_id));
    let seed = read_turn_context(&env, "sid-local", "prompt-1").unwrap();
    assert_eq!(seed.trace_id, a.trace_id);
    let raw: Value = serde_json::from_str(
        &fs::read_to_string(turn_context_path(&env, "sid-local", "prompt-1")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["source"], "local");
    assert_eq!(raw["traceId"], a.trace_id);
    assert_eq!(raw["flags"], "01");
}
#[test]
fn l211_acp_managed_session_does_not_generate_competing_context() {
    let (_root, env) = fixture();
    let dir = correlate_dir(&env);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("sid-acp.jsonl"),
        json!({"type":"turn","sessionId":"sid-acp","traceparent":UPSTREAM}).to_string() + "\n",
    )
    .unwrap();
    assert!(reserve_tool_context(&env, "sid-acp", "prompt-acp", "tool-acp", true).is_none());
}
#[test]
fn l232_later_prompt_uses_fresh_local_trace_without_consumed_upstream_tracestate() {
    let (_root, mut env) = fixture();
    upstream_env(&mut env);
    let first = reserve_tool_context(&env, "sid-mixed", "prompt-1", "tool-upstream", true).unwrap();
    assert_eq!(first.trace_id, TRACE_ID);
    mark_tool_propagation_consumed(&env, "sid-mixed");
    env.insert("TRACESTATE".into(), "vendor=must-not-leak".into());
    let local = reserve_tool_context(&env, "sid-mixed", "prompt-2", "tool-local", true).unwrap();
    assert_ne!(local.trace_id, TRACE_ID);
    assert!(local.tracestate.is_none());
    let raw: Value = serde_json::from_str(
        &fs::read_to_string(turn_context_path(&env, "sid-mixed", "prompt-2")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["source"], "local");
}
#[test]
fn l259_resource_only_propagation_preserves_opaque_value_and_shell_quoting() {
    let updated = build_bash_updated_input(
        Some(&json!({"command":"my-cli --work","timeout":1000})),
        None,
        None,
        Some(" team=O'Reilly,deployment.environment.name=prod "),
    )
    .unwrap();
    assert_eq!(updated["timeout"], 1000);
    let command = updated["command"].as_str().unwrap();
    assert!(command.contains(
        "export OTEL_RESOURCE_ATTRIBUTES=' team=O'\\''Reilly,deployment.environment.name=prod '"
    ));
    assert!(!command.contains("TRACEPARENT"));
    assert!(command.ends_with("my-cli --work"));
}
#[test]
fn l274_terminal_crlf_is_trimmed_but_embedded_resource_newlines_fail_open() {
    for text in ["team=infra\n", "team=infra\r\n"] {
        let updated =
            build_bash_updated_input(Some(&json!({"command":"my-cli"})), None, None, Some(text))
                .unwrap();
        assert!(updated["command"]
            .as_str()
            .unwrap()
            .contains("export OTEL_RESOURCE_ATTRIBUTES='team=infra'"));
    }
    assert!(build_bash_updated_input(
        Some(&json!({"command":"my-cli"})),
        None,
        None,
        Some("team=infra\nowner=pilot")
    )
    .is_none());
}
#[test]
fn l292_context_consumes_once_and_stop_rejects_later_env_only_context() {
    let (_root, mut env) = fixture();
    upstream_env(&mut env);
    let first = reserve_tool_context(&env, "sid-3", "", "tool-3", false).unwrap();
    assert_eq!(
        consume_tool_context(&env, "sid-3", "tool-3")
            .unwrap()
            .span_id,
        first.span_id
    );
    assert!(consume_tool_context(&env, "sid-3", "tool-3").is_none());
    mark_tool_propagation_consumed(&env, "sid-3");
    assert!(propagation_consumed(&env, "sid-3"));
    assert!(reserve_tool_context(&env, "sid-3", "", "tool-next-turn", false).is_none());
}
#[test]
fn l312_later_stop_refreshes_the_real_marker_mtime_past_stale_retention_window() {
    let (_root, env) = fixture();
    mark_tool_propagation_consumed(&env, "sid-ttl");
    let path = consumed_path(&env, "sid-ttl");
    assert!(path.is_file());
    let stale = SystemTime::now() - Duration::from_secs(48 * 60 * 60);
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(stale))
        .unwrap();
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    mark_tool_propagation_consumed(&env, "sid-ttl");
    assert!(fs::metadata(path).unwrap().modified().unwrap() > before);
    assert!(propagation_consumed(&env, "sid-ttl"));
}
#[test]
fn l329_invalid_trace_and_malformed_bash_input_fail_open() {
    let (_root, mut env) = fixture();
    env.insert("TRACEPARENT".into(), "invalid".into());
    assert!(reserve_tool_context(&env, "sid-4", "", "tool-4", false).is_none());
    assert!(
        build_bash_updated_input(Some(&json!({"command":""})), Some(UPSTREAM), None, None)
            .is_none()
    );
    assert!(build_bash_updated_input(
        Some(&json!({"command":"my-cli"})),
        None,
        None,
        Some("team=bad\nvalue")
    )
    .is_none());
}
fn child(
    root: &Path,
    name: &str,
    mode: &str,
    extra: &[(&str, String)],
) -> crate::utils::candidate_process::CandidateChild {
    use std::process::{Command, Stdio};
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--nocapture"])
        .env_clear()
        .env("PILOT_CLAUDE_CONTEXT_MODE", mode)
        .env("PILOT_CLAUDE_CONTEXT_ROOT", root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("CODEX_HOME", root.join("codex"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env("PATH", root.join("no-runtimes"))
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in extra {
        command.env(key, value);
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
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    crate::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap()
}
fn await_file(path: &Path) {
    let until = std::time::Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < until,
            "controlled child never became ready: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(1));
    }
}
fn finish(mut child: crate::utils::candidate_process::CandidateChild) {
    let until = std::time::Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < until,
            "controlled child did not finish"
        );
        thread::sleep(Duration::from_millis(1));
    };
    let mut error = String::new();
    if let Some(mut stderr) = child.take_stderr() {
        stderr.read_to_string(&mut error).unwrap();
    }
    assert!(status.success(), "{error}");
}
#[test]
fn l146_actual_eight_process_reservations_share_one_trace_and_six_duplicate_tools_share_one_span() {
    if std::env::var("PILOT_CLAUDE_CONTEXT_MODE").as_deref() == Ok("reserve") {
        let root = PathBuf::from(std::env::var_os("PILOT_CLAUDE_CONTEXT_ROOT").unwrap());
        let prompt = std::env::var("PILOT_CONTEXT_PROMPT").unwrap();
        let index = std::env::var("PILOT_CONTEXT_INDEX").unwrap();
        let tool = std::env::var("PILOT_CONTEXT_TOOL").unwrap();
        fs::write(root.join(format!("{prompt}.{index}.ready")), b"ready").unwrap();
        await_file(&root.join(format!("{prompt}.release")));
        let env = Env::from([(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        let context = reserve_tool_context(&env, "sid-parallel", &prompt, &tool, true).unwrap();
        fs::write(root.join(format!("{prompt}.{index}.result.json")),json!({"traceId":context.trace_id,"spanId":context.span_id,"traceparent":context.traceparent}).to_string()).unwrap();
        return;
    }
    let (root, _) = fixture();
    let name = thread::current().name().unwrap().to_owned();
    for (prompt, count, duplicate) in [("prompt-parallel", 8, false), ("prompt-duplicate", 6, true)]
    {
        let mut children = Vec::new();
        for index in 0..count {
            let tool = if duplicate {
                "tool-duplicate".into()
            } else {
                format!("tool-{index}")
            };
            children.push(child(
                root.path(),
                &name,
                "reserve",
                &[
                    ("PILOT_CONTEXT_PROMPT", prompt.into()),
                    ("PILOT_CONTEXT_INDEX", index.to_string()),
                    ("PILOT_CONTEXT_TOOL", tool),
                ],
            ));
        }
        for index in 0..count {
            await_file(&root.path().join(format!("{prompt}.{index}.ready")));
        }
        fs::write(root.path().join(format!("{prompt}.release")), b"release").unwrap();
        for process in children {
            finish(process)
        }
        let rows = (0..count)
            .map(|index| {
                serde_json::from_str::<Value>(
                    &fs::read_to_string(root.path().join(format!("{prompt}.{index}.result.json")))
                        .unwrap(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter()
                .map(|r| r["traceId"].as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len(),
            1,
            "concurrent hooks split prompt trace: {rows:?}"
        );
        assert_eq!(
            rows.iter()
                .map(|r| r["spanId"].as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len(),
            if duplicate { 1 } else { count },
            "immutable per-tool identity violated: {rows:?}"
        );
    }
}
#[test]
fn l163_actual_older_process_empty_then_complete_record_is_adopted_without_split_trace() {
    const LEGACY: &str = "cccccccccccccccccccccccccccccccc";
    if std::env::var("PILOT_CLAUDE_CONTEXT_MODE").as_deref() == Ok("legacy") {
        let root = PathBuf::from(std::env::var_os("PILOT_CLAUDE_CONTEXT_ROOT").unwrap());
        let dir = root.join("acp-correlate");
        fs::create_dir_all(&dir).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join("sid-legacy.prompt-legacy.turn-context.json"))
            .unwrap();
        fs::write(root.join("legacy.ready"), b"ready").unwrap();
        thread::sleep(Duration::from_millis(30));
        file.write_all(json!({"type":"turn","source":"local","sessionId":"sid-legacy","promptId":"prompt-legacy","traceId":LEGACY,"flags":"01"}).to_string().as_bytes()).unwrap();
        file.flush().unwrap();
        return;
    }
    let (root, env) = fixture();
    let name = thread::current().name().unwrap().to_owned();
    let writer = child(root.path(), &name, "legacy", &[]);
    await_file(&root.path().join("legacy.ready"));
    let context = reserve_tool_context(&env, "sid-legacy", "prompt-legacy", "tool-legacy", true);
    finish(writer);
    assert_eq!(
        context.as_ref().map(|c| c.trace_id.as_str()),
        Some(LEGACY),
        "bounded reader must wait for the existing winner, not drop reservation"
    );
    assert_eq!(
        read_turn_context(&env, "sid-legacy", "prompt-legacy")
            .unwrap()
            .trace_id,
        LEGACY
    );
}
