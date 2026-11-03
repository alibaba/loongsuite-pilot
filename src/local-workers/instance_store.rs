//! Port of `src/local-workers/instance-store.ts`.

use super::private_directory::prepare_private_local_worker_directory;
use crate::utils::{ensure_dir, is_process_alive, read_json_file, resolve_home, write_json_file};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOCAL_WORKER_HEARTBEAT_STALE_MS: u128 = 120_000;
const SCHEMA: &str = "loongsuite.localWorker.v1";
const TOKEN_REF: &str = "credentials/bootstrap-token";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeOptionValue {
    Bool(bool),
    Text(String),
}

pub type RuntimeOptions = IndexMap<String, RuntimeOptionValue>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkerInstance {
    pub schema_version: String,
    pub id: String,
    pub runtime: String,
    pub work_dir: String,
    pub bootstrap_token_ref: String,
    pub runtime_options: RuntimeOptions,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalWorkerView {
    pub id: String,
    pub runtime: String,
    pub work_dir: String,
    pub enabled: bool,
    pub state: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub pid: Option<u32>,
    pub worker_name: Option<String>,
    pub team_name: Option<String>,
    pub matrix: Option<String>,
    pub room_id: Option<String>,
    pub heartbeat: Option<String>,
    pub updated_at: String,
    pub log_path: String,
}

pub struct ConnectLocalWorkerOptions<'a> {
    pub data_dir: &'a str,
    pub runtime: &'a str,
    pub bootstrap_token: &'a str,
    pub work_dir: Option<&'a str>,
    pub runtime_options: Option<RuntimeOptions>,
}

pub struct ReconnectLocalWorkerOptions<'a> {
    pub data_dir: &'a str,
    pub instance_id: &'a str,
    pub bootstrap_token: Option<&'a str>,
    pub work_dir: Option<&'a str>,
    pub runtime_options: Option<RuntimeOptions>,
}

pub fn local_worker_root(data_dir: &str) -> String {
    Path::new(&resolve_home(data_dir))
        .join("local-workers")
        .to_string_lossy()
        .into_owned()
}

pub fn instance_dir(data_dir: &str, instance_id: &str) -> String {
    Path::new(&local_worker_root(data_dir))
        .join(instance_id)
        .to_string_lossy()
        .into_owned()
}

pub fn instance_config_path(data_dir: &str, instance_id: &str) -> String {
    Path::new(&instance_dir(data_dir, instance_id))
        .join("instance.json")
        .to_string_lossy()
        .into_owned()
}

pub fn bootstrap_token_path(data_dir: &str, instance: &LocalWorkerInstance) -> String {
    Path::new(&instance_dir(data_dir, &instance.id))
        .join(&instance.bootstrap_token_ref)
        .to_string_lossy()
        .into_owned()
}

pub fn state_dir(data_dir: &str, instance_id: &str) -> String {
    Path::new(&instance_dir(data_dir, instance_id))
        .join("state")
        .to_string_lossy()
        .into_owned()
}

pub fn log_dir(data_dir: &str, instance_id: &str) -> String {
    Path::new(&instance_dir(data_dir, instance_id))
        .join("logs")
        .to_string_lossy()
        .into_owned()
}

pub fn bundle_dir(data_dir: &str, instance_id: &str) -> String {
    Path::new(&instance_dir(data_dir, instance_id))
        .join("bundle")
        .to_string_lossy()
        .into_owned()
}

pub async fn connect_local_worker(
    opts: ConnectLocalWorkerOptions<'_>,
) -> Result<LocalWorkerInstance, String> {
    let runtime = opts.runtime.trim();
    if runtime.is_empty() {
        return Err("runtime is required".into());
    }
    let token = opts.bootstrap_token.trim();
    if token.is_empty() {
        return Err("bootstrap token is required".into());
    }
    let id = create_instance_id(opts.data_dir).await?;
    let dir = instance_dir(opts.data_dir, &id);
    let now = iso_now();
    let prepared = async {
        prepare_private_local_worker_directory(&dir).await?;
        ensure_dir(&state_dir(opts.data_dir, &id)).await;
        ensure_dir(&log_dir(opts.data_dir, &id)).await;
        write_bootstrap_token(&dir, token).await
    }
    .await;
    if let Err(err) = prepared {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(err);
    }
    let instance = LocalWorkerInstance {
        schema_version: SCHEMA.into(),
        id,
        runtime: runtime.to_string(),
        work_dir: resolve_abs(opts.work_dir.unwrap_or(".")),
        bootstrap_token_ref: TOKEN_REF.into(),
        runtime_options: normalize_runtime_options(opts.runtime_options.as_ref()),
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
    };
    write_json_file(
        &instance_config_path(opts.data_dir, &instance.id),
        &instance,
    )
    .await
    .map_err(|err| err.to_string())?;
    Ok(instance)
}

pub async fn reconnect_local_worker(
    opts: ReconnectLocalWorkerOptions<'_>,
) -> Result<LocalWorkerInstance, String> {
    let instance = read_local_worker_instance(opts.data_dir, opts.instance_id)
        .await?
        .ok_or_else(|| format!("local worker not found: {}", opts.instance_id))?;
    if opts
        .bootstrap_token
        .is_some_and(|token| token.trim().is_empty())
    {
        return Err("bootstrap token is required".into());
    }
    let dir = instance_dir(opts.data_dir, &instance.id);
    prepare_private_local_worker_directory(&dir).await?;
    ensure_dir(&state_dir(opts.data_dir, &instance.id)).await;
    ensure_dir(&log_dir(opts.data_dir, &instance.id)).await;
    if let Some(token) = opts
        .bootstrap_token
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        write_bootstrap_token(&dir, token).await?;
    }
    let updated = LocalWorkerInstance {
        work_dir: opts
            .work_dir
            .map(resolve_abs)
            .unwrap_or(instance.work_dir.clone()),
        runtime_options: match &opts.runtime_options {
            Some(options) => normalize_runtime_options(Some(options)),
            None => instance.runtime_options.clone(),
        },
        enabled: true,
        updated_at: iso_now(),
        ..instance
    };
    write_json_file(&instance_config_path(opts.data_dir, &updated.id), &updated)
        .await
        .map_err(|err| err.to_string())?;
    Ok(updated)
}

pub async fn read_local_worker_instance(
    data_dir: &str,
    instance_id: &str,
) -> Result<Option<LocalWorkerInstance>, String> {
    let Some(mut instance) =
        read_json_file::<LocalWorkerInstance>(&instance_config_path(data_dir, instance_id)).await
    else {
        return Ok(None);
    };
    instance.runtime_options = normalize_runtime_options(Some(&instance.runtime_options));
    Ok(Some(instance))
}

pub async fn list_local_worker_instances(
    data_dir: &str,
) -> Result<Vec<LocalWorkerInstance>, String> {
    let mut entries = match tokio::fs::read_dir(local_worker_root(data_dir)).await {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut instances = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("lw_") {
            continue;
        }
        if let Some(instance) = read_local_worker_instance(data_dir, &name).await? {
            instances.push(instance);
        }
    }
    instances.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(instances)
}

pub async fn set_local_worker_enabled(
    data_dir: &str,
    instance_id: &str,
    enabled: bool,
) -> Result<LocalWorkerInstance, String> {
    let mut instance = read_local_worker_instance(data_dir, instance_id)
        .await?
        .ok_or_else(|| format!("local worker not found: {instance_id}"))?;
    instance.enabled = enabled;
    instance.updated_at = iso_now();
    write_json_file(&instance_config_path(data_dir, instance_id), &instance)
        .await
        .map_err(|err| err.to_string())?;
    Ok(instance)
}

pub async fn delete_local_worker_instance(data_dir: &str, instance_id: &str) -> Result<(), String> {
    let instance = read_local_worker_instance(data_dir, instance_id)
        .await?
        .ok_or_else(|| format!("local worker not found: {instance_id}"))?;
    if instance.enabled {
        return Err(format!(
            "local worker must be disconnected before delete: {instance_id}"
        ));
    }
    if has_running_local_worker_process(data_dir, instance_id).await? {
        return Err(format!(
            "local worker is still running, retry after disconnect stops it: {instance_id}"
        ));
    }
    tokio::fs::remove_dir_all(instance_dir(data_dir, instance_id))
        .await
        .map_err(|err| err.to_string())
}

pub async fn list_local_worker_views(data_dir: &str) -> Result<Vec<LocalWorkerView>, String> {
    let instances = list_local_worker_instances(data_dir).await?;
    let mut views = Vec::new();
    for instance in instances {
        views.push(read_local_worker_view(data_dir, &instance).await?);
    }
    Ok(views)
}

pub async fn read_local_worker_view(
    data_dir: &str,
    instance: &LocalWorkerInstance,
) -> Result<LocalWorkerView, String> {
    let s_dir = state_dir(data_dir, &instance.id);
    let l_dir = log_dir(data_dir, &instance.id);
    let supervisor = read_json_file::<Value>(
        &Path::new(&s_dir)
            .join("supervisor-status.json")
            .to_string_lossy(),
    )
    .await;
    let worker =
        read_json_file::<Value>(&Path::new(&s_dir).join("status.json").to_string_lossy()).await;
    let runtime_snapshot = read_json_file::<Value>(
        &Path::new(&s_dir)
            .join("runtime-state.json")
            .to_string_lossy(),
    )
    .await;
    let matrix_snapshot = read_json_file::<Value>(
        &Path::new(&s_dir)
            .join("matrix-state.json")
            .to_string_lossy(),
    )
    .await;
    let runtime_member = runtime_snapshot
        .as_ref()
        .and_then(|value| value.get("member"))
        .and_then(Value::as_object);
    let pid = supervisor
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(json_u32);
    let alive = pid.is_some_and(is_process_alive);
    let supervisor_failed = supervisor
        .as_ref()
        .and_then(|value| value.get("state"))
        .and_then(Value::as_str)
        == Some("failed");
    let heartbeat_at = worker.as_ref().and_then(|value| {
        read_timestamp_ms(
            value
                .get("updatedAt")
                .or_else(|| value.get("lastHeartbeatAt"))
                .or_else(|| value.get("heartbeatAt")),
        )
    });
    let worker_phase = worker
        .as_ref()
        .and_then(|value| value.get("phase").or_else(|| value.get("state")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let now = now_ms();
    let degraded = is_worker_degraded(worker.as_ref())
        || (alive
            && heartbeat_at
                .is_some_and(|stamp| now.saturating_sub(stamp) > LOCAL_WORKER_HEARTBEAT_STALE_MS));
    let state = if supervisor_failed {
        "failed"
    } else if !instance.enabled && alive {
        "stopping"
    } else if !instance.enabled {
        "disabled"
    } else if alive && worker_phase == "waiting" {
        "waiting"
    } else if degraded {
        "degraded"
    } else if alive {
        "running"
    } else if pid.is_some() {
        "stale"
    } else {
        supervisor
            .as_ref()
            .and_then(|value| value.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("pending")
    };

    let supervisor_failed = state == "failed"
        && supervisor
            .as_ref()
            .and_then(|value| value.get("state"))
            .and_then(Value::as_str)
            == Some("failed");
    let reason = if supervisor_failed {
        read_string(supervisor.as_ref().and_then(|value| value.get("reason")))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("reason"))))
    } else {
        read_string(worker.as_ref().and_then(|value| value.get("reason")))
            .or_else(|| read_string(supervisor.as_ref().and_then(|value| value.get("reason"))))
    };
    let message = if supervisor_failed {
        read_string(supervisor.as_ref().and_then(|value| value.get("error")))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("message"))))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("error"))))
    } else {
        read_string(worker.as_ref().and_then(|value| value.get("message")))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("error"))))
            .or_else(|| read_string(supervisor.as_ref().and_then(|value| value.get("error"))))
    };
    Ok(LocalWorkerView {
        id: instance.id.clone(),
        runtime: instance.runtime.clone(),
        work_dir: instance.work_dir.clone(),
        enabled: instance.enabled,
        state: state.to_string(),
        reason,
        message,
        pid,
        worker_name: read_string(worker.as_ref().and_then(|value| value.get("workerName")))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("runtimeName"))))
            .or_else(|| read_string(runtime_member.and_then(|member| member.get("runtimeName"))))
            .or_else(|| read_string(runtime_member.and_then(|member| member.get("name")))),
        team_name: read_string(worker.as_ref().and_then(|value| value.get("teamName")))
            .or_else(|| read_team_name(runtime_snapshot.as_ref(), runtime_member)),
        matrix: read_display(
            worker
                .as_ref()
                .and_then(|value| value.get("matrixConnected")),
        )
        .or_else(|| {
            read_display(
                worker
                    .as_ref()
                    .and_then(|value| value.get("matrix"))
                    .and_then(|value| value.get("connected")),
            )
        })
        .or_else(|| read_matrix_snapshot(matrix_snapshot.as_ref())),
        room_id: read_string(worker.as_ref().and_then(|value| value.get("teamRoomId")))
            .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("roomId"))))
            .or_else(|| {
                matrix_snapshot
                    .as_ref()
                    .and_then(|value| first_record_key(value.get("matrixCursors")))
            })
            .or_else(|| read_string(runtime_member.and_then(|member| member.get("teamRoomId"))))
            .or_else(|| {
                read_string(runtime_member.and_then(|member| member.get("personalRoomId")))
            }),
        heartbeat: read_string(
            worker
                .as_ref()
                .and_then(|value| value.get("lastHeartbeatAt")),
        )
        .or_else(|| read_string(worker.as_ref().and_then(|value| value.get("heartbeatAt"))))
        .or_else(|| {
            read_timestamp_display(worker.as_ref().and_then(|value| value.get("updatedAt")))
        }),
        updated_at: read_string(worker.as_ref().and_then(|value| value.get("updatedAt")))
            .unwrap_or_else(|| instance.updated_at.clone()),
        log_path: Path::new(&l_dir)
            .join("worker.log")
            .to_string_lossy()
            .into_owned(),
    })
}

pub async fn read_bootstrap_token(
    data_dir: &str,
    instance: &LocalWorkerInstance,
) -> Result<String, String> {
    let text = tokio::fs::read_to_string(bootstrap_token_path(data_dir, instance))
        .await
        .map_err(|err| err.to_string())?;
    Ok(text.trim().to_string())
}

async fn has_running_local_worker_process(
    data_dir: &str,
    instance_id: &str,
) -> Result<bool, String> {
    let mut pids = Vec::new();
    if let Some(pid) =
        read_pid_file(&Path::new(&state_dir(data_dir, instance_id)).join("worker.pid")).await
    {
        pids.push(pid);
    }
    let supervisor = read_json_file::<Value>(
        &Path::new(&state_dir(data_dir, instance_id))
            .join("supervisor-status.json")
            .to_string_lossy(),
    )
    .await;
    if let Some(pid) = supervisor
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(json_u32)
    {
        pids.push(pid);
    }
    Ok(pids.into_iter().any(is_process_alive))
}

async fn read_pid_file(path: &Path) -> Option<u32> {
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let pid = text.trim().parse::<u32>().ok()?;
    if pid > 0 {
        Some(pid)
    } else {
        None
    }
}

async fn create_instance_id(data_dir: &str) -> Result<String, String> {
    for _ in 0..5 {
        let mut bytes = [0_u8; 10];
        getrandom_bytes(&mut bytes);
        let id = format!("lw_{}", base32(&bytes).to_lowercase());
        if read_local_worker_instance(data_dir, &id).await?.is_none() {
            return Ok(id);
        }
    }
    Err("failed to allocate local worker instance id".into())
}

fn getrandom_bytes(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        if file.read_exact(buf).is_ok() {
            return;
        }
    }
    let stamp = now_ms();
    for (index, byte) in buf.iter_mut().enumerate() {
        *byte = (stamp.wrapping_add(index as u128) % 256) as u8;
    }
}

async fn write_bootstrap_token(dir: &str, token: &str) -> Result<(), String> {
    let token_path = Path::new(dir).join(TOKEN_REF);
    if let Some(parent) = token_path.parent() {
        ensure_dir(&parent.to_string_lossy()).await;
    }
    tokio::fs::write(&token_path, token)
        .await
        .map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn normalize_runtime_options(value: Option<&RuntimeOptions>) -> RuntimeOptions {
    value.cloned().unwrap_or_default()
}

pub fn runtime_options_from_value(value: &Value) -> RuntimeOptions {
    let Some(object) = value.as_object() else {
        return RuntimeOptions::new();
    };
    let mut out = RuntimeOptions::new();
    for (key, raw) in object {
        if key.is_empty() {
            continue;
        }
        match raw {
            Value::Bool(flag) => {
                out.insert(key.clone(), RuntimeOptionValue::Bool(*flag));
            }
            Value::Null => {}
            other => {
                let text = match other {
                    Value::String(text) => text.clone(),
                    Value::Number(number) => number.to_string(),
                    _ => other.to_string(),
                };
                out.insert(key.clone(), RuntimeOptionValue::Text(text));
            }
        }
    }
    out
}

fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = 0_u32;
    let mut value = 0_u32;
    let mut output = String::new();
    for byte in bytes {
        value = (value << 8) | *byte as u32;
        bits += 8;
        while bits >= 5 {
            output.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    output
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read_display(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Bool(true)) => Some("connected".into()),
        Some(Value::Bool(false)) => Some("disconnected".into()),
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn is_worker_degraded(worker: Option<&Value>) -> bool {
    let phase = worker
        .and_then(|value| value.get("phase").or_else(|| value.get("state")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let reason = worker
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    phase == "degraded" || reason.contains("degraded")
}

fn read_timestamp_ms(value: Option<&Value>) -> Option<u128> {
    match value {
        Some(Value::Number(number)) => {
            let number = number.as_f64()?;
            if !number.is_finite() {
                return None;
            }
            Some(if number > 1_000_000_000_000.0 {
                number as u128
            } else {
                (number * 1000.0) as u128
            })
        }
        Some(Value::String(text)) if !text.trim().is_empty() => {
            if let Ok(number) = text.parse::<f64>() {
                if number.is_finite() {
                    return Some(if number > 1_000_000_000_000.0 {
                        number as u128
                    } else {
                        (number * 1000.0) as u128
                    });
                }
            }
            chrono::DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|time| time.timestamp_millis().max(0) as u128)
        }
        _ => None,
    }
}

fn read_timestamp_display(value: Option<&Value>) -> Option<String> {
    if let Some(text) = read_string(value) {
        return Some(text);
    }
    read_timestamp_ms(value).map(|ms| {
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default()
    })
}

fn read_team_name(
    runtime_snapshot: Option<&Value>,
    runtime_member: Option<&Map<String, Value>>,
) -> Option<String> {
    if let Some(direct) = read_string(runtime_snapshot.and_then(|value| value.get("teamName")))
        .or_else(|| read_string(runtime_member.and_then(|member| member.get("teamName"))))
    {
        return Some(direct);
    }
    let storage = runtime_snapshot
        .and_then(|value| value.get("storage"))
        .and_then(Value::as_object);
    if let Some(name) = read_string(storage.and_then(|value| value.get("teamName"))) {
        return Some(name);
    }
    let prefix = read_string(storage.and_then(|value| value.get("teamPrefix")))?;
    regex::Regex::new(r"(?:^|/)teams/([^/]+)")
        .ok()?
        .captures(&prefix)?
        .get(1)
        .map(|item| item.as_str().to_string())
}

fn read_matrix_snapshot(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if read_string(value.get("matrixSyncToken")).is_some() {
        return Some("connected".into());
    }
    let cursors = value.get("matrixCursors").and_then(Value::as_object)?;
    if cursors.keys().any(|key| !key.is_empty()) {
        Some("connected".into())
    } else {
        None
    }
}

fn first_record_key(value: Option<&Value>) -> Option<String> {
    value?
        .as_object()?
        .keys()
        .find(|key| !key.is_empty())
        .cloned()
}

fn json_u32(value: &Value) -> Option<u32> {
    let number = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))?;
    if number == 0 || number > u32::MAX as u64 {
        None
    } else {
        Some(number as u32)
    }
}

fn resolve_abs(path: &str) -> String {
    let input = Path::new(path);
    let absolute = if input.is_absolute() {
        input.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(input)
    };
    let mut parts = Vec::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(worker: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(format!(
            r#"{{"workerUuid":"{worker}","matrixUrl":"https://matrix.example.com","controllerUrl":"https://controller.example.com","modelGatewayUrl":"https://model.example.com"}}"#
        ))
    }

    #[tokio::test]
    async fn stores_the_token_outside_instance_json_and_lists_states() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").to_string_lossy().into_owned();
        let project = dir.path().join("project").to_string_lossy().into_owned();
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let instance = connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: &data,
            runtime: "claude-code",
            bootstrap_token: &token(uuid),
            work_dir: Some(&project),
            runtime_options: None,
        })
        .await
        .unwrap();
        assert!(regex::Regex::new(r"^lw_[a-z2-7]{16}$")
            .unwrap()
            .is_match(&instance.id));
        assert!(!instance.id.contains(uuid));
        assert!(instance.runtime_options.is_empty());
        let raw = std::fs::read_to_string(instance_config_path(&data, &instance.id)).unwrap();
        assert!(!raw.contains(&token(uuid)));
        assert!(!raw.contains(uuid));
        assert_eq!(
            std::fs::read_to_string(bootstrap_token_path(&data, &instance)).unwrap(),
            token(uuid)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(instance_dir(&data, &instance.id))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }

        let second = connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: &data,
            runtime: "claude-code",
            bootstrap_token: &token(uuid),
            work_dir: Some(dir.path().join("project-b").to_str().unwrap()),
            runtime_options: Some({
                let mut options = RuntimeOptions::new();
                options.insert(
                    "plugin-install-scope".into(),
                    RuntimeOptionValue::Text("global".into()),
                );
                options.insert(
                    "model-config-mode".into(),
                    RuntimeOptionValue::Text("managed-global".into()),
                );
                options
            }),
        })
        .await
        .unwrap();
        assert_ne!(second.id, instance.id);

        set_local_worker_enabled(&data, &instance.id, false)
            .await
            .unwrap();
        let views = list_local_worker_views(&data).await.unwrap();
        let disabled = views.iter().find(|view| view.id == instance.id).unwrap();
        assert_eq!(disabled.state, "disabled");

        let s_dir = state_dir(&data, &instance.id);
        std::fs::write(
            Path::new(&s_dir).join("supervisor-status.json"),
            json_status(std::process::id()),
        )
        .unwrap();
        let views = list_local_worker_views(&data).await.unwrap();
        assert_eq!(
            views
                .iter()
                .find(|view| view.id == instance.id)
                .unwrap()
                .state,
            "stopping"
        );

        std::fs::write(
            Path::new(&s_dir).join("supervisor-status.json"),
            format!(r#"{{"state":"failed","pid":{},"reason":"WorkerProcessTreeStopFailed","error":"worker process remained alive"}}"#, std::process::id()),
        )
        .unwrap();
        std::fs::write(Path::new(&s_dir).join("status.json"), r#"{"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"stale worker status"}"#).unwrap();
        let view = list_local_worker_views(&data)
            .await
            .unwrap()
            .into_iter()
            .find(|view| view.id == instance.id)
            .unwrap();
        assert_eq!(view.state, "failed");
        assert_eq!(view.reason.as_deref(), Some("WorkerProcessTreeStopFailed"));
        assert_eq!(
            view.message.as_deref(),
            Some("worker process remained alive")
        );

        let reconnected = reconnect_local_worker(ReconnectLocalWorkerOptions {
            data_dir: &data,
            instance_id: &instance.id,
            bootstrap_token: Some(&token("rotated-worker-uuid")),
            work_dir: Some(dir.path().join("project-b").to_str().unwrap()),
            runtime_options: None,
        })
        .await
        .unwrap();
        assert_eq!(reconnected.id, instance.id);
        assert_eq!(reconnected.created_at, instance.created_at);
        assert!(reconnected.enabled);
        assert_eq!(
            std::fs::read_to_string(bootstrap_token_path(&data, &reconnected)).unwrap(),
            token("rotated-worker-uuid")
        );

        set_local_worker_enabled(&data, &instance.id, false)
            .await
            .unwrap();
        delete_local_worker_instance(&data, &instance.id)
            .await
            .unwrap_err();
        std::fs::write(
            Path::new(&state_dir(&data, &instance.id)).join("supervisor-status.json"),
            r#"{"state":"stopped"}"#,
        )
        .unwrap();
        // enabled is false, but a live pid would block delete. Clear pid by writing no pid.
        delete_local_worker_instance(&data, &instance.id)
            .await
            .unwrap();
        assert!(!Path::new(&instance_dir(&data, &instance.id)).exists());
    }

    fn json_status(pid: u32) -> String {
        format!(r#"{{"state":"running","pid":{pid}}}"#)
    }

    #[tokio::test]
    async fn surfaces_waiting_and_stale_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_str().unwrap();
        let instance = connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: data,
            runtime: "claude-code",
            bootstrap_token: "opaque-token-owned-by-runtime-worker",
            work_dir: None,
            runtime_options: None,
        })
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(bootstrap_token_path(data, &instance)).unwrap(),
            "opaque-token-owned-by-runtime-worker"
        );
        let s_dir = state_dir(data, &instance.id);
        std::fs::write(
            Path::new(&s_dir).join("supervisor-status.json"),
            format!(r#"{{"state":"running","pid":{}}}"#, std::process::id()),
        )
        .unwrap();
        std::fs::write(Path::new(&s_dir).join("status.json"), r#"{"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"runtime command is not installed"}"#).unwrap();
        let view = read_local_worker_view(data, &instance).await.unwrap();
        assert_eq!(view.state, "waiting");
        assert_eq!(view.reason.as_deref(), Some("RuntimeCommandNotFound"));
        assert_eq!(
            view.message.as_deref(),
            Some("runtime command is not installed")
        );
    }
}

#[cfg(test)]
#[path = "instance_store_history_contract_tests.rs"]
mod history_contract_tests;
