//! Marked YAML block in `$DSH_HOME/cordis.patch.yml`.

use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeployStrategy, DeployedAgentRecord,
    DshYamlPatchConfig,
};
use crate::utils::{create_logger, file_exists, resolve_home};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use super::dsh_runtime_locator::{DshRuntimeLocator, DshRuntimeTarget};
use super::paths::node_resolve;

pub const DSH_ENABLED_MARKER: &str = ".collection-enabled";
const BEGIN_PREFIX: &str = "# BEGIN ";
const END_PREFIX: &str = "# END ";
const LOCK_SUFFIX: &str = ".loongsuite-pilot.lock";
const LOCK_GATE_SUFFIX: &str = ".reclaim";
const LOCK_TIMEOUT: Duration = Duration::from_millis(2_000);
const LOCK_RETRY: Duration = Duration::from_millis(25);
const STALE_LOCK: Duration = Duration::from_secs(30);

fn logger() -> crate::utils::BoundLogger {
    create_logger("DshYamlPatchStrategy")
}

pub struct DshYamlPatchStrategy {
    data_dir: String,
    locator: DshRuntimeLocator,
}

impl DshYamlPatchStrategy {
    pub fn new(data_dir: String) -> Self {
        Self {
            data_dir,
            locator: DshRuntimeLocator::new(),
        }
    }

    pub fn with_locator(data_dir: String, locator: DshRuntimeLocator) -> Self {
        Self { data_dir, locator }
    }

    pub async fn resolve_target(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> Option<DshRuntimeTarget> {
        self.locator.locate(def, record).await.ok().flatten()
    }

    pub async fn detect_recorded(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        self.resolve_target(def, record).await.is_some()
    }

    pub async fn needs_deploy_at(&self, def: &AgentDefinition, target: &DshRuntimeTarget) -> bool {
        let Some(cfg) = &def.dsh_yaml_patch else {
            return false;
        };
        let plugin_path = resolve_home(&cfg.plugin_source);
        let Some(plugin_hash) = sha256_file(&plugin_path).await else {
            return true;
        };
        if !file_exists(&enabled_marker(cfg)).await {
            return true;
        }
        let plugin_url = file_url(&plugin_path);
        let bytes = read_bytes(&target.patch_path).await.unwrap_or_default();
        let parsed = split_on_pilot_block(&bytes, &cfg.marker);
        let Some(block) = parsed.existing_block else {
            return true;
        };
        if parsed.conflict
            || !has_line(&block, &format!("# entryId={}", cfg.entry_id))
            || !has_line(&block, &format!("# pluginSource={plugin_url}"))
            || !has_line(&block, &format!("# pluginHash={plugin_hash}"))
        {
            return true;
        }
        false
    }

    pub async fn deploy_at(
        &self,
        def: &AgentDefinition,
        target: &DshRuntimeTarget,
    ) -> DeployResult {
        let Some(cfg) = &def.dsh_yaml_patch else {
            return fail(def, "missing dshYamlPatch config");
        };
        let plugin_path = resolve_home(&cfg.plugin_source);
        let Some(plugin_hash) = sha256_file(&plugin_path).await else {
            return fail(
                def,
                &format!("plugin file not found or unreadable: {plugin_path}"),
            );
        };
        let Some(token) = acquire_patch_lock(&target.patch_path).await else {
            return fail(def, "timed out waiting for DSH patch lock");
        };
        let result = async {
            for _attempt in 0..2 {
                let original = read_bytes(&target.patch_path).await?;
                let existed = !original.is_empty() || file_exists(&target.patch_path).await;
                let h0 = sha256_bytes(&original);
                let mode = resolve_mode(&target.patch_path, existed).await;
                let parsed = split_on_pilot_block(&original, &cfg.marker);
                if parsed.conflict || parsed.existing_block.as_ref().is_some_and(|block| !has_line(block, &format!("# entryId={}", cfg.entry_id))) {
                    return Err(format!("conflict: existing block with marker {} is not Pilot-managed (path/id mismatch)", cfg.marker));
                }
                let created = match parsed.existing_block.as_ref().and_then(|block| extract_created_flag(block)) {
                    Some(flag) => flag,
                    None => !existed,
                };
                let new_block = compose_block(cfg, &plugin_hash, created);
                let next = if parsed.existing_block.is_some() {
                    let mut bytes = parsed.before.clone();
                    bytes.extend(new_block.as_bytes());
                    bytes.extend(&parsed.after);
                    bytes
                } else {
                    let mut bytes = original.clone();
                    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
                        bytes.push(b'\n');
                    }
                    bytes.extend(new_block.as_bytes());
                    bytes
                };
                if atomic_write_if_unchanged(&target.patch_path, &next, &h0, mode).await? {
                    create_enabled_marker(cfg).await?;
                    return Ok(());
                }
            }
            Err("concurrent modification detected; aborting after retry".into())
        }
        .await;
        release_patch_lock(&target.patch_path, &token).await;
        let _ = self.data_dir;
        match result {
            Ok(()) => DeployResult {
                success: true,
                agent_id: def.id.clone(),
                deploy_mode: DeployMode::DshYamlPatch,
                skipped: None,
                reason: None,
                error: None,
                plugin_inject_config_path: None,
            },
            Err(err) => fail(def, &err),
        }
    }

    pub async fn undeploy_recorded(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        let Some(cfg) = &def.dsh_yaml_patch else {
            return false;
        };
        let Some(target) = self.resolve_target(def, record).await else {
            return false;
        };
        if let Err(err) = remove_enabled_marker(cfg).await {
            eprintln!("DSH cleanup failed before patch lock: stage=enabled-marker error={err}");
            return false;
        }
        let initial = read_bytes(&target.patch_path).await.unwrap_or_default();
        if initial.is_empty() && !file_exists(&target.patch_path).await {
            return true;
        }
        let Some(token) = acquire_patch_lock(&target.patch_path).await else {
            return false;
        };
        let result: Result<bool, String> = async {
            for _ in 0..2 {
                let original = read_bytes(&target.patch_path).await?;
                if original.is_empty() && !file_exists(&target.patch_path).await {
                    return Ok(true);
                }
                let h0 = sha256_bytes(&original);
                let mode = resolve_mode(&target.patch_path, true).await;
                let parsed = split_on_pilot_block(&original, &cfg.marker);
                if parsed.conflict
                    || parsed.existing_block.as_ref().is_some_and(|block| {
                        !has_line(block, &format!("# entryId={}", cfg.entry_id))
                    })
                {
                    return Ok(false);
                }
                let Some(block) = parsed.existing_block else {
                    return Ok(true);
                };
                let mut next = parsed.before.clone();
                next.extend(&parsed.after);
                if extract_created_flag(&block) == Some(true)
                    && String::from_utf8_lossy(&next).trim().is_empty()
                {
                    if delete_if_unchanged(&target.patch_path, &h0).await? {
                        return Ok(true);
                    }
                    continue;
                }
                if atomic_write_if_unchanged(&target.patch_path, &next, &h0, mode).await? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        .await;
        release_patch_lock(&target.patch_path, &token).await;
        match result {
            Ok(result) => result,
            Err(err) => {
                eprintln!("DSH cleanup failed after patch lock: stage=patch-edit error={err}");
                false
            }
        }
    }
}

struct Split {
    before: Vec<u8>,
    existing_block: Option<String>,
    after: Vec<u8>,
    conflict: bool,
}

fn compose_block(cfg: &DshYamlPatchConfig, plugin_hash: &str, created_file: bool) -> String {
    let plugin_url = file_url(&resolve_home(&cfg.plugin_source));
    let flag = format!(
        " (created-file: {})",
        if created_file { "true" } else { "false" }
    );
    [
        format!("{BEGIN_PREFIX}{}{flag}", cfg.marker),
        format!("# entryId={}", cfg.entry_id),
        format!("# pluginSource={plugin_url}"),
        format!("# pluginHash={plugin_hash}"),
        "- insert:".into(),
        "  - id: 'loongsuite-pilot-observability'".into(),
        format!("    name: {plugin_url}"),
        format!("{END_PREFIX}{}", cfg.marker),
        String::new(),
    ]
    .join("\n")
}

fn split_on_pilot_block(bytes: &[u8], marker: &str) -> Split {
    let begin_marker = format!("{BEGIN_PREFIX}{marker}");
    let end_marker = format!("{END_PREFIX}{marker}");
    let begins = find_line_markers(bytes, &begin_marker);
    let ends = find_line_markers(bytes, &end_marker);
    if begins.is_empty() && ends.is_empty() {
        return Split {
            before: bytes.to_vec(),
            existing_block: None,
            after: Vec::new(),
            conflict: false,
        };
    }
    if begins.len() != 1 || ends.len() != 1 || ends[0] <= begins[0] {
        return Split {
            before: bytes.to_vec(),
            existing_block: None,
            after: Vec::new(),
            conflict: true,
        };
    }
    let begin_idx = begins[0];
    let end_idx = ends[0];
    let begin_line_end = line_end(bytes, begin_idx);
    let end_line_end = line_end(bytes, end_idx);
    let begin_line = String::from_utf8_lossy(&bytes[begin_idx..begin_line_end])
        .trim_end_matches('\r')
        .to_string();
    let end_line = String::from_utf8_lossy(&bytes[end_idx..end_line_end])
        .trim_end_matches('\r')
        .to_string();
    let mut block_end = end_line_end;
    if bytes.get(block_end) == Some(&b'\n') {
        block_end += 1;
    }
    let block = String::from_utf8_lossy(&bytes[begin_idx..block_end]).into_owned();
    let valid_begin = begin_line == begin_marker
        || begin_line == format!("{begin_marker} (created-file: true)")
        || begin_line == format!("{begin_marker} (created-file: false)");
    let conflict = !valid_begin
        || end_line != end_marker
        || !has_prefix(&block, "# entryId=")
        || !has_prefix(&block, "# pluginSource=")
        || !has_prefix(&block, "# pluginHash=");
    Split {
        before: bytes[..begin_idx].to_vec(),
        existing_block: Some(block),
        after: bytes[block_end..].to_vec(),
        conflict,
    }
}

fn find_line_markers(bytes: &[u8], marker: &str) -> Vec<usize> {
    let needle = marker.as_bytes();
    let mut offsets = Vec::new();
    let mut from = 0;
    while from < bytes.len() {
        let Some(rel) = bytes[from..]
            .windows(needle.len())
            .position(|window| window == needle)
        else {
            break;
        };
        let index = from + rel;
        let at_line = index == 0 || bytes[index - 1] == b'\n';
        let next = index + needle.len();
        let boundary = next == bytes.len() || matches!(bytes[next], b' ' | b'\t' | b'\r' | b'\n');
        if at_line && boundary {
            offsets.push(index);
        }
        from = index + needle.len();
    }
    offsets
}

fn line_end(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| start + index)
        .unwrap_or(bytes.len())
}

fn has_prefix(block: &str, prefix: &str) -> bool {
    block
        .split(['\n', '\r'])
        .any(|line| line.starts_with(prefix) && line.len() > prefix.len())
}

fn has_line(block: &str, expected: &str) -> bool {
    block.split(['\n', '\r']).any(|line| line == expected)
}

fn extract_created_flag(block: &str) -> Option<bool> {
    if block.contains("created-file: true") {
        Some(true)
    } else if block.contains("created-file: false") {
        Some(false)
    } else {
        None
    }
}

fn file_url(path: &str) -> String {
    let absolute = node_resolve(path);
    let mut url = String::from("file://");
    for byte in absolute.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                url.push(*byte as char)
            }
            other => url.push_str(&format!("%{other:02X}")),
        }
    }
    url
}

fn enabled_marker(cfg: &DshYamlPatchConfig) -> String {
    Path::new(&resolve_home(&cfg.plugin_source))
        .parent()
        .unwrap_or(Path::new("."))
        .join(DSH_ENABLED_MARKER)
        .to_string_lossy()
        .into_owned()
}

async fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err.to_string()),
    }
}

async fn resolve_mode(path: &str, existed: bool) -> u32 {
    #[cfg(not(unix))]
    let _ = path;
    if !existed {
        return 0o644;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = tokio::fs::metadata(path).await {
            return meta.permissions().mode() & 0o777;
        }
    }
    0o644
}

async fn sha256_file(path: &str) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(sha256_bytes(&bytes))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

async fn atomic_write_if_unchanged(
    target: &str,
    next: &[u8],
    h0: &str,
    mode: u32,
) -> Result<bool, String> {
    #[cfg(not(unix))]
    let _ = mode;
    if let Some(parent) = Path::new(target).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| err.to_string())?;
    }
    let current = read_bytes(target).await?;
    if sha256_bytes(&current) != h0 {
        return Ok(false);
    }
    let tmp = format!(
        "{target}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut file = options.open(&tmp).map_err(|err| err.to_string())?;
        use std::io::Write;
        file.write_all(next).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }
    let final_bytes = read_bytes(target).await?;
    if sha256_bytes(&final_bytes) != h0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Ok(false);
    }
    tokio::fs::rename(&tmp, target)
        .await
        .map_err(|err| err.to_string())?;
    sync_dir(Path::new(target).parent().unwrap_or(Path::new("."))).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(true)
}

async fn delete_if_unchanged(target: &str, h0: &str) -> Result<bool, String> {
    let current = read_bytes(target).await?;
    if sha256_bytes(&current) != h0 {
        return Ok(false);
    }
    let final_bytes = read_bytes(target).await?;
    if sha256_bytes(&final_bytes) != h0 {
        return Ok(false);
    }
    tokio::fs::remove_file(target)
        .await
        .map_err(|err| err.to_string())?;
    sync_dir(Path::new(target).parent().unwrap_or(Path::new("."))).await;
    Ok(true)
}

async fn create_enabled_marker(cfg: &DshYamlPatchConfig) -> Result<(), String> {
    let marker = enabled_marker(cfg);
    if let Some(parent) = Path::new(&marker).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| err.to_string())?;
    }
    let tmp = format!("{marker}.{}.tmp", std::process::id());
    tokio::fs::write(&tmp, "enabled\n")
        .await
        .map_err(|err| err.to_string())?;
    tokio::fs::rename(&tmp, &marker)
        .await
        .map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

async fn remove_enabled_marker(cfg: &DshYamlPatchConfig) -> Result<(), String> {
    let marker = enabled_marker(cfg);
    let deadline = Instant::now() + LOCK_TIMEOUT;
    loop {
        match tokio::fs::remove_file(&marker).await {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            // A concurrent DeleteFile can temporarily expose delete-pending as
            // access denied. Retrying the idempotent removal must still be
            // bounded; a genuinely protected marker remains a cleanup failure.
            Err(err)
                if cfg!(windows)
                    && matches!(err.raw_os_error(), Some(5 | 32 | 33 | 303))
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep(LOCK_RETRY).await
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

async fn acquire_patch_lock(target: &str) -> Option<String> {
    let lock_path = format!("{target}{LOCK_SUFFIX}");
    let gate_path = format!("{lock_path}{LOCK_GATE_SUFFIX}");
    if let Some(parent) = Path::new(&lock_path).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let token = format!("{}:{}", std::process::id(), uuid::Uuid::new_v4().simple());
    let deadline = Instant::now() + LOCK_TIMEOUT;
    while Instant::now() <= deadline {
        let gate = acquire_owner_file(&gate_path, deadline).await?;
        let acquired = match exclusive_token(&lock_path, &token).await {
            Ok(()) => true,
            Err(err) if err == "exists" => {
                if let Ok(meta) = tokio::fs::metadata(&lock_path).await {
                    if meta
                        .modified()
                        .ok()
                        .and_then(|time| SystemTime::now().duration_since(time).ok())
                        .is_some_and(|age| age > STALE_LOCK)
                    {
                        let _ = tokio::fs::remove_file(&lock_path).await;
                    }
                }
                false
            }
            Err(err) => {
                eprintln!("DSH lock acquire failed: {err}");
                false
            }
        };
        release_owner_file(&gate_path, &gate).await;
        if acquired {
            return Some(token);
        }
        tokio::time::sleep(LOCK_RETRY).await;
    }
    eprintln!(
        "DSH patch lock timed out: lock_exists={} gate_exists={}",
        Path::new(&lock_path).exists(),
        Path::new(&gate_path).exists()
    );
    None
}

async fn acquire_owner_file(path: &str, deadline: Instant) -> Option<String> {
    let token = format!("{}:{}", std::process::id(), uuid::Uuid::new_v4().simple());
    while Instant::now() <= deadline {
        match exclusive_token(path, &token).await {
            Ok(()) => return Some(token),
            Err(err) if err == "exists" => tokio::time::sleep(LOCK_RETRY).await,
            Err(err) => {
                eprintln!("DSH lock gate creation failed: {err}");
                return None;
            }
        }
    }
    eprintln!("DSH lock gate timed out");
    None
}

// If an awaiting async caller is cancelled, a successfully created worker
// result must relinquish its token rather than strand the reclamation gate.
struct PendingOwnerFile {
    path: String,
    token: String,
    claimed: bool,
}
impl Drop for PendingOwnerFile {
    fn drop(&mut self) {
        if !self.claimed && std::fs::read_to_string(&self.path).ok().as_deref() == Some(&self.token)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn create_owner_file(path: String, token: String) -> Result<PendingOwnerFile, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(token.as_bytes())
                .map_err(|err| err.to_string())?;
            file.sync_all().map_err(|err| err.to_string())?;
            Ok(PendingOwnerFile {
                path,
                token,
                claimed: false,
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Err("exists".into()),
        Err(err) => Err(err.to_string()),
    }
}

async fn exclusive_token(path: &str, token: &str) -> Result<(), String> {
    let path = path.to_owned();
    let token = token.to_owned();
    // fsync on an ARM/Windows volume may stall. Keep it off the async thread
    // that must concurrently release a competing patch lock.
    let mut pending = tokio::task::spawn_blocking(move || create_owner_file(path, token))
        .await
        .map_err(|err| err.to_string())??;
    pending.claimed = true;
    Ok(())
}

async fn release_patch_lock(target: &str, token: &str) {
    let lock_path = format!("{target}{LOCK_SUFFIX}");
    let gate_path = format!("{lock_path}{LOCK_GATE_SUFFIX}");
    let Some(gate) = acquire_owner_file(&gate_path, Instant::now() + LOCK_TIMEOUT).await else {
        logger().warn("failed to acquire DSH lock release gate", None);
        return;
    };
    if tokio::fs::read_to_string(&lock_path).await.ok().as_deref() == Some(token) {
        let _ = tokio::fs::remove_file(&lock_path).await;
    }
    release_owner_file(&gate_path, &gate).await;
}

async fn release_owner_file(path: &str, token: &str) {
    if tokio::fs::read_to_string(path).await.ok().as_deref() == Some(token) {
        if let Err(err) = tokio::fs::remove_file(path).await {
            eprintln!("DSH lock gate release failed: {err}");
        }
    } else {
        eprintln!("DSH lock gate release token unreadable or changed");
    }
}

async fn sync_dir(dir: &Path) {
    let _ = std::fs::File::open(dir).and_then(|file| file.sync_all());
}

fn fail(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::DshYamlPatch,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[async_trait]
impl DeployStrategy for DshYamlPatchStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        self.detect_recorded(def, None).await
    }
    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        if def.dsh_yaml_patch.is_none() {
            return false;
        }
        match self.resolve_target(def, record).await {
            Some(target) => self.needs_deploy_at(def, &target).await,
            None => true,
        }
    }
    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        let Some(target) = self.resolve_target(def, None).await else {
            return fail(def, "DSH runtime target is unavailable");
        };
        self.deploy_at(def, &target).await
    }
    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        self.undeploy_recorded(def, None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentDetectionConfig, DshYamlPatchConfig};

    #[tokio::test]
    async fn writes_and_removes_a_created_patch_file() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("plugin.mjs");
        std::fs::write(&plugin, "export {}\n").unwrap();
        let home = dir.path().join("dsh");
        std::fs::create_dir_all(&home).unwrap();
        let mut locator = DshRuntimeLocator::new();
        locator
            .env
            .insert("DSH_HOME".into(), home.to_string_lossy().into_owned());
        let strategy =
            DshYamlPatchStrategy::with_locator(dir.path().to_string_lossy().into_owned(), locator);
        let def = AgentDefinition {
            id: "dsh".into(),
            display_name: "DSH".into(),
            deploy_mode: DeployMode::DshYamlPatch,
            detection: AgentDetectionConfig {
                paths: vec![home.to_string_lossy().into_owned()],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: None,
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: Some(DshYamlPatchConfig {
                plugin_source: plugin.to_string_lossy().into_owned(),
                patch_path: None,
                entry_id: "loongsuite-pilot-observability".into(),
                marker: "PILOT-OBSERVABILITY-MANAGED".into(),
            }),
            input: None,
            runtime: None,
        };
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let patch = std::fs::read_to_string(home.join("cordis.patch.yml")).unwrap();
        assert!(patch.contains("# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: true)"));
        assert!(patch.contains("# entryId=loongsuite-pilot-observability"));
        assert!(patch.contains("- insert:"));
        assert!(
            home.join("..").join(".collection-enabled").exists()
                || plugin.parent().unwrap().join(DSH_ENABLED_MARKER).exists()
        );
        assert!(strategy.undeploy(&def).await);
        assert!(!home.join("cordis.patch.yml").exists());
    }
    // Fixed historical syntax, independent of the Rust block formatter.
    fn historical_cleanup_block(created_file: bool) -> String {
        format!("# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: {created_file})\n# entryId=loongsuite-pilot-observability\n# pluginSource=file:///pilot/plugins/dsh/plugin.mjs\n# pluginHash=abc123\n- insert:\n  - id: 'loongsuite-pilot-observability'\n    name: file:///pilot/plugins/dsh/plugin.mjs\n# END PILOT-OBSERVABILITY-MANAGED\n")
    }

    fn cleanup_fixture() -> (
        tempfile::TempDir,
        AgentDefinition,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let root = tempfile::tempdir().unwrap();
        let plugin = root.path().join("data/plugins/dsh/plugin.mjs");
        let patch = root.path().join("dsh-home/cordis.patch.yml");
        std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        std::fs::write(&plugin, "export {}\n").unwrap();
        std::fs::write(
            plugin.parent().unwrap().join(DSH_ENABLED_MARKER),
            "enabled\n",
        )
        .unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/dsh.json")).unwrap();
        let cfg = def.dsh_yaml_patch.as_mut().unwrap();
        cfg.plugin_source = plugin.to_string_lossy().into_owned();
        cfg.patch_path = Some(patch.to_string_lossy().into_owned());
        (root, def, plugin, patch)
    }

    #[tokio::test]
    async fn uninstall_preserves_mixed_line_endings_deletes_owned_empty_files_and_never_creates_absent_homes(
    ) {
        for scenario in [
            "mixed",
            "created",
            "absent",
            "incomplete",
            "unmatched-end",
            "nested",
            "duplicate",
        ] {
            let (root, def, plugin, patch) = cleanup_fixture();
            let cfg = def.dsh_yaml_patch.as_ref().unwrap();
            let block = historical_cleanup_block(scenario == "created");
            let before = "# user-before\n- id: user-a\n  name: file:///a\n";
            let after = "# user-after\r\n- id: user-b\r\n  name: file:///b\r\n";
            let raw = match scenario {
                "mixed" => format!("{before}{block}{after}"),
                "created" => block.clone(),
                "absent" => String::new(),
                "incomplete" => format!("# BEGIN {}\n- insert: []\n", cfg.marker),
                "unmatched-end" => format!("{before}# END {}\n{after}", cfg.marker),
                "nested" => format!("# BEGIN {}\n{block}", cfg.marker),
                "duplicate" => format!("{block}{block}"),
                _ => unreachable!(),
            };
            if scenario != "absent" {
                std::fs::create_dir_all(patch.parent().unwrap()).unwrap();
                std::fs::write(&patch, &raw).unwrap();
            }
            let strategy =
                DshYamlPatchStrategy::new(root.path().join("data").to_string_lossy().into_owned());
            let expected = matches!(scenario, "mixed" | "created" | "absent");
            assert_eq!(
                strategy.undeploy_recorded(&def, None).await,
                expected,
                "{scenario}"
            );
            assert!(
                plugin.is_file(),
                "{scenario}: plugin asset survives standalone cleanup"
            );
            match scenario {
                "mixed" => assert_eq!(
                    std::fs::read_to_string(&patch).unwrap(),
                    format!("{before}{after}")
                ),
                "created" => assert!(!patch.exists()),
                "absent" => assert!(!patch.parent().unwrap().exists()),
                _ => assert_eq!(std::fs::read_to_string(&patch).unwrap(), raw),
            }
            if expected {
                assert!(!plugin.parent().unwrap().join(DSH_ENABLED_MARKER).exists());
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn marker_cleanup_is_idempotent_after_delete_and_bounds_real_sharing_conflicts() {
        use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            DeleteFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let (_root, def, _plugin, _patch) = cleanup_fixture();
        let cfg = def.dsh_yaml_patch.as_ref().unwrap();
        let marker = enabled_marker(cfg);
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&marker)
            .unwrap();
        let wide: Vec<u16> = Path::new(&marker)
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: the buffer is terminated and remains valid for this call.
        assert_ne!(unsafe { DeleteFileW(wide.as_ptr()) }, 0);
        let denied = std::fs::File::open(&marker).unwrap_err();
        assert!(
            matches!(denied.raw_os_error(), Some(2 | 5 | 303)),
            "a successfully deleted name must be absent or delete-pending: {denied}"
        );
        assert!(
            handle.metadata().unwrap().len() > 0,
            "the original deleted file handle remains open"
        );
        let release = tokio::task::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(handle);
        });
        remove_enabled_marker(cfg).await.unwrap();
        release.await.unwrap();
        assert!(!Path::new(&marker).exists());
        // Force the actual retry path with a handle that denies delete sharing,
        // then release it while cleanup is waiting.
        std::fs::write(&marker, "enabled").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&marker)
            .unwrap();
        let conflict = std::fs::remove_file(&marker).unwrap_err();
        assert_eq!(conflict.raw_os_error(), Some(32));
        let release = tokio::task::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        remove_enabled_marker(cfg).await.unwrap();
        release.await.unwrap();
        assert!(!Path::new(&marker).exists());

        // Rust 1.91 intentionally ignores the readonly attribute when deleting.
        // Hold a real handle without FILE_SHARE_DELETE to exercise a genuine
        // sharing restriction, rather than treating an attribute as an ACL.
        std::fs::write(&marker, "enabled").unwrap();
        let blocker = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&marker)
            .unwrap();
        assert!(remove_enabled_marker(cfg).await.is_err());
        assert!(Path::new(&marker).is_file());
        drop(blocker);
        remove_enabled_marker(cfg).await.unwrap();
        assert!(!Path::new(&marker).exists());
    }

    #[test]
    fn discarded_blocking_owner_results_release_only_their_own_token() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("gate").to_string_lossy().into_owned();
        let pending = create_owner_file(path.clone(), "owner-a".into()).unwrap();
        drop(pending);
        assert!(!Path::new(&path).exists());
        let pending = create_owner_file(path.clone(), "owner-b".into()).unwrap();
        std::fs::write(&path, "foreign-owner").unwrap();
        drop(pending);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "foreign-owner");
    }

    #[tokio::test]
    async fn concurrent_stale_lock_cleanup_serializes_and_removes_both_lock_files() {
        for round in 0..32 {
            let (root, def, plugin, patch) = cleanup_fixture();
            std::fs::create_dir_all(patch.parent().unwrap()).unwrap();
            let block = historical_cleanup_block(false);
            let before = "# user-before\n";
            let after = "# user-after\n";
            std::fs::write(&patch, format!("{before}{block}{after}")).unwrap();
            let lock = format!("{}{}", patch.display(), LOCK_SUFFIX);
            std::fs::write(&lock, "abandoned").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&lock)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(SystemTime::now() - Duration::from_secs(60)),
                )
                .unwrap();
            let strategy =
                DshYamlPatchStrategy::new(root.path().join("data").to_string_lossy().into_owned());
            let (a, b) = tokio::join!(
                strategy.undeploy_recorded(&def, None),
                strategy.undeploy_recorded(&def, None)
            );
            assert!(
                a && b,
                "cleanup round={round} results a={a} b={b}, lock={} reclaim={}",
                Path::new(&lock).exists(),
                Path::new(&format!("{lock}{LOCK_GATE_SUFFIX}")).exists()
            );
            assert_eq!(
                std::fs::read_to_string(&patch).unwrap(),
                format!("{before}{after}")
            );
            assert!(!Path::new(&lock).exists());
            assert!(!Path::new(&format!("{lock}{LOCK_GATE_SUFFIX}")).exists());
            assert!(!plugin.parent().unwrap().join(DSH_ENABLED_MARKER).exists());
        }
    }
}
