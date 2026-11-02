//! Locate the DSH home that should receive `cordis.patch.yml`.

use crate::types::{AgentDefinition, DeployedAgentRecord};
use crate::utils::resolve_home;
use std::collections::HashMap;
use std::path::Path;

use super::detect_utils::detect_agent;
use super::env_agent_dirs::resolve_dsh_home;
use super::paths::{is_absolute, node_resolve, node_resolve_from, parent_dir};

const DSH_PATCH_FILENAME: &str = "cordis.patch.yml";
const MAX_PROC_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DshRuntimeTargetSource {
    Persisted,
    ConfiguredPatch,
    PilotEnv,
    RunningProcess,
    StandardDetection,
}

impl DshRuntimeTargetSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Persisted => "persisted",
            Self::ConfiguredPatch => "configured-patch",
            Self::PilotEnv => "pilot-env",
            Self::RunningProcess => "running-process",
            Self::StandardDetection => "standard-detection",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DshRuntimeTarget {
    pub home: String,
    pub patch_path: String,
    pub source: DshRuntimeTargetSource,
    pub pid: Option<u32>,
}

pub struct DshRuntimeLocator {
    pub proc_root: String,
    pub platform: String,
    pub env: HashMap<String, String>,
    pub cwd: String,
    pub uid: Option<u32>,
}

impl DshRuntimeLocator {
    pub fn new() -> Self {
        let mut env = HashMap::new();
        for (key, value) in std::env::vars() {
            env.insert(key, value);
        }
        Self {
            proc_root: "/proc".into(),
            platform: match std::env::consts::OS {
                "windows" => "win32",
                "macos" => "darwin",
                other => other,
            }
            .into(),
            env,
            cwd: std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".into()),
            uid: current_uid(),
        }
    }

    pub async fn locate(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> Result<Option<DshRuntimeTarget>, String> {
        let Some(cfg) = &def.dsh_yaml_patch else {
            return Ok(None);
        };
        if let Some(patch) = record.and_then(|record| record.dsh_patch_path.as_deref()) {
            if is_absolute(patch) {
                return Ok(Some(target_from_patch(
                    node_resolve(patch),
                    DshRuntimeTargetSource::Persisted,
                )));
            }
        }
        if let Some(patch) = &cfg.patch_path {
            return Ok(Some(target_from_patch(
                node_resolve(&resolve_home(patch)),
                DshRuntimeTargetSource::ConfiguredPatch,
            )));
        }
        if let Some(home) = self.resolve_home_value(
            self.env.get("DSH_HOME").map(String::as_str).unwrap_or(""),
            &self.cwd,
        ) {
            return Ok(Some(target_from_home(
                &home,
                DshRuntimeTargetSource::PilotEnv,
                None,
            )));
        }
        if let Some(running) = self.locate_running_process().await? {
            return Ok(Some(running));
        }
        if detect_agent(&def.detection).await {
            let fallback = resolve_dsh_home(Some(&self.env));
            let home = self
                .resolve_home_value(&fallback, &self.cwd)
                .unwrap_or_else(|| {
                    Path::new(&home_dir())
                        .join(".dsh")
                        .to_string_lossy()
                        .into_owned()
                });
            return Ok(Some(target_from_home(
                &home,
                DshRuntimeTargetSource::StandardDetection,
                None,
            )));
        }
        Ok(None)
    }

    async fn locate_running_process(&self) -> Result<Option<DshRuntimeTarget>, String> {
        if self.platform != "linux" {
            return Ok(None);
        }
        let mut entries = match tokio::fs::read_dir(&self.proc_root).await {
            Ok(entries) => entries,
            Err(_) => return Ok(None),
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.chars().all(|ch| ch.is_ascii_digit()) {
                names.push(name);
            }
        }
        names.sort_by_key(|name| name.parse::<u64>().unwrap_or(0));
        let mut candidates: HashMap<String, Vec<u32>> = HashMap::new();
        for entry in names {
            let pid: u32 = entry.parse().unwrap_or(0);
            let process_dir = Path::new(&self.proc_root).join(&entry);
            if !self.is_owned(&process_dir).await {
                continue;
            }
            let Some(cmdline) = read_proc(&process_dir.join("cmdline")).await else {
                continue;
            };
            if !is_dsh_command(&cmdline) {
                continue;
            }
            let Some(environ) = read_proc(&process_dir.join("environ")).await else {
                continue;
            };
            let Some(raw_home) = read_env_value(&environ, "DSH_HOME") else {
                continue;
            };
            let process_cwd = if !is_absolute(&resolve_home(&raw_home)) {
                match tokio::fs::read_link(process_dir.join("cwd")).await {
                    Ok(path) => path.to_string_lossy().into_owned(),
                    Err(_) => continue,
                }
            } else {
                self.cwd.clone()
            };
            let Some(home) = self.resolve_home_value(&raw_home, &process_cwd) else {
                continue;
            };
            candidates.entry(home).or_default().push(pid);
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        if candidates.len() > 1 {
            let mut homes: Vec<_> = candidates.keys().cloned().collect();
            homes.sort();
            let homes = homes
                .into_iter()
                .map(|home| serde_json::to_string(&home).unwrap_or(home))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "ambiguous DSH runtime homes discovered from running processes: {homes}"
            ));
        }
        let (home, pids) = candidates.into_iter().next().unwrap();
        Ok(Some(target_from_home(
            &home,
            DshRuntimeTargetSource::RunningProcess,
            pids.first().copied(),
        )))
    }

    async fn is_owned(&self, process_dir: &Path) -> bool {
        let Some(uid) = self.uid else { return true };
        match tokio::fs::metadata(process_dir).await {
            Ok(meta) => file_uid(&meta) == Some(uid),
            Err(_) => false,
        }
    }

    fn resolve_home_value(&self, raw: &str, cwd: &str) -> Option<String> {
        if raw.trim().is_empty() {
            return None;
        }
        let expanded = resolve_home(raw);
        if is_absolute(&expanded) {
            Some(node_resolve(&expanded))
        } else {
            Some(node_resolve_from(cwd, &expanded))
        }
    }
}

impl Default for DshRuntimeLocator {
    fn default() -> Self {
        Self::new()
    }
}

fn target_from_home(
    home: &str,
    source: DshRuntimeTargetSource,
    pid: Option<u32>,
) -> DshRuntimeTarget {
    DshRuntimeTarget {
        home: home.to_string(),
        patch_path: Path::new(home)
            .join(DSH_PATCH_FILENAME)
            .to_string_lossy()
            .into_owned(),
        source,
        pid,
    }
}

fn target_from_patch(patch_path: String, source: DshRuntimeTargetSource) -> DshRuntimeTarget {
    DshRuntimeTarget {
        home: parent_dir(&patch_path),
        patch_path,
        source,
        pid: None,
    }
}

async fn read_proc(path: &Path) -> Option<Vec<u8>> {
    let bytes = tokio::fs::read(path).await.ok()?;
    if bytes.len() as u64 <= MAX_PROC_FILE_BYTES {
        Some(bytes)
    } else {
        None
    }
}

fn is_dsh_command(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let args: Vec<&str> = text.split('\0').filter(|item| !item.is_empty()).collect();
    let executable = Path::new(args.first().copied().unwrap_or(""))
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if executable == "dsh" || executable == "dsh.exe" {
        return true;
    }
    if executable != "node" && executable != "node.exe" && executable != "nodejs" {
        return false;
    }
    args.iter().skip(1).any(|arg| {
        let normalized = arg.replace('\\', "/");
        let base = Path::new(&normalized)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        base == "dsh" || normalized.ends_with("/@deepseek-ai/dsh/lib/bin.js")
    })
}

fn read_env_value(bytes: &[u8], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    String::from_utf8_lossy(bytes)
        .split('\0')
        .find_map(|field| field.strip_prefix(&prefix).map(|value| value.to_string()))
}

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid is always safe.
        Some(libc_getuid())
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(unix)]
fn libc_getuid() -> u32 {
    // Avoid a direct libc dependency: `id -u` is not the process uid if sudo changes it.
    // nix/libc are not direct dependencies, so read /proc/self/status Uid.
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let rest = line.strip_prefix("Uid:")?;
                rest.split_whitespace().next()?.parse().ok()
            })
        })
        .unwrap_or(0)
}

#[cfg(unix)]
fn file_uid(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.uid())
}

#[cfg(not(unix))]
fn file_uid(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentDetectionConfig, DeployMode, DshYamlPatchConfig};

    fn def(patch: Option<&str>) -> AgentDefinition {
        AgentDefinition {
            id: "dsh".into(),
            display_name: "DSH".into(),
            deploy_mode: DeployMode::DshYamlPatch,
            detection: AgentDetectionConfig {
                paths: vec![],
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
                plugin_source: "/tmp/plugin.mjs".into(),
                patch_path: patch.map(|value| value.to_string()),
                entry_id: "loongsuite-pilot-observability".into(),
                marker: "PILOT".into(),
            }),
            input: None,
            runtime: None,
        }
    }

    #[tokio::test]
    async fn prefers_persisted_then_configured_then_env() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let persisted = root.join("persisted").join("cordis.patch.yml");
        let configured = root.join("configured").join("cordis.patch.yml");
        let env_home = root.join("env").join("dsh");
        assert!(persisted.is_absolute());
        assert!(configured.is_absolute());
        assert!(env_home.is_absolute());
        let configured_def = def(Some(configured.to_str().unwrap()));
        let mut locator = DshRuntimeLocator::new();
        locator.env = HashMap::from([("DSH_HOME".into(), env_home.to_string_lossy().into_owned())]);
        let mut record = DeployedAgentRecord {
            deploy_mode: DeployMode::DshYamlPatch,
            deployed_at: "t".into(),
            source_hash: None,
            last_remote_checked_at: None,
            target_dir: None,
            dsh_patch_path: Some(persisted.to_string_lossy().into_owned()),
            hook_settings_path: None,
            hook_settings_paths: None,
            installed_by: None,
            plugin_inject_config_path: None,
        };
        let target = locator
            .locate(&configured_def, Some(&record))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.source, DshRuntimeTargetSource::Persisted);
        assert_eq!(std::path::Path::new(&target.patch_path), persisted);
        record.dsh_patch_path = None;
        let target = locator
            .locate(&configured_def, Some(&record))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.source, DshRuntimeTargetSource::ConfiguredPatch);
        assert_eq!(std::path::Path::new(&target.patch_path), configured);
        let target = locator.locate(&def(None), None).await.unwrap().unwrap();
        assert_eq!(target.source, DshRuntimeTargetSource::PilotEnv);
        assert_eq!(std::path::Path::new(&target.home), env_home);
        assert_eq!(
            std::path::Path::new(&target.patch_path),
            env_home.join("cordis.patch.yml")
        );
    }

    #[test]
    fn recognizes_node_dsh_entry() {
        let bytes = b"node\0--require\0preload.js\0/opt/@deepseek-ai/dsh/lib/bin.js\0";
        assert!(is_dsh_command(bytes));
        assert!(is_dsh_command(b"/usr/bin/dsh\0"));
        assert!(!is_dsh_command(b"node\0server.js\0"));
    }
}

#[cfg(test)]
#[path = "dsh_runtime_locator_history_contract_tests.rs"]
mod history_contract_tests;
