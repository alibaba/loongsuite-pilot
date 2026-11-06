//! Reads `${dataDir}/acp-correlate/<sessionId>.jsonl`.
//! Port of `correlation-store.ts`.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::utils::content_hash;

use super::super::{fields, logger};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnRecord {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_prefix: Option<String>,
    traceparent: String,
}

struct SessionState {
    modified: Option<SystemTime>,
    file_len: u64,
    turns: Vec<TurnRecord>,
    sessions: Vec<String>,
    consumed_turns: HashSet<usize>,
    resolved_turns: HashMap<String, usize>,
    session_consumed: bool,
    hash_index: HashMap<String, Vec<usize>>,
    hash_cursor: HashMap<String, usize>,
    last_access_ms: u128,
}

pub struct CorrelationStore {
    dir: PathBuf,
    states: std::sync::Mutex<HashMap<String, SessionState>>,
}

impl CorrelationStore {
    pub fn new(correlate_dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: correlate_dir.into(),
            states: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn resolve_turn(&self, session_id: &str, collected_text: &str) -> Option<String> {
        self.resolve_turn_with_identity(session_id, collected_text, None, None)
    }

    /// Persistent consume-once records can be replayed by their native turn.
    /// A producer hash identifies the full UTF-8 input before display truncation.
    pub fn resolve_turn_with_identity(
        &self,
        session_id: &str,
        collected_text: &str,
        turn_id: Option<&str>,
        collected_hash: Option<&str>,
    ) -> Option<String> {
        let dir = self.dir.clone();
        let mut states = self.states.lock().expect("states");
        let state = load_state(&mut states, &dir, session_id)?;
        let turn_id = turn_id.filter(|id| !id.is_empty());
        if let Some(index) = turn_id.and_then(|id| state.resolved_turns.get(id)) {
            return state
                .turns
                .get(*index)
                .map(|record| record.traceparent.clone());
        }
        let hash = collected_hash
            .filter(|hash| valid_content_hash(hash))
            .map(str::to_owned)
            .unwrap_or_else(|| content_hash(collected_text));
        if let Some(bucket) = state.hash_index.get(&hash).cloned() {
            let mut cursor = state.hash_cursor.get(&hash).copied().unwrap_or(0);
            while cursor < bucket.len() {
                let index = bucket[cursor];
                cursor += 1;
                if state.consumed_turns.contains(&index) {
                    continue;
                }
                if let Some(traceparent) = consume_turn(&dir, session_id, state, index, turn_id) {
                    state.hash_cursor.insert(hash, cursor);
                    return Some(traceparent);
                }
            }
            state.hash_cursor.insert(hash, cursor);
        }
        for index in 0..state.turns.len() {
            if state.consumed_turns.contains(&index) {
                continue;
            }
            if state.turns[index]
                .content_prefix
                .as_ref()
                .is_some_and(|prefix| !prefix.is_empty() && collected_text.starts_with(prefix))
            {
                if let Some(traceparent) = consume_turn(&dir, session_id, state, index, turn_id) {
                    return Some(traceparent);
                }
            }
        }
        None
    }

    pub fn resolve_session_first(&self, session_id: &str) -> Option<String> {
        let dir = self.dir.clone();
        let traceparent = {
            let mut states = self.states.lock().expect("states");
            let state = load_state(&mut states, &dir, session_id)?;
            if state.sessions.is_empty() || state.session_consumed {
                return None;
            }
            state.session_consumed = true;
            state.sessions[0].clone()
        };
        if !self.claim_session(session_id) {
            return None;
        }
        Some(traceparent)
    }

    pub fn mark_session_consumed(&self, session_id: &str) {
        let dir = self.dir.clone();
        let should_claim = {
            let mut states = self.states.lock().expect("states");
            let Some(state) = load_state(&mut states, &dir, session_id) else {
                return;
            };
            if state.sessions.is_empty() || state.session_consumed {
                return;
            }
            state.session_consumed = true;
            true
        };
        if should_claim {
            let _ = self.claim_session(session_id);
        }
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.session_path(session_id).is_file()
    }

    pub fn prune_idle(&self, cutoff_ms: u128) -> usize {
        let mut states = self.states.lock().expect("states");
        let before = states.len();
        states.retain(|_, state| state.last_access_ms >= cutoff_ms);
        before - states.len()
    }
}

fn load_state<'a>(
    states: &'a mut HashMap<String, SessionState>,
    dir: &Path,
    session_id: &str,
) -> Option<&'a mut SessionState> {
    let path = dir.join(format!("{}.jsonl", safe_name(session_id)));
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok();
    if states.get(session_id).is_some_and(|existing| {
        modified.is_some() && existing.modified == modified && existing.file_len == meta.len()
    }) {
        states.get_mut(session_id).expect("state").last_access_ms = now_ms();
        return states.get_mut(session_id);
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => {
            logger("correlation-store").warn(
                "failed to read correlation file",
                Some(&fields(
                    serde_json::json!({ "sessionId": session_id, "error": err.kind().to_string() }),
                )),
            );
            return states.get_mut(session_id);
        }
    };
    let mut turns = Vec::new();
    let mut sessions = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let traceparent = value
            .get("traceparent")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(traceparent) = traceparent else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("turn") => turns.push(TurnRecord {
                kind: "turn",
                content_hash: value
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                content_prefix: value
                    .get("contentPrefix")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                traceparent,
            }),
            Some("session") => sessions.push(traceparent),
            _ => {}
        }
    }
    let previous = states.remove(session_id);
    let mut hash_index = HashMap::new();
    for (index, turn) in turns.iter().enumerate() {
        if let Some(hash) = &turn.content_hash {
            hash_index
                .entry(hash.clone())
                .or_insert_with(Vec::new)
                .push(index);
        }
    }
    states.insert(
        session_id.to_string(),
        SessionState {
            modified,
            file_len: meta.len(),
            turns,
            sessions,
            consumed_turns: previous
                .as_ref()
                .map(|state| state.consumed_turns.clone())
                .unwrap_or_default(),
            resolved_turns: previous
                .as_ref()
                .map(|state| state.resolved_turns.clone())
                .unwrap_or_default(),
            session_consumed: previous
                .as_ref()
                .map(|state| state.session_consumed)
                .unwrap_or_else(|| {
                    dir.join(format!("{}.session-context.done", safe_name(session_id)))
                        .is_file()
                }),
            hash_index,
            hash_cursor: HashMap::new(),
            last_access_ms: now_ms(),
        },
    );
    states.get_mut(session_id)
}

impl CorrelationStore {
    fn claim_session(&self, session_id: &str) -> bool {
        let path = self.session_done_path(session_id);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = file.write_all(serde_json::json!({ "sessionId": session_id, "ts": chrono::Utc::now().to_rfc3339() }).to_string().as_bytes());
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
                true
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(err) => {
                logger("correlation-store").warn(
                    "failed to persist session context consumption",
                    Some(&fields(
                        serde_json::json!({ "sessionId": session_id, "error": err.to_string() }),
                    )),
                );
                true
            }
        }
    }

    fn session_path(&self, session_id: &str) -> PathBuf {
        self.dir.join(format!("{}.jsonl", safe_name(session_id)))
    }

    fn session_done_path(&self, session_id: &str) -> PathBuf {
        self.dir
            .join(format!("{}.session-context.done", safe_name(session_id)))
    }
}

fn safe_name(value: &str) -> String {
    let base = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value);
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub(super) fn valid_content_hash(hash: &str) -> bool {
    hash.len() == 16
        && hash
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}

fn consume_turn(
    dir: &Path,
    session_id: &str,
    state: &mut SessionState,
    index: usize,
    turn_id: Option<&str>,
) -> Option<String> {
    state.consumed_turns.insert(index);
    let record = &state.turns[index];
    let (claimed, owner) = claim_turn(dir, session_id, index, record, turn_id);
    if let Some(owner) = owner {
        state.resolved_turns.insert(owner, index);
    }
    claimed.then(|| record.traceparent.clone())
}

fn claim_turn(
    dir: &Path,
    session_id: &str,
    index: usize,
    record: &TurnRecord,
    turn_id: Option<&str>,
) -> (bool, Option<String>) {
    // Serialize only normalized fields in the same order as upstream Node's
    // JSON.stringify(record), preserving claim ownership through the migration.
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(record).expect("turn record"))
    );
    let marker = dir.join(format!(
        "{}.turn-context-{index}-{digest}.done",
        safe_name(session_id)
    ));
    let temporary = dir.join(format!(".turn-claim-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let owner = turn_id
            .map(|id| serde_json::json!({ "turnId": id }))
            .unwrap_or_else(|| serde_json::json!({}));
        file.write_all(owner.to_string().as_bytes())?;
        drop(file);
        std::fs::hard_link(&temporary, &marker)
    })();
    let _ = std::fs::remove_file(&temporary);
    match result {
        Ok(()) => (true, turn_id.map(str::to_owned)),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            let owner = std::fs::read(&marker)
                .ok()
                .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                .and_then(|value| {
                    value
                        .get("turnId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|owner| !owner.is_empty());
            (turn_id.is_some() && owner.as_deref() == turn_id, owner)
        }
        Err(err) => {
            logger("correlation-store").warn("failed to persist turn context consumption",
                Some(&fields(serde_json::json!({ "sessionId": session_id, "index": index, "error": err.kind().to_string() }))));
            (true, turn_id.map(str::to_owned))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hash_is_consumed_once_and_prefix_is_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let text = "hello upstream";
        let hash = content_hash(text);
        let path = dir.path().join("sess.jsonl");
        std::fs::write(&path, format!(
            "{}\n{}\n",
            serde_json::json!({ "type": "turn", "contentHash": hash, "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }),
            serde_json::json!({ "type": "turn", "contentPrefix": "rewrite", "traceparent": "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" }),
        )).unwrap();
        let store = CorrelationStore::new(dir.path());
        assert_eq!(
            store.resolve_turn("sess", text).as_deref(),
            Some("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
        );
        assert!(store.resolve_turn("sess", text).is_none());
        assert_eq!(
            store.resolve_turn("sess", "rewrite me").as_deref(),
            Some("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01")
        );
        assert!(store.has_session("sess"));
    }
}
