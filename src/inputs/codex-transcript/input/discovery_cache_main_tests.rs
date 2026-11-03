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
