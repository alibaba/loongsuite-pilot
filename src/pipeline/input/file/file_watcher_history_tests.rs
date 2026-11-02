//! Actual public watcher lifecycle with a private unavailable-backend factory.
use super::*;
use std::io::Write;
fn unavailable() -> FileWatcher {
    FileWatcher::with_backend(Arc::new(|| -1))
}
fn root_string(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}
#[test]
fn unavailable_backend_still_reports_real_create_append_and_remove_and_stops_after_close() {
    let root = tempfile::tempdir().unwrap();
    let watcher = unavailable();
    watcher.watch(&[root_string(root.path())]);
    let path = root.path().join("test.log");
    std::fs::write(&path, b"hello\n").unwrap();
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&path)));
    assert!(watcher.dirty_files().is_empty());
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    writeln!(file, "appended").unwrap();
    drop(file);
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&path)));
    std::fs::remove_file(&path).unwrap();
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&path)));
    watcher.close();
    std::fs::write(root.path().join("after-close.log"), b"no event").unwrap();
    assert!(watcher.dirty_files().is_empty());
}
#[test]
fn unavailable_backend_rewatch_preserves_pending_and_close_unwatches_old_directories() {
    let old = tempfile::tempdir().unwrap();
    let new = tempfile::tempdir().unwrap();
    let watcher = unavailable();
    watcher.watch(&[root_string(old.path()), root_string(old.path())]);
    watcher.add_dirty("/synthetic/pending.log");
    watcher.rewatch();
    assert_eq!(watcher.dirty_files(), ["/synthetic/pending.log"]);
    let after = old.path().join("after-rewatch.log");
    std::fs::write(&after, b"data\n").unwrap();
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&after)));
    watcher.close();
    watcher.rewatch();
    std::fs::write(old.path().join("unwatched.log"), b"old").unwrap();
    assert!(watcher.dirty_files().is_empty());
    watcher.watch(&[root_string(new.path())]);
    let fresh = new.path().join("new-watch.log");
    std::fs::write(&fresh, b"new").unwrap();
    let dirty = watcher.dirty_files();
    assert_eq!(dirty, [root_string(&fresh)]);
    watcher.close();
    // Explicit manual hints retain their original API semantics after close.
    watcher.add_dirty("/synthetic/manual.log");
    assert_eq!(watcher.dirty_files(), ["/synthetic/manual.log"]);
}

#[test]
fn bounded_fallback_scans_rotate_fairly_and_eventually_cover_large_directories() {
    use std::collections::HashSet;
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let watcher = unavailable();
    watcher.watch(&[root_string(first.path()), root_string(second.path())]);
    let mut expected = HashSet::new();
    for root in [first.path(), second.path()] {
        for index in 0..900 {
            let path = root.join(format!("file-{index}.log"));
            std::fs::write(&path, b"line").unwrap();
            expected.insert(root_string(&path));
        }
    }
    std::fs::write(outside.path().join("unwatched.log"), b"outside").unwrap();
    let mut seen = HashSet::new();
    for _ in 0..40 {
        let dirty = watcher.dirty_files();
        assert!(dirty.len() <= super::polling::POLL_WORK_BUDGET);
        seen.extend(dirty);
        assert!(
            watcher
                .state
                .lock()
                .unwrap()
                .polling
                .as_ref()
                .unwrap()
                .last_work
                <= super::polling::POLL_WORK_BUDGET
        );
        if expected.is_subset(&seen) {
            break;
        }
    }
    assert_eq!(
        seen, expected,
        "bounded scans must progress instead of permanently ignoring tail entries"
    );
    watcher.close();
}
#[test]
fn original_default_backend_creation_and_rewatch_contract_runs_on_every_platform() {
    let root = tempfile::tempdir().unwrap();
    let watcher = FileWatcher::new();
    watcher.watch(&[
        root_string(root.path()),
        root_string(root.path()),
        root_string(root.path()),
    ]);
    assert_eq!(watcher.state.lock().unwrap().dirs.len(), 1);
    let path = root.path().join("test.log");
    std::fs::write(&path, b"hello\n").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&path)));
    watcher.add_dirty("/synthetic/pending.log");
    watcher.rewatch();
    assert_eq!(watcher.dirty_files(), ["/synthetic/pending.log"]);
    let path = root.path().join("after-rewatch.log");
    std::fs::write(&path, b"data\n").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(watcher
        .dirty_files()
        .iter()
        .any(|value| value == &root_string(&path)));
    watcher.close();
    assert!(watcher.dirty_files().is_empty());
}

#[test]
fn bulk_removal_hints_are_bounded_and_all_eventually_delivered() {
    use std::collections::HashSet;
    let root = tempfile::tempdir().unwrap();
    let watcher = unavailable();
    watcher.watch(&[root_string(root.path())]);
    let paths = (0..600)
        .map(|index| root.path().join(format!("remove-{index}.log")))
        .collect::<Vec<_>>();
    let expected = paths
        .iter()
        .map(|path| root_string(path))
        .collect::<HashSet<_>>();
    for path in &paths {
        std::fs::write(path, b"line").unwrap();
    }
    let mut created = HashSet::new();
    for _ in 0..20 {
        created.extend(watcher.dirty_files());
        if expected.is_subset(&created) {
            break;
        }
    }
    assert_eq!(created, expected);
    for path in &paths {
        std::fs::remove_file(path).unwrap();
    }
    let mut removed = HashSet::new();
    for _ in 0..20 {
        let dirty = watcher.dirty_files();
        assert!(dirty.len() <= super::polling::POLL_WORK_BUDGET);
        removed.extend(dirty);
        if expected.is_subset(&removed) {
            break;
        }
    }
    assert_eq!(removed, expected);
    watcher.close();
}

#[test]
fn close_waits_for_inflight_callback_and_clears_its_late_dirty_hint() {
    let watcher = FileWatcher::new();
    watcher.add_dirty("/synthetic/before-close.log");
    let state = watcher.state.clone();
    let (completed, received) = std::sync::mpsc::channel();
    let callback = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            {
                let mut state = state.lock().unwrap();
                if state.stop && state.dirty.is_empty() {
                    let late = "/synthetic/late-callback.log".to_string();
                    state.dirty_set.insert(late.clone());
                    state.dirty.push(late);
                    completed.send(()).unwrap();
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "close did not cancel and drain its callback"
            );
            std::thread::yield_now();
        }
    });
    *watcher.thread.lock().unwrap() = Some(callback);
    watcher.close();
    received
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("callback really completed instead of panicking during join");
    assert!(
        watcher.dirty_files().is_empty(),
        "close must clear hints produced by a callback that finishes during join"
    );
}
