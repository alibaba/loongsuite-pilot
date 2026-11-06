// Exact identities observed in Native Windows x64/ARM64 run 41374812073.
// These tests exercise the checkpoint JSON contract on every platform; the
// actual Windows scan/reader/history regressions still run in Native CI.
use super::*;
use crate::checkpoints::{InputStatePatch, StateStore};
use serde_json::json;
use std::sync::Arc;

const WINDOWS_INODES: [u64; 7] = [
    15_762_598_697_515_553,
    19_703_248_371_464_725,
    18_014_398_511_200_787,
    9_007_199_255_671_545,
    10_977_524_092_646_103,
    9_007_199_254_740_993,
    u64::MAX,
];

#[test]
fn exact_windows_native_inode_identifiers_never_round_through_binary64() {
    for inode in WINDOWS_INODES {
        let raw = serde_json::to_string(&json!({"inode":inode})).expect("exact integer JSON");
        let value: Value = serde_json::from_str(&raw).expect("source JSON");
        assert_eq!(u64_value(value.get("inode")), Some(inode), "raw={raw}");
        let checkpoint =
            parse_checkpoint(&json!({"inode":inode,"scanOffset":118,"activeTurn":null}))
                .expect("production checkpoint parser");
        assert_eq!(
            checkpoint.inode, inode,
            "inode must not trigger a false rotation"
        );
        assert_eq!(
            checkpoint_to_value(&checkpoint)["inode"].as_u64(),
            Some(inode)
        );
    }
}

#[test]
fn checkpoint_integer_bounds_keep_exact_integers_and_legacy_integral_floats_without_saturation() {
    for number in [
        i64::MIN,
        i64::MIN + 1,
        -9_007_199_254_740_993,
        0,
        9_007_199_254_740_993,
        i64::MAX - 1,
        i64::MAX,
    ] {
        assert_eq!(i64_value(Some(&json!(number))), Some(number));
    }
    assert_eq!(u64_value(Some(&json!(10.0))), Some(10));
    assert_eq!(i64_value(Some(&json!(-10.0))), Some(-10));
    for invalid in [
        json!(-1),
        json!(0.25),
        json!("42"),
        Value::Null,
        json!(18_446_744_073_709_551_616.0),
    ] {
        assert_eq!(
            u64_value(Some(&invalid)),
            None,
            "invalid unsigned integer {invalid}"
        );
    }
    for invalid in [
        json!(0.25),
        json!("42"),
        Value::Null,
        json!(9_223_372_036_854_775_808.0),
        json!(-9_223_372_036_854_777_856.0),
    ] {
        assert_eq!(
            i64_value(Some(&invalid)),
            None,
            "invalid signed integer {invalid}"
        );
    }
}

#[tokio::test]
async fn real_checkpoint_store_save_and_fresh_load_keep_adjacent_windows_inodes_distinct() {
    let root = tempfile::tempdir().expect("synthetic state root");
    let path = root.path().join("input-state.json");
    let key = "codex-transcript:synthetic-rollout";
    for inode in WINDOWS_INODES {
        let store = Arc::new(StateStore::new(&path));
        store.load().await;
        let mut checkpoint = empty_checkpoint(inode);
        checkpoint.scan_offset = 118;
        checkpoint.first_owned_turn_id = Some("synthetic-owned-turn".into());
        checkpoint.owner_session_meta_offset = Some(0);
        checkpoint.active_turn = parse_active_turn(Some(&json!({
            "turnId":"synthetic-turn","startOffset":17,"startedAtMs":1_800_000_000_000.0
        })));
        assert!(checkpoint.active_turn.is_some());
        let pending = super::super::invocation_audit::PendingAgentResult {
            file_path: "synthetic-rollout".into(),
            inode,
            start_offset: 17,
            end_offset: 118,
            context: crate::normalization::build_agent_activity_entry(&json!({
                "gen_ai.session.id":"synthetic-session","event.id":"synthetic-pending-result"
            })),
        };
        store.update(
            "codex-transcript",
            InputStatePatch {
                extra: Some(json!({"codexPendingAgentResults":[pending]})),
                ..InputStatePatch::default()
            },
        );
        store.update(
            key,
            InputStatePatch {
                last_offset: Some(118.0),
                extra: Some(json!({"codexTranscript":checkpoint_to_value(&checkpoint)})),
                ..InputStatePatch::default()
            },
        );
        let extra = store.get(key).extra().expect("in-memory checkpoint");
        let parsed =
            parse_checkpoint(&extra["codexTranscript"]).expect("production parse before save");
        assert_eq!(parsed.inode, inode);
        assert_eq!(
            parsed.active_turn.as_ref().expect("active").turn_id,
            "synthetic-turn"
        );
        store.save().await.expect("actual durable state save");
        drop(store);
        let loaded = StateStore::new(&path);
        loaded.load().await;
        let extra = loaded.get(key).extra().expect("loaded checkpoint");
        let parsed =
            parse_checkpoint(&extra["codexTranscript"]).expect("production parse after restart");
        assert_eq!(
            parsed.inode, inode,
            "state reload must preserve exact source identity"
        );
        assert_eq!(parsed.scan_offset, 118);
        assert_eq!(
            parsed.first_owned_turn_id.as_deref(),
            Some("synthetic-owned-turn")
        );
        assert_eq!(parsed.owner_session_meta_offset, Some(0));
        assert_eq!(
            parsed.active_turn.as_ref().expect("active").start_offset,
            17
        );
        assert_eq!(extra["codexTranscript"]["inode"].as_u64(), Some(inode));
        let pending_extra = loaded
            .get("codex-transcript")
            .extra()
            .expect("pending source ranges");
        let pending: super::super::invocation_audit::PendingAgentResult =
            serde_json::from_value(pending_extra["codexPendingAgentResults"][0].clone())
                .expect("actual production pending-range decoder");
        assert_eq!(pending.inode, inode);
        assert_eq!((pending.start_offset, pending.end_offset), (17, 118));
        assert_eq!(pending.file_path, "synthetic-rollout");
        assert_eq!(pending.context.event_id, "synthetic-pending-result");
        assert_eq!(pending.context.session_id, "synthetic-session");
    }
}
