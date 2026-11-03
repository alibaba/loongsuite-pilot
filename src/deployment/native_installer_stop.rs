//! Installer fallback stops only a verified current-user native process in this installation.
use anyhow::Result;
use serde_json::Value;

pub(super) async fn run(value: Value) -> Result<String> {
    #[cfg(unix)]
    {
        unix::run(value).await
    }
    #[cfg(not(unix))]
    {
        let _ = value;
        anyhow::bail!("Installer PID fallback requires a Unix host")
    }
}
#[cfg(unix)]
mod unix {
    use super::super::worker_process::{NativeProcesses, ProcessIdentity, ProcessOperations};
    use crate::utils::runtime_paths::{
        build_edition, build_target, resource_file, runtime_metadata, validate_runtime,
    };
    use anyhow::{ensure, Context, Result};
    use serde::Deserialize;
    use serde_json::Value;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Options {
        data_dir: PathBuf,
        cache_dir: PathBuf,
        pid_file: PathBuf,
    }
    fn absolute(path: &Path) -> Result<()> {
        ensure!(
            path.is_absolute() && !path.to_string_lossy().chars().any(char::is_control),
            "Invalid installer PID fallback path"
        );
        Ok(())
    }
    fn read_pid(path: &Path) -> Result<Option<Vec<u8>>> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(_) => runtime_metadata(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => anyhow::bail!("Cannot inspect installer PID file; it was preserved"),
        };
        ensure!(
            metadata.is_file() && metadata.len() <= 128,
            "Invalid installer PID file; it was preserved"
        );
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(129)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 128,
            "Invalid installer PID file; it was preserved"
        );
        Ok(Some(bytes))
    }
    fn package(root: &Path) -> Result<()> {
        let mut bytes = Vec::new();
        std::fs::File::open(resource_file(root, "VERSION")?)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024,
            "Invalid installed package version"
        );
        let text = std::str::from_utf8(&bytes)?;
        let mut versions = text
            .trim_start_matches('\u{feff}')
            .lines()
            .filter_map(|line| line.strip_prefix("version="));
        let version = versions
            .next()
            .context("Installed package version is missing")?;
        ensure!(
            versions.next().is_none(),
            "Installed package version is ambiguous"
        );
        validate_runtime(root, version, build_target(), build_edition())?;
        Ok(())
    }
    fn entry_belongs_to_cache(cache: &Path, executable: &Path) -> Result<bool> {
        let Some(binary_dir) = executable.parent() else {
            return Ok(false);
        };
        let Some(root) = binary_dir.parent() else {
            return Ok(false);
        };
        if executable.file_name() != Some(std::ffi::OsStr::new("loongsuite-pilot"))
            || binary_dir.file_name() != Some(std::ffi::OsStr::new("bin"))
        {
            return Ok(false);
        }
        let cache = std::fs::canonicalize(cache)?;
        let versions = cache.join("versions");
        ensure!(
            runtime_metadata(&cache)?.is_dir() && runtime_metadata(&versions)?.is_dir(),
            "Cannot verify installed native package directories"
        );
        let versions = std::fs::canonicalize(versions)?;
        let root = std::fs::canonicalize(root)?;
        if root.parent() != Some(versions.as_path()) {
            return Ok(false);
        }
        let current = super::super::native_install::read_pointer(&cache.join("current"))?;
        let previous = super::super::native_install::read_pointer(&cache.join("previous"))?;
        if ![current, previous]
            .iter()
            .flatten()
            .any(|name| root.file_name() == Some(std::ffi::OsStr::new(name)))
        {
            return Ok(false);
        }
        if !runtime_metadata(&root)?.is_dir() {
            return Ok(false);
        }
        if std::fs::canonicalize(resource_file(&root, "bin/loongsuite-pilot")?)? != executable {
            return Ok(false);
        }
        package(&root)?;
        Ok(true)
    }
    fn belongs(
        identity: &ProcessIdentity,
        data: &Path,
        cache: &Path,
        updater: bool,
    ) -> Result<bool> {
        if identity.executable_path.is_empty() {
            return Ok(false);
        }
        let executable = std::fs::canonicalize(&identity.executable_path)?;
        if !entry_belongs_to_cache(cache, &executable)? {
            return Ok(false);
        }
        let key = sysinfo::Pid::from_u32(identity.pid);
        let self_key = sysinfo::Pid::from_u32(std::process::id());
        let mut snapshot = sysinfo::System::new();
        snapshot.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[key, self_key]),
            true,
            sysinfo::ProcessRefreshKind::everything(),
        );
        let (Some(process), Some(current)) = (snapshot.process(key), snapshot.process(self_key))
        else {
            return Ok(false);
        };
        if process.user_id().is_none()
            || process.effective_user_id().is_none()
            || process.user_id() != current.user_id()
            || process.effective_user_id() != current.effective_user_id()
        {
            return Ok(false);
        }
        if process
            .exe()
            .and_then(|p| std::fs::canonicalize(p).ok())
            .as_ref()
            != Some(&executable)
        {
            return Ok(false);
        }
        if !crate::utils::installed_process::is_installed_process(
            identity.pid,
            if updater { "updater" } else { "collector" },
            cache,
            data,
        ) {
            return Ok(false);
        }
        Ok(NativeProcesses
            .identity(identity.pid)?
            .is_some_and(|actual| identity.matches(&actual)))
    }
    pub(super) async fn run(value: Value) -> Result<String> {
        let options: Options = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("Invalid installer PID fallback options"))?;
        for path in [&options.data_dir, &options.cache_dir, &options.pid_file] {
            absolute(path)?;
        }
        let data = std::fs::canonicalize(&options.data_dir)?;
        ensure!(
            runtime_metadata(&options.data_dir)?.is_dir(),
            "Invalid installer data directory"
        );
        let updater = match options.pid_file.file_name().and_then(|name| name.to_str()) {
            Some("loongsuite-pilot.pid") => false,
            Some("loongsuite-pilot-updater.pid") => true,
            _ => anyhow::bail!("Installer PID fallback target is outside this installation"),
        };
        ensure!(
            options
                .pid_file
                .parent()
                .and_then(|path| std::fs::canonicalize(path).ok())
                .as_ref()
                == Some(&data),
            "Installer PID fallback target is outside this data directory"
        );
        let Some(original) = read_pid(&options.pid_file)? else {
            return Ok(String::new());
        };
        let text = std::str::from_utf8(&original)
            .map_err(|_| anyhow::anyhow!("Invalid installer PID file; it was preserved"))?
            .trim();
        ensure!(
            !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()),
            "Invalid installer PID file; it was preserved"
        );
        let pid: u32 = text
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid installer PID; file preserved"))?;
        ensure!(
            pid > 1 && pid != std::process::id(),
            "Refusing reserved installer PID; file preserved"
        );
        let processes = NativeProcesses;
        let Some(identity) = processes.identity(pid)? else {
            return Ok(String::new());
        };
        ensure!(
            belongs(&identity, &data, &options.cache_dir, updater)?,
            "Installer PID ownership was not verified; process and pid file preserved"
        );
        ensure!(
            read_pid(&options.pid_file)?.as_ref() == Some(&original),
            "Installer PID file changed; process and file preserved"
        );
        processes.signal(&identity, false)?;
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let force_after = start + Duration::from_secs(9);
        let mut forced = false;
        while let Some(actual) = processes.identity(pid)? {
            ensure!(
                identity.matches(&actual),
                "Installer PID was reused; new process and file preserved"
            );
            if !forced && Instant::now() >= force_after {
                ensure!(
                    read_pid(&options.pid_file)?.as_ref() == Some(&original)
                        && belongs(&identity, &data, &options.cache_dir, updater)?,
                    "Installer process ownership changed; process and pid file preserved"
                );
                processes.signal(&identity, true)?;
                forced = true;
            }
            ensure!(
                Instant::now() < deadline,
                "Could not stop verified installer process; pid file preserved"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // PID files are left to the process/service owner. Deleting here could
        // race a newly started collector writing its own PID after this stop.
        Ok(String::new())
    }
}
