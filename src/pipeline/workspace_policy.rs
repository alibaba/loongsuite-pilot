//! Native workspace exclusions shared by collector and pipeline.
//! Agent-hosted JavaScript retains the same explicit-metadata and durable-session contract.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct WorkspacePolicy {
    state_directory: Option<String>,
    roots: Vec<String>,
    blocked: HashSet<String>,
    fingerprint: String,
    pending_markers: HashSet<String>,
    next_retry_at: i64,
    next_warning_at: i64,
}

impl WorkspacePolicy {
    pub fn new(excluded: &[String], state_directory: Option<String>) -> Result<Self, String> {
        let validated = validate_excluded_workspaces(excluded)?;
        let roots: Vec<String> = validated
            .iter()
            .filter_map(|value| normalize_path(value))
            .collect();
        let mut sorted = roots.clone();
        sorted.sort();
        let fingerprint =
            sha256_hex(&serde_json::to_string(&sorted).unwrap_or_else(|_| "[]".into()));
        Ok(Self {
            state_directory,
            roots,
            blocked: HashSet::new(),
            fingerprint,
            pending_markers: HashSet::new(),
            next_retry_at: 0,
            next_warning_at: 0,
        })
    }

    pub fn enabled(&self) -> bool {
        !self.roots.is_empty()
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
        let session = record
            .get("gen_ai.session.id")
            .or_else(|| record.get("session_id"))
            .or_else(|| record.get("sessionId"))
            .or_else(|| record.get("conversation_id"));
        let key = session
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|session| sha256_hex(&format!("{agent}\0{session}")));
        let marker = key.as_ref().and_then(|key| {
            self.state_directory
                .as_ref()
                .map(|dir| format!("{dir}/{}/{key}", self.fingerprint))
        });
        if key.as_ref().is_some_and(|key| self.blocked.contains(key))
            || marker.as_ref().is_some_and(|path| Path::new(path).exists())
        {
            return false;
        }
        let mut directories = Vec::new();
        directories.extend(strings(record.get("workspace.path")));
        directories.extend(strings(record.get("cwd")));
        directories.extend(strings(record.get("workspace_roots")));
        for (name, value) in record {
            if agent_cwd_key(name) {
                directories.extend(strings(Some(value)));
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

    pub fn filter(
        &mut self,
        records: &[Map<String, Value>],
        agent: &str,
    ) -> Vec<Map<String, Value>> {
        if self.roots.is_empty() {
            return records.to_vec();
        }
        for record in records {
            let _ = self.allows(record, agent);
        }
        records
            .iter()
            .filter(|record| self.allows(record, agent))
            .cloned()
            .collect()
    }

    pub fn filter_string_rows(
        &mut self,
        rows: Vec<HashMap<String, String>>,
        agent: &str,
    ) -> Vec<HashMap<String, String>> {
        let maps: Vec<Map<String, Value>> = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect()
            })
            .collect();
        for record in &maps {
            let _ = self.allows(record, agent);
        }
        rows.into_iter()
            .zip(maps)
            .filter(|(_, record)| self.allows(record, agent))
            .map(|(row, _)| row)
            .collect()
    }

    fn excludes(&self, directory: &str) -> bool {
        let Some(candidate) = normalize_path(directory) else {
            return false;
        };
        self.roots.iter().any(|root| {
            within(&candidate, root) || within(&real_path(&candidate), &real_path(root))
        })
    }

    fn persist_marker(&mut self, marker: &str) {
        let path = Path::new(marker);
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_ok() && std::fs::write(path, b"").is_ok() {
                self.pending_markers.remove(marker);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                }
                return;
            }
        }
        self.pending_markers.insert(marker.to_string());
        let now = now_ms();
        self.next_retry_at = now + 5_000;
        if now >= self.next_warning_at {
            self.next_warning_at = now + 60_000;
            let _ = std::io::Write::write_all(
                &mut std::io::stderr(),
                b"[workspace-privacy] Cannot persist session exclusions; blocked in this process, restart/other-process protection may be unavailable. Retrying on subsequent events.\n",
            );
        }
    }

    fn retry_pending_markers(&mut self) {
        if self.pending_markers.is_empty() || now_ms() < self.next_retry_at {
            return;
        }
        self.next_retry_at = now_ms() + 5_000;
        let batch: Vec<String> = self.pending_markers.iter().take(8).cloned().collect();
        for marker in batch {
            self.pending_markers.remove(&marker);
            self.persist_marker(&marker);
        }
    }
}

pub fn validate_excluded_workspaces(value: &[String]) -> Result<Vec<String>, String> {
    if value.iter().any(|path| !Path::new(path).is_absolute()) {
        return Err(
            "privacy.excludeWorkspaces must be an array of absolute local directories".to_string(),
        );
    }
    let mut unique = Vec::new();
    for path in value {
        if !unique.iter().any(|existing: &String| existing == path) {
            unique.push(path.clone());
        }
    }
    Ok(unique)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Value::String(text) if text.is_empty() => Vec::new(),
        Value::String(text) if text.starts_with('[') => serde_json::from_str::<Value>(text)
            .ok()
            .map(|parsed| strings(Some(&parsed)))
            .unwrap_or_default(),
        Value::String(text) => vec![text.clone()],
        _ => Vec::new(),
    }
}

fn agent_cwd_key(name: &str) -> bool {
    let mut parts = name.split('.');
    parts.next() == Some("agent")
        && parts
            .next()
            .is_some_and(|part| !part.is_empty() && !part.contains('.'))
        && matches!(parts.next(), Some("cwd") | Some("workspace_roots"))
        && parts.next().is_none()
}

fn normalize_path(value: &str) -> Option<String> {
    let expanded = if let Some(rest) = value.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/{rest}")
    } else {
        value.to_string()
    };
    if !Path::new(&expanded).is_absolute() {
        return None;
    }
    Some(normalize_lexical(&expanded))
}

fn normalize_lexical(path: &str) -> String {
    let mut normalized = std::path::PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    let value = normalized.to_string_lossy().into_owned();
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

fn real_path(value: &str) -> String {
    match std::fs::canonicalize(value) {
        Ok(path) => normalize_lexical(&path.to_string_lossy()),
        Err(_) => {
            let parent = Path::new(value)
                .parent()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default();
            if parent == value || parent.is_empty() {
                value.to_string()
            } else {
                let base = Path::new(value)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                format!("{}/{}", real_path(&parent).trim_end_matches('/'), base)
            }
        }
    }
}

fn within(candidate: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    candidate == root || candidate.starts_with(&format!("{root}/"))
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod migration_contract_tests {
    use super::*;
    use serde_json::json;

    fn event(session: &str, cwd: Option<&Path>) -> Map<String, Value> {
        let mut record = json!({"gen_ai.agent.type":"codex","gen_ai.session.id":session})
            .as_object()
            .unwrap()
            .clone();
        if let Some(cwd) = cwd {
            record.insert("agent.codex.cwd".into(), json!(cwd.to_string_lossy()));
        }
        record
    }
    fn policy(root: &Path, state: Option<&Path>) -> WorkspacePolicy {
        WorkspacePolicy::new(
            &[root.to_string_lossy().into_owned()],
            state.map(|p| p.to_string_lossy().into_owned()),
        )
        .unwrap()
    }
    #[test]
    fn matches_directory_and_descendants_without_sibling_or_relative_prefixes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("private");
        let policy = policy(&root, None);
        assert!(policy.excludes(&root.to_string_lossy()));
        assert!(policy.excludes(&root.join("app").join("..").join("other").to_string_lossy()));
        assert!(!policy.excludes(&directory.path().join("private-copy").to_string_lossy()));
        assert!(!policy.excludes("private"));
    }
    #[cfg(unix)]
    fn link_directory(target: &Path, alias: &Path) {
        std::os::unix::fs::symlink(target, alias).unwrap();
    }
    #[cfg(windows)]
    fn link_directory(target: &Path, alias: &Path) {
        crate::utils::windows_test_junction::create(
            target,
            alias,
            std::time::Duration::from_secs(30),
        );
    }
    #[test]
    fn resolves_directory_links_including_not_yet_created_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("private with spaces");
        let alias = directory.path().join("alias with spaces");
        std::fs::create_dir(&root).unwrap();
        link_directory(&root, &alias);
        assert!(policy(&root, None).excludes(&alias.join("not-created").to_string_lossy()));
        assert!(policy(&alias, None).excludes(&root.to_string_lossy()));
    }
    #[test]
    fn unknown_workspace_does_not_scan_prompt_tool_arguments_or_inferred_git_roots() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy(directory.path(), None);
        let mut unknown = event("unknown", None);
        unknown.insert(
            "gen_ai.input.messages".into(),
            json!(directory.path().to_string_lossy()),
        );
        unknown.insert(
            "workspace.current_root".into(),
            json!(directory.path().to_string_lossy()),
        );
        unknown.insert(
            "gen_ai.tool.call.arguments".into(),
            json!({"path":directory.path()}),
        );
        assert!(policy.allows(&unknown, ""));
        assert!(policy.allows(
            &event("public", Some(&directory.path().join("../public"))),
            ""
        ));
    }
    #[test]
    fn explicit_workspace_arrays_and_json_encoded_roots_block_the_event() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy(directory.path(), None);
        let mut encoded = event("encoded", None);
        encoded.insert(
            "agent.cursor.workspace_roots".into(),
            json!(serde_json::to_string(&json!(["/public", directory.path()])).unwrap()),
        );
        assert!(!policy.allows(&encoded, ""));
        assert!(!policy.allows(
            json!({"workspace_roots":["/public",directory.path()]})
                .as_object()
                .unwrap(),
            ""
        ));
    }
    #[test]
    fn session_markers_are_shared_across_instances_and_restart_without_cross_agent_or_plaintext_leaks(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let state = directory.path().join("state");
        let mut collector = policy(&private, Some(&state));
        let mut hook = policy(&private, Some(&state));
        assert!(collector.allows(&event("one", None), ""));
        assert!(!hook.allows(&event("one", Some(&private)), ""));
        assert!(!collector.allows(&event("one", Some(&directory.path().join("public"))), ""));
        assert!(collector.allows(&event("two", None), ""));
        assert!(!policy(&private, Some(&state)).allows(&event("one", None), ""));
        assert!(
            WorkspacePolicy::new(&[], Some(state.to_string_lossy().into_owned()))
                .unwrap()
                .allows(&event("one", None), "")
        );
        let mut other_agent = event("one", None);
        other_agent.insert("gen_ai.agent.type".into(), json!("cursor"));
        assert!(collector.allows(&other_agent, ""));
        let names = std::fs::read_dir(&state)
            .unwrap()
            .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(",");
        assert!(!names.contains("private"));
        let inner = std::fs::read_dir(state.join(&collector.fingerprint))
            .unwrap()
            .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(",");
        assert!(!inner.contains("one"));
        assert!(!inner.contains("private"));
    }
    #[test]
    fn whole_batch_preflight_blocks_early_unknown_records_for_a_later_denied_session() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy(directory.path(), None);
        let unknown = event("late", None);
        let denied = event("late", Some(directory.path()));
        let allowed = event("other", None);
        assert_eq!(
            policy.filter(&[unknown, allowed.clone(), denied], ""),
            vec![allowed]
        );
    }
    #[test]
    fn relative_rules_are_rejected_and_absent_rule_list_is_empty() {
        assert!(validate_excluded_workspaces(&["relative".into()]).is_err());
        assert!(validate_excluded_workspaces(&[]).unwrap().is_empty());
    }
    #[test]
    fn marker_failures_keep_private_sessions_blocked_and_retry_without_dropping_public_events() {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private");
        let state = directory.path().join("blocked-state");
        std::fs::write(&state, b"a file prevents directory creation").unwrap();
        let mut policy = policy(&private, Some(&state));
        let public = event("public", Some(&directory.path().join("public")));
        assert_eq!(
            policy.filter(&[event("private", Some(&private)), public.clone()], ""),
            vec![public.clone()]
        );
        assert!(!policy.allows(&event("private", None), ""));
        assert_eq!(policy.pending_markers.len(), 1);
        let warning_deadline = policy.next_warning_at;
        assert!(warning_deadline > now_ms());
        assert_eq!(
            policy.filter(std::slice::from_ref(&public), ""),
            vec![public.clone()]
        );
        assert_eq!(policy.next_warning_at, warning_deadline);
        std::fs::remove_file(&state).unwrap();
        policy.next_retry_at = 0; // deterministic equivalent of the historical fake-clock advance
        assert_eq!(
            policy.filter(std::slice::from_ref(&public), ""),
            vec![public]
        );
        assert!(policy.pending_markers.is_empty());
        assert!(!WorkspacePolicy::new(
            &[private.to_string_lossy().into_owned()],
            Some(state.to_string_lossy().into_owned())
        )
        .unwrap()
        .allows(&event("private", None), ""));
    }
    #[test]
    fn identified_sessions_cross_pipeline_fallbacks_but_other_agents_and_anonymous_sources_are_isolated(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy(directory.path(), Some(&directory.path().join("markers")));
        assert!(!policy.allows(&event("same-session", Some(directory.path())), "file:first"));
        assert!(!policy.allows(&event("same-session", None), "file:second"));
        let mut cursor = event("same-session", None);
        cursor.insert("gen_ai.agent.type".into(), json!("cursor"));
        assert!(policy.allows(&cursor, "file:second"));
        assert!(policy.allows(
            json!({"session_id":"same-session"}).as_object().unwrap(),
            "file:second"
        ));
    }
    #[test]
    fn rule_changes_take_effect_when_policy_is_recreated_on_restart() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first-private");
        let new = directory.path().join("new-private");
        let mut roots = vec![first.to_string_lossy().into_owned()];
        let mut running = WorkspacePolicy::new(&roots, None).unwrap();
        roots.push(new.to_string_lossy().into_owned());
        assert!(running.allows(&event("new", Some(&new)), ""));
        assert!(!WorkspacePolicy::new(&roots, None)
            .unwrap()
            .allows(&event("new", Some(&new)), ""));
    }
}

#[cfg(test)]
mod privacy_path_edge_regressions {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    #[test]
    fn excluding_the_filesystem_root_blocks_all_absolute_workspace_descendants() {
        let mut policy = WorkspacePolicy::new(&["/".into()], None).unwrap();
        let directory = tempfile::tempdir().unwrap();
        assert!(!policy.allows(
            json!({"gen_ai.agent.type":"codex","gen_ai.session.id":"root-private",
            "agent.codex.cwd":directory.path().join("not-created")})
            .as_object()
            .unwrap(),
            ""
        ));
    }
    #[cfg(windows)]
    #[test]
    fn windows_workspace_exclusions_are_case_insensitive_even_when_descendants_do_not_exist() {
        let directory = tempfile::tempdir().unwrap();
        let mixed = directory.path().join("MiXeD-Private-Not-Created");
        let lower = mixed.to_string_lossy().to_ascii_lowercase();
        let mut policy =
            WorkspacePolicy::new(&[mixed.to_string_lossy().into_owned()], None).unwrap();
        assert!(!policy.allows(
            json!({"gen_ai.agent.type":"codex","gen_ai.session.id":"case-private",
            "agent.codex.cwd":std::path::Path::new(&lower).join("not-created")})
            .as_object()
            .unwrap(),
            ""
        ));
    }
}

#[cfg(test)]
mod marker_stderr_history_contract {
    use super::*;
    #[tokio::test]
    async fn real_marker_failure_warns_once_without_paths_and_recovers_while_public_events_survive()
    {
        const FLAG: &str = "PILOT_WORKSPACE_STDERR_HISTORY_ROOT";
        if let Some(directory) = std::env::var_os(FLAG) {
            let directory = std::path::PathBuf::from(directory);
            let private = directory.join("private");
            let state = directory.join("blocked-state");
            std::fs::write(&state, b"a real file prevents directory creation").unwrap();
            let mut policy = WorkspacePolicy::new(
                &[private.to_string_lossy().into_owned()],
                Some(state.to_string_lossy().into_owned()),
            )
            .unwrap();
            let event = |session: &str, cwd: Option<&std::path::Path>| {
                let mut row =
                    serde_json::json!({"gen_ai.agent.type":"codex","gen_ai.session.id":session})
                        .as_object()
                        .unwrap()
                        .clone();
                if let Some(cwd) = cwd {
                    row.insert("agent.codex.cwd".into(), serde_json::json!(cwd));
                }
                row
            };
            let public = event("public", Some(&directory.join("public")));
            assert_eq!(
                policy.filter(&[event("private", Some(&private)), public.clone()], ""),
                vec![public.clone()]
            );
            assert!(!policy.allows(&event("private", None), ""));
            assert_eq!(policy.pending_markers.len(), 1);
            assert_eq!(
                policy.filter(std::slice::from_ref(&public), ""),
                vec![public.clone()]
            );
            std::fs::remove_file(&state).unwrap();
            // Same deterministic deadline seam as the original fake-clock test.
            policy.next_retry_at = 0;
            assert_eq!(
                policy.filter(std::slice::from_ref(&public), ""),
                vec![public]
            );
            assert!(policy.pending_markers.is_empty());
            let mut restored = WorkspacePolicy::new(
                &[private.to_string_lossy().into_owned()],
                Some(state.to_string_lossy().into_owned()),
            )
            .unwrap();
            assert!(!restored.allows(&event("private", None), ""));
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let name = std::thread::current().name().unwrap().to_owned();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &name, "--nocapture"])
            .env_clear()
            .env(FLAG, directory.path())
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("appdata"))
            .env("LOCALAPPDATA", home.join("localappdata"))
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .env("XDG_DATA_HOME", home.join("data"))
            .env("CODEX_HOME", home.join("codex"))
            .env("CLAUDE_CONFIG_DIR", home.join("claude"))
            .env("PATH", home.join("no-runtimes"))
            .current_dir(&home)
            .kill_on_drop(true);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "ComSpec",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        let warnings = stderr
            .lines()
            .filter(|line| line.contains("[workspace-privacy]"))
            .collect::<Vec<_>>();
        assert_eq!(warnings.len(), 1, "{stderr}");
        assert!(warnings[0].contains("Cannot persist session exclusions"));
        assert!(
            !stderr.contains(&*directory.path().to_string_lossy()),
            "{stderr}"
        );
    }
}
