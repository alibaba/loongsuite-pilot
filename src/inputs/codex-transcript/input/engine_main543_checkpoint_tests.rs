//! Main 95081bd source-recovery checkpoint/persistence contracts.
//! One Rust function per owned AST; each source parameter keeps its own 15s budget.
use super::*;

const CHECKPOINT_CASE_MAX_SAFE: u64 = 9_007_199_254_740_991;

fn checkpoint_case_invalid_numbers() -> Vec<(&'static str, Value)> {
    // serde_json::Value cannot contain NaN/Infinity. Its explicit JSON projection
    // is null; these three invalid-value categories remain observable as rejected
    // metadata. L426 separately records the raw Infinity projection difference.
    vec![
        ("negative", json!(-1)),
        ("fractional", json!(0.5)),
        ("NaN-json-projection", json!(f64::NAN)),
        ("Infinity-json-projection", json!(f64::INFINITY)),
        (
            "negative-Infinity-json-projection",
            json!(f64::NEG_INFINITY),
        ),
        ("unsafe-integer", json!(CHECKPOINT_CASE_MAX_SAFE + 1)),
    ]
}
fn checkpoint_case_parsed(f: &Fixture, path: &str) -> Option<Value> {
    f.engine()
        .read_checkpoint(f.rt(), &f.engine().state_key(path))
        .map(|checkpoint| serde_json::to_value(checkpoint).unwrap())
}
fn checkpoint_case_required(f: &Fixture, path: &str) -> Value {
    checkpoint_case_parsed(f, path).expect("valid retained checkpoint")
}
fn checkpoint_case_deferred(checkpoint: &Value) -> &[Value] {
    checkpoint
        .get("deferredTerminals")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn checkpoint_case_responses(f: &Fixture, turn: &str) -> usize {
    responses_for(&f.records(), turn).len()
}
fn checkpoint_case_legacy(cp: &mut Value, end: i64) {
    cp["pendingFusion"] = json!({
        "turnId":"old","parentThreadId":"parent","parentTraceId":"a".repeat(32),
        "terminalEndOffset":end,
        "children":[{"parentToolCallId":"tool","parentTraceId":"a".repeat(32),"spawnedAtMs":0}]
    });
    cp["pendingSubagent"] = json!({
        "turnId":"old","parentThreadId":"parent","parentTurnId":"parent-turn",
        "parentTraceId":"a".repeat(32),"parentToolCallId":"tool","confidence":"explicit_id",
        "terminalEndOffset":end,"activeTurn":cp["activeTurn"].clone()
    });
    cp["forkBootstrap"] = json!({"state":"live-pending","searchOffset":0});
}
async fn checkpoint_case_save_load(f: &Fixture) {
    f.rt().state_store.save().await.unwrap();
    f.rt().state_store.load().await;
}

#[tokio::test]
async fn main543_l349_persisted_deferred_prefix_is_bounded_without_losing_the_barrier() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        let version = source_version_for(&case.path).await;
        let active = cp["activeTurn"].clone();
        let entries: Vec<_> = (0..10_000)
            .map(|i| {
                let mut active = active.clone();
                active["turnId"] = json!(format!("retained-{i}"));
                json!({
                    "activeTurn":active,
                    "pendingTerminal":{"turnId":format!("retained-{i}"),"terminalEndOffset":case.end,
                    "failure":{"sourceVersion":version,"retryAtMs":0,"delayMs":1000}}
                })
            })
            .collect();
        // Prefix first, then validate: a valid fifth element cannot fill a hole.
        let mut holes = cp.clone();
        holes["deferredTerminals"] = json!([null, null, null, null, entries[4]]);
        put_checkpoint(&case.f, &case.path, holes);
        assert!(checkpoint_case_deferred(&checkpoint_case_required(&case.f, &case.path)).is_empty());

        cp["deferredTerminals"] = Value::Array(entries);
        put_checkpoint(&case.f, &case.path, cp);
        checkpoint_case_save_load(&case.f).await;
        let parsed = checkpoint_case_required(&case.f, &case.path);
        let kept = checkpoint_case_deferred(&parsed);
        assert_eq!(kept.len(), 4);
        for (i, item) in kept.iter().enumerate() {
            assert_eq!(item["activeTurn"]["turnId"], format!("retained-{i}"));
        }
        case.f.process(&case.path).await;
        let raw = raw_checkpoint(&case.f, &case.path);
        assert_eq!(raw["pendingTerminal"]["turnId"], "old");
        assert_eq!(raw["scanOffset"], case.end);
        assert_eq!(checkpoint_case_responses(&case.f, "later"), 0);
        checkpoint_case_save_load(&case.f).await;
        assert_eq!(checkpoint_case_deferred(&raw_checkpoint(&case.f, &case.path)).len(), 4);
        case.f.rt().reset_read_accumulator_for_test();
        case.f.process(&case.path).await;
        assert_eq!(case.f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
    }).await;
}

#[tokio::test]
async fn main543_l408_invalid_terminal_offsets_drop_both_barriers_and_keep_later_work() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["pendingTerminal"]["terminalEndOffset"] = invalid;
            cp["deferredTerminals"] = json!([{
                "activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]
            }]);
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert!(parsed["pendingTerminal"].is_null(), "{label}");
            assert!(checkpoint_case_deferred(&parsed).is_empty(), "{label}");
            assert_eq!(parsed["activeTurn"]["turnId"], "old", "{label}");
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l426_real_overflow_json_keeps_valid_state_and_collects_later_once() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        case.f.rt().state_store.update(
            "other-preserved",
            InputStatePatch {
                last_offset: Some(99.0),
                extra: Some(json!({"preserved":true})),
                ..Default::default()
            },
        );
        case.f.rt().state_store.save().await.unwrap();
        let state_path = case.f.root.path().join("state.json");
        let original = tokio::fs::read_to_string(&state_path).await.unwrap();
        let pattern = regex::Regex::new(r#"("terminalEndOffset"\s*:\s*)\d+"#).unwrap();
        assert!(pattern.is_match(&original));
        let overflowing = pattern
            .replacen(&original, 1, |captures: &regex::Captures<'_>| {
                format!("{}1e309", &captures[1])
            })
            .into_owned();
        assert_ne!(overflowing, original);
        tokio::fs::write(&state_path, overflowing).await.unwrap();
        case.f.rt().state_store.load().await;
        let raw = raw_checkpoint(&case.f, &case.path);
        assert_eq!(raw["scanOffset"], case.end);
        assert_eq!(raw["activeTurn"]["turnId"], "old");
        assert_eq!(
            case.f.rt().state_store.get("other-preserved").last_offset(),
            Some(99.0)
        );
        assert_eq!(
            case.f
                .rt()
                .state_store
                .get("other-preserved")
                .extra()
                .unwrap()["preserved"],
            true
        );
        // Source JS asserts raw===Infinity. Native Value cannot represent it:
        // Root's strict checkpoint fallback projects only the bad number to null.
        // This literal-projection difference is explicitly PARTIAL in the mapping.
        assert!(raw["pendingTerminal"]["terminalEndOffset"].is_null());
        let parsed = checkpoint_case_required(&case.f, &case.path);
        assert!(parsed["pendingTerminal"].is_null());
        assert_eq!(parsed["activeTurn"]["turnId"], "old");
        case.f.process(&case.path).await;
        assert_eq!(checkpoint_case_responses(&case.f, "later"), 1);
    })
    .await;
}

#[tokio::test]
async fn main543_l517_inconsistent_pending_and_legacy_ranges_do_not_block_later() {
    for mode in [
        "missing-active",
        "mismatched-turn",
        "reversed-range",
        "legacy-reversed-range",
    ] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            match mode {
                "missing-active" => cp["activeTurn"] = Value::Null,
                "mismatched-turn" => cp["pendingTerminal"]["turnId"] = json!("different-turn"),
                "legacy-reversed-range" => {
                    cp["pendingTerminal"] = Value::Null;
                    cp["pendingSubagent"] = json!({"turnId":"old","terminalEndOffset":0});
                }
                _ => cp["pendingTerminal"]["terminalEndOffset"] = json!(0),
            }
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert!(parsed["pendingTerminal"].is_null(), "{mode}");
            if mode != "missing-active" {
                assert_eq!(parsed["activeTurn"]["turnId"], "old");
            }
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{mode}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l536_invalid_active_and_deferred_starts_do_not_block_later() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["activeTurn"]["startOffset"] = invalid;
            cp["deferredTerminals"] =
                json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert!(parsed["activeTurn"].is_null(), "{label}");
            assert!(parsed["pendingTerminal"].is_null(), "{label}");
            assert!(checkpoint_case_deferred(&parsed).is_empty(), "{label}");
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l552_invalid_optional_retry_metadata_is_omitted_not_the_range() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            for field in [
                "retryCount",
                "firstPendingAtMs",
                "lastAttemptAtMs",
                "sourceRecordCount",
            ] {
                cp["pendingTerminal"][field] = invalid.clone();
            }
            let mut active = cp["activeTurn"].clone();
            active["turnId"] = json!("retained");
            let mut pending = cp["pendingTerminal"].clone();
            pending["turnId"] = json!("retained");
            cp["deferredTerminals"] = json!([{"activeTurn":active,"pendingTerminal":pending}]);
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            for pending in [
                &parsed["pendingTerminal"],
                &checkpoint_case_deferred(&parsed)[0]["pendingTerminal"],
            ] {
                assert_eq!(pending["terminalEndOffset"], case.end, "{label}");
                for field in [
                    "retryCount",
                    "firstPendingAtMs",
                    "lastAttemptAtMs",
                    "sourceRecordCount",
                ] {
                    assert!(pending.get(field).is_none(), "{label}:{field}");
                }
            }
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
            let raw = raw_checkpoint(&case.f, &case.path);
            let deferred = checkpoint_case_deferred(&raw);
            assert_eq!(deferred.len(), 2);
            for item in deferred {
                assert_eq!(item["pendingTerminal"]["retryCount"], 1);
            }
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l575_zero_metadata_survives_but_bad_deadlines_and_delays_are_dropped() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        for field in [
            "retryCount",
            "firstPendingAtMs",
            "lastAttemptAtMs",
            "sourceRecordCount",
        ] {
            cp["pendingTerminal"][field] = json!(0);
        }
        cp["pendingTerminal"]["failure"] =
            json!({"sourceVersion":"old-version","retryAtMs":0,"delayMs":1000});
        put_checkpoint(&case.f, &case.path, cp.clone());
        let pending = checkpoint_case_required(&case.f, &case.path)["pendingTerminal"].clone();
        let mut keys: Vec<_> = pending
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "failure",
                "firstPendingAtMs",
                "lastAttemptAtMs",
                "retryCount",
                "sourceRecordCount",
                "terminalEndOffset",
                "turnId"
            ]
        );
        assert_eq!(pending["turnId"], "old");
        assert_eq!(pending["terminalEndOffset"], case.end);
        for field in [
            "retryCount",
            "firstPendingAtMs",
            "lastAttemptAtMs",
            "sourceRecordCount",
        ] {
            assert_eq!(pending[field].as_f64(), Some(0.0), "{field}");
        }
        assert_eq!(
            pending["failure"],
            json!({"sourceVersion":"old-version","retryAtMs":0.0,"delayMs":1000})
        );
        for (label, invalid) in checkpoint_case_invalid_numbers() {
            cp["pendingTerminal"]["failure"]["retryAtMs"] = invalid;
            put_checkpoint(&case.f, &case.path, cp.clone());
            assert!(
                checkpoint_case_required(&case.f, &case.path)["pendingTerminal"]
                    .get("failure")
                    .is_none(),
                "{label}"
            );
        }
        cp["pendingTerminal"]["failure"]["retryAtMs"] = json!(0);
        cp["pendingTerminal"]["failure"]["delayMs"] = json!(1000.5);
        put_checkpoint(&case.f, &case.path, cp);
        assert!(
            checkpoint_case_required(&case.f, &case.path)["pendingTerminal"]
                .get("failure")
                .is_none()
        );
        case.f.process(&case.path).await;
        assert_eq!(checkpoint_case_responses(&case.f, "later"), 1);
        assert_eq!(
            raw_checkpoint(&case.f, &case.path)["deferredTerminals"][0]["pendingTerminal"]
                ["failure"]["delayMs"],
            1000
        );
    })
    .await;
}

#[tokio::test]
async fn main543_l595_retry_counters_saturate_at_the_safe_limit_and_persist() {
    for location in ["pending", "deferred"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["pendingTerminal"]["retryCount"] = json!(CHECKPOINT_CASE_MAX_SAFE);
            if location == "deferred" {
                cp["deferredTerminals"] = json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
                cp["activeTurn"] = Value::Null;
                cp["pendingTerminal"] = Value::Null;
                cp["scanOffset"] = json!(tokio::fs::metadata(&case.path).await.unwrap().len());
            }
            put_checkpoint(&case.f, &case.path, cp);
            case.f.process(&case.path).await;
            assert_eq!(raw_checkpoint(&case.f, &case.path)["deferredTerminals"][0]["pendingTerminal"]["retryCount"], CHECKPOINT_CASE_MAX_SAFE);
            checkpoint_case_save_load(&case.f).await;
            case.f.rt().reset_read_accumulator_for_test();
            case.f.process(&case.path).await;
            assert_eq!(case.f.rt().reset_read_accumulator_for_test().raw_read_bytes, 0);
        }).await;
    }
}

#[tokio::test]
async fn main543_l610_invalid_scan_cursors_rebuild_and_deliver_new_appended_work() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["scanOffset"] = invalid;
            put_checkpoint(&case.f, &case.path, cp);
            assert!(
                checkpoint_case_parsed(&case.f, &case.path).is_none(),
                "{label}"
            );
            case.f.process(&case.path).await;
            let cursor = raw_checkpoint(&case.f, &case.path)["scanOffset"].as_u64();
            assert!(
                cursor.is_some_and(|value| value <= CHECKPOINT_CASE_MAX_SAFE),
                "{label}"
            );
            case.f
                .append(&case.path, &normal_turn("after-invalid-cursor", false))
                .await;
            case.f.process(&case.path).await;
            assert_eq!(
                checkpoint_case_responses(&case.f, "after-invalid-cursor"),
                1,
                "{label}"
            );
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l634_legacy_boundaries_ahead_of_saved_cursor_never_release() {
    for kind in ["fusion", "captured-subagent"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            for end in [case.end + 1, CHECKPOINT_CASE_MAX_SAFE as i64] {
                let mut cp = raw_checkpoint(&case.f, &case.path);
                checkpoint_case_legacy(&mut cp, end);
                cp["pendingTerminal"] = Value::Null;
                cp.as_object_mut().unwrap().remove("forkBootstrap");
                if kind == "fusion" {
                    cp["pendingSubagent"] = Value::Null;
                } else {
                    cp["pendingFusion"] = Value::Null;
                }
                put_checkpoint(&case.f, &case.path, cp);
                checkpoint_case_save_load(&case.f).await;
                let parsed = checkpoint_case_required(&case.f, &case.path);
                for field in ["pendingFusion", "pendingSubagent", "pendingTerminal"] {
                    assert!(parsed[field].is_null(), "{kind}:{end}:{field}");
                }
                assert_eq!(parsed["activeTurn"]["turnId"], "old");
            }
            let releases = capture_legacy_releases(&case.f);
            case.f.process(&case.path).await;
            assert!(releases.lock().unwrap().is_empty(), "{kind}");
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{kind}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l660_legacy_fusion_requires_the_same_turn_and_forward_range() {
    for mode in ["mismatched-turn", "reversed-range"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            checkpoint_case_legacy(&mut cp, case.end);
            cp["pendingTerminal"] = Value::Null;
            cp["pendingSubagent"] = Value::Null;
            cp.as_object_mut().unwrap().remove("forkBootstrap");
            if mode == "mismatched-turn" {
                cp["pendingFusion"]["turnId"] = json!("different-turn");
            } else {
                cp["pendingFusion"]["terminalEndOffset"] = json!(0);
            }
            put_checkpoint(&case.f, &case.path, cp);
            assert!(
                checkpoint_case_required(&case.f, &case.path)["pendingFusion"].is_null(),
                "{mode}"
            );
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{mode}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l674_valid_legacy_barriers_survive_saved_at_behind_or_no_active() {
    for location in ["at", "behind", "without-active"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            checkpoint_case_legacy(&mut cp, case.end);
            let start = cp["activeTurn"]["startOffset"].clone();
            if location == "without-active" {
                cp["activeTurn"] = Value::Null;
            }
            cp["pendingTerminal"] = Value::Null;
            cp.as_object_mut().unwrap().remove("forkBootstrap");
            cp["scanOffset"] = if location == "at" {
                json!(case.end)
            } else {
                json!(tokio::fs::metadata(&case.path).await.unwrap().len())
            };
            put_checkpoint(&case.f, &case.path, cp);
            checkpoint_case_save_load(&case.f).await;
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert_eq!(
                parsed["pendingFusion"]["terminalEndOffset"], case.end,
                "{location}"
            );
            assert_eq!(
                parsed["pendingSubagent"]["terminalEndOffset"], case.end,
                "{location}"
            );
            assert_eq!(parsed["pendingSubagent"]["activeTurn"]["turnId"], "old");
            assert_eq!(
                parsed["pendingSubagent"]["activeTurn"]["startOffset"],
                start
            );
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l689_legacy_parsing_has_no_retry_clock_or_state_side_effect() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        cp["pendingTerminal"] = Value::Null;
        cp["pendingSubagent"] = json!({"turnId":"old","terminalEndOffset":case.end});
        put_checkpoint(&case.f, &case.path, cp);
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_800_000_000_000));
        set_recovery_clock(&case.f, clock.clone());
        let revision = case.f.rt().state_store.revision();
        let raw = raw_checkpoint(&case.f, &case.path);
        let first = checkpoint_case_required(&case.f, &case.path);
        clock.fetch_add(30_000, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(checkpoint_case_required(&case.f, &case.path), first);
        assert_eq!(
            first["pendingTerminal"],
            json!({"turnId":"old","terminalEndOffset":case.end})
        );
        assert_eq!(case.f.rt().state_store.revision(), revision);
        assert_eq!(raw_checkpoint(&case.f, &case.path), raw);
    })
    .await;
}

#[tokio::test]
async fn main543_l703_first_actual_legacy_attempt_keeps_its_time_after_restart() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        cp["pendingTerminal"] = Value::Null;
        cp["pendingSubagent"] = json!({"turnId":"old","terminalEndOffset":case.end});
        put_checkpoint(&case.f, &case.path, cp);
        let first_at = 1_800_000_000_000_i64;
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(first_at));
        set_recovery_clock(&case.f, clock.clone());
        case.f.process(&case.path).await;
        let raw = raw_checkpoint(&case.f, &case.path);
        let pending = &raw["deferredTerminals"][0]["pendingTerminal"];
        assert_eq!(pending["retryCount"], 1);
        assert_eq!(pending["firstPendingAtMs"].as_f64(), Some(first_at as f64));
        assert_eq!(pending["lastAttemptAtMs"].as_f64(), Some(first_at as f64));
        assert_eq!(checkpoint_case_responses(&case.f, "later"), 1);
        checkpoint_case_save_load(&case.f).await;
        let restarted = case.f.restart().await;
        clock.fetch_add(3_600_000, std::sync::atomic::Ordering::SeqCst);
        set_recovery_clock(&restarted, clock);
        let recoveries = capture_recovery_ends(&restarted);
        restarted.process(&case.path).await;
        assert!(recoveries.lock().unwrap().is_empty());
        let raw = raw_checkpoint(&restarted, &case.path);
        let pending = &raw["deferredTerminals"][0]["pendingTerminal"];
        assert_eq!(pending["retryCount"], 1);
        assert_eq!(pending["firstPendingAtMs"].as_f64(), Some(first_at as f64));
        assert_eq!(pending["lastAttemptAtMs"].as_f64(), Some(first_at as f64));
    })
    .await;
}

#[tokio::test]
async fn main543_l759_invalid_owner_fusion_subagent_and_fork_offsets_are_rejected() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            checkpoint_case_legacy(&mut cp, case.end);
            put_checkpoint(&case.f, &case.path, cp.clone());
            let valid = checkpoint_case_required(&case.f, &case.path);
            assert!(!valid["pendingFusion"].is_null());
            assert!(!valid["pendingSubagent"].is_null());
            assert_eq!(valid["forkBootstrap"]["searchOffset"], 0);
            cp["pendingTerminal"] = Value::Null;
            cp["ownerSessionMetaOffset"] = invalid.clone();
            cp["pendingFusion"]["terminalEndOffset"] = invalid.clone();
            cp["pendingSubagent"]["terminalEndOffset"] = invalid.clone();
            cp["forkBootstrap"]["searchOffset"] = invalid;
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            for field in [
                "ownerSessionMetaOffset",
                "pendingFusion",
                "pendingSubagent",
                "pendingTerminal",
            ] {
                assert!(parsed[field].is_null(), "{label}:{field}");
            }
            assert!(parsed.get("forkBootstrap").is_none(), "{label}");
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l784_captured_legacy_turn_and_range_must_match() {
    for mode in ["mismatched-turn", "reversed-range"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            checkpoint_case_legacy(&mut cp, case.end);
            cp["pendingFusion"] = Value::Null;
            cp["pendingTerminal"] = Value::Null;
            cp.as_object_mut().unwrap().remove("forkBootstrap");
            if mode == "mismatched-turn" {
                cp["pendingSubagent"]["turnId"] = json!("different");
            } else {
                cp["pendingSubagent"]["terminalEndOffset"] = json!(0);
            }
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert!(parsed["pendingSubagent"].is_null(), "{mode}");
            assert!(parsed["pendingTerminal"].is_null(), "{mode}");
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{mode}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l800_zero_and_integral_float_boundaries_are_valid() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        for boundary in [0.0, 1.0] {
            let mut cp = raw_checkpoint(&case.f, &case.path);
            for field in ["startOffset", "startedAtMs", "nextStepStartedAtMs"] {
                cp["activeTurn"][field] = json!(boundary);
            }
            cp["activeTurn"]["subagentSpawns"] = json!([{
                "parentToolCallId":"tool","parentTraceId":"trace","spawnedAtMs":boundary
            }]);
            cp["scanOffset"] = json!(boundary);
            cp["pendingTerminal"]["terminalEndOffset"] = json!(boundary);
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert_eq!(parsed["scanOffset"].as_f64(), Some(boundary));
            assert_eq!(
                parsed["pendingTerminal"]["terminalEndOffset"].as_f64(),
                Some(boundary)
            );
            assert_eq!(parsed["activeTurn"]["startedAtMs"].as_f64(), Some(boundary));
            assert_eq!(
                parsed["activeTurn"]["nextStepStartedAtMs"].as_f64(),
                Some(boundary)
            );
            let spawn = &parsed["activeTurn"]["subagentSpawns"][0];
            assert_eq!(spawn["spawnedAtMs"].as_f64(), Some(boundary));
            assert_eq!(spawn["parentToolCallId"], "tool");
            assert_eq!(spawn["parentTraceId"], "trace");
        }
    })
    .await;
}

#[tokio::test]
async fn main543_l816_invalid_required_times_drop_active_and_deferred_context() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["activeTurn"]["startedAtMs"] = invalid;
            cp["deferredTerminals"] =
                json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            assert!(parsed["activeTurn"].is_null(), "{label}");
            assert!(parsed["pendingTerminal"].is_null(), "{label}");
            assert!(checkpoint_case_deferred(&parsed).is_empty(), "{label}");
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l831_bad_optional_times_do_not_destroy_valid_active_context() {
    for (label, invalid) in checkpoint_case_invalid_numbers() {
        source_budget(async {
            let case = pending_fixture(1024).await;
            let mut cp = raw_checkpoint(&case.f, &case.path);
            cp["activeTurn"]["nextStepStartedAtMs"] = invalid.clone();
            cp["activeTurn"]["subagentSpawns"] = json!([{
                "parentToolCallId":"tool","parentTraceId":"trace","spawnedAtMs":invalid
            }]);
            cp["deferredTerminals"] =
                json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
            let started = cp["activeTurn"]["startedAtMs"].clone();
            put_checkpoint(&case.f, &case.path, cp);
            let parsed = checkpoint_case_required(&case.f, &case.path);
            for active in [
                &parsed["activeTurn"],
                &checkpoint_case_deferred(&parsed)[0]["activeTurn"],
            ] {
                assert_eq!(active["turnId"], "old", "{label}");
                assert_eq!(active["startedAtMs"].as_f64(), started.as_f64());
                assert!(active.get("nextStepStartedAtMs").is_none(), "{label}");
            }
            // The typed parser retains an exact empty Vec; serialization omits
            // that empty field. Check the actual returned contexts directly.
            let native = case
                .f
                .engine()
                .read_checkpoint(case.f.rt(), &case.f.engine().state_key(&case.path))
                .expect("valid checkpoint with malformed optional metadata");
            assert!(
                native
                    .active_turn
                    .as_ref()
                    .unwrap()
                    .subagent_spawns
                    .is_empty(),
                "{label}:active"
            );
            assert!(
                native.deferred_terminals[0]
                    .active_turn
                    .subagent_spawns
                    .is_empty(),
                "{label}:deferred"
            );
            case.f.process(&case.path).await;
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{label}");
        })
        .await;
    }
}

#[tokio::test]
async fn main543_l849_all_barrier_kinds_reject_end_beyond_the_persisted_cursor() {
    for location in ["pending", "deferred", "legacy-pending"] {
        source_budget(async {
            let case = pending_fixture(1024).await;
            for end in [case.end + 1, CHECKPOINT_CASE_MAX_SAFE as i64] {
                let mut cp = raw_checkpoint(&case.f, &case.path);
                let pending = json!({"turnId":"old","terminalEndOffset":end});
                cp["pendingTerminal"] = if location == "pending" {
                    pending.clone()
                } else {
                    Value::Null
                };
                cp["deferredTerminals"] = if location == "deferred" {
                    json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":pending}])
                } else {
                    json!([])
                };
                cp["pendingSubagent"] = if location == "legacy-pending" {
                    pending
                } else {
                    Value::Null
                };
                put_checkpoint(&case.f, &case.path, cp);
                checkpoint_case_save_load(&case.f).await;
                let parsed = checkpoint_case_required(&case.f, &case.path);
                assert!(parsed["pendingTerminal"].is_null(), "{location}:{end}");
                assert!(checkpoint_case_deferred(&parsed).is_empty());
                assert_eq!(parsed["activeTurn"]["turnId"], "old");
            }
            let boundaries = capture_recovery_ends(&case.f);
            case.f.process(&case.path).await;
            let size = tokio::fs::metadata(&case.path).await.unwrap().len() as i64;
            assert!(boundaries.lock().unwrap().iter().all(|end| *end <= size));
            assert_eq!(checkpoint_case_responses(&case.f, "later"), 1, "{location}");
        })
        .await;
    }
}
