//! Ownership of native Agent configuration during explicit Linux root onboarding.
use std::io;
use std::path::Path;

pub(super) type Owner = (u32, u32);

pub(super) fn for_target(target: &Path) -> io::Result<Option<Owner>> {
    if !crate::utils::root_trigger::is_root_owner() {
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;

        let path = std::path::absolute(target)?;
        for candidate in path.ancestors() {
            match std::fs::symlink_metadata(candidate) {
                Ok(metadata) => {
                    if !(metadata.is_dir() || metadata.is_file())
                        || std::fs::canonicalize(candidate)? != candidate
                    {
                        return Err(io::Error::other(
                            "Agent configuration path is not a native file or directory",
                        ));
                    }
                    return Ok((metadata.uid() != 0).then(|| (metadata.uid(), metadata.gid())));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(
            "Agent configuration parent is unavailable",
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = target;
        Ok(None)
    }
}

pub(super) fn configure_child(command: &mut tokio::process::Command, owner: Option<Owner>) {
    #[cfg(target_os = "linux")]
    if let Some((uid, gid)) = owner {
        command.uid(uid).gid(gid);
    }
    let _ = (command, owner);
}

pub(super) async fn ensure_directory(path: &Path) -> io::Result<()> {
    if !crate::utils::root_trigger::is_root_owner() {
        return tokio::fs::create_dir_all(path).await;
    }
    let owner = for_target(path)?;
    if path.is_dir() {
        return Ok(());
    }
    let Some(owner) = owner else {
        return tokio::fs::create_dir_all(path).await;
    };
    // Run only the filesystem helper with the Agent's identity. Errors must
    // propagate rather than retrying the user's path under the root identity.
    let mut child = tokio::process::Command::new(std::env::current_exe()?);
    configure_child(&mut child, Some(owner));
    child
        .env_clear()
        .kill_on_drop(true)
        .arg("internal-agent-config-directory")
        .arg(std::path::absolute(path)?)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.status())
        .await
        .map_err(io::Error::other)??;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "Agent configuration owner could not create the directory ({status})"
        )))
    }
}

pub(crate) fn directory_helper(args: &[String]) -> i32 {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        // SAFETY: geteuid takes no pointers.
        if (unsafe { libc::geteuid() }) != 0 {
            if let [path] = args {
                let path = Path::new(path);
                if path.is_absolute()
                    && std::fs::DirBuilder::new()
                        .recursive(true)
                        .mode(0o700)
                        .create(path)
                        .is_ok()
                {
                    return 0;
                }
            }
        }
    }
    let _ = args;
    2
}

pub(super) fn preserve_file_owner(file: &std::fs::File, owner: Option<Owner>) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if let Some((uid, gid)) = owner {
        return std::os::unix::fs::fchown(file, Some(uid), Some(gid));
    }
    let _ = (file, owner);
    Ok(())
}
