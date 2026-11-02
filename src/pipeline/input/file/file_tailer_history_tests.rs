//! Frozen file-tailer23 declarations and actual identity/rotation regressions.
use super::*;
use std::io::Write;
struct Fixture {
    root: tempfile::TempDir,
    path: String,
}
impl Fixture {
    fn new(text: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.log").to_string_lossy().into_owned();
        std::fs::write(&path, text).unwrap();
        Self { root, path }
    }
    fn tailer(&self) -> FileTailer {
        FileTailer::new(vec![self.path.clone()], 0)
    }
    fn append(&self, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }
    fn rotate(&self, name: &str, text: &str) {
        std::fs::rename(&self.path, self.root.path().join(name)).unwrap();
        std::fs::write(&self.path, text).unwrap();
    }
}
fn ids(path: &str) -> (u64, u64) {
    let file = std::fs::File::open(path).unwrap();
    let identity = crate::utils::file_identity::identity_from_open(&file).unwrap();
    (identity.dev, identity.ino)
}
fn checkpoint(path: &str, offset: u64, last_update_time: i64) -> FileCheckpoint {
    let (dev, inode) = ids(path);
    FileCheckpoint {
        offset,
        inode,
        dev,
        signature_hash: String::new(),
        signature_size: 1024,
        last_update_time,
        cache: String::new(),
    }
}
#[tokio::test]
async fn source_l116_copytruncate_resets_offset_and_reads_the_new_generation() {
    let f = Fixture::new("old_line1\nold_line2\n");
    let mut tailer = f.tailer();
    let first = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(first.lines, ["old_line1", "old_line2"]);
    std::fs::write(&f.path, "new_line1\n").unwrap();
    let next = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(next.lines, ["new_line1"]);
    assert!(next.checkpoint.offset < first.checkpoint.offset);
}
#[tokio::test]
async fn source_l130_rename_reads_new_file_and_changes_its_actual_inode() {
    let f = Fixture::new("line1\nline2\n");
    let mut tailer = f.tailer();
    let first = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(first.lines, ["line1", "line2"]);
    f.rotate("app.log.1", "new_line1\nnew_line2\n");
    let next = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(next.lines, ["new_line1", "new_line2"]);
    assert_ne!(next.checkpoint.inode, first.checkpoint.inode);
    assert_eq!((next.checkpoint.dev, next.checkpoint.inode), ids(&f.path));
}
#[tokio::test]
async fn source_l148_reader_queue_drains_old_remnants_before_new_file_data() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    assert_eq!(tailer.read_new_lines(&f.path, None).await.lines, ["line1"]);
    f.append("line2_added\n");
    f.rotate("app.log.1", "new_file_line1\n");
    let next = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(next.lines, ["line2_added"]);
    assert!(next.has_more);
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["new_file_line1"]
    );
}
#[tokio::test]
async fn source_l168_original_queue_workload_keeps_the_file_active_and_cap_is_twenty() {
    let f = Fixture::new("gen1\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    for index in 2..=5 {
        f.rotate(&format!("app.log.{index}"), &format!("gen{index}\n"));
        tailer.read_new_lines(&f.path, None).await;
    }
    assert!(tailer.active_files().contains(&f.path));
    // Original declaration's title promises20, but its4 rotations never reach it.
    // Keep that workload and exercise the actual unchanged production queue cap.
    let f = Fixture::new("seed\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    for index in 0..25 {
        f.rotate(&format!("cap.{index}"), &format!("gen-{index}\n"));
        tailer.check_rotation(&f.path).await;
        assert!(tailer.reader_queues[&f.path].len() <= 20);
    }
    assert_eq!(tailer.reader_queues[&f.path].len(), 20);
}
#[tokio::test]
async fn source_l185_check_rotation_updates_identity_without_consuming_data() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    f.rotate("app.log.1", "new_line1\n");
    tailer.check_rotation(&f.path).await;
    assert_eq!(tailer.reader_queues[&f.path].len(), 2);
    assert_eq!(tailer.reader_queues[&f.path].last().unwrap().offset, 0);
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["new_line1"]
    );
}
#[tokio::test]
async fn source_l201_real_old_checkpoint_reader_is_evicted_by_stale_cleanup() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    assert!(
        tailer
            .init_reader_from_checkpoint(&f.path, &checkpoint(&f.path, 6, now_ms() - 4_000_000))
            .await
    );
    assert!(tailer.active_files().contains(&f.path));
    tailer.cleanup_stale_readers();
    assert!(!tailer.active_files().contains(&f.path));
}
#[tokio::test]
async fn source_l236_checkpoint_restoration_reads_only_the_later_append() {
    let f = Fixture::new("line1\nline2\nline3\n");
    let mut first = f.tailer();
    let original = first.read_new_lines(&f.path, None).await;
    assert_eq!(original.lines, ["line1", "line2", "line3"]);
    let mut restored = f.tailer();
    assert!(
        restored
            .init_reader_from_checkpoint(&f.path, &original.checkpoint)
            .await
    );
    f.append("line4\n");
    assert_eq!(
        restored.read_new_lines(&f.path, None).await.lines,
        ["line4"]
    );
}
#[tokio::test]
async fn source_l253_nonexistent_checkpoint_file_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("missing.log")
        .to_string_lossy()
        .into_owned();
    let cp = FileCheckpoint {
        offset: 100,
        inode: 999,
        dev: 1,
        signature_hash: "abc".into(),
        signature_size: 1024,
        last_update_time: now_ms(),
        cache: String::new(),
    };
    assert!(
        !FileTailer::new(vec![], 0)
            .init_reader_from_checkpoint(&path, &cp)
            .await
    );
}
#[tokio::test]
async fn source_l262_real_identity_mismatch_rejects_the_checkpoint() {
    let f = Fixture::new("data\n");
    let mut cp = checkpoint(&f.path, 0, now_ms());
    cp.inode = cp.inode.wrapping_add(999);
    assert!(!f.tailer().init_reader_from_checkpoint(&f.path, &cp).await);
}
#[tokio::test]
async fn source_l275_signature_mismatch_rejects_same_or_reused_inode_data() {
    let f = Fixture::new("original content\n");
    let original = f.tailer().read_new_lines(&f.path, None).await.checkpoint;
    std::fs::remove_file(&f.path).unwrap();
    std::fs::write(&f.path, "completely different content\n").unwrap();
    let (dev, inode) = ids(&f.path);
    let cp = FileCheckpoint {
        dev,
        inode,
        ..original
    };
    assert!(!f.tailer().init_reader_from_checkpoint(&f.path, &cp).await);
}
#[tokio::test]
async fn source_l301_checkpoints_expose_actual_integer_file_identity_and_state() {
    let f = Fixture::new("hello\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    let checkpoints = tailer.checkpoints();
    let cp = &checkpoints[&f.path];
    assert!(cp.offset > 0);
    assert!(cp.inode > 0);
    assert_eq!((cp.dev, cp.inode), ids(&f.path));
    assert!(!cp.signature_hash.is_empty());
    assert_eq!(cp.cache, "");
}
#[tokio::test]
async fn source_l318_all_reader_keys_use_distinct_actual_dev_inode_pairs() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    let old = ids(&f.path);
    f.append("line2_unread\n");
    f.rotate("app.log.1", "new_line1\n");
    tailer.check_rotation(&f.path).await;
    let new = ids(&f.path);
    let all = tailer.all_reader_checkpoints();
    assert_eq!(all.len(), 2);
    assert!(all.contains_key(&format!("{}*{}*{}", f.path, old.0, old.1)));
    assert!(all.contains_key(&format!("{}*{}*{}", f.path, new.0, new.1)));
}
#[tokio::test]
async fn source_l344_refresh_after_real_fifty_ms_sleep_preserves_offset() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    let before = tailer.checkpoints()[&f.path].clone();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    tailer.refresh_reader_timestamps();
    let after = tailer.checkpoints()[&f.path].clone();
    assert!(after.last_update_time > before.last_update_time);
    assert_eq!(after.offset, before.offset);
}
#[tokio::test]
async fn source_l363_refresh_updates_deleted_and_active_readers() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    tailer.read_new_lines(&f.path, None).await;
    f.rotate("app.log.1", "new\n");
    tailer.check_rotation(&f.path).await;
    assert!(tailer.reader_queues[&f.path]
        .iter()
        .any(|reader| reader.deleted));
    tailer.refresh_reader_timestamps();
    let all = tailer.all_reader_checkpoints();
    assert_eq!(all.len(), 2);
    for cp in all.values() {
        assert!(now_ms() - cp.last_update_time < 1000);
    }
}
#[tokio::test]
async fn actual_path_swap_between_stat_and_open_never_advances_the_wrong_reader_and_recovers() {
    let f = Fixture::new("old1\nold2\n");
    let (dev, ino) = ids(&f.path);
    let reader = FileReaderState {
        file_path: f.path.clone(),
        dev_inode: DevInode { dev, ino },
        offset: 5,
        signature_hash: String::new(),
        last_update_time: now_ms(),
        cache: String::new(),
        deleted: false,
        deleted_time: 0,
    };
    let mut queues = HashMap::from([(f.path.clone(), vec![reader])]);
    let rotated = f.root.path().join("app.log.1");
    let result =
        read_from_reader_with_open(&f.path, &f.path, &mut queues, &FileEncoding::Utf8, |path| {
            std::fs::rename(path, &rotated).unwrap();
            std::fs::write(path, "replacement1\nreplacement2\n").unwrap();
            std::fs::File::open(path)
        })
        .await;
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(queues[&f.path][0].offset, 5);
    assert_eq!(queues[&f.path][0].cache, "");
    let mut recovered = f.tailer();
    recovered.reader_queues = queues;
    let old = recovered.read_new_lines(&f.path, None).await;
    assert_eq!(old.lines, ["old2"]);
    assert!(old.has_more);
    assert_eq!(
        recovered.read_new_lines(&f.path, None).await.lines,
        ["replacement1", "replacement2"]
    );
}

#[tokio::test]
async fn actual_unlinked_old_generation_does_not_block_the_recreated_file_for_one_hour() {
    let f = Fixture::new("old\n");
    let mut tailer = f.tailer();
    assert_eq!(tailer.read_new_lines(&f.path, None).await.lines, ["old"]);
    // Retain the unlinked generation so the filesystem cannot immediately reuse
    // its inode; Windows File::open shares DELETE and permits this real unlink.
    let _unlinked_generation = std::fs::File::open(&f.path).unwrap();
    std::fs::remove_file(&f.path).unwrap();
    std::fs::write(&f.path, "replacement\n").unwrap();
    let first = tailer.read_new_lines(&f.path, None).await;
    assert!(first.lines.is_empty());
    // Frozen f84 processQueue clears the unavailable reader queue after break.
    assert!(!tailer.reader_queues.contains_key(&f.path));
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["replacement"]
    );
}
#[tokio::test]
async fn actual_final_rotated_reader_reports_its_updated_checkpoint_after_draining() {
    let f = Fixture::new("line1\n");
    let mut tailer = f.tailer();
    assert_eq!(tailer.read_new_lines(&f.path, None).await.lines, ["line1"]);
    f.append("line2\n");
    std::fs::rename(&f.path, f.root.path().join("app.log.1")).unwrap();
    tailer.check_rotation(&f.path).await;
    let last = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(last.lines, ["line2"]);
    assert!(!last.has_more);
    assert_eq!(
        last.checkpoint.offset, 12,
        "the fallback reader must be the post-read value, as in f84 reference semantics"
    );
}

#[test]
fn source_l38_zero_depth_ignores_the_only_nested_matching_file() {
    let f = Fixture::new("data");
    std::fs::create_dir(f.root.path().join("sub")).unwrap();
    std::fs::write(f.root.path().join("sub/b.log"), "data").unwrap();
    let files = FileTailer::new(
        vec![f.root.path().join("*.log").to_string_lossy().into_owned()],
        0,
    )
    .discover_files();
    assert_eq!(files, [f.path]);
}
#[tokio::test]
async fn source_l55_new_file_reads_all_complete_lines_with_nonzero_actual_identity() {
    let f = Fixture::new("line1\nline2\nline3\n");
    let result = f.tailer().read_new_lines(&f.path, None).await;
    assert_eq!(result.lines, ["line1", "line2", "line3"]);
    assert!(result.checkpoint.offset > 0);
    assert!(result.checkpoint.inode > 0);
    assert!(!result.has_more);
}
#[tokio::test]
async fn source_l68_append_only_emits_later_lines() {
    let f = Fixture::new("line1\nline2\n");
    let mut tailer = f.tailer();
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["line1", "line2"]
    );
    f.append("line3\nline4\n");
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["line3", "line4"]
    );
}
#[tokio::test]
async fn source_l81_incomplete_cache_survives_original_rewrite_sequence() {
    let f = Fixture::new("line1\nincomplete");
    let mut tailer = f.tailer();
    assert_eq!(tailer.read_new_lines(&f.path, None).await.lines, ["line1"]);
    std::fs::write(&f.path, "line1\nincomplete_now_done\nline3\n").unwrap();
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["incomplete_now_done", "line3"]
    );
}
#[tokio::test]
async fn source_l94_nonexistent_file_returns_empty_without_more() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("missing.log")
        .to_string_lossy()
        .into_owned();
    let result = FileTailer::new(vec![], 0).read_new_lines(&path, None).await;
    assert!(result.lines.is_empty());
    assert!(!result.has_more);
}
#[tokio::test]
async fn source_l101_original_five_thousand_lines_exceed_the_four_mib_budget() {
    let line = format!("{}\n", "x".repeat(1000));
    let f = Fixture::new(&line.repeat(5000));
    let mut tailer = f.tailer();
    let first = tailer.read_new_lines(&f.path, None).await;
    assert!(!first.lines.is_empty());
    assert!(first.lines.len() < 5000);
    assert!(first.has_more);
    assert_eq!(first.checkpoint.offset, MAX_READ_BYTES);
    let second = tailer.read_new_lines(&f.path, None).await;
    assert_eq!(first.lines.len() + second.lines.len(), 5000);
    assert!(!second.has_more);
    assert!(first
        .lines
        .iter()
        .chain(&second.lines)
        .all(|text| text == &"x".repeat(1000)));
}
#[tokio::test]
async fn source_l221_no_newline_is_cached_until_the_original_append_completes_it() {
    let f = Fixture::new("complete_line\nincomplete");
    let mut tailer = f.tailer();
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["complete_line"]
    );
    f.append("_rest_of_line\nnext\n");
    assert_eq!(
        tailer.read_new_lines(&f.path, None).await.lines,
        ["incomplete_rest_of_line", "next"]
    );
}
