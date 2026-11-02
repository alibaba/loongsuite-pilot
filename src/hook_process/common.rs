//! Shared native Hook-process helpers.
//! Payload decoding preserves UTF-8/BOM and repairs Windows host ANSI
//! double-encoding in the native process, including partial byte loss.

use crate::inputs::base::{validate_excluded_workspaces, WorkspacePolicy};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub type Obj = Map<String, Value>;
pub type Env = HashMap<String, String>;

pub struct HookRequest<'a> {
    pub args: &'a [String],
    pub stdin: &'a [u8],
    pub env: &'a Env,
    pub stdout: &'a mut dyn Write,
}

pub fn write_line(stdout: &mut dyn Write, line: &str) {
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

pub fn write_empty(stdout: &mut dyn Write) {
    write_line(stdout, "{}");
}

pub fn write_json(stdout: &mut dyn Write, value: &Value) {
    match serde_json::to_string(value) {
        Ok(text) => write_line(stdout, &text),
        Err(_) => write_empty(stdout),
    }
}

pub fn env_get<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

pub fn data_dir(env: &Env) -> PathBuf {
    if let Some(configured) = env_get(env, "LOONGSUITE_PILOT_DATA_DIR") {
        return PathBuf::from(configured);
    }
    home_dir(env).join(".loongsuite-pilot")
}

pub fn home_dir(env: &Env) -> PathBuf {
    if let Some(home) = env_get(env, "HOME").or_else(|| env_get(env, "USERPROFILE")) {
        return PathBuf::from(home);
    }
    crate::inputs::base::home_dir()
}

pub fn decode_payload(buf: &[u8]) -> String {
    super::payload_decoder::decode_for_platform(buf, cfg!(windows))
}

pub fn parse_json_object(bytes: &[u8]) -> Result<Obj, String> {
    let text = decode_payload(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Obj::new());
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Obj::new()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn local_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn utc_date() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

pub fn local_stamp_seconds() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub fn random_hex(bytes: usize) -> String {
    let mut out = String::new();
    while out.len() < bytes * 2 {
        out.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    out.truncate(bytes * 2);
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn sha256_text_prefix(text: &str, len: usize) -> String {
    let digest = sha256_hex(text.as_bytes());
    digest.chars().take(len).collect()
}

pub fn iso_to_unix_nanos(iso: &str) -> String {
    if iso.is_empty() {
        return "0".into();
    }
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|parsed| format!("{}000000", parsed.timestamp_millis()))
        .unwrap_or_else(|_| "0".into())
}

pub fn now_unix_nanos() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{ms}000000")
}

pub fn sanitize_session_id(session_id: &str) -> String {
    let base = Path::new(session_id)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(session_id);
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

pub fn safe_path_part(value: &str) -> String {
    let base = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value);
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

pub fn log_hook_error(
    env: &Env,
    agent_id: &str,
    stage: &str,
    error_type: &str,
    error_message: &str,
) {
    let dir = data_dir(env).join("logs").join(agent_id).join("errors");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join(format!("{agent_id}-error-{}.jsonl", utc_date()));
    let record = serde_json::json!({
        "time": iso_now(),
        "gen_ai.agent.type": agent_id,
        "stage": if stage.is_empty() { "unknown" } else { stage },
        "error.type": if error_type.is_empty() { "_OTHER" } else { error_type },
        "error.message": error_message,
    });
    let line = match serde_json::to_string(&record) {
        Ok(text) => format!("{text}\n"),
        Err(_) => return,
    };
    let _ = with_file_lock(&file.with_extension("jsonl.lock"), 15_000, 10_000, || {
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .and_then(|mut handle| handle.write_all(line.as_bytes()));
    });
}

pub use crate::utils::sync_file_lock::with_file_lock;

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub user_id: String,
    pub upstream_enabled: bool,
    pub propagate_to_tools: bool,
    pub generate_trace_when_missing: bool,
}

pub fn load_runtime_config(env: &Env) -> RuntimeConfig {
    let root = data_dir(env);
    let config_path = env_get(env, "AGENT_DATA_COLLECTION_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config.json"));
    let file = read_json_file(&config_path).unwrap_or_default();
    let upstream = file.get("upstreamLink").and_then(Value::as_object);
    let user_id = env_get(env, "LOONGSUITE_PILOT_USER_ID")
        .map(str::to_owned)
        .or_else(|| string_field(&file, "userId"))
        .or_else(|| string_field(&file, "user.id"))
        .unwrap_or_else(hostname);
    RuntimeConfig {
        user_id,
        upstream_enabled: env_bool(
            env,
            "LOONGSUITE_PILOT_UPSTREAM_LINK",
            upstream
                .and_then(|map| map.get("enabled"))
                .and_then(Value::as_bool)
                == Some(true),
        ),
        propagate_to_tools: env_bool(
            env,
            "LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS",
            upstream
                .and_then(|map| map.get("propagateToTools"))
                .and_then(Value::as_bool)
                == Some(true),
        ),
        generate_trace_when_missing: env_bool(
            env,
            "LOONGSUITE_PILOT_UPSTREAM_LINK_GENERATE_TRACE_WHEN_MISSING",
            upstream
                .and_then(|map| map.get("generateTraceWhenMissing"))
                .and_then(Value::as_bool)
                == Some(true),
        ),
    }
}

fn env_bool(env: &Env, name: &str, fallback: bool) -> bool {
    match env.get(name).map(String::as_str) {
        None | Some("") => fallback,
        Some(raw) => raw == "1" || raw.eq_ignore_ascii_case("true"),
    }
}

fn read_json_file(path: &Path) -> Option<Obj> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

pub fn string_field(map: &Obj, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn collect_resource_attributes(env: &Env, agent_id: &str) -> Obj {
    let mut fields = Obj::new();
    for (env_name, field_name) in [
        ("AGENTTEAMS_WORKER_NAME", "agentteams.worker.name"),
        ("AGENTTEAMS_INSTANCE_ID", "agentteams.instance.id"),
    ] {
        if sensitive_name(env_name) || sensitive_name(field_name) {
            warn_skip(agent_id, env_name, "sensitive field name");
            continue;
        }
        let Some(raw) = env.get(env_name) else {
            continue;
        };
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        if value.len() > 512 {
            warn_skip(agent_id, env_name, "value too long");
            continue;
        }
        fields.insert(field_name.to_string(), Value::String(value.to_string()));
    }
    fields
}

pub fn parse_span_attributes(env: &Env, agent_id: &str, allow_invocation_identity: bool) -> Obj {
    let mut out = Obj::new();
    let Some(raw) = env.get("LOONGSUITE_PILOT_SPAN_ATTRIBUTES") else {
        return out;
    };
    if raw.is_empty() {
        return out;
    }
    for pair in raw.split(',') {
        let Some(idx) = pair.find('=') else { continue };
        if idx == 0 {
            continue;
        }
        let key = pair[..idx].trim();
        let value = pair[idx + 1..].trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        if allow_invocation_identity {
            if let Some(mapped) = invocation_field(key) {
                if value.len() > 512 {
                    warn_skip(agent_id, key, "value too long");
                } else {
                    out.insert(mapped.to_string(), Value::String(value.to_string()));
                }
                continue;
            }
        }
        if reserved_span_key(key) {
            warn_skip(agent_id, key, "reserved prefix");
            continue;
        }
        if sensitive_name(key) {
            warn_skip(agent_id, key, "sensitive field name");
            continue;
        }
        if value.len() > 512 {
            warn_skip(agent_id, key, "value too long");
            continue;
        }
        out.insert(key.to_string(), Value::String(value.to_string()));
    }
    out
}

pub fn agent_name_patch(resource_attributes: &Obj) -> Option<String> {
    resource_attributes
        .get("agentteams.worker.name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn invocation_field(key: &str) -> Option<&'static str> {
    match key {
        "gen_ai.session.id" => Some("agent.pilot.invocation.session.id"),
        "gen_ai.user.id" => Some("agent.pilot.invocation.user.id"),
        _ => None,
    }
}

fn reserved_span_key(key: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "gen_ai.",
        "git.",
        "workspace.",
        "event.",
        "trace_",
        "user.",
        "cost_",
        "agent.",
        "time_unix_nano",
        "observed_time_unix_nano",
    ];
    PREFIXES
        .iter()
        .any(|prefix| key == *prefix || key.starts_with(prefix))
}

fn sensitive_name(name: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$").expect("sensitive field pattern")
    });
    pattern.is_match(name)
}

fn warn_skip(agent_id: &str, name: &str, reason: &str) {
    let _ = writeln!(
        io::stderr(),
        "[{agent_id}] skip resource marker {name}: {reason}"
    );
}

pub fn record_upstream_context_once(env: &Env, agent_id: &str, session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    let Some(traceparent) = env_get(env, "TRACEPARENT") else {
        return;
    };
    if !valid_traceparent(traceparent) {
        return;
    }
    let dir = data_dir(env).join("acp-correlate");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let base = safe_path_part(session_id);
    let lock = dir.join(format!("{base}.env.lock"));
    match OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(file) => drop(file),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => return,
        Err(err) => {
            let _ = writeln!(io::stderr(), "[{agent_id}] upstream_correlate skip: {err}");
            return;
        }
    }
    let record = serde_json::json!({
        "type": "session",
        "sessionId": session_id,
        "traceparent": traceparent.trim(),
        "ts": iso_now(),
    });
    if let Ok(text) = serde_json::to_string(&record) {
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{base}.jsonl")))
            .and_then(|mut file| writeln!(file, "{text}"));
    }
}

pub fn valid_traceparent(value: &str) -> bool {
    parse_traceparent(value).is_some()
}

pub struct TraceParent {
    pub trace_id: String,
    pub parent_span_id: String,
    pub flags: String,
}

pub fn parse_traceparent(value: &str) -> Option<TraceParent> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
            .expect("traceparent")
    });
    let captures = pattern.captures(value.trim())?;
    let trace_id = captures.get(1)?.as_str().to_ascii_lowercase();
    let parent_span_id = captures.get(2)?.as_str().to_ascii_lowercase();
    let flags = captures.get(3)?.as_str().to_ascii_lowercase();
    if trace_id.chars().all(|ch| ch == '0') || parent_span_id.chars().all(|ch| ch == '0') {
        return None;
    }
    Some(TraceParent {
        trace_id,
        parent_span_id,
        flags,
    })
}

pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

pub fn filter_workspace_records(
    env: &Env,
    records: &[Obj],
    agent_id: &str,
) -> Result<Vec<Obj>, String> {
    let root = data_dir(env);
    let config_path = env_get(env, "AGENT_DATA_COLLECTION_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config.json"));
    let text = match fs::read_to_string(&config_path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(records.to_vec()),
        Err(_) => return Err("Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor".into()),
    };
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Ok(records.to_vec());
    }
    let config: Value = serde_json::from_str(text).map_err(|_| {
        "Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor".to_string()
    })?;
    let Value::Object(config) = config else {
        return Err("Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor".into());
    };
    let excluded = config
        .get("privacy")
        .and_then(|privacy| privacy.get("excludeWorkspaces"));
    let roots = validate_excluded_workspaces(excluded).map_err(|_| {
        "Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor".to_string()
    })?;
    if roots.is_empty() {
        return Ok(records.to_vec());
    }
    let state_dir = root.join("state").join("workspace-exclusions");
    let mut policy = WorkspacePolicy::new(roots, Some(state_dir));
    Ok(policy.filter_maps(records, agent_id))
}

pub fn write_jsonl_records(
    env: &Env,
    log_dir: &Path,
    agent_id: &str,
    records: &[Obj],
) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let records = filter_workspace_records(env, records, agent_id)?;
    if records.is_empty() {
        return Ok(());
    }
    let path = log_dir.join(format!("{agent_id}-{}.jsonl", local_date()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut body = String::new();
    for record in records {
        body.push_str(
            &serde_json::to_string(&Value::Object(record)).map_err(|err| err.to_string())?,
        );
        body.push('\n');
    }
    with_file_lock(&path.with_extension("jsonl.lock"), 15_000, 10_000, || {
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(body.as_bytes()));
    });
    Ok(())
}

pub fn append_history_rows(env: &Env, agent_id: &str, log_prefix: &str, rows: &[String]) -> bool {
    if rows.is_empty() {
        return true;
    }
    let path = data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("history")
        .join(format!("{log_prefix}-{}.jsonl", local_date()));
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let mut body = rows.join("\n");
    body.push('\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .is_ok()
}

pub fn write_atomic_json(directory: &Path, file_name: &str, payload: &Value) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|err| err.to_string())?;
    let marker = directory.join(file_name);
    let temporary = directory.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        random_hex(8)
    ));
    fs::write(
        &temporary,
        serde_json::to_vec(payload).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    if let Err(err) = fs::rename(&temporary, &marker) {
        let retry = err
            .raw_os_error()
            .is_some_and(|code| code == 17 || code == 1);
        if retry {
            let _ = fs::remove_file(&marker);
            if fs::rename(&temporary, &marker).is_ok() {
                return Ok(());
            }
        }
        let _ = fs::remove_file(&temporary);
        return Err(err.to_string());
    }
    Ok(())
}

pub fn resolve_path(env: &Env, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| home_dir(env))
            .join(path)
    };
    normalize_lexical(&absolute)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn finite_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        _ => None,
    }
}

pub fn json_number(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

pub fn put_str(map: &mut Obj, key: &str, value: impl AsRef<str>) {
    let value = value.as_ref();
    if !value.is_empty() {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

pub fn sanitize_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(items) => {
            let list: Vec<Value> = items.iter().filter_map(sanitize_value).collect();
            if list.is_empty() {
                None
            } else {
                Some(Value::Array(list))
            }
        }
        Value::Object(map) => {
            let mut out = Obj::new();
            for (key, item) in map {
                if let Some(cleaned) = sanitize_value(item) {
                    out.insert(key.clone(), cleaned);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(Value::Object(out))
            }
        }
        other => Some(other.clone()),
    }
}

pub fn sanitize_record(record: Obj) -> Obj {
    match sanitize_value(&Value::Object(record.clone())) {
        Some(Value::Object(cleaned)) => cleaned,
        _ => record,
    }
}

#[cfg(test)]
#[path = "upstream_context_history_tests.rs"]
mod upstream_context_history_tests;
