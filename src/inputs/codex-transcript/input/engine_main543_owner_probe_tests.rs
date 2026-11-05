//! Exact source-recovery owner-probe/cache contracts from upstream 95081bd.
//! Kept separate from retry/backoff and checkpoint-field validation ownership.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn owner_cache_len(f: &Fixture) -> usize {
    f.input
        .inner
        .body
        .with_shared(|shared| shared.owner_offset_probes.len())
}

fn response_count(f: &Fixture, turn: &str) -> usize {
    f.records()
        .iter()
        .filter(|entry| {
            entry["event.name"] == "llm.response" && entry["agent.codex.transcript_turn_id"] == turn
        })
        .count()
}

fn advance_modified_time(path: &str) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    let metadata = file.metadata().unwrap();
    file.set_times(
        std::fs::FileTimes::new()
            .set_accessed(metadata.accessed().unwrap())
            .set_modified(metadata.modified().unwrap() + Duration::from_secs(1)),
    )
    .unwrap();
}

#[tokio::test]
async fn source_l58_missing_owner_startup_baseline_has_zero_repeated_reads_or_state_mutation() {
    source_budget(async {
        let f = Fixture::new();
        let text = diagnostic().repeat(32);
        let path = f.write("rollout-session.jsonl", &text).await;
        f.rt().reset_read_accumulator_for_test();
        InputBody::on_start(&f.input.inner.body, f.rt())
            .await
            .unwrap();
        let startup = f.rt().reset_read_accumulator_for_test();
        assert!(
            startup.raw_read_bytes <= 2 * text.len() as u64,
            "original L58 startup rawReadBytes={} sourceBytes={} maximum={}",
            startup.raw_read_bytes,
            text.len(),
            2 * text.len()
        );
        let before = raw_checkpoint(&f, &path);
        let revision = f.rt().state_store.revision();
        for _ in 0..3 {
            f.rt().reset_read_accumulator_for_test();
            InputBody::collect(&f.input.inner.body, f.rt())
                .await
                .unwrap();
            let cycle = f.rt().reset_read_accumulator_for_test();
            assert_eq!(cycle.raw_read_bytes, 0);
            assert_eq!(cycle.raw_in_bytes, 0);
        }
        assert_eq!(f.rt().state_store.revision(), revision);
        assert_eq!(raw_checkpoint(&f, &path), before);
        assert!(raw_checkpoint(&f, &path)["ownerSessionMetaOffset"].is_null());
        InputBody::on_stop(&f.input.inner.body, f.rt())
            .await
            .unwrap();
    })
    .await;
}

#[tokio::test]
async fn source_l72_headerless_normal_turn_is_emitted_once_and_then_reads_zero_bytes() {
    source_budget(async {
        let f = Fixture::new();
        let path = f
            .write("rollout-session.jsonl", &normal_turn("normal", false))
            .await;
        f.process(&path).await;
        assert_eq!(response_count(&f, "normal"), 1);
        f.rt().reset_read_accumulator_for_test();
        f.process(&path).await;
        assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
    })
    .await;
}

#[tokio::test]
async fn source_l79_absent_owner_probe_invalidates_after_all_four_real_file_repairs() {
    for mode in ["append", "same-size", "new-inode", "truncate"] {
        source_budget(async {
            let f = Fixture::new();
            let original = diagnostic();
            let path = f.write("rollout-session.jsonl", &original).await;
            assert_eq!(probe_owner(&f, &path, None).await, None, "{mode}");
            if mode == "append" {
                f.append(&path, &owner_header()).await;
            } else {
                let header = owner_header();
                let body = if mode == "same-size" {
                    header.clone() + &" ".repeat(original.len() - header.len() - 1) + "\n"
                } else {
                    header
                };
                if mode == "new-inode" {
                    let replacement = format!("{path}.new");
                    tokio::fs::write(&replacement, &body).await.unwrap();
                    tokio::fs::rename(&replacement, &path).await.unwrap();
                } else {
                    tokio::fs::write(&path, &body).await.unwrap();
                }
            }
            advance_modified_time(&path);
            assert_eq!(
                probe_owner(&f, &path, None).await,
                Some(if mode == "append" {
                    original.len() as i64
                } else {
                    0
                }),
                "{mode}"
            );
        })
        .await;
    }
}

#[tokio::test]
async fn source_l93_writer_change_during_probe_cannot_memoize_a_negative_result() {
    source_budget(async {
        let f = Fixture::new();
        let path = f.write("rollout-session.jsonl", &diagnostic()).await;
        let changed = Arc::new(AtomicBool::new(false));
        let changed_in_hook = changed.clone();
        let watched_path = path.clone();
        set_probe_after_read(&f, move |observed| {
            if observed == watched_path && !changed_in_hook.swap(true, Ordering::SeqCst) {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&watched_path)
                    .unwrap();
                file.write_all(owner_header().as_bytes()).unwrap();
                file.flush().unwrap();
            }
        });
        assert_eq!(probe_owner(&f, &path, None).await, None);
        assert!(changed.load(Ordering::SeqCst));
        assert_eq!(owner_cache_len(&f), 0);
        assert!(f
            .rt()
            .state_store
            .get(&f.engine().state_key(&path))
            .extra()
            .and_then(|extra| extra.get("codexOwnerAbsentVersion").cloned())
            .is_none());
        assert!(probe_owner(&f, &path, None).await.is_some());
    })
    .await;
}

#[tokio::test]
async fn source_l106_fork_baseline_owner_probe_never_rereads_the_incomplete_tail() {
    source_budget(async {
        let f = Fixture::new();
        let prefix = diagnostic();
        let text = prefix.clone() + "{\"unfinished\":\"" + &"x".repeat(3 * 1024 * 1024);
        let path = f.write("rollout-session.jsonl", &text).await;
        let size = tokio::fs::metadata(&path).await.unwrap().len();
        f.rt().reset_read_accumulator_for_test();
        f.engine()
            .park_fork_baseline(f.rt(), &path, &f.engine().state_key(&path))
            .await
            .unwrap();
        let cycle = f.rt().reset_read_accumulator_for_test();
        let checkpoint = raw_checkpoint(&f, &path);
        assert_eq!(checkpoint["scanOffset"], prefix.len() as u64);
        assert!(checkpoint["ownerSessionMetaOffset"].is_null());
        assert!(cycle.raw_read_bytes <= size + prefix.len() as u64 + 1);
    })
    .await;
}

#[tokio::test]
async fn source_l118_limited_and_full_owner_probe_boundaries_remain_separate_and_reusable() {
    for order in ["limited-first", "full-first"] {
        source_budget(async {
            let f = Fixture::new();
            let prefix = diagnostic();
            let boundary = prefix.len() as i64;
            let path = f
                .write("rollout-session.jsonl", &(prefix + &owner_header()))
                .await;
            if order == "full-first" {
                assert_eq!(probe_owner(&f, &path, None).await, Some(boundary));
            }
            assert_eq!(probe_owner(&f, &path, Some(boundary)).await, None);
            f.rt().reset_read_accumulator_for_test();
            assert_eq!(probe_owner(&f, &path, Some(boundary)).await, None);
            assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
            assert_eq!(probe_owner(&f, &path, None).await, Some(boundary));
            for _ in 0..3 {
                f.rt().reset_read_accumulator_for_test();
                assert_eq!(probe_owner(&f, &path, Some(boundary)).await, None);
                assert_eq!(probe_owner(&f, &path, None).await, Some(boundary));
                assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
            }
        })
        .await;
    }
}

#[tokio::test]
async fn source_l136_hard_link_paths_keep_filename_selected_owners_separate() {
    source_budget(async {
        let f = Fixture::new();
        let first_id = "11111111-1111-4111-8111-111111111111";
        let second_id = "22222222-2222-4222-8222-222222222222";
        let first_header = row(
            "session_meta",
            json!({"id":first_id,"model_provider":"openai"}),
            0,
        );
        let text = first_header.clone()
            + &row(
                "session_meta",
                json!({"id":second_id,"model_provider":"openai"}),
                0,
            )
            + &diagnostic();
        let first = f.write(&format!("rollout-{first_id}.jsonl"), &text).await;
        let second = f
            .root
            .path()
            .join("sessions")
            .join(format!("rollout-{second_id}.jsonl"))
            .to_string_lossy()
            .into_owned();
        tokio::fs::hard_link(&first, &second).await.unwrap();
        let first_stat = crate::inputs::codex_transcript::scan::file_version_snapshot(&first)
            .await
            .unwrap();
        let second_stat = crate::inputs::codex_transcript::scan::file_version_snapshot(&second)
            .await
            .unwrap();
        assert_eq!(first_stat, second_stat);
        assert_eq!(probe_owner(&f, &first, None).await, Some(0));
        assert_eq!(
            probe_owner(&f, &second, None).await,
            Some(first_header.len() as i64)
        );
        f.rt().reset_read_accumulator_for_test();
        assert_eq!(probe_owner(&f, &first, None).await, Some(0));
        assert_eq!(
            probe_owner(&f, &second, None).await,
            Some(first_header.len() as i64)
        );
        assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
    })
    .await;
}

#[tokio::test]
async fn source_l157_final_stat_disappearance_keeps_later_healthy_file_indexing() {
    source_budget(async {
        let f = Fixture::new();
        let path = f.write("rollout-session.jsonl", &diagnostic()).await;
        let healthy = f.write("rollout-healthy.jsonl", &owner_header()).await;
        let removed = Arc::new(AtomicBool::new(false));
        let removed_in_hook = removed.clone();
        let watched_path = path.clone();
        set_probe_after_read(&f, move |observed| {
            if observed == watched_path && !removed_in_hook.swap(true, Ordering::SeqCst) {
                std::fs::remove_file(&watched_path).unwrap();
            }
        });
        f.engine()
            .index_discovered_transcript_owners(
                f.rt(),
                &[
                    crate::inputs::codex_transcript::discovery::DiscoveredSessionFile {
                        file_path: path,
                        baseline_on_start: false,
                    },
                    crate::inputs::codex_transcript::discovery::DiscoveredSessionFile {
                        file_path: healthy.clone(),
                        baseline_on_start: false,
                    },
                ],
                None,
            )
            .await
            .unwrap();
        assert!(removed.load(Ordering::SeqCst));
        assert_eq!(owner_cache_len(&f), 1);
        assert!(f
            .input
            .inner
            .body
            .with_shared(|shared| shared.meta_by_path.contains_key(&healthy)));
    })
    .await;
}

#[tokio::test]
async fn source_l178_owner_probe_cache_is_bounded_to_2048_and_cleared_on_actual_stop() {
    source_budget(async {
        let f = Fixture::new();
        let path = f.write("rollout-session.jsonl", &diagnostic()).await;
        f.input.inner.body.with_shared(|shared| {
            for index in 0..2048 {
                shared.owner_offset_probes.set(format!("old-{index}"), None);
            }
        });
        probe_owner(&f, &path, None).await;
        assert_eq!(owner_cache_len(&f), 2048);
        assert!(!f
            .input
            .inner
            .body
            .with_shared(|shared| shared.owner_offset_probes.has("old-0")));
        InputBody::on_stop(&f.input.inner.body, f.rt())
            .await
            .unwrap();
        assert_eq!(owner_cache_len(&f), 0);
    })
    .await;
}

#[tokio::test]
async fn source_l187_recent_positive_and_negative_owner_probes_survive_lru_churn() {
    for has_owner in [false, true] {
        source_budget(async {
            let f = Fixture::new();
            let text = if has_owner {
                owner_header() + &diagnostic()
            } else {
                diagnostic()
            };
            let path = f.write("rollout-session.jsonl", &text).await;
            let expected = has_owner.then_some(0);
            assert_eq!(probe_owner(&f, &path, None).await, expected);
            f.input.inner.body.with_shared(|shared| {
                for index in 0..2047 {
                    shared
                        .owner_offset_probes
                        .set(format!("cold-{index}"), None);
                }
            });
            f.rt().reset_read_accumulator_for_test();
            assert_eq!(probe_owner(&f, &path, None).await, expected);
            assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
            let added = f.write("rollout-added.jsonl", &diagnostic()).await;
            assert_eq!(probe_owner(&f, &added, None).await, None);
            f.rt().reset_read_accumulator_for_test();
            assert_eq!(probe_owner(&f, &path, None).await, expected);
            assert_eq!(f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
            assert!(!f
                .input
                .inner
                .body
                .with_shared(|shared| shared.owner_offset_probes.has("cold-0")));
            assert_eq!(owner_cache_len(&f), 2048);
        })
        .await;
    }
}

#[tokio::test]
async fn source_l725_persisted_owner_at_eof_or_outside_file_is_reprobed_once() {
    for mode in ["eof", "unsafe-range"] {
        source_budget(async {
            let pending = pending_fixture(1024).await;
            let f = &pending.f;
            let path = &pending.path;
            let mut checkpoint = raw_checkpoint(f, path);
            checkpoint["ownerSessionMetaOffset"] = json!(if mode == "eof" {
                tokio::fs::metadata(path).await.unwrap().len()
            } else {
                9_007_199_254_740_991_u64
            });
            put_checkpoint(f, path, checkpoint);
            f.rt().state_store.save().await.unwrap();
            f.rt().state_store.load().await;
            let before = owner_probe_call_count(f);
            f.process(path).await;
            assert_eq!(owner_probe_call_count(f) - before, 1);
            assert_eq!(raw_checkpoint(f, path)["ownerSessionMetaOffset"], 0);
            assert_eq!(response_count(f, "later"), 1);
        })
        .await;
    }
}

#[tokio::test]
async fn source_l737_live_fork_owner_ahead_of_parked_scan_survives_restart_without_reprobe() {
    source_budget(async {
        let f = Fixture::new();
        let owner_id = "019b76da-a800-7000-8000-000000000001";
        let copied = row(
            "session_meta",
            json!({"id":"parent","model_provider":"openai"}),
            0,
        );
        let path = f
            .write(
                &format!("rollout-{owner_id}.jsonl"),
                &(copied.clone()
                    + &row(
                        "session_meta",
                        json!({"id":owner_id,"model_provider":"openai","forked_from_id":"parent"}),
                        0,
                    )
                    + &normal_turn("copied-parent-turn", false)),
            )
            .await;
        f.process(&path).await;
        let checkpoint = raw_checkpoint(&f, &path);
        assert_eq!(checkpoint["scanOffset"], 0);
        assert_eq!(checkpoint["ownerSessionMetaOffset"], copied.len() as u64);
        assert_eq!(checkpoint["forkBootstrap"]["state"], "live-pending");
        f.rt().state_store.save().await.unwrap();
        f.rt().state_store.load().await;
        let restarted = f.restart().await;
        assert_eq!(
            restarted.checkpoint(&path).owner_session_meta_offset,
            Some(copied.len() as i64)
        );
        assert_eq!(owner_probe_call_count(&restarted), 0);
        restarted.process(&path).await;
        assert_eq!(owner_probe_call_count(&restarted), 0);
        let checkpoint = raw_checkpoint(&restarted, &path);
        assert_eq!(checkpoint["scanOffset"], 0);
        assert_eq!(checkpoint["ownerSessionMetaOffset"], copied.len() as u64);
        assert!(restarted.records().is_empty());
    })
    .await;
}

#[path = "engine_main565_owner_probe_tests.rs"]
mod main565_contracts;
