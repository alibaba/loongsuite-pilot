//! In-process OpenClaw metadata lookup. Never executes a CLI.

use crate::utils::{config_json_path_from, resolve_home_with, EnvSource, HomeResolutionOptions};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::openclaw_compat::{open_claw_capabilities, OpenClawCapabilities};
use super::paths::{is_absolute, node_resolve, node_resolve_from, parent_dir};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClawHost {
    pub version: String,
    pub adapter: String,
    pub conversation_access: bool,
    pub source: String,
    pub executable: Option<String>,
    pub binding: Option<String>,
    pub recovered_from: Option<String>,
}

impl OpenClawHost {
    fn from_caps(caps: OpenClawCapabilities, source: String) -> Self {
        Self {
            version: caps.version,
            adapter: caps.adapter,
            conversation_access: caps.conversation_access,
            source,
            executable: None,
            binding: None,
            recovered_from: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenClawResolveMode {
    Runtime,
    Installer,
}

pub fn is_openclaw_host_bound(host: Option<&OpenClawHost>) -> bool {
    host.is_some_and(|host| {
        host.binding.is_some() && host.executable.as_deref().is_some_and(is_absolute)
    })
}

pub fn openclaw_binding_problem(host: Option<&OpenClawHost>, detail: Option<&str>) -> String {
    let head = match detail {
        Some(detail) if !detail.is_empty() => format!("{detail}; "),
        _ => String::new(),
    };
    let body = match host {
        Some(host) => format!(
            "OpenClaw {} candidate found, but Gateway entry is unconfirmed",
            host.version
        ),
        None => "OpenClaw >=2026.3.8 launch entry/version unavailable or unsupported".into(),
    };
    format!("{head}{body}; automatic entry discovery is unavailable or ambiguous; optionally set OPENCLAW_CLI_PATH to the absolute Gateway launch entry; config left unchanged")
}

enum PackageRead {
    Missing,
    Unreadable,
    Host(Option<OpenClawHost>),
}

pub async fn resolve_openclaw_host<F>(
    env: &HashMap<String, String>,
    cwd: &str,
    mut on_problem: Option<F>,
    mode: OpenClawResolveMode,
) -> Option<OpenClawHost>
where
    F: FnMut(String),
{
    let mut problem = |message: String| {
        if let Some(callback) = on_problem.as_mut() {
            callback(message);
        }
        None
    };
    if let Some(entry) = env.get("OPENCLAW_CLI_PATH") {
        if !is_absolute(entry) {
            return None;
        }
        let host = from_entry(entry, env).await;
        return host.map(|mut host| {
            host.binding = Some("explicit-entry".into());
            host
        });
    }

    let (home, config_path) = {
        let home_opts = HomeResolutionOptions {
            env: EnvSource::Isolated(env),
            platform: None,
            homedir: None,
        };
        let home = resolve_home_with("~", &home_opts);
        let config_path = config_json_path_from(EnvSource::Isolated(env), &home_opts);
        (home, config_path)
    };
    let mut recovered_from = None;
    if !config_path.is_empty() {
        match read_json(&config_path, 1024 * 1024).await {
            PackageRead::Unreadable => {
                return problem(format!(
                    "OpenClaw binding config unreadable: {}",
                    serde_json::to_string(&config_path).unwrap_or_default()
                ));
            }
            PackageRead::Host(_) | PackageRead::Missing => {}
        }
        if let Ok(text) = tokio::fs::read_to_string(&config_path).await {
            if let Ok(config) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
                if let Some(entry) = config.pointer("/agents/openclaw/cliPath") {
                    let Some(entry) = entry.as_str() else {
                        return problem(
                            "Invalid persisted OpenClaw entry; refusing automatic rebinding".into(),
                        );
                    };
                    if !is_absolute(entry) {
                        return problem(
                            "Invalid persisted OpenClaw entry; refusing automatic rebinding".into(),
                        );
                    }
                    if let Some(mut host) = from_entry(entry, env).await {
                        host.binding = Some("persisted-entry".into());
                        return Some(host);
                    }
                    let missing = confirmed_missing(entry).await;
                    let _ = problem(format!(
                        "Persisted OpenClaw entry {} : {}",
                        if missing {
                            "is missing"
                        } else {
                            "is unreadable or unsupported"
                        },
                        serde_json::to_string(entry).unwrap_or_default()
                    ));
                    if mode != OpenClawResolveMode::Installer || !missing {
                        return None;
                    }
                    recovered_from = Some(entry.to_string());
                }
            }
        }
    }

    let mut candidates = Vec::new();
    let mut unidentified_parent = None;
    for package_dir in [
        cwd.to_string(),
        Path::new(cwd)
            .join("openclaw")
            .to_string_lossy()
            .into_owned(),
    ] {
        if package_dir != cwd {
            match resolver_metadata(Path::new(&package_dir)).await {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => continue,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    return problem(format!(
                        "OpenClaw child directory lookup failed ({}): {}",
                        describe_fs_error(&err),
                        serde_json::to_string(&package_dir).unwrap_or_default()
                    ));
                }
            }
        }
        let package_json = Path::new(&package_dir)
            .join("package.json")
            .to_string_lossy()
            .into_owned();
        match read_package(&package_json).await {
            PackageRead::Host(None) => {
                return problem(format!(
                    "Unsupported OpenClaw package: {}",
                    serde_json::to_string(&package_dir).unwrap_or_default()
                ));
            }
            PackageRead::Unreadable => {
                let entry = Path::new(&package_dir)
                    .join("openclaw.mjs")
                    .to_string_lossy()
                    .into_owned();
                if package_dir != cwd || !confirmed_missing(&entry).await {
                    return problem(format!(
                        "OpenClaw package metadata unavailable: {}",
                        serde_json::to_string(&package_json).unwrap_or_default()
                    ));
                }
                unidentified_parent = Some(entry);
                continue;
            }
            PackageRead::Missing => {}
            PackageRead::Host(Some(_)) => {
                let entry = Path::new(&package_dir)
                    .join("openclaw.mjs")
                    .to_string_lossy()
                    .into_owned();
                let host = from_entry(&entry, env).await?;
                candidates.push(host);
            }
        }
    }
    if unidentified_parent.is_some() && candidates.is_empty() {
        return problem(format!(
            "Unidentified parent package has no valid fixed OpenClaw child: {}",
            serde_json::to_string(cwd).unwrap_or_default()
        ));
    }
    let bundle_root = env
        .get("OPENCLAW_BUNDLE_ROOT")
        .cloned()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if home.is_empty() {
                None
            } else {
                Some(
                    Path::new(&home)
                        .join(".openclaw-bundle")
                        .to_string_lossy()
                        .into_owned(),
                )
            }
        });
    if let Some(bundle_root) = bundle_root {
        if !is_absolute(&bundle_root) {
            return problem(format!(
                "OPENCLAW_BUNDLE_ROOT must be absolute: {}",
                serde_json::to_string(&bundle_root).unwrap_or_default()
            ));
        }
        let package_dir = Path::new(&bundle_root).join("openclaw/node_modules/openclaw");
        let entry = package_dir
            .join("openclaw.mjs")
            .to_string_lossy()
            .into_owned();
        let implicit = !env.contains_key("OPENCLAW_BUNDLE_ROOT");
        if !(implicit && confirmed_missing(&entry).await) {
            match read_package(&package_dir.join("package.json").to_string_lossy()).await {
                PackageRead::Host(Some(_)) => {
                    let Some(host) = from_entry(&entry, env).await else {
                        return problem(format!(
                            "OpenClaw bundle entry unavailable: {}",
                            serde_json::to_string(&entry).unwrap_or_default()
                        ));
                    };
                    candidates.push(host);
                }
                _ => {
                    return problem(format!(
                        "OpenClaw bundle metadata unavailable or unsupported: {}",
                        serde_json::to_string(&package_dir.to_string_lossy().as_ref())
                            .unwrap_or_default()
                    ));
                }
            }
        }
    }
    let env_value = |key: &str| {
        env.get(key).or_else(|| {
            cfg!(windows)
                .then(|| {
                    env.iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(key))
                        .map(|(_, value)| value)
                })
                .flatten()
        })
    };
    let path_var = env_value("PATH").cloned().unwrap_or_default();
    let extensions = if cfg!(windows) {
        std::iter::once(String::new())
            .chain(
                env_value("PATHEXT")
                    .filter(|value| !value.is_empty())
                    .map(String::as_str)
                    .unwrap_or(".COM;.EXE;.BAT;.CMD")
                    .split(';')
                    .map(str::to_lowercase),
            )
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    'path_search: for directory in path_var
        .split(if cfg!(windows) { ';' } else { ':' })
        .filter(|item| !item.is_empty())
        .take(128)
    {
        if !is_absolute(directory) {
            continue;
        }
        for extension in &extensions {
            let candidate = Path::new(directory).join(format!("openclaw{extension}"));
            if tokio::fs::metadata(&candidate)
                .await
                .ok()
                .is_some_and(|meta| meta.is_file())
            {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if std::fs::metadata(&candidate)
                        .map(|meta| meta.permissions().mode() & 0o111 != 0)
                        .unwrap_or(false)
                    {
                        let selected = from_entry(&candidate.to_string_lossy(), env).await?;
                        candidates.push(selected);
                        break 'path_search;
                    }
                }
                #[cfg(not(unix))]
                {
                    let selected = from_entry(&candidate.to_string_lossy(), env).await?;
                    candidates.push(selected);
                    break 'path_search;
                }
            }
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let mut packages = std::collections::HashSet::new();
    for host in &candidates {
        match tokio::fs::canonicalize(&host.source).await {
            Ok(path) => {
                packages.insert(path);
            }
            Err(_) => return None,
        }
    }
    if packages.len() != 1 {
        return None;
    }
    if let Some(recovered) = &recovered_from {
        if !confirmed_missing(recovered).await {
            return problem(format!(
                "Persisted OpenClaw entry reappeared during discovery: {}",
                serde_json::to_string(recovered).unwrap_or_default()
            ));
        }
    }
    if let Some(parent_entry) = &unidentified_parent {
        if !confirmed_missing(parent_entry).await {
            return problem(format!(
                "Unidentified parent entry appeared or became inaccessible during discovery: {}",
                serde_json::to_string(parent_entry).unwrap_or_default()
            ));
        }
    }
    let mut host = candidates.remove(0);
    host.binding = Some("auto-entry".into());
    host.recovered_from = recovered_from;
    Some(host)
}

async fn resolver_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    #[cfg(test)]
    resolver_io_test_hooks::before("stat", path)?;
    tokio::fs::metadata(path).await
}
async fn resolver_read(path: &Path) -> std::io::Result<Vec<u8>> {
    #[cfg(test)]
    resolver_io_test_hooks::before("read", path)?;
    tokio::fs::read(path).await
}
fn describe_fs_error(error: &std::io::Error) -> String {
    #[cfg(windows)]
    let symbol = match error.raw_os_error() {
        Some(5) => Some("EACCES"),
        Some(1314) => Some("EPERM"),
        Some(1921) => Some("ELOOP"),
        _ => None,
    };
    #[cfg(target_os = "macos")]
    let symbol = match error.raw_os_error() {
        Some(13) => Some("EACCES"),
        Some(1) => Some("EPERM"),
        Some(62) => Some("ELOOP"),
        _ => None,
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let symbol = match error.raw_os_error() {
        Some(13) => Some("EACCES"),
        Some(1) => Some("EPERM"),
        Some(40) => Some("ELOOP"),
        _ => None,
    };
    symbol
        .map(|code| format!("{code}: {error}"))
        .unwrap_or_else(|| error.to_string())
}

async fn confirmed_missing(entry: &str) -> bool {
    match resolver_metadata(Path::new(entry)).await {
        Ok(_) => false,
        Err(err) => err.kind() == std::io::ErrorKind::NotFound,
    }
}

async fn read_json(file: &str, limit: u64) -> PackageRead {
    let file_handle = match tokio::fs::File::open(file).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return PackageRead::Missing,
        Err(_) => return PackageRead::Unreadable,
    };
    let meta = match file_handle.metadata().await {
        Ok(meta) if meta.is_file() && meta.len() <= limit => meta,
        _ => return PackageRead::Unreadable,
    };
    let _ = meta;
    let bytes = match tokio::fs::read(file).await {
        Ok(bytes) if bytes.len() as u64 <= limit => bytes,
        _ => return PackageRead::Unreadable,
    };
    let text = String::from_utf8(bytes).unwrap_or_default();
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(_)) => PackageRead::Host(None),
        _ => PackageRead::Unreadable,
    }
}

async fn read_package(file: &str) -> PackageRead {
    let bytes = match resolver_read(Path::new(file)).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return PackageRead::Missing,
        Err(_) => return PackageRead::Unreadable,
    };
    if bytes.len() > 256 * 1024 {
        return PackageRead::Unreadable;
    }
    let text = String::from_utf8(bytes).unwrap_or_default();
    let Ok(Value::Object(pkg)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
    else {
        return PackageRead::Unreadable;
    };
    if pkg.get("name").and_then(Value::as_str) != Some("openclaw") {
        return PackageRead::Missing;
    }
    match pkg
        .get("version")
        .and_then(Value::as_str)
        .and_then(open_claw_capabilities)
    {
        Some(caps) => PackageRead::Host(Some(OpenClawHost::from_caps(caps, file.to_string()))),
        None => PackageRead::Host(None),
    }
}

async fn from_entry(entry: &str, env: &HashMap<String, String>) -> Option<OpenClawHost> {
    let real = tokio::fs::canonicalize(entry).await.ok()?;
    if !tokio::fs::metadata(&real).await.ok()?.is_file() {
        return None;
    }
    let mut dir = parent_dir(&real.to_string_lossy());
    for depth in 0..8 {
        if Path::new(&dir).parent().is_none()
            && (dir == "/" || dir.ends_with(':') || dir.ends_with(":\\"))
        {
            break;
        }
        if is_fs_root(&dir) {
            break;
        }
        let mut candidates = vec![PathBuf::from(&dir).join("package.json")];
        if depth <= 1 {
            candidates.push(PathBuf::from(&dir).join("node_modules/openclaw/package.json"));
            candidates.push(PathBuf::from(&dir).join("lib/node_modules/openclaw/package.json"));
            candidates
                .push(PathBuf::from(&dir).join("global/5/node_modules/openclaw/package.json"));
        }
        let base = Path::new(&dir)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let bundle = env
            .get("OPENCLAW_BUNDLE_ROOT")
            .map(|value| node_resolve(value));
        if base == ".openclaw-bundle"
            || base == "openclaw-bundle"
            || bundle.as_deref() == Some(dir.as_str())
        {
            candidates
                .push(PathBuf::from(&dir).join("openclaw/node_modules/openclaw/package.json"));
        }
        let mut unidentified = false;
        for candidate in candidates {
            match read_package(&candidate.to_string_lossy()).await {
                PackageRead::Unreadable => {
                    if candidate
                        .parent()
                        .and_then(|path| path.file_name())
                        .and_then(|name| name.to_str())
                        == Some("openclaw")
                    {
                        return None;
                    }
                    unidentified = true;
                }
                PackageRead::Host(Some(mut host)) => {
                    host.executable = Some(entry.to_string());
                    return Some(host);
                }
                PackageRead::Host(None) => return None,
                PackageRead::Missing => {}
            }
        }
        if unidentified {
            return None;
        }
        let parent = parent_dir(&dir);
        if parent == dir {
            break;
        }
        dir = parent;
    }
    None
}

fn is_fs_root(dir: &str) -> bool {
    dir == "/" || dir.is_empty() || Path::new(dir).parent().is_none()
}

#[allow(dead_code)]
fn _resolve_hint(cwd: &str, value: &str) -> String {
    node_resolve_from(cwd, value)
}

#[cfg(test)]
#[path = "openclaw_version_resolver_history_contract_tests.rs"]
mod history_contract_tests;

#[cfg(test)]
#[path = "openclaw_resolver_io_test_hooks.rs"]
mod resolver_io_test_hooks;

#[cfg(test)]
#[path = "openclaw_strategy_history_contract_tests.rs"]
mod strategy_history_contract_tests;
