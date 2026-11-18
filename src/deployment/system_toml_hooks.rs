//! Linux managed Hook configuration shares a TOML document with administrator settings.
use crate::types::{AgentDefinition, EventSubcommand, HookScope};
use std::path::Path;

pub(super) const GROK: &str = "grok-build";
const OWNER: &str = "# pilot-hook: ";
pub(super) const DEFAULT_PATH: &str = "/etc/grok/managed_config.toml";
const CODEX_PATH: &str = "/etc/codex/config.toml";
const GROK_LOCK: &str = "/etc/grok/managed_config.toml.pilot-lock";
const CODEX_LOCK: &str = "/etc/codex/config.toml.pilot-lock";

fn default_path(id: &str) -> Option<&'static str> {
    match id {
        GROK => Some(DEFAULT_PATH),
        "codex" => Some(CODEX_PATH),
        _ => None,
    }
}

pub(super) fn supports(id: &str) -> bool {
    default_path(id).is_some()
}

pub(super) fn is_system_path(path: &Path) -> bool {
    [DEFAULT_PATH, CODEX_PATH]
        .iter()
        .any(|candidate| path == Path::new(candidate))
}

pub(super) fn is_system_lock(path: &Path) -> bool {
    [GROK_LOCK, CODEX_LOCK]
        .iter()
        .any(|candidate| path == Path::new(candidate))
}

pub(super) fn is_system(def: &AgentDefinition) -> bool {
    supports(&def.id)
        && def
            .hook
            .as_ref()
            .is_some_and(|hook| hook.scope == Some(HookScope::System))
}

pub(super) fn validate_path(id: &str, path: &str) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("System hooks are supported only on Linux".into());
    }
    let expected = default_path(id).ok_or("This agent does not support Linux system hooks")?;
    if !cfg!(test) && path != expected {
        return Err("Unexpected managed system config path".into());
    }
    if !Path::new(path).is_absolute() || path.chars().any(char::is_control) {
        return Err("Managed system config path must be absolute".into());
    }
    Ok(())
}

pub(super) fn definition(
    def: &AgentDefinition,
    scope: HookScope,
) -> Result<AgentDefinition, String> {
    let default = default_path(&def.id).ok_or("This agent does not support Linux system hooks")?;
    let mut result = def.clone();
    let hook = result
        .hook
        .as_mut()
        .ok_or("Missing managed Hook definition")?;
    hook.scope = Some(scope);
    if scope == HookScope::System {
        let path = if cfg!(test) {
            hook.system_settings_path.as_deref().unwrap_or(default)
        } else {
            default
        };
        validate_path(&def.id, path)?;
        hook.settings_path = path.into();
    }
    Ok(result)
}

fn parse(raw: &str) -> Result<toml::Table, String> {
    toml::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw))
        .map_err(|_| "Invalid TOML in system config; original file preserved".into())
}

fn marker(def: &AgentDefinition, tag: &str) -> String {
    format!("# {tag} loongsuite-pilot:{}", def.id)
}

fn render(def: &AgentDefinition) -> Result<(String, String), String> {
    let hook = def.hook.as_ref().ok_or("Missing managed Hook definition")?;
    let script = &hook.hook_command;
    if !Path::new(script).is_absolute() || script.chars().any(char::is_control) {
        return Err("Managed system hooks require an absolute shell script path".into());
    }
    let quoted = format!("'{}'", script.replace('\'', "'\\''"));
    let owner = format!("{OWNER}{}", serde_json::json!(script));
    let mut text = format!("{}\n{owner}\n", marker(def, "BEGIN"));
    for event in &hook.events {
        if event.is_empty()
            || !event
                .bytes()
                .all(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        {
            return Err("Invalid system hook event".into());
        }
        let subcommand = if hook.event_subcommand == Some(EventSubcommand::KebabCase) {
            super::hook_strategy::event_to_subcommand(event)
        } else {
            event.clone()
        };
        let command = serde_json::json!(format!("/bin/bash {quoted} {subcommand}"));
        text.push_str(&format!("[[hooks.{event}]]\nmatcher = \"\"\nhooks = [{{ type = \"command\", command = {command} }}]\n\n"));
    }
    text.push_str(&format!("{}\n", marker(def, "END")));
    Ok((text, owner))
}

struct Owned<'a> {
    before: &'a str,
    block: &'a str,
    after: &'a str,
}

fn split_owned<'a>(raw: &'a str, def: &AgentDefinition, owner: &str) -> Result<Owned<'a>, String> {
    let begin = marker(def, "BEGIN");
    let end = marker(def, "END");
    let mut start = None;
    let mut stop = None;
    let mut offset = 0;
    let conflicting = "Conflicting System Pilot markers; original file preserved";
    for line in raw.split_inclusive('\n') {
        let label = line.trim_start_matches('\u{feff}').trim();
        let duplicate = if label == begin {
            start
                .replace(offset + usize::from(line.starts_with('\u{feff}')) * 3)
                .is_some()
        } else {
            label == end && stop.replace(offset + line.len()).is_some()
        };
        if duplicate {
            return Err(conflicting.into());
        }
        offset += line.len();
    }
    match (start, stop) {
        (None, None) => Ok(Owned {
            before: raw,
            block: "",
            after: "",
        }),
        (Some(start), Some(stop)) if start < stop => {
            let block = &raw[start..stop];
            let owners: Vec<_> = block
                .lines()
                .filter(|line| line.starts_with(OWNER))
                .collect();
            if owners != [owner] {
                return Err(
                    "Managed system hook belongs to another Pilot runtime; original file preserved"
                        .into(),
                );
            }
            // A marker inside a multiline TOML value never authorizes an edit.
            parse(&raw[..start])?;
            parse(block)?;
            Ok(Owned {
                before: &raw[..start],
                block,
                after: &raw[stop..],
            })
        }
        _ => Err(conflicting.into()),
    }
}

pub(super) fn installed(raw: &str, def: &AgentDefinition) -> Result<bool, String> {
    parse(raw)?;
    let (wanted, owner) = render(def)?;
    Ok(split_owned(raw, def, &owner)?.block.replace("\r\n", "\n") == wanted)
}

pub(super) fn read(def: &AgentDefinition) -> Result<String, String> {
    let path = &def
        .hook
        .as_ref()
        .ok_or("Missing managed Hook definition")?
        .settings_path;
    validate_path(&def.id, path)?;
    match super::codex_trust_writer::read_config_snapshot(path) {
        Ok(raw) => Ok(raw.unwrap_or_default()),
        Err(error) => Err(format!("Cannot read managed system config: {error}")),
    }
}

pub(super) fn plan(
    raw: &str,
    def: &AgentDefinition,
    uninstall: bool,
) -> Result<Option<String>, String> {
    let mut current = parse(raw)?;
    let (desired, owner) = render(def)?;
    let owned = split_owned(raw, def, &owner)?;
    let outside = [owned.before, owned.after].concat();
    let entry = Path::new(&def.hook.as_ref().unwrap().hook_command)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid system hook script name")?;
    if outside.contains(entry) {
        return Err(
            "Unmarked System Pilot hook exists; reconcile ownership before retrying".into(),
        );
    }
    let next = if uninstall {
        outside
    } else if owned.block.is_empty() {
        let separator = if raw.is_empty() || raw.ends_with('\n') || raw == "\u{feff}" {
            ""
        } else {
            "\n"
        };
        [raw, separator, &desired].concat()
    } else {
        [owned.before, &desired, owned.after].concat()
    };
    if next == raw {
        return Ok(None);
    }
    if !owned.after.trim().is_empty() {
        let mut probe = "__loongsuite_pilot_tail__".to_owned();
        while current.contains_key(&probe) {
            probe.push('_');
        }
        current = parse(&format!("[{probe}]\n{}", owned.after))?;
        if current
            .get(&probe)
            .and_then(toml::Value::as_table)
            .is_some_and(|table| !table.is_empty())
        {
            return Err("Keys after the Pilot block would change TOML table ownership; original file preserved".into());
        }
    }
    let path = &def
        .hook
        .as_ref()
        .ok_or("Missing managed Hook definition")?
        .settings_path;
    validate_path(&def.id, path)?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.permissions().readonly() => {
            return Err(
                "System config is read-only or externally mounted; update its deployment source"
                    .into(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect managed system config: {error}")),
    }
    parse(&next)?;
    Ok(Some(next))
}
