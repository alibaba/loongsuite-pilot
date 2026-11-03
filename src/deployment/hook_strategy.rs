//! Hook deploy strategy: settings JSON/JSONC, Codex trust, and Kiro agents.

use super::hook_assets::HookAssets;
use crate::hooks::{legacy_claude_hook_paths, quote_claude_hook_path, HookDefinition, HookManager};
use crate::types::{
    AgentDefinition, AgentHookConfig, DeployMode, DeployResult, DeployStrategy,
    DeployedAgentRecord, EventSubcommand, HookInsert, SettingsSyntax,
};
use crate::updater::ActivationTransaction;
use crate::utils::{
    create_logger, edit_jsonc, parse_json_document, read_json_document, read_json_file,
    resolve_home, ExpectedFileState, JsonDocumentRead, JsonEditOptions, JsonPathSeg, JsonSyntax,
};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::codex_trust_writer::{
    event_key, installed_hook_state_key, plan_remove_trust, plan_trusted_hashes,
    verify_trust_content, verify_trust_hashes, InstalledCodexCommandHandler,
    InstalledCodexHookLocation, InstalledTrustOpts, TrustOpts,
};
use super::detect_utils::detect_agent;
use super::paths::node_resolve;

const INTERCEPTOR_TIMEOUT: &[(&str, f64)] = &[
    ("UserPromptSubmit", 15.0),
    ("PreToolUse", 10.0),
    ("PostToolUse", 10.0),
];

fn logger() -> crate::utils::BoundLogger {
    create_logger("HookStrategy")
}

fn event_to_subcommand(event: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = event.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && ch.is_ascii_uppercase() && chars[index - 1].is_ascii_lowercase() {
            out.push('-');
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

// Parse only a bare script path and its exact argument suffix. Legacy command
// forms are enumerated for ownership matching, never used to launch a process.
fn split_ps1_script(command: &str) -> Option<(&str, &str)> {
    let command = command.trim();
    if let Some(quoted) = command.strip_prefix('"') {
        let end = quoted.find('"')?;
        Some((&quoted[..end], quoted[end + 1..].trim()))
    } else {
        let lower = command.to_ascii_lowercase();
        let (index, _) = lower.match_indices(".ps1").find(|(index, _)| {
            command
                .as_bytes()
                .get(index + 4)
                .is_none_or(u8::is_ascii_whitespace)
        })?;
        Some((&command[..index + 4], command[index + 4..].trim()))
    }
}

fn wrap_legacy_ps1_command(cmd: &str) -> String {
    let Some((script, args)) = split_ps1_script(cmd) else {
        return cmd.to_string();
    };
    if !script.to_ascii_lowercase().ends_with(".ps1")
        || script.contains(['"', '\r', '\n'])
        || script.to_ascii_lowercase().starts_with("powershell")
        || script.to_ascii_lowercase().starts_with("pwsh ")
    {
        return cmd.to_string();
    }
    let wrapped = format!("powershell -NoProfile -ExecutionPolicy Bypass -File {script}");
    if args.is_empty() {
        wrapped
    } else {
        format!("{wrapped} {args}")
    }
}

fn wrap_ps1_for_platform(cmd: &str, windows: bool) -> String {
    if !windows {
        return cmd.to_string();
    }
    let Some((script, rest)) = split_ps1_script(cmd) else {
        return cmd.to_string();
    };
    if !script.to_ascii_lowercase().ends_with(".ps1")
        || script.contains(['"', '\r', '\n'])
        || script.to_ascii_lowercase().starts_with("powershell")
        || script.to_ascii_lowercase().starts_with("pwsh ")
    {
        return cmd.to_string();
    }
    let wrapped = format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script}\""
    );
    if rest.is_empty() {
        wrapped
    } else {
        format!("{wrapped} {rest}")
    }
}

fn append_event_subcommand(command: &str, event: &str, style: Option<EventSubcommand>) -> String {
    match style {
        Some(EventSubcommand::KebabCase) => format!("{command} {}", event_to_subcommand(event)),
        Some(EventSubcommand::AsIs) => format!("{command} {event}"),
        None => command.to_string(),
    }
}

fn format_hook_command(
    hook_command: &str,
    event: &str,
    style: Option<EventSubcommand>,
    agent_id: &str,
) -> String {
    if !cfg!(windows) && (agent_id == "claude-code" || hook_command.ends_with(".sh")) {
        return append_event_subcommand(&quote_claude_hook_path(hook_command), event, style);
    }
    append_event_subcommand(
        &wrap_ps1_for_platform(hook_command, cfg!(windows)),
        event,
        style,
    )
}

fn legacy_hook_commands(
    hook_command: &str,
    event: &str,
    style: Option<EventSubcommand>,
    agent_id: &str,
) -> Vec<String> {
    if !cfg!(windows) && (agent_id == "claude-code" || hook_command.ends_with(".sh")) {
        return legacy_claude_hook_paths(hook_command)
            .into_iter()
            .map(|command| append_event_subcommand(&command, event, style))
            .collect();
    }
    if !cfg!(windows) {
        return Vec::new();
    }
    let current = format_hook_command(hook_command, event, style, agent_id);
    windows_compatible_hook_commands(hook_command, event, style)
        .into_iter()
        .filter(|command| command != &current)
        .collect()
}

// Only enumerate known command forms. Arguments remain byte-exact so an
// unrecognized reference still aborts cleanup before runtime assets are removed.
fn windows_compatible_hook_commands(
    hook_command: &str,
    event: &str,
    style: Option<EventSubcommand>,
) -> Vec<String> {
    let mut out = Vec::new();
    for path in [
        hook_command.to_string(),
        hook_command.replace('\\', "/"),
        hook_command.replace('/', "\\"),
    ] {
        for command in [
            append_event_subcommand(&path, event, style),
            append_event_subcommand(&wrap_ps1_for_platform(&path, true), event, style),
            append_event_subcommand(&wrap_legacy_ps1_command(&path), event, style),
        ] {
            if !out.contains(&command) {
                out.push(command);
            }
        }
    }
    out
}

// Normalize only a known PowerShell script path. Shell flags, quotes and all
// arguments remain exact; normalizing the entire command could change an
// argument containing a literal backslash.
fn windows_hook_comparison_key(command: &str) -> Option<String> {
    let (prefix, body) = match command.split_once(" -File ") {
        Some((prefix, body)) => (format!("{prefix} -File "), body),
        None => (String::new(), command),
    };
    let (path, suffix, quoted) = if let Some(body) = body.strip_prefix('"') {
        let end = body.find('"')?;
        (&body[..end], &body[end + 1..], true)
    } else {
        let lower = body.to_ascii_lowercase();
        let (end, _) = lower.match_indices(".ps1").find(|(index, _)| {
            body.as_bytes()
                .get(index + 4)
                .is_none_or(u8::is_ascii_whitespace)
        })?;
        (&body[..end + 4], &body[end + 4..], false)
    };
    if !path.to_ascii_lowercase().ends_with(".ps1") || path.contains(['"', '\r', '\n']) {
        return None;
    }
    let quote = if quoted { "\"" } else { "" };
    Some(format!(
        "{prefix}{quote}{}{quote}{suffix}",
        path.replace('\\', "/")
    ))
}

fn hook_commands_match(installed: &str, expected: &str) -> bool {
    installed == expected
        || (cfg!(windows)
            && windows_hook_comparison_key(installed)
                .zip(windows_hook_comparison_key(expected))
                .is_some_and(|(installed, expected)| installed == expected))
}

fn windows_hook_spelling_aliases(definition: &HookDefinition, data: &Value) -> HookDefinition {
    let mut definition = definition.clone();
    let known: HashSet<_> = std::iter::once(&definition.hook_command)
        .chain(definition.replace_hook_commands.iter().flatten())
        .filter_map(|command| windows_hook_comparison_key(command))
        .collect();
    let entries = definition
        .hook_json_path
        .iter()
        .try_fold(data, |value, key| value.get(key))
        .and_then(Value::as_array);
    let mut aliases = definition.replace_hook_commands.take().unwrap_or_default();
    // The requested command must not also be considered retired: edit/status
    // correctly reject any retired command still present after installation.
    aliases.retain(|command| command != &definition.hook_command);
    if let Some(entries) = entries {
        for entry in entries {
            // Same direct/nested command shapes as HookManager; no recursive
            // removal from unknown host structures.
            for handler in std::iter::once(entry).chain(
                entry
                    .get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            ) {
                let Some(command) = handler.get("command").and_then(Value::as_str) else {
                    continue;
                };
                if command != definition.hook_command
                    && windows_hook_comparison_key(command).is_some_and(|key| known.contains(&key))
                    && !aliases.iter().any(|alias| alias == command)
                {
                    aliases.push(command.into());
                }
            }
        }
    }
    definition.replace_hook_commands = Some(aliases);
    definition
}

struct SettingsDocument {
    data: Value,
    raw: String,
    expected: ExpectedFileState,
    syntax: JsonSyntax,
}

impl SettingsDocument {
    fn from_snapshot(raw: Option<&str>, syntax: JsonSyntax) -> Result<Self, String> {
        let expected = raw.map_or(ExpectedFileState::Missing, |raw| {
            ExpectedFileState::Present(raw.into())
        });
        let raw = raw.unwrap_or("");
        let empty = raw.trim_start_matches('\u{feff}').trim().is_empty();
        let data = if empty {
            Value::Object(Map::new())
        } else {
            parse_json_document(raw, syntax)
                .map_err(|err| format!("invalid JSON settings: {}", err.message))?
        };
        if !data.is_object() {
            return Err("invalid JSON settings: 根节点必须为对象".into());
        }
        Ok(Self {
            data,
            raw: if empty {
                format!("{raw}{{}}\n")
            } else {
                raw.into()
            },
            expected,
            syntax,
        })
    }

    fn apply_hook(&mut self, definition: &HookDefinition, remove: bool) -> Result<(), String> {
        let compatible;
        let definition = if cfg!(windows) {
            compatible = windows_hook_spelling_aliases(definition, &self.data);
            &compatible
        } else {
            definition
        };
        self.raw = HookManager::edit_hook(&self.raw, definition, remove)?;
        self.data = parse_json_document(&self.raw, self.syntax).map_err(|err| err.message)?;
        Ok(())
    }

    fn changed(&self) -> bool {
        !matches!(&self.expected, ExpectedFileState::Present(raw) if raw == &self.raw)
    }

    async fn read(path: &str, syntax: JsonSyntax) -> Result<Self, String> {
        let (data, raw, expected) = match read_json_document(path, syntax).await {
            JsonDocumentRead::Ok { data, raw } => {
                let expected = ExpectedFileState::Present(raw.clone());
                (data, raw, expected)
            }
            JsonDocumentRead::Empty { raw } => (
                Value::Object(Map::new()),
                format!("{raw}{{}}\n"),
                ExpectedFileState::Present(raw),
            ),
            JsonDocumentRead::Missing => (
                Value::Object(Map::new()),
                "{}\n".into(),
                ExpectedFileState::Missing,
            ),
            JsonDocumentRead::Error { error } => {
                return Err(format!("invalid JSON settings {path}: {}", error.message));
            }
        };
        if !data.is_object() {
            return Err(format!("invalid JSON settings {path}: 根节点必须为对象"));
        }
        Ok(Self {
            data,
            raw,
            expected,
            syntax,
        })
    }

    fn set(&mut self, keys: &[&str], value: Option<Value>) -> Result<(), String> {
        let current = keys.iter().try_fold(&self.data, |item, key| item.get(*key));
        if current == value.as_ref() {
            return Ok(());
        }
        let path: Vec<_> = keys
            .iter()
            .map(|key| JsonPathSeg::Key((*key).into()))
            .collect();
        let next = edit_jsonc(&self.raw, &path, value.as_ref(), JsonEditOptions::default());
        let data = parse_json_document(&next, self.syntax).map_err(|err| err.to_string())?;
        if keys.iter().try_fold(&data, |item, key| item.get(*key)) != value.as_ref() {
            return Err("JSON 配置编辑校验失败，原文件未写入".into());
        }
        self.data = data;
        self.raw = next;
        Ok(())
    }

    #[cfg(test)]
    async fn save(self, path: &str) -> Result<(), String> {
        if matches!(&self.expected, ExpectedFileState::Present(raw) if raw == &self.raw) {
            return Ok(());
        }
        crate::utils::write_text_file_atomic(
            path,
            &self.raw,
            &crate::utils::AtomicTextWriteOptions {
                expected: Some(self.expected),
                ..crate::utils::AtomicTextWriteOptions::default()
            },
        )
        .await
        .map_err(|err| err.to_string())
    }
}

fn settings_syntax(hook: &AgentHookConfig) -> JsonSyntax {
    match hook.settings_syntax {
        Some(SettingsSyntax::Jsonc) => JsonSyntax::Jsonc,
        _ => JsonSyntax::Json,
    }
}

fn kiro_cli_settings(agent_settings_path: &str) -> String {
    let agents_dir = parent(agent_settings_path);
    let kiro_root = if Path::new(&agents_dir)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("agents")
    {
        parent(&agents_dir)
    } else {
        agents_dir
    };
    Path::new(&kiro_root)
        .join("settings/cli.json")
        .to_string_lossy()
        .into_owned()
}

fn normalize_hook_reference(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn remaining_hook_reference(value: &Value, needles: &[String]) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| remaining_hook_reference(value, needles)),
        Value::Object(values) => {
            values
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| {
                    let command = normalize_hook_reference(command);
                    needles
                        .iter()
                        .any(|needle| !needle.is_empty() && command.contains(needle))
                })
                || values
                    .values()
                    .any(|value| remaining_hook_reference(value, needles))
        }
        _ => false,
    }
}

pub struct HookStrategy {
    hook_manager: HookManager,
    resource_roots: Option<(PathBuf, PathBuf)>,
    deployment_state: Option<(PathBuf, Option<crate::types::InstalledBy>)>,
    preserve_runtime_assets: bool,
    #[cfg(test)]
    corrupt_next_planned_trust: std::sync::atomic::AtomicBool,
}

impl HookStrategy {
    pub fn new(hook_manager: HookManager) -> Self {
        Self {
            hook_manager,
            resource_roots: None,
            deployment_state: None,
            preserve_runtime_assets: false,
            #[cfg(test)]
            corrupt_next_planned_trust: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn preserving_runtime_assets(mut self) -> Self {
        self.preserve_runtime_assets = true;
        self
    }

    pub(crate) fn with_resource_roots(mut self, pilot: &Path, data: &Path) -> Self {
        self.resource_roots = Some((pilot.into(), data.into()));
        self
    }

    pub(crate) fn with_deployment_state(
        mut self,
        path: PathBuf,
        installed_by: Option<crate::types::InstalledBy>,
    ) -> Self {
        self.deployment_state = Some((path, installed_by));
        self
    }

    fn transaction_root(&self, def: &AgentDefinition) -> Result<PathBuf, String> {
        if let Some((_, data)) = &self.resource_roots {
            return Ok(data.clone());
        }
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        Path::new(&node_resolve(&resolve_home(&hook.settings_path)))
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Hook 配置缺少父目录".into())
    }

    fn recovery_pending(&self, def: &AgentDefinition) -> bool {
        self.transaction_root(def)
            .is_ok_and(|root| super::hook_assets::recovery_pending(&root))
    }

    pub async fn needs_hook_deploy(
        &self,
        def: &AgentDefinition,
        _record: Option<&DeployedAgentRecord>,
    ) -> bool {
        if self.recovery_pending(def) || self.preflight(def).await.is_err() {
            return true;
        }
        if self
            .resource_roots
            .as_ref()
            .is_some_and(|(pilot, data)| !super::hook_assets::healthy(def, pilot, data))
        {
            return true;
        }
        if self.needs_settings_repair(def).await {
            return true;
        }
        if def
            .hook
            .as_ref()
            .is_some_and(|hook| hook.kiro_agent.is_some())
        {
            return self.kiro_agent_needs_deploy(def).await;
        }
        for hook_def in self
            .build_interceptor_definitions(def)
            .iter()
            .chain(self.build_hook_definitions(def).iter())
        {
            if !self.hook_manager.is_hook_installed(hook_def).await {
                return true;
            }
        }
        for retired in self.build_retired_hook_definitions(def) {
            if self.hook_manager.is_hook_installed(&retired).await {
                return true;
            }
        }
        if self.needs_trust_repair_for_codex(def).await {
            return true;
        }
        false
    }

    async fn needs_settings_repair(&self, def: &AgentDefinition) -> bool {
        let Some(settings_path) = def.hook.as_ref().map(|hook| hook.settings_path.as_str()) else {
            return false;
        };
        if !settings_path.ends_with("hooks.json") {
            return false;
        }
        let Some(hook) = &def.hook else { return false };
        let Ok(existing) = SettingsDocument::read(settings_path, settings_syntax(hook)).await
        else {
            return true;
        };
        match def.id.as_str() {
            "codex" => existing.data.get("version").is_some(),
            "cursor" | "cursor-cli" => existing.data.get("version").is_none(),
            _ => false,
        }
    }

    async fn needs_trust_repair_for_codex(&self, def: &AgentDefinition) -> bool {
        let Some(hook) = &def.hook else { return false };
        let Some(cfg) = &hook.trust_toml else {
            return false;
        };
        match self
            .resolve_installed_codex_hooks(def, &hook.events, false)
            .await
        {
            Ok(locations) => {
                let opts = TrustOpts::Installed(InstalledTrustOpts {
                    config_path: resolve_home(&cfg.config_path),
                    hooks_json_abs_path: node_resolve(&resolve_home(&hook.settings_path)),
                    locations,
                    retired_keys: Vec::new(),
                    marker: cfg.marker.clone(),
                });
                verify_trust_hashes(&opts)
                    .map(|result| !result.valid)
                    .unwrap_or(true)
            }
            Err(err) => {
                logger().warn(
                    "could not resolve installed Codex hooks for trust verification",
                    Some(&err_meta(&def.id, &err)),
                );
                true
            }
        }
    }

    /// 只读预检全部关联配置；在资源准备和逐事件写入之前拒绝损坏配置。
    pub(crate) async fn preflight(&self, def: &AgentDefinition) -> Result<(), String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        if hook.events.is_empty() || hook.hook_command.trim().is_empty() {
            return Err("Hook 声明缺少事件或命令".into());
        }
        let document =
            SettingsDocument::read(&resolve_home(&hook.settings_path), settings_syntax(hook))
                .await?;
        if let Some(hooks) = document.data.get("hooks") {
            if !hooks.is_object() {
                return Err("invalid JSON settings: hooks 必须为对象".into());
            }
            for event in hook
                .events
                .iter()
                .chain(hook.retired_events.iter().flatten())
                .chain(hook.interceptor.iter().flat_map(|item| &item.events))
            {
                if hooks.get(event).is_some_and(|value| !value.is_array()) {
                    return Err(format!("invalid JSON settings: hooks.{event} 必须为数组"));
                }
            }
        }
        if hook.env.is_some()
            && document
                .data
                .get("env")
                .is_some_and(|value| !value.is_object())
        {
            return Err("invalid JSON settings: env 必须为对象".into());
        }
        if let Some(trust) = &hook.trust_toml {
            if let Some(raw) =
                super::codex_trust_writer::read_config_snapshot(&resolve_home(&trust.config_path))
                    .map_err(|err| format!("无法读取 Codex config.toml：{err}"))?
            {
                if toml::from_str::<toml::Value>(&raw).is_err() {
                    // Duplicate owned hook-state sections can be repaired, but
                    // only the normal strict planner may authorize that edit.
                    // Derive keys from actual installed matching commands;
                    // arbitrary trust keys and invalid unrelated TOML stay fatal.
                    let retired = self.build_retired_hook_definitions(def);
                    let events: Vec<_> = hook
                        .events
                        .iter()
                        .cloned()
                        .chain(
                            retired
                                .iter()
                                .filter_map(|item| item.hook_json_path.last().cloned()),
                        )
                        .collect();
                    let all = self.resolve_codex_hooks_from_data(
                        def,
                        &events,
                        true,
                        &document.data,
                        true,
                    )?;
                    let hooks_json = node_resolve(&resolve_home(&hook.settings_path));
                    let retired_keys = all
                        .iter()
                        .filter(|(event, _)| !hook.events.contains(event))
                        .map(|(_, location)| installed_hook_state_key(&hooks_json, location))
                        .collect();
                    let opts = TrustOpts::Installed(InstalledTrustOpts {
                        config_path: resolve_home(&trust.config_path),
                        hooks_json_abs_path: hooks_json,
                        locations: all
                            .into_iter()
                            .filter(|(event, _)| hook.events.contains(event))
                            .collect(),
                        retired_keys,
                        marker: trust.marker.clone(),
                    });
                    let planned = plan_trusted_hashes(&opts, Some(&raw))
                        .map_err(|_| "invalid Codex config.toml，未修改配置".to_string())?
                        .ok_or_else(|| "invalid Codex config.toml，未修改配置".to_string())?;
                    toml::from_str::<toml::Value>(&planned)
                        .map_err(|_| "invalid Codex config.toml，未修改配置".to_string())?;
                }
            }
        }
        if hook.kiro_agent.is_some() {
            let path = kiro_cli_settings(&resolve_home(&hook.settings_path));
            let cli = SettingsDocument::read(&path, JsonSyntax::Json).await?;
            if cli
                .data
                .get("chat.defaultAgent")
                .is_some_and(|value| !value.is_string())
            {
                return Err("invalid JSON settings: chat.defaultAgent 必须为字符串".into());
            }
        }
        Ok(())
    }

    pub async fn deploy_hooks(&self, def: &AgentDefinition) -> DeployResult {
        let Some(hook_config) = def.hook.clone() else {
            return fail(def, "missing hook config");
        };
        if hook_config.events.is_empty() || hook_config.hook_command.trim().is_empty() {
            return fail(def, "Hook 声明缺少事件或命令");
        }
        match self.configure(def, false).await {
            Ok(()) => ok(def),
            Err(err) => fail(def, &err),
        }
    }

    fn config_targets(&self, def: &AgentDefinition) -> Result<BTreeMap<String, PathBuf>, String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        let path = node_resolve(&resolve_home(&hook.settings_path));
        let mut targets = BTreeMap::from([("config".into(), PathBuf::from(&path))]);
        if hook.settings_syntax == Some(SettingsSyntax::Jsonc) {
            targets.insert(
                "backup".into(),
                PathBuf::from(format!("{path}.loongsuite-pilot.bak")),
            );
        }
        if let Some(trust) = &hook.trust_toml {
            targets.insert(
                "trust".into(),
                PathBuf::from(node_resolve(&resolve_home(&trust.config_path))),
            );
        }
        if hook.kiro_agent.is_some() {
            targets.insert("kiro-cli".into(), PathBuf::from(kiro_cli_settings(&path)));
        }
        if let Some((path, _)) = &self.deployment_state {
            targets.insert("state".into(), path.clone());
        }
        Ok(targets)
    }

    async fn configure(&self, def: &AgentDefinition, uninstall: bool) -> Result<(), String> {
        // 待恢复时必须先恢复再读取；否则部分写入的配置会被误用为新基线。
        if !self.recovery_pending(def) {
            self.preflight(def).await?;
        } else if uninstall {
            return Err("Hook 事务待恢复，停止清理并保留配置与资源".into());
        }
        let configs = self.config_targets(def)?;
        let settings = configs["config"].to_string_lossy().into_owned();
        let root = self.transaction_root(def)?;
        let assets = if uninstall {
            HookAssets::cleanup(
                def,
                &root,
                self.resource_roots.is_some() && !self.preserve_runtime_assets,
            )
        } else {
            HookAssets::load(
                def,
                self.resource_roots
                    .as_ref()
                    .map(|(pilot, _)| pilot.as_path()),
                &root,
            )
        }
        .map_err(|err| err.to_string())?;
        assets
            .apply(
                configs,
                (def.id == "claude-code").then_some(settings.as_str()),
                uninstall,
                |transaction| {
                    self.plan_config_edits(def, transaction, uninstall)
                        .map_err(anyhow::Error::msg)
                },
            )
            .await
            .map_err(|err| format!("Hook 事务失败：{err:#}"))
    }

    fn plan_config_edits(
        &self,
        def: &AgentDefinition,
        transaction: &ActivationTransaction,
        uninstall: bool,
    ) -> Result<BTreeMap<String, String>, String> {
        let snapshot = |key: &str| -> Result<Option<String>, String> {
            transaction
                .original_bytes(key)
                .map_err(|err| err.to_string())?
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| "Hook 配置不是 UTF-8".into())
        };
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        if hook.events.is_empty() || hook.hook_command.trim().is_empty() {
            return Err("Hook 声明缺少事件或命令".into());
        }
        let original = snapshot("config")?;
        let mut document =
            SettingsDocument::from_snapshot(original.as_deref(), settings_syntax(hook))?;
        let initial_raw = document.raw.clone();
        let mut edits = BTreeMap::new();
        let retired = self.build_retired_hook_definitions(def);
        let events: Vec<_> = hook
            .events
            .iter()
            .cloned()
            .chain(
                retired
                    .iter()
                    .filter_map(|item| item.hook_json_path.last().cloned()),
            )
            .collect();
        let hooks_json = node_resolve(&resolve_home(&hook.settings_path));
        let old_locations = if hook.trust_toml.is_some() {
            self.resolve_codex_hooks_from_data(def, &events, true, &document.data, true)?
        } else {
            HashMap::new()
        };
        if !uninstall {
            self.ensure_settings_file(def, &mut document)?;
        }
        if hook.kiro_agent.is_some() && !uninstall {
            let cli_original = snapshot("kiro-cli")?;
            let mut cli =
                SettingsDocument::from_snapshot(cli_original.as_deref(), JsonSyntax::Json)?;
            self.deploy_kiro_agent(def, &mut document, &mut cli)?;
            if cli.changed() {
                edits.insert("kiro-cli".into(), cli.raw);
            }
        } else {
            for retired in &retired {
                document.apply_hook(retired, true)?;
            }
            if !uninstall {
                if let Some(env) = &hook.env {
                    self.apply_env_to_settings(&mut document, env)?;
                }
            }
            for definition in self
                .build_interceptor_definitions(def)
                .iter()
                .chain(self.build_hook_definitions(def).iter())
            {
                document.apply_hook(definition, uninstall)?;
            }
        }
        if let Some(cfg) = &hook.trust_toml {
            let original = snapshot("trust")?;
            if uninstall {
                if let Some(raw) = &original {
                    toml::from_str::<toml::Value>(raw)
                        .map_err(|_| "invalid Codex config.toml，未修改配置".to_string())?;
                }
            }
            // Installation validates the fresh snapshot through the strict
            // owned-key trust planner and verifies its complete result below.
            // Parsing the unreconciled duplicate tables first would prevent
            // that existing repair path from ever running.
            let owned_keys: Vec<_> = old_locations
                .values()
                .map(|location| installed_hook_state_key(&hooks_json, location))
                .collect();
            if uninstall {
                if let Some(raw) = original.as_deref() {
                    if let Some(content) = plan_remove_trust(raw, &cfg.marker, &owned_keys)
                        .map_err(|err| err.to_string())?
                    {
                        edits.insert("trust".into(), content);
                    }
                }
            } else {
                let locations = self.resolve_codex_hooks_from_data(
                    def,
                    &hook.events,
                    false,
                    &document.data,
                    false,
                )?;
                let new_keys: HashSet<_> = locations
                    .values()
                    .map(|location| installed_hook_state_key(&hooks_json, location))
                    .collect();
                let opts = InstalledTrustOpts {
                    config_path: resolve_home(&cfg.config_path),
                    hooks_json_abs_path: hooks_json,
                    locations,
                    retired_keys: owned_keys
                        .into_iter()
                        .filter(|key| !new_keys.contains(key))
                        .collect(),
                    marker: cfg.marker.clone(),
                };
                let next =
                    plan_trusted_hashes(&TrustOpts::Installed(opts.clone()), original.as_deref())
                        .map_err(|err| err.to_string())?;
                #[cfg(test)]
                let next = if self
                    .corrupt_next_planned_trust
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    Some(String::new())
                } else {
                    next
                };
                let verify = verify_trust_content(
                    next.as_deref().or(original.as_deref()).unwrap_or(""),
                    &opts,
                );
                if !verify.valid {
                    return Err(format!(
                        "codex trust hash verification failed: {}",
                        verify.mismatches.join("; ")
                    ));
                }
                if let Some(next) = next {
                    edits.insert("trust".into(), next);
                }
            }
        }
        if uninstall && self.preserve_runtime_assets {
            let path = resolve_home(&hook.hook_command);
            let needles = [path.clone(), quote_claude_hook_path(&path)]
                .into_iter()
                .map(|path| normalize_hook_reference(&path))
                .collect::<Vec<_>>();
            if document
                .data
                .get("hooks")
                .is_some_and(|hooks| remaining_hook_reference(hooks, &needles))
            {
                return Err("Unrecognized Pilot Hook reference; configuration and runtime assets were preserved".into());
            }
        }
        if document.changed() && (!uninstall || document.raw != initial_raw) {
            edits.insert("config".into(), document.raw);
        }
        if let Some((_, installed_by)) = &self.deployment_state {
            if let Some(state) = super::deployed_state_merge::plan_hook_state(
                snapshot("state")?.as_deref(),
                def,
                *installed_by,
                uninstall,
                !edits.is_empty(),
            )
            .map_err(|err| err.to_string())?
            {
                edits.insert("state".into(), state);
            }
        }
        Ok(edits)
    }

    pub async fn undeploy_hooks(&self, def: &AgentDefinition) -> bool {
        match self.configure(def, true).await {
            Ok(()) => true,
            Err(err) => {
                logger().error(
                    "Hook 清理失败，配置与恢复材料保留",
                    Some(&err_meta(&def.id, &err)),
                );
                false
            }
        }
    }

    async fn resolve_installed_codex_hooks(
        &self,
        def: &AgentDefinition,
        event_names: &[String],
        allow_missing: bool,
    ) -> Result<HashMap<String, InstalledCodexHookLocation>, String> {
        let hook = def
            .hook
            .as_ref()
            .ok_or_else(|| "missing hook config".to_string())?;
        let settings_path = resolve_home(&hook.settings_path);
        let document = SettingsDocument::read(&settings_path, settings_syntax(hook)).await?;
        self.resolve_codex_hooks_from_data(def, event_names, allow_missing, &document.data, false)
    }

    fn resolve_codex_hooks_from_data(
        &self,
        def: &AgentDefinition,
        event_names: &[String],
        allow_missing: bool,
        data: &Value,
        include_legacy: bool,
    ) -> Result<HashMap<String, InstalledCodexHookLocation>, String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        let hook_command = resolve_home(&hook.hook_command);
        let settings_path = resolve_home(&hook.settings_path);
        if allow_missing && data.get("hooks").is_none() {
            return Ok(HashMap::new());
        }
        let hooks = data
            .get("hooks")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("installed hooks object missing: {settings_path}"))?;
        let mut result = HashMap::new();
        for event_name in event_names {
            let event_key =
                event_key(event_name).ok_or_else(|| format!("Unknown hook event: {event_name}"))?;
            let Some(groups) = hooks.get(event_name).and_then(Value::as_array) else {
                if allow_missing {
                    continue;
                }
                return Err(format!("installed hook event missing: {event_name}"));
            };
            let command =
                format_hook_command(&hook_command, event_name, hook.event_subcommand, &def.id);
            let mut matches = Vec::new();
            for (group_index, raw_group) in groups.iter().enumerate() {
                let Some(group) = raw_group.as_object() else {
                    continue;
                };
                let handlers = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![raw_group.clone()]);
                let nested = group.get("hooks").and_then(Value::as_array).is_some();
                for (handler_index, raw_handler) in handlers.iter().enumerate() {
                    let Some(handler) = raw_handler.as_object() else {
                        continue;
                    };
                    let Some(installed_command) = handler.get("command").and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let known_command = hook_commands_match(installed_command, &command)
                        || (include_legacy
                            && legacy_hook_commands(
                                &hook_command,
                                event_name,
                                hook.event_subcommand,
                                &def.id,
                            )
                            .iter()
                            .any(|old| hook_commands_match(installed_command, old)));
                    if !known_command {
                        continue;
                    }
                    if handler
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind != "command")
                    {
                        continue;
                    }
                    matches.push(InstalledCodexHookLocation {
                        event_name: event_name.clone(),
                        event_key: event_key.into(),
                        group_index,
                        handler_index: if nested { handler_index } else { 0 },
                        matcher: group
                            .get("matcher")
                            .and_then(Value::as_str)
                            .map(|value| value.to_string()),
                        handler: InstalledCodexCommandHandler {
                            command: installed_command.into(),
                            command_windows: handler
                                .get("commandWindows")
                                .or_else(|| handler.get("command_windows"))
                                .and_then(Value::as_str)
                                .map(|value| value.to_string()),
                            timeout: handler.get("timeout").and_then(Value::as_f64),
                            r#async: handler.get("async").and_then(Value::as_bool),
                            status_message: handler
                                .get("statusMessage")
                                .and_then(Value::as_str)
                                .map(|value| value.to_string()),
                            additional_context_limit: handler
                                .get("additionalContextLimit")
                                .and_then(Value::as_f64),
                        },
                    });
                }
            }
            if matches.is_empty() && allow_missing {
                continue;
            }
            if matches.len() != 1 {
                return Err(format!(
                    "expected exactly one installed Pilot handler for {event_name}; found {}",
                    matches.len()
                ));
            }
            result.insert(event_name.clone(), matches.remove(0));
        }
        Ok(result)
    }

    fn interceptor_timeout(&self, event: &str, timeout: Option<&Value>) -> Option<f64> {
        match timeout {
            Some(Value::Number(number)) => number.as_f64(),
            Some(Value::Object(map)) => map
                .get(event)
                .and_then(Value::as_f64)
                .or_else(|| default_timeout(event)),
            _ => default_timeout(event),
        }
    }

    fn build_interceptor_definitions(&self, def: &AgentDefinition) -> Vec<HookDefinition> {
        let Some(hook_config) = &def.hook else {
            return Vec::new();
        };
        let Some(interceptor) = &hook_config.interceptor else {
            return Vec::new();
        };
        interceptor
            .events
            .iter()
            .map(|event| {
                let matcher = interceptor
                    .event_matchers
                    .as_ref()
                    .and_then(|map| map.get(event))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .or_else(|| interceptor.matcher.clone())
                    .or_else(|| hook_config.matcher.clone());
                HookDefinition {
                    agent_id: def.id.clone(),
                    settings_path: hook_config.settings_path.clone(),
                    settings_syntax: hook_config.settings_syntax,
                    hook_json_path: vec!["hooks".into(), event.clone()],
                    hook_command: format_hook_command(
                        &interceptor.hook_command,
                        event,
                        hook_config.event_subcommand,
                        &def.id,
                    ),
                    matcher,
                    history_dir: None,
                    replace_hook_commands: interceptor
                        .replace_hook_commands
                        .clone()
                        .or_else(|| Some(Vec::new())),
                    use_nested_format: Some(hook_config.format.as_str() == "nested"),
                    shell: if cfg!(windows) {
                        hook_config.win_shell.clone()
                    } else {
                        None
                    },
                    timeout: self.interceptor_timeout(event, interceptor.timeout.as_ref()),
                    insert: interceptor.insert.or(Some(HookInsert::Head)),
                }
            })
            .collect()
    }

    fn build_hook_definitions(&self, def: &AgentDefinition) -> Vec<HookDefinition> {
        let Some(hook_config) = &def.hook else {
            return Vec::new();
        };
        hook_config
            .events
            .iter()
            .map(|event| self.hook_definition(def, hook_config, event, false))
            .collect()
    }

    fn build_retired_hook_definitions(&self, def: &AgentDefinition) -> Vec<HookDefinition> {
        let Some(hook_config) = &def.hook else {
            return Vec::new();
        };
        let Some(retired) = &hook_config.retired_events else {
            return Vec::new();
        };
        let current: HashSet<&str> = hook_config.events.iter().map(String::as_str).collect();
        let mut seen = HashSet::new();
        retired
            .iter()
            .filter(|event| !current.contains(event.as_str()) && seen.insert((*event).clone()))
            .map(|event| self.hook_definition(def, hook_config, event, true))
            .collect()
    }

    fn hook_definition(
        &self,
        def: &AgentDefinition,
        hook_config: &AgentHookConfig,
        event: &str,
        _retired: bool,
    ) -> HookDefinition {
        let matcher = hook_config
            .event_matchers
            .as_ref()
            .and_then(|map| map.get(event))
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .or_else(|| hook_config.matcher.clone());
        let mut replace = hook_config
            .replace_hook_commands
            .clone()
            .unwrap_or_default();
        replace.extend(legacy_hook_commands(
            &hook_config.hook_command,
            event,
            hook_config.event_subcommand,
            &def.id,
        ));
        HookDefinition {
            agent_id: def.id.clone(),
            settings_path: hook_config.settings_path.clone(),
            settings_syntax: hook_config.settings_syntax,
            hook_json_path: vec!["hooks".into(), event.to_string()],
            hook_command: format_hook_command(
                &hook_config.hook_command,
                event,
                hook_config.event_subcommand,
                &def.id,
            ),
            matcher,
            history_dir: None,
            replace_hook_commands: Some(replace),
            use_nested_format: Some(hook_config.format.as_str() == "nested"),
            shell: if cfg!(windows) {
                hook_config.win_shell.clone()
            } else {
                None
            },
            timeout: None,
            insert: None,
        }
    }

    fn apply_env_to_settings(
        &self,
        document: &mut SettingsDocument,
        env: &Map<String, Value>,
    ) -> Result<(), String> {
        if document
            .data
            .get("env")
            .is_some_and(|value| !value.is_object())
        {
            return Err("invalid JSON settings: env 必须为对象".into());
        }
        for (key, value) in env {
            let mut value = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            if key == "BUN_OPTIONS" {
                if let Some(current) = document
                    .data
                    .get("env")
                    .and_then(|env| env.get(key))
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    let current_tokens: Vec<_> = current.split_whitespace().collect();
                    if value
                        .split_whitespace()
                        .all(|token| current_tokens.contains(&token))
                    {
                        continue;
                    }
                    value = format!("{current} {value}").trim().to_string();
                }
            }
            document.set(&["env", key], Some(Value::String(value)))?;
        }
        Ok(())
    }

    fn deploy_kiro_agent(
        &self,
        def: &AgentDefinition,
        document: &mut SettingsDocument,
        cli: &mut SettingsDocument,
    ) -> Result<(), String> {
        let hook_config = def.hook.as_ref().unwrap();
        let agent = hook_config.kiro_agent.as_ref().unwrap();
        let hook_command_base = resolve_home(&hook_config.hook_command);
        document.set(&["name"], Some(Value::String(agent.name.clone())))?;
        document.set(&["tools"], Some(serde_json::json!(agent.tools)))?;
        for event in &hook_config.events {
            let cmd = format_hook_command(
                &hook_command_base,
                event,
                hook_config.event_subcommand,
                &def.id,
            );
            let mut entry = Map::new();
            entry.insert("command".into(), Value::String(cmd.clone()));
            if let Some(matcher) = &hook_config.matcher {
                entry.insert("matcher".into(), Value::String(matcher.clone()));
            }
            let mut arr = document
                .data
                .get("hooks")
                .and_then(|hooks| hooks.get(event))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let old_commands = legacy_hook_commands(
                &hook_command_base,
                event,
                hook_config.event_subcommand,
                &def.id,
            );
            arr.retain(|item| {
                item.get("command")
                    .and_then(Value::as_str)
                    .is_none_or(|existing| {
                        existing != cmd && !old_commands.iter().any(|old| old == existing)
                    })
            });
            if !arr
                .iter()
                .any(|item| item.get("command").and_then(Value::as_str) == Some(cmd.as_str()))
            {
                arr.push(Value::Object(entry));
            }
            document.set(&["hooks", event], Some(Value::Array(arr)))?;
        }
        self.set_kiro_default_agent_if_missing(&agent.name, cli)
    }

    fn set_kiro_default_agent_if_missing(
        &self,
        agent_name: &str,
        cli: &mut SettingsDocument,
    ) -> Result<(), String> {
        if let Some(value) = cli.data.get("chat.defaultAgent") {
            if !value.is_string() {
                return Err("invalid JSON settings: chat.defaultAgent 必须为字符串".into());
            }
            if value.as_str().is_some_and(|value| !value.is_empty()) {
                return Ok(());
            }
        }
        cli.set(
            &["chat.defaultAgent"],
            Some(Value::String(agent_name.into())),
        )?;
        Ok(())
    }

    async fn kiro_agent_needs_deploy(&self, def: &AgentDefinition) -> bool {
        let Some(hook_config) = &def.hook else {
            return true;
        };
        let cli_path = kiro_cli_settings(&resolve_home(&hook_config.settings_path));
        let cli: Option<Value> = read_json_file(&cli_path).await;
        if cli
            .as_ref()
            .and_then(|cli| cli.get("chat.defaultAgent"))
            .and_then(Value::as_str)
            .is_none_or(|value| value.is_empty())
        {
            return true;
        }
        let Ok(settings) = SettingsDocument::read(
            &resolve_home(&hook_config.settings_path),
            settings_syntax(hook_config),
        )
        .await
        else {
            return true;
        };
        let Some(hooks) = settings.data.get("hooks").and_then(Value::as_object) else {
            return true;
        };
        let base = resolve_home(&hook_config.hook_command);
        for event in &hook_config.events {
            let cmd = format_hook_command(&base, event, hook_config.event_subcommand, &def.id);
            let Some(arr) = hooks.get(event).and_then(Value::as_array) else {
                return true;
            };
            if !arr
                .iter()
                .any(|item| item.get("command").and_then(Value::as_str) == Some(cmd.as_str()))
            {
                return true;
            }
        }
        false
    }

    fn ensure_settings_file(
        &self,
        def: &AgentDefinition,
        document: &mut SettingsDocument,
    ) -> Result<(), String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        let settings_path = resolve_home(&hook.settings_path);
        if !settings_path.ends_with("hooks.json") {
            return Ok(());
        }
        if document.data.get("hooks").is_none() {
            document.set(&["hooks"], Some(Value::Object(Map::new())))?;
        }
        if matches!(def.id.as_str(), "cursor" | "cursor-cli")
            && document.data.get("version").is_none()
        {
            document.set(&["version"], Some(Value::from(1)))?;
        } else if def.id == "codex" {
            document.set(&["version"], None)?;
        }
        Ok(())
    }
}

fn default_timeout(event: &str) -> Option<f64> {
    INTERCEPTOR_TIMEOUT
        .iter()
        .find(|(name, _)| *name == event)
        .map(|(_, timeout)| *timeout)
}

fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn err_meta(agent_id: &str, err: &str) -> Map<String, Value> {
    serde_json::json!({ "agentId": agent_id, "error": err })
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn ok(def: &AgentDefinition) -> DeployResult {
    DeployResult {
        success: true,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::Hook,
        skipped: None,
        reason: None,
        error: None,
        plugin_inject_config_path: None,
    }
}

fn fail(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::Hook,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[async_trait]
impl DeployStrategy for HookStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        detect_agent(&def.detection).await
    }

    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        self.needs_hook_deploy(def, record).await
    }

    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        self.deploy_hooks(def).await
    }

    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        self.undeploy_hooks(def).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_hook_paths_preserve_unicode_spaces_and_arguments() {
        for script in [
            "C:/Users/中文 🚀/hooks/cursor.ps1",
            "C:\\Users\\a & b\\hooks\\qoder.ps1",
            "C:/folder.ps1/hooks/KIRO.PS1",
        ] {
            let expected = format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script}\" --agent-id qoder-cn");
            assert_eq!(
                wrap_ps1_for_platform(&format!("{script} --agent-id qoder-cn"), true),
                expected
            );
            assert_eq!(
                wrap_ps1_for_platform(&format!("\"{script}\" --agent-id qoder-cn"), true),
                expected
            );
            assert_eq!(wrap_ps1_for_platform(&expected, true), expected);
            assert_eq!(wrap_ps1_for_platform(script, false), script);
        }
    }

    #[test]
    fn windows_compatible_commands_preserve_arguments_and_both_path_separators() {
        let path = "C:/Users/研发 O'Brien 🚀/hooks/cursor.ps1";
        let commands =
            windows_compatible_hook_commands(path, "Stop", Some(EventSubcommand::KebabCase));
        for path in [path.to_string(), path.replace('/', "\\")] {
            let command = format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{path}\" stop");
            assert!(commands.contains(&command));
            let legacy = format!("powershell -NoProfile -ExecutionPolicy Bypass -File {path} stop");
            assert!(
                commands.contains(&legacy),
                "missing legacy spelling: {legacy}"
            );
            assert!(!commands.contains(&format!("{legacy} --unknown")));
            assert!(!commands.contains(&format!("{command} --unknown")));
        }
        assert!(!commands
            .iter()
            .any(|command| command.contains("other-install")));
    }

    #[test]
    fn windows_cleanup_matches_mixed_script_separators_without_normalizing_arguments() {
        let command = r#"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/研发 🚀/data/hooks/cursor.ps1" --value "\keep""#;
        let mixed = r#"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\研发 🚀\data\hooks/cursor.ps1" --value "\keep""#;
        let wrong_arg = mixed.replace(r"\keep", "/keep");
        let unknown_arg = format!("{mixed} --unknown");
        let foreign = mixed.replace("data", "other-install");
        let raw = serde_json::json!({"hooks":{"stop":[
            {"command":mixed},
            {"hooks":[{"type":"command","command":mixed}]},
            {"command":wrong_arg},{"command":unknown_arg},{"command":foreign}
        ]}})
        .to_string();
        let definition = HookDefinition {
            agent_id: "cursor".into(),
            settings_path: "unused".into(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "stop".into()],
            hook_command: command.into(),
            matcher: None,
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: None,
            shell: None,
            timeout: None,
            insert: None,
        };
        let data: Value = serde_json::from_str(&raw).unwrap();
        let compatible = windows_hook_spelling_aliases(&definition, &data);
        let next = HookManager::edit_hook(&raw, &compatible, true).unwrap();
        let data: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(
            data["hooks"]["stop"],
            serde_json::json!([
                {"command":wrong_arg},{"command":unknown_arg},{"command":foreign}
            ])
        );
        assert_eq!(
            windows_hook_comparison_key(mixed),
            windows_hook_comparison_key(command)
        );
        assert_ne!(
            windows_hook_comparison_key(mixed),
            windows_hook_comparison_key(&wrong_arg)
        );
    }

    #[tokio::test]
    async fn windows_current_command_is_never_retired_during_install_reinstall_or_status() {
        let root = tempfile::tempdir().unwrap();
        let command = r#"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/研发 🚀/hooks/cursor.ps1""#;
        for nested in [false, true] {
            let path = root.path().join(format!("settings-{nested}.json"));
            let mut definition = HookDefinition {
                agent_id: "cursor".into(),
                settings_path: path.to_string_lossy().into_owned(),
                settings_syntax: None,
                hook_json_path: vec!["hooks".into(), "stop".into()],
                hook_command: command.into(),
                matcher: None,
                history_dir: None,
                replace_hook_commands: Some(vec![command.into()]),
                use_nested_format: Some(nested),
                shell: None,
                timeout: None,
                insert: None,
            };
            let initial = serde_json::json!({"hooks":{"stop":[{"command":"user-owned-hook"}]}});
            let compatible = windows_hook_spelling_aliases(&definition, &initial);
            assert!(!compatible
                .replace_hook_commands
                .as_ref()
                .unwrap()
                .iter()
                .any(|old| old == command));
            let first = HookManager::edit_hook(&initial.to_string(), &compatible, false).unwrap();
            let data: Value = serde_json::from_str(&first).unwrap();
            let compatible = windows_hook_spelling_aliases(&definition, &data);
            let second = HookManager::edit_hook(&first, &compatible, false).unwrap();
            assert_eq!(first, second);
            std::fs::write(&path, &second).unwrap();
            assert!(
                HookManager::new(None, None)
                    .is_hook_installed(&compatible)
                    .await
            );
            let serialized = serde_json::to_string(&data).unwrap();
            assert_eq!(serialized.matches("user-owned-hook").count(), 1);
            assert_eq!(serialized.matches("cursor.ps1").count(), 1);
            // The producer used by health/status also excludes the current form.
            definition.replace_hook_commands = Some(legacy_hook_commands(
                r"C:/Users/研发 🚀/hooks/cursor.ps1",
                "stop",
                None,
                "cursor",
            ));
            assert!(!definition
                .replace_hook_commands
                .as_ref()
                .unwrap()
                .iter()
                .any(|old| old == command));
            assert!(
                HookManager::new(None, None)
                    .is_hook_installed(&definition)
                    .await
            );
        }
    }

    use crate::types::{
        AgentDetectionConfig, DeployStrategy, HookFormat, KiroAgentSeed, TrustAlgo, TrustTomlConfig,
    };
    use crate::utils::resolve_home;

    fn base_def(id: &str, settings: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.into(),
            display_name: id.into(),
            deploy_mode: DeployMode::Hook,
            detection: AgentDetectionConfig {
                paths: vec![settings.into()],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: Some(AgentHookConfig {
                settings_path: settings.into(),
                settings_syntax: None,
                events: vec!["Stop".into()],
                hook_command: "/opt/hook.sh".into(),
                format: HookFormat::Nested,
                matcher: Some("*".into()),
                event_matchers: None,
                replace_hook_commands: None,
                retired_events: None,
                trust_toml: None,
                event_subcommand: Some(EventSubcommand::KebabCase),
                raw_command: None,
                win_shell: None,
                env: None,
                kiro_agent: None,
                interceptor: None,
            }),
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        }
    }

    #[tokio::test]
    async fn creates_cursor_version_and_strips_codex_version() {
        let dir = tempfile::tempdir().unwrap();
        let cursor = dir.path().join(".cursor").join("hooks.json");
        let codex = dir.path().join(".codex").join("hooks.json");
        std::fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        let manager = HookManager::new(
            Some(dir.path().join("hooks").to_string_lossy().into_owned()),
            Some(dir.path().join("logs").to_string_lossy().into_owned()),
        );
        let strategy = HookStrategy::new(manager);
        let mut cursor_def = base_def("cursor", &cursor.to_string_lossy());
        cursor_def.hook.as_mut().unwrap().event_subcommand = None;
        cursor_def.hook.as_mut().unwrap().events = vec!["stop".into()];
        assert!(strategy.deploy(&cursor_def).await.success);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&cursor).unwrap()).unwrap();
        assert_eq!(parsed["version"], 1);

        std::fs::write(&codex, "{\n  \"version\": 1,\n  \"hooks\": {}\n}\n").unwrap();
        let mut codex_def = base_def("codex", &codex.to_string_lossy());
        codex_def.hook.as_mut().unwrap().trust_toml = None;
        assert!(strategy.deploy(&codex_def).await.success);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&codex).unwrap()).unwrap();
        assert!(parsed.get("version").is_none());
        assert!(parsed["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("stop"));
    }

    #[tokio::test]
    async fn merges_env_and_bun_options_by_token() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "{\n  \"env\": { \"KEEP\": \"yes\", \"BUN_OPTIONS\": \"--preload=/other.mjs\" },\n  \"theme\": \"dark\"\n}\n").unwrap();
        let mut def = base_def("claude-code", &settings.to_string_lossy());
        let mut env = Map::new();
        env.insert(
            "BUN_OPTIONS".into(),
            Value::String("--preload=/pilot/intercept.mjs".into()),
        );
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            Value::String("/data".into()),
        );
        def.hook.as_mut().unwrap().env = Some(env);
        def.hook.as_mut().unwrap().event_subcommand = None;
        let strategy = HookStrategy::new(HookManager::new(None, None));
        assert!(strategy.deploy(&def).await.success);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(parsed["env"]["KEEP"], "yes");
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["env"]["LOONGSUITE_PILOT_DATA_DIR"], "/data");
        let bun = parsed["env"]["BUN_OPTIONS"].as_str().unwrap();
        assert!(bun.contains("--preload=/other.mjs"));
        assert!(bun.contains("--preload=/pilot/intercept.mjs"));

        let before = std::fs::read_to_string(&settings).unwrap();
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), before);
        let _ = resolve_home;
    }

    #[tokio::test]
    async fn sets_kiro_default_agent_only_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agents").join("pilot-kiro.json");
        std::fs::create_dir_all(agent.parent().unwrap()).unwrap();
        let mut def = base_def("kiro-cli", &agent.to_string_lossy());
        def.hook.as_mut().unwrap().kiro_agent = Some(KiroAgentSeed {
            name: "pilot-kiro".into(),
            tools: vec!["shell".into()],
        });
        def.hook.as_mut().unwrap().events = vec!["Stop".into()];
        def.hook.as_mut().unwrap().event_subcommand = None;
        let strategy = HookStrategy::new(HookManager::new(None, None));
        assert!(strategy.deploy(&def).await.success);
        let cli: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("settings").join("cli.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cli["chat.defaultAgent"], "pilot-kiro");
        std::fs::write(
            dir.path().join("settings").join("cli.json"),
            "{\n  \"chat.defaultAgent\": \"user\"\n}\n",
        )
        .unwrap();
        assert!(strategy.deploy(&def).await.success);
        let cli: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("settings").join("cli.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cli["chat.defaultAgent"], "user");
    }

    #[tokio::test]
    async fn writes_codex_trust_before_removing_retired_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join(".codex").join("hooks.json");
        let config = dir.path().join("config.toml");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        let mut def = base_def("codex", &hooks.to_string_lossy());
        def.hook.as_mut().unwrap().events = vec!["Stop".into()];
        def.hook.as_mut().unwrap().retired_events = Some(vec!["PreToolUse".into()]);
        def.hook.as_mut().unwrap().hook_command = "/opt/hook.sh".into();
        def.hook.as_mut().unwrap().trust_toml = Some(TrustTomlConfig {
            config_path: config.to_string_lossy().into_owned(),
            trust_algo: TrustAlgo::V1,
            marker: "otel-codex-hook".into(),
        });
        std::fs::write(
            &hooks,
            r#"{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/opt/hook.sh pre-tool-use" }] }],
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/opt/hook.sh stop" }] }]
  }
}"#,
        )
        .unwrap();
        let strategy = HookStrategy::new(HookManager::new(None, None));
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let toml = std::fs::read_to_string(&config).unwrap();
        assert!(toml.contains("trusted_hash"));
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        assert!(parsed["hooks"].get("PreToolUse").is_none());
        assert!(parsed["hooks"].get("Stop").is_some());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_cleanup_removes_trust_for_mixed_windows_script_paths() {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join(".codex/hooks.json");
        let config = root.path().join(".codex/config.toml");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let path = root.path().join("研发 🚀/hooks/codex.ps1");
        let normalized = path.to_string_lossy().replace('\\', "/");
        let mixed = path.to_string_lossy().into_owned();
        assert_ne!(normalized, mixed);
        let mut def = base_def("codex", &settings.to_string_lossy());
        let hook = def.hook.as_mut().unwrap();
        hook.hook_command = normalized;
        hook.events = vec!["Stop".into()];
        hook.event_subcommand = None;
        hook.trust_toml = Some(TrustTomlConfig {
            config_path: config.to_string_lossy().into_owned(),
            trust_algo: TrustAlgo::V1,
            marker: "otel-codex-hook".into(),
        });
        let command = wrap_ps1_for_platform(&mixed, true);
        let data = serde_json::json!({"hooks":{"Stop":[
            {"matcher":"*","hooks":[
                {"type":"command","command":command},
                {"type":"command","command":"user-owned-command"}
            ]}
        ]}});
        std::fs::write(&settings, data.to_string()).unwrap();
        let strategy = HookStrategy::new(HookManager::new(None, None));
        let locations = strategy
            .resolve_codex_hooks_from_data(&def, &["Stop".into()], false, &data, true)
            .unwrap();
        assert_eq!(locations.len(), 1);
        assert_eq!(locations["Stop"].handler.command, command);
        let trust = plan_trusted_hashes(
            &TrustOpts::Installed(InstalledTrustOpts {
                config_path: config.to_string_lossy().into_owned(),
                hooks_json_abs_path: node_resolve(&settings.to_string_lossy()),
                locations,
                retired_keys: vec![],
                marker: "otel-codex-hook".into(),
            }),
            Some("model = \"user-model\"\n"),
        )
        .unwrap()
        .unwrap();
        assert!(trust.contains("trusted_hash"));
        std::fs::write(&config, trust).unwrap();
        assert!(strategy.undeploy_hooks(&def).await);
        let remaining = std::fs::read_to_string(&config).unwrap();
        assert!(remaining.contains("user-model"));
        assert!(!remaining.contains("trusted_hash"));
        let remaining: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            remaining["hooks"]["Stop"][0]["hooks"],
            serde_json::json!([
                {"type":"command","command":"user-owned-command"}
            ])
        );
    }

    #[tokio::test]
    async fn jsonc_env_merge_preserves_comments_and_rejects_invalid_shapes() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.jsonc");
        let raw = "\u{feff}{\n // 用户顶层注释\n \"env\": {\n  // 用户环境注释\n  \"KEEP\": \"保留🚀\",\n },\n \"theme\": \"dark\",\n}\n";
        std::fs::write(&settings, raw).unwrap();
        let mut def = base_def("qoder", settings.to_str().unwrap());
        let hook = def.hook.as_mut().unwrap();
        hook.settings_syntax = Some(SettingsSyntax::Jsonc);
        hook.env = Some(
            serde_json::json!({"PILOT_TEST": "fixture"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let strategy = HookStrategy::new(HookManager::new(
            Some(dir.path().join("hooks").to_string_lossy().into_owned()),
            Some(dir.path().join("logs").to_string_lossy().into_owned()),
        ));
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let next = std::fs::read_to_string(&settings).unwrap();
        assert!(next.starts_with('\u{feff}'));
        assert!(next.contains("// 用户顶层注释") && next.contains("// 用户环境注释"));
        let value = parse_json_document(&next, JsonSyntax::Jsonc).unwrap();
        assert_eq!(value["env"]["KEEP"], "保留🚀");
        assert_eq!(value["env"]["PILOT_TEST"], "fixture");
        assert_eq!(value["theme"], "dark");
        assert!(strategy.deploy(&def).await.success);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), next);
        for invalid in [
            "[]",
            "{broken",
            r#"{"env": []}"#,
            r#"{"hooks": []}"#,
            r#"{"hooks":{"Stop": {}}}"#,
        ] {
            std::fs::write(&settings, invalid).unwrap();
            assert!(!strategy.deploy(&def).await.success, "{invalid}");
            assert_eq!(std::fs::read_to_string(&settings).unwrap(), invalid);
        }
    }

    #[tokio::test]
    async fn corrupt_companion_configs_fail_before_writing_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let strategy = HookStrategy::new(HookManager::new(None, None));
        for (id, definition, settings_relative, companion) in [
            (
                "codex",
                include_str!("../../agents.d/codex.json"),
                "hooks.json",
                "config.toml",
            ),
            (
                "kiro-cli",
                include_str!("../../agents.d/kiro-cli.json"),
                "agents/pilot-kiro.json",
                "settings/cli.json",
            ),
        ] {
            let home = dir.path().join(id);
            let parsed: AgentDefinition = serde_json::from_str(definition).unwrap();
            let def = super::super::hook_install_service::definition_at_install_home(
                &parsed,
                home.to_str().unwrap(),
            )
            .unwrap();
            let other = home.join(companion);
            std::fs::create_dir_all(other.parent().unwrap()).unwrap();
            std::fs::write(&other, "deliberately broken [").unwrap();
            let result = strategy.deploy(&def).await;
            assert!(!result.success, "{id}");
            assert!(
                !home.join(settings_relative).exists(),
                "{id} 不得留下部分 Hook"
            );
            assert_eq!(
                std::fs::read_to_string(other).unwrap(),
                "deliberately broken ["
            );
        }
    }

    #[tokio::test]
    async fn settings_document_detects_concurrent_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        let mut document = SettingsDocument::read(path.to_str().unwrap(), JsonSyntax::Json)
            .await
            .unwrap();
        document.set(&["test"], Some(Value::Bool(true))).unwrap();
        std::fs::write(&path, "{\"user\":true}").unwrap();
        assert!(document.save(path.to_str().unwrap()).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"user\":true}");
    }

    fn transaction_fixture(root: &Path, id: &str) -> (HookStrategy, AgentDefinition) {
        let data = root.join("数据 🚀");
        let pilot = root.join("candidate");
        let settings = if id == "kiro-cli" {
            root.join("agent/agents/pilot.json")
        } else {
            root.join("agent/hooks.json")
        };
        let mut def = base_def(id, settings.to_str().unwrap());
        let hook = def.hook.as_mut().unwrap();
        hook.settings_syntax = Some(SettingsSyntax::Jsonc);
        hook.hook_command = data
            .join(if cfg!(windows) {
                "hooks/fixture.ps1"
            } else {
                "hooks/fixture.sh"
            })
            .to_string_lossy()
            .into_owned();
        hook.events = vec!["SessionStart".into(), "Stop".into()];
        if id == "codex" {
            hook.trust_toml = Some(TrustTomlConfig {
                config_path: root
                    .join("agent/config.toml")
                    .to_string_lossy()
                    .into_owned(),
                trust_algo: TrustAlgo::V1,
                marker: "otel-codex-hook".into(),
            });
        }
        if id == "kiro-cli" {
            hook.kiro_agent = Some(KiroAgentSeed {
                name: "pilot".into(),
                tools: vec!["shell".into()],
            });
        }
        (
            HookStrategy::new(HookManager::new(None, None))
                .with_resource_roots(&pilot, &data)
                .with_deployment_state(
                    data.join("deployed-agents.json"),
                    Some(crate::types::InstalledBy::HookInstall),
                ),
            def,
        )
    }

    fn seed_transaction_fixture(root: &Path, id: &str) -> (HookStrategy, AgentDefinition) {
        let (strategy, def) = transaction_fixture(root, id);
        let pilot = root.join("candidate");
        super::super::hook_assets::seed_development_root(&pilot);
        let suffix = if cfg!(windows) { "ps1" } else { "sh" };
        std::fs::create_dir_all(pilot.join("assets/hooks/shared")).unwrap();
        std::fs::write(
            pilot.join(format!("assets/hooks/fixture.{suffix}")),
            "fixture entry",
        )
        .unwrap();
        std::fs::write(
            pilot.join(format!("assets/hooks/shared/native.{suffix}")),
            "fixture shared",
        )
        .unwrap();
        let configs = strategy.config_targets(&def).unwrap();
        for (key, path) in &configs {
            if key == "backup" {
                continue;
            }
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, if key == "trust" { "# 用户 TOML\r\nmodel = 'user'\r\n" } else if key == "kiro-cli" || key == "state" { "{}\n" } else { "\u{feff}{\r\n // 用户注释 🚀\r\n \"theme\": \"dark\",\r\n \"hooks\": {},\r\n}\r\n" }).unwrap();
        }
        (strategy, def)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hook_transactions_support_agent_home_directory_symlinks_and_preserve_user_files() {
        for id in ["cursor", "qoder", "codex", "kiro-cli"] {
            let root = tempfile::tempdir().unwrap();
            let (strategy, def) = seed_transaction_fixture(root.path(), id);
            let original_home = root.path().join("agent");
            let physical_home = root.path().join("SSD agent home");
            std::fs::rename(&original_home, &physical_home).unwrap();
            std::os::unix::fs::symlink(&physical_home, &original_home).unwrap();
            let settings = strategy.config_targets(&def).unwrap()["config"].clone();
            let original = std::fs::read(&settings).unwrap();
            let result = strategy.deploy(&def).await;
            assert!(result.success, "{id}: {:?}", result.error);
            assert_eq!(std::fs::read_link(&original_home).unwrap(), physical_home);
            assert!(!strategy.needs_deploy(&def, None).await, "{id}");
            let installed = std::fs::read(&settings).unwrap();
            assert!(String::from_utf8_lossy(&installed).contains("用户注释"));
            assert!(String::from_utf8_lossy(&installed).contains("dark"));
            assert!(strategy.deploy(&def).await.success);
            assert_eq!(std::fs::read(&settings).unwrap(), installed);
            assert!(strategy.undeploy_hooks(&def).await);
            assert_eq!(std::fs::read_link(&original_home).unwrap(), physical_home);
            let after = std::fs::read_to_string(&settings).unwrap();
            assert!(after.contains("用户注释") && after.contains("dark"));
            assert!(!original.is_empty());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hook_transactions_still_reject_linked_config_files_without_changing_their_targets() {
        let root = tempfile::tempdir().unwrap();
        let (strategy, def) = seed_transaction_fixture(root.path(), "cursor");
        let settings = strategy.config_targets(&def).unwrap()["config"].clone();
        let original = std::fs::read(&settings).unwrap();
        let target = root.path().join("unrelated-settings.json");
        std::fs::rename(&settings, &target).unwrap();
        std::os::unix::fs::symlink(&target, &settings).unwrap();
        let result = strategy.deploy(&def).await;
        assert!(!result.success);
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert_eq!(std::fs::read_link(&settings).unwrap(), target);
        assert!(!strategy.recovery_pending(&def));
    }

    #[tokio::test]
    async fn hook_transaction_rolls_back_resources_config_and_backup_on_companion_failure() {
        for id in ["codex", "kiro-cli"] {
            let root = tempfile::tempdir().unwrap();
            let (strategy, def) = seed_transaction_fixture(root.path(), id);
            let targets = strategy.config_targets(&def).unwrap();
            let before = std::fs::read(&targets["config"]).unwrap();
            let companion = &targets[if id == "codex" { "trust" } else { "kiro-cli" }];
            let companion_before = std::fs::read(companion).unwrap();
            let permissions = std::fs::metadata(companion).unwrap().permissions();
            let mut readonly = permissions.clone();
            readonly.set_readonly(true);
            std::fs::set_permissions(companion, readonly).unwrap();
            let result = strategy.deploy(&def).await;
            // 在 Windows 清除临时夹具只读位，保证 TempDir 能清理测试文件。
            std::fs::set_permissions(companion, permissions).unwrap();
            assert!(!result.success, "{id}");
            assert_eq!(std::fs::read(&targets["config"]).unwrap(), before);
            assert_eq!(std::fs::read(companion).unwrap(), companion_before);
            assert_eq!(std::fs::read_to_string(&targets["state"]).unwrap(), "{}\n");
            assert!(!targets["backup"].exists());
            assert!(!Path::new(&def.hook.as_ref().unwrap().hook_command).exists());
            assert!(!root.path().join("数据 🚀/hooks/pilot-bin").exists());
            assert!(!strategy.recovery_pending(&def));
            assert!(strategy.deploy(&def).await.success);
            assert!(!strategy.needs_deploy(&def, None).await, "{id}");
            assert_eq!(std::fs::read(&targets["backup"]).unwrap(), before);
            let installed = std::fs::read(&targets["config"]).unwrap();
            assert!(strategy.deploy(&def).await.success);
            assert_eq!(std::fs::read(&targets["config"]).unwrap(), installed);
        }
    }

    #[tokio::test]
    async fn hook_transaction_planning_failure_never_publishes_resources() {
        let root = tempfile::tempdir().unwrap();
        let (strategy, mut def) = seed_transaction_fixture(root.path(), "codex");
        let configs = strategy.config_targets(&def).unwrap();
        let original = std::fs::read(&configs["config"]).unwrap();
        // JSON 合法但 trust 不能表示此事件：错误发生在批量规划中，不是只读语法预检。
        def.hook
            .as_mut()
            .unwrap()
            .events
            .push("UnknownEvent".into());
        let result = strategy.deploy(&def).await;
        assert!(!result.success);
        assert_eq!(std::fs::read(&configs["config"]).unwrap(), original);
        assert!(!root.path().join("数据 🚀/hooks/pilot-bin").exists());
        assert!(!configs["backup"].exists());
        assert!(!strategy.recovery_pending(&def));
    }

    #[test]
    fn hook_transaction_crash_fixture() {
        let Some(root) = std::env::var_os("PILOT_HOOK_TRANSACTION_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (strategy, def) = transaction_fixture(root, "codex");
        let data = strategy.transaction_root(&def).unwrap();
        let assets = HookAssets::load(&def, Some(&root.join("candidate")), &data).unwrap();
        let configs = HookAssets::prepare_configs(&strategy.config_targets(&def).unwrap()).unwrap();
        let mut transaction = assets.begin(&configs).unwrap();
        let edits = strategy
            .plan_config_edits(&def, &transaction, false)
            .unwrap();
        assets.prepare(&mut transaction).unwrap();
        transaction
            .write(
                "backup",
                &transaction.original_bytes("config").unwrap().unwrap(),
                0o600,
            )
            .unwrap();
        for (key, content) in edits {
            transaction
                .write_preserving_mode(&key, content.as_bytes(), 0o600)
                .unwrap();
        }
        // 真正退出跳过 Drop：模拟所有文件已写入、commit 之前的进程崩溃。
        std::process::exit(17);
    }

    #[tokio::test]
    async fn hook_transaction_official_retry_recovers_after_process_exit() {
        let root = tempfile::tempdir().unwrap();
        assert_hook_crash_recovery(root.path()).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hook_transaction_crash_recovery_uses_the_same_targets_through_a_parent_directory_alias(
    ) {
        let owner = tempfile::tempdir().unwrap();
        let physical = owner.path().join("physical");
        let alias = owner.path().join("alias");
        std::fs::create_dir(&physical).unwrap();
        std::os::unix::fs::symlink(&physical, &alias).unwrap();
        assert_hook_crash_recovery(&alias).await;
    }

    async fn assert_hook_crash_recovery(root: &Path) {
        let (strategy, def) = seed_transaction_fixture(root, "codex");
        let configs = strategy.config_targets(&def).unwrap();
        let original = std::fs::read(&configs["config"]).unwrap();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "deployment::hook_strategy::tests::hook_transaction_crash_fixture",
                "--nocapture",
            ])
            .env_clear()
            .env("PILOT_HOOK_TRANSACTION_FIXTURE", root)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .current_dir(root);
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = crate::utils::candidate_process::output(
            &mut command,
            std::time::Duration::from_secs(30),
            1024 * 1024,
        )
        .await
        .unwrap();
        assert_eq!(
            output.status.code(),
            Some(17),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(strategy.recovery_pending(&def));
        assert!(strategy.needs_deploy(&def, None).await);
        let partial = std::fs::read(&configs["config"]).unwrap();
        assert_ne!(partial, original);
        assert!(!strategy.undeploy(&def).await);
        assert_eq!(std::fs::read(&configs["config"]).unwrap(), partial);
        // 不允许其他配置目标借用旧 journal，且恢复材料不能丢失。
        let mut other = def.clone();
        other.hook.as_mut().unwrap().settings_path =
            root.join("other/hooks.json").to_string_lossy().into_owned();
        assert!(!strategy.deploy(&other).await.success);
        assert!(strategy.recovery_pending(&def));
        let manager = crate::deployment::DeploymentManager::new(
            crate::deployment::DeploymentManagerOptions {
                data_dir: root.join("数据 🚀").to_string_lossy().into_owned(),
                pilot_dir: root.join("candidate").to_string_lossy().into_owned(),
                builtin_agents_dir: None,
                installed_by: Some(crate::types::InstalledBy::HookInstall),
            },
        );
        let result = manager.deploy_prepared(&def, true).await;
        assert!(result.success, "{:?}", result.error);
        assert!(manager.has_record("codex"));
        let state: Value =
            serde_json::from_slice(&std::fs::read(&configs["state"]).unwrap()).unwrap();
        assert_eq!(
            state["codex"]["hookSettingsPath"],
            configs["config"].to_str().unwrap()
        );
        assert!(!strategy.recovery_pending(&def));
        assert!(!strategy.needs_deploy(&def, None).await);
        assert_eq!(std::fs::read(&configs["backup"]).unwrap(), original);
        assert!(std::fs::read_to_string(&configs["config"])
            .unwrap()
            .contains("// 用户注释 🚀\r\n"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hook_transactions_serialize_shared_config_across_installations() {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join("shared/settings.jsonc");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, "{\n // 用户\n \"theme\": \"dark\"\n}\n").unwrap();
        let (first, mut a) = seed_transaction_fixture(&root.path().join("first"), "qoder");
        let (second, mut b) = seed_transaction_fixture(&root.path().join("second"), "qoder");
        a.hook.as_mut().unwrap().settings_path = settings.to_string_lossy().into_owned();
        b.hook.as_mut().unwrap().settings_path = settings.to_string_lossy().into_owned();
        let first = std::sync::Arc::new(first);
        let second = std::sync::Arc::new(second);
        let install_a = {
            let first = first.clone();
            let a = a.clone();
            tokio::spawn(async move { first.deploy(&a).await })
        };
        let install_b = {
            let second = second.clone();
            let b = b.clone();
            tokio::spawn(async move { second.deploy(&b).await })
        };
        assert!(install_a.await.unwrap().success);
        assert!(install_b.await.unwrap().success);
        assert!(!first.needs_deploy(&a, None).await);
        assert!(!second.needs_deploy(&b, None).await);
        assert!(first.undeploy(&a).await);
        assert!(!second.needs_deploy(&b, None).await);
        let remaining = std::fs::read_to_string(&settings).unwrap();
        assert!(remaining.contains("// 用户"));
        assert_eq!(
            parse_json_document(&remaining, JsonSyntax::Jsonc).unwrap()["theme"],
            "dark"
        );
        assert!(second.undeploy(&b).await);
        let before = std::fs::read(&settings).unwrap();
        assert!(second.undeploy(&b).await);
        assert_eq!(std::fs::read(&settings).unwrap(), before);
    }

    #[test]
    fn subcommand_is_kebab_case() {
        assert_eq!(event_to_subcommand("SessionStart"), "session-start");
        assert_eq!(event_to_subcommand("PreToolUse"), "pre-tool-use");
    }
}

#[cfg(test)]
#[path = "hook_strategy_contract_tests.rs"]
mod migration_contract_tests;

#[cfg(test)]
#[path = "codex_trust_reconciliation_history_contract_tests.rs"]
mod trust_reconciliation_history_contract_tests;
