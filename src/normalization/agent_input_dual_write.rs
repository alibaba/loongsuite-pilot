use crate::types::{AgentActivityEntry, AgentEventName};
use std::collections::HashSet;

pub const AGENT_INPUT_EVENT_NAMESPACE: &str = "29afa46e-d5de-5c48-946b-90c1d0537f36";

pub fn is_input_other_event(entry: &AgentActivityEntry) -> bool {
    entry.event_name == Some(AgentEventName::Other)
        && (entry.input_messages.is_some() || entry.input_messages_delta.is_some())
}

pub fn derive_agent_input_event_id(original_event_id: &str) -> String {
    uuid_v5(
        &parse_uuid(AGENT_INPUT_EVENT_NAMESPACE),
        original_event_id.as_bytes(),
    )
}

pub fn expand_agent_input_events(entries: Vec<AgentActivityEntry>) -> Vec<AgentActivityEntry> {
    let mut existing_event_ids: HashSet<String> =
        entries.iter().map(|entry| entry.event_id.clone()).collect();
    let mut expanded = Vec::with_capacity(entries.len());

    for entry in entries {
        let should_derive = is_input_other_event(&entry);
        expanded.push(entry);
        if !should_derive {
            continue;
        }
        let source = expanded.last().expect("source entry");
        let derived_event_id = derive_agent_input_event_id(&source.event_id);
        if !existing_event_ids.insert(derived_event_id.clone()) {
            continue;
        }
        let mut derived = source.clone();
        derived.turn_start = None;
        derived.turn_end = None;
        derived.event_id = derived_event_id;
        derived.event_name = Some(AgentEventName::AgentInput);
        expanded.push(derived);
    }

    expanded
}

fn uuid_v5(namespace: &[u8; 16], name: &[u8]) -> String {
    let mut data = Vec::with_capacity(namespace.len() + name.len());
    data.extend_from_slice(namespace);
    data.extend_from_slice(name);
    let hash = sha1(&data);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(&bytes)
}

fn parse_uuid(text: &str) -> [u8; 16] {
    let hex: String = text.chars().filter(|ch| *ch != '-').collect();
    let mut out = [0u8; 16];
    for index in 0..16 {
        out[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("uuid hex");
    }
    out
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn sha1(message: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xEFCD_AB89;
    let mut h2: u32 = 0x98BA_DCFE;
    let mut h3: u32 = 0x1032_5476;
    let mut h4: u32 = 0xC3D2_E1F0;

    let bit_len = (message.len() as u64).saturating_mul(8);
    let mut data = message.to_vec();
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in data.as_chunks::<64>().0 {
        let mut words = [0u32; 80];
        for index in 0..16 {
            words[index] = u32::from_be_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalization::entry_from_map;
    use crate::types::AgentEventName;
    use regex::Regex;
    use serde_json::{json, Map, Value};
    use std::sync::LazyLock;

    static UUID_V5_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .expect("uuid v5")
    });

    fn make_entry(overrides: Value) -> AgentActivityEntry {
        let mut map = match json!({
            "time_unix_nano": "1700000000000000000",
            "event.id": "source-event",
            "event.name": "other",
            "user.id": "user-1",
            "gen_ai.session.id": "session-1",
            "gen_ai.agent.type": "codex",
            "gen_ai.provider.name": "openai"
        }) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if let Value::Object(extra) = overrides {
            for (key, value) in extra {
                map.insert(key, value);
            }
        }
        entry_from_map(map)
    }

    fn strip_derived_fields(mut entry: AgentActivityEntry) -> AgentActivityEntry {
        entry.event_id.clear();
        entry.event_name = None;
        entry.turn_start = None;
        entry.turn_end = None;
        entry
    }

    #[test]
    fn recognizes_only_other_events_with_canonical_input_fields() {
        assert!(is_input_other_event(&make_entry(json!({
            "gen_ai.input.messages": []
        }))));
        assert!(is_input_other_event(&make_entry(json!({
            "gen_ai.input.messages_delta": []
        }))));
        assert!(!is_input_other_event(&make_entry(json!({}))));
        assert!(!is_input_other_event(&make_entry(json!({
            "event.name": "llm.request",
            "gen_ai.input.messages": []
        }))));
        assert!(!is_input_other_event(&make_entry(json!({
            "event.name": "agent.input",
            "gen_ai.input.messages": []
        }))));
    }

    #[test]
    fn expands_input_other_with_messages_delta_and_empty_delta() {
        for input in [
            json!({ "gen_ai.input.messages": [{ "role": "user", "content": "hello" }] }),
            json!({ "gen_ai.input.messages_delta": [{ "role": "user", "content": "hello" }] }),
            json!({ "gen_ai.input.messages_delta": [] }),
        ] {
            let source = make_entry(input);
            let source_id = source.event_id.clone();
            let result = expand_agent_input_events(vec![source.clone()]);
            assert_eq!(result.len(), 2);
            assert_eq!(result[0], source);
            assert_eq!(result[1].event_name, Some(AgentEventName::AgentInput));
            assert_eq!(result[0].event_id, source_id);
        }
    }

    #[test]
    fn preserves_content_while_omitting_turn_boundaries_from_the_derived_event() {
        let source = make_entry(json!({
            "gen_ai.input.messages_delta": [{ "role": "user", "content": "hello" }],
            "trace_id": "0123456789abcdef0123456789abcdef",
            "gen_ai.turn.id": "turn-1",
            "gen_ai.turn.start": true,
            "gen_ai.turn.end": true,
            "custom": { "nested": ["value"] }
        }));
        let result = expand_agent_input_events(vec![source.clone()]);
        let derived = result[1].clone();

        assert_eq!(
            strip_derived_fields(derived.clone()),
            strip_derived_fields(source.clone())
        );
        assert_ne!(derived.event_id, source.event_id);
        assert_eq!(derived.turn_start, None);
        assert_eq!(derived.turn_end, None);
        assert_eq!(result[0].turn_start, Some(true));
        assert_eq!(result[0].turn_end, Some(true));
        assert_eq!(result[0].event_name, Some(AgentEventName::Other));
        assert_eq!(result[0].event_id, "source-event");
    }

    #[test]
    fn derives_a_deterministic_uuid_v5_in_the_fixed_namespace() {
        let expected = derive_agent_input_event_id("source-event");
        assert_eq!(expected, derive_agent_input_event_id("source-event"));
        assert_eq!(expected, "6ea0c3d3-8dcb-5381-9446-171a5b88f1ec");
        assert!(UUID_V5_RE.is_match(&expected));
        assert_eq!(
            uuid_v5(
                &parse_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
                b"www.example.com"
            ),
            "2ed6657d-e927-568b-95e1-2665a8aea6a2"
        );
        assert_eq!(
            hex::encode(sha1(b"")),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            hex::encode(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }

    #[test]
    fn preserves_original_order_and_inserts_the_derived_event_next_to_its_source() {
        let before = make_entry(json!({
            "event.id": "before",
            "event.name": "tool.call"
        }));
        let source = make_entry(json!({
            "event.id": "input",
            "gen_ai.input.messages_delta": [{ "role": "user", "content": "hello" }]
        }));
        let after = make_entry(json!({
            "event.id": "after",
            "event.name": "tool.result"
        }));
        let result = expand_agent_input_events(vec![before, source, after]);
        let derived = derive_agent_input_event_id("input");
        let ids: Vec<_> = result.iter().map(|entry| entry.event_id.as_str()).collect();
        assert_eq!(ids, vec!["before", "input", derived.as_str(), "after"]);
    }

    #[test]
    fn is_idempotent_when_an_expanded_batch_is_processed_again() {
        let source = make_entry(json!({
            "gen_ai.input.messages_delta": [{ "role": "user", "content": "hello" }]
        }));
        let once = expand_agent_input_events(vec![source]);
        let once_ids: Vec<_> = once
            .iter()
            .map(|entry| entry.event_id.clone())
            .collect::<Vec<_>>();
        let twice = expand_agent_input_events(once);
        let twice_ids: Vec<_> = twice
            .iter()
            .map(|entry| entry.event_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(twice_ids, once_ids);
    }

    #[test]
    fn does_not_append_when_the_derived_id_already_exists() {
        let source = make_entry(json!({
            "gen_ai.input.messages": [{ "role": "user", "content": "hello" }]
        }));
        let existing_derived = make_entry(json!({
            "event.id": derive_agent_input_event_id(&source.event_id),
            "event.name": "agent.input",
            "gen_ai.input.messages": source.input_messages.clone()
        }));
        let expected = vec![source.clone(), existing_derived.clone()];
        let result = expand_agent_input_events(vec![source, existing_derived]);
        assert_eq!(result, expected);
    }

    #[test]
    fn preserves_non_input_other_and_non_other_events() {
        let metadata_other = make_entry(json!({ "event.id": "metadata" }));
        let request = make_entry(json!({
            "event.id": "request",
            "event.name": "llm.request",
            "gen_ai.input.messages": [{ "role": "user", "content": "hello" }]
        }));
        let expected = vec![metadata_other.clone(), request.clone()];
        assert_eq!(
            expand_agent_input_events(vec![metadata_other, request]),
            expected
        );
    }
}
