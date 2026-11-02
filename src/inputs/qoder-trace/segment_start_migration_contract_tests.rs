//! Request anchoring contracts through the production on-disk reader.
use super::*;
use serde_json::json;
struct Fixture {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    session: String,
    dir: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let dir = root.join("Users-project").join(&session).join("segments");
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            _temp: temp,
            root,
            session,
            dir,
        }
    }
    fn write(&self, name: &str, records: &[Value]) {
        std::fs::write(
            self.dir.join(name),
            records.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
    }
    async fn read(&self) -> Vec<SegmentTokenData> {
        read_segment_tokens_for_session(&self.session, &[], self.root.to_str().unwrap()).await
    }
}
fn event(kind: &str, request: Option<&str>, loop_id: Option<&str>, ts: i64) -> Value {
    let mut record = json!({"type":kind,"ts":ts});
    if let Some(request) = request {
        record["request_id"] = json!(request);
    }
    if let Some(loop_id) = loop_id {
        record["loop_id"] = json!(loop_id);
    }
    if kind == "model.response.completed" {
        record["data"] = json!({"input_tokens":100,"output_tokens":20,"model":"claude-sonnet-4"});
    }
    record
}
fn iteration(id: &str, ts: i64) -> Value {
    event("loop.iteration.started", None, Some(id), ts)
}
fn started(id: &str, loop_id: &str, ts: i64) -> Value {
    event("model.request.started", Some(id), Some(loop_id), ts)
}
fn completed(id: &str, loop_id: Option<&str>, ts: i64) -> Value {
    event("model.response.completed", Some(id), loop_id, ts)
}
#[tokio::test]
async fn source_l54_exact_request_start_precedes_iteration_fallback() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            started("req-a", "turn-1:1", 1780000000004),
            completed("req-a", Some("turn-1:1"), 1780000009000),
        ],
    );
    let data = f.read().await;
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].request_start_ts, 1780000000004);
    assert_eq!(data[0].response_end_ts, 1780000009000);
}
#[tokio::test]
async fn source_l70_retry_anchors_to_replaced_failure_not_iteration() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            started("req-first", "turn-1:1", 1780000000002),
            event(
                "model.request.attempt_failed",
                Some("req-first"),
                Some("turn-1:1"),
                1780000060026,
            ),
            completed("req-retry", Some("turn-1:1"), 1780000068125),
        ],
    );
    let data = f.read().await;
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].request_id, "req-retry");
    assert_eq!(data[0].request_start_ts, 1780000060026);
    assert_eq!(data[0].response_end_ts - data[0].request_start_ts, 8099);
}
#[tokio::test]
async fn source_l86_unfailed_orphan_uses_own_iteration() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            completed("req-orphan", Some("turn-1:1"), 1780000007500),
        ],
    );
    let data = f.read().await;
    assert_eq!(data[0].request_start_ts, 1780000000000);
    assert_eq!(data[0].response_end_ts - data[0].request_start_ts, 7500);
}
#[tokio::test]
async fn source_l100_each_completion_uses_its_own_iteration() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            completed("req-1", Some("turn-1:1"), 1780000003000),
            iteration("turn-1:2", 1780000020000),
            completed("req-2", Some("turn-1:2"), 1780000024000),
        ],
    );
    assert_eq!(
        f.read()
            .await
            .iter()
            .map(|s| s.request_start_ts)
            .collect::<Vec<_>>(),
        vec![1780000000000, 1780000020000]
    );
}
#[tokio::test]
async fn source_l115_no_anchor_reports_zero_instead_of_completion_time() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[completed("req-no-anchor", None, 1780000005000)],
    );
    let data = f.read().await;
    assert_eq!(data[0].request_start_ts, 0);
    assert_ne!(data[0].request_start_ts, data[0].response_end_ts);
}
#[tokio::test]
async fn source_l124_missing_start_never_fabricates_instantaneous_span() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            completed("req-a", Some("turn-1:1"), 1780000004000),
            completed("req-b", Some("turn-2:1"), 1780000008000),
            completed("req-c", None, 1780000012000),
        ],
    );
    let data = f.read().await;
    assert_eq!(data.len(), 3);
    assert!(data.iter().all(|s| s.request_start_ts != s.response_end_ts));
}
#[tokio::test]
async fn source_l141_failure_anchor_is_consumed_once_for_its_replacement() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            started("req-first", "turn-1:1", 1780000000002),
            event(
                "model.request.attempt_failed",
                Some("req-first"),
                Some("turn-1:1"),
                1780000060026,
            ),
            completed("req-retry", Some("turn-1:1"), 1780000068125),
            completed("req-later", Some("turn-1:1"), 1780000075000),
        ],
    );
    let data = f.read().await;
    assert_eq!(
        data.iter()
            .find(|s| s.request_id == "req-retry")
            .unwrap()
            .request_start_ts,
        1780000060026
    );
    assert_ne!(
        data.iter()
            .find(|s| s.request_id == "req-later")
            .unwrap()
            .request_start_ts,
        1780000060026
    );
}
#[tokio::test]
async fn source_l164_global_timestamp_sort_anchors_start_in_later_named_file() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &[completed("req-a", Some("turn-1:1"), 1780000009000)],
    );
    f.write(
        "segment-1.jsonl",
        &[
            iteration("turn-1:1", 1780000000000),
            started("req-a", "turn-1:1", 1780000000004),
        ],
    );
    let data = f.read().await;
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].request_start_ts, 1780000000004);
}
