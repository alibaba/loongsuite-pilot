//! Native equivalents of fixed-main Codex hook timing fault contracts.
use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

fn invoke(root: &Path, event: &str) -> Vec<u8> {
    let mut env = Env::new();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "HOME".into(),
        root.join("synthetic-home").to_string_lossy().into_owned(),
    );
    env.insert(
        "LOONGSUITE_PILOT_SPAN_ATTRIBUTES".into(),
        "multica.issue.id=timing-issue".into(),
    );
    let mut stdout = Vec::new();
    let input =
        json!({"session_id":"native-timing-session","turn_id":"native-timing-turn"}).to_string();
    assert_eq!(
        dispatch(
            "codex",
            false,
            input.as_bytes(),
            &[event.to_owned()],
            &env,
            &mut stdout,
            Instant::now()
        ),
        0
    );
    assert_eq!(stdout, b"{}\n");
    stdout
}
fn spool(root: &Path) -> std::path::PathBuf {
    root.join("state").join("hook-metrics").join("codex.jsonl")
}
fn samples(root: &Path) -> Vec<Value> {
    fs::read_to_string(spool(root))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[test]
fn f84_l400_each_actual_discovery_call_records_exact_sample_shape_and_releases_the_writer_lock() {
    let root = tempfile::tempdir().unwrap();
    invoke(root.path(), "session-start");
    invoke(root.path(), "stop");
    let rows = samples(root.path());
    assert_eq!(
        rows.iter()
            .map(|row| row["hook_event"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["session-start", "stop"]
    );
    for row in rows {
        let mut keys = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, vec!["duration_ms", "hook_event"]);
        let duration = row["duration_ms"].as_f64().unwrap();
        assert!(duration.is_finite() && duration >= 0.0);
        assert_eq!(duration.fract(), 0.0);
    }
    let names = fs::read_dir(spool(root.path()).parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(names, vec![std::ffi::OsString::from("codex.jsonl")]);
}
#[test]
fn f84_l415_actual_ignored_and_invalid_events_acknowledge_and_record_pretool_or_unknown() {
    let root = tempfile::tempdir().unwrap();
    invoke(root.path(), "pre-tool-use");
    invoke(root.path(), "Not An Event");
    assert_eq!(
        samples(root.path())
            .iter()
            .map(|row| row["hook_event"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["pre-tool-use", "unknown"]
    );
}
#[test]
fn f84_l467_real_elapsed_duration_includes_response_write_and_flush_before_timing_production() {
    struct Response<'a> {
        root: &'a Path,
        bytes: Vec<u8>,
        flushed_at: Option<Instant>,
    }
    impl Write for Response<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            std::thread::sleep(Duration::from_millis(20));
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            assert!(
                !spool(self.root).exists(),
                "timing produced before protocol flush"
            );
            std::thread::sleep(Duration::from_millis(20));
            self.flushed_at = Some(Instant::now());
            Ok(())
        }
    }
    let root = tempfile::tempdir().unwrap();
    let mut env = Env::new();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.path().to_string_lossy().into_owned(),
    );
    env.insert(
        "HOME".into(),
        root.path()
            .join("synthetic-home")
            .to_string_lossy()
            .into_owned(),
    );
    let mut response = Response {
        root: root.path(),
        bytes: Vec::new(),
        flushed_at: None,
    };
    let started = Instant::now();
    let input = json!({"session_id":"native-timing-boundary"}).to_string();
    assert_eq!(
        dispatch(
            "codex",
            false,
            input.as_bytes(),
            &["stop".into()],
            &env,
            &mut response,
            started
        ),
        0
    );
    assert_eq!(response.bytes, b"{}\n");
    let through_flush = response
        .flushed_at
        .unwrap()
        .duration_since(started)
        .as_secs_f64()
        * 1000.0;
    let rows = samples(root.path());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["hook_event"], "stop");
    let marker: Value = serde_json::from_slice(
        &fs::read(
            root.path()
                .join("state")
                .join("codex")
                .join("transcript-wakeups")
                .join("native-timing-boundary.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(marker["session_id"], "native-timing-boundary");
    // The producer rounds milliseconds; monotonic rounding retains this lower
    // bound without a scheduling-sensitive upper limit.
    assert!(rows[0]["duration_ms"].as_f64().unwrap() >= through_flush.round());
}
