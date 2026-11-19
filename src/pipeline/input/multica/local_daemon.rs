use std::path::{Path, PathBuf};

use reqwest::Client;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::config::{source_url, valid_agent_id, Input};
use super::{records, source_http};

const HEALTH_PORT: u16 = 19514;
const MAX_PROFILES: usize = 64;

pub(crate) async fn discover() -> Vec<(Value, Option<PathBuf>)> {
    let mut sources = Vec::new();
    let home = PathBuf::from(crate::utils::resolve_home("~/.multica"));
    if home.is_absolute() {
        if let Some(source) = daemon(&home, None).await {
            sources.push(source);
        }
        if let Ok(mut entries) = tokio::fs::read_dir(home.join("profiles")).await {
            for _ in 0..MAX_PROFILES {
                let Ok(Some(entry)) = entries.next_entry().await else {
                    break;
                };
                if !entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                let name = entry.file_name();
                if let Some(name) = name.to_str() {
                    if let Some(source) = daemon(&entry.path(), Some(name)).await {
                        sources.push(source);
                    }
                }
            }
        }
    }
    let metrics_addr = std::env::var("METRICS_ADDR").unwrap_or_default();
    let metrics = port(metrics_addr.rsplit_once(':').map(|(_, port)| port), 9090);
    let api = port(std::env::var("PORT").ok().as_deref(), 8080);
    sources.push((
        config(
            "multica-local-backend".into(),
            json!({
                "BackendIdentityUrl": format!("http://127.0.0.1:{api}/api/config"),
                "MetricsUrls": [format!("http://127.0.0.1:{metrics}/metrics")],
                "PprofBaseUrl": "http://127.0.0.1:6060",
            }),
        ),
        None,
    ));
    sources
}

fn config(name: String, mut input: Value) -> Value {
    input["Type"] = "input_multica".into();
    input["CollectionMode"] = "on".into();
    json!({ "configName": name, "inputs": [input], "flushers": [] })
}

fn port(value: Option<&str>, fallback: u16) -> u16 {
    value
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(fallback)
}

async fn read_regular(path: &Path, max: u64) -> Option<Vec<u8>> {
    if !tokio::fs::symlink_metadata(path).await.ok()?.is_file() {
        return None;
    }
    let mut reader = tokio::fs::OpenOptions::new();
    reader.read(true);
    #[cfg(unix)]
    reader.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let file = reader.open(path).await.ok()?;
    let meta = file.metadata().await.ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let mut out = Vec::new();
    file.take(max + 1).read_to_end(&mut out).await.ok()?;
    (out.len() as u64 <= max).then_some(out)
}

async fn daemon(dir: &Path, profile: Option<&str>) -> Option<(Value, Option<PathBuf>)> {
    let log = dir.join("daemon.log");
    if !tokio::fs::symlink_metadata(&log).await.ok()?.is_file() {
        return None;
    }
    let pid = read_regular(&dir.join("daemon.pid"), 32).await?;
    let pid_text = std::str::from_utf8(&pid).ok()?.trim();
    if !pid_text.bytes().all(|byte| byte.is_ascii_digit()) || pid_text.starts_with('0') {
        return None;
    }
    let pid = pid_text.parse::<u32>().ok()?;
    if pid > i32::MAX as u32 || !crate::utils::is_process_alive(pid) {
        return None;
    }
    let name = profile
        .map(|name| records::digest(name.as_bytes())[..16].to_owned())
        .unwrap_or_else(|| "default".into());
    let port = profile
        .map(|profile| {
            let sum = profile.bytes().map(u32::from).sum::<u32>();
            HEALTH_PORT + 1 + (sum % 1000) as u16
        })
        .unwrap_or(HEALTH_PORT);
    let config_file = dir.join("config.json");
    Some((
        config(
            format!("multica-local-daemon-{name}"),
            json!({
                "LogFiles": [log],
                "DaemonHealthUrls": [format!("http://127.0.0.1:{port}/health")],
                "LocalDaemonPid": pid,
            }),
        ),
        Some(config_file),
    ))
}

pub(crate) async fn workspace_input(
    client: &Client,
    input: &Input,
    file: &Path,
) -> Result<Input, String> {
    let bytes = read_regular(file, 64 * 1024)
        .await
        .ok_or("invalid_profile")?;
    let profile: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_profile")?;
    let base = source_url(
        profile["server_url"]
            .as_str()
            .ok_or("invalid_profile_url")?,
    )
    .map_err(|_| "invalid_profile_url")?;
    if base.query().is_some() {
        return Err("invalid_profile_url".into());
    }
    let token = profile["token"]
        .as_str()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or("missing_api_token")?;
    let base = base.as_str().trim_end_matches('/');
    let endpoint = format!("{base}/api/workspaces")
        .parse()
        .map_err(|_| "invalid_profile_url")?;
    let mut selected = input.clone();
    selected.api_base = Some(base.to_owned());
    selected.local_token = Some(token.to_owned());
    let response = source_http::get(
        client,
        endpoint,
        input.timeout(),
        input.max_response_bytes.unwrap_or(4 * 1024 * 1024),
        Some((&selected, "")),
    )
    .await?;
    let workspaces: Vec<Value> =
        serde_json::from_slice(&response.bytes).map_err(|_| "unexpected_response_shape")?;
    let mut seen = std::collections::HashSet::new();
    selected.workspace_ids.clear();
    for workspace in workspaces {
        let id = workspace["id"]
            .as_str()
            .filter(|id| valid_agent_id(id))
            .ok_or("unexpected_response_shape")?;
        if seen.insert(id.to_owned()) {
            selected.workspace_ids.push(id.to_owned());
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn daemon_sources_require_live_pid_and_bind_profile_port() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path();
        tokio::fs::write(at.join("daemon.log"), "").await.unwrap();
        tokio::fs::write(at.join("daemon.pid"), "0").await.unwrap();
        assert!(daemon(at, Some("dev")).await.is_none());
        tokio::fs::write(at.join("daemon.pid"), std::process::id().to_string())
            .await
            .unwrap();
        let (spec, profile) = daemon(at, Some("dev")).await.unwrap();
        assert_eq!(profile.unwrap(), at.join("config.json"));
        assert_eq!(spec["inputs"][0]["LocalDaemonPid"], std::process::id());
        assert_eq!(
            spec["inputs"][0]["DaemonHealthUrls"][0],
            "http://127.0.0.1:19834/health"
        );
        assert!(!spec.to_string().contains("config.json"));
    }
}
