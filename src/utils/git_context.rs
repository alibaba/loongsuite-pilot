//! Port of `src/utils/git-context.ts`.
//!
//! `normalizeDomain` is copied from `src/normalization/source-context.ts` so this
//! module does not depend on the normalization crate area, which is not ported yet.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const GIT_CONTEXT_TTL_MS: u128 = 30_000;
const MAX_CACHE_ENTRIES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitContextResult {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub root: Option<String>,
    pub domain: Option<String>,
}

struct CacheEntry {
    expires_at: u128,
    seq: u64,
    result: GitContextResult,
}

struct TtlValue<V> {
    value: V,
    expires_at: u128,
    seq: u64,
}

/// Bounded map. Eviction uses the module cap of 256, matching `evictStaleEntries`,
/// not the constructor's `max_entries` (that value only decides when to try).
pub struct BoundedTtlCache<V> {
    map: HashMap<String, TtlValue<V>>,
    max_entries: usize,
    seq: u64,
}

impl<V> BoundedTtlCache<V> {
    pub fn new(max_entries: usize) -> Self {
        Self {
            map: HashMap::new(),
            max_entries,
            seq: 0,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<&V> {
        let expired = self
            .map
            .get(key)
            .map(|entry| entry.expires_at <= now_ms())
            .unwrap_or(false);
        if expired {
            self.map.remove(key);
            return None;
        }
        self.map.get(key).map(|entry| &entry.value)
    }

    pub fn set(&mut self, key: impl Into<String>, value: V, expires_at: u128) {
        self.seq = self.seq.saturating_add(1);
        let seq = self.seq;
        self.map.insert(
            key.into(),
            TtlValue {
                value,
                expires_at,
                seq,
            },
        );
        if self.map.len() > self.max_entries {
            evict_stale_ttl(&mut self.map);
        }
    }

    pub fn delete(&mut self, key: &str) {
        self.map.remove(key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

fn evict_stale_ttl<V>(cache: &mut HashMap<String, TtlValue<V>>) {
    if cache.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let now = now_ms();
    cache.retain(|_, entry| entry.expires_at > now);
    if cache.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut entries: Vec<(String, u128, u64)> = cache
        .iter()
        .map(|(key, entry)| (key.clone(), entry.expires_at, entry.seq))
        .collect();
    entries.sort_by(|left, right| left.1.cmp(&right.1).then(left.2.cmp(&right.2)));
    let remove_count = cache.len() - MAX_CACHE_ENTRIES;
    for (key, _, _) in entries.into_iter().take(remove_count) {
        cache.remove(&key);
    }
}

fn git_cache() -> &'static Mutex<(HashMap<String, CacheEntry>, u64)> {
    static CACHE: std::sync::OnceLock<Mutex<(HashMap<String, CacheEntry>, u64)>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new((HashMap::new(), 0)))
}

pub async fn infer_git_context(probe_dir: &str) -> GitContextResult {
    let now = now_ms();
    {
        let guard = git_cache().lock().unwrap_or_else(|err| err.into_inner());
        if let Some(cached) = guard.0.get(probe_dir) {
            if cached.expires_at > now {
                return cached.result.clone();
            }
        }
    }

    let root = run_git(probe_dir, &["rev-parse", "--show-toplevel"]).await;
    let git_root = root.filter(|text| !text.is_empty());
    let cwd = git_root.as_deref().unwrap_or(probe_dir);
    let branch = normalize_branch(run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await);
    let remote = run_git(cwd, &["config", "--get", "remote.origin.url"]).await;
    let repo = normalize_repo(remote.as_deref());
    let domain = normalize_domain(remote.as_deref());
    let result = GitContextResult {
        repo,
        branch,
        root: git_root,
        domain,
    };

    let mut guard = git_cache().lock().unwrap_or_else(|err| err.into_inner());
    evict_git(&mut guard.0);
    guard.1 = guard.1.saturating_add(1);
    let seq = guard.1;
    guard.0.insert(
        probe_dir.to_string(),
        CacheEntry {
            expires_at: now + GIT_CONTEXT_TTL_MS,
            seq,
            result: result.clone(),
        },
    );
    result
}

fn evict_git(cache: &mut HashMap<String, CacheEntry>) {
    if cache.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let now = now_ms();
    cache.retain(|_, entry| entry.expires_at > now);
    if cache.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut entries: Vec<(String, u128, u64)> = cache
        .iter()
        .map(|(key, entry)| (key.clone(), entry.expires_at, entry.seq))
        .collect();
    entries.sort_by(|left, right| left.1.cmp(&right.1).then(left.2.cmp(&right.2)));
    let remove_count = cache.len() - MAX_CACHE_ENTRIES;
    for (key, _, _) in entries.into_iter().take(remove_count) {
        cache.remove(&key);
    }
}

async fn run_git(root: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new("git");
    command.arg("-C").arg(root).args(args);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let child = command.spawn().ok()?;
    let finished = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        child.wait_with_output(),
    )
    .await;
    let output = match finished {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return None,
        Err(_) => return None,
    };
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn normalize_branch(raw: Option<String>) -> Option<String> {
    match raw {
        Some(value) if !value.is_empty() && value != "HEAD" => Some(value),
        _ => None,
    }
}

pub fn normalize_repo(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|value| !value.is_empty())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let owned_ssh = ssh_repo_path(trimmed);
    let source = owned_ssh.as_deref().unwrap_or(trimmed);
    let without_host = regex::Regex::new(r"^https?://[^/]+/")
        .ok()
        .map(|pattern| pattern.replace(source, "").into_owned())
        .unwrap_or_else(|| source.to_string());
    let without_git = without_host.strip_suffix(".git").unwrap_or(&without_host);
    let trimmed_slashes = without_git.trim_matches('/');
    Some(trimmed_slashes.to_string())
}

fn normalize_domain(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|value| !value.is_empty())?;
    if let Some(caps) = regex::Regex::new(r"^https?://([^/]+)")
        .ok()
        .and_then(|pattern| pattern.captures(raw))
    {
        return caps.get(1).map(|m| m.as_str().to_string());
    }
    if let Some(caps) = regex::Regex::new(r"^[^@]+@([^:]+)")
        .ok()
        .and_then(|pattern| pattern.captures(raw))
    {
        return caps.get(1).map(|m| m.as_str().to_string());
    }
    None
}

fn ssh_repo_path(trimmed: &str) -> Option<String> {
    let pattern = regex::Regex::new(r"^[^@]+@[^:]+:(.+)$").ok()?;
    let caps = pattern.captures(trimmed)?;
    caps.get(1).map(|m| m.as_str().to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{normalize_domain, normalize_repo, BoundedTtlCache};

    #[test]
    fn normalize_repo_strips_https_ssh_and_git_suffix() {
        assert_eq!(
            normalize_repo(Some("https://github.com/foo/bar.git")).as_deref(),
            Some("foo/bar")
        );
        assert_eq!(
            normalize_repo(Some("git@github.com:foo/bar.git")).as_deref(),
            Some("foo/bar")
        );
        assert_eq!(normalize_repo(Some("  ")), None);
        assert_eq!(normalize_repo(None), None);
        assert_eq!(
            normalize_repo(Some("/foo/bar/")).as_deref(),
            Some("foo/bar")
        );
    }

    #[test]
    fn normalize_domain_reads_https_host_and_ssh_host() {
        assert_eq!(
            normalize_domain(Some("https://github.com/foo/bar.git")).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            normalize_domain(Some("git@github.com:foo/bar.git")).as_deref(),
            Some("github.com")
        );
        assert_eq!(normalize_domain(Some("not a remote")), None);
        assert_eq!(normalize_domain(None), None);
    }

    #[test]
    fn bounded_cache_drops_expired_entries_on_get() {
        let mut cache = BoundedTtlCache::new(256);
        cache.set("old", 1u8, 1);
        assert!(cache.get("old").is_none());
        assert_eq!(cache.len(), 0);
        let future = super::now_ms() + 60_000;
        cache.set("live", 2u8, future);
        assert!(cache.get("live").is_some());
    }
}
