//! f84 added debug/failed evidence rollover at original100MiB/3GiB limits.
use super::*;

fn span() -> ReadableSpan {
    let mut span = ReadableSpan::minimal("failed-span", &"a".repeat(32), &"b".repeat(16));
    span.start_time = [1000, 0];
    span.end_time = [1001, 0];
    span.duration = [1, 0];
    span.attributes
        .insert("gen_ai.agent.type".into(), serde_json::json!("claude-code"));
    span.attributes.insert(
        "gen_ai.input.messages".into(),
        serde_json::json!("diagnostic payload"),
    );
    span
}
async fn fixture(sink: &str, size: u64) -> (tempfile::TempDir, OtlpTraceFlusher, PathBuf, String) {
    let root = tempfile::tempdir().unwrap();
    let config: OtlpTraceFlusherConfig = serde_json::from_value(serde_json::json!({
        "enabled":true,"protocol":"http/protobuf","serviceName":"test-pilot","dataDir":root.path(),
        "endpoints":[{"name":"primary","endpoint":"http://localhost:4318"}]
    }))
    .unwrap();
    let flusher = OtlpTraceFlusher::new(config).unwrap();
    let dir = root.path().join("logs").join(format!("otlp-{sink}"));
    std::fs::create_dir_all(&dir).unwrap();
    let suffix = if sink == "failed" { "__primary" } else { "" };
    let name = format!(
        "test-pilot-claude-code{suffix}-{}.jsonl",
        get_today_date_string()
    );
    let path = dir.join(&name);
    let file = std::fs::File::create(&path).unwrap();
    make_sparse(&file);
    file.set_len(size).unwrap();
    drop(file);
    (root, flusher, dir, name)
}
async fn write(flusher: &OtlpTraceFlusher, sink: &str) {
    if sink == "failed" {
        flusher
            .inner
            .write_failed_log_at("claude-code", "primary", &[span()], 2, "failure", None)
            .await;
    } else {
        flusher
            .inner
            .write_debug_log("claude-code", &[span()])
            .await;
    }
}
fn files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}
#[tokio::test]
async fn main_l46_original_debug_and_failed_evidence_rotate_after_one_hundred_mib_without_truncating_the_closed_file(
) {
    for sink in ["debug", "failed"] {
        let (_root, flusher, dir, name) = fixture(sink, DEFAULT_JSONL_SEGMENT_BYTES).await;
        write(&flusher, sink).await;
        let files = files(&dir);
        assert_eq!(files.len(), 2, "{sink}");
        let closed = files
            .iter()
            .find(|file| {
                file.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".part-")
            })
            .unwrap();
        assert_eq!(
            std::fs::metadata(closed).unwrap().len(),
            DEFAULT_JSONL_SEGMENT_BYTES
        );
        let record: Value =
            serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap();
        assert_eq!(record["name"], "failed-span");
        if sink == "failed" {
            assert_eq!(record["_error"]["message"], "failure");
        }
        flusher.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn main_l60_original_debug_and_failed_over_three_gib_active_file_is_reclaimed_without_archive(
) {
    for sink in ["debug", "failed"] {
        let (_root, flusher, dir, name) =
            fixture(sink, crate::utils::LOCAL_LOG_EMERGENCY_FILE_BYTES + 1).await;
        write(&flusher, sink).await;
        assert_eq!(files(&dir), [dir.join(&name)], "{sink}");
        let record: Value =
            serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap();
        assert_eq!(record["name"], "failed-span");
        flusher.shutdown().await.unwrap();
    }
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
