use super::{InputState, StateStore};
use serde_json::json;

#[tokio::test]
async fn overflowing_json_offsets_preserve_other_checkpoint_state_and_reject_only_the_bad_value() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let text = r#"{
      "codex": {"lastOffset": 42, "extra": {"codexTranscript": {
        "scanOffset": 1024, "activeTurn": {"turnId": "old"},
        "pendingTerminal": {"turnId": "old", "terminalEndOffset": 1e309}
      }}},
      "other": {"lastOffset": 99, "extra": {"preserved": true}}
    }"#;
    std::fs::write(&path, text).unwrap();
    let store = StateStore::new(&path);
    store.load().await;
    assert_eq!(store.get("codex").last_offset(), Some(42.0));
    let cp = store.get("codex").extra().unwrap();
    assert_eq!(cp["codexTranscript"]["scanOffset"], 1024);
    assert_eq!(cp["codexTranscript"]["activeTurn"]["turnId"], "old");
    // serde_json::Value has no non-finite number. Keep the valid state and
    // expose this unsupported number as null for the input's validity checks.
    assert!(cp["codexTranscript"]["pendingTerminal"]["terminalEndOffset"].is_null());
    assert_eq!(store.get("other").last_offset(), Some(99.0));
    assert_eq!(store.get("other").extra().unwrap()["preserved"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    assert!(
        crate::utils::json_document::parse_json_document(
            text,
            crate::utils::json_document::JsonSyntax::Json
        )
        .is_err(),
        "checkpoint recovery must not relax ordinary JSON parsing"
    );
}

#[tokio::test]
async fn overflow_recovery_preserves_strings_exact_integer_identity_and_finite_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let text = r#"{"native":{"lastOffset":7,"extra":{
        "positive":1e309,"negative":-1E+9999,
        "wide":9007199254740993,"max":18446744073709551615,
        "fraction":1.25,"underflow":1e-999,
        "label":"1e309 \"quoted -1E999\" \\ path 中文🙂",
        "array":[1e309,{"retained":true}],
        "duplicate":"first","duplicate":"last"
    }}}"#;
    std::fs::write(&path, text).unwrap();
    let store = StateStore::new(&path);
    store.load().await;
    assert_eq!(store.get("native").last_offset(), Some(7.0));
    let extra = store.get("native").extra().unwrap();
    assert!(extra["positive"].is_null());
    assert!(extra["negative"].is_null());
    assert_eq!(extra["wide"].as_u64(), Some(9007199254740993));
    assert_eq!(extra["max"].as_u64(), Some(u64::MAX));
    assert_eq!(extra["fraction"], json!(1.25));
    assert_eq!(extra["underflow"].as_f64(), Some(0.0));
    assert_eq!(extra["label"], "1e309 \"quoted -1E999\" \\ path 中文🙂");
    assert!(extra["array"][0].is_null());
    assert_eq!(extra["array"][1]["retained"], true);
    assert_eq!(extra["duplicate"], "last");
    store.set("native", store.get("native"));
    store.save().await.unwrap();
    store.load().await;
    assert_eq!(store.get("native").extra().unwrap(), extra);
}

#[tokio::test]
async fn overflow_recovery_requires_strict_valid_json_and_keeps_the_depth_limit() {
    for token in [
        "01e309",
        "+1e309",
        "NaN",
        "Infinity",
        "-Infinity",
        "1e309.0",
        "1e309e2",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            format!(r#"{{"native":{{"lastOffset":7,"extra":{{"bad":{token}}}}}}}"#),
        )
        .unwrap();
        let store = StateStore::new(&path);
        store.set("native", InputState::new().with_last_offset(8.0));
        store.load().await;
        assert!(store.get("native").last_offset().is_none(), "{token}");
    }
    for text in [
        r#"{"native":{"lastOffset":7,"extra":{"bad":1e309,}}}"#,
        r#"{"native":{"lastOffset":7,"extra":{"bad":1e309/*comment*/}}}"#,
        r#"{"native":{"lastOffset":7,"extra":{"bad":1e309}}} trailing"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, text).unwrap();
        let store = StateStore::new(&path);
        store.load().await;
        assert!(store.get("native").last_offset().is_none(), "{text}");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    let text = format!(
        r#"{{"native":{{"lastOffset":7,"extra":{}1e309{}}}}}"#,
        "[".repeat(140),
        "]".repeat(140)
    );
    std::fs::write(&path, text).unwrap();
    let store = StateStore::new(&path);
    store.load().await;
    assert!(store.get("native").last_offset().is_none());
}

#[tokio::test]
async fn overflow_recovery_accepts_bom_and_does_not_change_normal_finite_state_loading() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    for raw in [
        "\u{feff}{\"native\":{\"lastOffset\":7,\"extra\":{\"bad\":1e309,\"valid\":false}}}",
        "{\"native\":{\"lastOffset\":7,\"extra\":{\"bad\":null,\"valid\":false}}}",
    ] {
        std::fs::write(&path, raw).unwrap();
        let store = StateStore::new(&path);
        store.load().await;
        assert_eq!(store.get("native").last_offset(), Some(7.0));
        assert_eq!(
            store.get("native").extra(),
            Some(json!({"bad":null,"valid":false}))
        );
        assert_eq!(store.revision(), 0);
    }
}
