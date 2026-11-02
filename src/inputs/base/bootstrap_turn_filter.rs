//! Port of `src/inputs/base/bootstrap-turn-filter.ts`.

use crate::types::AgentActivityEntry;
use serde_json::Value;
use std::collections::HashMap;

pub fn filter_bootstrap_history_turns(entries: Vec<AgentActivityEntry>) -> Vec<AgentActivityEntry> {
    let mut latest_turn_by_batch: HashMap<String, String> = HashMap::new();
    for entry in &entries {
        if entry_str(entry, "agent.transcript.cursor_mode") != Some("bootstrap") {
            continue;
        }
        let Some(batch_id) = non_empty(entry_str(entry, "agent.transcript.cursor_batch_id")) else {
            continue;
        };
        let Some(turn_id) = non_empty(entry.turn_id.as_deref()) else {
            continue;
        };
        latest_turn_by_batch.insert(batch_id.to_owned(), turn_id.to_owned());
    }
    if latest_turn_by_batch.is_empty() {
        return entries;
    }
    entries
        .into_iter()
        .filter(|entry| {
            if entry_str(entry, "agent.transcript.cursor_mode") != Some("bootstrap") {
                return true;
            }
            let batch_id = non_empty(entry_str(entry, "agent.transcript.cursor_batch_id"));
            let turn_id = non_empty(entry.turn_id.as_deref());
            let (Some(batch_id), Some(turn_id)) = (batch_id, turn_id) else {
                return true;
            };
            latest_turn_by_batch.get(batch_id) == Some(&turn_id.to_owned())
        })
        .collect()
}

fn entry_str<'a>(entry: &'a AgentActivityEntry, key: &str) -> Option<&'a str> {
    entry.extra.get(key).and_then(Value::as_str)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

#[cfg(test)]
mod history_contracts {
    use super::*;
    use crate::normalization::build_agent_activity_entry;
    use serde_json::json;

    fn entry(id: &str, turn: &str, mode: &str, batch: Option<&str>) -> AgentActivityEntry {
        let mut entry = build_agent_activity_entry(&json!({
            "event.id":id,"event.name":"llm.response","gen_ai.agent.type":"qoder","gen_ai.turn.id":turn
        }));
        entry
            .extra
            .insert("agent.transcript.cursor_mode".into(), json!(mode));
        if let Some(batch) = batch {
            entry
                .extra
                .insert("agent.transcript.cursor_batch_id".into(), json!(batch));
        }
        entry
    }
    fn ids(entries: &[AgentActivityEntry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| entry.event_id.as_str())
            .collect()
    }

    #[test]
    fn l22_latest_bootstrap_turn_preserves_every_event_in_that_turn_and_original_order() {
        let entries = vec![
            entry("old-request", "turn-old", "bootstrap", Some("batch-a")),
            entry("old-response", "turn-old", "bootstrap", Some("batch-a")),
            entry(
                "latest-request",
                "turn-latest",
                "bootstrap",
                Some("batch-a"),
            ),
            entry(
                "latest-response",
                "turn-latest",
                "bootstrap",
                Some("batch-a"),
            ),
        ];
        let expected = entries[2..].to_vec();
        let actual = filter_bootstrap_history_turns(entries);
        assert_eq!(ids(&actual), vec!["latest-request", "latest-response"]);
        assert_eq!(actual, expected);
    }
    #[test]
    fn l36_each_invocation_batch_recovers_independently_and_incremental_entries_survive() {
        let actual = filter_bootstrap_history_turns(vec![
            entry("a-old", "a-old-turn", "bootstrap", Some("batch-a")),
            entry("a-latest", "a-latest-turn", "bootstrap", Some("batch-a")),
            entry("b-old", "b-old-turn", "bootstrap", Some("batch-b")),
            entry("b-latest", "b-latest-turn", "bootstrap", Some("batch-b")),
            entry("normal", "normal-turn", "incremental", Some("batch-c")),
        ]);
        assert_eq!(ids(&actual), vec!["a-latest", "b-latest", "normal"]);
    }
    #[test]
    fn l52_mixed_version_missing_batch_id_returns_the_exact_entries_unmodified() {
        let entries = vec![
            entry("legacy-old", "legacy-old-turn", "bootstrap", None),
            entry("legacy-new", "legacy-new-turn", "bootstrap", None),
        ];
        assert_eq!(filter_bootstrap_history_turns(entries.clone()), entries);
    }
}
