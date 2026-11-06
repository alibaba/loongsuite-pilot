//! main #517 sparse disk-pressure workload, with actual sparse files on Windows.
use crate::core::LogRetentionService;
use crate::types::LogRetentionConfig;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

fn sparse_file(path: &Path, bytes: u64) {
    let file = std::fs::File::create(path).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        // Same ABI/constant as windows-sys 0.61 Win32/System/IO and Ioctl.
        // Keep this test helper self-contained: the operation is synchronous,
        // with no input/output/OVERLAPPED buffers.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            #[link_name = "DeviceIoControl"]
            fn device_io_control(
                handle: *mut core::ffi::c_void,
                code: u32,
                input: *const core::ffi::c_void,
                input_len: u32,
                output: *mut core::ffi::c_void,
                output_len: u32,
                returned: *mut u32,
                overlapped: *mut core::ffi::c_void,
            ) -> i32;
        }
        const FSCTL_SET_SPARSE: u32 = 590020;
        let mut returned = 0;
        let success = unsafe {
            device_io_control(
                file.as_raw_handle(),
                FSCTL_SET_SPARSE,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(
            success,
            0,
            "Cannot create the required sparse pressure fixture: {}",
            std::io::Error::last_os_error()
        );
    }
    file.set_len(bytes).unwrap();
}
#[tokio::test]
async fn sparse_pressure_reclaims_128_closed_segments_and_three_legacy_files_over_three_gib() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("logs/output");
        let debug = root.path().join("logs/otlp-debug");
        let failed = root.path().join("logs/otlp-failed");
        let day = crate::utils::get_today_date_string();
        let large = 3 * 1024 * 1024 * 1024u64 + 1;
        for folder in [&output, &debug, &failed] {
            tokio::fs::create_dir_all(folder).await.unwrap();
            sparse_file(&folder.join(format!("copilot-{day}.jsonl")), large);
        }
        for n in 0..128usize {
            sparse_file(&output.join(format!("copilot.part-{n:032x}-{day}.jsonl")), 32*1024*1024);
        }
        let config: LogRetentionConfig = serde_json::from_value(json!({
            "enabled":true,"intervalMs":21600000,"hookHistoryDays":7,"hookErrorDays":7,
            "hookDebugDays":7,"outputDays":7,"slsFailedDays":7,"otlpFailedDays":7,"metricAlarmDays":7
        })).unwrap();
        let service = LogRetentionService::new(root.path(), config);
        let (deleted, errors) = service.run_cleanup().await;
        assert_eq!(errors, 0);
        assert!(deleted >= 3 + 64);
        for folder in [&output, &debug, &failed] {
            assert!(!folder.join(format!("copilot-{day}.jsonl")).exists());
        }
        let mut entries = tokio::fs::read_dir(output).await.unwrap();
        let mut remaining = 0;
        while let Some(file) = entries.next_entry().await.unwrap() {
            remaining += file.metadata().await.unwrap().len();
        }
        assert!(remaining <= 2 * 1024 * 1024 * 1024u64);
    }).await.expect("main's 60-second sparse pressure budget exceeded");
}
