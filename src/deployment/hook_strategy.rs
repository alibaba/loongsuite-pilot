//! Hook deploy strategy: settings JSON/JSONC, Codex trust, and Kiro agents.

use super::hook_assets::HookAssets;
use crate::hooks::{legacy_claude_hook_paths, quote_claude_hook_path, HookDefinition, HookManager};
use crate::sdk::agent_hooks::{
    codex_command, codex_command_executable, quote_codex_path, sdk_hook_command,
};
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

pub(super) fn event_to_subcommand(event: &str) -> String {
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

fn owned_legacy_codex_scripts(
    hook_command: &str,
    agent_id: &str,
    data_dir: Option<&Path>,
) -> Option<[PathBuf; 2]> {
    if cfg!(windows) || agent_id != "codex" {
        return None;
    }
    let data = data_dir.filter(|data| {
        data.is_absolute()
            && Path::new(hook_command) == data.join("hooks/codex-loongsuite-pilot-hook.sh")
    })?;
    Some([
        data.join("hooks/codex-loongsuite-pilot-hook.sh"),
        data.join("hooks/codex-loongsuite-pilot-hook.mjs"),
    ])
}

fn legacy_codex_path_spellings(script: &str) -> Vec<String> {
    let mut out = legacy_claude_hook_paths(script);
    for spelling in [
        quote_claude_hook_path(script),
        format!("'{}'", script.replace('\'', "'\\''")),
    ] {
        if !out.contains(&spelling) {
            out.push(spelling);
        }
    }
    out
}

fn legacy_hook_commands(
    hook_command: &str,
    event: &str,
    style: Option<EventSubcommand>,
    agent_id: &str,
    data_dir: Option<&Path>,
) -> Vec<String> {
    let mut out = if !cfg!(windows) && (agent_id == "claude-code" || hook_command.ends_with(".sh"))
    {
        legacy_claude_hook_paths(hook_command)
            .into_iter()
            .map(|command| append_event_subcommand(&command, event, style))
            .collect()
    } else if cfg!(windows) {
        let current = format_hook_command(hook_command, event, style, agent_id);
        windows_compatible_hook_commands(hook_command, event, style)
            .into_iter()
            .filter(|command| command != &current)
            .collect()
    } else {
        Vec::new()
    };

    // Old Unix Codex uninstall accepted bash-prefixed .sh/.mjs commands.
    // Enumerate only known spellings rooted in this install's explicit resource
    // authority. Never infer ownership from a basename or parse arbitrary shell.
    if let Some(paths) = owned_legacy_codex_scripts(hook_command, agent_id, data_dir) {
        for path in paths {
            for spelling in legacy_codex_path_spellings(&path.to_string_lossy()) {
                for base in [spelling.clone(), format!("bash {spelling}")] {
                    // Legacy uninstall also found a fixed Stop command in
                    // other event groups. Accept that known old suffix only,
                    // never arbitrary additional arguments or shell syntax.
                    for legacy_event in [event, "Stop"] {
                        let command = append_event_subcommand(&base, legacy_event, style);
                        if !out.contains(&command) {
                            out.push(command);
                        }
                    }
                }
            }
        }
        let current = format_hook_command(hook_command, event, style, agent_id);
        out.retain(|command| command != &current);
    }
    out
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
        .filter(|_| definition.exec_args.is_none())
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

const QODER_VERIFIED_EXEC_VERSION: semver::Version = semver::Version::new(1, 1, 76);
const QODER_EXEC_TIMEOUT: f64 = 4.0;

fn qoder_supports_exec(executable: &Path) -> bool {
    let Some(name) = executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.strip_suffix(".exe").unwrap_or(name);
    ["qodercli-", "qoder-"]
        .into_iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .and_then(|version| semver::Version::parse(version).ok())
        .is_some_and(|version| version >= QODER_VERIFIED_EXEC_VERSION)
}

fn qoder_installed_cli(home: &Path) -> Option<bool> {
    use std::io::Read;
    let directory = home.join("bin/qodercli");
    let marker = directory.join("version.txt");
    if matches!(
        std::fs::symlink_metadata(&marker),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    ) {
        return None;
    }
    Some(
        (|| {
            let metadata = crate::utils::runtime_paths::runtime_metadata(&marker).ok()?;
            if !metadata.is_file() || metadata.len() > 64 {
                return None;
            }
            let mut version = String::new();
            std::fs::File::open(&marker)
                .ok()?
                .take(65)
                .read_to_string(&mut version)
                .ok()?;
            if version.len() > 64 {
                return None;
            }
            let version = semver::Version::parse(version.trim()).ok()?;
            let extension = if cfg!(windows) { ".exe" } else { "" };
            let path = directory.join(format!("qodercli-{version}{extension}"));
            let metadata = crate::utils::runtime_paths::runtime_metadata(&path).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return None;
                }
            }
            Some(metadata.is_file() && qoder_supports_exec(&path))
        })()
        .unwrap_or(false),
    )
}

fn qoder_exec_supported(settings_path: &str) -> bool {
    let settings = PathBuf::from(resolve_home(settings_path));
    if let Some(supported) = settings.parent().and_then(qoder_installed_cli) {
        return supported;
    }
    ["qodercli", "qoder"]
        .into_iter()
        .find_map(|command| which::which(command).ok())
        .and_then(|path| std::fs::canonicalize(path).ok())
        .is_some_and(|path| qoder_supports_exec(&path))
}

pub(super) fn pilot_binary_name() -> &'static str {
    if cfg!(windows) {
        "loongsuite-pilot.exe"
    } else {
        "loongsuite-pilot"
    }
}

pub(super) fn sdk_hook_binary_name() -> &'static str {
    if cfg!(windows) {
        "loongsuite-pilot-sdk-hook.exe"
    } else {
        "loongsuite-pilot-sdk-hook"
    }
}

// Anchor development Hooks to the running Cargo build. A resource override
// or an incomplete installed manifest cannot provide an arbitrary executable.
fn development_sdk_hook_binary(pilot: &Path) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?.canonicalize().ok()?;
    let root = pilot.canonicalize().ok()?;
    if !crate::utils::runtime_paths::is_development_root(&root)
        || !matches!(std::fs::symlink_metadata(root.join("runtime-manifest.json")),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound)
        || executable.file_name()? != pilot_binary_name()
    {
        return None;
    }
    let profile = executable
        .parent()?
        .strip_prefix(root.join("target"))
        .ok()?;
    if profile.components().count() > 2
        || !matches!(profile.file_name()?.to_str()?, "debug" | "release")
    {
        return None;
    }
    Some(executable.with_file_name(sdk_hook_binary_name()))
}

pub(super) fn installed_qoder_hook_binary(
    pilot: &Path,
    data: &Path,
    cache: &Path,
) -> Option<PathBuf> {
    use crate::utils::runtime_paths::resource_file;
    let hook = format!("bin/{}", sdk_hook_binary_name());
    let executable = match std::fs::symlink_metadata(pilot.join(&hook)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            resource_file(pilot, &format!("bin/{}", pilot_binary_name())).ok()?
        }
        _ => resource_file(pilot, &hook).ok()?,
    };
    let sdk = if cfg!(windows) {
        "bin/loongsuite_pilot.dll"
    } else if cfg!(target_os = "macos") {
        "bin/libloongsuite_pilot.dylib"
    } else {
        "bin/libloongsuite_pilot.so"
    };
    resource_file(pilot, sdk).ok()?;
    let current = super::native_install::read_pointer(&cache.join("current")).ok()??;
    if std::fs::canonicalize(cache.join("versions").join(current)).ok()?
        != std::fs::canonicalize(pilot).ok()?
        || !data.is_absolute()
        || data.to_str().is_none()
        || !matches!(
            std::fs::symlink_metadata(cache.join("update-recovery.json")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        )
    {
        return None;
    }
    let binary = super::runtime_launcher::RuntimeLauncher::read(cache, data)
        .ok()?
        .map_or(executable, |runtime| runtime.hook_path().to_owned());
    let metadata = crate::utils::runtime_paths::runtime_metadata(&binary).ok()?;
    let path = binary.to_str()?;
    (binary.is_absolute() && metadata.is_file() && !path.chars().any(char::is_control))
        .then_some(binary)
}

fn hook_cache_dir(data: &Path) -> PathBuf {
    std::env::var_os("LOONGSUITE_PILOT_CACHE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data.to_owned())
}

pub(super) fn codex_channel(event: &str) -> &'static str {
    if matches!(event, "UserPromptSubmit" | "PreToolUse" | "PostToolUse") {
        "local"
    } else {
        "observe"
    }
}

fn qoder_subagent_hook(hook: &HookDefinition) -> bool {
    hook.agent_id == "qoder"
        && hook
            .hook_json_path
            .last()
            .is_some_and(|event| matches!(event.as_str(), "SubagentStart" | "SubagentStop"))
}

fn qoder_legacy_exec_args(legacy: &HookDefinition, data: &Path) -> Vec<String> {
    let args: &[&str] = if legacy
        .hook_json_path
        .last()
        .is_some_and(|event| event == "Stop")
        || qoder_subagent_hook(legacy)
    {
        &[
            "hook-process",
            "qoder",
            "--wakeup-only",
            "--agent-id",
            "qoder",
            "--log-prefix",
            "qoder",
        ]
    } else {
        &["interceptor", "hook", "--agent", "qoder-auto"]
    };
    args.iter()
        .map(|arg| (*arg).to_owned())
        .chain(["--data-dir".into(), data.to_string_lossy().into_owned()])
        .collect()
}

fn qoder_cn_command(binary: &Path, data: &Path, event: &str) -> Option<String> {
    if !crate::interceptor::SUPPORTED_HOOK_EVENTS.contains(&event) {
        return None;
    }
    let binary = quote_codex_path(binary)?;
    let sdk_data = quote_codex_path(&data.join(crate::sdk::STANDALONE_QODER_CN_DATA))?;
    Some(format!(
        "{binary} sdk-hook --channel local --agent qoder-cn-auto --event {event} --data-dir {sdk_data}"
    ))
}

fn qoder_cn_interception_enabled() -> bool {
    let config: Option<Value> = std::fs::read_to_string(crate::utils::config_json_path())
        .ok()
        .and_then(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')).ok());
    crate::interceptor::should_deploy_interceptor_hooks(
        &crate::interceptor::build_interceptor_config(
            config.as_ref().and_then(|config| config.get("interceptor")),
        ),
    )
}

fn qoder_exec_args(legacy: &HookDefinition, data: &Path) -> Vec<String> {
    let event = legacy.hook_json_path.last().expect("Qoder Hook event");
    let channel = if event == "Stop" || qoder_subagent_hook(legacy) {
        "observe"
    } else {
        "local"
    };
    [
        "sdk-hook",
        "--channel",
        channel,
        "--agent",
        "qoder-auto",
        "--event",
        event,
        "--data-dir",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([data
        .join(crate::sdk::STANDALONE_QODER_DATA)
        .to_string_lossy()
        .into_owned()])
    .collect()
}

fn qoder_exec_definition(legacy: &HookDefinition, binary: &Path, data: &Path) -> HookDefinition {
    let mut definition = legacy.clone();
    let command = std::mem::replace(
        &mut definition.hook_command,
        binary.to_string_lossy().into_owned(),
    );
    definition
        .replace_hook_commands
        .get_or_insert_with(Vec::new)
        .push(command);
    definition.exec_args = Some(qoder_exec_args(legacy, data));
    definition.shell = None;
    definition.timeout = Some(legacy.timeout.map_or(QODER_EXEC_TIMEOUT, |timeout| {
        timeout.min(QODER_EXEC_TIMEOUT)
    }));
    definition
}

fn qoder_cn_owned_hooks(
    settings: &Value,
    legacy: &HookDefinition,
    data: &Path,
    binary_owned: impl Fn(&Path) -> bool,
) -> Vec<HookDefinition> {
    let Some(event) = legacy.hook_json_path.last() else {
        return Vec::new();
    };
    settings["hooks"][event]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|group| {
            std::iter::once(group).chain(group["hooks"].as_array().into_iter().flatten())
        })
        .filter_map(|handler| {
            let command = handler["command"].as_str()?;
            let binary = codex_command_executable(command)?;
            if handler["type"] != "command"
                || !binary_owned(&binary)
                || qoder_cn_command(&binary, data, event).as_deref() != Some(command)
            {
                return None;
            }
            let mut owned = legacy.clone();
            owned.hook_command = command.to_owned();
            owned.replace_hook_commands = None;
            Some(owned)
        })
        .collect()
}

fn qoder_owned_exec_hooks(
    settings: &Value,
    legacy: &HookDefinition,
    data: &Path,
    binary_owned: impl Fn(&Path) -> bool,
) -> Vec<HookDefinition> {
    let Some(entries) = legacy
        .hook_json_path
        .iter()
        .try_fold(settings, |value, key| value.get(key))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let args = serde_json::json!(qoder_exec_args(legacy, data));
    let legacy_args = serde_json::json!(qoder_legacy_exec_args(legacy, data));
    let mut definitions = Vec::new();
    for entry in entries {
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
            let path = Path::new(command);
            if handler.get("type").and_then(Value::as_str) == Some("command")
                && matches!(handler.get("args"), Some(actual) if actual == &args || actual == &legacy_args)
                && path.is_absolute()
                && binary_owned(path)
            {
                let mut definition = qoder_exec_definition(legacy, path, data);
                if handler.get("args") == Some(&legacy_args) {
                    definition.exec_args = Some(qoder_legacy_exec_args(legacy, data));
                }
                definition.replace_hook_commands = None;
                definitions.push(definition);
            }
        }
    }
    definitions
}

fn qoder_version_binary(path: &Path, cache: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(cache.join("versions")) else {
        return false;
    };
    let mut components = relative.components();
    let Some(version) = components
        .next()
        .and_then(|value| value.as_os_str().to_str())
    else {
        return false;
    };
    crate::utils::runtime_paths::safe_component(version)
        && components
            .next()
            .is_some_and(|value| value.as_os_str() == "bin")
        && components.next().is_some_and(|value| {
            let name = value.as_os_str();
            name == pilot_binary_name() || name == sdk_hook_binary_name()
        })
        && components.next().is_none()
}

fn qoder_definition_supports_exec(def: &AgentDefinition, data: &Path) -> bool {
    def.id == "qoder"
        && def.hook.as_ref().is_some_and(|hook| {
            hook.format.as_str() == "nested"
                && (hook.events == ["Stop"]
                    || hook.events == ["Stop", "SubagentStart", "SubagentStop"])
                && Path::new(&hook.hook_command)
                    == data.join("hooks/qoder-loongsuite-pilot-hook.sh")
                && hook.interceptor.as_ref().is_some_and(|interceptor| {
                    Path::new(&interceptor.hook_command) == data.join("hooks/interceptor-hook.sh")
                        && interceptor.events == ["UserPromptSubmit", "PreToolUse", "PostToolUse"]
                })
                && qoder_exec_supported(&hook.settings_path)
        })
}

pub(super) fn plan_qoder_exec_install(
    raw: &str,
    def: &AgentDefinition,
    data: &Path,
    binary: &Path,
) -> Result<Option<String>, String> {
    if !qoder_definition_supports_exec(def, data) {
        return Ok(None);
    }
    let hook = def
        .hook
        .as_ref()
        .ok_or("Missing Qoder hook configuration")?;
    let mut document = SettingsDocument::from_snapshot(Some(raw), settings_syntax(hook))?;
    let strategy = HookStrategy::new(HookManager::new(None, None));
    for legacy in strategy.legacy_hook_definitions(def) {
        let previous = qoder_owned_exec_hooks(&document.data, &legacy, data, |path| {
            path == binary || qoder_version_binary(path, &hook_cache_dir(data))
        });
        if qoder_subagent_hook(&legacy)
            || HookManager::is_hook_installed_in_settings(&document.data, &legacy)
            || !previous.is_empty()
        {
            let desired = qoder_exec_definition(&legacy, binary, data);
            let multiple = previous.len() > 1;
            for hook in previous {
                if multiple
                    || hook.hook_command != desired.hook_command
                    || hook.exec_args != desired.exec_args
                {
                    document.apply_hook(&hook, true, false)?;
                }
            }
            document.apply_hook(&desired, false, false)?;
        }
    }
    Ok(document.changed().then_some(document.raw))
}

/// A caller already holding the activation and settings locks can stage this
/// edit with the version pointer. A previous Pilot cannot remove our argv
/// registrations itself. Only replace exact commands issued by this version.
pub(crate) fn plan_qoder_legacy_restore(
    raw: &str,
    def: &AgentDefinition,
    data: &Path,
    binary: &Path,
    restore_subagents: bool,
) -> Result<Option<String>, String> {
    let Some(hook) = &def.hook else {
        return Ok(None);
    };
    let mut document = SettingsDocument::from_snapshot(Some(raw), settings_syntax(hook))?;
    let strategy = HookStrategy::new(HookManager::new(None, None));
    if def.id == "qoder-cn" {
        let previous = strategy.build_interceptor_definitions(def);
        for entry in strategy.build_hook_definitions(def) {
            let direct = qoder_cn_owned_hooks(&document.data, &entry, data, |path| path == binary);
            if direct.is_empty() {
                continue;
            }
            for owned in direct {
                document.apply_hook(&owned, true, false)?;
            }
            if let Some(old) = previous
                .iter()
                .find(|old| old.hook_json_path == entry.hook_json_path)
            {
                document.apply_hook(old, false, false)?;
            }
        }
        return Ok(document.changed().then_some(document.raw));
    }
    if def.id != "qoder" {
        return Ok(None);
    }
    for legacy in strategy.legacy_hook_definitions(def) {
        let direct = qoder_owned_exec_hooks(&document.data, &legacy, data, |path| path == binary);
        if direct.is_empty() {
            continue;
        }
        for definition in direct {
            document.apply_hook(&definition, true, false)?;
        }
        if restore_subagents || !qoder_subagent_hook(&legacy) {
            document.apply_hook(&legacy, false, false)?;
        }
    }
    Ok(document.changed().then_some(document.raw))
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

    fn apply_hook(
        &mut self,
        definition: &HookDefinition,
        remove: bool,
        prune_empty_owned_hooks: bool,
    ) -> Result<(), String> {
        let previous = prune_empty_owned_hooks.then(|| self.raw.clone());
        let compatible;
        let definition = if cfg!(windows) {
            compatible = windows_hook_spelling_aliases(definition, &self.data);
            &compatible
        } else {
            definition
        };
        self.raw = HookManager::edit_hook(&self.raw, definition, remove)?;
        self.data = parse_json_document(&self.raw, self.syntax).map_err(|err| err.message)?;
        if remove
            && previous.as_ref().is_some_and(|raw| raw != &self.raw)
            && definition.hook_json_path.len() == 2
            && definition.hook_json_path[0] == "hooks"
        {
            let event = &definition.hook_json_path[1];
            if self
                .data
                .get("hooks")
                .and_then(|hooks| hooks.get(event))
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                self.set(&["hooks", event], None)?;
            }
            if self
                .data
                .get("hooks")
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty)
            {
                self.set(&["hooks"], None)?;
            }
        }
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

struct ScopeChange {
    previous: Option<DeployedAgentRecord>,
    retire: Vec<AgentDefinition>,
}

#[derive(Clone)]
struct EmbeddedCodexHooks {
    binary: PathBuf,
    data_dir: PathBuf,
    channel: &'static str,
}

pub(crate) struct EmbeddedCodexHookPlan {
    state: &'static str,
    config: Option<(HookStrategy, AgentDefinition, bool)>,
}
impl EmbeddedCodexHookPlan {
    pub(crate) fn report(&self) -> Value {
        serde_json::json!({"state": self.state})
    }

    pub(crate) fn targets(&self) -> anyhow::Result<BTreeMap<String, PathBuf>> {
        match &self.config {
            Some((strategy, definition, _)) => strategy
                .config_targets(definition)
                .map_err(anyhow::Error::msg),
            None => Ok(BTreeMap::new()),
        }
    }

    pub(crate) fn write(&self, tx: &mut ActivationTransaction) -> anyhow::Result<()> {
        if let Some((strategy, definition, uninstall)) = &self.config {
            let edits = strategy
                .plan_config_edits(definition, tx, *uninstall, None, true)
                .map_err(anyhow::Error::msg)?;
            for (key, value) in edits {
                tx.write_preserving_mode(&key, value.as_bytes(), 0o600)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn prepare_embedded_codex_hooks(
    home: &Path,
    data_dir: &Path,
    resource_dir: &Path,
    channel: Option<&'static str>,
) -> anyhow::Result<EmbeddedCodexHookPlan> {
    use crate::utils::source_access::private_path;

    let settings = home.join("hooks.json");
    let config = home.join("config.toml");
    private_path(&settings)?;
    private_path(&config)?;
    let scratch = data_dir.join("codex-hook-deployment");
    private_path(&scratch)?;
    if !home.is_dir() {
        return Ok(EmbeddedCodexHookPlan {
            state: if channel.is_some() {
                "waiting"
            } else {
                "disabled"
            },
            config: None,
        });
    }
    let binary = resource_dir.join("bin").join(sdk_hook_binary_name());
    if let Some(channel) = channel {
        let meta = crate::utils::runtime_paths::runtime_metadata(&binary)?;
        anyhow::ensure!(meta.is_file(), "Codex Hook must be an ordinary file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                meta.permissions().mode() & 0o111 != 0,
                "Codex Hook is not executable"
            );
        }
        anyhow::ensure!(
            codex_command(&binary, data_dir, "PreToolUse", channel).is_some(),
            "invalid Codex Hook command"
        );
    }
    let (strategy, def) = embedded_codex_definition(
        &settings,
        &config,
        data_dir,
        &binary,
        channel.unwrap_or("cloud"),
    )?;
    let targets = strategy.config_targets(&def).map_err(anyhow::Error::msg)?;
    // Recover updates interrupted by earlier SDK releases before the shared
    // policy journal takes responsibility for these paths.
    ActivationTransaction::recover(&scratch, targets)?;
    Ok(EmbeddedCodexHookPlan {
        state: if channel.is_some() {
            "deployed"
        } else {
            "disabled"
        },
        config: Some((strategy, def, channel.is_none())),
    })
}

#[cfg(test)]
pub(crate) fn reconcile_embedded_codex_hooks(
    home: &Path,
    data_dir: &Path,
    resource_dir: &Path,
    channel: Option<&'static str>,
    before_commit: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<Value> {
    let plan = prepare_embedded_codex_hooks(home, data_dir, resource_dir, channel)?;
    let targets = plan.targets()?;
    if targets.is_empty() {
        before_commit()?;
    } else {
        let scratch = data_dir.join("codex-hook-deployment");
        std::fs::create_dir_all(&scratch)?;
        let mut tx = ActivationTransaction::begin(&scratch, targets)?;
        let result = (|| {
            plan.write(&mut tx)?;
            before_commit()?;
            tx.commit()
        })();
        if let Err(error) = result {
            return match tx.rollback() {
                Ok(()) => Err(error),
                Err(rollback) => Err(error.context(format!(
                    "Codex Hook configuration recovery failed: {rollback:#}"
                ))),
            };
        }
    }
    Ok(plan.report())
}

fn embedded_codex_definition(
    settings: &Path,
    config: &Path,
    data_dir: &Path,
    binary: &Path,
    channel: &'static str,
) -> anyhow::Result<(HookStrategy, AgentDefinition)> {
    let mut def: AgentDefinition = serde_json::from_str(include_str!("../../agents.d/codex.json"))?;
    let hook = def.hook.as_mut().expect("Codex Hook definition");
    hook.settings_path = settings
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Codex settings path must be UTF-8"))?
        .into();
    hook.hook_command = binary.to_string_lossy().into_owned();
    hook.event_subcommand = None;
    use sha2::{Digest, Sha256};
    let trust = hook.trust_toml.as_mut().expect("Codex trust definition");
    let owner = hex::encode(Sha256::digest(data_dir.as_os_str().as_encoded_bytes()));
    trust.marker = format!("pilot-sdk-codex-{}", &owner[..16]);
    trust.config_path = config
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Codex config path must be UTF-8"))?
        .into();
    let mut strategy =
        HookStrategy::new(HookManager::new(Some(String::new()), Some(String::new())));
    strategy.embedded_codex = Some(EmbeddedCodexHooks {
        binary: binary.to_owned(),
        data_dir: data_dir.to_owned(),
        channel,
    });
    Ok((strategy, def))
}

// Handler indices can be reused by a different owner after manual edits.
fn embedded_codex_trust_keys(
    settings: &Value,
    path: &str,
    trust: &str,
    marker: &str,
    locations: &[InstalledCodexHookLocation],
) -> anyhow::Result<std::collections::BTreeSet<String>> {
    let parsed: toml::Table = toml::from_str(trust)?;
    let states = parsed.get("hooks").and_then(|h| h.get("state"));
    let hashes = locations
        .iter()
        .map(|location| {
            super::codex_trust_writer::compute_installed_hook_trust_hash(
                location,
                super::codex_trust_writer::TrustPlatform::current(),
            )
            .map_err(anyhow::Error::msg)
        })
        .collect::<anyhow::Result<HashSet<_>>>()?;
    let executable = |handler: &Value| {
        ["command", "commandWindows", "command_windows"]
            .iter()
            .any(|key| handler[key].as_str().is_some_and(|s| !s.trim().is_empty()))
            || handler["type"].as_str().is_some_and(|t| t != "command")
    };
    let mut occupied = HashSet::new();
    if let Some(events) = settings["hooks"].as_object() {
        for (event, groups) in events {
            let Some(event_key) = event_key(event) else {
                continue;
            };
            for (group_index, group) in groups.as_array().into_iter().flatten().enumerate() {
                if let Some(handlers) = group["hooks"].as_array() {
                    for (handler_index, _) in
                        handlers.iter().enumerate().filter(|(_, h)| executable(h))
                    {
                        occupied
                            .insert(format!("{path}:{event_key}:{group_index}:{handler_index}"));
                    }
                } else if executable(group) {
                    occupied.insert(format!("{path}:{event_key}:{group_index}:0"));
                }
            }
        }
    }
    Ok(super::codex_trust_writer::marked_trust_keys(trust, marker)?
        .into_iter()
        .filter(|key| {
            key.rsplitn(4, ':').nth(3) == Some(path)
                && (!occupied.contains(key)
                    || states
                        .and_then(|s| s.get(key))
                        .and_then(|t| t.get("trusted_hash"))
                        .and_then(toml::Value::as_str)
                        .is_some_and(|h| hashes.contains(h)))
        })
        .collect())
}

pub(crate) fn inspect_embedded_codex_hooks(
    home: Option<&Path>,
    data: &Path,
    resources: &Path,
) -> anyhow::Result<Value> {
    let Some(home) = home else {
        return Ok(
            serde_json::json!({"agent":"codex","settings_path":null,"trust_path":null,"hooks":[],"trust_records":[]}),
        );
    };
    let settings = home.join("hooks.json");
    let config = home.join("config.toml");
    let binary = resources.join("bin").join(sdk_hook_binary_name());
    let (strategy, def) = embedded_codex_definition(&settings, &config, data, &binary, "cloud")?;
    let hook = def.hook.as_ref().expect("embedded hook");
    let trust = hook.trust_toml.as_ref().expect("embedded trust");
    for path in [&settings, &config] {
        crate::utils::source_access::private_path(path)?;
    }
    let raw = super::codex_trust_writer::read_config_snapshot(&hook.settings_path)?;
    let doc = SettingsDocument::from_snapshot(raw.as_deref(), JsonSyntax::Json)
        .map_err(anyhow::Error::msg)?;
    let locations = strategy
        .resolve_codex_hook_locations_from_data(&def, &hook.events, true, &doc.data, false, false)
        .map_err(anyhow::Error::msg)?;
    let path = node_resolve(&hook.settings_path);
    let raw =
        super::codex_trust_writer::read_config_snapshot(&trust.config_path)?.unwrap_or_default();
    let keys = embedded_codex_trust_keys(&doc.data, &path, &raw, &trust.marker, &locations)?;
    let parsed: toml::Table = toml::from_str(&raw)?;
    let states = parsed.get("hooks").and_then(|hooks| hooks.get("state"));
    let mut hooks = Vec::new();
    for location in locations {
        let key = installed_hook_state_key(&path, &location);
        let hash = super::codex_trust_writer::compute_installed_hook_trust_hash(
            &location,
            super::codex_trust_writer::TrustPlatform::current(),
        )
        .map_err(anyhow::Error::msg)?;
        let key = keys.get(&key).filter(|key| {
            states
                .and_then(|s| s.get(*key))
                .and_then(|e| e.get("trusted_hash"))
                .and_then(toml::Value::as_str)
                == Some(&hash)
        });
        hooks.push(serde_json::json!({
            "event":location.event_name, "matcher":location.matcher, "command":location.handler.command,
            "group_index":location.group_index, "handler_index":location.handler_index, "trust_key":key,
        }));
    }
    let mut records = Vec::new();
    for key in keys {
        if let Some(entry) = states.and_then(|state| state.get(&key)) {
            records.push(serde_json::json!({
                "key":key, "trusted_hash":entry.get("trusted_hash").and_then(toml::Value::as_str),
                "enabled":entry.get("enabled").and_then(toml::Value::as_bool)
            }));
        }
    }
    Ok(
        serde_json::json!({"agent":"codex","settings_path":settings,"trust_path":config,"hooks":hooks,"trust_records":records}),
    )
}

pub struct HookStrategy {
    hook_manager: HookManager,
    embedded_codex: Option<EmbeddedCodexHooks>,
    codex_legacy_cache: Option<PathBuf>,
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
            embedded_codex: None,
            codex_legacy_cache: None,
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

    /// Bind hook deployment to the package and data directories for this installation.
    pub fn with_resource_roots(mut self, pilot: &Path, data: &Path) -> Self {
        self.resource_roots = Some((pilot.into(), data.into()));
        self
    }

    pub(super) async fn restore_codex_legacy(
        mut self,
        def: &AgentDefinition,
        cache: &Path,
        data: &Path,
    ) -> anyhow::Result<()> {
        self.codex_legacy_cache = Some(cache.to_owned());
        let configs = self.config_targets(def).map_err(anyhow::Error::msg)?;
        super::hook_assets::HookAssets::configuration_cleanup(data)
            .apply(configs, None, true, |transaction| {
                self.plan_config_edits(def, transaction, false, None, true)
                    .map_err(anyhow::Error::msg)
            })
            .await
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
        if super::system_toml_hooks::is_system(def) {
            let native = self.system_codex_sdk_paths(def);
            return !super::system_toml_hooks::read(def)
                .and_then(|raw| {
                    super::system_toml_hooks::installed_with_native(
                        &raw,
                        def,
                        native
                            .as_ref()
                            .map(|(binary, data)| (binary.as_path(), data.as_path())),
                    )
                })
                .unwrap_or(false);
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
        let direct_binary = self.sdk_hook_binary(def);
        if requires_native_sdk(def) && direct_binary.is_none() {
            return true;
        }
        let sdk_settings = if let Some(hook) = def.hook.as_ref().filter(|_| {
            matches!(def.id.as_str(), "qoder" | "codex" | "qoder-cn") || requires_native_sdk(def)
        }) {
            let Ok(document) =
                SettingsDocument::read(&resolve_home(&hook.settings_path), settings_syntax(hook))
                    .await
            else {
                return true;
            };
            Some(document.data)
        } else {
            None
        };
        let interception = self.native_interceptor_enabled(def).await;
        for legacy in self.legacy_hook_definitions(def) {
            if requires_native_sdk(def) && !self.native_hook_selected(def, &legacy, interception) {
                if self.hook_manager.is_hook_installed(&legacy).await
                    || sdk_settings.as_ref().is_some_and(|settings| {
                        !self.installed_sdk_hooks(def, settings, &legacy).is_empty()
                    })
                {
                    return true;
                }
                continue;
            }
            if qoder_subagent_hook(&legacy) && direct_binary.is_none() {
                continue;
            }
            let interceptor = self.is_interceptor_definition(def, &legacy);
            if interceptor && def.id == "qoder-cn" && direct_binary.is_none() {
                if sdk_settings.as_ref().is_some_and(|settings| {
                    !self.installed_sdk_hooks(def, settings, &legacy).is_empty()
                        || HookManager::is_hook_installed_in_settings(settings, &legacy)
                }) {
                    return true;
                }
                continue;
            }
            if def.id != "qoder"
                && def.id != "qoder-cn"
                && !requires_native_sdk(def)
                && legacy.exec_args.is_none()
                && interceptor
            {
                if self.hook_manager.is_hook_installed(&legacy).await {
                    return true;
                }
                continue;
            }
            let binary = direct_binary
                .as_deref()
                .filter(|_| def.id != "qoder-cn" || interceptor);
            let Some(desired) = self.desired_hook(def, legacy.clone(), binary) else {
                return true;
            };
            if let Some(settings) = &sdk_settings {
                let installed = self.installed_sdk_hooks(def, settings, &legacy);
                if installed.len() > usize::from(direct_binary.is_some())
                    || installed.iter().any(|definition| {
                        definition.hook_command != desired.hook_command
                            || definition.exec_args != desired.exec_args
                    })
                    || !HookManager::is_hook_installed_in_settings(settings, &desired)
                {
                    return true;
                }
            } else if !self.hook_manager.is_hook_installed(&desired).await {
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
        super::qoder_token_usage::reconcile(def, false).await
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
        if super::system_toml_hooks::is_system(def) {
            let raw = super::system_toml_hooks::read(def)?;
            super::system_toml_hooks::installed(&raw, def)?;
            return Ok(());
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
        match self.configure(def, false, None).await {
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

    pub(super) async fn configure_scope(
        &self,
        def: &AgentDefinition,
        previous: Option<DeployedAgentRecord>,
        retire: Vec<AgentDefinition>,
        uninstall: bool,
    ) -> Result<(), String> {
        self.configure(def, uninstall, Some(ScopeChange { previous, retire }))
            .await
    }

    async fn configure(
        &self,
        def: &AgentDefinition,
        uninstall: bool,
        scope: Option<ScopeChange>,
    ) -> Result<(), String> {
        // 待恢复时必须先恢复再读取；否则部分写入的配置会被误用为新基线。
        if !self.recovery_pending(def) {
            self.preflight(def).await?;
        } else if uninstall {
            return Err("Hook 事务待恢复，停止清理并保留配置与资源".into());
        }
        let mut configs = self.config_targets(def)?;
        if let Some(scope) = &scope {
            for (index, old) in scope.retire.iter().enumerate() {
                let path = &old
                    .hook
                    .as_ref()
                    .ok_or("Missing retired Hook settings")?
                    .settings_path;
                configs.insert(format!("retire-{index}"), PathBuf::from(path));
            }
        }
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
        let interception = !uninstall && self.native_interceptor_enabled(def).await;
        assets
            .apply(
                configs,
                (def.id == "claude-code").then_some(settings.as_str()),
                uninstall,
                |transaction| {
                    self.plan_config_edits(
                        def,
                        transaction,
                        uninstall,
                        scope.as_ref(),
                        interception,
                    )
                    .map_err(anyhow::Error::msg)
                },
            )
            .await
            .map_err(|err| format!("Hook 事务失败：{err:#}"))?;
        if !uninstall {
            super::qoder_token_usage::reconcile(def, true).await;
        }
        Ok(())
    }

    fn plan_config_edits(
        &self,
        def: &AgentDefinition,
        transaction: &ActivationTransaction,
        uninstall: bool,
        scope: Option<&ScopeChange>,
        interception: bool,
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
        if !uninstall && self.codex_legacy_cache.is_none() && super::hook_assets::is_sdk_codex(def)
        {
            let (binary, data) = self
                .system_codex_sdk_paths(def)
                .ok_or("Codex requires the installed loongsuite-pilot-sdk-hook binary")?;
            if hook
                .events
                .iter()
                .any(|event| codex_command(&binary, &data, event, codex_channel(event)).is_none())
            {
                return Err("Invalid Codex SDK hook command".into());
            }
        }
        let original = snapshot("config")?;
        let mut edits = BTreeMap::new();
        let mut retired_paths = Vec::new();
        if let Some(scope) = scope {
            let state = snapshot("state")?
                .map(|raw| {
                    serde_json::from_str::<crate::types::DeployedAgentsState>(
                        raw.trim_start_matches('\u{feff}'),
                    )
                    .map_err(|_| {
                        "Invalid Hook deployment state; original files preserved".to_string()
                    })
                })
                .transpose()?
                .unwrap_or_default();
            if state.get(&def.id) != scope.previous.as_ref() {
                return Err("Hook deployment state changed; retry the scope operation".into());
            }
            for (index, old) in scope.retire.iter().enumerate() {
                let key = format!("retire-{index}");
                let path = &old
                    .hook
                    .as_ref()
                    .ok_or("Missing retired Hook settings")?
                    .settings_path;
                retired_paths.push(node_resolve(path));
                if let Some(raw) = snapshot(&key)? {
                    let next = if super::system_toml_hooks::is_system(old) {
                        super::system_toml_hooks::plan(&raw, old, true)?
                    } else {
                        let old_hook = old.hook.as_ref().unwrap();
                        let mut document =
                            SettingsDocument::from_snapshot(Some(&raw), settings_syntax(old_hook))?;
                        for hook in self
                            .legacy_hook_definitions(old)
                            .iter()
                            .chain(&self.build_retired_hook_definitions(old))
                        {
                            document.apply_hook(hook, true, false)?;
                        }
                        document.changed().then_some(document.raw)
                    };
                    if let Some(next) = next {
                        edits.insert(key, next);
                    }
                }
            }
        }
        if super::system_toml_hooks::is_system(def) {
            if self.codex_legacy_cache.is_some()
                && !original
                    .as_deref()
                    .is_some_and(super::system_toml_hooks::has_codex_owner)
            {
                return Ok(edits);
            }
            let native = self.system_codex_sdk_paths(def);
            if let Some(next) = super::system_toml_hooks::plan_with_native(
                original.as_deref().unwrap_or(""),
                def,
                uninstall,
                native
                    .as_ref()
                    .map(|(binary, data)| (binary.as_path(), data.as_path())),
            )? {
                edits.insert("config".into(), next);
            }
            self.plan_state_edit(
                def,
                snapshot("state")?.as_deref(),
                uninstall,
                &retired_paths,
                &mut edits,
            )?;
            return Ok(edits);
        }
        let mut document =
            SettingsDocument::from_snapshot(original.as_deref(), settings_syntax(hook))?;
        let initial_raw = document.raw.clone();
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
            // Cleanup removes every exact-owned direct/nested handler. Normal
            // deployment and trust repair still require one handler per event.
            self.resolve_codex_hook_locations_from_data(
                def,
                &events,
                true,
                &document.data,
                true,
                !uninstall && self.codex_legacy_cache.is_none(),
            )?
        } else {
            Vec::new()
        };
        let embedded_removal_keys = if uninstall && self.embedded_codex.is_some() {
            let trust = hook.trust_toml.as_ref().expect("embedded trust");
            Some(
                embedded_codex_trust_keys(
                    &document.data,
                    &hooks_json,
                    &snapshot("trust")?.unwrap_or_default(),
                    &trust.marker,
                    &old_locations,
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        if self.codex_legacy_cache.is_some()
            && !old_locations.iter().any(|location| {
                self.owns_codex_sdk_command(def, &location.event_name, &location.handler.command)
            })
        {
            return Ok(edits);
        }
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
            let direct_binary = (!uninstall).then(|| self.sdk_hook_binary(def)).flatten();
            if !uninstall && requires_native_sdk(def) && direct_binary.is_none() {
                return Err("The installed SDK Hook binary is required".into());
            }
            let indexed_codex = def.id == "codex"
                && self.resource_roots.is_some()
                && (direct_binary.is_some() || self.codex_legacy_cache.is_some());
            if self.embedded_codex.is_none() {
                for retired in &retired {
                    if indexed_codex {
                        self.edit_indexed_codex_event(def, &mut document, retired, retired, true)?;
                    } else {
                        document.apply_hook(
                            retired,
                            true,
                            uninstall && self.preserve_runtime_assets,
                        )?;
                    }
                }
            }
            if !uninstall {
                if let Some(env) = &hook.env {
                    self.apply_env_to_settings(&mut document, env)?;
                }
            }
            let prune_empty = uninstall && self.preserve_runtime_assets;
            for legacy in self.legacy_hook_definitions(def) {
                let interceptor = self.is_interceptor_definition(def, &legacy);
                if requires_native_sdk(def)
                    && !self.native_hook_selected(def, &legacy, interception)
                {
                    for installed in self.installed_sdk_hooks(def, &document.data, &legacy) {
                        document.apply_hook(&installed, true, prune_empty)?;
                    }
                    document.apply_hook(&legacy, true, prune_empty)?;
                    continue;
                }
                if def.id != "qoder"
                    && def.id != "qoder-cn"
                    && !requires_native_sdk(def)
                    && interceptor
                {
                    document.apply_hook(&legacy, true, prune_empty)?;
                    continue;
                }
                let binary = direct_binary
                    .as_deref()
                    .filter(|_| def.id != "qoder-cn" || interceptor);
                let desired = self
                    .desired_hook(def, legacy.clone(), binary)
                    .ok_or("Invalid SDK Hook command or data directory")?;
                if indexed_codex || self.embedded_codex.is_some() {
                    self.edit_indexed_codex_event(
                        def,
                        &mut document,
                        &legacy,
                        &desired,
                        uninstall,
                    )?;
                    continue;
                }
                let installed = self.installed_sdk_hooks(def, &document.data, &legacy);
                let multiple = installed.len() > 1;
                for definition in installed {
                    if uninstall
                        || multiple
                        || definition.hook_command != desired.hook_command
                        || definition.exec_args != desired.exec_args
                    {
                        document.apply_hook(&definition, true, prune_empty)?;
                    }
                }
                // Whole-product uninstall owns the removed handlers' empty
                // containers; ordinary per-agent Hook edits retain their format.
                if qoder_subagent_hook(&legacy) && direct_binary.is_none() && !uninstall {
                    continue;
                }
                let inactive_cn = def.id == "qoder-cn" && interceptor && binary.is_none();
                document.apply_hook(&desired, uninstall || inactive_cn, prune_empty)?;
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
                .iter()
                .map(|location| installed_hook_state_key(&hooks_json, location))
                .collect();
            if uninstall {
                if let Some(raw) = original.as_deref() {
                    let removal = if self.embedded_codex.is_some() {
                        let keys: Vec<_> = embedded_removal_keys
                            .unwrap_or_default()
                            .into_iter()
                            .collect();
                        super::codex_trust_writer::plan_remove_embedded_trust(
                            raw,
                            &cfg.marker,
                            &keys,
                        )
                    } else {
                        plan_remove_trust(raw, &cfg.marker, &owned_keys)
                    };
                    if let Some(content) = removal.map_err(|err| err.to_string())? {
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
            let mut needles = [path.clone(), quote_claude_hook_path(&path)]
                .into_iter()
                .map(|path| normalize_hook_reference(&path))
                .collect::<Vec<_>>();
            if let Some(data) = self.codex_sdk_data(def) {
                if let Some(quoted) = crate::sdk::agent_hooks::quote_codex_path(&data) {
                    needles.push(normalize_hook_reference(&format!("--data-dir {quoted}")));
                }
            }
            if let Some(paths) = owned_legacy_codex_scripts(
                &path,
                &def.id,
                self.resource_roots.as_ref().map(|(_, data)| data.as_path()),
            ) {
                for legacy in paths {
                    for spelling in legacy_codex_path_spellings(&legacy.to_string_lossy()) {
                        let needle = normalize_hook_reference(&spelling);
                        if !needles.contains(&needle) {
                            needles.push(needle);
                        }
                    }
                }
            }
            if document
                .data
                .get("hooks")
                .is_some_and(|hooks| remaining_hook_reference(hooks, &needles))
            {
                return Err("Unrecognized Pilot Hook reference; configuration and runtime assets were preserved".into());
            }
        }
        if document.changed() && (!uninstall || document.raw != initial_raw) {
            // The former Codex cleanup writer emitted BOM-free UTF-8. Only an
            // actual Codex uninstall edit changes this encoding boundary; a
            // no-op and every other Agent keep the original bytes.
            let raw = if uninstall && def.id == "codex" {
                document
                    .raw
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&document.raw)
                    .to_owned()
            } else {
                document.raw
            };
            edits.insert("config".into(), raw);
        }
        if self.deployment_state.is_some() {
            self.plan_state_edit(
                def,
                snapshot("state")?.as_deref(),
                uninstall,
                &retired_paths,
                &mut edits,
            )?;
        }
        Ok(edits)
    }

    fn plan_state_edit(
        &self,
        def: &AgentDefinition,
        raw: Option<&str>,
        uninstall: bool,
        retired: &[String],
        edits: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        if let Some((_, installed_by)) = &self.deployment_state {
            if let Some(state) = super::deployed_state_merge::plan_hook_state(
                raw,
                def,
                *installed_by,
                uninstall,
                !edits.is_empty(),
                retired,
            )
            .map_err(|err| err.to_string())?
            {
                edits.insert("state".into(), state);
            }
        }
        Ok(())
    }

    pub(super) fn retire_sdk_hook_settings(
        &self,
        def: &AgentDefinition,
        source: &str,
    ) -> Result<Option<String>, String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        let mut document = SettingsDocument::from_snapshot(Some(source), settings_syntax(hook))?;
        if document
            .data
            .get("hooks")
            .is_some_and(|hooks| !hooks.is_object())
        {
            return Err("invalid JSON settings: hooks must be an object".into());
        }
        for legacy in self.legacy_hook_definitions(def) {
            let Some(event) = legacy.hook_json_path.last() else {
                continue;
            };
            if document.data["hooks"]
                .get(event)
                .is_some_and(|hooks| !hooks.is_array())
            {
                return Err(format!(
                    "invalid JSON settings: hooks.{event} must be an array"
                ));
            }
            for installed in self.installed_sdk_hooks(def, &document.data, &legacy) {
                document.apply_hook(&installed, true, false)?;
            }
        }
        Ok(document.changed().then_some(document.raw))
    }

    pub async fn undeploy_hooks(&self, def: &AgentDefinition) -> bool {
        match self.configure(def, true, None).await {
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
        Ok(self
            .resolve_codex_hook_locations_from_data(
                def,
                event_names,
                allow_missing,
                data,
                include_legacy,
                true,
            )?
            .into_iter()
            .map(|location| (location.event_name.clone(), location))
            .collect())
    }

    fn resolve_codex_hook_locations_from_data(
        &self,
        def: &AgentDefinition,
        event_names: &[String],
        allow_missing: bool,
        data: &Value,
        include_legacy: bool,
        require_unique: bool,
    ) -> Result<Vec<InstalledCodexHookLocation>, String> {
        let hook = def.hook.as_ref().ok_or("missing hook config")?;
        let hook_command = resolve_home(&hook.hook_command);
        let settings_path = resolve_home(&hook.settings_path);
        if allow_missing && data.get("hooks").is_none() {
            return Ok(Vec::new());
        }
        let hooks = data
            .get("hooks")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("installed hooks object missing: {settings_path}"))?;
        let mut result = Vec::new();
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
                    let known_command =
                        self.owns_codex_sdk_command(def, event_name, installed_command)
                            || (self.embedded_codex.is_none()
                                && (hook_commands_match(installed_command, &command)
                                    || (include_legacy
                                        && legacy_hook_commands(
                                            &hook_command,
                                            event_name,
                                            hook.event_subcommand,
                                            &def.id,
                                            self.resource_roots
                                                .as_ref()
                                                .map(|(_, data)| data.as_path()),
                                        )
                                        .iter()
                                        .any(|old| hook_commands_match(installed_command, old)))));
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
            // Older rollbacks could leave one native handler alongside the
            // restored Node handler. Both are exact matches for this install.
            let rollback_pair = include_legacy
                && matches.len() == 2
                && self.resource_roots.is_some()
                && matches
                    .iter()
                    .filter(|location| {
                        self.owns_codex_sdk_command(def, event_name, &location.handler.command)
                    })
                    .count()
                    == 1;
            if matches.is_empty() || (require_unique && matches.len() != 1 && !rollback_pair) {
                return Err(format!(
                    "expected exactly one installed Pilot handler for {event_name}; found {}",
                    matches.len()
                ));
            }
            result.extend(matches);
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
                let command = format_hook_command(
                    &interceptor.hook_command,
                    event,
                    hook_config.event_subcommand,
                    &def.id,
                );
                HookDefinition {
                    agent_id: def.id.clone(),
                    settings_path: hook_config.settings_path.clone(),
                    settings_syntax: hook_config.settings_syntax,
                    hook_json_path: vec!["hooks".into(), event.clone()],
                    hook_command: command.clone(),
                    matcher,
                    exec_args: None,
                    history_dir: None,
                    replace_hook_commands: {
                        let mut commands = interceptor
                            .replace_hook_commands
                            .clone()
                            .unwrap_or_default();
                        if def.id == "qoder-cn" {
                            if let Some((script, args)) =
                                interceptor.hook_command.rsplit_once(" --agent ")
                            {
                                commands.push(format!(
                                    "{} --agent {args}",
                                    quote_claude_hook_path(script)
                                ));
                                commands.push(wrap_legacy_ps1_command(&interceptor.hook_command));
                            }
                        }
                        commands.retain(|alias| alias != &command);
                        Some(commands)
                    },
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

    fn legacy_hook_definitions(&self, def: &AgentDefinition) -> Vec<HookDefinition> {
        self.build_interceptor_definitions(def)
            .into_iter()
            .chain(self.build_hook_definitions(def))
            .collect()
    }

    async fn native_interceptor_enabled(&self, def: &AgentDefinition) -> bool {
        if !requires_native_sdk(def)
            || def
                .hook
                .as_ref()
                .is_none_or(|hook| hook.interceptor.is_none())
        {
            return true;
        }
        let config = crate::interceptor::load_interceptor_config(None).await;
        crate::interceptor::should_deploy_interceptor_hooks(&config)
    }

    fn is_interceptor_definition(&self, def: &AgentDefinition, hook: &HookDefinition) -> bool {
        (def.id == "qoder-cn" || self.resource_roots.is_some())
            && self
                .build_interceptor_definitions(def)
                .iter()
                .any(|candidate| {
                    candidate.hook_json_path == hook.hook_json_path
                        && candidate.hook_command == hook.hook_command
                })
    }

    fn native_hook_selected(
        &self,
        def: &AgentDefinition,
        hook: &HookDefinition,
        interception: bool,
    ) -> bool {
        if self.is_interceptor_definition(def, hook) {
            return interception;
        }
        // QwenWorkCN uses prompt Hook registration to decide whether to write
        // the prompt. The verdict Hook also satisfies that registration.
        !(interception
            && def.id == "qwen-work-cn"
            && hook.hook_json_path.last().map(String::as_str) == Some("UserPromptSubmit"))
    }

    fn sdk_hook_binary(&self, def: &AgentDefinition) -> Option<PathBuf> {
        if def.id == "codex" && self.codex_legacy_cache.is_some() {
            return None;
        }
        if let Some(sdk) = &self.embedded_codex {
            return Some(sdk.binary.clone());
        }
        let (pilot, data) = self.resource_roots.as_ref()?;
        let cache = hook_cache_dir(data);
        if requires_native_sdk(def) {
            use crate::utils::runtime_paths::{resource_file, runtime_metadata};
            // The installer deploys from the validated candidate in versions/
            // before advancing current. Its transaction owns this registration.
            let installed = std::fs::canonicalize(cache.join("versions")).is_ok_and(|versions| {
                std::fs::canonicalize(pilot.parent().unwrap_or(pilot))
                    .is_ok_and(|parent| parent == versions)
            });
            let binary = if installed {
                let hook = format!("bin/{}", sdk_hook_binary_name());
                let binary = resource_file(pilot, &hook).ok()?;
                super::runtime_launcher::RuntimeLauncher::read(&cache, data)
                    .ok()?
                    .map_or(binary, |runtime| runtime.hook_path().to_owned())
            } else {
                development_sdk_hook_binary(pilot)?
            };
            let metadata = runtime_metadata(&binary).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return None;
                }
            }
            return metadata.is_file().then_some(binary);
        } else if super::hook_assets::is_sdk_codex(def) {
            let binary = crate::utils::runtime_paths::resource_file(
                pilot,
                &format!("bin/{}", sdk_hook_binary_name()),
            )
            .ok()?;
            // publish-package deploys hooks from the staged candidate before
            // committing the current pointer. Only that candidate's own process
            // may pin its sibling during the install transaction.
            if crate::utils::runtime_paths::runtime_metadata(&cache.join("update-recovery.json"))
                .is_ok_and(|meta| meta.is_file())
                && pilot.parent()?.canonicalize().ok()?
                    == cache.join("versions").canonicalize().ok()?
                && std::env::current_exe().ok()?.canonicalize().ok()?
                    == crate::utils::runtime_paths::resource_file(
                        pilot,
                        &format!("bin/{}", pilot_binary_name()),
                    )
                    .ok()?
                    .canonicalize()
                    .ok()?
            {
                return Some(
                    super::runtime_launcher::RuntimeLauncher::read(&cache, data)
                        .ok()?
                        .map_or(binary, |runtime| runtime.hook_path().to_owned()),
                );
            }
            if super::native_install::read_pointer(&cache.join("current"))
                .ok()?
                .is_some()
            {
                return installed_qoder_hook_binary(pilot, data, &cache);
            }
            // An unpacked package can be used before it has an active version pointer.
            return Some(binary);
        }
        if def.id == "qoder-cn" {
            return qoder_cn_interception_enabled()
                .then(|| installed_qoder_hook_binary(pilot, data, &hook_cache_dir(data)))
                .flatten()
                .filter(|binary| qoder_cn_command(binary, data, "PreToolUse").is_some());
        }
        if !qoder_definition_supports_exec(def, data) && self.codex_sdk_data(def).is_none() {
            return None;
        }
        installed_qoder_hook_binary(pilot, data, &cache)
    }

    fn codex_sdk_data(&self, def: &AgentDefinition) -> Option<PathBuf> {
        if let Some(sdk) = &self.embedded_codex {
            return Some(sdk.data_dir.clone());
        }
        let (_, data) = self.resource_roots.as_ref()?;
        let hook = def.hook.as_ref()?;
        (def.id == "codex" && hook.trust_toml.is_some())
            .then(|| data.join("state/standalone-codex-transcript-sdk"))
    }

    fn system_codex_sdk_paths(&self, def: &AgentDefinition) -> Option<(PathBuf, PathBuf)> {
        Some((self.sdk_hook_binary(def)?, self.codex_sdk_data(def)?))
    }

    fn owns_codex_sdk_command(&self, def: &AgentDefinition, event: &str, cmd: &str) -> bool {
        let Some(data) = self.codex_sdk_data(def) else {
            return false;
        };
        let Some(executable) = codex_command_executable(cmd) else {
            return false;
        };
        if self.embedded_codex.is_some() {
            return executable
                .file_name()
                .is_some_and(|name| name == sdk_hook_binary_name())
                && ["local", "cloud", "observe"].iter().any(|channel| {
                    codex_command(&executable, &data, event, channel).as_deref() == Some(cmd)
                });
        }
        let Some((_, root)) = &self.resource_roots else {
            return false;
        };
        let stable = super::runtime_launcher::hook_binary(root).ok();
        let cache = self
            .codex_legacy_cache
            .clone()
            .unwrap_or_else(|| hook_cache_dir(root));
        use crate::sdk::agent_hooks::codex_shell_path;
        let sibling = self
            .resource_roots
            .as_ref()
            .map(|(pilot, _)| pilot.join("bin").join(sdk_hook_binary_name()));
        let current_package = sibling
            .as_deref()
            .is_some_and(|path| codex_shell_path(path).as_ref() == executable.as_path());
        if !current_package
            && !stable
                .as_deref()
                .is_some_and(|path| codex_shell_path(path).as_ref() == executable.as_path())
            && !qoder_version_binary(&executable, &codex_shell_path(&cache))
        {
            return false;
        }
        codex_command(&executable, &data, event, codex_channel(event)).as_deref() == Some(cmd)
    }

    // Codex trusts a handler by its event, group index and handler index.
    // Keep an empty group only when removing it would move another owner's
    // handler. Reuse that group on the next activation.
    fn edit_indexed_codex_event(
        &self,
        def: &AgentDefinition,
        document: &mut SettingsDocument,
        legacy: &HookDefinition,
        desired: &HookDefinition,
        uninstall: bool,
    ) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let data = self
            .codex_sdk_data(def)
            .ok_or("Missing Codex SDK data path")?;
        let owner = hex::encode(Sha256::digest(data.as_os_str().as_encoded_bytes()));
        let vacant =
            serde_json::json!({"matcher":format!("^pilot-vacant-{}$",&owner[..16]),"hooks":[]});
        let event = desired
            .hook_json_path
            .last()
            .ok_or("Missing Codex Hook event")?;
        let current = document.data["hooks"].get(event);
        let mut groups = match current {
            None => Vec::new(),
            Some(value) => value
                .as_array()
                .ok_or("Codex Hook event must be an array")?
                .clone(),
        };
        let owned = |entry: &Value| {
            entry.get("type").is_none_or(|kind| kind == "command")
                && entry["command"].as_str().is_some_and(|command| {
                    self.owns_codex_sdk_command(def, event, command)
                        || (self.embedded_codex.is_none()
                            && (hook_commands_match(command, &legacy.hook_command)
                                || legacy
                                    .replace_hook_commands
                                    .as_deref()
                                    .is_some_and(|older| {
                                        older.iter().any(|old| hook_commands_match(command, old))
                                    })))
                })
        };
        let mut available = None;
        for (index, group) in groups.iter_mut().enumerate() {
            let mut clear = owned(group);
            if let Some(handlers) = group["hooks"].as_array() {
                let count = handlers.iter().filter(|handler| owned(handler)).count();
                if count > 0 {
                    if count != handlers.len() {
                        return Err(
                            "Codex SDK Hook shares a group with externally owned handlers".into(),
                        );
                    }
                    clear = true;
                }
            }
            if clear || *group == vacant {
                *group = vacant.clone();
                available.get_or_insert(index);
            }
        }
        if !uninstall {
            let entry = crate::hooks::build_hook_entry(desired);
            if let Some(index) = available {
                groups[index] = entry;
            } else {
                groups.push(entry);
            }
        }
        while groups.last() == Some(&vacant) {
            groups.pop();
        }
        if let Some(old) = current.and_then(Value::as_array) {
            if *old == groups {
                return Ok(());
            }
        }
        if groups.is_empty() && current.is_none() {
            return Ok(());
        }
        document.set(
            &["hooks", event],
            (!groups.is_empty()).then_some(Value::Array(groups)),
        )
    }

    fn installed_sdk_hooks(
        &self,
        def: &AgentDefinition,
        settings: &Value,
        legacy: &HookDefinition,
    ) -> Vec<HookDefinition> {
        if def.id == "qoder-cn" {
            return self
                .resource_roots
                .as_ref()
                .filter(|_| self.is_interceptor_definition(def, legacy))
                .map(|(_, data)| {
                    let cache = hook_cache_dir(data);
                    let binary = super::runtime_launcher::hook_binary(data).ok();
                    qoder_cn_owned_hooks(settings, legacy, data, |path| {
                        binary.as_deref() == Some(path) || qoder_version_binary(path, &cache)
                    })
                })
                .unwrap_or_default();
        }
        if def.id != "codex" && !requires_native_sdk(def) {
            return self.qoder_installed_exec_hooks(def, settings, legacy);
        }
        let Some(event) = legacy.hook_json_path.last() else {
            return Vec::new();
        };
        settings["hooks"][event]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| {
                std::iter::once(group).chain(group["hooks"].as_array().into_iter().flatten())
            })
            .filter_map(|handler| {
                let command = handler.get("command")?.as_str()?;
                if handler["type"] != "command" {
                    return None;
                }
                let owned = if requires_native_sdk(def) {
                    let (pilot, data) = self.resource_roots.as_ref()?;
                    let cache = hook_cache_dir(data);
                    let binary = codex_command_executable(command)?;
                    let installed = super::runtime_launcher::RuntimeLauncher::read(&cache, data)
                        .ok()
                        .flatten();
                    (installed
                        .as_ref()
                        .is_some_and(|runtime| runtime.hook_path() == binary)
                        || qoder_version_binary(&binary, &cache)
                        // Installation resolves the resource root physically. The
                        // configured cache may still use that root's lexical alias.
                        || cache.canonicalize().is_ok_and(|physical| {
                            qoder_version_binary(&binary, &physical)
                        })
                        || development_sdk_hook_binary(pilot).is_some_and(|dev| {
                            crate::sdk::agent_hooks::codex_shell_path(&dev).as_ref() == binary
                        }))
                        && self
                            .desired_hook(def, legacy.clone(), Some(&binary))
                            .is_some_and(|desired| desired.hook_command == command)
                } else {
                    self.owns_codex_sdk_command(def, event, command)
                };
                if !owned {
                    return None;
                }
                let mut hook = legacy.clone();
                hook.hook_command = command.into();
                hook.replace_hook_commands = None;
                Some(hook)
            })
            .collect()
    }

    fn qoder_installed_exec_hooks(
        &self,
        def: &AgentDefinition,
        settings: &Value,
        legacy: &HookDefinition,
    ) -> Vec<HookDefinition> {
        let Some((_, data)) = self.resource_roots.as_ref().filter(|_| def.id == "qoder") else {
            return Vec::new();
        };
        let cache = hook_cache_dir(data);
        let binary = super::runtime_launcher::hook_binary(data).ok();
        qoder_owned_exec_hooks(settings, legacy, data, |path| {
            binary.as_deref() == Some(path) || qoder_version_binary(path, &cache)
        })
    }

    fn sdk_desired_hook(&self, legacy: HookDefinition, binary: Option<&Path>) -> HookDefinition {
        let Some(binary) = binary else {
            return legacy;
        };
        if legacy.agent_id == "qoder-cn" {
            let command = self.resource_roots.as_ref().and_then(|(_, data)| {
                qoder_cn_command(binary, data, legacy.hook_json_path.last()?)
            });
            let Some(command) = command else {
                return legacy;
            };
            let mut native = legacy;
            let old = std::mem::replace(&mut native.hook_command, command);
            native
                .replace_hook_commands
                .get_or_insert_with(Vec::new)
                .push(old);
            native.shell = None;
            native.timeout = Some(QODER_EXEC_TIMEOUT);
            return native;
        }
        if legacy.agent_id == "codex" {
            let Some(event) = legacy.hook_json_path.last() else {
                return legacy;
            };
            let channel = if codex_channel(event) == "local" {
                self.embedded_codex
                    .as_ref()
                    .map_or("local", |sdk| sdk.channel)
            } else {
                "observe"
            };
            let data_dir = self
                .embedded_codex
                .as_ref()
                .map(|sdk| sdk.data_dir.clone())
                .or_else(|| {
                    self.resource_roots
                        .as_ref()
                        .map(|(_, root)| root.join("state/standalone-codex-transcript-sdk"))
                });
            let Some(command) = data_dir
                .as_deref()
                .and_then(|data| codex_command(binary, data, event, channel))
            else {
                return legacy;
            };
            let mut native = legacy;
            let old = std::mem::replace(&mut native.hook_command, command);
            if self.embedded_codex.is_none() {
                native
                    .replace_hook_commands
                    .get_or_insert_with(Vec::new)
                    .push(old);
            }
            native.shell = None;
            native.timeout = Some(4.0);
            return native;
        }
        self.resource_roots
            .as_ref()
            .map_or(legacy.clone(), |(_, data)| {
                qoder_exec_definition(&legacy, binary, data)
            })
    }

    fn desired_hook(
        &self,
        def: &AgentDefinition,
        mut legacy: HookDefinition,
        binary: Option<&Path>,
    ) -> Option<HookDefinition> {
        let Some(relative) = def
            .hook
            .as_ref()
            .and_then(|hook| hook.native_sdk_data.as_deref())
        else {
            return Some(self.sdk_desired_hook(legacy, binary));
        };
        let Some(binary) = binary else {
            return Some(legacy); // Uninstall also recognizes the historical script.
        };
        let (_, root) = self.resource_roots.as_ref()?;
        let relative = Path::new(relative);
        if !relative.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) {
            return None;
        }
        let event = legacy.hook_json_path.last()?;
        let interception = self.is_interceptor_definition(def, &legacy);
        let (data_dir, channel) = if interception {
            (
                root.join(format!("state/standalone-{}-interceptor-sdk", def.id)),
                "local",
            )
        } else {
            (
                if relative == Path::new(".") {
                    root.clone()
                } else {
                    root.join(relative)
                },
                "observe",
            )
        };
        // Cursor desktop and CLI share the same configuration and registration.
        let agent = if def.id == "cursor-cli" {
            "cursor"
        } else {
            &def.id
        };
        let command = sdk_hook_command(binary, &data_dir, agent, event, channel)?;
        let old = std::mem::replace(&mut legacy.hook_command, command);
        legacy
            .replace_hook_commands
            .get_or_insert_with(Vec::new)
            .push(old);
        legacy.shell = None;
        legacy.timeout = Some(4.0);
        Some(legacy)
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
            self.resource_roots.as_ref().map(|(_, data)| data.as_path()),
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
            exec_args: None,
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
                self.resource_roots.as_ref().map(|(_, data)| data.as_path()),
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

fn requires_native_sdk(def: &AgentDefinition) -> bool {
    def.hook
        .as_ref()
        .is_some_and(|hook| hook.native_sdk_data.is_some())
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
        super::system_toml_hooks::is_system(def) || detect_agent(&def.detection).await
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
    fn embedded_codex_clear_preserves_marked_trust_for_other_settings_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("codex");
        let state = root.join("sdk");
        let resources = root.join("package");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("hooks.json"), r#"{"hooks": {}}"#).unwrap();
        let ours = format!("{}:stop:0:0", home.join("hooks.json").display());
        let other = format!("{}:stop:0:0", root.join("other-hooks.json").display());
        let config = home.join("config.toml");
        let binary = resources.join("bin").join(sdk_hook_binary_name());
        let (_, def) =
            embedded_codex_definition(&home.join("hooks.json"), &config, &state, &binary, "cloud")
                .unwrap();
        let marker = def.hook.unwrap().trust_toml.unwrap().marker;
        let entry = |key: &str, hash: &str| {
            format!(
                "[hooks.state.{}]\nenabled = true\ntrusted_hash = '{hash}'\n",
                serde_json::to_string(key).unwrap(),
            )
        };
        std::fs::write(
            &config,
            format!(
                "# BEGIN {marker} trust\n{}{}# END {marker} trust\n",
                entry(&ours, "own"),
                entry(&other, "foreign"),
            ),
        )
        .unwrap();
        let before = inspect_embedded_codex_hooks(Some(&home), &state, &resources).unwrap();
        reconcile_embedded_codex_hooks(&home, &state, &resources, None, || Ok(())).unwrap();
        let remaining = std::fs::read_to_string(&config).unwrap();
        let parsed: toml::Table = toml::from_str(&remaining).unwrap();
        assert_eq!(
            parsed["hooks"]["state"][&other]["trusted_hash"].as_str(),
            Some("foreign")
        );
        assert!(
            super::super::codex_trust_writer::marked_trust_keys(&remaining, &marker)
                .unwrap()
                .contains(&other)
        );
        assert!(parsed["hooks"]["state"].get(&ours).is_none());
        assert_eq!(before["trust_records"].as_array().unwrap().len(), 1);
        assert_eq!(before["trust_records"][0]["key"], ours);
    }

    #[test]
    fn codex_hook_transaction_restores_files_when_precommit_check_fails() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let home = root.join("codex");
        let state = root.join("sdk");
        let resources = root.join("package");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(resources.join("bin")).unwrap();
        let binary = resources.join("bin").join(sdk_hook_binary_name());
        std::fs::copy(std::env::current_exe().unwrap(), binary).unwrap();
        let settings = home.join("hooks.json");
        let trust = home.join("config.toml");
        let original_hooks =
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user"}]}]}}"#;
        let original_trust = "model = 'user'\n";
        std::fs::write(&settings, original_hooks).unwrap();
        std::fs::write(&trust, original_trust).unwrap();
        let result =
            reconcile_embedded_codex_hooks(&home, &state, &resources, Some("cloud"), || {
                assert!(std::fs::read_to_string(&settings)?.contains("sdk-hook"));
                assert!(std::fs::read_to_string(&trust)?.contains("trusted_hash"));
                anyhow::bail!("precommit check failed")
            });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("precommit check failed"));
        assert_eq!(std::fs::read_to_string(settings).unwrap(), original_hooks);
        assert_eq!(std::fs::read_to_string(trust).unwrap(), original_trust);
    }

    #[test]
    fn verified_qoder_exec_range_keeps_older_and_unknown_cli_on_legacy_hooks() {
        for name in [
            "qodercli-1.0.33",
            "qodercli-1.1.75",
            "qodercli",
            "qoder-wrapper",
        ] {
            assert!(!qoder_supports_exec(Path::new(name)));
        }
        for name in ["qodercli-1.1.76", "qodercli-1.1.76.exe", "qoder-1.2.0"] {
            assert!(qoder_supports_exec(Path::new(name)));
        }
    }

    #[test]
    fn qoder_cn_rollback_preserves_collection_and_user_entries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let binary = root
            .join("current package/bin")
            .join(sdk_hook_binary_name());
        let foreign = root.join("user binary/bin").join(sdk_hook_binary_name());
        let mut definition: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/qoder-cn.json")).unwrap();
        definition.hook.as_mut().unwrap().interceptor.take();
        let original = serde_json::json!({"hooks":{"PreToolUse":[{"matcher":"*", "hooks":[
            {"type":"command","command":qoder_cn_command(&binary, &root, "PreToolUse").unwrap()},
            {"type":"command","command":qoder_cn_command(&foreign, &root, "PreToolUse").unwrap()},
            {"type":"command","command":"qoder-cn-collection"},
            {"type":"command","command":"third-party"},
        ]}]}});
        let edited =
            plan_qoder_legacy_restore(&original.to_string(), &definition, &root, &binary, true)
                .unwrap()
                .unwrap();
        let after: Value = serde_json::from_str(&edited).unwrap();
        assert_eq!(
            after["hooks"]["PreToolUse"][0]["hooks"].as_array().unwrap(),
            &original["hooks"]["PreToolUse"][0]["hooks"]
                .as_array()
                .unwrap()[1..],
        );
        assert!(
            plan_qoder_legacy_restore(&edited, &definition, &root, &binary, true)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn qoder_sdk_migration_recognizes_exact_old_and_new_commands() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let binary = root.join("versions/2.0.0/bin").join(sdk_hook_binary_name());
        let def = HookDefinition {
            agent_id: "qoder".into(),
            hook_json_path: vec!["hooks".into(), "PreToolUse".into()],
            hook_command: root
                .join("hooks/interceptor-hook.sh")
                .to_string_lossy()
                .into_owned(),
            settings_path: root.join("settings.json").to_string_lossy().into_owned(),
            settings_syntax: None,
            matcher: Some("*".into()),
            exec_args: None,
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: None,
            timeout: Some(10.0),
            insert: Some(HookInsert::Head),
        };
        let old = qoder_legacy_exec_args(&def, root);
        let new = qoder_exec_args(&def, root);
        assert_eq!(
            &new[..5],
            ["sdk-hook", "--channel", "local", "--agent", "qoder-auto"]
        );
        let source = serde_json::json!({"hooks": {"PreToolUse": [{"matcher":"*", "hooks": [
            {"type":"command","command":binary,"args":old},
            {"type":"command","command":binary,"args":new},
            {"type":"command","command":binary,"args":["unrelated-user-hook"]},
        ]}]}});
        let mut document =
            SettingsDocument::from_snapshot(Some(&source.to_string()), JsonSyntax::Json).unwrap();
        let owned = qoder_owned_exec_hooks(&document.data, &def, root, |path| {
            qoder_version_binary(path, root)
        });
        assert_eq!(owned.len(), 2);
        for hook in owned {
            document.apply_hook(&hook, true, true).unwrap();
        }
        let left = document
            .data
            .pointer("/hooks/PreToolUse/0/hooks")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["args"], serde_json::json!(["unrelated-user-hook"]));
    }

    #[test]
    fn qoder_managed_version_requires_matching_executable() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin/qodercli");
        std::fs::create_dir_all(&bin).unwrap();
        assert_eq!(qoder_installed_cli(home.path()), None);
        std::fs::write(bin.join("version.txt"), "1.1.76\n").unwrap();
        assert_eq!(qoder_installed_cli(home.path()), Some(false));
        let executable = bin.join(if cfg!(windows) {
            "qodercli-1.1.76.exe"
        } else {
            "qodercli-1.1.76"
        });
        std::fs::write(&executable, b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(qoder_installed_cli(home.path()), Some(true));
        std::fs::write(bin.join("version.txt"), "../unexpected").unwrap();
        assert_eq!(qoder_installed_cli(home.path()), Some(false));
    }

    #[test]
    fn windows_hook_paths_preserve_unicode_spaces_and_arguments() {
        for script in [
            "C:/Users/中文 🚀/hooks/cursor.ps1",
            "C:\\Users\\a & b\\hooks\\qoder.ps1",
            "C:/folder.ps1/hooks/KIRO.PS1",
        ] {
            let expected = format!(
                "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script}\" --agent-id qoder-cn"
            );
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
            let command = format!(
                "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{path}\" stop"
            );
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
            exec_args: None,
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
                exec_args: None,
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
                None,
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
                scope: None,
                system_settings_path: None,
                events: vec!["Stop".into()],
                hook_command: "/opt/hook.sh".into(),
                native_sdk_data: None,
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
            .plan_config_edits(&def, &transaction, false, None, true)
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
