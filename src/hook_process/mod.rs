//! Out-of-process hook entry point.
//!
//! Agent shell wrappers can exec `loongsuite-pilot hook-process <agent>` instead
//! of `node <agent>-hook-processor.mjs`. A terminal stdin is a manual run and
//! returns `{}` immediately. Otherwise the agent module reads the hook payload
//! and writes the same JSONL or state files as the JavaScript processor.

mod claude_code;
mod codex;
mod common;
mod copilot;
mod cursor;
mod grok_build;
mod kiro_cli;
mod payload_decoder;
mod qoder;
mod qoder_wakeup;
mod qoder_work;
mod qwen_code_cli;
mod qwen_work_cn;
mod workbuddy;

pub(crate) use qoder::resolve_collected_qoder_user_id;
pub use qoder::{
    build_collected_transcript_turn, qoder_has_cn_terminal, qoder_is_control_user_row,
    qoder_is_real_user_prompt, qoder_legacy_retry_lock_path, CollectedTranscriptTurnContext,
};
pub use qoder::{
    resolve_qoder_collector_cli_identity, resolve_qoder_collector_cli_identity_with_env,
};
pub use qoder_wakeup::{publish_qoder_wakeup, with_qoder_wakeup_lock};

use common::{write_empty, Env, HookRequest};
use std::io::{IsTerminal, Read, Write};

pub fn run_hook_process(agent: &str) -> i32 {
    let started = std::time::Instant::now();
    crate::utils::redirect_root_logger_to_stderr();
    let args: Vec<String> = std::env::args().skip(3).collect();
    let bounded_qoder =
        matches!(agent, "qoder" | "qoder-cn") && args.iter().any(|arg| arg == "--wakeup-only");
    let mut env: Env = std::env::vars().collect();
    if bounded_qoder {
        if let Some(index) = args.iter().position(|arg| arg == "--data-dir") {
            let Some(data_dir) = args
                .get(index + 1)
                .filter(|path| std::path::Path::new(path).is_absolute())
            else {
                write_empty(&mut std::io::stdout());
                return 0;
            };
            env.insert("LOONGSUITE_PILOT_DATA_DIR".into(), data_dir.clone());
        }
    }
    let terminal = std::io::stdin().is_terminal();
    let mut raw = Vec::new();
    if !terminal {
        if bounded_qoder {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let mut payload = Vec::new();
                let result = std::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut payload);
                let _ = send.send(if result.is_ok() && payload.len() <= 1024 * 1024 {
                    payload
                } else {
                    Vec::new()
                });
            });
            raw = receive
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or_default();
        } else {
            let _ = std::io::stdin().read_to_end(&mut raw);
        }
    }
    let mut stdout = std::io::stdout();
    dispatch(agent, terminal, &raw, &args, &env, &mut stdout, started)
}

pub(crate) fn dispatch(
    agent: &str,
    terminal: bool,
    stdin: &[u8],
    args: &[String],
    env: &Env,
    stdout: &mut dyn Write,
    started: std::time::Instant,
) -> i32 {
    if terminal {
        write_empty(stdout);
        return 0;
    }
    let mut request = HookRequest {
        args,
        stdin,
        env,
        stdout,
    };
    let code = match agent {
        "cursor" => cursor::run(&mut request),
        "claude-code" => claude_code::run(&mut request),
        "codex" => codex::run(&mut request),
        "copilot" => copilot::run(&mut request),
        "qwen-code-cli" => qwen_code_cli::run(&mut request),
        "qwen-work-cn" => qwen_work_cn::run(&mut request),
        "grok-build" => grok_build::run(&mut request),
        "qoder" | "qoder-cn" => qoder::run(&mut request),
        "kiro-cli" => kiro_cli::run(&mut request),
        "qoderwork" | "qoder-work" | "qoder-work-cn" => qoder_work::run(&mut request),
        "workbuddy" => workbuddy::run(&mut request),
        _ => {
            write_empty(request.stdout);
            0
        }
    };
    if agent == "codex" {
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
        crate::metrics::record_hook_timing(
            &common::data_dir(env),
            "codex",
            args.first().map(|s| s.trim()).unwrap_or(""),
            duration_ms,
        );
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};

    struct Outcome {
        code: i32,
        stdout: String,
        root: PathBuf,
        _dir: tempfile::TempDir,
    }

    fn invoke(agent: &str, args: &[&str], stdin: &str, extra: &[(&str, &str)]) -> Outcome {
        let dir = tempfile::tempdir().expect("tempdir");
        let (code, stdout) = invoke_in(dir.path(), agent, args, stdin, extra);
        Outcome {
            code,
            stdout,
            root: dir.path().to_path_buf(),
            _dir: dir,
        }
    }

    fn invoke_in(
        root: &Path,
        agent: &str,
        args: &[&str],
        stdin: &str,
        extra: &[(&str, &str)],
    ) -> (i32, String) {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        for (key, value) in extra {
            env.insert((*key).to_string(), (*value).to_string());
        }
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        let mut stdout = Vec::new();
        let code = dispatch(
            agent,
            false,
            stdin.as_bytes(),
            &args,
            &env,
            &mut stdout,
            std::time::Instant::now(),
        );
        (code, String::from_utf8(stdout).expect("utf8 stdout"))
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(
            &fs::read_to_string(path).unwrap_or_else(|_| panic!("missing {}", path.display())),
        )
        .expect("json")
    }

    fn read_jsonl_dir(dir: &Path) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut records = Vec::new();
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .collect();
        paths.sort();
        for path in paths {
            let content = fs::read_to_string(path).unwrap_or_default();
            for line in content.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    records.push(value);
                }
            }
        }
        records
    }

    fn error_text(root: &Path, agent: &str) -> String {
        let dir = root.join("logs").join(agent).join("errors");
        let Ok(entries) = fs::read_dir(dir) else {
            return String::new();
        };
        entries
            .flatten()
            .map(|entry| fs::read_to_string(entry.path()).unwrap_or_default())
            .collect()
    }

    #[test]
    fn terminal_stdin_prints_empty_object() {
        let mut stdout = Vec::new();
        let code = dispatch(
            "cursor",
            true,
            b"not-json",
            &[],
            &Env::new(),
            &mut stdout,
            std::time::Instant::now(),
        );
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8(stdout).unwrap(), "{}\n");
    }

    #[test]
    fn unknown_agent_is_fail_open() {
        let outcome = invoke("not-an-agent", &[], "{}", &[]);
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.stdout, "{}\n");
    }

    #[test]
    fn codex_definition_exposes_only_discovery_and_retires_telemetry_hooks() {
        let definition: Value =
            serde_json::from_str(include_str!("../../agents.d/codex.json")).unwrap();
        assert_eq!(
            definition["hook"]["events"],
            json!([
                "SessionStart",
                "UserPromptSubmit",
                "SubagentStart",
                "SubagentStop",
                "Stop"
            ])
        );
        assert_eq!(
            definition["hook"]["retiredEvents"],
            json!(["PreToolUse", "PostToolUse", "PostToolUseFailure"])
        );
        assert!(definition["hook"].get("replaceHookCommands").is_none());
    }

    #[test]
    fn codex_both_invocation_events_preserve_filtered_context_and_isolate_each_turn() {
        let root = tempfile::tempdir().unwrap();
        let long_value = "x".repeat(513);
        let attributes=format!("multica.issue.id=issue-1,multica.agent.name=codex,gen_ai.agent.name=must-not-overwrite,multica.secret=must-not-leak,multica.long={long_value},malformed");
        for sub in ["user-prompt-submit", "stop"] {
            let (code, stdout) = invoke_in(
                root.path(),
                "codex",
                &[sub],
                &json!({"session_id":"cdx-span-context","turn_id":"turn-span-context"}).to_string(),
                &[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", attributes.as_str())],
            );
            assert_eq!(code, 0);
            assert_eq!(stdout.trim(), "{}");
            let context = read_json(
                &root
                    .path()
                    .join("state")
                    .join("codex")
                    .join("transcript-span-contexts")
                    .join("cdx-span-context--turn-span-context.json"),
            );
            assert_eq!(context["session_id"], "cdx-span-context");
            assert_eq!(context["turn_id"], "turn-span-context");
            assert_eq!(
                context["spanAttributes"],
                json!({"multica.issue.id":"issue-1","multica.agent.name":"codex"})
            );
            assert!(context["received_at"].is_string());
            let serialized = context.to_string();
            for forbidden in ["must-not-overwrite", "must-not-leak", long_value.as_str()] {
                assert!(!serialized.contains(forbidden));
            }
        }
        for index in 1..=2 {
            let attributes = format!("multica.issue.id=issue-{index}");
            let (code, _) = invoke_in(
                root.path(),
                "codex",
                &["user-prompt-submit"],
                &json!({"session_id":"cdx-shared-session","turn_id":format!("turn-{index}")})
                    .to_string(),
                &[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", attributes.as_str())],
            );
            assert_eq!(code, 0);
        }
        for index in 1..=2 {
            let context = read_json(
                &root
                    .path()
                    .join("state")
                    .join("codex")
                    .join("transcript-span-contexts")
                    .join(format!("cdx-shared-session--turn-{index}.json")),
            );
            assert_eq!(
                context["spanAttributes"],
                json!({"multica.issue.id":format!("issue-{index}")})
            );
        }
    }

    #[test]
    fn codex_writes_wakeup_marker_with_codex_home() {
        let root_dir = tempfile::tempdir().unwrap();
        let codex_home = root_dir.path().join("task-codex-home");
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({
                "session_id": "cdx-wakeup",
                "turn_id": "turn-wakeup",
                "transcript_path": "/tmp/rollout-cdx-wakeup.jsonl",
            })
            .to_string(),
            &[("CODEX_HOME", codex_home.to_str().unwrap())],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/cdx-wakeup.json"),
        );
        assert_eq!(marker["session_id"], "cdx-wakeup");
        assert_eq!(marker["turn_id"], "turn-wakeup");
        assert_eq!(marker["transcript_path"], "/tmp/rollout-cdx-wakeup.jsonl");
        assert_eq!(marker["codex_home"], codex_home.to_string_lossy().as_ref());
        assert_eq!(
            marker["session_dir"],
            codex_home.join("sessions").to_string_lossy().as_ref()
        );
        assert!(!root_dir.path().join("logs/codex").exists());
    }

    #[test]
    fn codex_records_isolated_user_session_directory() {
        let root_dir = tempfile::tempdir().unwrap();
        let codex_home = root_dir.path().join("codex-home");
        let isolated = codex_home
            .join("u")
            .join("d4bb12dfd37d67c70484b62e0ed31509")
            .join("sessions");
        let transcript = isolated
            .join("2026")
            .join("09")
            .join("17")
            .join("rollout-2026-09-17T02-43-12-session.jsonl");
        let (code, _) = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({
                "session_id": "cdx-isolated-home",
                "turn_id": "turn-isolated-home",
                "transcript_path": transcript,
            })
            .to_string(),
            &[("CODEX_HOME", codex_home.to_str().unwrap())],
        );
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/cdx-isolated-home.json"),
        );
        assert_eq!(code, 0);
        assert_eq!(marker["session_dir"], isolated.to_string_lossy().as_ref());
        assert_eq!(
            marker["transcript_path"],
            transcript.to_string_lossy().as_ref()
        );
        assert_eq!(marker["codex_home"], codex_home.to_string_lossy().as_ref());
    }

    #[test]
    fn codex_writes_discovery_markers_and_normalizes_subagents() {
        let root_dir = tempfile::tempdir().unwrap();
        for sub in ["session-start", "user-prompt-submit", "stop"] {
            let home = root_dir.path().join(format!("{sub}-home"));
            let (code, _) = invoke_in(
                root_dir.path(),
                "codex",
                &[sub],
                &json!({
                    "session_id": format!("cdx-{sub}"),
                    "turn_id": format!("turn-{sub}"),
                })
                .to_string(),
                &[("CODEX_HOME", home.to_str().unwrap())],
            );
            assert_eq!(code, 0);
            let marker = read_json(
                &root_dir
                    .path()
                    .join(format!("state/codex/transcript-wakeups/cdx-{sub}.json")),
            );
            assert_eq!(marker["session_id"], format!("cdx-{sub}"));
            assert_eq!(marker["codex_home"], home.to_string_lossy().as_ref());
            assert_eq!(
                marker["session_dir"],
                home.join("sessions").to_string_lossy().as_ref()
            );
        }
        let (start_code, _) = invoke_in(
            root_dir.path(),
            "codex",
            &["subagent-start"],
            &json!({
                "session_id": "parent-session",
                "agent_id": "child-session",
                "turn_id": "child-turn",
                "transcript_path": "/tmp/rollout-child.jsonl",
            })
            .to_string(),
            &[],
        );
        let start = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/child-session.json"),
        );
        assert_eq!(start_code, 0);
        assert_eq!(start["session_id"], "child-session");
        assert_eq!(start["turn_id"], "child-turn");
        assert_eq!(start["transcript_path"], "/tmp/rollout-child.jsonl");
        assert_eq!(start["initial_turn_id"], "child-turn");
        assert_eq!(start["hook_event"], "subagent-start");
        assert!(!root_dir
            .path()
            .join("state/codex/transcript-wakeups/parent-session.json")
            .exists());
        let (stop_code, _) = invoke_in(
            root_dir.path(),
            "codex",
            &["subagent-stop"],
            &json!({
                "session_id": "parent-session",
                "agent_id": "child-session",
                "turn_id": "child-turn",
                "transcript_path": "/tmp/rollout-parent.jsonl",
                "agent_transcript_path": "/tmp/rollout-child.jsonl",
            })
            .to_string(),
            &[],
        );
        let stop = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/child-session.json"),
        );
        assert_eq!(stop_code, 0);
        assert_eq!(stop["session_id"], "child-session");
        assert_eq!(stop["turn_id"], "child-turn");
        assert_eq!(stop["initial_turn_id"], "child-turn");
        assert_eq!(stop["recovery_turn_id"], "child-turn");
        assert_eq!(stop["transcript_path"], "/tmp/rollout-child.jsonl");
        assert_eq!(stop["hook_event"], "subagent-stop");
    }

    #[test]
    fn codex_stop_is_recovery_evidence_and_later_prompt_does_not_promote_it() {
        let root_dir = tempfile::tempdir().unwrap();
        let (code, _) = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({
                "session_id": "fork-session",
                "turn_id": "latest-terminal-turn",
                "transcript_path": "/tmp/rollout-fork.jsonl",
            })
            .to_string(),
            &[],
        );
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/fork-session.json"),
        );
        assert_eq!(code, 0);
        assert_eq!(marker["session_id"], "fork-session");
        assert_eq!(marker["turn_id"], "latest-terminal-turn");
        assert_eq!(marker["hook_event"], "stop");
        assert_eq!(marker["recovery_turn_id"], "latest-terminal-turn");
        assert!(marker.get("initial_turn_id").is_none());
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({
                "session_id": "multi-turn-fork",
                "turn_id": "first-terminal-turn",
            })
            .to_string(),
            &[],
        );
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["user-prompt-submit"],
            &json!({
                "session_id": "multi-turn-fork",
                "turn_id": "later-prompt-turn",
            })
            .to_string(),
            &[],
        );
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/multi-turn-fork.json"),
        );
        assert!(marker.get("initial_turn_id").is_none());
        assert_eq!(marker["recovery_turn_id"], "first-terminal-turn");
        assert_eq!(marker["turn_id"], "later-prompt-turn");
    }

    #[test]
    fn codex_filters_resource_and_span_attributes() {
        let root_dir = tempfile::tempdir().unwrap();
        let (resource_code, _) = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({
                "session_id": "cdx-agentteams",
                "turn_id": "turn-agentteams",
            })
            .to_string(),
            &[
                ("AGENTTEAMS_WORKER_NAME", "codex-worker"),
                ("AGENTTEAMS_INSTANCE_ID", "lw-codex"),
                ("AGENTTEAMS_TOKEN", "should-not-leak"),
            ],
        );
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/cdx-agentteams.json"),
        );
        assert_eq!(resource_code, 0);
        assert_eq!(
            marker["resourceAttributes"],
            json!({
                "agentteams.worker.name": "codex-worker",
                "agentteams.instance.id": "lw-codex",
            })
        );
        assert!(!marker.to_string().contains("should-not-leak"));

        let long_value = "x".repeat(513);
        let span = format!("multica.issue.id=issue-1,multica.agent.name=codex,gen_ai.agent.name=must-not-overwrite,multica.secret=must-not-leak,multica.long={long_value},malformed");
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["user-prompt-submit"],
            &json!({
                "session_id": "cdx-span-context",
                "turn_id": "turn-span-context",
            })
            .to_string(),
            &[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", span.as_str())],
        );
        let context =
            read_json(&root_dir.path().join(
                "state/codex/transcript-span-contexts/cdx-span-context--turn-span-context.json",
            ));
        assert_eq!(
            context["spanAttributes"],
            json!({"multica.issue.id": "issue-1", "multica.agent.name": "codex"})
        );
        let serialized = context.to_string();
        assert!(!serialized.contains("must-not-overwrite"));
        assert!(!serialized.contains("must-not-leak"));
        assert!(!serialized.contains(&long_value));
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "codex",
            &["session-start"],
            &json!({
                "session_id": "cdx-session-start",
                "turn_id": "turn-session-start",
            })
            .to_string(),
            &[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "multica.issue.id=issue-session-start",
            )],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        assert!(!root_dir
            .path()
            .join("state/codex/transcript-span-contexts/cdx-session-start--turn-session-start.json")
            .exists());
        assert!(root_dir
            .path()
            .join("state/codex/transcript-wakeups/cdx-session-start.json")
            .exists());
    }

    #[test]
    fn codex_keeps_latest_wakeup_and_logs_write_failures() {
        let root_dir = tempfile::tempdir().unwrap();
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({"session_id": "cdx-overwrite", "turn_id": "turn-1"}).to_string(),
            &[],
        );
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({"session_id": "cdx-overwrite", "turn_id": "turn-2"}).to_string(),
            &[],
        );
        let marker = read_json(
            &root_dir
                .path()
                .join("state/codex/transcript-wakeups/cdx-overwrite.json"),
        );
        assert_eq!(marker["session_id"], "cdx-overwrite");
        assert_eq!(marker["turn_id"], "turn-2");

        let (code, stdout) = invoke_in(
            root_dir.path(),
            "codex",
            &["pre-tool-use"],
            &json!({"session_id": "cdx-ignore", "tool_name": "Bash"}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        let _ = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({"turn_id": "turn-missing-session"}).to_string(),
            &[],
        );
        let names = fs::read_dir(root_dir.path().join("state/codex/transcript-wakeups"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            names.len(),
            1,
            "ignored or missing-session event published a marker"
        );
        assert_eq!(names[0], "cdx-overwrite.json");

        let wakeups = root_dir.path().join("state/codex/transcript-wakeups");
        let _ = fs::remove_dir_all(&wakeups);
        fs::create_dir_all(root_dir.path().join("state/codex")).unwrap();
        fs::write(&wakeups, "not-a-directory").unwrap();
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "codex",
            &["stop"],
            &json!({"session_id": "cdx-error", "turn_id": "turn-error"}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        assert!(error_text(root_dir.path(), "codex").contains("\"stage\":\"wakeup_write\""));
    }

    #[test]
    fn codex_span_write_failure_still_publishes_wakeup() {
        let root_dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(root_dir.path().join("state/codex")).unwrap();
        fs::write(
            root_dir.path().join("state/codex/transcript-span-contexts"),
            "not-a-directory",
        )
        .unwrap();
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "codex",
            &["user-prompt-submit"],
            &json!({
                "session_id": "cdx-span-error",
                "turn_id": "turn-span-error",
            })
            .to_string(),
            &[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "multica.issue.id=issue-error",
            )],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        assert!(root_dir
            .path()
            .join("state/codex/transcript-wakeups/cdx-span-error.json")
            .exists());
        assert!(error_text(root_dir.path(), "codex").contains("\"stage\":\"span_context_write\""));
    }

    #[test]
    fn cursor_source_event_preserves_zero_duration_and_workspace() {
        let event = cursor::to_internal_event(
            json!({
                "hook_event_name": "postToolUse",
                "conversation_id": "conv-1",
                "tool_name": "Read",
                "tool_use_id": "call-1",
                "duration_ms": 0,
                "duration": 123,
            })
            .as_object()
            .unwrap(),
        );
        assert_eq!(event.get("duration_ms").and_then(Value::as_i64), Some(0));
        let failure = cursor::to_internal_event(
            json!({
                "hook_event_name": "postToolUseFailure",
                "conversation_id": "conv-1",
                "tool_name": "Read",
                "tool_use_id": "call-1",
                "duration_ms": 0,
                "duration": 123,
            })
            .as_object()
            .unwrap(),
        );
        assert_eq!(failure.get("duration_ms").and_then(Value::as_i64), Some(0));
        let prompt = cursor::to_internal_event(
            json!({
                "hook_event_name": "beforeSubmitPrompt",
                "conversation_id": "conv-workspace",
                "prompt": "inspect this project",
                "cwd": "C:\\Users\\alice\\project",
                "workspace_roots": ["C:\\Users\\alice\\project"],
            })
            .as_object()
            .unwrap(),
        );
        assert_eq!(
            prompt.get("cwd").and_then(Value::as_str),
            Some("C:\\Users\\alice\\project")
        );
        assert_eq!(
            prompt.get("workspace_roots"),
            Some(&json!(["C:\\Users\\alice\\project"]))
        );
    }

    #[test]
    fn cursor_journal_preserves_concurrent_appends_and_dedups_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let journal = cursor::Journal::open(dir.path());
        let completed = json!({
            "_journal_ts": "2026-06-11T10:00:00.000Z",
            "hook_event": "beforeSubmitPrompt",
            "conversation_id": "completed-conv",
            "generation_id": "completed-turn",
            "prompt": "done",
        });
        let concurrent = json!({
            "_journal_ts": "2026-06-11T10:00:01.000Z",
            "hook_event": "preToolUse",
            "conversation_id": "next-conv",
            "generation_id": "next-turn",
            "tool_name": "Read",
            "tool_use_id": "call-next-read",
        });
        journal.append(completed.as_object().unwrap()).unwrap();
        let snapshot = journal.read_all().unwrap();
        journal.append(concurrent.as_object().unwrap()).unwrap();
        journal.rewrite(&[], Some(&snapshot)).unwrap();
        let remaining = journal.read_all().unwrap();
        assert_eq!(remaining, vec![concurrent]);

        let original = json!({
            "_journal_ts": "2026-06-11T10:00:00.000Z",
            "hook_event": "preToolUse",
            "conversation_id": "dedup-conv",
            "generation_id": "gen-1",
            "tool_name": "Write",
            "tool_use_id": "call-write-1",
        });
        journal.append(original.as_object().unwrap()).unwrap();
        let snapshot = journal.read_all().unwrap();
        let reordered = json!({
            "conversation_id": "dedup-conv",
            "tool_use_id": "call-write-1",
            "_journal_ts": "2026-06-11T10:00:00.000Z",
            "generation_id": "gen-1",
            "hook_event": "preToolUse",
            "tool_name": "Write",
        });
        journal
            .rewrite(std::slice::from_ref(&reordered), Some(&snapshot))
            .unwrap();
        let remaining = journal.read_all().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["tool_use_id"], "call-write-1");

        let event_a = json!({
            "_journal_ts": "2026-06-11T10:00:00.000Z",
            "hook_event": "preToolUse",
            "conversation_id": "dedup-conv-2",
            "generation_id": "gen-1",
            "tool_use_id": "call-write-A",
        });
        let event_b = json!({
            "_journal_ts": "2026-06-11T10:00:00.000Z",
            "hook_event": "preToolUse",
            "conversation_id": "dedup-conv-2",
            "generation_id": "gen-1",
            "tool_use_id": "call-write-B",
        });
        journal.append(event_a.as_object().unwrap()).unwrap();
        let snapshot = journal.read_all().unwrap();
        journal.append(event_b.as_object().unwrap()).unwrap();
        journal.rewrite(&[], Some(&snapshot)).unwrap();
        let remaining = journal.read_all().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["tool_use_id"], "call-write-B");
        const { assert!(cursor::JOURNAL_LOCK_TIMEOUT_MS > cursor::JOURNAL_LOCK_STALE_MS) };
    }

    #[test]
    fn cursor_cli_resource_context_survives_deferred_stop() {
        let root_dir = tempfile::tempdir().unwrap();
        let prompt = cursor_payload(
            "beforeSubmitPrompt",
            "2026.07.31",
            json!({"prompt": "Inspect the repository"}),
        );
        let (code, _) = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &prompt,
            &[
                ("AGENTTEAMS_WORKER_NAME", "planner"),
                ("AGENTTEAMS_INSTANCE_ID", "cursor-instance-01"),
                ("AGENTTEAMS_TOKEN", "must-not-leak"),
            ],
        );
        assert_eq!(code, 0);
        let (code, _) = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &cursor_payload("stop", "2026.07.31", json!({"status": "completed"})),
            &[],
        );
        assert_eq!(code, 0);
        assert!(read_jsonl_dir(&root_dir.path().join("logs/cursor/history")).is_empty());
        let (code, _) = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &cursor_payload("afterAgentResponse", "2026.07.31", json!({"text": "Done."})),
            &[],
        );
        assert_eq!(code, 0);
        let records = read_jsonl_dir(&root_dir.path().join("logs/cursor/history"));
        assert!(!records.is_empty());
        for record in &records {
            assert_eq!(record["gen_ai.agent.type"], "cursor-cli");
            assert_eq!(record["gen_ai.agent.name"], "planner");
            assert_eq!(
                record["resourceAttributes"],
                json!({
                    "agentteams.worker.name": "planner",
                    "agentteams.instance.id": "cursor-instance-01",
                })
            );
            assert!(!record.to_string().contains("must-not-leak"));
        }
    }

    #[test]
    fn cursor_desktop_ignores_resource_env() {
        let root_dir = tempfile::tempdir().unwrap();
        let env = [
            ("AGENTTEAMS_WORKER_NAME", "desktop-worker"),
            ("AGENTTEAMS_INSTANCE_ID", "desktop-instance-01"),
        ];
        let _ = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &cursor_payload(
                "beforeSubmitPrompt",
                "1.7.0",
                json!({"prompt": "Inspect the repository"}),
            ),
            &env,
        );
        let _ = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &cursor_payload("afterAgentResponse", "1.7.0", json!({"text": "Done."})),
            &env,
        );
        let (code, _) = invoke_in(
            root_dir.path(),
            "cursor",
            &[],
            &cursor_payload("stop", "1.7.0", json!({"status": "completed"})),
            &env,
        );
        assert_eq!(code, 0);
        let records = read_jsonl_dir(&root_dir.path().join("logs/cursor/history"));
        assert!(!records.is_empty());
        assert!(records
            .iter()
            .all(|record| record["gen_ai.agent.type"] == "cursor"));
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.name").is_none()));
        assert!(records
            .iter()
            .all(|record| record.get("resourceAttributes").is_none()));
    }

    fn cursor_payload(hook: &str, version: &str, extra: Value) -> String {
        let mut payload = json!({
            "hook_event_name": hook,
            "conversation_id": "cursor-conversation-1",
            "session_id": "cursor-conversation-1",
            "generation_id": "cursor-generation-1",
            "cursor_version": version,
            "model": "gpt-5",
        });
        if let (Value::Object(base), Value::Object(extra)) = (&mut payload, extra) {
            for (key, value) in extra {
                base.insert(key, value);
            }
        }
        payload.to_string()
    }

    fn write_transcript(dir: &Path, session: &str, records: &[Value]) -> PathBuf {
        let path = dir.join(format!("{session}.jsonl"));
        let body = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, body).unwrap();
        path
    }

    fn claude_records(root: &Path) -> Vec<Value> {
        read_jsonl_dir(&root.join("logs/claude-code"))
    }

    fn claude_state(root: &Path, session: &str) -> Option<Value> {
        fs::read_to_string(
            root.join("state/claude-code/sessions")
                .join(format!("{session}.json")),
        )
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
    }

    fn enable_tools(root: &Path, generate: bool) {
        fs::write(root.join("config.json"), json!({
            "upstreamLink": { "enabled": true, "propagateToTools": true, "generateTraceWhenMissing": generate }
        }).to_string()).unwrap();
    }

    #[test]
    fn claude_stop_failure_exports_structured_error_once() {
        let root_dir = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "session-api-error",
            &[
                json!({"type": "user", "timestamp": "2026-09-16T03:43:03.998Z", "promptId": "prompt-api-error", "message": {"role": "user", "content": "trigger error"}}),
                json!({"type": "assistant", "timestamp": "2026-09-16T03:46:02.445Z", "isApiErrorMessage": true, "apiErrorStatus": 529, "error": "server_error", "requestId": "req-error-11", "message": {"id": "synthetic-error-message", "model": "<synthetic>", "role": "assistant", "content": [{"type": "text", "text": "private upstream detail"}], "usage": {"input_tokens": 0, "output_tokens": 0}, "stop_reason": "stop_sequence"}}),
            ],
        );
        let payload = json!({
            "session_id": "session-api-error",
            "transcript_path": transcript,
            "cwd": "/tmp/api-error-test",
            "hook_event_name": "StopFailure",
            "error": "server_error",
            "error_details": "private upstream detail",
            "last_assistant_message": "private rendered error",
        })
        .to_string();
        let (code, _) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop-failure"],
            &payload,
            &[],
        );
        assert_eq!(code, 0);
        let records = claude_records(root_dir.path());
        assert_eq!(
            records
                .iter()
                .filter(|record| record["event.name"] == "llm.request")
                .count(),
            1
        );
        let responses: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "llm.response")
            .collect();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["gen_ai.request.model"], "unknown");
        assert_eq!(responses[0]["gen_ai.response.model"], "unknown");
        assert_eq!(responses[0]["gen_ai.turn.end"], true);
        assert_eq!(responses[0]["gen_ai.request.id"], "req-error-11");
        assert_eq!(responses[0]["http.response.status_code"], 529);
        assert_eq!(responses[0]["error.type"], "server_error");
        assert_eq!(
            responses[0]["gen_ai.response.finish_reasons"],
            json!(["error"])
        );
        assert!(responses[0].get("error.message").is_none());
        assert!(responses[0].get("gen_ai.output.messages").is_none());
        let serialized = serde_json::to_string(&records).unwrap();
        assert!(!serialized.contains("private upstream detail"));
        assert!(!serialized.contains("private rendered error"));
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop-failure"],
            &payload,
            &[],
        );
        assert_eq!(
            claude_records(root_dir.path())
                .iter()
                .filter(|record| record["event.name"] == "llm.response")
                .count(),
            1
        );
    }

    #[test]
    fn claude_accepts_invocation_identity_and_agentteams_resources() {
        let root_dir = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "native-session",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "hello"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:33.000Z", "message": {"id": "msg_identity", "content": [{"type": "text", "text": "hi"}], "usage": {"input_tokens": 10, "output_tokens": 2}, "stop_reason": "end_turn"}}),
            ],
        );
        let (code, _) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({
                "session_id": "native-session",
                "stop_reason": "end_turn",
                "transcript_path": transcript,
            })
            .to_string(),
            &[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "gen_ai.session.id=env-session,gen_ai.user.id=env-user,gen_ai.agent.name=blocked",
            )],
        );
        assert_eq!(code, 0);
        let records = claude_records(root_dir.path());
        assert!(!records.is_empty());
        for record in &records {
            assert_eq!(record["agent.pilot.invocation.session.id"], "env-session");
            assert_eq!(record["agent.pilot.invocation.user.id"], "env-user");
            assert_eq!(record["gen_ai.session.id"], "native-session");
            assert_ne!(record["gen_ai.agent.name"], "blocked");
        }

        let transcript = write_transcript(
            transcripts.path(),
            "sat1",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "hello"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:35.000Z", "message": {"id": "msg_1", "content": [{"type": "text", "text": "hi"}], "usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({
                "session_id": "sat1",
                "stop_reason": "end_turn",
                "transcript_path": transcript,
            })
            .to_string(),
            &[
                ("AGENTTEAMS_WORKER_NAME", "local-worker"),
                ("AGENTTEAMS_INSTANCE_ID", "example-instance"),
                ("AGENTTEAMS_TOKEN", "should-not-leak"),
            ],
        );
        let records = claude_records(root_dir.path())
            .into_iter()
            .filter(|record| record["gen_ai.session.id"] == "sat1")
            .collect::<Vec<_>>();
        assert!(!records.is_empty());
        for record in &records {
            assert_eq!(
                record["resourceAttributes"],
                json!({"agentteams.worker.name": "local-worker", "agentteams.instance.id": "example-instance"})
            );
            assert_eq!(record["gen_ai.agent.name"], "local-worker");
            assert!(!record.to_string().contains("should-not-leak"));
        }
    }

    #[test]
    fn claude_pretool_injects_traceparent_and_stop_reuses_span() {
        let root_dir = tempfile::tempdir().unwrap();
        enable_tools(root_dir.path(), false);
        let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let (code, stdout) = invoke_in(root_dir.path(), "claude-code", &["pre-tool-use"], &json!({
            "session_id": "s-propagate",
            "prompt_id": "prompt-1",
            "tool_name": "Bash",
            "tool_use_id": "tu-propagate",
            "tool_input": {"command": "my-cli --work", "description": "run user cli", "timeout": 5000, "run_in_background": false},
        }).to_string(), &[("TRACEPARENT", traceparent), ("TRACESTATE", "vendor=value")]);
        assert_eq!(code, 0);
        assert_eq!(stdout.trim().lines().count(), 1);
        let hook_output: Value = serde_json::from_str(stdout.trim()).unwrap();
        assert!(hook_output["hookSpecificOutput"]
            .get("permissionDecision")
            .is_none());
        let updated = &hook_output["hookSpecificOutput"]["updatedInput"];
        assert_eq!(updated["description"], "run user cli");
        assert_eq!(updated["timeout"], 5000);
        assert_eq!(updated["run_in_background"], false);
        let pattern =
            regex::Regex::new(r"TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})'")
                .unwrap();
        let captures = pattern
            .captures(updated["command"].as_str().unwrap())
            .unwrap();
        assert_eq!(&captures[1], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(&captures[3], "01");
        let reserved = captures[2].to_string();

        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "s-propagate",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "run my cli"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "tu-propagate", "name": "Bash", "input": {"command": "my-cli --work"}}], "usage": {"input_tokens": 100, "output_tokens": 50}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:49.200Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu-propagate", "content": "done"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.000Z", "message": {"id": "msg_2", "content": [{"type": "text", "text": "complete"}], "usage": {"input_tokens": 200, "output_tokens": 20}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({
                "session_id": "s-propagate",
                "prompt_id": "prompt-1",
                "stop_reason": "end_turn",
                "transcript_path": transcript,
            })
            .to_string(),
            &[("TRACEPARENT", traceparent)],
        );
        let records = claude_records(root_dir.path());
        let tool_call = records
            .iter()
            .find(|record| {
                record["event.name"] == "tool.call"
                    && record["gen_ai.tool.call.id"] == "tu-propagate"
            })
            .unwrap();
        let tool_result = records
            .iter()
            .find(|record| {
                record["event.name"] == "tool.result"
                    && record["gen_ai.tool.call.id"] == "tu-propagate"
            })
            .unwrap();
        assert_eq!(tool_call["span_id"], reserved);
        assert_eq!(tool_result["span_id"], reserved);
        let (_, later) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-propagate",
                "prompt_id": "prompt-2",
                "tool_name": "Bash",
                "tool_use_id": "tu-later",
                "tool_input": {"command": "my-cli --again"},
            })
            .to_string(),
            &[("TRACEPARENT", traceparent)],
        );
        assert_eq!(later.trim(), "{}");
    }

    #[test]
    fn claude_generates_local_trace_and_quotes_resource_attributes() {
        let root_dir = tempfile::tempdir().unwrap();
        enable_tools(root_dir.path(), true);
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-local",
                "prompt_id": "prompt-local-1",
                "tool_name": "Bash",
                "tool_use_id": "tu-local-1",
                "tool_input": {"command": "my-cli --local", "timeout": 5000},
            })
            .to_string(),
            &[(
                "LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES",
                "team=O'Reilly,deployment.environment.name=prod",
            )],
        );
        assert_eq!(code, 0);
        let updated: Value = serde_json::from_str(stdout.trim()).unwrap();
        let command = updated["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap();
        let pattern =
            regex::Regex::new(r"TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-01'").unwrap();
        let captures = pattern.captures(command).unwrap();
        let local_trace = captures[1].to_string();
        let reserved = captures[2].to_string();
        assert!(command.contains(
            "export OTEL_RESOURCE_ATTRIBUTES='team=O'\\''Reilly,deployment.environment.name=prod'"
        ));
        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "s-local",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "run local cli"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg-local-1", "content": [{"type": "tool_use", "id": "tu-local-1", "name": "Bash", "input": {"command": "my-cli --local"}}], "usage": {"input_tokens": 100, "output_tokens": 50}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:49.200Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu-local-1", "content": "done"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.000Z", "message": {"id": "msg-local-2", "content": [{"type": "text", "text": "complete"}], "usage": {"input_tokens": 200, "output_tokens": 20}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({
                "session_id": "s-local",
                "prompt_id": "prompt-local-1",
                "stop_reason": "end_turn",
                "transcript_path": transcript,
            })
            .to_string(),
            &[],
        );
        let records = claude_records(root_dir.path());
        let traces: std::collections::HashSet<_> = records
            .iter()
            .map(|record| record["trace_id"].as_str().unwrap())
            .collect();
        assert_eq!(
            traces,
            std::collections::HashSet::from([local_trace.as_str()])
        );
        let tool_call = records
            .iter()
            .find(|record| {
                record["event.name"] == "tool.call" && record["gen_ai.tool.call.id"] == "tu-local-1"
            })
            .unwrap();
        assert_eq!(tool_call["span_id"], reserved);
        let (_, later) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-local",
                "prompt_id": "prompt-local-2",
                "tool_name": "Bash",
                "tool_use_id": "tu-local-2",
                "tool_input": {"command": "my-cli --later"},
            })
            .to_string(),
            &[],
        );
        let later_command = serde_json::from_str::<Value>(later.trim()).unwrap()
            ["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .to_string();
        let later_trace = pattern.captures(&later_command).unwrap()[1].to_string();
        assert_ne!(later_trace, local_trace);
    }

    #[test]
    fn claude_pretool_defaults_off_and_can_export_resource_attributes_only() {
        let root_dir = tempfile::tempdir().unwrap();
        let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let (_, stdout) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-disabled",
                "tool_name": "Bash",
                "tool_use_id": "tu-disabled",
                "tool_input": {"command": "my-cli"},
            })
            .to_string(),
            &[("TRACEPARENT", traceparent)],
        );
        assert_eq!(stdout.trim(), "{}");
        enable_tools(root_dir.path(), false);
        let (_, stdout) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-subagent",
                "tool_name": "Bash",
                "tool_use_id": "tu-subagent",
                "agent_id": "agent-child",
                "agent_type": "Explore",
                "tool_input": {"command": "my-cli"},
            })
            .to_string(),
            &[("TRACEPARENT", traceparent)],
        );
        assert_eq!(stdout.trim(), "{}");
        let (_, stdout) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["pre-tool-use"],
            &json!({
                "session_id": "s-resource-only",
                "prompt_id": "prompt-resource-only",
                "tool_name": "Bash",
                "tool_use_id": "tu-resource-only",
                "tool_input": {"command": "my-cli"},
            })
            .to_string(),
            &[("LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES", "team=infra")],
        );
        let command = serde_json::from_str::<Value>(stdout.trim()).unwrap()["hookSpecificOutput"]
            ["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(command.contains("export OTEL_RESOURCE_ATTRIBUTES='team=infra'"));
        assert!(!command.contains("TRACEPARENT"));
    }

    #[test]
    fn claude_stop_builds_tool_steps_and_parallel_tools_share_a_step() {
        let root_dir = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "s1",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "list files"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "tu_1", "name": "Bash", "input": {"command": "ls"}}], "usage": {"input_tokens": 100, "output_tokens": 50}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:49.200Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu_1", "content": "a.txt\nb.txt"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.000Z", "message": {"id": "msg_2", "content": [{"type": "text", "text": "Found 2 files."}], "usage": {"input_tokens": 200, "output_tokens": 20}, "stop_reason": "end_turn"}}),
            ],
        );
        let (code, _) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s1", "stop_reason": "end_turn", "transcript_path": transcript})
                .to_string(),
            &[],
        );
        assert_eq!(code, 0);
        let records = claude_records(root_dir.path());
        assert!(records.len() >= 4);
        assert!(records
            .iter()
            .all(|record| record["gen_ai.session.id"] == "s1"
                && record["gen_ai.agent.type"] == "claude-code"));
        assert!(records
            .iter()
            .all(|record| record["trace_id"].as_str().unwrap().len() == 32));
        let traces: std::collections::HashSet<_> = records
            .iter()
            .map(|record| record["trace_id"].as_str().unwrap())
            .collect();
        assert_eq!(traces.len(), 1);
        let names: Vec<_> = records
            .iter()
            .map(|record| record["event.name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"llm.request")
                && names.contains(&"llm.response")
                && names.contains(&"tool.call")
                && names.contains(&"tool.result")
        );

        let transcript = write_transcript(
            transcripts.path(),
            "s2",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "do things"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"file_path": "/a"}}], "usage": {"input_tokens": 100, "output_tokens": 50}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:49.200Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu_1", "content": "aaa"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.000Z", "message": {"id": "msg_2", "content": [{"type": "tool_use", "id": "tu_2", "name": "Bash", "input": {"command": "echo hi"}}], "usage": {"input_tokens": 200, "output_tokens": 30}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:52.500Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu_2", "content": "hi"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:55.000Z", "message": {"id": "msg_3", "content": [{"type": "text", "text": "done"}], "usage": {"input_tokens": 300, "output_tokens": 10}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s2", "stop_reason": "end_turn", "transcript_path": transcript})
                .to_string(),
            &[],
        );
        let records = claude_records(root_dir.path())
            .into_iter()
            .filter(|record| record["gen_ai.session.id"] == "s2")
            .collect::<Vec<_>>();
        let requests: Vec<_> = records
            .iter()
            .filter(|record| {
                record["event.name"] == "llm.request" && record.get("gen_ai.step.id").is_some()
            })
            .collect();
        let responses: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "llm.response")
            .collect();
        let tools: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "tool.call")
            .collect();
        assert_eq!(requests.len(), 3);
        assert_eq!(responses.len(), 3);
        assert_eq!(tools.len(), 2);
        assert_eq!(
            requests[1]["gen_ai.input.messages_delta"],
            json!([
                {"role": "assistant", "parts": [{"type": "tool_call", "id": "tu_1", "name": "Read", "arguments": {"file_path": "/a"}}]},
                {"role": "tool", "parts": [{"type": "tool_call_response", "id": "tu_1", "response": "aaa"}]}
            ])
        );
        assert_eq!(
            requests[2]["gen_ai.input.messages_delta"],
            json!([
                {"role": "assistant", "parts": [{"type": "tool_call", "id": "tu_2", "name": "Bash", "arguments": {"command": "echo hi"}}]},
                {"role": "tool", "parts": [{"type": "tool_call_response", "id": "tu_2", "response": "hi"}]}
            ])
        );
        assert!(tools
            .iter()
            .find(|record| record["gen_ai.tool.call.id"] == "tu_1")
            .unwrap()["gen_ai.step.id"]
            .as_str()
            .unwrap()
            .contains(":s1"));
        assert!(tools
            .iter()
            .find(|record| record["gen_ai.tool.call.id"] == "tu_2")
            .unwrap()["gen_ai.step.id"]
            .as_str()
            .unwrap()
            .contains(":s2"));

        let transcript = write_transcript(
            transcripts.path(),
            "s3",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "read files"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "thinking", "thinking": "reading 3 files"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:51.000Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "/a"}}]}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:51.200Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "r1", "content": "aaa"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.000Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "r2", "name": "Read", "input": {"file_path": "/b"}}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:52.500Z", "message": {"id": "msg_1", "content": [{"type": "tool_use", "id": "r3", "name": "Read", "input": {"file_path": "/c"}}], "usage": {"input_tokens": 1000, "output_tokens": 100}, "stop_reason": "tool_use"}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:52.800Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "r2", "content": "bbb"}]}}),
                json!({"type": "user", "timestamp": "2026-06-04T02:57:53.000Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "r3", "content": "ccc"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:56.000Z", "message": {"id": "msg_2", "content": [{"type": "text", "text": "All read."}], "usage": {"input_tokens": 2000, "output_tokens": 20}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s3", "stop_reason": "end_turn", "transcript_path": transcript})
                .to_string(),
            &[],
        );
        let records = claude_records(root_dir.path())
            .into_iter()
            .filter(|record| record["gen_ai.session.id"] == "s3")
            .collect::<Vec<_>>();
        let calls: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "tool.call")
            .collect();
        let results: Vec<_> = records
            .iter()
            .filter(|record| record["event.name"] == "tool.result")
            .collect();
        assert_eq!(calls.len(), 3);
        assert_eq!(results.len(), 3);
        assert!(calls
            .iter()
            .all(|record| record["gen_ai.step.id"].as_str().unwrap().contains(":s1")));
        assert!(results
            .iter()
            .all(|record| record["gen_ai.step.id"].as_str().unwrap().contains(":s1")));
    }

    #[test]
    fn claude_cursor_caller_missing_session_offset_and_turns() {
        let root_dir = tempfile::tempdir().unwrap();
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s-cursor", "stop_reason": "end_turn", "cursor_version": "1.0"})
                .to_string(),
            &[],
        );
        assert!(claude_state(root_dir.path(), "s-cursor").is_none());
        let (code, _) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"stop_reason": "end_turn"}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert!(claude_state(root_dir.path(), "missing").is_none());
        let (code, stdout) = invoke_in(
            root_dir.path(),
            "claude-code",
            &["user-prompt-submit"],
            &json!({"session_id": "s-legacy", "prompt": "hi"}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "{}");
        assert!(claude_state(root_dir.path(), "s-legacy").is_none());

        let transcripts = tempfile::tempdir().unwrap();
        let transcript = write_transcript(
            transcripts.path(),
            "s-inc",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "q1"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "text", "text": "a1"}], "usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(root_dir.path(), "claude-code", &["stop"], &json!({"session_id": "s-inc", "stop_reason": "end_turn", "transcript_path": transcript}).to_string(), &[]);
        let state = claude_state(root_dir.path(), "s-inc").unwrap();
        assert!(state["transcript_offset"].as_u64().unwrap() > 0);
        assert_eq!(state["events"], json!([]));
        let before = claude_records(root_dir.path()).len();
        let _ = invoke_in(root_dir.path(), "claude-code", &["stop"], &json!({"session_id": "s-inc", "stop_reason": "end_turn", "transcript_path": transcript}).to_string(), &[]);
        assert_eq!(claude_records(root_dir.path()).len(), before);

        let synthetic = write_transcript(
            transcripts.path(),
            "s-synthetic-only",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:30.000Z", "promptId": "p1", "isMeta": true, "message": {"content": [{"type": "text", "text": "Continue from where you left off."}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:31.000Z", "message": {"id": "synthetic_1", "model": "<synthetic>", "content": [{"type": "text", "text": "No response requested."}], "usage": {"input_tokens": 0, "output_tokens": 0}, "stop_reason": "end_turn"}}),
            ],
        );
        let before = claude_records(root_dir.path()).len();
        let _ = invoke_in(root_dir.path(), "claude-code", &["stop"], &json!({"session_id": "s-synthetic-only", "stop_reason": "end_turn", "transcript_path": synthetic}).to_string(), &[]);
        let state = claude_state(root_dir.path(), "s-synthetic-only").unwrap();
        assert!(state["transcript_offset"].as_u64().unwrap() > 0);
        assert_eq!(claude_records(root_dir.path()).len(), before);

        let multi = write_transcript(
            transcripts.path(),
            "s-multi",
            &[
                json!({"type": "user", "timestamp": "2026-06-04T02:57:32.000Z", "message": {"content": [{"type": "text", "text": "q1"}]}}),
                json!({"type": "assistant", "timestamp": "2026-06-04T02:57:49.000Z", "message": {"id": "msg_1", "content": [{"type": "text", "text": "a1"}], "usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "end_turn"}}),
            ],
        );
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s-multi", "stop_reason": "end_turn", "transcript_path": &multi})
                .to_string(),
            &[],
        );
        assert_eq!(
            claude_state(root_dir.path(), "s-multi").unwrap()["turn_count"],
            1
        );
        let extra = [
            json!({"type": "user", "timestamp": "2026-06-04T03:00:00.000Z", "message": {"content": [{"type": "text", "text": "q2"}]}}),
            json!({"type": "assistant", "timestamp": "2026-06-04T03:00:10.000Z", "message": {"id": "msg_2", "content": [{"type": "text", "text": "a2"}], "usage": {"input_tokens": 20, "output_tokens": 10}, "stop_reason": "end_turn"}}),
        ];
        let mut body = fs::read_to_string(&multi).unwrap();
        body.push_str(
            &extra
                .iter()
                .map(|record| serde_json::to_string(record).unwrap())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        body.push('\n');
        fs::write(&multi, body).unwrap();
        let _ = invoke_in(
            root_dir.path(),
            "claude-code",
            &["stop"],
            &json!({"session_id": "s-multi", "stop_reason": "end_turn", "transcript_path": multi})
                .to_string(),
            &[],
        );
        assert_eq!(
            claude_state(root_dir.path(), "s-multi").unwrap()["turn_count"],
            2
        );
        let traces: std::collections::HashSet<_> = claude_records(root_dir.path())
            .into_iter()
            .filter(|record| record["gen_ai.session.id"] == "s-multi")
            .map(|record| record["trace_id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(traces.len(), 2);
    }

    #[test]
    fn kiro_stop_enqueues_pending_record() {
        let outcome = invoke(
            "kiro-cli",
            &["stop"],
            &json!({"cwd": "/tmp/kiro-project", "assistant_response": "done"}).to_string(),
            &[],
        );
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.stdout.trim(), "{}");
        let ready = outcome.root.join("state/kiro-cli/pending-stops/ready");
        let files = fs::read_dir(&ready)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        let record = read_json(&files[0]);
        assert_eq!(record["schemaVersion"], 1);
        assert_eq!(record["cwd"], "/tmp/kiro-project");
        assert_eq!(record["assistantResponse"], "done");
    }

    #[test]
    fn codex_records_timing_only_after_flushing_the_hook_response() {
        struct Response<'a> {
            root: &'a Path,
            bytes: Vec<u8>,
            flushed: bool,
        }
        impl Write for Response<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                assert!(!self.root.join("state/hook-metrics/codex.jsonl").exists());
                self.flushed = true;
                Ok(())
            }
        }
        let root = tempfile::tempdir().unwrap();
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        );
        let mut response = Response {
            root: root.path(),
            bytes: Vec::new(),
            flushed: false,
        };
        let args = vec!["stop".to_string()];
        assert_eq!(
            dispatch(
                "codex",
                false,
                b"{}",
                &args,
                &env,
                &mut response,
                std::time::Instant::now()
            ),
            0
        );
        assert!(response.flushed);
        assert_eq!(response.bytes, b"{}\n");
        let rows = crate::metrics::HookMetricsSpool::new(root.path()).drain();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].calls, 1);
        assert_eq!(rows[0].hook_event, "stop");
    }
}

#[cfg(test)]
mod codex_timing_history;
