use crate::types::AgentActivityEntry;
use indexmap::IndexMap;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TRACKED_TURNS: usize = 4_096;
const STATE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_FINISH_REASONS: &[&str] = &["stop", "end_turn", "cancelled", "error"];

#[derive(Clone)]
struct TrackedTurn {
    started: bool,
    ended: bool,
    updated_at: i64,
}

/// Fill-only turn boundary enrichment shared by every canonical agent input.
///
/// The processor mutates only `gen_ai.turn.start` and `gen_ai.turn.end`.
/// Existing markers stay authoritative, records are never reordered or
/// synthesized, and records without a turn id are left untouched.
pub struct TurnBoundaryProcessor {
    // Updating an existing key retains its insertion order, matching JavaScript Map.
    turns: IndexMap<String, TrackedTurn>,
}

impl TurnBoundaryProcessor {
    pub fn new() -> Self {
        Self {
            turns: IndexMap::new(),
        }
    }

    pub fn enrich(&mut self, entries: &mut [AgentActivityEntry]) {
        if entries.is_empty() {
            return;
        }

        let mut order = Vec::new();
        let mut grouped: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            if (is_subagent(entry) && !is_codex(entry))
                || matches!(
                    entry.event_name,
                    Some(
                        crate::types::AgentEventName::AgentInvoke
                            | crate::types::AgentEventName::AgentResult
                    )
                )
            {
                continue;
            }
            let Some(key) = turn_key(entry) else {
                continue;
            };
            match grouped.entry(key.clone()) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    order.push(key);
                    slot.insert(vec![index]);
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    slot.get_mut().push(index);
                }
            }
        }
        if grouped.is_empty() {
            return;
        }

        let now = now_millis();
        for key in order {
            let Some(indices) = grouped.get(&key) else {
                continue;
            };
            let mut tracked = self.turns.get(&key).cloned().unwrap_or(TrackedTurn {
                started: false,
                ended: false,
                updated_at: now,
            });

            // Inspect the whole batch before filling. Producers such as WorkBuddy
            // put an existing start marker on llm.request rather than the first
            // record; a single-pass fill would create a duplicate marker.
            if indices
                .iter()
                .any(|index| entries[*index].turn_start.is_some())
            {
                tracked.started = true;
            }
            if indices
                .iter()
                .any(|index| entries[*index].turn_end.is_some())
            {
                tracked.ended = true;
            }

            // Codex persists its native prompt marker with the input cursor.
            // A fresh processor may see a restored suffix, not a new turn.
            let codex_turn = indices
                .first()
                .is_some_and(|index| is_codex(&entries[*index]));
            if !tracked.started && !codex_turn {
                if let Some(first) = indices.first().copied() {
                    entries[first].turn_start = Some(true);
                    tracked.started = true;
                }
            }

            if !tracked.ended {
                if let Some(terminal) = indices
                    .iter()
                    .rev()
                    .copied()
                    .find(|index| is_terminal_turn_entry(&entries[*index]))
                {
                    entries[terminal].turn_end = Some(true);
                    tracked.ended = true;
                }
            }

            tracked.updated_at = now;
            self.turns.insert(key, tracked);
        }

        self.compact(now);
    }

    fn compact(&mut self, now: i64) {
        self.turns
            .retain(|_, tracked| now - tracked.updated_at <= STATE_TTL_MS);
        let overflow = self.turns.len().saturating_sub(MAX_TRACKED_TURNS);
        if overflow == 0 {
            return;
        }

        // At equal timestamps, the earliest insertion is evicted first.
        let mut ranked: Vec<_> = self
            .turns
            .values()
            .enumerate()
            .map(|(index, turn)| (turn.updated_at, index))
            .collect();
        let (_, cutoff, _) = ranked.select_nth_unstable(overflow);
        let cutoff = *cutoff;
        let mut index = 0;
        self.turns.retain(|_, turn| {
            let keep = (turn.updated_at, index) >= cutoff;
            index += 1;
            keep
        });
    }
}

impl Default for TurnBoundaryProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Agent-aware terminal signal used only for additive boundary enrichment.
pub fn is_terminal_turn_entry(entry: &AgentActivityEntry) -> bool {
    if is_subagent(entry) && !is_codex(entry) {
        return false;
    }
    if entry.turn_end == Some(true) {
        return true;
    }

    let agent_type = normalize_agent_type(non_empty(Some(entry.agent_type.as_str())).unwrap_or(""));
    if agent_type == "hermes" && extra_str(entry, "agent.hermes.collection") == Some("realtime-v1")
    {
        // An individual API stop or error is not the end of a retry/tool turn.
        // The incremental producer owns the explicit lifecycle marker, even when
        // the response and marker arrive in different input batches.
        return false;
    }
    if agent_type == "codex" {
        // Aborted status is stamped on every Codex record. Only its explicit
        // native terminal marker closes a turn across input batches.
        return false;
    }
    if agent_type == "openclaw" {
        return extra_str(entry, "agent.openclaw.collection") != Some("cron-lifecycle-v1")
            && extra_str(entry, "agent.openclaw.hook") == Some("llm_output");
    }

    entry.finish_reasons.as_ref().is_some_and(|reasons| {
        reasons
            .iter()
            .any(|reason| TERMINAL_FINISH_REASONS.contains(&reason.as_str()))
    })
}

fn turn_key(entry: &AgentActivityEntry) -> Option<String> {
    let turn_id = non_empty(entry.turn_id.as_deref())?;
    let agent_type =
        normalize_agent_type(non_empty(Some(entry.agent_type.as_str())).unwrap_or("unknown"));
    let session_id = non_empty(Some(entry.session_id.as_str())).unwrap_or("");
    if agent_type == "hermes" {
        return serde_json::to_string(&(agent_type, &entry.user_id, session_id, turn_id)).ok();
    }
    Some(format!("{agent_type}\u{0000}{session_id}\u{0000}{turn_id}"))
}

fn is_codex(entry: &AgentActivityEntry) -> bool {
    normalize_agent_type(entry.agent_type.as_str()) == "codex"
}

fn is_subagent(entry: &AgentActivityEntry) -> bool {
    extra_str(entry, "gen_ai.agent.scope") == Some("subagent")
}

fn extra_str<'a>(entry: &'a AgentActivityEntry, key: &str) -> Option<&'a str> {
    entry.extra.get(key).and_then(serde_json::Value::as_str)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// Same shape as `src/utils/agent-type-normalize.ts`, kept local so this module
/// does not import `crate::utils`.
fn normalize_agent_type(raw: &str) -> String {
    let mut normalized = String::new();
    let mut pending_dash = false;
    let mut started = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            if pending_dash && started {
                normalized.push('-');
            }
            pending_dash = false;
            started = true;
            normalized.push(lower);
        } else if started {
            pending_dash = true;
        }
    }
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalization::build_test_entry;
    use crate::types::AgentActivityEntry;
    use serde_json::{json, Value};

    fn entry(event_id: &str, event_name: &str, extra: Value) -> AgentActivityEntry {
        let mut base = json!({
            "event.id": event_id,
            "event.name": event_name,
            "gen_ai.turn.id": "turn-1"
        });
        if let (Some(base_map), Some(extra_map)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in extra_map {
                base_map.insert(key.clone(), value.clone());
            }
        }
        build_test_entry(&base)
    }

    fn without_boundaries(mut value: AgentActivityEntry) -> AgentActivityEntry {
        value.turn_start = None;
        value.turn_end = None;
        value
    }

    #[test]
    fn waits_for_the_incremental_hermes_end_marker_across_batches() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut request = entry(
            "request",
            "llm.request",
            json!({
                "gen_ai.agent.type": "hermes",
                "agent.hermes.collection": "realtime-v1"
            }),
        );
        let mut error = entry(
            "retry",
            "llm.response",
            json!({
                "gen_ai.agent.type": "hermes",
                "agent.hermes.collection": "realtime-v1",
                "gen_ai.response.finish_reasons": ["error"]
            }),
        );
        let mut stop = entry(
            "stop",
            "llm.response",
            json!({
                "gen_ai.agent.type": "hermes",
                "agent.hermes.collection": "realtime-v1",
                "gen_ai.response.finish_reasons": ["stop"]
            }),
        );
        let mut terminal = entry(
            "end",
            "other",
            json!({
                "gen_ai.agent.type": "hermes",
                "agent.hermes.collection": "realtime-v1",
                "gen_ai.turn.end": true
            }),
        );
        for value in [&mut request, &mut error, &mut stop, &mut terminal] {
            processor.enrich(std::slice::from_mut(value));
        }
        assert_eq!(request.turn_start, Some(true));
        assert_eq!(error.turn_end, None);
        assert_eq!(stop.turn_end, None);
        assert_eq!(terminal.turn_end, Some(true));
        let ended = [&request, &error, &stop, &terminal]
            .iter()
            .filter(|value| value.turn_end == Some(true))
            .count();
        assert_eq!(ended, 1);
    }

    #[test]
    fn fills_the_default_lifecycle_for_registered_agent_types() {
        for agent_type in [
            "qoder",
            "qoder-cn",
            "qoder-idea",
            "qoder-cli",
            "qoder-work",
            "qoder-work-cn",
            "qwen-work-cn",
            "cursor",
            "cursor-cli",
            "claude-code",
            "kiro-cli",
            "opencode",
            "pi-coding-agent",
            "mimo-code",
            "qwen-code-cli",
            "hermes",
            "wukong",
            "workbuddy",
        ] {
            let mut entries = vec![
                entry(
                    &format!("{agent_type}-request"),
                    "llm.request",
                    json!({ "gen_ai.agent.type": agent_type }),
                ),
                entry(
                    &format!("{agent_type}-response"),
                    "llm.response",
                    json!({
                        "gen_ai.agent.type": agent_type,
                        "gen_ai.response.finish_reasons": ["stop"]
                    }),
                ),
            ];
            TurnBoundaryProcessor::new().enrich(&mut entries);
            assert_eq!(entries[0].turn_start, Some(true), "{agent_type}");
            assert_eq!(entries[1].turn_end, Some(true), "{agent_type}");
        }
    }

    #[test]
    fn adds_one_start_and_one_end_without_changing_existing_event_data() {
        let mut entries = vec![
            entry("prompt", "other", json!({})),
            entry(
                "request",
                "llm.request",
                json!({ "gen_ai.step.id": "turn-1:s1" }),
            ),
            entry(
                "response",
                "llm.response",
                json!({
                    "gen_ai.step.id": "turn-1:s1",
                    "gen_ai.response.finish_reasons": ["stop"]
                }),
            ),
        ];
        let before = entries.clone();
        TurnBoundaryProcessor::new().enrich(&mut entries);
        assert_eq!(entries[0].turn_start, Some(true));
        assert_eq!(entries[2].turn_end, Some(true));
        assert_eq!(
            entries
                .iter()
                .filter(|item| item.turn_start == Some(true))
                .count(),
            1
        );
        assert_eq!(
            entries
                .iter()
                .filter(|item| item.turn_end == Some(true))
                .count(),
            1
        );
        let actual: Vec<_> = entries.into_iter().map(without_boundaries).collect();
        let expected: Vec<_> = before.into_iter().map(without_boundaries).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn keeps_producer_owned_boundary_placement_unchanged() {
        let mut entries = vec![
            entry("prompt", "other", json!({})),
            entry(
                "request",
                "llm.request",
                json!({ "gen_ai.turn.start": true }),
            ),
            entry(
                "response",
                "llm.response",
                json!({
                    "gen_ai.response.finish_reasons": ["stop"],
                    "gen_ai.turn.end": true
                }),
            ),
        ];
        let before = entries.clone();
        TurnBoundaryProcessor::new().enrich(&mut entries);
        assert_eq!(entries, before);
    }

    #[test]
    fn never_overwrites_producer_owned_boundary_fields() {
        let mut entries = vec![entry(
            "producer-entry",
            "other",
            json!({ "gen_ai.turn.start": false, "gen_ai.turn.end": false }),
        )];
        let before = entries.clone();
        TurnBoundaryProcessor::new().enrich(&mut entries);
        assert_eq!(entries, before);
    }

    #[test]
    fn tracks_one_turn_across_batches_and_marks_only_its_real_terminal_batch() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut first = vec![entry("request", "llm.request", json!({}))];
        let mut middle = vec![entry("tool", "tool.result", json!({}))];
        let mut last = vec![entry(
            "response",
            "llm.response",
            json!({ "gen_ai.response.finish_reasons": ["end_turn"] }),
        )];
        processor.enrich(&mut first);
        processor.enrich(&mut middle);
        processor.enrich(&mut last);
        assert_eq!(first[0].turn_start, Some(true));
        assert_eq!(middle[0].turn_start, None);
        assert_eq!(middle[0].turn_end, None);
        assert_eq!(last[0].turn_start, None);
        assert_eq!(last[0].turn_end, Some(true));
    }

    #[test]
    fn marks_every_turn_independently_when_one_batch_contains_multiple_turns() {
        let mut entries = vec![
            entry("turn-1-request", "llm.request", json!({})),
            entry(
                "turn-1-response",
                "llm.response",
                json!({ "gen_ai.response.finish_reasons": ["stop"] }),
            ),
            entry(
                "turn-2-request",
                "llm.request",
                json!({ "gen_ai.turn.id": "turn-2" }),
            ),
            entry(
                "turn-2-response",
                "llm.response",
                json!({
                    "gen_ai.turn.id": "turn-2",
                    "gen_ai.response.finish_reasons": ["end_turn"]
                }),
            ),
        ];
        TurnBoundaryProcessor::new().enrich(&mut entries);
        let starts: Vec<_> = entries
            .iter()
            .filter(|item| item.turn_start == Some(true))
            .map(|item| item.event_id.as_str())
            .collect();
        let ends: Vec<_> = entries
            .iter()
            .filter(|item| item.turn_end == Some(true))
            .map(|item| item.event_id.as_str())
            .collect();
        assert_eq!(starts, vec!["turn-1-request", "turn-2-request"]);
        assert_eq!(ends, vec!["turn-1-response", "turn-2-response"]);
    }

    #[test]
    fn accepts_a_repeated_start_after_a_fresh_processor_is_created() {
        let mut first = vec![entry("request", "llm.request", json!({}))];
        TurnBoundaryProcessor::new().enrich(&mut first);
        let mut last = vec![entry(
            "response",
            "llm.response",
            json!({ "gen_ai.response.finish_reasons": ["stop"] }),
        )];
        TurnBoundaryProcessor::new().enrich(&mut last);
        assert_eq!(first[0].turn_start, Some(true));
        assert_eq!(last[0].turn_start, Some(true));
        assert_eq!(last[0].turn_end, Some(true));
    }

    #[test]
    fn bounds_process_local_tracking_by_evicting_the_oldest_observed_turn() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut initial = (0..4_097)
            .map(|index| {
                entry(
                    &format!("request-{index}"),
                    "llm.request",
                    json!({ "gen_ai.turn.id": format!("turn-{index}") }),
                )
            })
            .collect::<Vec<_>>();
        processor.enrich(&mut initial);

        let mut evicted = vec![entry(
            "request-evicted",
            "llm.request",
            json!({ "gen_ai.turn.id": "turn-0" }),
        )];
        let mut retained = vec![entry(
            "request-retained",
            "llm.request",
            json!({ "gen_ai.turn.id": "turn-4096" }),
        )];
        processor.enrich(&mut evicted);
        processor.enrich(&mut retained);
        assert_eq!(evicted[0].turn_start, Some(true));
        assert_eq!(retained[0].turn_start, None);
    }

    #[test]
    fn uses_llm_output_rather_than_per_call_stop_as_the_openclaw_end() {
        let mut entries = vec![
            entry(
                "response",
                "llm.response",
                json!({
                    "gen_ai.agent.type": "openclaw",
                    "gen_ai.response.finish_reasons": ["stop"]
                }),
            ),
            entry(
                "terminal",
                "other",
                json!({
                    "gen_ai.agent.type": "openclaw",
                    "agent.openclaw.hook": "llm_output"
                }),
            ),
        ];
        TurnBoundaryProcessor::new().enrich(&mut entries);
        assert_eq!(entries[0].turn_start, Some(true));
        assert_eq!(entries[0].turn_end, None);
        assert_eq!(entries[1].turn_end, Some(true));
    }

    #[test]
    fn uses_codex_turn_status_rather_than_a_model_wave_stop_as_the_end() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut response = vec![entry(
            "response",
            "llm.response",
            json!({
                "gen_ai.agent.type": "codex",
                "gen_ai.response.finish_reasons": ["stop"]
            }),
        )];
        let mut terminal = vec![entry(
            "terminal",
            "other",
            json!({
                "gen_ai.agent.type": "codex",
                "agent.codex.turn_status": "completed",
                "gen_ai.turn.end": true
            }),
        )];
        processor.enrich(&mut response);
        processor.enrich(&mut terminal);
        // main explicitly supersedes status-inferred end and synthetic Codex start.
        assert_eq!(response[0].turn_start, None);
        assert_eq!(response[0].turn_end, None);
        assert_eq!(terminal[0].turn_start, None);
        assert_eq!(terminal[0].turn_end, Some(true));
    }

    #[test]
    fn does_not_let_a_fused_subagent_create_parent_turn_boundaries() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut child = vec![entry(
            "child-response",
            "llm.response",
            json!({
                "gen_ai.agent.type": "codex",
                "gen_ai.agent.scope": "subagent",
                "gen_ai.session.id": "child-session",
                "gen_ai.turn.id": "child-session:turn",
                "gen_ai.response.finish_reasons": ["stop"]
            }),
        )];
        let mut root = vec![entry(
            "root-terminal",
            "other",
            json!({
                "gen_ai.agent.type": "codex",
                "agent.codex.turn_status": "completed",
                "gen_ai.turn.end": true
            }),
        )];
        processor.enrich(&mut child);
        processor.enrich(&mut root);
        assert_eq!(child[0].turn_start, None);
        assert_eq!(child[0].turn_end, None);
        // main lets the child own native boundaries independently of the root.
        assert_eq!(root[0].turn_start, None);
        assert_eq!(root[0].turn_end, Some(true));
    }

    #[test]
    fn does_not_repeat_end_for_duplicate_terminal_signals() {
        let mut processor = TurnBoundaryProcessor::new();
        let mut first = vec![entry(
            "terminal-1",
            "llm.response",
            json!({ "gen_ai.response.finish_reasons": ["error"] }),
        )];
        let mut duplicate = vec![entry(
            "terminal-2",
            "llm.response",
            json!({ "gen_ai.response.finish_reasons": ["error"] }),
        )];
        processor.enrich(&mut first);
        processor.enrich(&mut duplicate);
        assert_eq!(first[0].turn_start, Some(true));
        assert_eq!(first[0].turn_end, Some(true));
        assert_eq!(duplicate[0].turn_start, None);
        assert_eq!(duplicate[0].turn_end, None);
    }

    #[test]
    fn tracks_equal_turn_ids_independently_across_sessions() {
        let mut entries = vec![
            entry(
                "a",
                "llm.request",
                json!({ "gen_ai.session.id": "session-a" }),
            ),
            entry(
                "b",
                "llm.request",
                json!({ "gen_ai.session.id": "session-b" }),
            ),
        ];
        TurnBoundaryProcessor::new().enrich(&mut entries);
        assert_eq!(entries[0].turn_start, Some(true));
        assert_eq!(entries[1].turn_start, Some(true));
    }

    #[test]
    fn leaves_supplemental_telemetry_without_a_canonical_turn_id_untouched() {
        let mut supplemental = build_test_entry(&json!({
            "event.id": "tokens-only",
            "event.name": "llm.response",
            "gen_ai.response.finish_reasons": ["stop"]
        }));
        let before = supplemental.clone();
        TurnBoundaryProcessor::new().enrich(std::slice::from_mut(&mut supplemental));
        assert_eq!(supplemental, before);
    }

    #[test]
    fn recognizes_general_codex_and_openclaw_terminal_semantics() {
        assert!(is_terminal_turn_entry(&entry(
            "general",
            "llm.response",
            json!({ "gen_ai.response.finish_reasons": ["cancelled"] }),
        )));
        // main supersedes only the old Codex status-only clause.
        assert!(!is_terminal_turn_entry(&entry(
            "codex",
            "other",
            json!({
                "gen_ai.agent.type": "codex",
                "agent.codex.turn_status": "interrupted"
            }),
        )));
        assert!(is_terminal_turn_entry(&entry(
            "codex-native-terminal",
            "other",
            json!({"gen_ai.agent.type":"codex","gen_ai.turn.end":true}),
        )));
        assert!(is_terminal_turn_entry(&entry(
            "openclaw",
            "other",
            json!({
                "gen_ai.agent.type": "openclaw",
                "agent.openclaw.hook": "llm_output"
            }),
        )));
    }

    #[test]
    fn compacts_turns_by_ttl_and_preserves_insertion_order_for_timestamp_ties() {
        let mut processor = TurnBoundaryProcessor::new();
        let now = STATE_TTL_MS + 10;
        for (key, updated_at) in [
            ("expired", now - STATE_TTL_MS - 1),
            ("updated", now - STATE_TTL_MS - 1),
            ("ttl-edge", now - STATE_TTL_MS),
            ("first-tie", now - STATE_TTL_MS + 1),
            ("second-tie", now - STATE_TTL_MS + 1),
        ] {
            processor.turns.insert(
                key.to_owned(),
                TrackedTurn {
                    started: true,
                    ended: false,
                    updated_at,
                },
            );
        }
        processor.turns["updated"].updated_at = now;
        processor.compact(now);
        assert!(!processor.turns.contains_key("expired"));
        assert!(processor.turns.contains_key("ttl-edge"));

        for index in 0..MAX_TRACKED_TURNS - 2 {
            processor.turns.insert(
                format!("new-{index}"),
                TrackedTurn {
                    started: false,
                    ended: false,
                    updated_at: now,
                },
            );
        }
        processor.compact(now);
        assert_eq!(processor.turns.len(), MAX_TRACKED_TURNS);
        assert!(!processor.turns.contains_key("ttl-edge"));
        assert!(!processor.turns.contains_key("first-tie"));
        assert!(processor.turns["updated"].started);
        assert_eq!(
            processor
                .turns
                .keys()
                .take(2)
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["updated", "second-tie"]
        );
    }

    #[test]
    fn audit_invocation_rows_cannot_claim_or_finish_a_work_turn_boundary() {
        for name in ["gen_ai.agent.invoke", "gen_ai.agent.result"] {
            let mut processor = TurnBoundaryProcessor::new();
            let mut audit = entry(
                "audit",
                name,
                json!({
                    "gen_ai.agent.type":"cursor","gen_ai.turn.id":"work","gen_ai.session.id":"session",
                    "gen_ai.response.finish_reasons":["stop"],"gen_ai.turn.end":true
                }),
            );
            let original = audit.clone();
            processor.enrich(std::slice::from_mut(&mut audit));
            assert_eq!(processor.turns.len(), 0);
            assert_eq!(audit, original);
            let mut rows = vec![
                audit,
                entry(
                    "work",
                    "gen_ai.model.request",
                    json!({
                        "gen_ai.agent.type":"cursor","gen_ai.turn.id":"work","gen_ai.session.id":"session"
                    }),
                ),
            ];
            processor.enrich(&mut rows);
            assert_eq!(rows[0], original);
            assert_eq!(rows[1].turn_start, Some(true));
            assert_eq!(rows[1].turn_end, None);
        }
    }
}
