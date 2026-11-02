//! f84 jsonl-rotation8: final JsonlFlusher output with the original1024-byte threshold.
use super::*;
use std::collections::HashSet;

struct Fixture {
    root: tempfile::TempDir,
    config: JsonlFlusherConfig,
    flusher: Arc<JsonlFlusher>,
    date: String,
}
impl Fixture {
    async fn new(daily: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let date = get_today_date_string();
        let config: JsonlFlusherConfig = serde_json::from_value(serde_json::json!({
            "enabled":true, "outputDir":root.path(), "rotateDaily":daily,
            "maxFileSizeMb":1024.0/(1024.0*1024.0)
        }))
        .expect("f84 valid1024-byte fractional-MiB configuration");
        let flusher = Arc::new(Self::writer(&config, &date));
        flusher.start().await.unwrap();
        Self {
            root,
            config,
            flusher,
            date,
        }
    }
    fn writer(config: &JsonlFlusherConfig, date: &str) -> JsonlFlusher {
        let date = date.to_string();
        JsonlFlusher::with_today(config.clone(), Arc::new(move || date.clone()))
    }
    fn files(&self) -> Vec<String> {
        let mut files: Vec<_> = std::fs::read_dir(self.root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_string())
            .collect();
        files.sort();
        files
    }
    fn records(&self) -> Vec<Value> {
        self.files()
            .iter()
            .flat_map(|name| {
                std::fs::read_to_string(self.root.path().join(name))
                    .unwrap()
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect()
    }
    fn active(&self) -> std::path::PathBuf {
        self.root.path().join(format!(
            "copilot-{}.jsonl",
            if self.config.rotate_daily {
                &self.date
            } else {
                "all"
            }
        ))
    }
}
fn entry(id: &str, text: String) -> AgentActivityEntry {
    crate::normalization::build_test_entry(&serde_json::json!({
        "uuid":id, "agentType":"copilot",
        "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":text}]}]
    }))
}
fn standard(id: &str) -> AgentActivityEntry {
    entry(id, "界".repeat(50))
}
async fn batch(writer: &JsonlFlusher, ids: &[&str]) {
    writer
        .send_batch(ids.iter().map(|id| standard(id)).collect(), None)
        .await
        .unwrap();
}
fn ids(records: &[Value]) -> Vec<String> {
    let mut ids: Vec<_> = records
        .iter()
        .map(|r| r["event.id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}
#[tokio::test]
async fn source_l26_concurrent_writes_preserve_all_utf8_records_under_the_original_1024_byte_limit()
{
    let f = Fixture::new(true).await;
    let mut tasks = tokio::task::JoinSet::new();
    for index in 0..12 {
        let writer = f.flusher.clone();
        tasks.spawn(async move {
            writer
                .send(standard(&index.to_string()), None)
                .await
                .unwrap();
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    f.flusher.flush().await.unwrap();
    let files = f.files();
    let records = f.records();
    assert!(files.len() > 1);
    assert_eq!(records.len(), 12);
    assert_eq!(ids(&records).into_iter().collect::<HashSet<_>>().len(), 12);
    assert!(files.contains(
        &f.active()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    ));
    for file in files {
        assert!(std::fs::metadata(f.root.path().join(file)).unwrap().len() <= 1024);
    }
    for record in records {
        assert_eq!(
            record["gen_ai.input.messages"][0]["parts"][0]["content"],
            "界".repeat(50)
        );
    }
}
#[tokio::test]
async fn source_l38_reconstruction_does_not_overwrite_a_closed_segment() {
    let f = Fixture::new(true).await;
    batch(&f.flusher, &["a", "b", "c"]).await;
    f.flusher.shutdown().await.unwrap();
    let closed = f
        .files()
        .into_iter()
        .find(|name| name.contains(".part-"))
        .unwrap();
    let before = std::fs::read(f.root.path().join(&closed)).unwrap();
    let next = Fixture::writer(&f.config, &f.date);
    batch(&next, &["d", "e"]).await;
    next.shutdown().await.unwrap();
    assert_eq!(std::fs::read(f.root.path().join(closed)).unwrap(), before);
    assert_eq!(ids(&f.records()), ["a", "b", "c", "d", "e"]);
}
#[tokio::test]
async fn source_l50_one_oversized_event_remains_whole_when_the_following_event_rotates_it() {
    let f = Fixture::new(true).await;
    f.flusher
        .send(entry("large", "x".repeat(3000)), None)
        .await
        .unwrap();
    f.flusher.send(standard("small"), None).await.unwrap();
    assert_eq!(f.files().len(), 2);
    let records = f.records();
    assert_eq!(records.len(), 2);
    let large = records.iter().find(|r| r["event.id"] == "large").unwrap();
    assert_eq!(
        large["gen_ai.input.messages"][0]["parts"][0]["content"]
            .as_str()
            .unwrap()
            .len(),
        3000
    );
    assert!(std::fs::metadata(f.active()).unwrap().len() <= 1024);
}
#[tokio::test]
async fn source_l60_raw_topics_and_non_daily_output_share_the_original_rotation_contract() {
    let f = Fixture::new(false).await;
    batch(&f.flusher, &["a", "b", "c"]).await;
    for index in 0..5 {
        f.flusher
            .send_raw(
                "metrics",
                serde_json::json!({"id":index,"content":"x".repeat(600)})
                    .as_object()
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    let files = f.files();
    assert!(files.iter().any(|file| file == "copilot-all.jsonl"));
    assert!(files
        .iter()
        .any(|file| file.ends_with("-all.jsonl") && file.contains(".part-")));
    assert!(files.iter().any(|file| file.starts_with("metrics.part-")));
    assert_eq!(f.records().len(), 8);
}
#[tokio::test]
async fn source_l70_filesystem_error_is_visible_and_a_later_write_recovers() {
    let f = Fixture::new(true).await;
    std::fs::create_dir(f.active()).unwrap();
    let error = f.flusher.send(standard("failed"), None).await.unwrap_err();
    assert!(error.to_string().contains("not a regular file"));
    std::fs::remove_dir(f.active()).unwrap();
    f.flusher.send(standard("accepted"), None).await.unwrap();
    assert_eq!(ids(&f.records()), ["accepted"]);
}
#[tokio::test]
async fn source_l80_retention_removal_never_reuses_a_closed_segment_name() {
    let f = Fixture::new(true).await;
    batch(&f.flusher, &["a", "b"]).await;
    let old: Vec<_> = f
        .files()
        .into_iter()
        .filter(|name| name.contains(".part-"))
        .collect();
    assert!(!old.is_empty());
    for name in &old {
        std::fs::remove_file(f.root.path().join(name)).unwrap();
    }
    let next = Fixture::writer(&f.config, &f.date);
    next.send(standard("c"), None).await.unwrap();
    let new: Vec<_> = f
        .files()
        .into_iter()
        .filter(|name| name.contains(".part-"))
        .collect();
    assert!(!new.is_empty());
    assert!(new.iter().all(|name| !old.contains(name)));
}
#[tokio::test]
async fn source_l92_two_writer_instances_serialize_twenty_four_shared_active_file_writes() {
    let f = Fixture::new(true).await;
    let next = Arc::new(Fixture::writer(&f.config, &f.date));
    let mut tasks = tokio::task::JoinSet::new();
    for index in 0..24 {
        let writer = if index % 2 == 0 {
            f.flusher.clone()
        } else {
            next.clone()
        };
        tasks.spawn(async move {
            writer
                .send(standard(&index.to_string()), None)
                .await
                .unwrap();
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    f.flusher.shutdown().await.unwrap();
    next.shutdown().await.unwrap();
    let records = f.records();
    assert_eq!(records.len(), 24);
    assert_eq!(ids(&records).into_iter().collect::<HashSet<_>>().len(), 24);
    for file in f.files() {
        assert!(std::fs::metadata(f.root.path().join(file)).unwrap().len() <= 1024);
    }
}
#[tokio::test]
async fn source_l103_sparse_legacy_file_over_three_gib_is_reclaimed_without_archive() {
    let f = Fixture::new(true).await;
    std::fs::write(f.active(), "old").unwrap();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(f.active())
        .unwrap();
    make_sparse(&file);
    file.set_len(crate::utils::LOCAL_LOG_EMERGENCY_FILE_BYTES + 1)
        .unwrap();
    drop(file);
    f.flusher.send(standard("new"), None).await.unwrap();
    assert_eq!(f.files().len(), 1);
    assert_eq!(ids(&f.records()), ["new"]);
    assert!(std::fs::metadata(f.active()).unwrap().len() <= 1024);
}

fn make_sparse(_file: &std::fs::File) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn DeviceIoControl(
                device: *mut std::ffi::c_void,
                control: u32,
                input: *const std::ffi::c_void,
                input_size: u32,
                output: *mut std::ffi::c_void,
                output_size: u32,
                returned: *mut u32,
                overlapped: *mut std::ffi::c_void,
            ) -> i32;
        }
        let mut returned = 0;
        // FSCTL_SET_SPARSE affects only this test's new tempfile. Logical byte
        // thresholds remain production values without allocating tens of GiB.
        let result = unsafe {
            DeviceIoControl(
                _file.as_raw_handle(),
                0x0009_00c4,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
    }
}

#[tokio::test]
async fn assembled_user_configuration_keeps_the_fractional_rotation_limit_through_final_output() {
    use crate::core::{assemble_config, ConfigSources};
    use std::collections::HashMap;
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("output");
    let env = HashMap::new();
    let sources = ConfigSources {
        env: &env,
        platform: if cfg!(windows) {
            crate::utils::Platform::Win32
        } else {
            crate::utils::Platform::Posix
        },
        hostname: "synthetic",
        config_path: "synthetic-not-read.json",
        global_poll_ms: None,
    };
    let document = serde_json::json!({
        "dataDir":root.path().join("data"),
        "jsonl":{"enabled":true,"outputDir":output,"rotateDaily":true,"maxFileSizeMb":1024.0/(1024.0*1024.0)}
    });
    let config = assemble_config(Some(&document), None, &sources)
        .unwrap()
        .flushers
        .jsonl
        .unwrap();
    assert_eq!(config.max_file_size_mb.as_f64(), Some(1.0 / 1024.0));
    let writer = JsonlFlusher::new(config);
    writer
        .send_batch(vec![standard("a"), standard("b")], None)
        .await
        .unwrap();
    writer.shutdown().await.unwrap();
    assert_eq!(std::fs::read_dir(output).unwrap().count(), 2);
}
