//! Real fixed transcript files and exact Stop/retry window contracts.
use super::*;
fn progress(name: &str) -> Value {
    json!({"type":"progress","data":{"hookEvent":name}})
}
fn user(content: &str) -> Value {
    json!({"type":"user","message":{"content":content}})
}
fn assistant(content: &str) -> Value {
    json!({"type":"assistant","timestamp":"2026-07-31T04:33:41.000Z","message":{"content":[{"type":"text","text":content}]}})
}
fn physical_snapshot(rows: &[Value]) -> (tempfile::TempDir, Snapshot) {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("native.jsonl");
    fs::write(
        &path,
        rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    let snapshot = read_snapshot(&path, false);
    (d, snapshot)
}
fn object(window: TurnWindow) -> Value {
    json!({
 "status":if window.complete{"complete"}else{"waiting"},"reason":window.reason,
 "startLine":window.start_line,"stopLine":window.stop_line,"endLine":window.end_line})
}
fn assert_window(
    rows: &[Value],
    trigger: i64,
    reason: &str,
    start: usize,
    stop: usize,
    end: usize,
    complete: bool,
) {
    let (_d, s) = physical_snapshot(rows);
    assert_eq!(
        object(find_triggered_turn_window(&s, trigger)),
        json!({
  "status":if complete{"complete"}else{"waiting"},"reason":reason,"startLine":start,"stopLine":stop,"endLine":end})
    );
}
#[test]
fn window_l715_stop_anchor_excludes_queued_prompt() {
    let rows = vec![
        progress("UserPromptSubmit"),
        user("historical"),
        assistant("old answer"),
        progress("Stop"),
        progress("SessionEnd"),
        progress("UserPromptSubmit"),
        user("target prompt"),
        assistant("target answer"),
        progress("Stop"),
        progress("Stop"),
        progress("SessionEnd"),
        json!({"type":"session_meta"}),
        progress("UserPromptSubmit"),
        user("queued prompt"),
    ];
    assert_window(&rows, 8, "session-end", 5, 8, 11, true);
}
#[test]
fn window_l745_next_prompt_without_session_end() {
    let rows = vec![
        progress("UserPromptSubmit"),
        user("target prompt"),
        assistant("target answer"),
        progress("Stop"),
        progress("UserPromptSubmit"),
        user("queued prompt"),
    ];
    assert_window(&rows, 3, "next-prompt", 0, 3, 4, true);
}
#[test]
fn window_l765_stop_at_eof_waits() {
    let rows = vec![
        user("target prompt"),
        assistant("target answer"),
        progress("Stop"),
    ];
    assert_window(&rows, 2, "stop-at-eof", 0, 2, 3, false);
}
fn eof_window() -> TurnWindow {
    TurnWindow {
        complete: false,
        reason: "stop-at-eof".into(),
        start_line: Some(0),
        stop_line: Some(2),
        end_line: Some(3),
    }
}
fn hashed(hash: &str) -> Snapshot {
    Snapshot {
        line_count: 3,
        rows: vec![None; 3],
        content_hash: hash.into(),
        reason: "ok",
    }
}
#[test]
fn window_l782_two_identical_hashes_required() {
    let (first, window) = assess_stable_eof(None, eof_window(), &hashed("hash-a"));
    assert!(!window.complete);
    let (changed, window) = assess_stable_eof(first.as_deref(), eof_window(), &hashed("hash-b"));
    assert!(!window.complete);
    let (_, stable) = assess_stable_eof(changed.as_deref(), eof_window(), &hashed("hash-b"));
    assert!(stable.complete);
    assert_eq!(stable.reason, "stable-stop-eof");
}
#[test]
fn window_l811_cli_last_prompt_terminal() {
    let rows = vec![
        progress("UserPromptSubmit"),
        user("target prompt"),
        assistant("target answer"),
        progress("Stop"),
        json!({"type":"last-prompt","lastPrompt":"target prompt"}),
    ];
    assert_window(&rows, 3, "last-prompt", 0, 3, 5, true);
}
fn frozen_snapshot(name: &str) -> (tempfile::TempDir, Snapshot) {
    let text = match name {
        "transcript-stop-progress-only.jsonl" => include_str!(
            "../../tests/fixtures/qoder-hook-retry/transcript-stop-progress-only.jsonl"
        ),
        "transcript-stop-reason-only.jsonl" => {
            include_str!("../../tests/fixtures/qoder-hook-retry/transcript-stop-reason-only.jsonl")
        }
        "transcript-both-stops.jsonl" => {
            include_str!("../../tests/fixtures/qoder-hook-retry/transcript-both-stops.jsonl")
        }
        "transcript-react-tool-cycle.jsonl" => {
            include_str!("../../tests/fixtures/qoder-hook-retry/transcript-react-tool-cycle.jsonl")
        }
        "transcript-stop-sequence.jsonl" => {
            include_str!("../../tests/fixtures/qoder-hook-retry/transcript-stop-sequence.jsonl")
        }
        "transcript-pause-turn.jsonl" => {
            include_str!("../../tests/fixtures/qoder-hook-retry/transcript-pause-turn.jsonl")
        }
        other => panic!("unknown fixed fixture: {other}"),
    };
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join(name);
    fs::write(&path, text).unwrap();
    let snapshot = read_snapshot(&path, false);
    (d, snapshot)
}
fn frozen_window(name: &str, trigger: i64, reason: &str, start: usize, stop: usize, end: usize) {
    let (_d, s) = frozen_snapshot(name);
    assert_eq!(
        object(find_triggered_turn_window(&s, trigger)),
        json!({"status":"complete","reason":reason,"startLine":start,"stopLine":stop,"endLine":end})
    );
}
#[test]
fn window_l843_traditional_progress_stop() {
    frozen_window(
        "transcript-stop-progress-only.jsonl",
        4,
        "last-prompt",
        1,
        4,
        6,
    );
}
#[test]
fn window_l854_assistant_terminal_without_progress() {
    frozen_window(
        "transcript-stop-reason-only.jsonl",
        3,
        "last-prompt",
        1,
        3,
        5,
    );
}
#[test]
fn window_l865_prefers_progress_when_both_present() {
    frozen_window("transcript-both-stops.jsonl", 5, "last-prompt", 1, 4, 6);
}
#[test]
fn window_l879_tool_cycle_waits_for_terminal_assistant() {
    frozen_window(
        "transcript-react-tool-cycle.jsonl",
        6,
        "last-prompt",
        1,
        5,
        7,
    );
}
#[test]
fn window_l893_stop_sequence_is_terminal() {
    frozen_window("transcript-stop-sequence.jsonl", 4, "last-prompt", 1, 3, 5);
}
#[test]
fn window_l907_nonterminal_reasons_keep_waiting() {
    let (_d, s) = frozen_snapshot("transcript-pause-turn.jsonl");
    assert_eq!(
        object(find_triggered_turn_window(&s, 6)),
        json!({"status":"waiting","reason":"stop-not-found","startLine":null,"stopLine":null,"endLine":null})
    );
}
#[test]
fn terminal_l923_progress_stop() {
    assert!(has_qoder_cn_terminal(
        &[Progress {
            hook_event: "Stop".into()
        }],
        &[]
    ));
}
#[test]
fn terminal_l927_sdk_terminal_before_progress_appended() {
    assert!(has_qoder_cn_terminal(
        &[],
        &[
            json!({"type":"assistant","message":{"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt","lastPrompt":"summarize the file"})
        ]
    ));
}
#[test]
fn terminal_l934_mid_tool_not_terminal() {
    assert!(!has_qoder_cn_terminal(
        &[],
        &[
            json!({"type":"assistant","message":{"stop_reason":"tool_use"}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result"}]}})
        ]
    ));
}

// New main contracts from qoder-hook-processor-retry.test.mjs at 2caaaf9.
#[test]
fn main2caa_window_keeps_user_before_late_prompt_progress() {
    let rows = vec![
        progress("UserPromptSubmit"),
        progress("UserPromptSubmit"),
        user("first prompt"),
        progress("UserPromptSubmit"),
        assistant("first answer"),
        progress("Stop"),
        progress("SessionEnd"),
        progress("UserPromptSubmit"),
        user("second prompt"),
        progress("UserPromptSubmit"),
        assistant("second answer"),
        progress("Stop"),
        progress("SessionEnd"),
    ];
    let (_dir, snapshot) = physical_snapshot(&rows);
    for (start, stop, end, prompt) in [(2, 5, 7, "first prompt"), (8, 11, 13, "second prompt")] {
        let window = find_triggered_turn_window(&snapshot, stop as i64);
        assert!(window.complete);
        assert_eq!(
            (window.start_line, window.stop_line, window.end_line),
            (Some(start), Some(stop), Some(end))
        );
        assert!(snapshot.rows[start..end]
            .iter()
            .flatten()
            .any(|row| row["message"]["content"] == prompt));
    }
}
fn normal_prompt_ordering(boundary: &str) {
    let mut rows = vec![user("previous prompt")];
    if boundary != "none" {
        rows.push(if boundary == "last-prompt" {
            json!({"type":"last-prompt"})
        } else {
            progress(boundary)
        });
    }
    let start = rows.len();
    rows.extend([
        progress("UserPromptSubmit"),
        user("current prompt"),
        assistant("current answer"),
        progress("Stop"),
        progress("SessionEnd"),
    ]);
    let (_dir, snapshot) = physical_snapshot(&rows);
    let window = find_triggered_turn_window(&snapshot, (start + 3) as i64);
    assert!(window.complete);
    assert_eq!(window.start_line, Some(start));
    let selected = &snapshot.rows[window.start_line.unwrap()..window.end_line.unwrap()];
    assert!(selected
        .iter()
        .flatten()
        .any(|row| row == &user("current prompt")));
    assert!(!selected
        .iter()
        .flatten()
        .any(|row| row == &user("previous prompt")));
}
#[test]
fn main2caa_normal_order_after_no_boundary() {
    normal_prompt_ordering("none");
}
#[test]
fn main2caa_normal_order_after_session_end() {
    normal_prompt_ordering("SessionEnd");
}
#[test]
fn main2caa_normal_order_after_last_prompt() {
    normal_prompt_ordering("last-prompt");
}
fn missing_current_user(boundary: &str) {
    let rows = vec![
        user("previous prompt"),
        if boundary == "last-prompt" {
            json!({"type":"last-prompt"})
        } else {
            progress(boundary)
        },
        progress("UserPromptSubmit"),
        assistant("current answer"),
        progress("Stop"),
        progress("SessionEnd"),
    ];
    let (_dir, snapshot) = physical_snapshot(&rows);
    let window = find_triggered_turn_window(&snapshot, 4);
    assert!(window.complete);
    assert_eq!(window.start_line, Some(2));
    assert!(
        !snapshot.rows[window.start_line.unwrap()..window.end_line.unwrap()]
            .iter()
            .flatten()
            .any(|row| row == &user("previous prompt"))
    );
}
#[test]
fn main2caa_missing_user_never_crosses_session_end() {
    missing_current_user("SessionEnd");
}
#[test]
fn main2caa_missing_user_never_crosses_last_prompt() {
    missing_current_user("last-prompt");
}
