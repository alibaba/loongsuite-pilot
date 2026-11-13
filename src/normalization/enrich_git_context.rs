use super::source_context::normalize_domain;
use crate::types::AgentActivityEntry;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GIT_CONTEXT_TTL_MS: i64 = 30_000;
const MAX_CACHE_ENTRIES: usize = 256;
const GIT_TIMEOUT: Duration = Duration::from_millis(1500);
const GIT_MAX_BUFFER: usize = 64 * 1024;

const NAMESPACE_ALIASES: &[(&str, &[&str])] = &[
    ("cursor-cli", &["cursor-cli", "cursor_cli"]),
    ("cursor_cli", &["cursor_cli", "cursor-cli"]),
    ("qoder-cli", &["qoder-cli", "qoder"]),
    ("qoder-app", &["qoder-app", "qoder-cli", "qoder"]),
    ("qoder-idea", &["qoder-idea", "qoder"]),
    ("qoder-cn", &["qoder-cn", "qodercn", "qoder"]),
    ("qodercn", &["qodercn", "qoder-cn", "qoder"]),
    ("qoder-work", &["qoder-work", "qoderwork"]),
    ("qoder-work-cn", &["qoder-work-cn", "qoderwork"]),
    ("qwen-work-cn", &["qwen-work-cn", "qwenworkcn"]),
];

static SSH_REPO: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^[^@]+@[^:]+:(.+)$").expect("ssh repo"));
static HTTPS_PREFIX: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^https?://[^/]+/").expect("https prefix"));
static GIT_SUFFIX: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"\.git$").expect("git suffix"));

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitContextResult {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub root: Option<String>,
    pub domain: Option<String>,
}

struct GitCacheEntry {
    expires_at: i64,
    result: GitContextResult,
}

struct GitCache {
    order: Vec<String>,
    values: HashMap<String, GitCacheEntry>,
}

impl GitCache {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            values: HashMap::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&GitCacheEntry> {
        self.values.get(key)
    }

    fn insert(&mut self, key: String, value: GitCacheEntry) {
        match self.values.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                entry.insert(value);
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                self.order.push(entry.key().clone());
                entry.insert(value);
            }
        }
    }

    fn remove(&mut self, key: &str) {
        if self.values.remove(key).is_some() {
            self.order.retain(|existing| existing != key);
        }
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn evict(&mut self, now: i64) {
        if self.len() <= MAX_CACHE_ENTRIES {
            return;
        }
        let order = self.order.clone();
        let expired = order
            .iter()
            .filter(|key| {
                self.values
                    .get(key.as_str())
                    .is_some_and(|entry| entry.expires_at <= now)
            })
            .cloned()
            .collect::<Vec<_>>();
        for key in expired {
            self.remove(&key);
        }
        if self.len() <= MAX_CACHE_ENTRIES {
            return;
        }
        let order = self.order.clone();
        let mut ranked = order
            .iter()
            .filter_map(|key| {
                self.values
                    .get(key)
                    .map(|entry| (key.clone(), entry.expires_at))
            })
            .collect::<Vec<_>>();
        ranked.sort_by_key(|entry| entry.1);
        let overflow = self.len() - MAX_CACHE_ENTRIES;
        for (key, _) in ranked.into_iter().take(overflow) {
            self.remove(&key);
        }
    }
}

fn git_cache() -> &'static Mutex<GitCache> {
    static CACHE: OnceLock<Mutex<GitCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(GitCache::new()))
}

pub trait IntoNamespaces {
    fn into_namespaces(self) -> Vec<String>;
}

impl IntoNamespaces for &str {
    fn into_namespaces(self) -> Vec<String> {
        vec![self.to_string()]
    }
}

impl IntoNamespaces for String {
    fn into_namespaces(self) -> Vec<String> {
        vec![self]
    }
}

impl<'a> IntoNamespaces for &'a [&'a str] {
    fn into_namespaces(self) -> Vec<String> {
        self.iter().map(|value| (*value).to_string()).collect()
    }
}

impl IntoNamespaces for Vec<String> {
    fn into_namespaces(self) -> Vec<String> {
        self
    }
}

/// Fill missing canonical git and workspace fields from `entry` and `record`.
///
/// `namespace` is a producer id or a list of them. Aliases such as `qoder-cn`
/// also probe `agent.qoder.cwd`. Inference fills only fields that are still
/// empty. When `git.repo` and `git.branch` are already set, git is not run,
/// but an absolute probe directory can still become `workspace.path`.
#[allow(clippy::unused_async)]
pub async fn enrich_canonical_entry_with_git(
    entry: &mut AgentActivityEntry,
    record: &Map<String, Value>,
    namespace: impl IntoNamespaces,
) -> Result<(), String> {
    if crate::utils::source_access::current().is_some() {
        return Ok(());
    }
    let mut infer = |dir: &str| Ok(infer_git_context_sync(dir));
    enrich_entry_using(entry, record, namespace, &mut infer)
}

/// Last-mile enrichment for inputs that emit canonical agent records directly.
///
/// A failed probe is logged and skipped. Later entries in the batch still run.
#[allow(clippy::unused_async)]
pub async fn enrich_canonical_entries_with_git(entries: &mut [AgentActivityEntry]) {
    enrich_canonical_entries_with_git_using(entries, |dir| Ok(infer_git_context_sync(dir)));
}

/// Infer git repo, branch, domain, and root for a directory.
///
/// Repeated probes, including directories that are not repositories, are cached
/// for 30 seconds. Each git command is allowed to fail on its own so a missing
/// remote still returns the branch and root.
#[allow(clippy::unused_async)]
pub async fn infer_git_context(probe_dir: &str) -> GitContextResult {
    infer_git_context_sync(probe_dir)
}

fn enrich_canonical_entries_with_git_using<F>(entries: &mut [AgentActivityEntry], mut infer: F)
where
    F: FnMut(&str) -> Result<GitContextResult, String>,
{
    for entry in entries.iter_mut() {
        if entry.agent_type.is_empty() {
            continue;
        }
        let agent_type = entry.agent_type.clone();
        // Canonical lookup reads only the workspace and producer probe fields.
        // Preserve extra's fallback for missing/empty typed values without
        // materializing message bodies and every unrelated event field.
        let mut record = Map::new();
        if let Some(value) = entry.extra.get("workspace.path") {
            record.insert("workspace.path".to_owned(), value.clone());
        }
        for namespace in expand_namespaces(std::slice::from_ref(&agent_type)) {
            for key in [
                format!("agent.{namespace}.cwd"),
                format!("agent.{namespace}.workspace_roots"),
            ] {
                if let Some(value) = entry.extra.get(&key) {
                    record.insert(key, value.clone());
                }
            }
        }
        if let Err(err) = enrich_entry_using(entry, &record, agent_type.as_str(), &mut infer) {
            tracing::warn!(
                target: "GitContextEnrichment",
                error = %err,
                "git context enrichment failed for entry (skipped)"
            );
        }
    }
}

fn enrich_entry_using<F>(
    entry: &mut AgentActivityEntry,
    record: &Map<String, Value>,
    namespace: impl IntoNamespaces,
    infer: &mut F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<GitContextResult, String>,
{
    let namespaces = expand_namespaces(&namespace.into_namespaces());
    let probe_dir = extract_probe_dir(entry, record, &namespaces);
    if let Some(dir) = &probe_dir {
        if !truthy_string(entry.workspace_path.as_deref()) {
            entry.workspace_path = Some(dir.clone());
        }
    }
    if truthy_string(entry.git_repo.as_deref()) && truthy_string(entry.git_branch.as_deref()) {
        return Ok(());
    }
    let Some(dir) = probe_dir else {
        return Ok(());
    };
    let inferred = infer(&dir)?;
    apply_inferred(entry, inferred);
    Ok(())
}

fn apply_inferred(entry: &mut AgentActivityEntry, inferred: GitContextResult) {
    if !truthy_string(entry.git_repo.as_deref()) {
        if let Some(repo) = inferred.repo.filter(|value| !value.is_empty()) {
            entry.git_repo = Some(repo);
        }
    }
    if !truthy_string(entry.git_branch.as_deref()) {
        if let Some(branch) = inferred.branch.filter(|value| !value.is_empty()) {
            entry.git_branch = Some(branch);
        }
    }
    if !truthy_string(entry.git_domain.as_deref()) {
        if let Some(domain) = inferred.domain.filter(|value| !value.is_empty()) {
            entry.git_domain = Some(domain);
        }
    }
    if !truthy_string(entry.workspace_current_root.as_deref()) {
        if let Some(root) = inferred.root.filter(|value| !value.is_empty()) {
            entry.workspace_current_root = Some(root);
        }
    }
}

fn infer_git_context_sync(probe_dir: &str) -> GitContextResult {
    let now = now_millis();
    {
        let cache = git_cache().lock().unwrap_or_else(|err| err.into_inner());
        if let Some(hit) = cache.get(probe_dir) {
            if hit.expires_at > now {
                return hit.result.clone();
            }
        }
    }

    let root = run_git(probe_dir, &["rev-parse", "--show-toplevel"]);
    let git_root = root.clone();
    let command_root = git_root.as_deref().unwrap_or(probe_dir);
    let branch = normalize_branch(run_git(
        command_root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
    ));
    let remote = run_git(command_root, &["config", "--get", "remote.origin.url"]);
    let repo = normalize_git_repo(remote.as_deref());
    let domain = normalize_domain(remote.as_deref());
    let result = GitContextResult {
        repo,
        branch,
        root: git_root,
        domain,
    };

    let mut cache = git_cache().lock().unwrap_or_else(|err| err.into_inner());
    cache.evict(now);
    cache.insert(
        probe_dir.to_string(),
        GitCacheEntry {
            expires_at: now + GIT_CONTEXT_TTL_MS,
            result: result.clone(),
        },
    );
    result
}

fn run_git(root: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let mut stdout = child.stdout.take()?;
    let mut buffer = Vec::new();
    stdout.read_to_end(&mut buffer).ok()?;
    if buffer.len() > GIT_MAX_BUFFER {
        return None;
    }
    let text = String::from_utf8(buffer).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_branch(raw: Option<String>) -> Option<String> {
    match raw {
        Some(branch) if !branch.is_empty() && branch != "HEAD" => Some(branch),
        _ => None,
    }
}

fn normalize_git_repo(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let source = if let Some(caps) = SSH_REPO.captures(trimmed) {
        caps.get(1)
            .map(|item| item.as_str().to_string())
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    };
    let without_https = HTTPS_PREFIX.replace(&source, "");
    let without_git = GIT_SUFFIX.replace(&without_https, "");
    let stripped = without_git.trim_matches('/');
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn extract_probe_dir(
    entry: &AgentActivityEntry,
    record: &Map<String, Value>,
    namespaces: &[String],
) -> Option<String> {
    if let Some(workspace_path) = lookup_string(entry, record, "workspace.path") {
        if is_absolute_path(&workspace_path) {
            return Some(workspace_path);
        }
    }
    for candidate in namespaces {
        let cwd_key = format!("agent.{candidate}.cwd");
        if let Some(cwd) = lookup_string(entry, record, &cwd_key) {
            if is_absolute_path(&cwd) {
                return Some(cwd);
            }
        }
        let roots_key = format!("agent.{candidate}.workspace_roots");
        let roots_value = lookup_value(entry, record, &roots_key);
        let roots = normalize_string_array(roots_value.as_ref());
        if let Some(root) = roots.first() {
            if is_absolute_path(root) {
                return Some(root.clone());
            }
        }
    }
    None
}

fn expand_namespaces(requested: &[String]) -> Vec<String> {
    let mut expanded = Vec::new();
    for value in requested {
        for candidate in aliases_for(value) {
            if !expanded.iter().any(|existing| existing == &candidate) {
                expanded.push(candidate);
            }
        }
    }
    expanded
}

fn aliases_for(value: &str) -> Vec<String> {
    if let Some((_, aliases)) = NAMESPACE_ALIASES.iter().find(|(name, _)| *name == value) {
        return aliases.iter().map(|alias| (*alias).to_string()).collect();
    }
    vec![value.to_string()]
}

fn lookup_value(
    entry: &AgentActivityEntry,
    record: &Map<String, Value>,
    key: &str,
) -> Option<Value> {
    match entry_get(entry, key) {
        Some(Value::Null) | None => record.get(key).cloned(),
        Some(value) => Some(value),
    }
}

fn lookup_string(
    entry: &AgentActivityEntry,
    record: &Map<String, Value>,
    key: &str,
) -> Option<String> {
    nonempty_trimmed_string(entry_get(entry, key))
        .or_else(|| nonempty_trimmed_string(record.get(key).cloned()))
}

fn entry_get(entry: &AgentActivityEntry, key: &str) -> Option<Value> {
    match key {
        "workspace.path" => entry.workspace_path.clone().map(Value::String),
        "git.repo" => entry.git_repo.clone().map(Value::String),
        "git.branch" => entry.git_branch.clone().map(Value::String),
        "git.domain" => entry.git_domain.clone().map(Value::String),
        "workspace.current_root" => entry.workspace_current_root.clone().map(Value::String),
        "gen_ai.agent.type" => {
            if entry.agent_type.is_empty() {
                None
            } else {
                Some(Value::String(entry.agent_type.clone()))
            }
        }
        _ => entry.extra.get(key).cloned(),
    }
}

fn nonempty_trimmed_string(value: Option<Value>) -> Option<String> {
    let text = value?.as_str()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// JSON arrays keep the original element text when it is non-blank. A raw
/// string that is not a JSON array is trimmed. A JSON array value is trimmed.
fn normalize_string_array(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(raw) => {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) {
                return items
                    .into_iter()
                    .filter_map(|item| match item {
                        Value::String(text) if !text.trim().is_empty() => Some(text),
                        _ => None,
                    })
                    .collect();
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn truthy_string(value: Option<&str>) -> bool {
    value.is_some_and(|text| !text.is_empty())
}

fn is_absolute_path(value: &str) -> bool {
    is_posix_absolute(value) || is_win32_absolute(value)
}

fn is_posix_absolute(value: &str) -> bool {
    value.starts_with('/')
}

fn is_win32_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if bytes[0] == b'/' || bytes[0] == b'\\' {
        return true;
    }
    if bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return true;
    }
    false
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
    use serde_json::{json, Value};

    fn obj(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    #[test]
    fn sets_workspace_path_from_cwd_even_when_the_dir_is_not_a_git_repo() {
        let mut entry = AgentActivityEntry::default();
        let record = obj(json!({ "agent.opencode.cwd": "/Users/foo/not-a-repo" }));
        enrich_entry_using(&mut entry, &record, "opencode", &mut |_| {
            Ok(GitContextResult::default())
        })
        .unwrap();
        assert_eq!(
            entry.workspace_path.as_deref(),
            Some("/Users/foo/not-a-repo")
        );
        assert_eq!(entry.workspace_current_root, None);
        assert_eq!(entry.git_repo, None);
    }

    #[test]
    fn sets_workspace_path_and_git_root_in_a_git_repo() {
        let mut entry = AgentActivityEntry::default();
        let record = obj(json!({ "agent.opencode.cwd": "/Users/foo/proj/src" }));
        enrich_entry_using(&mut entry, &record, "opencode", &mut |_| {
            Ok(GitContextResult {
                repo: Some("org/proj".to_string()),
                branch: Some("main".to_string()),
                domain: Some("github.com".to_string()),
                root: Some("/Users/foo/proj".to_string()),
            })
        })
        .unwrap();
        assert_eq!(entry.workspace_path.as_deref(), Some("/Users/foo/proj/src"));
        assert_eq!(
            entry.workspace_current_root.as_deref(),
            Some("/Users/foo/proj")
        );
        assert_eq!(entry.git_repo.as_deref(), Some("org/proj"));
        assert_eq!(entry.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn accepts_windows_absolute_cwd_paths() {
        let mut entry = AgentActivityEntry::default();
        let record = obj(json!({ "agent.opencode.cwd": "C:\\Users\\foo\\proj\\src" }));
        let mut seen = Vec::new();
        enrich_entry_using(&mut entry, &record, "opencode", &mut |dir| {
            seen.push(dir.to_string());
            Ok(GitContextResult {
                repo: Some("org/win-proj".to_string()),
                branch: Some("feature/windows".to_string()),
                domain: Some("github.com".to_string()),
                root: Some(r"C:\Users\foo\proj".to_string()),
            })
        })
        .unwrap();
        assert_eq!(seen, vec![r"C:\Users\foo\proj\src"]);
        assert_eq!(
            entry.workspace_path.as_deref(),
            Some(r"C:\Users\foo\proj\src")
        );
        assert_eq!(
            entry.workspace_current_root.as_deref(),
            Some(r"C:\Users\foo\proj")
        );
        assert_eq!(entry.git_repo.as_deref(), Some("org/win-proj"));
    }

    #[test]
    fn accepts_windows_absolute_workspace_roots_when_cwd_is_absent() {
        let mut entry = AgentActivityEntry::default();
        let encoded = serde_json::to_string(&vec![r"\\server\share\repo"]).unwrap();
        let record = obj(json!({ "agent.opencode.workspace_roots": encoded }));
        let mut seen = Vec::new();
        enrich_entry_using(&mut entry, &record, "opencode", &mut |dir| {
            seen.push(dir.to_string());
            Ok(GitContextResult {
                root: Some(r"\\server\share\repo".to_string()),
                ..GitContextResult::default()
            })
        })
        .unwrap();
        assert_eq!(seen, vec![r"\\server\share\repo"]);
        assert_eq!(
            entry.workspace_path.as_deref(),
            Some(r"\\server\share\repo")
        );
        assert_eq!(
            entry.workspace_current_root.as_deref(),
            Some(r"\\server\share\repo")
        );
    }

    #[test]
    fn does_not_run_git_when_repo_and_branch_are_present_but_still_sets_workspace_path() {
        let mut entry = AgentActivityEntry {
            git_repo: Some("org/proj".to_string()),
            git_branch: Some("main".to_string()),
            ..AgentActivityEntry::default()
        };
        let record = obj(json!({ "agent.opencode.cwd": "/Users/foo/proj" }));
        let mut calls = 0;
        enrich_entry_using(&mut entry, &record, "opencode", &mut |_| {
            calls += 1;
            Ok(GitContextResult::default())
        })
        .unwrap();
        assert_eq!(calls, 0);
        assert_eq!(entry.workspace_path.as_deref(), Some("/Users/foo/proj"));
    }

    #[test]
    fn does_not_overwrite_an_existing_workspace_path() {
        let mut entry = AgentActivityEntry {
            workspace_path: Some("/already/set".to_string()),
            ..AgentActivityEntry::default()
        };
        let record = obj(json!({ "agent.opencode.cwd": "/Users/foo/other" }));
        enrich_entry_using(&mut entry, &record, "opencode", &mut |_| {
            Ok(GitContextResult::default())
        })
        .unwrap();
        assert_eq!(entry.workspace_path.as_deref(), Some("/already/set"));
    }

    #[test]
    fn ignores_non_absolute_cwd() {
        let mut entry = AgentActivityEntry::default();
        let record = obj(json!({ "agent.opencode.cwd": "relative/dir" }));
        let mut calls = 0;
        enrich_entry_using(&mut entry, &record, "opencode", &mut |_| {
            calls += 1;
            Ok(GitContextResult::default())
        })
        .unwrap();
        assert_eq!(entry.workspace_path, None);
        assert_eq!(calls, 0);
    }

    #[test]
    fn resolves_producer_namespace_aliases() {
        let cases = [
            ("qoder-work", "agent.qoderwork.cwd"),
            ("qoder-work-cn", "agent.qoderwork.cwd"),
            ("qwen-work-cn", "agent.qwenworkcn.cwd"),
            ("qoder-cn", "agent.qoder.cwd"),
            ("cursor-cli", "agent.cursor_cli.cwd"),
        ];
        for (namespace, cwd_key) in cases {
            let mut entry = AgentActivityEntry::default();
            let mut record = Map::new();
            record.insert(cwd_key.to_string(), json!("/workspace/aliased"));
            let mut seen = Vec::new();
            enrich_entry_using(&mut entry, &record, namespace, &mut |dir| {
                seen.push(dir.to_string());
                Ok(GitContextResult::default())
            })
            .unwrap();
            assert_eq!(
                entry.workspace_path.as_deref(),
                Some("/workspace/aliased"),
                "{namespace}"
            );
            assert_eq!(seen, vec!["/workspace/aliased".to_string()], "{namespace}");
        }
    }

    #[test]
    fn last_mile_enriches_entries_from_agent_type_or_workspace_path() {
        let mut first = AgentActivityEntry {
            agent_type: "codex".to_string(),
            ..AgentActivityEntry::default()
        };
        first.extra.insert(
            "agent.codex.cwd".to_string(),
            json!("/workspace/codex-project/src"),
        );
        let mut second = AgentActivityEntry {
            agent_type: "cursor".to_string(),
            workspace_path: Some("/workspace/cursor-project".to_string()),
            ..AgentActivityEntry::default()
        };
        second.extra.insert(
            "agent.cursor.cwd".to_string(),
            json!("/workspace/cursor-project"),
        );
        let mut entries = vec![first, second];
        let mut calls = Vec::new();
        enrich_canonical_entries_with_git_using(&mut entries, |dir| {
            calls.push(dir.to_string());
            if dir.ends_with("/src") {
                Ok(GitContextResult {
                    repo: Some("org/codex-project".to_string()),
                    branch: Some("feature/codex".to_string()),
                    domain: Some("github.com".to_string()),
                    root: Some("/workspace/codex-project".to_string()),
                })
            } else {
                Ok(GitContextResult::default())
            }
        });
        assert_eq!(
            entries[0].workspace_path.as_deref(),
            Some("/workspace/codex-project/src")
        );
        assert_eq!(
            entries[0].workspace_current_root.as_deref(),
            Some("/workspace/codex-project")
        );
        assert_eq!(entries[0].git_repo.as_deref(), Some("org/codex-project"));
        assert_eq!(entries[0].git_branch.as_deref(), Some("feature/codex"));
        assert_eq!(entries[0].git_domain.as_deref(), Some("github.com"));
        assert_eq!(
            calls,
            vec![
                "/workspace/codex-project/src".to_string(),
                "/workspace/cursor-project".to_string()
            ]
        );
    }

    #[test]
    fn continues_enriching_later_entries_when_one_git_probe_fails() {
        let mut first = AgentActivityEntry {
            agent_type: "codex".to_string(),
            ..AgentActivityEntry::default()
        };
        first.extra.insert(
            "agent.codex.cwd".to_string(),
            json!("/workspace/failing-project"),
        );
        let mut second = AgentActivityEntry {
            agent_type: "codex".to_string(),
            ..AgentActivityEntry::default()
        };
        second.extra.insert(
            "agent.codex.cwd".to_string(),
            json!("/workspace/healthy-project"),
        );
        let mut entries = vec![first, second];
        let mut calls = 0;
        enrich_canonical_entries_with_git_using(&mut entries, |_| {
            calls += 1;
            if calls == 1 {
                Err("git probe failed".to_string())
            } else {
                Ok(GitContextResult {
                    repo: Some("org/healthy-project".to_string()),
                    branch: Some("main".to_string()),
                    domain: Some("github.com".to_string()),
                    root: Some("/workspace/healthy-project".to_string()),
                })
            }
        });
        assert_eq!(
            entries[0].workspace_path.as_deref(),
            Some("/workspace/failing-project")
        );
        assert_eq!(entries[0].git_repo, None);
        assert_eq!(
            entries[1].workspace_path.as_deref(),
            Some("/workspace/healthy-project")
        );
        assert_eq!(
            entries[1].workspace_current_root.as_deref(),
            Some("/workspace/healthy-project")
        );
        assert_eq!(entries[1].git_repo.as_deref(), Some("org/healthy-project"));
        assert_eq!(entries[1].git_branch.as_deref(), Some("main"));
        assert_eq!(entries[1].git_domain.as_deref(), Some("github.com"));
    }
}
