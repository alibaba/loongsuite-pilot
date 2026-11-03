//! Native Copilot plugin configuration, ownership and shell integration.
mod jsonc_cleanup;
use crate::types::{
    AgentDefinition, CopilotPluginHookConfig, DeployMode, DeployResult, DeployStrategy,
    DeployedAgentRecord, EventSubcommand,
};
use crate::utils::{
    parse_json_document, resolve_home, write_text_file_atomic, AtomicTextWriteOptions,
    ExpectedFileState, JsonSyntax,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const BEGIN: &str = "# >>> loongsuite-pilot copilot otel >>>";
const END: &str = "# <<< loongsuite-pilot copilot otel <<<";
const MARKER: &str = ".loongsuite-pilot-managed.json";
struct Snapshot {
    path: String,
    content: Option<String>,
    mode: u32,
    config_alias: Option<ConfigAlias>,
}

/// Only user configuration opts in to following a final symlink. Assets and
/// ownership markers continue to use the strict ordinary-file Snapshot::read.
#[derive(PartialEq, Eq)]
struct ConfigAlias {
    path: PathBuf,
    target: PathBuf,
    raw_target: PathBuf,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
impl ConfigAlias {
    fn capture(path: &Path) -> anyhow::Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            metadata.file_type().is_symlink(),
            "Copilot config alias is no longer a symlink"
        );
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            path: path.to_owned(),
            target: std::fs::canonicalize(path)?,
            raw_target: std::fs::read_link(path)?,
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}
impl Snapshot {
    async fn read(path: &Path) -> anyhow::Result<Self> {
        let metadata = match crate::utils::runtime_paths::runtime_metadata(path) {
            Ok(metadata) => {
                anyhow::ensure!(
                    metadata.is_file() && metadata.len() <= 4 * 1024 * 1024,
                    "Copilot configuration must be a bounded regular file"
                );
                Some(metadata)
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata
                .as_ref()
                .map_or(0o600, |metadata| metadata.permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let mode = 0o600;
        let content = if metadata.is_some() {
            Some(tokio::fs::read_to_string(path).await?)
        } else {
            None
        };
        Ok(Self {
            path: path.to_string_lossy().into_owned(),
            content,
            mode,
            config_alias: None,
        })
    }

    async fn read_config(path: &Path) -> anyhow::Result<Self> {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            let alias = ConfigAlias::capture(path)?;
            let mut snapshot = Self::read(&alias.target).await?;
            snapshot.config_alias = Some(alias);
            snapshot.validate_config_alias()?;
            Ok(snapshot)
        } else {
            Self::read(path).await
        }
    }
    fn validate_config_alias(&self) -> anyhow::Result<()> {
        let Some(alias) = &self.config_alias else {
            return Ok(());
        };
        anyhow::ensure!(
            ConfigAlias::capture(&alias.path)? == *alias,
            "Copilot configuration alias changed; original targets preserved"
        );
        let metadata = crate::utils::runtime_paths::runtime_metadata(Path::new(&self.path))?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= 4 * 1024 * 1024,
            "Copilot configuration target changed"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o777 == self.mode,
                "Copilot configuration target permissions changed"
            );
        }
        Ok(())
    }
    fn json(&self) -> anyhow::Result<Value> {
        let value = parse_json_document(self.content.as_deref().unwrap_or("{}"), JsonSyntax::Jsonc)
            .map_err(|_| {
                anyhow::anyhow!("Invalid Copilot JSONC configuration; original file preserved")
            })?;
        anyhow::ensure!(value.is_object(), "Copilot configuration must be an object");
        Ok(value)
    }
    async fn write(&self, content: &str) -> anyhow::Result<()> {
        self.validate_config_alias()?;
        if self.content.as_deref() == Some(content) {
            return Ok(());
        }
        write_text_file_atomic(
            &self.path,
            content,
            &AtomicTextWriteOptions {
                expected: Some(
                    self.content
                        .clone()
                        .map(ExpectedFileState::Present)
                        .unwrap_or(ExpectedFileState::Missing),
                ),
                mode: Some(self.mode),
                backup_path: None,
            },
        )
        .await?;
        self.validate_config_alias()?;
        Ok(())
    }
    #[cfg(test)]
    async fn write_key(&self, key: &str, value: Option<Value>) -> anyhow::Result<()> {
        use crate::utils::{edit_jsonc, JsonEditOptions, JsonPathSeg};
        let content = edit_jsonc(
            self.content.as_deref().unwrap_or("{}\n"),
            &[JsonPathSeg::Key(key.into())],
            value.as_ref(),
            JsonEditOptions::default(),
        );
        self.write(&content).await
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn copilot_shell_block(data_dir: &Path) -> String {
    let dir = data_dir.join("state/copilot/otel");
    let marker = data_dir.join("state/copilot/otel-enabled");
    format!("{BEGIN}\nif [ -f {} ] && [ -z \"${{COPILOT_OTEL_FILE_EXPORTER_PATH+x}}\" ] && [ -z \"${{OTEL_EXPORTER_OTLP_ENDPOINT+x}}\" ] && [ -z \"${{COPILOT_OTEL_EXPORTER_TYPE+x}}\" ] && [ -z \"${{COPILOT_OTEL_ENABLED+x}}\" ]; then\n  if (umask 077; mkdir -p {}); then\n    export COPILOT_OTEL_FILE_EXPORTER_PATH={}/copilot-$(date -u +%Y%m%dT%H%M%S)-$$.jsonl\n  fi\nfi\n{END}\n",
        quote(&marker.to_string_lossy()), quote(&dir.to_string_lossy()), quote(&dir.to_string_lossy()))
}
fn remove_blocks(text: &str) -> anyhow::Result<String> {
    let mut output = String::new();
    let mut rest = text;
    while let Some(begin) = rest.find(BEGIN) {
        output.push_str(&rest[..begin]);
        let tail = &rest[begin + BEGIN.len()..];
        let end = tail.find(END).ok_or_else(|| {
            anyhow::anyhow!("Incomplete owned Copilot shell block; profile preserved")
        })?;
        rest = &tail[end + END.len()..];
        rest = rest
            .strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))
            .unwrap_or(rest);
    }
    output.push_str(rest);
    Ok(output)
}
async fn shell_snapshots(home: &Path) -> anyhow::Result<Vec<Snapshot>> {
    let mut profiles = Vec::new();
    #[cfg(unix)]
    let paths = vec![home.join(".bashrc"), home.join(".zshrc")];
    #[cfg(windows)]
    let paths = vec![
        home.join("Documents/PowerShell/Microsoft.PowerShell_profile.ps1"),
        home.join("Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"),
    ];
    for profile in paths {
        // Profiles are explicit user configuration, just like settings.json:
        // follow only a final alias captured by the same identity/mode/CAS
        // guard. Package assets and ownership markers stay ordinary files.
        let snapshot = Snapshot::read_config(&profile).await?;
        remove_blocks(snapshot.content.as_deref().unwrap_or_default())?;
        profiles.push(snapshot);
    }
    Ok(profiles)
}
async fn install_shell(data: &Path, profiles: &[Snapshot]) -> anyhow::Result<()> {
    let dir = data.join("state/copilot/otel");
    tokio::fs::create_dir_all(&dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Snapshot::read(&data.join("state/copilot/otel-enabled"))
        .await?
        .write("")
        .await?;
    for profile in profiles {
        let base = remove_blocks(profile.content.as_deref().unwrap_or_default())?;
        profile
            .write(&format!(
                "{}\n{}",
                base.trim_end_matches(['\r', '\n']),
                copilot_shell_block(data)
            ))
            .await?;
    }
    Ok(())
}
pub fn build_copilot_plugin_manifest() -> Value {
    json!({"name":"loongsuite-pilot","version":"0.1.0",
        "description":"Loongsuite Pilot observability hooks for GitHub Copilot CLI",
        "author":{"name":"loongsuite-pilot"},"license":"Apache-2.0","hooks":"hooks/hooks.json"})
}
fn subcommand(event: &str) -> String {
    let mut output = String::new();
    for (index, ch) in event.chars().enumerate() {
        if index > 0 && ch.is_ascii_uppercase() {
            output.push('-');
        }
        output.push(ch.to_ascii_lowercase());
    }
    output
}
pub fn build_copilot_plugin_hooks(config: &CopilotPluginHookConfig) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in &config.events {
        let command = if config.event_subcommand == Some(EventSubcommand::KebabCase) {
            format!("{} {}", config.hook_command, subcommand(event))
        } else {
            config.hook_command.clone()
        };
        hooks.insert(
            event.clone(),
            json!([{"type":"command","command":command,
            "timeoutSec":config.timeout_sec.unwrap_or(5)}]),
        );
    }
    json!({"version":1,"hooks":hooks})
}
fn validate_registration(settings: &Value, config: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        settings.get("enabledPlugins").is_none_or(Value::is_object),
        "Invalid Copilot enabledPlugins map; original file preserved"
    );
    anyhow::ensure!(
        config.get("installedPlugins").is_none_or(Value::is_array),
        "Invalid Copilot installedPlugins array; original file preserved"
    );
    Ok(())
}
fn owned_registration(value: &Value, id: &str) -> bool {
    value.get("name").and_then(Value::as_str) == Some(id)
        && value.get("marketplace").and_then(Value::as_str) == Some(id)
}
async fn owned_root(
    root: &Path,
    legacy: Option<(&CopilotPluginHookConfig, &Value, &Value)>,
) -> anyhow::Result<bool> {
    match crate::utils::runtime_paths::runtime_metadata(root) {
        Ok(metadata) => anyhow::ensure!(
            metadata.is_dir(),
            "Copilot plugin root must be an ordinary directory"
        ),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(false)
        }
        Err(error) => return Err(error),
    }
    let marker = Snapshot::read(&root.join(MARKER)).await?;
    if marker.content.is_none() {
        let mut entries = tokio::fs::read_dir(root).await?;
        if entries.next_entry().await?.is_none() {
            return Ok(false);
        }
        if let Some((config, settings, installed)) = legacy {
            if legacy_root_owned(root, config, settings, installed).await? {
                return Ok(true);
            }
        }
        anyhow::bail!("Existing unmanaged Copilot plugin directory preserved");
    }
    let value = marker.json()?;
    anyhow::ensure!(
        value["schema"] == 1 && value["owner"] == "loongsuite-pilot",
        "Unrecognized Copilot plugin ownership marker; assets preserved"
    );
    Ok(true)
}
/// Main's original Copilot plugin predates the ownership marker. Adopt only
/// exact generated assets, the complete expected directory shape, and an
/// enabled registration pointing at this very root. Names alone prove nothing.
async fn legacy_root_owned(
    root: &Path,
    config: &CopilotPluginHookConfig,
    settings: &Value,
    installed: &Value,
) -> anyhow::Result<bool> {
    let key = format!("{}@{}", config.plugin_id, config.plugin_id);
    if settings.get("enabledPlugins").and_then(|v| v.get(&key)) != Some(&json!(true))
        || !installed["installedPlugins"]
            .as_array()
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    owned_registration(entry, &config.plugin_id)
                        && entry["enabled"] == true
                        && entry["cache_path"].as_str() == Some(root.to_string_lossy().as_ref())
                })
            })
    {
        return Ok(false);
    }
    for (directory, expected) in [
        (root.to_owned(), vec!["hooks", "plugin.json"]),
        (root.join("hooks"), vec!["hooks.json"]),
    ] {
        match crate::utils::runtime_paths::runtime_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => {}
            _ => return Ok(false),
        }
        let mut names = Vec::new();
        let mut entries = tokio::fs::read_dir(directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                return Ok(false);
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Ok(false);
            };
            names.push(name);
        }
        names.sort();
        if names != expected {
            return Ok(false);
        }
    }
    for (path, expected) in [
        (root.join("plugin.json"), build_copilot_plugin_manifest()),
        (
            root.join("hooks/hooks.json"),
            build_copilot_plugin_hooks(config),
        ),
    ] {
        let snapshot = Snapshot::read(&path).await?;
        if snapshot.content.is_none() || snapshot.json()? != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

pub struct CopilotPluginStrategy {
    data_dir: PathBuf,
    home_dir: PathBuf,
    pilot_dir: Option<PathBuf>,
}
impl CopilotPluginStrategy {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            home_dir: PathBuf::from(resolve_home("~")),
            pilot_dir: None,
        }
    }
    pub fn with_pilot_dir(mut self, pilot: impl Into<PathBuf>) -> Self {
        self.pilot_dir = Some(pilot.into());
        self
    }
    pub fn with_home_dir(mut self, home: impl Into<PathBuf>) -> Self {
        self.home_dir = home.into();
        self
    }
    // The manager calls this before recording a pending cleanup target.
    // Registration repeats the snapshots under its lock, so any later I/O/CAS
    // failure still retains the already persisted owner-bound retry record.
    pub(super) async fn preflight_deploy(&self, def: &AgentDefinition) -> anyhow::Result<()> {
        anyhow::ensure!(
            !cfg!(windows),
            "Copilot automatic deployment currently supports Unix shells only"
        );
        let config = def
            .copilot_plugin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("missing copilotPlugin config"))?;
        let settings =
            Snapshot::read_config(Path::new(&resolve_home(&config.settings_path))).await?;
        let installed =
            Snapshot::read_config(Path::new(&resolve_home(&config.config_path))).await?;
        let settings_value = settings.json()?;
        let config_value = installed.json()?;
        validate_registration(&settings_value, &config_value)?;
        shell_snapshots(&self.home_dir).await?;
        owned_root(
            Path::new(&resolve_home(&config.plugin_root)),
            Some((config, &settings_value, &config_value)),
        )
        .await?;
        if let Some(pilot) = &self.pilot_dir {
            super::hook_assets::HookAssets::load(def, Some(pilot), &self.data_dir)?;
        }
        Ok(())
    }

    async fn lock_path(&self) -> anyhow::Result<String> {
        let directory = self.data_dir.join("state/copilot");
        tokio::fs::create_dir_all(&directory).await?;
        Ok(directory.join("plugin.lock").to_string_lossy().into_owned())
    }
    async fn register(&self, config: &CopilotPluginHookConfig) -> anyhow::Result<()> {
        anyhow::ensure!(
            !cfg!(windows),
            "Copilot automatic deployment currently supports Unix shells only"
        );
        let root = PathBuf::from(resolve_home(&config.plugin_root));
        let settings =
            Snapshot::read_config(Path::new(&resolve_home(&config.settings_path))).await?;
        let installed =
            Snapshot::read_config(Path::new(&resolve_home(&config.config_path))).await?;
        let settings_value = settings.json()?;
        let config_value = installed.json()?;
        validate_registration(&settings_value, &config_value)?;
        let profiles = shell_snapshots(&self.home_dir).await?;
        owned_root(&root, Some((config, &settings_value, &config_value))).await?;
        let entry = json!({"name":config.plugin_id,"marketplace":config.plugin_id,"installed_at":super::paths::iso_now(),
            "enabled":true,"version":"0.1.0","cache_path":root.to_string_lossy()});
        // Compute and validate both complete documents before any deployment writes.
        let (next_settings, next_installed) = jsonc_cleanup::set_registration(
            settings.content.as_deref().unwrap_or("{}\n"),
            installed.content.as_deref().unwrap_or("{}\n"),
            &config.plugin_id,
            entry,
        )?;
        tokio::fs::create_dir_all(&root).await?;
        Snapshot::read(&root.join(MARKER))
            .await?
            .write(&format!(
                "{}\n",
                json!({"schema":1,"owner":"loongsuite-pilot"})
            ))
            .await?;
        tokio::fs::create_dir_all(root.join("hooks")).await?;
        for (path, value) in [
            (root.join("plugin.json"), build_copilot_plugin_manifest()),
            (
                root.join("hooks/hooks.json"),
                build_copilot_plugin_hooks(config),
            ),
        ] {
            Snapshot::read(&path)
                .await?
                .write(&format!("{}\n", serde_json::to_string_pretty(&value)?))
                .await?;
        }
        settings.write(&next_settings).await?;
        installed.write(&next_installed).await?;
        install_shell(&self.data_dir, &profiles).await?;
        Ok(())
    }
    async fn unregister(&self, config: &CopilotPluginHookConfig) -> anyhow::Result<()> {
        let root = PathBuf::from(resolve_home(&config.plugin_root));
        let settings =
            Snapshot::read_config(Path::new(&resolve_home(&config.settings_path))).await?;
        let installed =
            Snapshot::read_config(Path::new(&resolve_home(&config.config_path))).await?;
        let settings_value = settings.json()?;
        let config_value = installed.json()?;
        validate_registration(&settings_value, &config_value)?;
        let profiles = shell_snapshots(&self.home_dir).await?;
        let owned = owned_root(&root, Some((config, &settings_value, &config_value))).await?;
        let (next_settings, next_installed) = jsonc_cleanup::remove_registrations(
            settings.content.as_deref().unwrap_or("{}\n"),
            installed.content.as_deref().unwrap_or("{}\n"),
            &config.plugin_id,
        )?;
        if settings.content.is_some() {
            settings.write(&next_settings).await?;
        }
        if installed.content.is_some() {
            installed.write(&next_installed).await?;
        }
        match tokio::fs::remove_file(self.data_dir.join("state/copilot/otel-enabled")).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        for profile in profiles {
            if let Some(content) = &profile.content {
                profile.write(&remove_blocks(content)?).await?;
            }
        }
        if owned {
            tokio::fs::remove_dir_all(root).await?;
        }
        Ok(())
    }
    async fn healthy(&self, config: &CopilotPluginHookConfig) -> anyhow::Result<bool> {
        let root = PathBuf::from(resolve_home(&config.plugin_root));
        if !owned_root(&root, None).await? {
            return Ok(false);
        }
        for (path, expected) in [
            (root.join("plugin.json"), build_copilot_plugin_manifest()),
            (
                root.join("hooks/hooks.json"),
                build_copilot_plugin_hooks(config),
            ),
        ] {
            if Snapshot::read(&path).await?.json()? != expected {
                return Ok(false);
            }
        }
        let settings = Snapshot::read_config(Path::new(&resolve_home(&config.settings_path)))
            .await?
            .json()?;
        let installed = Snapshot::read_config(Path::new(&resolve_home(&config.config_path)))
            .await?
            .json()?;
        validate_registration(&settings, &installed)?;
        if settings
            .get("enabledPlugins")
            .and_then(|enabled| enabled.get(format!("{}@{}", config.plugin_id, config.plugin_id)))
            != Some(&json!(true))
        {
            return Ok(false);
        }
        if !installed["installedPlugins"]
            .as_array()
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    owned_registration(entry, &config.plugin_id)
                        && entry["enabled"] == true
                        && entry["cache_path"].as_str() == Some(root.to_string_lossy().as_ref())
                })
            })
        {
            return Ok(false);
        }
        if !self.data_dir.join("state/copilot/otel-enabled").is_file() {
            return Ok(false);
        }
        for profile in shell_snapshots(&self.home_dir).await? {
            if !profile
                .content
                .as_deref()
                .unwrap_or_default()
                .contains(&copilot_shell_block(&self.data_dir))
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
fn result(def: &AgentDefinition, error: Option<String>) -> DeployResult {
    DeployResult {
        success: error.is_none(),
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::CopilotPlugin,
        skipped: None,
        reason: None,
        error,
        plugin_inject_config_path: None,
    }
}
#[async_trait]
impl DeployStrategy for CopilotPluginStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        !cfg!(windows) && super::detect_utils::detect_agent(&def.detection).await
    }
    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        _record: Option<&DeployedAgentRecord>,
    ) -> bool {
        if self
            .pilot_dir
            .as_ref()
            .is_some_and(|pilot| !super::hook_assets::healthy(def, pilot, &self.data_dir))
        {
            return true;
        }
        match &def.copilot_plugin {
            Some(config) => !self.healthy(config).await.unwrap_or(false),
            None => true,
        }
    }
    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        let Some(config) = &def.copilot_plugin else {
            return result(def, Some("missing copilotPlugin config".into()));
        };
        if let Err(error) = self.preflight_deploy(def).await {
            return result(def, Some(error.to_string()));
        }
        let lock = match self.lock_path().await {
            Ok(lock) => lock,
            Err(error) => return result(def, Some(error.to_string())),
        };
        let registration = super::deployed_state_merge::with_deployed_state_lock(
            &lock,
            || async {
                if let Some(pilot) = &self.pilot_dir {
                    let assets =
                        super::hook_assets::HookAssets::load(def, Some(pilot), &self.data_dir)?;
                    assets
                        .apply(Default::default(), None, false, |_| Ok(Default::default()))
                        .await?;
                }
                self.register(config).await
            },
            5_000,
        )
        .await;
        result(def, registration.err().map(|error| error.to_string()))
    }
    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        let Some(config) = &def.copilot_plugin else {
            return true;
        };
        let lock = match self.lock_path().await {
            Ok(lock) => lock,
            Err(_) => return false,
        };
        super::deployed_state_merge::with_deployed_state_lock(
            &lock,
            || self.unregister(config),
            5_000,
        )
        .await
        .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn definition(root: &Path) -> AgentDefinition {
        serde_json::from_value(json!({
            "id":"copilot","displayName":"GitHub Copilot CLI","deployMode":"copilot-plugin",
            "detection":{"paths":[],"commands":[]},
            "copilotPlugin":{"pluginRoot":root.join("home/plugins/pilot"),"pluginId":"loongsuite-pilot",
                "settingsPath":root.join("home/settings.json"),"configPath":root.join("home/config.json"),
                "events":["sessionStart","preToolUse","agentStop"],
                "hookCommand":format!("{}/hooks/copilot-hook.sh",root.join("data").display()),
                "format":"nested","eventSubcommand":"kebab-case","timeoutSec":5}
        })).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn deployment_repairs_owned_assets_preserves_jsonc_and_removes_only_owned_registration() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        let settings = home.join("settings.json");
        let config = home.join("config.json");
        tokio::fs::write(&settings,"{\n // user comment\n \"theme\":\"dark\", \"enabledPlugins\":{\"foreign@market\":true},\n}\n").await.unwrap();
        tokio::fs::write(&config,"{\"installedPlugins\":[{\"name\":\"foreign\",\"marketplace\":\"market\"}],\"custom\":42}\n").await.unwrap();
        tokio::fs::write(home.join(".bashrc"), "export USER_CUSTOM=value\n")
            .await
            .unwrap();
        let strategy = CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
        let def = definition(root.path());
        assert!(strategy.needs_deploy(&def, None).await);
        let deployed = strategy.deploy(&def).await;
        assert!(deployed.success, "{deployed:?}");
        assert!(!strategy.needs_deploy(&def, None).await);
        let text = tokio::fs::read_to_string(&settings).await.unwrap();
        assert!(text.contains("// user comment") && text.contains("\"theme\":\"dark\""));
        let shell = tokio::fs::read_to_string(home.join(".bashrc"))
            .await
            .unwrap();
        assert!(shell.contains("export USER_CUSTOM=value"));
        assert_eq!(shell.matches(BEGIN).count(), 1);
        let deployed = strategy.deploy(&def).await;
        assert!(deployed.success, "{deployed:?}");
        assert_eq!(
            tokio::fs::read_to_string(home.join(".bashrc"))
                .await
                .unwrap()
                .matches(BEGIN)
                .count(),
            1
        );
        let hooks = home.join("plugins/pilot/hooks/hooks.json");
        tokio::fs::write(&hooks, "{}").await.unwrap();
        assert!(strategy.needs_deploy(&def, None).await);
        let deployed = strategy.deploy(&def).await;
        assert!(deployed.success, "{deployed:?}");
        assert!(strategy.undeploy(&def).await);
        let enabled = Snapshot::read(&settings).await.unwrap().json().unwrap();
        assert_eq!(enabled["enabledPlugins"]["foreign@market"], true);
        assert!(enabled["enabledPlugins"]
            .get("loongsuite-pilot@loongsuite-pilot")
            .is_none());
        let installed = Snapshot::read(&config).await.unwrap().json().unwrap();
        assert_eq!(installed["installedPlugins"].as_array().unwrap().len(), 1);
        assert_eq!(installed["custom"], 42);
        assert_eq!(
            tokio::fs::read_to_string(home.join(".bashrc"))
                .await
                .unwrap(),
            "export USER_CUSTOM=value\n"
        );
        assert!(!home.join("plugins/pilot").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_user_config_or_unmanaged_plugin_preserves_all_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        let settings = home.join("settings.json");
        let config = home.join("config.json");
        tokio::fs::write(&settings, "{\"enabledPlugins\":{}}")
            .await
            .unwrap();
        tokio::fs::write(&config, "not-json").await.unwrap();
        let strategy = CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
        let def = definition(root.path());
        assert!(!strategy.deploy(&def).await.success);
        assert_eq!(
            tokio::fs::read_to_string(&settings).await.unwrap(),
            "{\"enabledPlugins\":{}}"
        );
        assert!(!home.join("plugins/pilot").exists());
        tokio::fs::write(&config, "{}").await.unwrap();
        tokio::fs::create_dir_all(home.join("plugins/pilot"))
            .await
            .unwrap();
        tokio::fs::write(home.join("plugins/pilot/foreign.txt"), "owned by user")
            .await
            .unwrap();
        assert!(!strategy.deploy(&def).await.success);
        assert_eq!(tokio::fs::read_to_string(&config).await.unwrap(), "{}");
        assert_eq!(
            tokio::fs::read_to_string(home.join("plugins/pilot/foreign.txt"))
                .await
                .unwrap(),
            "owned by user"
        );
    }

    #[cfg(unix)]
    async fn legacy_install(def: &AgentDefinition) {
        let config = def.copilot_plugin.as_ref().unwrap();
        let root = PathBuf::from(&config.plugin_root);
        tokio::fs::create_dir_all(root.join("hooks")).await.unwrap();
        tokio::fs::write(
            root.join("plugin.json"),
            build_copilot_plugin_manifest().to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            root.join("hooks/hooks.json"),
            build_copilot_plugin_hooks(config).to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            &config.settings_path,
            json!({"enabledPlugins":{
                format!("{}@{}",config.plugin_id,config.plugin_id):true, "foreign@market":true
            }})
            .to_string(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            &config.config_path,
            json!({"installedPlugins":[{
                "name":config.plugin_id,"marketplace":config.plugin_id,"enabled":true,
                "cache_path":root
            }]})
            .to_string(),
        )
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exact_main_legacy_install_is_adopted_and_can_be_cleaned_without_a_new_marker() {
        for upgrade in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let def = definition(root.path());
            legacy_install(&def).await;
            let home = root.path().join("home");
            let plugin = home.join("plugins/pilot");
            let strategy =
                CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
            assert!(!plugin.join(MARKER).exists());
            assert!(strategy.needs_deploy(&def, None).await);
            if upgrade {
                let result = strategy.deploy(&def).await;
                assert!(result.success, "{result:?}");
                assert!(plugin.join(MARKER).is_file());
                assert!(!strategy.needs_deploy(&def, None).await);
            }
            assert!(strategy.undeploy(&def).await);
            assert!(!plugin.exists());
            let settings = Snapshot::read(&home.join("settings.json"))
                .await
                .unwrap()
                .json()
                .unwrap();
            assert_eq!(settings["enabledPlugins"]["foreign@market"], true);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_adoption_requires_all_assets_and_the_exact_registered_root() {
        for fault in [
            "foreign-file",
            "different-path",
            "different-hook",
            "missing-setting",
            "missing-registration",
        ] {
            let root = tempfile::tempdir().unwrap();
            let def = definition(root.path());
            legacy_install(&def).await;
            let home = root.path().join("home");
            let plugin = home.join("plugins/pilot");
            match fault {
                "foreign-file" => tokio::fs::write(plugin.join("foreign.txt"), "user owned").await.unwrap(),
                "different-path" => tokio::fs::write(home.join("config.json"),
                    r#"{"installedPlugins":[{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot","enabled":true,"cache_path":"/other/install"}]}"#).await.unwrap(),
                "different-hook" => tokio::fs::write(plugin.join("hooks/hooks.json"),
                    r#"{"version":1,"hooks":{"agentStop":[{"type":"command","command":"user command"}]}}"#).await.unwrap(),
                "missing-setting" => tokio::fs::write(home.join("settings.json"), "{}").await.unwrap(),
                "missing-registration" => tokio::fs::write(home.join("config.json"), "{}").await.unwrap(),
                _ => unreachable!(),
            }
            let settings = tokio::fs::read(home.join("settings.json")).await.unwrap();
            let installed = tokio::fs::read(home.join("config.json")).await.unwrap();
            let hooks = tokio::fs::read(plugin.join("hooks/hooks.json"))
                .await
                .unwrap();
            let strategy =
                CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
            assert!(!strategy.deploy(&def).await.success, "{fault}");
            assert!(!strategy.undeploy(&def).await, "{fault}");
            assert_eq!(
                tokio::fs::read(home.join("settings.json")).await.unwrap(),
                settings
            );
            assert_eq!(
                tokio::fs::read(home.join("config.json")).await.unwrap(),
                installed
            );
            assert_eq!(
                tokio::fs::read(plugin.join("hooks/hooks.json"))
                    .await
                    .unwrap(),
                hooks
            );
            assert!(!plugin.join(MARKER).exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_plugin_symlink_is_never_adopted_or_removed() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let def = definition(root.path());
        legacy_install(&def).await;
        let home = root.path().join("home");
        let plugin = home.join("plugins/pilot");
        let original = root.path().join("user-hooks.json");
        tokio::fs::rename(plugin.join("hooks/hooks.json"), &original)
            .await
            .unwrap();
        let before = tokio::fs::read(&original).await.unwrap();
        symlink(&original, plugin.join("hooks/hooks.json")).unwrap();
        let strategy = CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
        assert!(!strategy.deploy(&def).await.success);
        assert!(!strategy.undeploy(&def).await);
        assert_eq!(tokio::fs::read(&original).await.unwrap(), before);
        assert!(plugin.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uninstall_preserves_nested_foreign_jsonc_comments_and_separator_trivia() {
        for position in 0..3 {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            tokio::fs::create_dir_all(&home).await.unwrap();
            let def = definition(root.path());
            let strategy =
                CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
            assert!(strategy.deploy(&def).await.success);
            let settings = home.join("settings.json");
            let config = home.join("config.json");
            let original_settings="\u{feff}// user settings\n{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true,\n// foreign registration\n\"third@third\":true,},\"user\":\"中文\"}\n";
            let mut entries = vec![r#"{"name":"first"}"#, r#"{"name":"last"}"#];
            entries.insert(
                position,
                r#"{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}"#,
            );
            let original_config=format!("// user CLI\n{{\"installedPlugins\":[{}],\"url\":\"https://example.test/path//keep\"}}\n",entries.join(", /* foreign separator */ "));
            tokio::fs::write(&settings, original_settings)
                .await
                .unwrap();
            tokio::fs::write(&config, &original_config).await.unwrap();
            assert!(strategy.undeploy(&def).await);
            let next_settings = tokio::fs::read_to_string(&settings).await.unwrap();
            let next_config = tokio::fs::read_to_string(&config).await.unwrap();
            assert!(next_settings.starts_with('\u{feff}'));
            assert!(
                next_settings.contains("// user settings")
                    && next_settings.contains("// foreign registration")
            );
            assert!(next_config.contains("// user CLI"));
            assert_eq!(next_config.matches("foreign separator").count(), 2);
            assert_eq!(
                Snapshot::read(&config).await.unwrap().json().unwrap()["installedPlugins"],
                json!([{"name":"first"},{"name":"last"}])
            );
            assert_eq!(
                Snapshot::read(&settings).await.unwrap().json().unwrap()["enabledPlugins"],
                json!({"third@third":true})
            );
            assert!(!home.join("plugins/pilot").exists());
            assert!(strategy.undeploy(&def).await);
            assert_eq!(
                tokio::fs::read_to_string(&settings).await.unwrap(),
                next_settings
            );
            assert_eq!(
                tokio::fs::read_to_string(&config).await.unwrap(),
                next_config
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn user_config_symlink_cleanup_preserves_alias_target_mode_bom_and_jsonc() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        let def = definition(root.path());
        let strategy = CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
        assert!(strategy.deploy(&def).await.success);
        let alias = home.join("settings.json");
        let target = home.join("settings-target.json");
        tokio::fs::remove_file(&alias).await.unwrap();
        let original="\u{feff}{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true,/* foreign */\"other\":true},\"foreign\":\"中文\"}\n";
        tokio::fs::write(&target, original).await.unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink("settings-target.json", &alias).unwrap();
        assert!(strategy.undeploy(&def).await);
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&alias).unwrap(),
            PathBuf::from("settings-target.json")
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let raw = tokio::fs::read_to_string(&target).await.unwrap();
        assert!(raw.starts_with('\u{feff}'));
        assert!(raw.contains("/* foreign */"));
        assert_eq!(
            Snapshot::read_config(&alias).await.unwrap().json().unwrap(),
            json!({"enabledPlugins":{"other":true},"foreign":"中文"})
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn config_alias_retarget_and_target_cas_changes_never_overwrite_either_file() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("settings.json");
        let first = root.path().join("first.json");
        let second = root.path().join("second.json");
        tokio::fs::write(&first, "{\"value\":\"first\"}")
            .await
            .unwrap();
        tokio::fs::write(&second, "{\"value\":\"second\"}")
            .await
            .unwrap();
        symlink(&first, &alias).unwrap();
        let snapshot = Snapshot::read_config(&alias).await.unwrap();
        tokio::fs::remove_file(&alias).await.unwrap();
        symlink(&second, &alias).unwrap();
        assert!(snapshot.write("{\"value\":\"overwrite\"}").await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&first).await.unwrap(),
            "{\"value\":\"first\"}"
        );
        assert_eq!(
            tokio::fs::read_to_string(&second).await.unwrap(),
            "{\"value\":\"second\"}"
        );
        let snapshot = Snapshot::read_config(&alias).await.unwrap();
        tokio::fs::write(&second, "{\"value\":\"concurrent\"}")
            .await
            .unwrap();
        assert!(snapshot.write("{\"value\":\"overwrite\"}").await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&second).await.unwrap(),
            "{\"value\":\"concurrent\"}"
        );
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn final_config_symlink_opt_in_does_not_weaken_asset_or_dangling_link_guards() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("user.json");
        tokio::fs::write(&target, "{}").await.unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let alias = root.path().join("settings.json");
        symlink(&target, &alias).unwrap();
        assert!(Snapshot::read(&alias).await.is_err());
        let snapshot = Snapshot::read_config(&alias).await.unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(snapshot.write("{\"new\":true}").await.is_err());
        assert_eq!(tokio::fs::read_to_string(&target).await.unwrap(), "{}");
        let dangling = root.path().join("dangling.json");
        let absent = root.path().join("missing.json");
        symlink(&absent, &dangling).unwrap();
        assert!(Snapshot::read_config(&dangling).await.is_err());
        assert!(!absent.exists());
        assert!(std::fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn deploy_and_repair_preserve_foreign_nested_jsonc_comments_and_alias_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for position in 0..3 {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            tokio::fs::create_dir_all(&home).await.unwrap();
            let def = definition(root.path());
            let strategy =
                CopilotPluginStrategy::new(root.path().join("data")).with_home_dir(&home);
            let target = home.join("settings-target.json");
            let alias = home.join("settings.json");
            let settings="\u{feff}// user settings\n{\"enabledPlugins\":{/* head */\"third@third\":true,/* between */\"loongsuite-pilot@loongsuite-pilot\":false,/* tail */},\"custom\":\"中文\"}\n";
            tokio::fs::write(&target, settings).await.unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
            symlink("settings-target.json", &alias).unwrap();
            let mut entries = vec![
                r#"{"name":"first","details":{/* nested foreign */"value":42}}"#,
                r#"{"name":"last"}"#,
            ];
            entries.insert(
                position,
                r#"{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}"#,
            );
            let config=format!("// CLI metadata\n{{\"installedPlugins\":[/* array head */{},/* array tail */],\"url\":\"https://example.test//literal\"}}\n",entries.join(",/* separator */"));
            tokio::fs::write(home.join("config.json"), config)
                .await
                .unwrap();
            for repair in [false, true] {
                if repair {
                    tokio::fs::write(home.join("plugins/pilot/hooks/hooks.json"), "{}")
                        .await
                        .unwrap();
                    assert!(!strategy
                        .healthy(def.copilot_plugin.as_ref().unwrap())
                        .await
                        .unwrap());
                }
                let result = strategy.deploy(&def).await;
                assert!(result.success, "{:?}", result.error);
                let a = tokio::fs::read_to_string(&target).await.unwrap();
                let b = tokio::fs::read_to_string(home.join("config.json"))
                    .await
                    .unwrap();
                assert!(a.starts_with('\u{feff}'));
                for marker in [
                    "// user settings",
                    "/* head */",
                    "/* between */",
                    "/* tail */",
                ] {
                    assert!(a.contains(marker));
                }
                for marker in [
                    "// CLI metadata",
                    "/* array head */",
                    "/* array tail */",
                    "/* nested foreign */",
                ] {
                    assert!(b.contains(marker));
                }
                assert_eq!(b.matches("/* separator */").count(), 2);
                assert_eq!(
                    Snapshot::read_config(&alias).await.unwrap().json().unwrap()["enabledPlugins"],
                    json!({"third@third":true,"loongsuite-pilot@loongsuite-pilot":true})
                );
                let parsed = Snapshot::read_config(&home.join("config.json"))
                    .await
                    .unwrap()
                    .json()
                    .unwrap();
                let entries = parsed["installedPlugins"].as_array().unwrap();
                assert_eq!(entries.len(), 3);
                assert_eq!(
                    entries
                        .iter()
                        .filter(|entry| owned_registration(entry, "loongsuite-pilot"))
                        .count(),
                    1
                );
                assert_eq!(entries[0], json!({"name":"first","details":{"value":42}}));
                assert_eq!(entries[1], json!({"name":"last"}));
                assert!(std::fs::symlink_metadata(&alias)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                assert_eq!(
                    std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                    0o640
                );
            }
        }
    }

    #[tokio::test]
    async fn optimistic_snapshot_never_overwrites_a_concurrent_user_change() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        tokio::fs::write(&path, "{}").await.unwrap();
        let snapshot = Snapshot::read(&path).await.unwrap();
        tokio::fs::write(&path, "{\"newUserField\":true}")
            .await
            .unwrap();
        assert!(snapshot
            .write_key("enabledPlugins", Some(json!({"pilot":true})))
            .await
            .is_err());
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "{\"newUserField\":true}"
        );
    }

    #[test]
    fn shell_export_respects_explicit_user_exporter_settings_and_quotes_paths() {
        let text = copilot_shell_block(Path::new("/tmp/user's pilot"));
        assert!(text.contains("'\\''"));
        for key in [
            "COPILOT_OTEL_FILE_EXPORTER_PATH",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "COPILOT_OTEL_EXPORTER_TYPE",
            "COPILOT_OTEL_ENABLED",
        ] {
            assert!(text.contains(&format!("{key}+x")));
        }
        assert!(remove_blocks(&format!("before\n{BEGIN}\nunclosed")).is_err());
        assert_eq!(
            remove_blocks(&format!("before\n{BEGIN}\nowned\n{END}\nafter\n")).unwrap(),
            "before\nafter\n"
        );
    }
}

#[cfg(test)]
#[path = "copilot_plugin_main_history_contract_tests.rs"]
mod main_history_contract_tests;

#[cfg(test)]
#[path = "copilot_config_main_history_contract_tests.rs"]
mod config_main_history_contract_tests;
