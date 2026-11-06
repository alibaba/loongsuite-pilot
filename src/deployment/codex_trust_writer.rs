//! Codex `config.toml` trust hashes.
//!
//! Edits keep every byte outside Pilot's exact hook-state tables. Hashes follow
//! Codex handler normalization: sorted JSON, sha256, `sha256:` prefix.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const CODEX_HOOK_EVENT_KEYS: &[(&str, &str)] = &[
    ("PreToolUse", "pre_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("PostToolUse", "post_tool_use"),
    ("PostToolUseFailure", "post_tool_use_failure"),
    ("PreCompact", "pre_compact"),
    ("PostCompact", "post_compact"),
    ("SessionStart", "session_start"),
    ("SessionEnd", "session_end"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("SubagentStart", "subagent_start"),
    ("SubagentStop", "subagent_stop"),
    ("Stop", "stop"),
];

const MATCHER_EVENTS: &[&str] = &[
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];

const ADDITIONAL_CONTEXT_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
];

const DEFAULT_ADDITIONAL_CONTEXT_LIMIT: f64 = 2500.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustPlatform {
    Linux,
    Win32,
}

impl TrustPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstalledCodexCommandHandler {
    pub command: String,
    pub command_windows: Option<String>,
    pub timeout: Option<f64>,
    pub r#async: Option<bool>,
    pub status_message: Option<String>,
    pub additional_context_limit: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstalledCodexHookLocation {
    pub event_name: String,
    pub event_key: String,
    pub group_index: usize,
    pub handler_index: usize,
    pub matcher: Option<String>,
    pub handler: InstalledCodexCommandHandler,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
    pub valid: bool,
    pub mismatches: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct InvalidCodexConfigError {
    pub message: String,
}

impl std::fmt::Display for InvalidCodexConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for InvalidCodexConfigError {}

#[derive(Debug, Clone)]
pub struct InstalledTrustOpts {
    pub config_path: String,
    pub hooks_json_abs_path: String,
    pub locations: HashMap<String, InstalledCodexHookLocation>,
    pub retired_keys: Vec<String>,
    pub marker: String,
}

#[derive(Debug, Clone)]
pub struct LegacyTrustOpts {
    pub config_path: String,
    pub hooks_json_abs_path: String,
    pub hook_events: Vec<String>,
    pub event_to_command: HashMap<String, String>,
    pub event_to_group_index: HashMap<String, usize>,
    pub retired_keys: Vec<String>,
    pub marker: String,
}

#[derive(Debug, Clone)]
pub enum TrustOpts {
    Installed(InstalledTrustOpts),
    Legacy(LegacyTrustOpts),
}

pub fn event_key(event_name: &str) -> Option<&'static str> {
    CODEX_HOOK_EVENT_KEYS
        .iter()
        .find(|(name, _)| *name == event_name)
        .map(|(_, key)| *key)
}

pub fn compute_installed_hook_trust_hash(
    location: &InstalledCodexHookLocation,
    platform: TrustPlatform,
) -> Result<String, String> {
    let expected = event_key(&location.event_name).ok_or_else(|| {
        format!(
            "Unknown or inconsistent hook event: {}",
            location.event_name
        )
    })?;
    if expected != location.event_key {
        return Err(format!(
            "Unknown or inconsistent hook event: {}",
            location.event_name
        ));
    }
    let matcher = if MATCHER_EVENTS.contains(&location.event_name.as_str()) {
        location.matcher.clone()
    } else {
        None
    };
    let mut payload = Map::new();
    payload.insert(
        "event_name".into(),
        Value::String(location.event_key.clone()),
    );
    if let Some(matcher) = matcher {
        payload.insert("matcher".into(), Value::String(matcher));
    }
    payload.insert(
        "hooks".into(),
        Value::Array(vec![normalize_installed_handler(location, platform)]),
    );
    Ok(version_for_toml(&Value::Object(payload)))
}

pub fn compute_hook_trust_hash(
    event_name: &str,
    command: &str,
    matcher: Option<&str>,
) -> Result<String, String> {
    let event_key =
        event_key(event_name).ok_or_else(|| format!("Unknown hook event: {event_name}"))?;
    compute_installed_hook_trust_hash(
        &InstalledCodexHookLocation {
            event_name: event_name.into(),
            event_key: event_key.into(),
            group_index: 0,
            handler_index: 0,
            matcher: matcher.map(|value| value.to_string()),
            handler: InstalledCodexCommandHandler {
                command: command.into(),
                command_windows: None,
                timeout: None,
                r#async: None,
                status_message: None,
                additional_context_limit: None,
            },
        },
        TrustPlatform::current(),
    )
}

pub fn installed_hook_state_key(
    hooks_json_abs_path: &str,
    location: &InstalledCodexHookLocation,
) -> String {
    format!(
        "{hooks_json_abs_path}:{}:{}:{}",
        location.event_key, location.group_index, location.handler_index
    )
}

pub fn hook_state_key(
    hooks_json_abs_path: &str,
    event_name: &str,
    group_index: usize,
    handler_index: usize,
) -> Result<String, String> {
    let event_key =
        event_key(event_name).ok_or_else(|| format!("Unknown hook event: {event_name}"))?;
    Ok(format!(
        "{hooks_json_abs_path}:{event_key}:{group_index}:{handler_index}"
    ))
}

pub fn verify_trust_hashes(opts: &TrustOpts) -> Result<VerifyResult, String> {
    let opts = normalize_trust_opts(opts)?;
    if !Path::new(&opts.config_path).exists() {
        return Ok(VerifyResult {
            valid: false,
            mismatches: vec!["config.toml missing".into()],
        });
    }
    let content = std::fs::read_to_string(&opts.config_path).map_err(|err| err.to_string())?;
    Ok(verify_trust_content(&content, &opts))
}

pub async fn write_trusted_hashes(opts: &TrustOpts) -> Result<bool, InvalidCodexConfigError> {
    let normalized =
        normalize_trust_opts(opts).map_err(|message| InvalidCodexConfigError { message })?;
    let snapshot = read_config_snapshot(&normalized.config_path)?;
    let Some(output) = plan_trusted_hashes(opts, snapshot.as_deref())? else {
        return Ok(false);
    };
    write_validated_config(&normalized.config_path, &output, snapshot.as_deref()).await?;
    Ok(true)
}

/// 只计算并验证最终 TOML，供配置与资源共同事务使用，不触碰磁盘。
pub(crate) fn plan_trusted_hashes(
    opts: &TrustOpts,
    snapshot: Option<&str>,
) -> Result<Option<String>, InvalidCodexConfigError> {
    let opts = normalize_trust_opts(opts).map_err(|message| InvalidCodexConfigError { message })?;
    let existing = snapshot.unwrap_or("");
    let initial = verify_trust_content(existing, &opts);
    let expected = expected_trust_state(&opts)?;
    let retired: HashSet<String> = opts.retired_keys.iter().cloned().collect();
    let mut exact: HashSet<String> = expected.keys().cloned().collect();
    exact.extend(retired.iter().cloned());
    let mut enabled_by_key = HashMap::new();
    for section in parse_trust_sections(existing) {
        let Some(enabled) = section.enabled else {
            continue;
        };
        if expected.get(&section.key) != section.hash.as_ref() {
            continue;
        }
        let next = if enabled_by_key.get(&section.key) == Some(&false) {
            false
        } else {
            enabled
        };
        enabled_by_key.insert(section.key, next);
    }

    let mut minimal = remove_marked_trust_sections(existing, &opts.marker, &exact)?;
    let removed_marked = minimal != existing;
    minimal = remove_legacy_trust_markers(&minimal, &opts.marker);
    minimal = remove_exact_trust_sections(&minimal, &retired)?;
    let mut minimal_state = None;
    let mut minimal_parses = false;
    if let Some(parsed) = parse_toml_value(&minimal) {
        minimal_state = hooks_state(&parsed);
        minimal_parses = true;
    }
    if minimal_parses {
        let remaining_owned = exact
            .iter()
            .any(|key| state_has(minimal_state.as_ref(), key));
        if initial.valid && (!removed_marked || !remaining_owned) {
            return Ok(None);
        }
        if let Some(missing) =
            missing_preservable(minimal_state.as_ref(), &expected, &retired, &enabled_by_key)
        {
            let output =
                append_canonical_trust_sections(&minimal, &opts.marker, &missing, &enabled_by_key);
            if output == existing {
                return Ok(None);
            }
            match validate_config(&output) {
                Ok(()) => return Ok(Some(output)),
                Err(err) if err.message.starts_with("Refusing to write invalid") => {}
                Err(err) => return Err(err),
            }
        }
    }

    let mut content = remove_legacy_trust_markers(existing, &opts.marker);
    content = remove_exact_trust_sections(&content, &exact)?;
    let mut missing = expected.clone();
    let mut parsed_remainder = false;
    if let Some(parsed) = parse_toml_value(&content) {
        let remaining = hooks_state(&parsed);
        let preservable =
            missing_preservable(remaining.as_ref(), &expected, &retired, &enabled_by_key);
        let Some(preservable) = preservable else {
            return Err(InvalidCodexConfigError {
                message: "Refusing to replace an uneditable Codex hook trust entry; original file left unchanged".into(),
            });
        };
        missing = preservable;
        parsed_remainder = true;
    }
    let output = append_canonical_trust_sections(&content, &opts.marker, &missing, &enabled_by_key);
    if output == existing {
        return Ok(None);
    }
    if let Err(err) = validate_config(&output) {
        if parsed_remainder && err.message.starts_with("Refusing to write invalid") {
            return Err(InvalidCodexConfigError {
                message: "Refusing to extend an uneditable Codex hook trust entry; original file left unchanged".into(),
            });
        }
        return Err(err);
    }
    Ok(Some(output))
}

pub async fn remove_trust_block(
    config_path: &str,
    marker: &str,
    owned_hook_state_keys: &[String],
) -> Result<bool, InvalidCodexConfigError> {
    let Some(before) = read_config_snapshot(config_path)? else {
        return Ok(false);
    };
    let Some(content) = plan_remove_trust(&before, marker, owned_hook_state_keys)? else {
        return Ok(false);
    };
    write_validated_config(config_path, &content, Some(&before)).await?;
    Ok(true)
}

pub(crate) fn plan_remove_trust(
    before: &str,
    marker: &str,
    owned_hook_state_keys: &[String],
) -> Result<Option<String>, InvalidCodexConfigError> {
    let owned: HashSet<String> = owned_hook_state_keys.iter().cloned().collect();
    let content =
        remove_exact_trust_sections(&remove_legacy_trust_markers(before, marker), &owned)?;
    if content == before {
        return Ok(None);
    }
    validate_config(&content)?;
    Ok(Some(content))
}

pub async fn remove_trust_state_keys(
    config_path: &str,
    owned_hook_state_keys: &[String],
) -> Result<bool, InvalidCodexConfigError> {
    if owned_hook_state_keys.is_empty() {
        return Ok(false);
    }
    let Some(before) = read_config_snapshot(config_path)? else {
        return Ok(false);
    };
    let content = match remove_exact_trust_sections(
        &before,
        &owned_hook_state_keys.iter().cloned().collect(),
    ) {
        Ok(content) => content,
        Err(err) if err.message.starts_with("Refusing to write invalid") => return Ok(false),
        Err(err) => return Err(err),
    };
    if content == before {
        return Ok(false);
    }
    match write_validated_config(config_path, &content, Some(&before)).await {
        Ok(()) => Ok(true),
        Err(err) if err.message.starts_with("Refusing to write invalid") => Ok(false),
        Err(err) => Err(err),
    }
}

fn normalize_installed_handler(
    location: &InstalledCodexHookLocation,
    platform: TrustPlatform,
) -> Value {
    let source = &location.handler;
    let command = if platform == TrustPlatform::Win32 {
        source
            .command_windows
            .clone()
            .unwrap_or_else(|| source.command.clone())
    } else {
        source.command.clone()
    };
    let mut normalized = Map::new();
    normalized.insert("type".into(), Value::String("command".into()));
    normalized.insert("command".into(), Value::String(command));
    normalized.insert(
        "timeout".into(),
        json_int(normalized_timeout(&location.event_name, source.timeout)),
    );
    normalized.insert("async".into(), Value::Bool(source.r#async.unwrap_or(false)));
    if let Some(status) = &source.status_message {
        normalized.insert("statusMessage".into(), Value::String(status.clone()));
    }
    if ADDITIONAL_CONTEXT_EVENTS.contains(&location.event_name.as_str()) {
        if let Some(limit) = source.additional_context_limit {
            if limit != DEFAULT_ADDITIONAL_CONTEXT_LIMIT {
                normalized.insert("additionalContextLimit".into(), json_int(limit));
            }
        }
    }
    Value::Object(normalized)
}

fn normalized_timeout(event_name: &str, configured: Option<f64>) -> f64 {
    if event_name == "SessionEnd" {
        return (configured.unwrap_or(1.0)).clamp(1.0, 3.0);
    }
    (configured.unwrap_or(600.0)).max(1.0)
}

fn json_int(value: f64) -> Value {
    if value.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&value) {
        Value::Number((value as i64).into())
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().cloned().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(child) = fields.get(&key) {
                    out.insert(key, canonical_json(child));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn version_for_toml(value: &Value) -> String {
    let serialized =
        serde_json::to_string(&canonical_json(value)).unwrap_or_else(|_| "null".into());
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

fn normalize_trust_opts(opts: &TrustOpts) -> Result<InstalledTrustOpts, String> {
    match opts {
        TrustOpts::Installed(opts) => Ok(opts.clone()),
        TrustOpts::Legacy(opts) => {
            let mut locations = HashMap::new();
            for event_name in &opts.hook_events {
                let event_key = event_key(event_name)
                    .ok_or_else(|| format!("Unknown hook event: {event_name}"))?;
                let command = opts
                    .event_to_command
                    .get(event_name)
                    .ok_or_else(|| format!("Missing eventToCommand[{event_name}]"))?;
                locations.insert(
                    event_name.clone(),
                    InstalledCodexHookLocation {
                        event_name: event_name.clone(),
                        event_key: event_key.into(),
                        group_index: opts
                            .event_to_group_index
                            .get(event_name)
                            .copied()
                            .unwrap_or(0),
                        handler_index: 0,
                        matcher: None,
                        handler: InstalledCodexCommandHandler {
                            command: command.clone(),
                            command_windows: None,
                            timeout: None,
                            r#async: None,
                            status_message: None,
                            additional_context_limit: None,
                        },
                    },
                );
            }
            Ok(InstalledTrustOpts {
                config_path: opts.config_path.clone(),
                hooks_json_abs_path: opts.hooks_json_abs_path.clone(),
                locations,
                retired_keys: opts.retired_keys.clone(),
                marker: opts.marker.clone(),
            })
        }
    }
}

fn expected_trust_state(
    opts: &InstalledTrustOpts,
) -> Result<HashMap<String, String>, InvalidCodexConfigError> {
    let mut expected = HashMap::new();
    for location in opts.locations.values() {
        let hash = compute_installed_hook_trust_hash(location, TrustPlatform::current())
            .map_err(|message| InvalidCodexConfigError { message })?;
        expected.insert(
            installed_hook_state_key(&opts.hooks_json_abs_path, location),
            hash,
        );
    }
    Ok(expected)
}

struct ConfigLine {
    text: String,
    editable: bool,
}

fn config_lines(content: &str) -> Vec<ConfigLine> {
    let mut quote = '\0';
    let mut multiline = false;
    let mut depth: i32 = 0;
    content
        .split('\n')
        .map(|text| {
            let editable = quote == '\0' && depth == 0;
            let chars: Vec<char> = text.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                let ch = chars[i];
                if quote != '\0' {
                    if quote == '"' && ch == '\\' {
                        i += 2;
                        continue;
                    }
                    if ch != quote {
                        i += 1;
                        continue;
                    }
                    if !multiline {
                        quote = '\0';
                        i += 1;
                        continue;
                    }
                    if i + 2 >= chars.len() || chars[i + 1] != quote || chars[i + 2] != quote {
                        i += 1;
                        continue;
                    }
                    while i + 1 < chars.len() && chars[i + 1] == quote {
                        i += 1;
                    }
                    quote = '\0';
                    multiline = false;
                } else if ch == '#' {
                    break;
                } else if ch == '"' || ch == '\'' {
                    quote = ch;
                    multiline = i + 2 < chars.len() && chars[i + 1] == ch && chars[i + 2] == ch;
                    if multiline {
                        i += 2;
                    }
                } else if ch == '[' || ch == '{' {
                    depth += 1;
                } else if ch == ']' || ch == '}' {
                    depth -= 1;
                }
                i += 1;
            }
            ConfigLine {
                text: text.to_string(),
                editable,
            }
        })
        .collect()
}

fn trust_section_key(header: &str) -> Option<String> {
    // `regex` cannot compile the TypeScript lookahead `/^\s*\[(?!\[)/`.
    // A table header is `[...]`; `[[...]]` is an array of tables.
    let trimmed = header.trim_start();
    if !trimmed.starts_with('[') || trimmed.starts_with("[[") {
        return None;
    }
    if let Ok(parsed) = toml::from_str::<toml::Value>(header) {
        let root = parsed.as_table()?;
        if root.len() != 1 {
            return None;
        }
        let hooks = root.get("hooks")?.as_table()?;
        if hooks.len() != 1 {
            return None;
        }
        let state = hooks.get("state")?.as_table()?;
        if state.len() != 1 {
            return None;
        }
        let (key, value) = state.iter().next()?;
        let table = value.as_table()?;
        if table.is_empty() {
            return Some(key.clone());
        }
        return None;
    }
    let legacy = regex::Regex::new(r#"^\s*\[hooks\.state\."([^"\r\n]+)"\]\s*$"#).ok()?;
    legacy
        .captures(header)
        .and_then(|caps| caps.get(1).map(|item| item.as_str().to_string()))
}

struct TrustRange {
    key: String,
    start: usize,
    end: usize,
}

fn trust_section_ranges(content: &str) -> Vec<TrustRange> {
    let lines = config_lines(content);
    let mut sections: Vec<TrustRange> = Vec::new();
    let mut current: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        if !line.editable || !line.text.trim_start().starts_with('[') {
            continue;
        }
        if let Some(slot) = current {
            sections[slot].end = index;
        }
        current = None;
        if let Some(key) = trust_section_key(&line.text) {
            sections.push(TrustRange {
                key,
                start: index,
                end: lines.len(),
            });
            current = Some(sections.len() - 1);
        }
    }
    sections
}

struct ParsedTrustSection {
    key: String,
    hash: Option<String>,
    enabled: Option<bool>,
}

fn parse_trust_sections(content: &str) -> Vec<ParsedTrustSection> {
    let lines: Vec<&str> = content.split('\n').collect();
    trust_section_ranges(content)
        .into_iter()
        .map(|range| {
            let body = lines[range.start + 1..range.end].join("\n");
            match parse_toml_value(&body) {
                Some(parsed) => {
                    let table = parsed.as_table();
                    ParsedTrustSection {
                        key: range.key,
                        hash: table
                            .and_then(|table| table.get("trusted_hash"))
                            .and_then(|value| value.as_str().map(|text| text.to_string())),
                        enabled: table
                            .and_then(|table| table.get("enabled"))
                            .and_then(|value| value.as_bool()),
                    }
                }
                None => ParsedTrustSection {
                    key: range.key,
                    hash: None,
                    enabled: None,
                },
            }
        })
        .collect()
}

fn parse_toml_value(content: &str) -> Option<toml::Value> {
    if content.trim().is_empty() {
        return Some(toml::Value::Table(toml::map::Map::new()));
    }
    toml::from_str(content).ok()
}

fn hooks_state(parsed: &toml::Value) -> Option<toml::value::Table> {
    parsed
        .as_table()
        .and_then(|root| root.get("hooks"))
        .and_then(|hooks| hooks.as_table())
        .and_then(|hooks| hooks.get("state"))
        .and_then(|state| state.as_table())
        .cloned()
}

fn state_has(state: Option<&toml::map::Map<String, toml::Value>>, key: &str) -> bool {
    state.is_some_and(|state| state.contains_key(key))
}

fn validate_config(content: &str) -> Result<(), InvalidCodexConfigError> {
    if parse_toml_value(content).is_none() {
        return Err(InvalidCodexConfigError {
            message: "Refusing to write invalid Codex config.toml; original file left unchanged"
                .into(),
        });
    }
    Ok(())
}

pub(crate) fn read_config_snapshot(
    config_path: &str,
) -> Result<Option<String>, InvalidCodexConfigError> {
    let read = || -> Result<Option<String>, std::io::Error> {
        match std::fs::symlink_metadata(config_path) {
            Ok(_) => {
                let metadata =
                    crate::utils::runtime_paths::runtime_metadata(Path::new(config_path))
                        .map_err(std::io::Error::other)?;
                if !metadata.is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Codex 配置不是普通文件",
                    ));
                }
                std::fs::read_to_string(config_path).map(Some)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    };
    read().map_err(|err| InvalidCodexConfigError {
        message: err.to_string(),
    })
}

async fn write_validated_config(
    config_path: &str,
    content: &str,
    before: Option<&str>,
) -> Result<(), InvalidCodexConfigError> {
    use crate::utils::{write_text_file_atomic, AtomicTextWriteOptions, ExpectedFileState};
    validate_config(content)?;
    // 写入前再次拒绝链接和特殊文件；预期快照防止覆盖其他进程的新配置。
    read_config_snapshot(config_path)?;
    write_text_file_atomic(
        config_path,
        content,
        &AtomicTextWriteOptions {
            expected: Some(match before {
                Some(raw) => ExpectedFileState::Present(raw.into()),
                None => ExpectedFileState::Missing,
            }),
            ..AtomicTextWriteOptions::default()
        },
    )
    .await
    .map_err(|err| InvalidCodexConfigError {
        message: err.to_string(),
    })
}

fn remove_exact_trust_sections(
    content: &str,
    keys: &HashSet<String>,
) -> Result<String, InvalidCodexConfigError> {
    if keys.is_empty() {
        return Ok(content.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let mut keep = vec![true; lines.len()];
    for range in trust_section_ranges(content) {
        if !keys.contains(&range.key) {
            continue;
        }
        validate_config(&lines[range.start + 1..range.end].join("\n"))?;
        for slot in &mut keep[range.start..range.end] {
            *slot = false;
        }
    }
    Ok(lines
        .iter()
        .enumerate()
        .filter(|(index, _)| keep[*index])
        .map(|(_, line)| *line)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn marker_line_membership(content: &str, marker: &str) -> Vec<bool> {
    let begin = format!("# BEGIN {marker} trust");
    let end = format!("# END {marker} trust");
    let mut inside = false;
    config_lines(content)
        .into_iter()
        .map(|line| {
            let trimmed = line.text.trim();
            if line.editable && trimmed == begin {
                inside = true;
                return false;
            }
            if line.editable && trimmed == end {
                inside = false;
                return false;
            }
            inside
        })
        .collect()
}

fn remove_marked_trust_sections(
    content: &str,
    marker: &str,
    keys: &HashSet<String>,
) -> Result<String, InvalidCodexConfigError> {
    if keys.is_empty() {
        return Ok(content.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let in_marker = marker_line_membership(content, marker);
    let mut keep = vec![true; lines.len()];
    for range in trust_section_ranges(content) {
        if !in_marker.get(range.start).copied().unwrap_or(false) || !keys.contains(&range.key) {
            continue;
        }
        validate_config(&lines[range.start + 1..range.end].join("\n"))?;
        for slot in &mut keep[range.start..range.end] {
            *slot = false;
        }
    }
    Ok(lines
        .iter()
        .enumerate()
        .filter(|(index, _)| keep[*index])
        .map(|(_, line)| *line)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn remove_legacy_trust_markers(content: &str, marker: &str) -> String {
    let begin = format!("# BEGIN {marker} trust");
    let end = format!("# END {marker} trust");
    let bypass = regex::Regex::new(r"^\s*bypass_hook_trust\s*=").unwrap();
    config_lines(content)
        .into_iter()
        .filter(|line| {
            !line.editable
                || (line.text.trim() != begin
                    && line.text.trim() != end
                    && !bypass.is_match(&line.text))
        })
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn encode_toml_basic_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn append_canonical_trust_sections(
    content: &str,
    marker: &str,
    entries: &HashMap<String, String>,
    enabled_by_key: &HashMap<String, bool>,
) -> String {
    if entries.is_empty() {
        return content.to_string();
    }
    let mut keys: Vec<_> = entries.keys().cloned().collect();
    keys.sort();
    let mut lines = vec![format!("# BEGIN {marker} trust")];
    for key in keys {
        let hash = &entries[&key];
        lines.push(format!("[hooks.state.{}]", encode_toml_basic_string(&key)));
        if let Some(enabled) = enabled_by_key.get(&key) {
            lines.push(format!("enabled = {enabled}"));
        }
        lines.push(format!("trusted_hash = \"{hash}\""));
        lines.push(String::new());
    }
    lines.push(format!("# END {marker} trust"));
    let separator = if content.is_empty() || content.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    format!("{content}{separator}\n{}\n", lines.join("\n"))
}

pub(crate) fn verify_trust_content(content: &str, opts: &InstalledTrustOpts) -> VerifyResult {
    let mut mismatches = Vec::new();
    let state = match parse_toml_value(content) {
        Some(parsed) => hooks_state(&parsed),
        None => {
            return VerifyResult {
                valid: false,
                mismatches: vec!["invalid Codex config.toml".into()],
            };
        }
    };
    if config_lines(content).iter().any(|line| {
        line.editable
            && regex::Regex::new(r"^\s*bypass_hook_trust\s*=")
                .unwrap()
                .is_match(&line.text)
    }) {
        mismatches.push("unsupported config field bypass_hook_trust".into());
    }
    let expected = match expected_trust_state(opts) {
        Ok(expected) => expected,
        Err(err) => {
            return VerifyResult {
                valid: false,
                mismatches: vec![err.message],
            }
        }
    };
    for (key, hash) in &expected {
        let current = state
            .as_ref()
            .and_then(|table| table.get(key))
            .and_then(|value| value.as_table())
            .and_then(|table| table.get("trusted_hash"))
            .and_then(|value| value.as_str());
        match current {
            None => mismatches.push(format!("missing key={key}")),
            Some(current) if current != hash => mismatches.push(format!(
                "hash mismatch key={key} (expected={hash}, got={current})"
            )),
            _ => {}
        }
    }
    for key in &opts.retired_keys {
        if state_has(state.as_ref(), key) {
            mismatches.push(format!("retired key still present={key}"));
        }
    }
    VerifyResult {
        valid: mismatches.is_empty(),
        mismatches,
    }
}

fn missing_preservable(
    state: Option<&toml::map::Map<String, toml::Value>>,
    expected: &HashMap<String, String>,
    retired: &HashSet<String>,
    enabled_by_key: &HashMap<String, bool>,
) -> Option<HashMap<String, String>> {
    for key in retired {
        if state_has(state, key) {
            return None;
        }
    }
    let mut missing = HashMap::new();
    for (key, hash) in expected {
        let Some(raw) = state.and_then(|table| table.get(key)) else {
            missing.insert(key.clone(), hash.clone());
            continue;
        };
        let remaining = raw.as_table()?;
        if remaining
            .get("trusted_hash")
            .and_then(|value| value.as_str())
            != Some(hash.as_str())
        {
            return None;
        }
        if enabled_by_key.get(key) == Some(&false)
            && remaining.get("enabled").and_then(|value| value.as_bool()) != Some(false)
        {
            return None;
        }
    }
    Some(missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(config_path: &str, events: &[&str], commands: &[(&str, &str)]) -> TrustOpts {
        TrustOpts::Legacy(LegacyTrustOpts {
            config_path: config_path.into(),
            hooks_json_abs_path: "/abs/hooks.json".into(),
            hook_events: events.iter().map(|event| (*event).to_string()).collect(),
            event_to_command: commands
                .iter()
                .map(|(event, command)| ((*event).to_string(), (*command).to_string()))
                .collect(),
            event_to_group_index: events
                .iter()
                .map(|event| ((*event).to_string(), 0))
                .collect(),
            retired_keys: vec![],
            marker: "otel-codex-hook".into(),
        })
    }

    #[test]
    fn hash_is_deterministic_and_matches_codex_vectors() {
        let a = compute_hook_trust_hash("SessionStart", "bash /a session-start", None).unwrap();
        let b = compute_hook_trust_hash("SessionStart", "bash /a session-start", None).unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:") && a.len() == "sha256:".len() + 64);
        assert!(a["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert_ne!(
            a,
            compute_hook_trust_hash("SessionStart", "bash /b session-start", None).unwrap()
        );
        assert_eq!(
            hook_state_key("/abs/hooks.json", "SessionStart", 0, 0).unwrap(),
            "/abs/hooks.json:session_start:0:0"
        );
        assert!(compute_hook_trust_hash("Unknown", "cmd", None)
            .unwrap_err()
            .contains("Unknown hook event"));
        let command = "/Users/yunshen/.loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.sh";
        assert_eq!(
            compute_hook_trust_hash(
                "SessionStart",
                &format!("{command} session-start"),
                Some("*")
            )
            .unwrap(),
            "sha256:474a9671344eabd67eeda6fc6dc5c152e22ee474e067ff28885da1230e334512"
        );
        assert_eq!(
            compute_hook_trust_hash(
                "SubagentStart",
                &format!("{command} subagent-start"),
                Some("*")
            )
            .unwrap(),
            "sha256:b35e26cd3fd1c65960cbb8a5b62720743729d447b720a62f4a78bf2bf19edcde"
        );
        assert_eq!(
            compute_hook_trust_hash(
                "SubagentStop",
                &format!("{command} subagent-stop"),
                Some("*")
            )
            .unwrap(),
            "sha256:d7d2dee53aeaca1819c85d2781ef97e6056768187eef9186a1eef8dc3e0dbc91"
        );
        assert_eq!(
            compute_hook_trust_hash("UserPromptSubmit", "cmd", Some("*")).unwrap(),
            compute_hook_trust_hash("UserPromptSubmit", "cmd", None).unwrap()
        );
        assert_eq!(
            compute_hook_trust_hash("Stop", "cmd", Some("*")).unwrap(),
            compute_hook_trust_hash("Stop", "cmd", None).unwrap()
        );
        let hashes = [
            compute_hook_trust_hash("SessionStart", "cmd", None).unwrap(),
            compute_hook_trust_hash("SessionStart", "cmd", Some("")).unwrap(),
            compute_hook_trust_hash("SessionStart", "cmd", Some("*")).unwrap(),
        ];
        assert_eq!(
            hashes
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
    }

    #[test]
    fn normalizes_installed_handler_fields() {
        let base = InstalledCodexHookLocation {
            event_name: "SessionStart".into(),
            event_key: "session_start".into(),
            group_index: 2,
            handler_index: 3,
            matcher: Some("*".into()),
            handler: InstalledCodexCommandHandler {
                command: "unix-command".into(),
                command_windows: Some("windows-command".into()),
                timeout: Some(0.0),
                r#async: Some(true),
                status_message: Some("running".into()),
                additional_context_limit: Some(4096.0),
            },
        };
        assert_eq!(
            installed_hook_state_key("/abs/hooks.json", &base),
            "/abs/hooks.json:session_start:2:3"
        );
        assert_ne!(
            compute_installed_hook_trust_hash(&base, TrustPlatform::Linux).unwrap(),
            compute_installed_hook_trust_hash(&base, TrustPlatform::Win32).unwrap()
        );
        let mut without_status = base.clone();
        without_status.handler.status_message = None;
        assert_ne!(
            compute_installed_hook_trust_hash(&base, TrustPlatform::Linux).unwrap(),
            compute_installed_hook_trust_hash(&without_status, TrustPlatform::Linux).unwrap()
        );
        let mut default_limit = base.clone();
        default_limit.handler.additional_context_limit = Some(2500.0);
        let mut omitted = base.clone();
        omitted.handler.additional_context_limit = None;
        assert_eq!(
            compute_installed_hook_trust_hash(&default_limit, TrustPlatform::Linux).unwrap(),
            compute_installed_hook_trust_hash(&omitted, TrustPlatform::Linux).unwrap()
        );
    }

    #[tokio::test]
    async fn write_then_verify_and_escape_windows_keys() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let config_path = config.to_string_lossy().into_owned();
        let events = [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
        ];
        let entry = "/abs/hook.sh";
        let commands = [
            ("SessionStart", format!("{entry} session-start")),
            ("UserPromptSubmit", format!("{entry} user-prompt-submit")),
            ("PreToolUse", format!("{entry} pre-tool-use")),
            ("PostToolUse", format!("{entry} post-tool-use")),
            ("Stop", format!("{entry} stop")),
        ];
        let command_refs: Vec<(&str, &str)> = commands
            .iter()
            .map(|(event, command)| (*event, command.as_str()))
            .collect();
        let opts = legacy(&config_path, &events, &command_refs);
        assert!(write_trusted_hashes(&opts).await.unwrap());
        let result = verify_trust_hashes(&opts).unwrap();
        assert!(result.valid, "{:?}", result.mismatches);
        let content = std::fs::read_to_string(&config).unwrap();
        assert_eq!(content.matches("[hooks.state.\"").count(), 5);
        assert_eq!(content.matches("# BEGIN otel-codex-hook trust").count(), 1);
        assert_eq!(content.matches("# END otel-codex-hook trust").count(), 1);
        assert!(!write_trusted_hashes(&opts).await.unwrap());

        let windows = TrustOpts::Legacy(LegacyTrustOpts {
            config_path: config_path.clone(),
            hooks_json_abs_path: r"C:\Users\测试 User\.codex\hooks.json".into(),
            hook_events: vec!["Stop".into()],
            event_to_command: HashMap::from([(
                "Stop".into(),
                r#"powershell.exe -File "C:\Users\测试 User\.loongsuite-pilot\hooks\codex-hook.ps1" stop"#.into(),
            )]),
            event_to_group_index: HashMap::from([("Stop".into(), 0)]),
            retired_keys: vec![],
            marker: "otel-codex-hook".into(),
        });
        // Start from an empty file so the previous block does not remain.
        std::fs::write(&config, "").unwrap();
        assert!(write_trusted_hashes(&windows).await.unwrap());
        let content = std::fs::read_to_string(&config).unwrap();
        assert!(content
            .contains(r#"[hooks.state."C:\\Users\\测试 User\\.codex\\hooks.json:stop:0:0"]"#));
        assert!(
            !content
                .contains("[hooks.state.\"C:\\Users\\测试 User\\.codex\\hooks.json:stop:0:0\"]")
                || content.contains("\\\\")
        );
        let verified = verify_trust_hashes(&windows).unwrap();
        assert!(verified.valid, "{:?}", verified.mismatches);
        assert!(!write_trusted_hashes(&windows).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(&config)
                .unwrap()
                .matches("[hooks.state.")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn atomic_trust_write_preserves_private_mode_and_rejects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        let path = file.to_str().unwrap();
        let original = "# 用户注释\nmodel = 'user'\n";
        std::fs::write(&file, original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let opts = legacy(path, &["Stop"], &[("Stop", "/abs/hook.sh stop")]);
        assert!(write_trusted_hashes(&opts).await.unwrap());
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.starts_with(original));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        for before in [None, Some(original)] {
            assert!(
                write_validated_config(path, "model = 'overwrite'\n", before)
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), after);
        }
        assert!(write_validated_config(path, "broken [", Some(&after))
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), after);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        std::fs::write(&file, "model = [").unwrap();
        assert!(write_trusted_hashes(&opts).await.is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "model = [");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_trust_config_is_neither_written_nor_removed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("user.toml");
        let link = dir.path().join("config.toml");
        std::fs::write(&target, "model = 'private'\n").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let opts = legacy(
            link.to_str().unwrap(),
            &["Stop"],
            &[("Stop", "/abs/hook.sh stop")],
        );
        assert!(write_trusted_hashes(&opts).await.is_err());
        assert!(
            remove_trust_block(link.to_str().unwrap(), "otel-codex-hook", &["key".into()])
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "model = 'private'\n"
        );
        assert!(std::fs::symlink_metadata(link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[tokio::test]
    async fn removes_only_owned_keys() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let config_path = config.to_string_lossy().into_owned();
        let opts = legacy(&config_path, &["Stop"], &[("Stop", "/abs/hook.sh stop")]);
        write_trusted_hashes(&opts).await.unwrap();
        let key = hook_state_key("/abs/hooks.json", "Stop", 0, 0).unwrap();
        assert!(remove_trust_block(&config_path, "otel-codex-hook", &[key])
            .await
            .unwrap());
        let content = std::fs::read_to_string(&config).unwrap();
        assert!(!content.contains("trusted_hash"));
        assert!(!content.contains("# BEGIN otel-codex-hook trust"));
    }
}

#[cfg(test)]
#[path = "codex_trust_writer_contract_tests.rs"]
mod migration_contract_tests;
