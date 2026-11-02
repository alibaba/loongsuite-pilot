//! Exact f84 assertions missing from the existing journal native contracts.
use super::*;
use crate::normalization::build_agent_activity_entry;
use serde_json::json;
fn entry(id: &str, turn: &str) -> AgentActivityEntry {
    build_agent_activity_entry(&json!({
        "event.id":id,"event.name":"llm.request","user.id":"user-1",
        "gen_ai.agent.type":"codex","gen_ai.session.id":"child-session",
        "gen_ai.turn.id":turn,"gen_ai.agent.parent.invocation.id":"incoming"
    }))
}
async fn read(journal: &Arc<CodexTurnJournal>) -> Vec<Vec<AgentActivityEntry>> {
    let mut replay = journal.load(None).await.unwrap();
    let mut groups = Vec::new();
    while let Some(group) = replay.next_group().await.unwrap() {
        groups.push(group);
    }
    groups
}
#[tokio::test]
async fn main_l26_all_concurrently_written_group_filenames_are_owned_sha256_jsonl_files() {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(CodexTurnJournal::new(root.path()));
    let mut records = vec![
        entry("a", "child-turn"),
        entry("b", "child-turn"),
        entry("c", "turn-2"),
        entry("d", "child-turn"),
        entry("e", "child-turn"),
    ];
    records[3].session_id = "session-2".into();
    records[4].user_id = "user-2".into();
    let (a, b) = tokio::join!(journal.append(&records), journal.append(&records[..1]));
    a.unwrap();
    b.unwrap();
    let restarted = Arc::new(CodexTurnJournal::new(root.path()));
    let groups = read(&restarted).await;
    assert_eq!(groups.len(), 4);
    let mut all: Vec<_> = groups.into_iter().flatten().collect();
    all.sort_by(|a, b| a.event_id.cmp(&b.event_id));
    assert_eq!(all, records);
    let pattern = regex::Regex::new(r"^codex-turn-[a-f0-9]{64}\.jsonl$").unwrap();
    for file in std::fs::read_dir(root.path()).unwrap() {
        assert!(pattern.is_match(file.unwrap().file_name().to_str().unwrap()));
    }
}
#[tokio::test]
async fn main_private_pending_permissions_and_both_remove_forms_preserve_the_other_group_and_absent_directory(
) {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(CodexTurnJournal::new(root.path()));
    let first = entry("first", "child-turn");
    let second = entry("second", "another-turn");
    journal
        .append(&[first.clone(), second.clone()])
        .await
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(journal.file(&codex_turn_journal_group_key(&first)))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    journal
        .remove_entries(std::slice::from_ref(&first))
        .await
        .unwrap();
    assert_eq!(read(&journal).await, vec![vec![second.clone()]]);
    journal
        .remove_key(&codex_turn_journal_group_key(&second))
        .await
        .unwrap();
    journal.remove_key("../unrelated").await.unwrap();
    assert!(read(&journal).await.is_empty());
    journal.append(std::slice::from_ref(&first)).await.unwrap();
    assert_eq!(read(&journal).await, vec![vec![first]]);
    let absent = Arc::new(CodexTurnJournal::new(root.path().join("absent")));
    assert!(read(&absent).await.is_empty());
    assert!(!root.path().join("absent").exists());
}
