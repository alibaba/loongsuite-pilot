//! TraceLinker source contracts; actual JSONL claims and native production methods.
use super::*;
use crate::utils::content_hash;
use serde_json::json;
const SID: &str = "ses_x";
const TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT: &str = "00f067aa0ba902b7";
const TP: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SESSION_TRACE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_PARENT: &str = "bbbbbbbbbbbbbbbb";
const SESSION_TP: &str = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const LOCAL: &str = "origtrace00000000000000000000000a";
fn input(turn: &str, text: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({
        "event.name":"other","gen_ai.session.id":SID,"gen_ai.turn.id":turn,
        "trace_id":LOCAL,"span_id":"aaaaaaaaaaaaaaaa",
        "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":text}]}]
    }))
    .unwrap()
}
fn llm(turn: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({
        "event.name":"llm.request","gen_ai.session.id":SID,"gen_ai.turn.id":turn,
        "trace_id":LOCAL,"span_id":"cccccccccccccccc","parent_span_id":"dddddddddddddddd"
    }))
    .unwrap()
}
fn append(root: &std::path::Path, row: Value) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(format!("{SID}.jsonl")))
        .unwrap();
    writeln!(file, "{row}").unwrap();
}
fn write_turn(root: &std::path::Path, text: &str, tp: &str) {
    append(
        root,
        json!({"type":"turn","sessionId":SID,"contentHash":content_hash(text),"contentPrefix":text.chars().take(128).collect::<String>(),"traceparent":tp}),
    );
}
fn write_session(root: &std::path::Path) {
    append(
        root,
        json!({"type":"session","sessionId":SID,"traceparent":SESSION_TP}),
    );
}
fn linker(root: &std::path::Path) -> TraceLinker {
    TraceLinker::with_retry(CorrelationStore::new(root), 0, 0)
}
#[tokio::test]
async fn baseline_stamp_preserves_intra_turn_parent_and_reuses_context_across_batches() {
    let root = tempfile::tempdir().unwrap();
    write_turn(root.path(), "do X", TP);
    let tl = linker(root.path());
    let mut batch = vec![input("t1", "do X"), llm("t1")];
    tl.stamp(&mut batch).await;
    assert_eq!(batch[0].trace_id.as_deref(), Some(TRACE));
    assert_eq!(batch[0].parent_span_id.as_deref(), Some(PARENT));
    assert_eq!(batch[1].trace_id.as_deref(), Some(TRACE));
    assert_eq!(batch[1].parent_span_id.as_deref(), Some("dddddddddddddddd"));
    assert_eq!(batch[0].turn_id.as_deref(), Some("t1"));
    let mut late = vec![llm("t1")];
    tl.stamp(&mut late).await;
    assert_eq!(late[0].trace_id.as_deref(), Some(TRACE));
    assert_eq!(late[0].parent_span_id.as_deref(), Some("dddddddddddddddd"));
    // An existing native trace is overridden on a fresh hit as in L132.
    let native_root = tempfile::tempdir().unwrap();
    write_turn(native_root.path(), "n", TP);
    let mut native = input("t1", "n");
    native.trace_id = Some(
        "nativetraceid00000000000000000000"
            .chars()
            .take(32)
            .collect(),
    );
    linker(native_root.path())
        .stamp(std::slice::from_mut(&mut native))
        .await;
    assert_eq!(native.trace_id.as_deref(), Some(TRACE));
}
#[tokio::test]
async fn baseline_turn_priority_and_session_fallback_are_first_turn_only_even_after_restart() {
    for turn_record in [true, false] {
        let root = tempfile::tempdir().unwrap();
        if turn_record {
            write_turn(root.path(), "first", TP);
        }
        write_session(root.path());
        let tl = linker(root.path());
        let mut first = input("t1", if turn_record { "first" } else { "anything" });
        tl.stamp(std::slice::from_mut(&mut first)).await;
        assert_eq!(
            first.trace_id.as_deref(),
            Some(if turn_record { TRACE } else { SESSION_TRACE })
        );
        assert_eq!(
            first.parent_span_id.as_deref(),
            Some(if turn_record { PARENT } else { SESSION_PARENT })
        );
        let mut second = input("t2", "q2");
        tl.stamp(std::slice::from_mut(&mut second)).await;
        assert_eq!(second.trace_id.as_deref(), Some(LOCAL));
        assert_eq!(second.parent_span_id, None);
        let mut restarted_second = input("t2", "q2");
        linker(root.path())
            .stamp(std::slice::from_mut(&mut restarted_second))
            .await;
        assert_eq!(restarted_second.trace_id.as_deref(), Some(LOCAL));
        assert_eq!(restarted_second.parent_span_id, None);
        assert_eq!(
            CorrelationStore::new(root.path()).resolve_session_first(SID),
            None
        );
    }
}
#[tokio::test]
async fn baseline_missing_context_and_missing_session_or_turn_are_fail_open_and_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let mut batch = vec![
        input("t1", "no record"),
        AgentActivityEntry {
            event_name: Some(AgentEventName::Other),
            ..AgentActivityEntry::default()
        },
    ];
    let original = batch.clone();
    linker(root.path()).stamp(&mut batch).await;
    assert_eq!(batch, original);
    assert_eq!(batch[0].trace_id.as_deref(), Some(LOCAL));
    assert_eq!(batch[0].parent_span_id, None);
    // A valid context file must not change the missing-session/turn skip rule.
    write_turn(root.path(), "x", TP);
    let mut bad = AgentActivityEntry {
        event_name: Some(AgentEventName::Other),
        ..AgentActivityEntry::default()
    };
    linker(root.path())
        .stamp(std::slice::from_mut(&mut bad))
        .await;
    assert_eq!(
        bad,
        AgentActivityEntry {
            event_name: Some(AgentEventName::Other),
            ..AgentActivityEntry::default()
        }
    );
}
#[tokio::test]
async fn baseline_no_file_and_empty_other_preserve_the_real_forty_ms_retry_fast_paths() {
    for has_file in [false, true] {
        let root = tempfile::tempdir().unwrap();
        if has_file {
            write_turn(root.path(), "something", TP);
        }
        let tl = TraceLinker::with_retry(CorrelationStore::new(root.path()), 3, 50);
        let mut record = input("t1", if has_file { "" } else { "anything" });
        let start = std::time::Instant::now();
        tl.stamp(std::slice::from_mut(&mut record)).await;
        let elapsed = start.elapsed();
        assert_eq!(record.trace_id.as_deref(), Some(LOCAL));
        assert!(elapsed<std::time::Duration::from_millis(40),"has_file={has_file}, actual={elapsed:?}; production retries3 x50ms must be short-circuited");
    }
}
#[tokio::test]
async fn baseline_prune_evicts_only_idle_native_caches_and_never_reuses_a_main_disk_claim() {
    for future in [false, true] {
        let root = tempfile::tempdir().unwrap();
        write_turn(root.path(), "do X", TP);
        let tl = linker(root.path());
        let mut record = input("t1", "do X");
        tl.stamp(std::slice::from_mut(&mut record)).await;
        assert_eq!(tl.cache.lock().unwrap().len(), 1);
        tl.prune_idle(if future {
            now_ms() + 1000
        } else {
            now_ms() - 60_000
        });
        assert_eq!(tl.cache.lock().unwrap().len(), usize::from(!future));
        assert_eq!(tl.first_turn.lock().unwrap().len(), usize::from(!future));
        // ef's future-cutoff reuse was explicitly replaced by f84 L281:
        // in-memory eviction cannot erase the persisted consumption marker.
        assert_eq!(tl.store.resolve_turn(SID, "do X"), None);
    }
}
#[tokio::test]
async fn main_repeated_prompts_restore_their_own_linker_context_across_restart() {
    let root = tempfile::tempdir().unwrap();
    write_turn(root.path(), "do X", TP);
    let mut original = input("t1", "do X");
    linker(root.path())
        .stamp(std::slice::from_mut(&mut original))
        .await;
    write_turn(root.path(), "do X", SESSION_TP);
    let restarted = linker(root.path());
    let mut replay = input("t1", "do X");
    restarted.stamp(std::slice::from_mut(&mut replay)).await;
    assert_eq!(replay.trace_id.as_deref(), Some(TRACE));
    let mut second = vec![input("t2", "do X"), llm("t2")];
    restarted.stamp(&mut second).await;
    assert_eq!(second[0].trace_id.as_deref(), Some(SESSION_TRACE));
    assert_eq!(second[0].parent_span_id.as_deref(), Some(SESSION_PARENT));
    assert_eq!(second[1].trace_id.as_deref(), Some(SESSION_TRACE));
}
#[tokio::test]
async fn main_empty_metadata_cannot_claim_a_session_fallback_before_later_input() {
    let root = tempfile::tempdir().unwrap();
    write_turn(root.path(), "do X", TP);
    write_session(root.path());
    let tl = linker(root.path());
    let mut metadata = input("t1", "");
    tl.stamp(std::slice::from_mut(&mut metadata)).await;
    assert_eq!(metadata.parent_span_id, None);
    assert!(!root
        .path()
        .join(format!("{SID}.session-context.done"))
        .exists());
    let mut later = vec![input("t1", "do X"), llm("t1")];
    tl.stamp(&mut later).await;
    assert_eq!(later[0].trace_id.as_deref(), Some(TRACE));
    assert_eq!(later[0].parent_span_id.as_deref(), Some(PARENT));
    assert_eq!(later[1].trace_id.as_deref(), Some(TRACE));
    assert_eq!(
        CorrelationStore::new(root.path()).resolve_session_first(SID),
        None
    );
}
#[tokio::test]
async fn main_pre_truncation_unicode_hash_resolves_without_display_text_and_replays_after_restart()
{
    let root = tempfile::tempdir().unwrap();
    let prompt = "界".repeat(33000);
    append(
        root.path(),
        json!({"type":"turn","contentHash":content_hash(&prompt),"traceparent":TP}),
    );
    let mut empty = input("t1", "");
    empty.extra.insert(
        "agent.pilot.correlation.content_hash".into(),
        json!(content_hash(&prompt)),
    );
    linker(root.path())
        .stamp(std::slice::from_mut(&mut empty))
        .await;
    assert_eq!(empty.trace_id.as_deref(), Some(TRACE));
    assert_eq!(empty.parent_span_id.as_deref(), Some(PARENT));
    let display = prompt.chars().take(32768).collect::<String>() + "...[truncated]";
    let mut replay = input("t1", &display);
    replay.extra.insert(
        "agent.pilot.correlation.content_hash".into(),
        json!(content_hash(&prompt)),
    );
    linker(root.path())
        .stamp(std::slice::from_mut(&mut replay))
        .await;
    assert_eq!(replay.trace_id.as_deref(), Some(TRACE));
}
#[tokio::test]
async fn main_invalid_producer_hash_is_ignored_in_favor_of_the_actual_text() {
    let root = tempfile::tempdir().unwrap();
    write_turn(root.path(), "do X", TP);
    let mut record = input("t1", "do X");
    record.extra.insert(
        "agent.pilot.correlation.content_hash".into(),
        json!("invalid"),
    );
    linker(root.path())
        .stamp(std::slice::from_mut(&mut record))
        .await;
    assert_eq!(record.trace_id.as_deref(), Some(TRACE));
}
