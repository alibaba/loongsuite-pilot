//! Actual engine cache contracts, with task-local IO scheduling/failure seams.
use super::*;
use crate::inputs::codex_transcript::discovery::{DiscoveryPoint, TEST_DISCOVERY};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
fn directory_time(path: &std::path::Path, time: std::time::SystemTime) {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .access_mode(0x100)
            .custom_flags(0x02000000)
            .open(path)
            .unwrap()
    };
    #[cfg(not(windows))]
    let file = std::fs::File::open(path).unwrap();
    file.set_modified(time).unwrap();
}
#[tokio::test]
async fn main_discovery_l19_engine_retries_root_and_leaf_publication_and_keeps_idle_cache() {
    for level in ["root", "leaf"] {
        let f = Fixture::new();
        let sessions = f.root.path().join("sessions");
        let leaf = sessions.join("2026/06/24");
        let scanned = if level == "root" {
            sessions.clone()
        } else {
            leaf.clone()
        };
        std::fs::create_dir_all(&scanned).unwrap();
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_767_225_600);
        directory_time(&scanned, old);
        let transcript = leaf.join("rollout-new.jsonl");
        let fired = Arc::new(AtomicBool::new(false));
        let hit = Arc::clone(&fired);
        let reads = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&reads);
        let selected = scanned.clone();
        let file = transcript.clone();
        let directory = leaf.clone();
        let hook = Arc::new(move |path: &str, point: DiscoveryPoint| {
            if point == DiscoveryPoint::BeforeRead {
                count.fetch_add(1, Ordering::SeqCst);
            }
            if point == DiscoveryPoint::AfterRead
                && std::path::Path::new(path) == selected
                && !hit.swap(true, Ordering::SeqCst)
            {
                std::fs::create_dir_all(&directory)?;
                std::fs::write(&file, "{}\n")?;
                directory_time(&selected, old + Duration::from_secs(2));
            }
            Ok(())
        });
        TEST_DISCOVERY
            .scope(hook, async {
                assert!(f.engine().list_default_rollout_files().await.is_empty());
                assert!(fired.load(Ordering::SeqCst));
                let expected = vec![transcript.to_string_lossy().into_owned()];
                assert_eq!(f.engine().list_default_rollout_files().await, expected);
                let before = reads.load(Ordering::SeqCst);
                assert_eq!(f.engine().list_default_rollout_files().await, expected);
                assert_eq!(reads.load(Ordering::SeqCst), before);
            })
            .await;
    }
}
#[tokio::test]
async fn main_discovery_l58_engine_retries_failed_root_and_leaf_without_mtime_change() {
    for level in ["root", "leaf"] {
        let f = Fixture::new();
        let sessions = f.root.path().join("sessions");
        let leaf = sessions.join("2026/06/24");
        std::fs::create_dir_all(&leaf).unwrap();
        let transcript = leaf.join("rollout-existing.jsonl");
        std::fs::write(&transcript, "{}\n").unwrap();
        let scanned = if level == "root" {
            sessions.clone()
        } else {
            leaf.clone()
        };
        let original = std::fs::metadata(&scanned).unwrap().modified().unwrap();
        let fail = Arc::new(AtomicBool::new(true));
        let once = Arc::clone(&fail);
        let reads = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&reads);
        let selected = scanned.clone();
        let hook = Arc::new(move |path: &str, point: DiscoveryPoint| {
            if point == DiscoveryPoint::BeforeRead {
                count.fetch_add(1, Ordering::SeqCst);
                if std::path::Path::new(path) == selected && once.swap(false, Ordering::SeqCst) {
                    return Err(std::io::Error::other("temporary enumeration failure"));
                }
            }
            Ok(())
        });
        TEST_DISCOVERY
            .scope(hook, async {
                assert!(f.engine().list_default_rollout_files().await.is_empty());
                assert!(f
                    .input
                    .inner
                    .body
                    .with_shared(|shared| shared.cached_default.is_none()));
                assert!(!fail.load(Ordering::SeqCst));
                assert_eq!(
                    std::fs::metadata(&scanned).unwrap().modified().unwrap(),
                    original
                );
                let expected = vec![transcript.to_string_lossy().into_owned()];
                assert_eq!(f.engine().list_default_rollout_files().await, expected);
                let before = reads.load(Ordering::SeqCst);
                assert_eq!(f.engine().list_default_rollout_files().await, expected);
                assert_eq!(reads.load(Ordering::SeqCst), before);
            })
            .await;
    }
}

#[tokio::test]
async fn native_full_collect_discovers_first_rollout_with_unchanged_directory_clock() {
    tokio::time::timeout(Duration::from_secs(4), async {
        let f = Fixture::new();
        let sessions = f.root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        f.input.start().await.unwrap();
        f.input.inner.await_current_cycle_for_test().await;
        let clock = std::fs::metadata(&sessions).unwrap().modified().unwrap();
        let path = f
            .write("2026/08/07/rollout-session-1.jsonl", &completed())
            .await;
        directory_time(&sessions, clock);
        assert_eq!(
            std::fs::metadata(&sessions).unwrap().modified().unwrap(),
            clock
        );
        f.input.run_cycle().await;
        let rows = f.records();
        assert_eq!(
            events(&rows, "llm.response").len(),
            3,
            "same-clock full discovery lost new source"
        );
        assert_eq!(events(&rows, "tool.call").len(), 2);
        assert_eq!(events(&rows, "tool.result").len(), 2);
        assert_eq!(f.checkpoint(&path).scan_offset, completed().len() as i64);
        assert_unique_native_events(&rows);
        f.input.stop().await.unwrap();
    })
    .await
    .expect("original native collection bound remains 4s");
}

fn assert_unique_native_events(rows: &[Value]) {
    assert_eq!(
        rows.iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        rows.len()
    );
}

#[tokio::test]
async fn native_full_collect_discovers_new_rollout_in_nonempty_same_clock_bucket() {
    tokio::time::timeout(Duration::from_secs(4), async {
        let f = Fixture::new();
        let old = completed()
            .replace("session-1", "old-session")
            .replace("turn-1", "old-turn");
        let old_path = f.write("2026/08/07/rollout-old-session.jsonl", &old).await;
        f.input.start().await.unwrap();
        f.input.inner.await_current_cycle_for_test().await;
        assert!(f.records().is_empty());
        let bucket = std::path::Path::new(&old_path).parent().unwrap();
        let clock = std::fs::metadata(bucket).unwrap().modified().unwrap();
        let new_path = f
            .write("2026/08/07/rollout-session-1.jsonl", &completed())
            .await;
        directory_time(bucket, clock);
        assert_eq!(
            std::fs::metadata(bucket).unwrap().modified().unwrap(),
            clock
        );
        f.input.run_cycle().await;
        let rows = f.records();
        assert_eq!(events(&rows, "llm.response").len(), 3);
        assert_eq!(
            f.checkpoint(&new_path).scan_offset,
            completed().len() as i64
        );
        assert_eq!(f.checkpoint(&old_path).scan_offset, old.len() as i64);
        assert!(rows.iter().all(|r| r["gen_ai.session.id"] != "old-session"));
        assert_unique_native_events(&rows);
        f.input.stop().await.unwrap();
    })
    .await
    .expect("original native collection bound remains 4s");
}

#[tokio::test]
async fn native_restart_baselines_new_same_clock_rollout_before_any_output() {
    tokio::time::timeout(Duration::from_secs(4), async {
        let f = Fixture::new();
        let old = completed()
            .replace("session-1", "old-session")
            .replace("turn-1", "old-turn");
        let old_path = f.write("2026/08/07/rollout-old-session.jsonl", &old).await;
        f.input.start().await.unwrap();
        f.input.stop().await.unwrap();
        let bucket = std::path::Path::new(&old_path).parent().unwrap();
        let clock = std::fs::metadata(bucket).unwrap().modified().unwrap();
        let new_path = f
            .write("2026/08/07/rollout-session-1.jsonl", &completed())
            .await;
        directory_time(bucket, clock);
        f.input.start().await.unwrap();
        f.input.inner.await_current_cycle_for_test().await;
        assert!(
            f.records().is_empty(),
            "restart promoted preexisting private history"
        );
        assert_eq!(
            f.checkpoint(&new_path).scan_offset,
            completed().len() as i64
        );
        assert_eq!(f.checkpoint(&old_path).scan_offset, old.len() as i64);
        f.input.stop().await.unwrap();
    })
    .await
    .expect("original native collection bound remains 4s");
}

#[tokio::test]
async fn native_known_targeted_wakeup_keeps_real_whole_tree_reads_at_zero() {
    use crate::inputs::base::InputBody;
    tokio::time::timeout(Duration::from_secs(4), async {
        let f = Fixture::new();
        let path = f
            .write(
                "2026/08/07/rollout-session-1.jsonl",
                &(completed().lines().next().unwrap().to_owned() + "\n"),
            )
            .await;
        f.input.start().await.unwrap();
        f.input.inner.await_current_cycle_for_test().await;
        f.append(
            &path,
            &(completed().lines().skip(1).collect::<Vec<_>>().join("\n") + "\n"),
        )
        .await;
        f.input.inner.body.note_wakeup(Some("session-1.json"));
        f.input.inner.body.with_shared(|s| {
            s.wakeup.only_requested = true;
            s.main541_visits.clear();
            s.main541_discoveries = 0;
        });
        let reads = Arc::new(AtomicUsize::new(0));
        let count = reads.clone();
        let observed = Arc::new(move |_: &str, point: DiscoveryPoint| {
            if point == DiscoveryPoint::BeforeRead {
                count.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        });
        // Run the real body/engine future in this task so the existing IO
        // observer sees every recursive listing, without replacing its code.
        TEST_DISCOVERY
            .scope(observed, async {
                f.input.inner.body.collect(f.rt()).await.unwrap();
            })
            .await;
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        f.input.inner.body.with_shared(|s| {
            assert_eq!(s.main541_discoveries, 0);
            assert_eq!(s.main541_visits, vec![path.clone()]);
        });
        assert_eq!(events(&f.records(), "llm.response").len(), 3);
        assert_eq!(f.checkpoint(&path).scan_offset, completed().len() as i64);
        f.input.stop().await.unwrap();
    })
    .await
    .expect("original native collection bound remains 4s");
}
