//! Claude settings injection used by `loongsuite-pilot inject`.

use crate::hooks::{legacy_claude_hook_paths, quote_claude_hook_path, with_claude_settings_lock};
use crate::types::AgentHookConfig;
use crate::utils::{write_text_file_atomic, AtomicTextWriteOptions, ExpectedFileState};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInjectArgs {
    pub config_dir: Option<String>,
    pub json: bool,
    pub help: bool,
    pub agents: Option<String>,
}

pub fn parse_inject_command_args(argv: &[String]) -> Result<ParsedInjectArgs, String> {
    let mut opts = ParsedInjectArgs {
        config_dir: None,
        json: false,
        help: false,
        agents: None,
    };
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if arg == "--json" {
            opts.json = true;
            index += 1;
            continue;
        }
        if arg == "--help" || arg == "-h" {
            opts.help = true;
            index += 1;
            continue;
        }
        let key = arg.split('=').next().unwrap_or(arg);
        if key != "--agents" && key != "--config-dir" {
            return Err(format!("Unknown option: {arg}"));
        }
        let value = if arg.contains('=') {
            arg[key.len() + 1..].to_string()
        } else {
            index += 1;
            argv.get(index).cloned().unwrap_or_default()
        };
        if value.trim().is_empty() || value.starts_with("--") {
            return Err(format!("Missing value for {key}"));
        }
        if key == "--agents" {
            opts.agents = Some(value);
        } else {
            opts.config_dir = Some(value);
        }
        index += 1;
    }
    if !opts.help && opts.agents.as_deref() != Some("claude-code") {
        return Err("Specify --agents=claude-code; other agents are not supported".into());
    }
    Ok(opts)
}

fn is_pilot_command(command: &str, expected: &HashSet<String>) -> bool {
    if expected.contains(command) {
        return true;
    }
    regex::Regex::new(r#"^(?:"[^"\n]*[\\/]claude-code-loongsuite-pilot-hook\.sh"|'[^'\n]*[\\/]claude-code-loongsuite-pilot-hook\.sh'|[^\s'";|&]+[\\/]claude-code-loongsuite-pilot-hook\.sh)\s+(?:pre-tool-use|stop|stop-failure|subagent-start|subagent-stop)$"#)
        .unwrap()
        .is_match(command)
}

pub fn merge_claude_hooks(
    settings: &Value,
    hook: &AgentHookConfig,
    data_dir: &str,
) -> Result<Value, String> {
    if settings.get("disableAllHooks") == Some(&Value::Bool(true))
        || settings.get("allowManagedHooksOnly") == Some(&Value::Bool(true))
    {
        return Err("Settings disable user hooks; refusing to change the policy".into());
    }
    let mut result = settings.clone();
    if !result.is_object() {
        return Err("settings.json must be an object".into());
    }
    let hooks = match result.get("hooks") {
        None => Value::Object(Map::new()),
        Some(value) if value.is_object() => value.clone(),
        _ => return Err("hooks must be an object".into()),
    };
    let mut env = match result.get("env") {
        None => Map::new(),
        Some(value) if value.is_object() => value.as_object().unwrap().clone(),
        _ => return Err("env must be an object".into()),
    };
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        Value::String(data_dir.to_string()),
    );
    let quoted = quote_claude_hook_path(&hook.hook_command);
    let mut commands = HashMap::new();
    let mut expected = HashSet::new();
    for event in &hook.events {
        let arg = kebab(event);
        let command = format!("{quoted} {arg}");
        commands.insert(event.clone(), command.clone());
        expected.insert(command);
        for legacy in legacy_claude_hook_paths(&hook.hook_command) {
            expected.insert(format!("{legacy} {arg}"));
        }
    }
    let mut hooks_obj = hooks.as_object().cloned().unwrap_or_default();
    let events: Vec<String> = hooks_obj.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks_obj.get(&event).and_then(Value::as_array) else {
            return Err(format!("hooks.{event} must be an array"));
        };
        let mut next_groups = Vec::new();
        for group in groups {
            let Some(entry) = group.as_object() else {
                return Err(format!("hooks.{event} entry must be an object"));
            };
            let Some(handlers) = entry.get("hooks").and_then(Value::as_array) else {
                return Err(format!("hooks.{event} entry.hooks must be an array"));
            };
            let remaining: Vec<Value> = handlers
                .iter()
                .filter(|handler| {
                    handler
                        .get("command")
                        .and_then(Value::as_str)
                        .is_none_or(|command| !is_pilot_command(command, &expected))
                })
                .cloned()
                .collect();
            if remaining.len() == handlers.len() {
                next_groups.push(group.clone());
            } else if !remaining.is_empty() {
                let mut next = entry.clone();
                next.insert("hooks".into(), Value::Array(remaining));
                next_groups.push(Value::Object(next));
            }
        }
        hooks_obj.insert(event, Value::Array(next_groups));
    }
    for (event, command) in commands {
        let groups = hooks_obj
            .entry(event.clone())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !groups.is_array() {
            return Err(format!("hooks.{event} must be an array"));
        }
        let matcher = hook
            .event_matchers
            .as_ref()
            .and_then(|map| map.get(&event))
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .or_else(|| hook.matcher.clone())
            .unwrap_or_else(|| "*".into());
        groups.as_array_mut().unwrap().push(serde_json::json!({ "matcher": matcher, "hooks": [{ "type": "command", "command": command }] }));
    }
    result
        .as_object_mut()
        .unwrap()
        .insert("hooks".into(), Value::Object(hooks_obj));
    result
        .as_object_mut()
        .unwrap()
        .insert("env".into(), Value::Object(env));
    Ok(result)
}

fn kebab(event: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = event.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && ch.is_ascii_uppercase() && chars[index - 1].is_ascii_alphanumeric() {
            out.push('-');
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

pub async fn inject_claude_directory(
    config_dir: &str,
    data_dir: &str,
    hook: &AgentHookConfig,
) -> Result<Value, String> {
    inject_claude_directory_with_lock_timeout(config_dir, data_dir, hook, 10_000).await
}

// Native overload for the historical optional lock timeout; the public command
// keeps its exact 10s budget. No changes to canonicalization or locking order.
async fn inject_claude_directory_with_lock_timeout(
    config_dir: &str,
    data_dir: &str,
    hook: &AgentHookConfig,
    timeout_ms: u64,
) -> Result<Value, String> {
    if cfg!(windows) {
        return Err("Session hook injection currently supports Linux and macOS only".into());
    }
    if hook.format.as_str() != "nested"
        || hook.event_subcommand.map(|style| style.as_str()) != Some("kebab-case")
    {
        return Err("Unsupported Claude hook definition".into());
    }
    tokio::fs::metadata(&hook.hook_command)
        .await
        .map_err(|_| format!("missing hook command {}", hook.hook_command))?;
    tokio::fs::create_dir_all(config_dir)
        .await
        .map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(config_dir, std::fs::Permissions::from_mode(0o700));
    }
    let real_dir = tokio::fs::canonicalize(config_dir)
        .await
        .map_err(|err| err.to_string())?;
    let settings_path = real_dir.join("settings.json");
    let settings_path_text = settings_path.to_string_lossy().into_owned();
    with_claude_settings_lock(
        &settings_path_text,
        || inject_locked(&settings_path_text, data_dir, hook),
        timeout_ms,
    )
    .await?
}

async fn inject_locked(
    settings_path: &str,
    data_dir: &str,
    hook: &AgentHookConfig,
) -> Result<Value, String> {
    #[cfg(unix)]
    let mut mode = 0o600u32;
    #[cfg(not(unix))]
    let mode = 0o600u32;
    let raw = match tokio::fs::symlink_metadata(settings_path).await {
        Ok(meta) => {
            if !meta.is_file() {
                return Err("settings.json must be a regular, non-linked file".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() > 1 {
                    return Err("settings.json must be a regular, non-linked file".into());
                }
                mode = meta.mode() & 0o777;
            }
            Some(
                tokio::fs::read_to_string(settings_path)
                    .await
                    .map_err(|err| err.to_string())?,
            )
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.to_string()),
    };
    let settings = match &raw {
        None => Value::Object(Map::new()),
        Some(raw) => serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|err| err.to_string())?,
    };
    if !settings.is_object() {
        return Err("settings.json must be an object".into());
    }
    let next = merge_claude_hooks(&settings, hook, data_dir)?;
    let status = if settings == next {
        "unchanged"
    } else {
        "updated"
    };
    if status == "updated" {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&next).unwrap_or_else(|_| "{}".into())
        );
        write_text_file_atomic(
            settings_path,
            &text,
            &AtomicTextWriteOptions {
                expected: Some(match &raw {
                    None => ExpectedFileState::Missing,
                    Some(raw) => ExpectedFileState::Present(raw.clone()),
                }),
                backup_path: None,
                mode: Some(mode),
            },
        )
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(
        serde_json::json!({ "status": status, "agentId": "claude-code", "settingsPath": settings_path }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EventSubcommand, HookFormat};

    fn hook() -> AgentHookConfig {
        AgentHookConfig {
            settings_path: "/tmp/settings.json".into(),
            settings_syntax: None,
            events: vec!["PreToolUse".into(), "Stop".into()],
            hook_command: "/opt/hooks/claude-code-loongsuite-pilot-hook.sh".into(),
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
        }
    }

    #[test]
    fn merges_env_and_replaces_only_pilot_commands() {
        let settings = serde_json::json!({
            "env": { "KEEP": "1" },
            "hooks": {
                "Stop": [{ "matcher": "*", "hooks": [
                    { "type": "command", "command": "/opt/hooks/claude-code-loongsuite-pilot-hook.sh stop" },
                    { "type": "command", "command": "/opt/customer.sh stop" }
                ]}]
            }
        });
        let merged = merge_claude_hooks(&settings, &hook(), "/data").unwrap();
        assert_eq!(merged["env"]["LOONGSUITE_PILOT_DATA_DIR"], "/data");
        assert_eq!(merged["env"]["KEEP"], "1");
        let stop = &merged["hooks"]["Stop"];
        let text = stop.to_string();
        assert!(text.contains("/opt/customer.sh stop"));
        assert_eq!(
            stop.as_array()
                .unwrap()
                .iter()
                .filter(|group| group
                    .to_string()
                    .contains("claude-code-loongsuite-pilot-hook.sh stop"))
                .count(),
            1
        );
        assert!(merged["hooks"]["PreToolUse"]
            .to_string()
            .contains("pre-tool-use"));
    }

    #[test]
    fn requires_claude_code_agent() {
        assert!(parse_inject_command_args(&["--agents=codex".into()]).is_err());
        let parsed = parse_inject_command_args(&[
            "--agents=claude-code".into(),
            "--config-dir".into(),
            "/tmp/claude".into(),
            "--json".into(),
        ])
        .unwrap();
        assert!(parsed.json);
        assert_eq!(parsed.config_dir.as_deref(), Some("/tmp/claude"));
    }
}

#[cfg(all(test, unix))]
#[path = "inject_command_history_contract_tests.rs"]
mod history_contract_tests;

#[cfg(all(test, unix))]
#[path = "claude_inject_review_history_contract_tests.rs"]
mod review_history_contract_tests;
