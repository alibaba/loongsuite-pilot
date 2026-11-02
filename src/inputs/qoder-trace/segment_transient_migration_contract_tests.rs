//! Exact transient-read contracts through native reader and real temporary files.
use super::*;
use serde_json::json;
use std::sync::Arc;
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
    fn write(&self, text: &str) -> std::path::PathBuf {
        let p = self.dir.join("segment-0.jsonl");
        std::fs::write(&p, text).unwrap();
        p
    }
    async fn read(&self, expected: &[&str]) -> Vec<SegmentTokenData> {
        read_segment_tokens_for_session(
            &self.session,
            &expected.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            self.root.to_str().unwrap(),
        )
        .await
    }
    fn cached_ptr(&self) -> usize {
        sessions()
            .lock()
            .unwrap()
            .get(&format!("{}::{}", self.root.display(), self.session))
            .unwrap()
            .data
            .as_ptr() as usize
    }
}
fn start(id: &str, ts: i64) -> String {
    format!(
        "{}\n",
        json!({"type":"model.request.started","request_id":id,"loop_id":format!("loop-{id}"),"ts":ts})
    )
}
fn end(id: &str, ts: i64) -> String {
    format!(
        "{}\n",
        json!({"type":"model.response.completed","request_id":id,"loop_id":format!("loop-{id}"),"ts":ts,"data":{"input_tokens":100,"output_tokens":20,"model":"qoder-model"}})
    )
}
fn body(id: &str, a: i64, b: i64) -> String {
    format!("{}{}", start(id, a), end(id, b))
}
fn ids(data: &[SegmentTokenData]) -> Vec<&str> {
    data.iter().map(|s| s.request_id.as_str()).collect()
}
fn probe() -> Arc<Mutex<test_io::Probe>> {
    Arc::new(Mutex::new(test_io::Probe::default()))
}
#[tokio::test]
async fn source_l179_plain_transient_open_fails_once_and_recovers_next_lookup() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.open = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&[]).await.is_empty());
            assert_eq!(p.lock().unwrap().body_opens, 1);
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
        })
        .await;
}
#[tokio::test]
async fn source_l190_missing_expected_id_retries_one_transient_open_failure() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.open = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert_eq!(ids(&f.read(&["req-a"]).await), vec!["req-a"]);
            assert_eq!(p.lock().unwrap().body_opens, 2);
        })
        .await;
}
#[tokio::test]
async fn source_l200_stable_permission_failure_does_not_retry_for_missing_expected() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.stable_open = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&["req-a"]).await.is_empty());
            assert_eq!(p.lock().unwrap().body_opens, 1);
        })
        .await;
}
#[tokio::test]
async fn source_l209_readable_missing_id_rechecks_root_without_rereading_unchanged_body() {
    let f = Fixture::new();
    f.write(&body("req-other", 1000, 2000));
    let p = probe();
    test_io::PROBE
        .scope(p.clone(), async {
            assert_eq!(ids(&f.read(&["req-a"]).await), vec!["req-other"]);
            assert_eq!(p.lock().unwrap().root_attempts, 2);
            assert_eq!(p.lock().unwrap().body_opens, 1);
            assert_eq!(
                p.lock().unwrap().metadata_opens,
                2,
                "fresh metadata handle is native stat-equivalent, not a second body acquisition"
            );
        })
        .await;
}
#[tokio::test]
async fn source_l219_expected_completion_appended_after_first_snapshot_is_read_on_one_recheck() {
    let f = Fixture::new();
    let path = f.write(&start("req-a", 1000));
    let p = probe();
    p.lock().unwrap().append_after_read = Some((path, end("req-a", 2000)));
    test_io::PROBE
        .scope(p.clone(), async {
            assert_eq!(ids(&f.read(&["req-a"]).await), vec!["req-a"]);
            assert_eq!(p.lock().unwrap().root_attempts, 2);
            assert_eq!(p.lock().unwrap().body_opens, 2);
        })
        .await;
}
#[tokio::test]
async fn source_l230_plain_read_failure_keeps_offset_for_next_lookup() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.read_at = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&[]).await.is_empty());
            assert_eq!(p.lock().unwrap().read_attempts, 1);
            p.lock().unwrap().faults.read_at = 0;
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
        })
        .await;
}
#[tokio::test]
async fn source_l243_complete_prefix_survives_a_later_actual_read_error() {
    let f = Fixture::new();
    let first = body("req-a", 1000, 2000);
    f.write(&format!("{first}{}", body("req-b", 3000, 4000)));
    let p = probe();
    {
        let mut p = p.lock().unwrap();
        p.max_read_bytes = first.len();
        p.faults.read_at = 2;
    }
    test_io::PROBE
        .scope(p.clone(), async {
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
            {
                let mut p = p.lock().unwrap();
                p.faults.read_at = 0;
                p.max_read_bytes = usize::MAX;
            }
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a", "req-b"]);
        })
        .await;
}
#[tokio::test]
async fn source_l260_root_listing_failure_returns_once_then_next_lookup_recovers() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.root = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&[]).await.is_empty());
            assert_eq!(p.lock().unwrap().root_attempts, 1);
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
        })
        .await;
}
#[tokio::test]
async fn source_l271_root_failure_preserves_existing_cached_allocation_and_content() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    test_io::PROBE
        .scope(p.clone(), async {
            let first = f.read(&[]).await;
            let allocation = f.cached_ptr();
            p.lock().unwrap().faults.root = 1;
            let during = f.read(&[]).await;
            assert_eq!(during, first);
            assert_eq!(ids(&during), vec!["req-a"]);
            assert_eq!(
                f.cached_ptr(),
                allocation,
                "owned public Vec clone still retains same native parsed-cache allocation"
            );
        })
        .await;
}
#[tokio::test]
async fn source_l282_segment_directory_failure_is_one_attempt_and_recovers_next_lookup() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.directory = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&[]).await.is_empty());
            assert_eq!(p.lock().unwrap().directory_attempts, 1);
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
        })
        .await;
}
#[tokio::test]
async fn source_l293_stat_failure_is_one_attempt_and_recovers_next_lookup() {
    let f = Fixture::new();
    f.write(&body("req-a", 1000, 2000));
    let p = probe();
    p.lock().unwrap().faults.stat = 1;
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(f.read(&[]).await.is_empty());
            assert_eq!(p.lock().unwrap().stat_attempts, 1);
            assert_eq!(ids(&f.read(&[]).await), vec!["req-a"]);
        })
        .await;
}
#[tokio::test]
async fn source_l304_absent_root_returns_empty_without_expected_id_retry() {
    let f = Fixture::new();
    std::fs::remove_dir_all(f.root.join("Users-project")).unwrap();
    let absent = f.root.join("absent");
    let p = probe();
    test_io::PROBE
        .scope(p.clone(), async {
            assert!(read_segment_tokens_for_session(
                &f.session,
                &["req-a".to_owned()],
                absent.to_str().unwrap()
            )
            .await
            .is_empty());
            assert_eq!(p.lock().unwrap().root_attempts, 1);
        })
        .await;
}
