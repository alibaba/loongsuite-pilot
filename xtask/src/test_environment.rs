//! Shared pre-exec environment used by the real Baseline runner and its history contracts.
use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

pub(crate) fn prepare_isolated_environment(command: &mut Command, home: &Path) -> io::Result<()> {
    command.env_clear();
    // 工具链和系统最小环境可继承；所有 Agent/输出凭据均不继承。
    for key in [
        "PATH",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "RUSTUP_TOOLCHAIN",
        "RUSTUP_DIST_SERVER",
        "RUSTUP_UPDATE_ROOT",
        "CARGO_NET_OFFLINE",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for key in ["HOME", "USERPROFILE"] {
        command.env(key, home);
    }
    for key in [
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    ] {
        let directory = home.join(key.to_lowercase());
        fs::create_dir_all(&directory)?;
        command.env(key, directory);
    }
    Ok(())
}
