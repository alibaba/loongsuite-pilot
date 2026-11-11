//! Port of `assets/hooks/shared/workspace-policy.mjs`.
//!
//! The collector and the hook runtime share one implementation. Core is not
//! part of this inputs port, so the filter BaseInput calls lives here.

use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::resolve_home;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// `privacy.excludeWorkspaces` must be an array of absolute directories.
pub fn validate_excluded_workspaces(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        return Err(
            "privacy.excludeWorkspaces must be an array of absolute local directories".into(),
        );
    };
    let mut out = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(
                "privacy.excludeWorkspaces must be an array of absolute local directories".into(),
            );
        };
        if !Path::new(text).is_absolute() {
            return Err(
                "privacy.excludeWorkspaces must be an array of absolute local directories".into(),
            );
        }
        if !out.iter().any(|existing: &String| existing == text) {
            out.push(text.to_owned());
        }
    }
    Ok(out)
}

fn normalize_directory(value: &str) -> Option<PathBuf> {
    let expanded = if let Some(rest) = value.strip_prefix("~/") {
        resolve_home(&format!("~/{rest}"))
    } else if value == "~" {
        resolve_home("~")
    } else {
        value.to_owned()
    };
    let path = PathBuf::from(&expanded);
    if !path.is_absolute() {
        return None;
    }
    let normalized = normalize_lexical(&path);
    if cfg!(windows) {
        Some(PathBuf::from(
            normalized.to_string_lossy().to_ascii_lowercase(),
        ))
    } else {
        Some(normalized)
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// Fingerprints are a cross-component disk protocol. In particular Windows
// canonical paths may carry verbatim prefixes, while hook paths do not.
fn marker_directory(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let value = value.replace('\\', "/").to_lowercase();
        if let Some(rest) = value.strip_prefix("//?/unc/") {
            format!("//{rest}")
        } else {
            value.strip_prefix("//?/").unwrap_or(&value).to_owned()
        }
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn real_path(value: &Path) -> PathBuf {
    match fs::canonicalize(value) {
        Ok(resolved) => normalize_directory(&resolved.to_string_lossy()).unwrap_or(resolved),
        Err(_) => {
            let parent = value.parent().unwrap_or(value);
            if parent == value {
                value.to_path_buf()
            } else {
                let name = value.file_name().unwrap_or_default();
                real_path(parent).join(name)
            }
        }
    }
}

fn within(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn strings_of(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        Value::String(text) if !text.is_empty() => {
            if let Some(rest) = text.strip_prefix('[') {
                let _ = rest;
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    return strings_of(&parsed);
                }
                return Vec::new();
            }
            vec![text.clone()]
        }
        _ => Vec::new(),
    }
}

#[derive(Debug)]
pub struct WorkspacePolicy {
    state_directory: Option<PathBuf>,
    roots: Vec<PathBuf>,
    blocked: BTreeSet<String>,
    fingerprint: String,
    pending_markers: BTreeSet<PathBuf>,
    next_retry_at: i64,
    next_warning_at: i64,
}

impl Default for WorkspacePolicy {
    fn default() -> Self {
        Self::new(Vec::new(), None)
    }
}

impl WorkspacePolicy {
    pub fn new(excluded: Vec<String>, state_directory: Option<PathBuf>) -> Self {
        // Match hook/manager validation: deduplicate the original rule spelling,
        // before normalization, so both sides choose the same durable namespace.
        let mut unique = BTreeSet::new();
        let roots = excluded
            .into_iter()
            .filter(|value| unique.insert(value.clone()))
            .filter_map(|value| normalize_directory(&value))
            .collect::<Vec<_>>();
        let mut sorted = roots
            .iter()
            .map(|path| marker_directory(path))
            .collect::<Vec<_>>();
        sorted.sort();
        let fingerprint =
            sha256_hex(&serde_json::to_string(&sorted).unwrap_or_else(|_| "[]".into()));
        Self {
            state_directory,
            roots,
            blocked: BTreeSet::new(),
            fingerprint,
            pending_markers: BTreeSet::new(),
            next_retry_at: 0,
            next_warning_at: 0,
        }
    }

    pub fn enabled(&self) -> bool {
        !self.roots.is_empty()
    }

    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub(crate) fn has_pending_markers(&self) -> bool {
        !self.pending_markers.is_empty()
    }

    pub fn excludes(&self, directory: &str) -> bool {
        let Some(candidate) = normalize_directory(directory) else {
            return false;
        };
        self.roots.iter().any(|root| {
            within(&candidate, root) || within(&real_path(&candidate), &real_path(root))
        })
    }

    fn persist_marker(&mut self, marker: &Path) {
        let write = (|| -> std::io::Result<()> {
            if let Some(parent) = marker.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(marker)?;
            file.write_all(b"")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(marker, fs::Permissions::from_mode(0o600));
            }
            Ok(())
        })();
        if write.is_ok() {
            self.pending_markers.remove(marker);
            return;
        }
        self.pending_markers.insert(marker.to_path_buf());
        let now = now_ms();
        self.next_retry_at = now + 5000;
        if now >= self.next_warning_at {
            self.next_warning_at = now + 60_000;
            let _ = std::io::stderr().write_all(
                b"[workspace-privacy] Cannot persist session exclusions; blocked in this process, restart/other-process protection may be unavailable. Retrying on subsequent events.\n",
            );
        }
    }

    fn retry_pending_markers(&mut self) {
        if self.pending_markers.is_empty() || now_ms() < self.next_retry_at {
            return;
        }
        self.next_retry_at = now_ms() + 5000;
        let batch: Vec<PathBuf> = self.pending_markers.iter().take(8).cloned().collect();
        for marker in batch {
            self.pending_markers.remove(&marker);
            self.persist_marker(&marker);
        }
    }

    pub fn allows(&mut self, record: &Map<String, Value>, fallback_agent: &str) -> bool {
        if self.roots.is_empty() {
            return true;
        }
        self.retry_pending_markers();
        let agent = record
            .get("gen_ai.agent.type")
            .and_then(Value::as_str)
            .unwrap_or(fallback_agent);
        let session = [
            "gen_ai.session.id",
            "session_id",
            "sessionId",
            "conversation_id",
        ]
        .iter()
        .find_map(|key| record.get(*key).and_then(Value::as_str))
        .filter(|text| !text.is_empty());
        let key = session.map(|session| sha256_hex(&format!("{agent}\0{session}")));
        let marker = match (&key, &self.state_directory) {
            (Some(key), Some(dir)) => Some(dir.join(&self.fingerprint).join(key)),
            _ => None,
        };
        if key.as_ref().is_some_and(|key| self.blocked.contains(key))
            || marker.as_ref().is_some_and(|path| path.exists())
        {
            return false;
        }
        let mut directories = Vec::new();
        for key in ["workspace.path", "cwd", "workspace_roots"] {
            if let Some(value) = record.get(key) {
                directories.extend(strings_of(value));
            }
        }
        let agent_dir = regex::Regex::new(r"^agent\.[^.]+\.(cwd|workspace_roots)$").ok();
        if let Some(pattern) = agent_dir {
            for (name, value) in record {
                if pattern.is_match(name) {
                    directories.extend(strings_of(value));
                }
            }
        }
        if !directories.iter().any(|directory| self.excludes(directory)) {
            return true;
        }
        if let Some(key) = key {
            self.blocked.insert(key);
            if let Some(marker) = marker {
                self.persist_marker(&marker);
            }
        }
        false
    }

    pub fn filter_maps(
        &mut self,
        records: &[Map<String, Value>],
        fallback_agent: &str,
    ) -> Vec<Map<String, Value>> {
        if self.roots.is_empty() {
            return records.to_vec();
        }
        for record in records {
            let _ = self.allows(record, fallback_agent);
        }
        records
            .iter()
            .filter(|record| self.allows(record, fallback_agent))
            .cloned()
            .collect()
    }

    pub fn filter_entries(
        &mut self,
        entries: &[AgentActivityEntry],
        agent_type: ClientType,
    ) -> Vec<AgentActivityEntry> {
        if self.roots.is_empty() {
            return entries.to_vec();
        }
        let maps: Vec<Map<String, Value>> = entries
            .iter()
            .map(crate::normalization::entry_to_object)
            .collect();
        let agent = agent_type.as_str();
        for record in &maps {
            let _ = self.allows(record, agent);
        }
        entries
            .iter()
            .zip(maps.iter())
            .filter(|(_, record)| self.allows(record, agent))
            .map(|(entry, _)| entry.clone())
            .collect()
    }

    pub(crate) fn filter_entries_owned(
        &mut self,
        entries: Vec<AgentActivityEntry>,
        agent_type: ClientType,
    ) -> Vec<AgentActivityEntry> {
        if self.roots.is_empty() {
            return entries;
        }
        let maps: Vec<_> = entries
            .iter()
            .map(crate::normalization::entry_to_object)
            .collect();
        let agent = agent_type.as_str();
        for record in &maps {
            let _ = self.allows(record, agent);
        }
        entries
            .into_iter()
            .zip(maps)
            .filter(|(_, record)| self.allows(record, agent))
            .map(|(entry, _)| entry)
            .collect()
    }

    /// Side-effect pass used by trace inputs that ignore the filtered list.
    pub fn preflight_entries(&mut self, entries: &[AgentActivityEntry], agent_type: ClientType) {
        if self.roots.is_empty() {
            return;
        }
        let _ = self.filter_entries(entries, agent_type);
    }

    pub fn allows_entry(&mut self, entry: &AgentActivityEntry, agent_type: ClientType) -> bool {
        if self.roots.is_empty() {
            return true;
        }
        let map = crate::normalization::entry_to_object(entry);
        self.allows(&map, agent_type.as_str())
    }
}

#[cfg(test)]
mod owned_entry_filter_contract_tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, agent: &str, session: &str, workspace: Option<&Path>) -> AgentActivityEntry {
        let mut nested = Map::new();
        nested.insert(
            "zeta-first".into(),
            json!([null, true, 1.25, {"raw":"路径\r\n原文"}]),
        );
        nested.insert("alpha-second".into(), Value::Null);
        let mut fields = json!({
            "event.id": id,
            "event.name": "llm.request",
            "time_unix_nano": "1794294000000000000",
            "gen_ai.agent.type": agent,
            "gen_ai.session.id": session,
            "gen_ai.input.messages_delta": [{
                "role":"user", "parts":[{"type":"future-part","payload":{"array":[null,{},[]]}}]
            }]
        });
        let object = fields.as_object_mut().unwrap();
        object.insert("future.z-before-a".into(), Value::Object(nested));
        object.insert(
            "future.a-after-z".into(),
            json!({"unknown":[{"keep":false},null]}),
        );
        object.insert(
            "future.payload".into(),
            Value::String("原始 payload\n".repeat(64)),
        );
        if let Some(workspace) = workspace {
            object.insert("workspace.path".into(), json!(workspace));
        }
        serde_json::from_value(fields).unwrap()
    }

    fn bytes(entries: &[AgentActivityEntry]) -> Vec<u8> {
        serde_json::to_vec(entries).unwrap()
    }

    fn ids(entries: &[AgentActivityEntry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| entry.event_id.as_str())
            .collect()
    }

    fn late_exclusion_batch(excluded: &Path, allowed: &Path) -> Vec<AgentActivityEntry> {
        vec![
            entry("qoder-before-without-path", "qoder", "shared", None),
            entry("codex-before", "codex", "shared", Some(allowed)),
            entry("other-session", "qoder", "different", Some(allowed)),
            entry("codex-after", "codex", "shared", None),
            entry(
                "qoder-before-with-allowed-path",
                "qoder",
                "shared",
                Some(allowed),
            ),
            entry("late-excluded-notice", "qoder", "shared", Some(excluded)),
        ]
    }

    fn assert_blocked_session_and_markers(
        owned: &WorkspacePolicy,
        borrowed: &WorkspacePolicy,
        owned_state: &Path,
        borrowed_state: &Path,
    ) {
        let blocked = sha256_hex("qoder\0shared");
        let other_agent = sha256_hex("codex\0shared");
        assert_eq!(owned.blocked, borrowed.blocked);
        assert_eq!(owned.blocked, BTreeSet::from([blocked.clone()]));
        assert_eq!(owned.fingerprint(), borrowed.fingerprint());
        assert!(!owned.has_pending_markers());
        assert!(!borrowed.has_pending_markers());
        assert_ne!(owned_state, borrowed_state);
        for state in [owned_state, borrowed_state] {
            let directory = state.join(owned.fingerprint());
            assert!(directory.join(&blocked).is_file());
            assert!(!directory.join(&other_agent).exists());
            assert_eq!(
                fs::read(directory.join(&blocked)).unwrap(),
                Vec::<u8>::new()
            );
            assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
        }
    }

    #[test]
    fn owned_empty_roots_preserve_original_vec_allocation_and_complete_entry_bytes() {
        let root = tempfile::tempdir().unwrap();
        let owned_state = root.path().join("owned-markers");
        let borrowed_state = root.path().join("borrowed-markers");
        let mut owned = WorkspacePolicy::new(Vec::new(), Some(owned_state.clone()));
        let mut borrowed = WorkspacePolicy::new(Vec::new(), Some(borrowed_state.clone()));
        let mut input = Vec::with_capacity(19);
        input.extend([
            entry("first", "qoder", "one", None),
            entry("second", "codex", "two", None),
        ]);
        let original_bytes = bytes(&input);
        let allocation = input.as_ptr();
        let capacity = input.capacity();
        let payload = input[0].extra["future.payload"].as_str().unwrap().as_ptr();
        let expected = borrowed.filter_entries(&input, ClientType::Qoder);
        let actual = owned.filter_entries_owned(input, ClientType::Qoder);

        assert_eq!(
            actual.as_ptr(),
            allocation,
            "disabled policy must return the owned Vec allocation"
        );
        assert_eq!(actual.capacity(), capacity);
        assert_eq!(
            actual[0].extra["future.payload"].as_str().unwrap().as_ptr(),
            payload
        );
        assert_eq!(ids(&actual), ["first", "second"]);
        assert_eq!(bytes(&actual), original_bytes);
        assert_eq!(bytes(&actual), bytes(&expected));
        assert_eq!(
            actual[0].extra["future.z-before-a"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["zeta-first", "alpha-second"]
        );
        assert_eq!(owned.blocked, borrowed.blocked);
        assert!(owned.blocked.is_empty());
        assert!(!owned_state.exists());
        assert!(!borrowed_state.exists());
    }

    #[test]
    fn owned_late_exclusion_retroactively_blocks_only_owning_agent_session_and_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let excluded = root.path().join("excluded");
        let allowed = root.path().join("excluded-sibling");
        fs::create_dir_all(&excluded).unwrap();
        fs::create_dir_all(&allowed).unwrap();
        let roots = vec![excluded.to_string_lossy().into_owned()];
        let owned_state = root.path().join("owned-markers");
        let borrowed_state = root.path().join("borrowed-markers");
        let mut owned = WorkspacePolicy::new(roots.clone(), Some(owned_state.clone()));
        let mut borrowed = WorkspacePolicy::new(roots.clone(), Some(borrowed_state.clone()));
        let input = late_exclusion_batch(&excluded.join("nested"), &allowed);
        let expected = borrowed.filter_entries(&input, ClientType::Qoder);
        let actual = owned.filter_entries_owned(input, ClientType::Qoder);

        assert_eq!(
            ids(&actual),
            ["codex-before", "other-session", "codex-after"]
        );
        assert_eq!(bytes(&actual), bytes(&expected));
        assert_blocked_session_and_markers(&owned, &borrowed, &owned_state, &borrowed_state);
        drop(owned);
        drop(borrowed);

        let mut owned = WorkspacePolicy::new(roots.clone(), Some(owned_state));
        let mut borrowed = WorkspacePolicy::new(roots, Some(borrowed_state));
        assert!(owned.blocked.is_empty());
        assert!(borrowed.blocked.is_empty());
        let restarted = vec![
            entry(
                "blocked-after-restart-without-path",
                "qoder",
                "shared",
                None,
            ),
            entry("codex-after-restart", "codex", "shared", None),
            entry("other-session-after-restart", "qoder", "different", None),
        ];
        let expected = borrowed.filter_entries(&restarted, ClientType::Qoder);
        let actual = owned.filter_entries_owned(restarted, ClientType::Qoder);
        assert_eq!(
            ids(&actual),
            ["codex-after-restart", "other-session-after-restart"]
        );
        assert_eq!(bytes(&actual), bytes(&expected));
        assert_eq!(owned.blocked, borrowed.blocked);
        assert!(
            owned.blocked.is_empty(),
            "rejection must be proven by the durable marker, not retained memory"
        );
        assert!(!owned.has_pending_markers());
        assert!(!borrowed.has_pending_markers());
    }

    #[test]
    fn owned_excluded_notice_first_matches_borrowed_oracle_and_keeps_reverse_survivor_order() {
        let root = tempfile::tempdir().unwrap();
        let excluded = root.path().join("excluded");
        let allowed = root.path().join("excluded-sibling");
        fs::create_dir_all(&excluded).unwrap();
        fs::create_dir_all(&allowed).unwrap();
        let roots = vec![excluded.to_string_lossy().into_owned()];
        let owned_state = root.path().join("owned-reverse-markers");
        let borrowed_state = root.path().join("borrowed-reverse-markers");
        let mut owned = WorkspacePolicy::new(roots.clone(), Some(owned_state.clone()));
        let mut borrowed = WorkspacePolicy::new(roots, Some(borrowed_state.clone()));
        let mut input = late_exclusion_batch(&excluded.join("nested"), &allowed);
        input.reverse();
        assert_eq!(input[0].event_id, "late-excluded-notice");
        let expected = borrowed.filter_entries(&input, ClientType::Qoder);
        let actual = owned.filter_entries_owned(input, ClientType::Qoder);
        assert_eq!(
            ids(&actual),
            ["codex-after", "other-session", "codex-before"]
        );
        assert_eq!(bytes(&actual), bytes(&expected));
        assert_blocked_session_and_markers(&owned, &borrowed, &owned_state, &borrowed_state);
    }
}
