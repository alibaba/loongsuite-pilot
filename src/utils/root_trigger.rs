use std::io;
use std::path::Path;

#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    pub(super) fn enabled() -> bool {
        std::env::var("LOONGSUITE_PILOT_ROOT_TRIGGER").is_ok_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
    }

    pub(super) fn euid() -> libc::uid_t {
        // SAFETY: geteuid takes no pointers.
        unsafe { libc::geteuid() }
    }

    fn open_read(path: &Path, directory: bool) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(
                libc::O_NONBLOCK | libc::O_NOFOLLOW | if directory { libc::O_DIRECTORY } else { 0 },
            )
            .open(path)
    }

    pub(super) fn root_claim(path: &Path) -> bool {
        let Ok(file) = open_read(path, false) else {
            return false;
        };
        let Ok(info) = file.metadata() else {
            return false;
        };
        if !info.is_file() || info.uid() != 0 || info.len() > 64 {
            return false;
        }
        let mut text = String::new();
        if file.take(65).read_to_string(&mut text).is_err() || text.len() > 64 {
            return false;
        }
        let value = text.trim();
        if value.is_empty() {
            return info
                .modified()
                .ok()
                .and_then(|stamp| SystemTime::now().duration_since(stamp).ok())
                .is_some_and(|age| age < Duration::from_secs(60));
        }
        let Some(pid) = value
            .parse::<u32>()
            .ok()
            .filter(|pid| *pid > 0 && pid.to_string() == value)
        else {
            return false;
        };
        let process = std::path::PathBuf::from(format!("/proc/{pid}"));
        if !fs::metadata(&process).is_ok_and(|meta| meta.is_dir() && meta.uid() == 0) {
            return false;
        }
        // Unprivileged launchers may read cmdline where ptrace-protected
        // /proc/PID/exe is inaccessible. A root-owned PID must identify the
        // same installed binary by its full path.
        use std::os::unix::ffi::OsStrExt;
        let Ok(current) = std::env::current_exe() else {
            return false;
        };
        let Ok(command) = open_read(&process.join("cmdline"), false) else {
            return false;
        };
        let mut bytes = Vec::new();
        command.take(4097).read_to_end(&mut bytes).is_ok()
            && bytes.len() <= 4096
            && !bytes.is_empty()
            && bytes.split(|byte| *byte == 0).next() == Some(current.as_os_str().as_bytes())
    }

    pub(super) fn write_pid(path: &Path, pid: u32) -> io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| io::Error::other("spawn lock has no parent directory"))?;
        let name = ".daemon.spawn.lock";
        // Use the same parent so readers observe either the prior claim or the
        // full PID. Set the mode through the owned file despite the service umask.
        let temporary = dir.join(format!("{name}.{pid}.{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&temporary)?;
        let publish = (|| {
            write!(file, "{pid}")?;
            file.set_permissions(fs::Permissions::from_mode(0o644))?;
            file.sync_all()?;
            fs::rename(&temporary, path)
        })();
        if publish.is_err() {
            let _ = fs::remove_file(temporary);
        }
        publish
    }

    fn configure_log_dir(logs: &Path, agent: &str) -> io::Result<()> {
        let directory = logs.join(agent);
        if let Err(error) = fs::DirBuilder::new().create(&directory) {
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        let dir = open_read(&directory, true)?;
        if dir.metadata()?.uid() != 0 {
            return Ok(());
        }
        let lock = directory.join(".raw-source-gate.sqlite");
        let options = || {
            let mut open = OpenOptions::new();
            open.read(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            open
        };
        let gate = match options().create_new(true).open(&lock) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => options().open(&lock)?,
            Err(error) => return Err(error),
        };
        let info = gate.metadata()?;
        if !info.is_file() || info.uid() != 0 || info.nlink() != 1 {
            return Err(io::Error::other(
                "raw source gate is not a root-owned regular file",
            ));
        }
        gate.set_permissions(fs::Permissions::from_mode(0o666))?;
        dir.set_permissions(fs::Permissions::from_mode(0o1777))
    }

    pub(super) fn prepare_logs(data: &Path) -> io::Result<()> {
        let logs = data.join("logs");
        fs::create_dir_all(&logs)?;
        let parent = open_read(&logs, true)?;
        let info = parent.metadata()?;
        if info.uid() != 0 {
            return Ok(());
        }
        if info.mode() & 0o022 != 0 {
            return Err(io::Error::other(
                "shared logs parent must be writable only by root",
            ));
        }
        parent.set_permissions(fs::Permissions::from_mode(info.mode() & 0o7777 | 0o111))?;
        for agent in ["openclaw", "hermes-agent", "dsh"] {
            configure_log_dir(&logs, agent)?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn explicit_root_trigger_publishes_coordination_without_following_symlinks() {
            let dir = tempfile::tempdir().unwrap();
            let original = dir.path().join("original");
            fs::write(&original, "keep").unwrap();
            let target = dir.path().join("daemon.spawn.lock");
            std::os::unix::fs::symlink(&original, &target).unwrap();
            assert!(!root_claim(&target));
            write_pid(&target, std::process::id()).unwrap();
            assert_eq!(fs::read_to_string(original).unwrap(), "keep");
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                std::process::id().to_string()
            );
            assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o644);
            if euid() == 0 {
                assert!(root_claim(&target));
            }
        }
    }
}

pub(crate) fn is_root_owner() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::enabled() && linux::euid() == 0
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub(crate) fn reuse_root_collector(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::enabled() && linux::euid() != 0 && linux::root_claim(path)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        false
    }
}

pub(crate) fn record_pid(path: &Path, pid: u32) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if is_root_owner() {
        return linux::write_pid(path, pid);
    }
    std::fs::write(path, pid.to_string())
}

pub(crate) fn prepare_logs(data: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if is_root_owner() {
        return linux::prepare_logs(data);
    }
    let _ = data;
    Ok(())
}
