//! CorrelationStore10 and retention2 from ef8953; f84-only additions labelled main.
use loongsuite_pilot::core::{AcpCorrelateRetentionService, CorrelationStore};
use loongsuite_pilot::types::UpstreamLinkConfig;
use loongsuite_pilot::utils::content_hash;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
const SID: &str = "ses_abc123";
const TP1: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TP2: &str = "00-2370c4052bf954474d8c490b9ccce247-6ec62402a158c33c-01";
const TP_SESSION: &str = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
fn turn(text: &str, tp: &str) -> Value {
    json!({"type":"turn","sessionId":SID,"contentHash":content_hash(text),"contentPrefix":text.chars().take(128).collect::<String>(),"traceparent":tp})
}
fn write(root: &Path, lines: &[Value]) {
    let mut file = std::fs::File::create(root.join(format!("{SID}.jsonl"))).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

#[test]
fn store_l50_duplicate_prompts_consume_distinct_records_in_source_order() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[turn("OK", TP1), turn("HELLO", TP2), turn("OK", TP_SESSION)],
    );
    let store = CorrelationStore::new(root.path());
    assert_eq!(store.resolve_turn(SID, "OK").as_deref(), Some(TP1));
    assert_eq!(store.resolve_turn(SID, "HELLO").as_deref(), Some(TP2));
    assert_eq!(store.resolve_turn(SID, "OK").as_deref(), Some(TP_SESSION));
    assert_eq!(store.resolve_turn(SID, "OK"), None);
}
#[test]
fn store_l59_session_context_resolves_once_then_none() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[json!({"type":"session","sessionId":SID,"traceparent":TP_SESSION})],
    );
    let store = CorrelationStore::new(root.path());
    assert_eq!(
        store.resolve_session_first(SID).as_deref(),
        Some(TP_SESSION)
    );
    assert_eq!(store.resolve_session_first(SID), None);
}
#[test]
fn store_l66_session_consumption_survives_a_fresh_collector() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[json!({"type":"session","sessionId":SID,"traceparent":TP_SESSION})],
    );
    assert_eq!(
        CorrelationStore::new(root.path())
            .resolve_session_first(SID)
            .as_deref(),
        Some(TP_SESSION)
    );
    assert_eq!(
        CorrelationStore::new(root.path()).resolve_session_first(SID),
        None
    );
    assert!(root
        .path()
        .join(format!("{SID}.session-context.done"))
        .is_file());
}
#[test]
fn store_l76_unknown_sessions_and_unmatched_text_return_none() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("known", TP1)]);
    let store = CorrelationStore::new(root.path());
    assert_eq!(store.resolve_turn("ses_other", "known"), None);
    assert_eq!(store.resolve_turn(SID, "unknown text"), None);
}
#[test]
fn store_l83_malformed_lines_do_not_hide_a_later_valid_record() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join(format!("{SID}.jsonl")),
        format!("not json\n{}\n{{\"type\":\"turn\"}}\n", turn("valid", TP1)),
    )
    .unwrap();
    assert_eq!(
        CorrelationStore::new(root.path())
            .resolve_turn(SID, "valid")
            .as_deref(),
        Some(TP1)
    );
}
#[test]
fn store_l89_exact_hash_precedes_a_prefix_and_keeps_the_prefix_available() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        &[turn("analyze", TP1), turn("analyze this", TP2)],
    );
    let store = CorrelationStore::new(root.path());
    assert_eq!(
        store.resolve_turn(SID, "analyze this").as_deref(),
        Some(TP2)
    );
    assert_eq!(store.resolve_turn(SID, "analyze xyz").as_deref(), Some(TP1));
}
#[test]
fn store_l98_has_session_reports_actual_file_presence() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("x", TP1)]);
    let store = CorrelationStore::new(root.path());
    assert!(store.has_session(SID));
    assert!(!store.has_session("ses_missing"));
}
#[test]
fn store_l105_idle_eviction_preserves_the_main_durable_consumption_contract() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("OK", TP1)]);
    let store = CorrelationStore::new(root.path());
    assert_eq!(store.resolve_turn(SID, "OK").as_deref(), Some(TP1));
    assert_eq!(store.prune_idle(now_ms() - 60_000), 0);
    assert_eq!(store.resolve_turn(SID, "OK"), None);
    assert_eq!(store.prune_idle(now_ms() + 1000), 1);
    // ef8953 expected reuse here. Frozen main f84 explicitly replaces that
    // assertion with None: cache eviction must never erase a disk claim.
    assert_eq!(store.resolve_turn(SID, "OK"), None);
}
#[test]
fn main_prefix_consumption_is_shared_between_preloaded_collectors_and_restarts() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("analyze", TP1), turn("analyze", TP2)]);
    let first = CorrelationStore::new(root.path());
    let second = CorrelationStore::new(root.path());
    assert_eq!(first.resolve_turn(SID, "unrelated"), None);
    assert_eq!(second.resolve_turn(SID, "unrelated"), None);
    assert_eq!(
        first.resolve_turn(SID, "analyze@file:///a").as_deref(),
        Some(TP1)
    );
    assert_eq!(
        second.resolve_turn(SID, "analyze@file:///b").as_deref(),
        Some(TP2)
    );
    assert_eq!(
        CorrelationStore::new(root.path()).resolve_turn(SID, "analyze@file:///c"),
        None
    );
}
#[test]
fn main_private_claims_never_rewrite_adapter_records_or_contain_prompt_text() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("private prompt", TP1)]);
    let source = root.path().join(format!("{SID}.jsonl"));
    let original = std::fs::read(&source).unwrap();
    assert_eq!(
        CorrelationStore::new(root.path())
            .resolve_turn(SID, "private prompt")
            .as_deref(),
        Some(TP1)
    );
    let markers: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "done")
        })
        .collect();
    assert_eq!(markers.len(), 1);
    assert!(!markers[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("private prompt"));
    assert!(!std::fs::read_to_string(&markers[0])
        .unwrap()
        .contains("private prompt"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&markers[0]).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(std::fs::read(source).unwrap(), original);
}
fn retention_config() -> UpstreamLinkConfig {
    UpstreamLinkConfig {
        enabled: true,
        propagate_to_tools: false,
        propagate_to_llm: false,
        generate_trace_when_missing: false,
        ttl_ms: 24 * 3_600_000,
    }
}
#[tokio::test]
async fn retention_source_l28_removes_old_jsonl_and_env_lock_but_keeps_fresh() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("acp-correlate");
    std::fs::create_dir(&dir).unwrap();
    let paths = ["old.jsonl", "old.env.lock", "new.jsonl"].map(|name| dir.join(name));
    for (index, path) in paths.iter().enumerate() {
        std::fs::write(path, b"{}\n").unwrap();
        let age = if index < 2 {
            Duration::from_secs(48 * 3600)
        } else {
            Duration::from_secs(60)
        };
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
    }
    let service = AcpCorrelateRetentionService::new(root.path(), &retention_config(), None);
    assert_eq!(service.run_cleanup().await, (2, 0));
    assert!(!paths[0].exists());
    assert!(!paths[1].exists());
    assert!(paths[2].exists());
}
#[tokio::test]
async fn retention_source_l49_absent_directory_returns_zero_counts() {
    let root = tempfile::tempdir().unwrap();
    let service = AcpCorrelateRetentionService::new(
        root.path(),
        &UpstreamLinkConfig {
            ttl_ms: 1000,
            ..retention_config()
        },
        None,
    );
    assert_eq!(service.run_cleanup().await, (0, 0));
}

#[test]
fn main_anonymous_consumption_survives_restart_and_append_without_reusing_old_context() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &[turn("OK", TP1)]);
    assert_eq!(
        CorrelationStore::new(root.path())
            .resolve_turn(SID, "OK")
            .as_deref(),
        Some(TP1)
    );
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(root.path().join(format!("{SID}.jsonl")))
        .unwrap();
    writeln!(file, "{}", turn("OK", TP2)).unwrap();
    drop(file);
    assert_eq!(
        CorrelationStore::new(root.path())
            .resolve_turn(SID, "OK")
            .as_deref(),
        Some(TP2)
    );
    assert_eq!(
        CorrelationStore::new(root.path()).resolve_turn(SID, "OK"),
        None
    );
}
