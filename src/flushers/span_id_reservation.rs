//! 外部 Span ID 的一次性预留；原生转换器直接将预留 ID 写入 Span。
//! 冲突或非法 ID 不预留，避免错误的父子关联。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::types::AgentActivityEntry;

const VALID_SPAN_ID_LEN: usize = 16;
const ZERO_SPAN_ID: &str = "0000000000000000";
const TOOL_EVENT_NAMES: &[&str] = &["tool.call", "tool.result"];
const LLM_EVENT_NAMES: &[&str] = &["llm.request", "llm.response"];

pub(super) fn valid_span_id(value: &str) -> bool {
    value.len() == VALID_SPAN_ID_LEN
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        && value != ZERO_SPAN_ID
}

pub(super) fn valid_trace_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        && value.bytes().any(|ch| ch != b'0')
}

pub struct ReservedSpanIdGenerator {
    reserved: Option<String>,
    reserved_trace: Option<String>,
}

impl ReservedSpanIdGenerator {
    pub fn new() -> Self {
        Self {
            reserved: None,
            reserved_trace: None,
        }
    }

    pub fn generate_trace_id(&mut self) -> String {
        self.reserved_trace.take().unwrap_or_else(|| random_hex(32))
    }

    pub fn reserve_trace_id(&mut self, trace_id: &str) -> Result<(), String> {
        if !valid_trace_id(trace_id) {
            return Err("Invalid reserved trace id".into());
        }
        self.reserved_trace = Some(trace_id.into());
        Ok(())
    }

    pub fn clear_trace_id(&mut self) {
        self.reserved_trace = None;
    }

    pub fn generate_span_id(&mut self) -> String {
        self.reserved.take().unwrap_or_else(|| random_hex(16))
    }

    pub fn reserve(&mut self, span_id: &str) -> bool {
        if !valid_span_id(span_id) {
            return false;
        }
        self.reserved = Some(span_id.to_string());
        true
    }

    pub fn clear(&mut self) {
        self.reserved = None;
    }
}

impl Default for ReservedSpanIdGenerator {
    fn default() -> Self {
        Self::new()
    }
}

fn random_hex(chars: usize) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let mixed = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(mixed.to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
        if out.len() >= chars {
            break;
        }
    }
    let out = out[..chars].to_string();
    if out.chars().all(|ch| ch == '0') {
        "1".repeat(chars)
    } else {
        out
    }
}

#[derive(Clone, Debug, Default)]
pub struct SpanIdReservations {
    event_names: Vec<String>,
    key_field: String,
    by_key: HashMap<String, String>,
}

impl SpanIdReservations {
    pub fn tool() -> Self {
        Self::new(TOOL_EVENT_NAMES, "gen_ai.tool.call.id")
    }

    pub fn llm() -> Self {
        Self::new(LLM_EVENT_NAMES, "gen_ai.response.id")
    }

    pub fn new(event_names: &[&str], key_field: &str) -> Self {
        Self {
            event_names: event_names.iter().map(|name| (*name).to_string()).collect(),
            key_field: key_field.to_string(),
            by_key: HashMap::new(),
        }
    }

    pub fn prepare(&mut self, records: &[AgentActivityEntry]) {
        self.by_key.clear();
        let mut conflicts = HashSet::new();
        for record in records {
            let Some(event_name) = record.event_name.map(|name| name.as_str().to_string()) else {
                continue;
            };
            if !self.event_names.iter().any(|name| name == &event_name) {
                continue;
            }
            let key = record_key(record, &self.key_field);
            let Some(span_id) = record.span_id.clone().filter(|value| valid_span_id(value)) else {
                continue;
            };
            let Some(key) = key.filter(|value| !value.is_empty()) else {
                continue;
            };
            if let Some(existing) = self.by_key.get(&key) {
                if existing != &span_id {
                    conflicts.insert(key.clone());
                    self.by_key.remove(&key);
                }
            } else if !conflicts.contains(&key) {
                self.by_key.insert(key, span_id);
            }
        }
    }

    pub fn take(&mut self, key: Option<&str>) -> Option<String> {
        let key = key.filter(|value| !value.is_empty())?;
        self.by_key.remove(key)
    }

    pub fn clear(&mut self) {
        self.by_key.clear();
    }
}

fn record_key(record: &AgentActivityEntry, field: &str) -> Option<String> {
    match field {
        "gen_ai.tool.call.id" => record.tool_call_id.clone(),
        "gen_ai.response.id" => record.response_id.clone(),
        other => record
            .get(other)
            .and_then(|value| value.as_str().map(str::to_string)),
    }
}

/// Holds a reservation only for the synchronous `start` call, then clears it
/// so a panic-equivalent early return cannot leak the id. The TypeScript
/// `attachReserved*` helpers mutate the third-party handler; this gate is the
/// Rust stand-in and is not invoked by an OTel SDK.
pub struct SpanIdGate {
    pub reservations: SpanIdReservations,
    pub generator: ReservedSpanIdGenerator,
}

impl SpanIdGate {
    pub fn start<T>(
        &mut self,
        key: Option<&str>,
        start: impl FnOnce(&mut ReservedSpanIdGenerator) -> T,
    ) -> T {
        if let Some(span_id) = self.reservations.take(key) {
            self.generator.reserve(&span_id);
        }
        let result = start(&mut self.generator);
        self.generator.clear();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentActivityEntry, AgentEventName};

    fn entry(
        name: AgentEventName,
        response_id: Option<&str>,
        span_id: Option<&str>,
    ) -> AgentActivityEntry {
        AgentActivityEntry {
            event_name: Some(name),
            response_id: response_id.map(str::to_string),
            span_id: span_id.map(str::to_string),
            ..AgentActivityEntry::default()
        }
    }

    #[test]
    fn reserves_one_id_then_falls_back_and_rejects_invalid_ids() {
        let mut generator = ReservedSpanIdGenerator::new();
        assert!(!generator.reserve("not-hex"));
        assert!(!generator.reserve(ZERO_SPAN_ID));
        assert!(generator.reserve("d0d0d0d0d0d0d0d0"));
        assert_eq!(generator.generate_span_id(), "d0d0d0d0d0d0d0d0");
        let fallback = generator.generate_span_id();
        assert_ne!(fallback, "d0d0d0d0d0d0d0d0");
        assert_eq!(fallback.len(), 16);
        assert!(generator.reserve("d0d0d0d0d0d0d0d0"));
        generator.clear();
        assert_ne!(generator.generate_span_id(), "d0d0d0d0d0d0d0d0");
        assert_eq!(generator.generate_trace_id().len(), 32);
    }

    #[test]
    fn prepare_takes_the_first_id_and_drops_conflicts() {
        let mut reservations = SpanIdReservations::llm();
        reservations.prepare(&[
            entry(
                AgentEventName::LlmRequest,
                Some("msg_a"),
                Some("d0d0d0d0d0d0d0d0"),
            ),
            entry(
                AgentEventName::LlmResponse,
                Some("msg_a"),
                Some("d0d0d0d0d0d0d0d0"),
            ),
            entry(
                AgentEventName::LlmRequest,
                Some("msg_b"),
                Some("aaaaaaaaaaaaaaaa"),
            ),
            entry(
                AgentEventName::LlmResponse,
                Some("msg_b"),
                Some("bbbbbbbbbbbbbbbb"),
            ),
            entry(
                AgentEventName::Other,
                Some("msg_c"),
                Some("cccccccccccccccc"),
            ),
            entry(AgentEventName::LlmRequest, None, Some("dddddddddddddddd")),
            entry(
                AgentEventName::LlmRequest,
                Some("msg_d"),
                Some(ZERO_SPAN_ID),
            ),
        ]);
        assert_eq!(
            reservations.take(Some("msg_a")).as_deref(),
            Some("d0d0d0d0d0d0d0d0")
        );
        assert!(reservations.take(Some("msg_a")).is_none());
        assert!(reservations.take(Some("msg_b")).is_none());
        assert!(reservations.take(Some("msg_c")).is_none());
        assert!(reservations.take(None).is_none());
    }

    #[test]
    fn gate_clears_the_reservation_after_start() {
        let mut gate = SpanIdGate {
            reservations: SpanIdReservations::llm(),
            generator: ReservedSpanIdGenerator::new(),
        };
        gate.reservations.prepare(&[entry(
            AgentEventName::LlmRequest,
            Some("msg_a"),
            Some("d0d0d0d0d0d0d0d0"),
        )]);
        let seen = gate.start(Some("msg_a"), |generator| generator.generate_span_id());
        assert_eq!(seen, "d0d0d0d0d0d0d0d0");
        let next = gate.start(Some("missing"), |generator| generator.generate_span_id());
        assert_ne!(next, "d0d0d0d0d0d0d0d0");
    }
}

#[cfg(test)]
mod main533_trace_reservation_tests {
    use super::*;
    const TRACE: &str = "1234567890abcdef1234567890abcdef";
    #[test]
    fn trace_reservation_is_one_shot_and_independent_of_a_reserved_span() {
        let mut generator = ReservedSpanIdGenerator::new();
        assert!(generator.reserve("aaaaaaaaaaaaaaaa"));
        generator.reserve_trace_id(TRACE).unwrap();
        assert_eq!(generator.generate_trace_id(), TRACE);
        assert_eq!(generator.generate_span_id(), "aaaaaaaaaaaaaaaa");
        let next = generator.generate_trace_id();
        assert!(valid_trace_id(&next));
        assert_ne!(next, TRACE);
    }
    #[test]
    fn invalid_trace_reservations_fail_without_replacing_a_valid_pending_one() {
        for invalid in [
            "0".repeat(32),
            "a".repeat(31),
            "A".repeat(32),
            "z".repeat(32),
        ] {
            let mut generator = ReservedSpanIdGenerator::new();
            generator.reserve_trace_id(TRACE).unwrap();
            assert_eq!(
                generator.reserve_trace_id(&invalid).unwrap_err(),
                "Invalid reserved trace id"
            );
            assert_eq!(generator.generate_trace_id(), TRACE);
        }
    }
    #[test]
    fn clearing_a_trace_reservation_cannot_change_or_leak_a_span_reservation() {
        let mut generator = ReservedSpanIdGenerator::new();
        assert!(generator.reserve("aaaaaaaaaaaaaaaa"));
        generator.reserve_trace_id(TRACE).unwrap();
        generator.clear_trace_id();
        assert_ne!(generator.generate_trace_id(), TRACE);
        assert_eq!(generator.generate_span_id(), "aaaaaaaaaaaaaaaa");
    }
}
