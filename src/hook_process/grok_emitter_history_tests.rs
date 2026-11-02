//! Historical shared chain contracts, against the native Grok production chain.
use super::*;
use serde_json::json;
fn hex32(value: &str) {
    assert_eq!(value.len(), 32);
    assert!(value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}
#[test]
fn emitter_initial_hash_is_thirty_two_hex_characters() {
    hex32(&initial_hash());
}
#[test]
fn emitter_hash_step_is_deterministic() {
    let message = json!({"role":"user","content":"hi"});
    let first = hash_step(&initial_hash(), &message);
    assert_eq!(first, hash_step(&initial_hash(), &message));
    hex32(&first);
}
#[test]
fn emitter_hash_changes_with_message_content() {
    assert_ne!(
        hash_step(&initial_hash(), &json!({"role":"user","content":"hi"})),
        hash_step(&initial_hash(), &json!({"role":"user","content":"bye"}))
    );
}
#[test]
fn emitter_compute_hash_matches_step_by_step_accumulation() {
    let messages = [
        json!({"role":"user","content":"a"}),
        json!({"role":"user","content":"b"}),
    ];
    assert_eq!(
        compute_hash(&initial_hash(), &messages),
        hash_step(&hash_step(&initial_hash(), &messages[0]), &messages[1])
    );
}
#[test]
fn emitter_broken_chain_requests_full_messages() {
    assert!(should_log_full_messages(
        &initial_hash(),
        &[json!({"role":"user","content":"x"})],
        "fakehash"
    ));
}
#[test]
fn emitter_consistent_chain_keeps_only_delta_messages() {
    let messages = [json!({"role":"user","content":"x"})];
    assert!(!should_log_full_messages(
        &initial_hash(),
        &messages,
        &compute_hash(&initial_hash(), &messages)
    ));
}
