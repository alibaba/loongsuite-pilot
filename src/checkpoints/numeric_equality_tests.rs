use super::{InputState, InputStatePatch, StateStore};
use serde_json::{json, Value};

fn state(number: &str) -> InputState {
    InputState::new().with_extra(serde_json::from_str::<Value>(&format!(
        r#"{{"identity":{{"generation":{number}}},"samples":[{number}],"unchanged":"preserved"}}"#
    )).unwrap())
}

#[test]
fn public_input_state_distinguishes_adjacent_large_signed_and_unsigned_integers() {
    for (left, right) in [
        ("9007199254740992", "9007199254740993"),
        ("-9007199254740992", "-9007199254740993"),
        ("18446744073709551614", "18446744073709551615"),
        ("-9223372036854775808", "-9223372036854775807"),
    ] {
        let a = state(left);
        let b = state(right);
        assert_ne!(
            a, b,
            "distinct integer generations must not share an equality class: {left}/{right}"
        );
        assert_ne!(b, a, "equality must remain symmetric");
        assert_eq!(a, a.clone());
        let extra = a.extra().unwrap();
        assert_eq!(extra["identity"]["generation"].to_string(), left);
    }
}

#[test]
fn mixed_number_representations_equal_only_for_the_same_exact_mathematical_value() {
    for (left, right) in [
        ("1", "1.0"),
        ("-1", "-1.0"),
        ("0", "-0.0"),
        ("9007199254740992", "9007199254740992.0"),
        ("-9223372036854775808", "-9223372036854775808.0"),
        ("1.25", "1.25"),
        ("1e20", "100000000000000000000.0"),
    ] {
        assert_eq!(
            state(left),
            state(right),
            "{left} and {right} represent the same value"
        );
        assert_eq!(state(right), state(left));
    }
    for (left, right) in [
        ("9007199254740993", "9007199254740992.0"),
        ("-9007199254740993", "-9007199254740992.0"),
        ("18446744073709551615", "18446744073709551616.0"),
        ("9223372036854775807", "9223372036854775808.0"),
        ("-9223372036854775807", "-9223372036854775808.0"),
        ("1", "1.25"),
        ("-1", "-1.25"),
        ("1.25", "1.5"),
    ] {
        assert_ne!(
            state(left),
            state(right),
            "rounding must not equate {left} and {right}"
        );
        assert_ne!(state(right), state(left));
    }
}

#[tokio::test]
async fn actual_store_set_update_and_reload_preserve_large_extra_integer_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let store = StateStore::new(&path);
    let first = InputState::new().with_extra(json!({"generation":9007199254740992u64,"keep":true}));
    store.set("native", first.clone());
    let first_revision = store.revision();
    store.save().await.unwrap();
    store.update(
        "native",
        InputStatePatch {
            extra: Some(json!({"generation":9007199254740993u64})),
            ..Default::default()
        },
    );
    assert_eq!(
        store.revision(),
        first_revision + 1,
        "set/update are unconditional progress mutations"
    );
    let changed = store.get("native");
    assert_ne!(first, changed);
    assert_eq!(
        changed.extra().unwrap()["generation"].as_u64(),
        Some(9007199254740993)
    );
    store.save().await.unwrap();
    let disk: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        disk["native"]["extra"]["generation"].as_u64(),
        Some(9007199254740993)
    );
    assert_eq!(disk["native"]["extra"]["keep"], true);
    let fresh = StateStore::new(&path);
    fresh.load().await;
    assert_eq!(fresh.get("native"), changed);
    assert_ne!(fresh.get("native"), first);
    assert_eq!(
        fresh.get("native").extra().unwrap()["generation"].as_u64(),
        Some(9007199254740993)
    );
}
