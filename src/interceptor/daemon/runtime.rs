//! `runtime.json` and `interceptor.pid`.

use crate::interceptor::paths::{interceptor_pid_path, interceptor_runtime_path};
use crate::interceptor::types::{InterceptorRuntime, INTERCEPTOR_SERVICE};
use crate::utils::{
    read_process_start_token, remove_own_pid_file_sync, write_pid_file_sync,
    write_text_file_atomic, AtomicTextWriteOptions,
};
use std::fs;

pub struct RuntimeWriteOptions<'a> {
    pub data_dir: Option<&'a str>,
    pub port: u16,
    pub version: &'a str,
    pub git_commit: Option<&'a str>,
}

pub fn build_runtime(opts: &RuntimeWriteOptions<'_>) -> InterceptorRuntime {
    let token = read_process_start_token(std::process::id());
    InterceptorRuntime {
        service: INTERCEPTOR_SERVICE.to_string(),
        status: "ok".to_string(),
        pid: u64::from(std::process::id()),
        version: opts.version.to_string(),
        daemon_port: opts.port,
        package_version: opts.version.to_string(),
        git_commit: opts
            .git_commit
            .map(str::to_string)
            .filter(|text| !text.is_empty()),
        process_start_token: if token.is_empty() { None } else { Some(token) },
        updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

pub async fn write_runtime(opts: &RuntimeWriteOptions<'_>) -> std::io::Result<InterceptorRuntime> {
    let runtime = build_runtime(opts);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&runtime).unwrap_or_else(|_| "{}".to_string())
    );
    let file_path = interceptor_runtime_path(opts.data_dir);
    if let Some(dir) = file_path.parent() {
        fs::create_dir_all(dir)?;
    }
    write_text_file_atomic(
        &file_path.to_string_lossy(),
        &text,
        &AtomicTextWriteOptions::default(),
    )
    .await
    .map_err(|err| std::io::Error::other(err.to_string()))?;
    write_pid(opts.data_dir);
    Ok(runtime)
}

pub fn write_pid(data_dir: Option<&str>) {
    write_pid_file_sync(&interceptor_pid_path(data_dir).to_string_lossy());
}

pub fn remove_own_pid(data_dir: Option<&str>) {
    remove_own_pid_file_sync(&interceptor_pid_path(data_dir).to_string_lossy());
}

pub fn read_installed_git_commit(data_dir: &str) -> Option<String> {
    let current = fs::read_to_string(std::path::Path::new(data_dir).join("current")).ok()?;
    let current = current.trim();
    if current.is_empty() {
        return None;
    }
    let content = fs::read_to_string(
        std::path::Path::new(data_dir)
            .join("versions")
            .join(current)
            .join("VERSION"),
    )
    .ok()?;
    let pattern = regex::Regex::new(r"(?m)^git_commit=(.+)$").ok()?;
    pattern
        .captures(&content)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::paths::interceptor_pid_path;
    use crate::interceptor::types::INTERCEPTOR_SERVICE;
    use std::fs;

    #[test]
    fn records_the_process_lifetime_token_when_the_platform_exposes_one() {
        let runtime = build_runtime(&RuntimeWriteOptions {
            data_dir: None,
            port: 18791,
            version: "1.2.3",
            git_commit: None,
        });
        let token = crate::utils::read_process_start_token(std::process::id());
        assert!(
            !token.is_empty(),
            "supported host must expose its own process identity"
        );
        assert_eq!(runtime.process_start_token.as_deref(), Some(token.as_str()));
        assert_eq!(runtime.service, INTERCEPTOR_SERVICE);
        assert_eq!(runtime.package_version, "1.2.3");
        assert_eq!(runtime.daemon_port, 18791);
    }

    #[test]
    fn does_not_remove_a_pid_file_already_replaced_by_a_successor() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_string_lossy().to_string();
        write_pid(Some(&data_dir));
        let pid_file = interceptor_pid_path(Some(&data_dir));
        let successor = format!("{}\n", std::process::id() + 1);
        fs::write(&pid_file, &successor).unwrap();
        remove_own_pid(Some(&data_dir));
        assert_eq!(fs::read_to_string(&pid_file).unwrap(), successor);
    }
}
