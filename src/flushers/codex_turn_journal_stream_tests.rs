//! Main d1bc bounded Codex journal contracts through the production file reader.
use super::*;
use serde_json::json;

fn record(id: &str, content: &str) -> AgentActivityEntry {
    serde_json::from_value(json!({
        "event.id":id,"event.name":"gen_ai.model.request","time_unix_nano":"1000000",
        "user.id":"user-1","gen_ai.agent.type":"codex","gen_ai.session.id":"session",
        "gen_ai.turn.id":"turn","gen_ai.input.messages":content
    }))
    .unwrap()
}

async fn batches(journal: &Arc<CodexTurnJournal>) -> Vec<CodexJournalBatch> {
    let mut replay = journal.load_batches(None).await.unwrap();
    let mut all = Vec::new();
    while let Some(batch) = replay.next_batch().await.unwrap() {
        all.push(batch);
    }
    all
}

#[tokio::test]
async fn main_541_streams_bounded_batches_and_deduplicates_ids_across_batch_boundaries() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let first = record("large-a", &"x".repeat(600 * 1024));
        let second = record("large-b", &"y".repeat(600 * 1024));
        journal
            .append(&[first.clone(), second.clone(), first.clone()])
            .await
            .unwrap();
        let all = batches(&journal).await;
        assert_eq!(all.len(), 2);
        assert_eq!(
            all.iter().map(|batch| batch.last).collect::<Vec<_>>(),
            [false, true]
        );
        assert_eq!(all[0].entries.as_slice(), std::slice::from_ref(&first));
        assert_eq!(all[1].entries.as_slice(), std::slice::from_ref(&second));
        let key = codex_turn_journal_group_key(&first);
        assert!(all.iter().all(|batch| batch.key == key));
        let mut compatibility = journal.load(None).await.unwrap();
        assert_eq!(
            compatibility.next_group().await.unwrap(),
            Some(vec![first, second])
        );
        assert!(compatibility.next_group().await.unwrap().is_none());
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_batch_limit_counts_utf8_bytes_and_preserves_an_indivisible_oversized_event() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let first = record("unicode-a", &"界".repeat(200 * 1024));
        let second = record("unicode-b", &"界".repeat(200 * 1024));
        let oversized = record("oversized", &"x".repeat(2 * 1024 * 1024));
        let small = record("small", "tail");
        let expected = [first, second, oversized, small];
        journal.append(&expected).await.unwrap();
        let all = batches(&journal).await;
        assert_eq!(
            all.len(),
            4,
            "UTF-8 bytes, not Unicode scalar count, bound each batch"
        );
        assert_eq!(
            all.iter().map(|batch| batch.last).collect::<Vec<_>>(),
            [false, false, false, true]
        );
        for (batch, entry) in all.iter().zip(expected) {
            assert_eq!(batch.entries, [entry]);
        }
        assert!(serde_json::to_vec(&all[2].entries[0]).unwrap().len() > JOURNAL_BATCH_BYTES);
        assert!(all
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != 2)
            .all(|(_, batch)| {
                batch
                    .entries
                    .iter()
                    .map(|entry| serde_json::to_vec(entry).unwrap().len())
                    .sum::<usize>()
                    <= JOURNAL_BATCH_BYTES
            }));
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_replay_and_append_repair_ignore_a_tail_larger_than_two_scan_chunks() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let first = record("first", "complete");
        let second = record("second", "after repair");
        let key = codex_turn_journal_group_key(&first);
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let complete = format!("{}\r\n", serde_json::to_string(&first).unwrap());
        let mut bytes = complete.as_bytes().to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 2 * JOURNAL_SCAN_BYTES + 17));
        tokio::fs::write(journal.file(&key), &bytes).await.unwrap();
        let all = batches(&journal).await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].entries.as_slice(), std::slice::from_ref(&first));
        assert!(all[0].last);
        assert_eq!(
            tokio::fs::read(journal.file(&key)).await.unwrap(),
            bytes,
            "replay is read-only"
        );
        journal.append(std::slice::from_ref(&second)).await.unwrap();
        let expected = format!("{complete}{}\n", serde_json::to_string(&second).unwrap());
        assert_eq!(
            tokio::fs::read(journal.file(&key)).await.unwrap(),
            expected.as_bytes()
        );
        let all = batches(&journal).await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].entries, [first, second]);
        assert!(all[0].last);
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_reader_keeps_its_committed_snapshot_and_reopens_new_events_independently() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let first = record("first", &"x".repeat(600 * 1024));
        let second = record("second", &"y".repeat(600 * 1024));
        let third = record("third", &"z".repeat(600 * 1024));
        journal
            .append(&[first.clone(), second.clone()])
            .await
            .unwrap();
        let mut replay = journal.load_batches(None).await.unwrap();
        let batch = replay.next_batch().await.unwrap().unwrap();
        assert_eq!(batch.entries.as_slice(), std::slice::from_ref(&first));
        assert!(!batch.last);
        journal.append(std::slice::from_ref(&third)).await.unwrap();
        let batch = replay.next_batch().await.unwrap().unwrap();
        assert_eq!(batch.entries.as_slice(), std::slice::from_ref(&second));
        assert!(batch.last);
        assert!(replay.next_batch().await.unwrap().is_none());
        let all = batches(&journal).await;
        assert_eq!(
            all.into_iter()
                .flat_map(|batch| batch.entries)
                .collect::<Vec<_>>(),
            [first, second, third]
        );
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_reader_finishes_invalid_complete_files_but_skips_empty_and_truncated_only_files()
{
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let first = record("first", "");
        let key = codex_turn_journal_group_key(&first);
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        tokio::fs::write(journal.file(&key), b"{invalid}\n")
            .await
            .unwrap();
        let all = batches(&journal).await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].key, key);
        assert!(all[0].entries.is_empty() && all[0].last);
        let mut compatibility = journal.load(None).await.unwrap();
        assert!(compatibility.next_group().await.unwrap().is_none());
        for bytes in [b"".as_slice(), b"{incomplete}".as_slice()] {
            tokio::fs::write(journal.file(&key), bytes).await.unwrap();
            assert!(batches(&journal).await.is_empty());
        }
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_reader_propagates_storage_errors_without_acknowledging_or_removing_the_turn() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let first = record("first", "");
        let key = codex_turn_journal_group_key(&first);
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        journal.append(std::slice::from_ref(&first)).await.unwrap();
        let mut replay = journal.load_batches(None).await.unwrap();
        tokio::fs::remove_file(journal.file(&key)).await.unwrap();
        tokio::fs::create_dir(journal.file(&key)).await.unwrap();
        assert!(replay.next_batch().await.is_err());
        assert!(journal.file(&key).is_dir());
        assert!(!journal.is_acknowledged(&first).await.unwrap());
        tokio::fs::remove_dir(journal.file(&key)).await.unwrap();
        tokio::fs::write(
            journal.file(&key),
            format!("{}\n", serde_json::to_string(&first).unwrap()),
        )
        .await
        .unwrap();
        let all = batches(&journal).await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].entries, [first]);
    })
    .await
    .expect("source main 15s journal contract budget");
}

#[tokio::test]
async fn streamed_last_batch_closes_before_acknowledgement_and_reopen_with_the_iterator_still_alive(
) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let journal = Arc::new(CodexTurnJournal::new(root.path()));
        let first = record("first", "complete");
        journal.append(std::slice::from_ref(&first)).await.unwrap();
        let key = codex_turn_journal_group_key(&first);
        let mut replay = journal.load_batches(Some(&key)).await.unwrap();
        let batch = replay.next_batch().await.unwrap().unwrap();
        assert_eq!(batch.entries.as_slice(), std::slice::from_ref(&first));
        assert!(batch.last);
        // On Windows the completed reader must not prevent ACK publication/deletion
        // or a fresh reader while the outer iterator is deliberately still alive.
        journal
            .acknowledge(std::slice::from_ref(&first))
            .await
            .unwrap();
        assert!(!journal.file(&key).exists());
        assert!(journal.done_file(&key).is_file());
        let fresh = Arc::new(CodexTurnJournal::new(root.path()));
        assert!(fresh.is_acknowledged(&first).await.unwrap());
        assert!(fresh
            .load_batches(Some(&key))
            .await
            .unwrap()
            .next_batch()
            .await
            .unwrap()
            .is_none());
        assert!(replay.next_batch().await.unwrap().is_none());
    })
    .await
    .expect("source main 15s journal contract budget");
}
