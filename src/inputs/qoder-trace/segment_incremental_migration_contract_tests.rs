//! Incremental byte/record contracts via the actual production file reader.
use super::*;
use serde_json::json;
use std::io::Write;
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
    fn write(&self, name: &str, text: &str) -> std::path::PathBuf {
        let path = self.dir.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }
    async fn read(&self) -> Vec<SegmentTokenData> {
        read_segment_tokens_for_session(&self.session, &[], self.root.to_str().unwrap()).await
    }
}
fn pair(id: &str, start: i64, end: i64, input: i64) -> String {
    [json!({"type":"model.request.started","request_id":id,"loop_id":format!("loop-{id}"),"ts":start}),
    json!({"type":"model.response.completed","request_id":id,"loop_id":format!("loop-{id}"),"ts":end,"data":{"input_tokens":input,"output_tokens":20,"model":"qoder-model"}})].iter().map(|v|format!("{v}\n")).collect()
}
fn ids(data: &[SegmentTokenData]) -> Vec<&str> {
    data.iter().map(|s| s.request_id.as_str()).collect()
}
fn append(path: &std::path::Path, text: &str) {
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}
#[tokio::test]
async fn source_l91_real_reader_reads_only_appended_bytes_and_cached_snapshot_reads_zero() {
    let f = Fixture::new();
    let first = pair("req-a", 1000, 2000, 100);
    let path = f.write("segment-0.jsonl", &first);
    let probe = Arc::new(Mutex::new(test_io::Probe::default()));
    test_io::PROBE
        .scope(probe.clone(), async {
            assert_eq!(ids(&f.read().await), vec!["req-a"]);
            assert_eq!(probe.lock().unwrap().read_bytes, first.len());
            {
                let mut p = probe.lock().unwrap();
                p.read_calls = 0;
                p.read_bytes = 0;
            }
            let second = pair("req-b", 3000, 4000, 250);
            append(&path, &second);
            assert_eq!(ids(&f.read().await), vec!["req-a", "req-b"]);
            assert_eq!(probe.lock().unwrap().read_bytes, second.len());
            probe.lock().unwrap().read_calls = 0;
            assert_eq!(ids(&f.read().await), vec!["req-a", "req-b"]);
            assert_eq!(probe.lock().unwrap().read_calls, 0);
        })
        .await;
}
#[tokio::test]
async fn source_l115_partial_tail_is_revisited_from_last_complete_newline() {
    let f = Fixture::new();
    let first = pair("req-a", 1000, 2000, 100);
    let second = pair("req-b", 3000, 4000, 100);
    let start = second.lines().next().unwrap();
    let split = start.len() / 2;
    let path = f.write("segment-0.jsonl", &format!("{first}{}", &start[..split]));
    assert_eq!(ids(&f.read().await), vec!["req-a"]);
    append(&path, &second[split..]);
    assert_eq!(ids(&f.read().await), vec!["req-a", "req-b"]);
}
#[tokio::test]
async fn source_l134_complete_json_without_final_newline_waits_for_writer_commit() {
    let f = Fixture::new();
    let text = pair("req-a", 1000, 2000, 100);
    let path = f.write("segment-0.jsonl", text.trim_end_matches('\n'));
    assert!(f.read().await.is_empty());
    append(&path, "\n");
    assert_eq!(ids(&f.read().await), vec!["req-a"]);
}
#[tokio::test]
async fn source_l146_actual_seven_byte_reads_loop_until_snapshot_complete() {
    let f = Fixture::new();
    let text = pair("req-a", 1000, 2000, 100);
    f.write("segment-0.jsonl", &text);
    let probe = Arc::new(Mutex::new(test_io::Probe {
        max_read_bytes: 7,
        ..Default::default()
    }));
    test_io::PROBE
        .scope(probe.clone(), async {
            assert_eq!(ids(&f.read().await), vec!["req-a"]);
        })
        .await;
    assert!(probe.lock().unwrap().read_calls > 2);
    assert_eq!(probe.lock().unwrap().read_bytes, text.len());
}
#[tokio::test]
async fn source_l158_malformed_complete_line_is_consumed_once_without_poisoning_later_pair() {
    let f = Fixture::new();
    f.write(
        "segment-0.jsonl",
        &format!("{{not-json}}\n{}", pair("req-a", 1000, 2000, 100)),
    );
    let probe = Arc::new(Mutex::new(test_io::Probe::default()));
    test_io::PROBE
        .scope(probe.clone(), async {
            assert_eq!(ids(&f.read().await), vec!["req-a"]);
            probe.lock().unwrap().read_calls = 0;
            assert_eq!(ids(&f.read().await), vec!["req-a"]);
            assert_eq!(probe.lock().unwrap().read_calls, 0);
        })
        .await;
}
#[tokio::test]
async fn source_l175_new_file_is_discovered_without_rereading_first_file_body() {
    let f = Fixture::new();
    f.write("segment-0.jsonl", &pair("req-a", 1000, 2000, 100));
    let probe = Arc::new(Mutex::new(test_io::Probe::default()));
    test_io::PROBE
        .scope(probe.clone(), async {
            assert_eq!(ids(&f.read().await), vec!["req-a"]);
            probe.lock().unwrap().read_bytes = 0;
            let second = pair("req-b", 3000, 4000, 100);
            f.write("segment-1.jsonl", &second);
            assert_eq!(ids(&f.read().await), vec!["req-a", "req-b"]);
            assert_eq!(probe.lock().unwrap().read_bytes, second.len());
        })
        .await;
}
#[tokio::test]
async fn source_l190_real_truncation_rebuilds_file_index_and_removes_old_pair() {
    let f = Fixture::new();
    let first = pair("req-a-longer-id", 1000, 2000, 100);
    let path = f.write("segment-0.jsonl", &first);
    assert_eq!(ids(&f.read().await), vec!["req-a-longer-id"]);
    let second = pair("b", 3000, 4000, 100);
    assert!(second.len() < first.len());
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(0)
        .unwrap();
    std::fs::write(&path, &second).unwrap();
    assert_eq!(ids(&f.read().await), vec!["b"]);
}
