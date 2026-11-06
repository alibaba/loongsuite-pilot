//! 公共服务命令只调用当前原生包内经过清单验证的平台入口。
//! run / run-updater 不经过此桥接，防止 launcher 递归。

use anyhow::{ensure, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::utils::runtime_paths::{build_edition, build_target, resource_file, validate_runtime};

pub(crate) const COMMANDS: &[&str] = &[
    "start",
    "stop",
    "restart",
    "status",
    "info",
    "log",
    "diagnose-service",
    "start-collector",
    "restart-collector",
    "restart-updater",
    "schedule-updater-restart",
];

fn installed_script(executable: &Path) -> Result<PathBuf> {
    let bin = executable.parent().context("无法定位原生入口目录")?;
    ensure!(
        bin.file_name().is_some_and(|name| name == "bin"),
        "服务命令需要原生安装包，不能从开发目录调用系统服务"
    );
    let root = bin.parent().context("无法定位原生安装根")?;
    let manifest = validate_runtime(
        root,
        env!("CARGO_PKG_VERSION"),
        build_target(),
        build_edition(),
    )?;
    ensure!(
        std::fs::canonicalize(root.join(&manifest.binary))? == std::fs::canonicalize(executable)?,
        "服务入口不是本包的原生二进制"
    );
    resource_file(
        root,
        if cfg!(windows) {
            "scripts/loongsuite-pilot.ps1"
        } else {
            "scripts/loongsuite-pilot.sh"
        },
    )
}

fn command(
    script: &Path,
    arguments: &[String],
    data: &Path,
    cache: &Path,
    config: &Path,
) -> Result<tokio::process::Command> {
    let mut process = if cfg!(windows) {
        let system = std::env::var_os("SystemRoot").context("缺少 Windows SystemRoot")?;
        let mut process = tokio::process::Command::new(
            Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        process.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        process
    } else {
        tokio::process::Command::new("/bin/bash")
    };
    // 参数逐个传递；不拼 -Command / sh -c，也不从 PATH 搜索 Pilot。
    process
        .arg(script)
        .args(arguments)
        .env("LOONGSUITE_PILOT_DATA_DIR", data)
        .env("LOONGSUITE_PILOT_CACHE_DIR", cache)
        .env("AGENT_DATA_COLLECTION_CONFIG", config)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    Ok(process)
}

pub(crate) async fn run(arguments: &[String]) -> Result<i32> {
    let name = arguments.first().context("缺少服务命令")?;
    ensure!(COMMANDS.contains(&name.as_str()), "不支持的服务命令");
    let executable = std::env::current_exe()?;
    let script = installed_script(&executable)?;
    let data = PathBuf::from(crate::utils::resolve_data_dir(None));
    let cache = std::env::var("LOONGSUITE_PILOT_CACHE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(crate::utils::resolve_home(&value)))
        .or_else(|| {
            let root = executable.parent()?.parent()?;
            let versions = root.parent()?;
            (versions.file_name()? == "versions")
                .then(|| versions.parent().map(Path::to_path_buf))
                .flatten()
        })
        .unwrap_or_else(|| PathBuf::from(crate::utils::resolve_home("~/.loongsuite-pilot")));
    let config = std::env::var("AGENT_DATA_COLLECTION_CONFIG")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(crate::utils::resolve_home(&value)))
        .unwrap_or_else(|| data.join("config.json"));
    let mut child = command(&script, arguments, &data, &cache, &config)?
        .spawn()
        .context("无法启动本安装的平台服务入口")?;
    if name == "log" {
        return Ok(child.wait().await?.code().unwrap_or(1));
    }
    match tokio::time::timeout(Duration::from_secs(90), child.wait()).await {
        Ok(status) => Ok(status?.code().unwrap_or(1)),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            if let Some(target) = name
                .strip_prefix("restart-")
                .and_then(crate::utils::restart_breadcrumb::RestartTarget::parse)
            {
                crate::utils::restart_breadcrumb::write_restart_failure(
                    &data.to_string_lossy(),
                    target,
                    &crate::utils::restart_breadcrumb::RestartFailureWrite {
                        stage: "timeout".into(),
                        init_type: None,
                        detail: Some("原生服务命令超过 90 秒，已终止等待进程".into()),
                        diag: None,
                    },
                );
            }
            anyhow::bail!("服务命令 {name} 超过 90 秒")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_and_legacy_launchers_are_rejected_before_execution() {
        let root = tempfile::tempdir().unwrap();
        for relative in [
            "target/debug/loongsuite-pilot",
            "dist/index.js",
            "bin/loongsuite-pilot",
        ] {
            let executable = root.path().join(relative);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, "not an installed package").unwrap();
            assert!(installed_script(&executable).is_err());
        }
        assert!(!COMMANDS.contains(&"run"));
        assert!(!COMMANDS.contains(&"run-updater"));
    }
}
