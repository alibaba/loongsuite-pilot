use super::super::processor::MultimodalProcessor;
use super::super::types::{
    PathToUriOptions, UploadItem, UploadOptions, Uploader, MAX_MULTIMODAL_DATA_SIZE,
};
use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
fn image(label: &[u8]) -> Vec<u8> {
    [PNG, label].concat()
}
fn canonical(path: &Path) -> String {
    let text = std::fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        text.trim_start_matches(r"\\?\").to_owned()
    } else {
        text
    }
}
#[cfg(unix)]
fn dir_link(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn dir_link(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link)
        .expect("actual Windows symlink required for root policy contract");
}
#[cfg(unix)]
fn remove_dir_link(link: &Path) {
    std::fs::remove_file(link).unwrap();
}
#[cfg(windows)]
fn remove_dir_link(link: &Path) {
    std::fs::remove_dir(link).unwrap();
}

#[test]
fn every_historical_unc_device_form_and_question_mark_filename_keeps_native_path_contract() {
    for raw in [
        r"\\server\share\a.png",
        "//server/share/a.png",
        r"\\?\UNC\server\share\a.png",
        r"\\.\UNC\server\share\a.png",
        r"\\.\pipe\a.png",
        "//./pipe/a.png",
        r"\\.\GLOBALROOT\Device\HarddiskVolume1\a.png",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\a.png",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\a.png",
        r"\\.\C:\tmp\a.png",
        r"\??\C:\tmp\a.png",
    ] {
        assert!(is_unc_or_device_path(raw), "{raw}");
        assert!(normalize_local_image_path(raw).is_none(), "{raw}");
    }
    for raw in [r"\\?\C:\tmp\a.png", "//?/C:/tmp/a.png", "/tmp/a.png"] {
        assert!(!is_unc_or_device_path(raw), "{raw}");
    }
    assert_eq!(mime_from_image_path("/a/photo?.png"), Some("image/png"));
    let normalized = normalize_local_image_path("/a/photo?.png").unwrap();
    assert_eq!(
        PathBuf::from(normalized),
        std::path::absolute("/a/photo?.png").unwrap()
    );
    #[cfg(windows)]
    {
        assert_eq!(
            normalize_local_image_path(r"\\?\C:\tmp\a.png").as_deref(),
            Some(r"C:\tmp\a.png")
        );
        assert_eq!(
            normalize_local_image_path("//?/C:/tmp/a.png").as_deref(),
            Some(r"C:\tmp\a.png")
        );
    }
    #[cfg(not(windows))]
    assert!(normalize_local_image_path(r"\\?\C:\tmp\a.png").is_none());
}
#[test]
fn root_merge_expands_only_synthetic_home_and_deduplicates_canonical_defaults_and_user_roots() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("USERPROFILE", home.path());
    let default = home.path().join(".qoder").join("tmp");
    std::fs::create_dir_all(&default).unwrap();
    let actual_default = canonical(&default);
    let extra = home.path().join("workspace").join("foo");
    let merged = merge_allowed_root_paths(
        &[
            default.to_string_lossy().into_owned(),
            default.join(".").to_string_lossy().into_owned(),
            "  ".into(),
        ],
        Some(&[
            "~/workspace/foo".into(),
            default.to_string_lossy().into_owned(),
        ]),
    );
    assert_eq!(merged.len(), 2);
    assert_eq!(merged.iter().filter(|p| **p == actual_default).count(), 1);
    assert!(merged.contains(&extra.to_string_lossy().into_owned()));
    assert_eq!(canonicalize_root_path(""), "");
}
#[test]
fn real_existing_and_missing_root_resolution_keeps_both_default_roots() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert_eq!(
        canonicalize_root_path(&dir.path().to_string_lossy()),
        canonical(dir.path())
    );
    assert_eq!(
        canonicalize_root_path(&missing.to_string_lossy()),
        missing.to_string_lossy()
    );
    let tmp = std::env::temp_dir();
    let merged = merge_allowed_root_paths(
        &[
            dir.path().to_string_lossy().into_owned(),
            tmp.to_string_lossy().into_owned(),
        ],
        None,
    );
    assert!(merged.contains(&canonical(dir.path())));
    assert!(merged.contains(&canonical(&tmp)));
}
#[cfg(unix)]
#[test]
fn east_of_utc_midnight_uses_real_local_calendar_and_unix_ms_in_an_isolated_process() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    std::env::set_var("TZ", "Asia/Shanghai");
    use chrono::TimeZone;
    let morning = chrono::Local
        .with_ymd_and_hms(2026, 1, 2, 0, 30, 0)
        .unwrap();
    assert_eq!(morning.offset().local_minus_utc(), 8 * 3600);
    assert_eq!(
        morning
            .with_timezone(&chrono::Utc)
            .format("%Y%m%d")
            .to_string(),
        "20260101"
    );
    assert_eq!(yyyymmdd_local(morning), "20260102");
    assert_eq!(
        yyyymmdd_from_unix_ms(Some(morning.timestamp_millis() as f64), morning),
        "20260102"
    );
}
#[tokio::test]
async fn authorized_actual_file_and_internal_directory_symlink_still_read_identical_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("allowed");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let bytes = image(b"inside");
    let file = data.join("x.png");
    std::fs::write(&file, &bytes).unwrap();
    dir_link(&data, &root.join("alias"));
    let roots = merge_allowed_root_paths(&[root.to_string_lossy().into_owned()], None);
    for path in [file, root.join("alias").join("x.png")] {
        let original = path;
        let path = normalize_local_image_path(&original.to_string_lossy()).unwrap();
        assert_eq!(
            PathBuf::from(&path),
            std::path::absolute(&original).unwrap()
        );
        assert!(is_real_path_inside_roots(&path, &roots, None).await);
        let loaded =
            open_normalized_local_image(&path, MAX_MULTIMODAL_DATA_SIZE, Some(&roots), None)
                .await
                .unwrap();
        assert_eq!(loaded.bytes, bytes);
        assert_eq!(loaded.mime_type, "image/png");
        assert_eq!(loaded.size, bytes.len());
    }
}
#[tokio::test]
async fn static_outside_directory_symlink_never_passes_real_root_or_body_read() {
    let dir = tempfile::tempdir().unwrap();
    // Keep the lexical positive control in the same namespace as the canonical
    // roots (/var aliases on macOS and 8.3 aliases on Windows are distinct text).
    let parent = std::fs::canonicalize(dir.path()).unwrap();
    let allowed = parent.join("allowed");
    let outside = parent.join("outside");
    std::fs::create_dir(&allowed).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.png"), image(b"OUTSIDE-PRIVATE")).unwrap();
    dir_link(&outside, &allowed.join("via"));
    let path = allowed
        .join("via")
        .join("secret.png")
        .to_string_lossy()
        .into_owned();
    let roots = merge_allowed_root_paths(&[allowed.to_string_lossy().into_owned()], None);
    assert!(is_path_inside_roots(&path, &roots));
    assert!(!is_real_path_inside_roots(&path, &roots, None).await);
    let reads = Arc::new(AtomicUsize::new(0));
    let hook: ImageIoTestHook = Arc::new({
        let reads = reads.clone();
        move |phase, _| {
            if let ImageIoTestPhase::AfterRead(n) = phase {
                reads.fetch_add(n, Ordering::SeqCst);
            }
            None
        }
    });
    assert!(IMAGE_IO_TEST_HOOK
        .scope(
            hook,
            open_normalized_local_image(&path, MAX_MULTIMODAL_DATA_SIZE, Some(&roots), None)
        )
        .await
        .is_none());
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[derive(Default)]
struct CaptureUploader(Mutex<Vec<Vec<u8>>>);
#[async_trait::async_trait]
impl Uploader for CaptureUploader {
    async fn upload(&self, item: UploadItem, _: UploadOptions) -> bool {
        self.0.lock().unwrap().push(item.data.unwrap());
        true
    }
    async fn shutdown(&self) {}
}
#[tokio::test]
async fn actual_parent_swaps_between_each_check_cannot_authorize_or_upload_an_outside_handle() {
    for repeated in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        let outside = dir.path().join("outside");
        let via = allowed.join("via");
        let parked = allowed.join("via.parked");
        std::fs::create_dir_all(&via).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(via.join("pic.png"), image(b"inside")).unwrap();
        std::fs::write(outside.join("pic.png"), image(b"OUTSIDE-PRIVATE")).unwrap();
        let path = via.join("pic.png").to_string_lossy().into_owned();
        let roots = merge_allowed_root_paths(&[allowed.to_string_lossy().into_owned()], None);
        let reads = Arc::new(AtomicUsize::new(0));
        let allocations = Arc::new(AtomicUsize::new(0));
        let stages = Arc::new(AtomicUsize::new(0));
        let hook: ImageIoTestHook = Arc::new({
            let via = via.clone();
            let parked = parked.clone();
            let outside = outside.clone();
            let reads = reads.clone();
            let allocations = allocations.clone();
            let stages = stages.clone();
            move |phase, _| {
                match phase {
                    ImageIoTestPhase::BeforeOpen => {
                        stages.fetch_add(1, Ordering::SeqCst);
                        std::fs::rename(&via, &parked).unwrap();
                        dir_link(&outside, &via);
                    }
                    ImageIoTestPhase::AfterOpen => {
                        stages.fetch_add(1, Ordering::SeqCst);
                        remove_dir_link(&via);
                        std::fs::rename(&parked, &via).unwrap();
                    }
                    ImageIoTestPhase::AfterOpenedRealPath => {
                        stages.fetch_add(1, Ordering::SeqCst);
                        if repeated {
                            std::fs::rename(&via, &parked).unwrap();
                            dir_link(&outside, &via);
                        }
                    }
                    ImageIoTestPhase::Allocation(n) => {
                        allocations.fetch_add(n, Ordering::SeqCst);
                    }
                    ImageIoTestPhase::AfterRead(n) => {
                        reads.fetch_add(n, Ordering::SeqCst);
                    }
                    _ => {}
                };
                None
            }
        });
        let uploader = Arc::new(CaptureUploader::default());
        let processor =
            MultimodalProcessor::new(Some("oss://synthetic-bucket/mm"), uploader.clone(), None)
                .unwrap();
        let result = IMAGE_IO_TEST_HOOK
            .scope(
                hook,
                processor.path_to_uri(
                    &path,
                    None,
                    PathToUriOptions {
                        allowed_root_paths: Some(roots),
                        deadline_ms: None,
                    },
                ),
            )
            .await;
        processor.shutdown(1500).await;
        if parked.exists() {
            remove_dir_link(&via);
            std::fs::rename(&parked, &via).unwrap();
        }
        assert_eq!(
            stages.load(Ordering::SeqCst),
            3,
            "actual original open, restore and second containment check must all run"
        );
        assert!(
            result.is_none(),
            "repeated={repeated}, outside bytes read={}, synthetic uploads={:?}",
            reads.load(Ordering::SeqCst),
            uploader.0.lock().unwrap()
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(allocations.load(Ordering::SeqCst), 0);
        assert!(uploader.0.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn actual_file_short_reads_assemble_all_bytes_and_early_eof_rejects_partial_image() {
    for early_eof in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.png");
        let bytes = image(&[7; 32]);
        std::fs::write(&file, &bytes).unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let hook: ImageIoTestHook = Arc::new({
            let reads = reads.clone();
            let requests = requests.clone();
            move |phase, _| {
                match phase {
                    ImageIoTestPhase::ReadRequested(n) => {
                        assert!(n > 0);
                        let call = requests.fetch_add(1, Ordering::SeqCst);
                        return Some(if early_eof && call > 0 {
                            0
                        } else if early_eof {
                            8
                        } else {
                            5
                        });
                    }
                    ImageIoTestPhase::AfterRead(n) => {
                        reads.fetch_add(n, Ordering::SeqCst);
                    }
                    _ => {}
                };
                None
            }
        });
        let path = file.to_string_lossy().into_owned();
        let loaded = IMAGE_IO_TEST_HOOK
            .scope(
                hook,
                open_normalized_local_image(&path, MAX_MULTIMODAL_DATA_SIZE, None, None),
            )
            .await;
        if early_eof {
            assert!(loaded.is_none());
            assert_eq!(reads.load(Ordering::SeqCst), 8);
            assert_eq!(requests.load(Ordering::SeqCst), 2);
        } else {
            let loaded = loaded.unwrap();
            assert_eq!(loaded.bytes, bytes);
            assert_eq!(loaded.mime_type, "image/png");
            assert_eq!(reads.load(Ordering::SeqCst), bytes.len());
            assert!(requests.load(Ordering::SeqCst) > 1);
        }
    }
}
#[tokio::test]
async fn actual_read_size_change_and_during_read_abort_reject_even_valid_png_bytes() {
    for abort in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.png");
        std::fs::write(&file, image(&[7; 32])).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let hook: ImageIoTestHook = Arc::new({
            let flag = flag.clone();
            let reads = reads.clone();
            move |phase, path| {
                if let ImageIoTestPhase::AfterRead(n) = phase {
                    reads.fetch_add(n, Ordering::SeqCst);
                    if abort {
                        flag.store(true, Ordering::SeqCst);
                    } else {
                        use std::io::Write;
                        std::fs::OpenOptions::new()
                            .append(true)
                            .open(path)
                            .unwrap()
                            .write_all(&[1])
                            .unwrap();
                    }
                };
                None
            }
        });
        let path = file.to_string_lossy().into_owned();
        assert!(IMAGE_IO_TEST_HOOK
            .scope(
                hook,
                open_normalized_local_image(&path, MAX_MULTIMODAL_DATA_SIZE, None, Some(&flag))
            )
            .await
            .is_none());
        assert_eq!(
            reads.load(Ordering::SeqCst),
            40,
            "the actual OS read must occur before mutation/cancellation"
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().len(),
            if abort { 40 } else { 41 }
        );
    }
}
#[tokio::test]
async fn sparse_oversize_file_is_rejected_before_content_buffer_allocation_or_content_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("huge.png");
    std::fs::write(&file, PNG).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_len((MAX_MULTIMODAL_DATA_SIZE + 1) as u64)
        .unwrap();
    let allocations = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let hook: ImageIoTestHook = Arc::new({
        let allocations = allocations.clone();
        let reads = reads.clone();
        move |phase, _| {
            match phase {
                ImageIoTestPhase::Allocation(n) => {
                    allocations.fetch_add(n, Ordering::SeqCst);
                }
                ImageIoTestPhase::ReadRequested(n) => {
                    reads.fetch_add(n, Ordering::SeqCst);
                }
                _ => {}
            }
            None
        }
    });
    let path = file.to_string_lossy().into_owned();
    for max_bytes in [32, MAX_MULTIMODAL_DATA_SIZE] {
        assert!(IMAGE_IO_TEST_HOOK
            .scope(
                hook.clone(),
                open_normalized_local_image(&path, max_bytes, None, None)
            )
            .await
            .is_none());
    }
    assert_eq!(allocations.load(Ordering::SeqCst), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::metadata(&file).unwrap().len(),
        (MAX_MULTIMODAL_DATA_SIZE + 1) as u64
    );
}

#[cfg(unix)]
#[tokio::test]
async fn posix_literal_backslash_roots_never_authorize_a_different_slash_directory() {
    let dir = tempfile::tempdir().unwrap();
    let allowed = dir.path().join(r"allowed\physical");
    let shadow = dir.path().join("allowed").join("physical");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&shadow).unwrap();
    let permitted = image(b"permitted");
    std::fs::write(allowed.join("pic.png"), &permitted).unwrap();
    std::fs::write(shadow.join("pic.png"), image(b"OUTSIDE-PRIVATE")).unwrap();
    let roots = merge_allowed_root_paths(&[allowed.to_string_lossy().into_owned()], None);
    let uploader = Arc::new(CaptureUploader::default());
    let processor =
        MultimodalProcessor::new(Some("oss://synthetic-bucket/mm"), uploader.clone(), None)
            .unwrap();
    let outside = processor
        .path_to_uri(
            &shadow.join("pic.png").to_string_lossy(),
            None,
            PathToUriOptions {
                allowed_root_paths: Some(roots.clone()),
                deadline_ms: None,
            },
        )
        .await;
    let inside = processor
        .path_to_uri(
            &allowed.join("pic.png").to_string_lossy(),
            None,
            PathToUriOptions {
                allowed_root_paths: Some(roots.clone()),
                deadline_ms: None,
            },
        )
        .await;
    processor.shutdown(1500).await;
    assert!(
        outside.is_none(),
        "literal backslash root admitted slash-separated sibling; uploads={:?}",
        uploader.0.lock().unwrap()
    );
    assert!(
        inside.is_some(),
        "actual permitted POSIX filename must still be collected"
    );
    assert_eq!(roots, vec![canonical(&allowed)]);
    assert_eq!(
        normalize_local_image_path(&allowed.join("pic.png").to_string_lossy()).unwrap(),
        allowed.join("pic.png").to_string_lossy()
    );
    assert_eq!(*uploader.0.lock().unwrap(), vec![permitted]);
}
