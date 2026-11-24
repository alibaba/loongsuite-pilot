//! Reconcile Qoder's token reporting defaults in the Agent's own profile.
use crate::types::AgentDefinition;
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::Path,
};

const KEYS: [&str; 2] = ["QODER_EXPOSE_TOKEN_USAGE", "QODERCN_EXPOSE_TOKEN_USAGE"];
const MAX_ENV_BYTES: u64 = 1024 * 1024;

fn missing_defaults(content: &str) -> String {
    let mut seen = [false; 2];
    let mut quoted = None;
    for line in content.trim_start_matches('\u{feff}').lines() {
        if let Some(quote) = quoted {
            if line.contains(quote) {
                quoted = None;
            }
            continue;
        }
        let line = line.trim_start();
        if line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .unwrap_or(line)
            .trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if let Some(index) = KEYS.iter().position(|name| key.trim() == *name) {
            seen[index] = true;
        }
        let mut value = value.trim_start().chars();
        if let Some(quote @ ('"' | '\'' | '`')) = value.next() {
            if !value.any(|character| character == quote) {
                quoted = Some(quote);
            }
        }
    }
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut suffix = String::new();
    if seen.iter().all(|seen| *seen) || quoted.is_some() {
        return suffix;
    }
    if !content.is_empty() && !content.ends_with('\n') {
        suffix.push_str(newline);
    }
    for (key, present) in KEYS.into_iter().zip(seen) {
        if !present {
            suffix.push_str(key);
            suffix.push_str("=1");
            suffix.push_str(newline);
        }
    }
    suffix
}

fn reconcile_file(directory: &Path, apply: bool) -> io::Result<bool> {
    let mut file = directory.join(".env");
    let stat = match fs::symlink_metadata(&file) {
        Ok(metadata) if metadata.is_symlink() => {
            #[cfg(unix)]
            if current_uid() == 0 {
                return Ok(false);
            }
            file = fs::canonicalize(file)?;
            crate::utils::runtime_paths::runtime_metadata(&file).map_err(io::Error::other)?
        }
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !apply {
                return Ok(!fs::metadata(directory)?.permissions().readonly());
            }
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&file)?
                .write_all(missing_defaults("").as_bytes())?;
            return Ok(true);
        }
        Err(error) => return Err(error),
    };
    if !stat.is_file() || stat.len() > MAX_ENV_BYTES {
        return Ok(false);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if stat.uid() != current_uid() {
            return Ok(false);
        }
        let mut stream = OpenOptions::new()
            .read(true)
            .append(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&file)?;
        fs2::FileExt::try_lock_exclusive(&stream)?;
        let opened = stream.metadata()?;
        if !opened.is_file()
            || opened.uid() != current_uid()
            || (opened.dev(), opened.ino()) != (stat.dev(), stat.ino())
        {
            return Ok(false);
        }
        let mut content = String::new();
        (&mut stream)
            .take(MAX_ENV_BYTES + 1)
            .read_to_string(&mut content)?;
        if content.len() as u64 > MAX_ENV_BYTES {
            return Ok(false);
        }
        let suffix = missing_defaults(&content);
        if suffix.is_empty() {
            return Ok(false);
        }
        if apply {
            let current = fs::symlink_metadata(&file)?;
            if !current.is_file()
                || (
                    current.dev(),
                    current.ino(),
                    current.ctime(),
                    current.ctime_nsec(),
                ) != (
                    opened.dev(),
                    opened.ino(),
                    opened.ctime(),
                    opened.ctime_nsec(),
                )
            {
                return Ok(false);
            }
            stream.write_all(suffix.as_bytes())?;
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        let mut stream = OpenOptions::new()
            .read(true)
            .append(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&file)?;
        fs2::FileExt::try_lock_exclusive(&stream)?;
        let opened = stream.metadata()?;
        if !opened.is_file() || opened.file_attributes() & 0x400 != 0 {
            return Ok(false);
        }
        let mut content = String::new();
        (&mut stream)
            .take(MAX_ENV_BYTES + 1)
            .read_to_string(&mut content)?;
        if content.len() as u64 > MAX_ENV_BYTES {
            return Ok(false);
        }
        let suffix = missing_defaults(&content);
        if suffix.is_empty() {
            return Ok(false);
        }
        if apply {
            stream.write_all(suffix.as_bytes())?;
        }
        Ok(true)
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: geteuid takes no arguments.
    unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn trusted_profile(directory: &Path) -> io::Result<Option<(u32, u32, u64, u64)>> {
    use std::os::unix::fs::MetadataExt;
    if !directory.is_absolute()
        || directory
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Ok(None);
    }
    let profile = fs::symlink_metadata(directory)?;
    for path in directory.ancestors() {
        let stat = fs::symlink_metadata(path)?;
        if !stat.is_dir()
            || (stat.uid() != 0 && stat.uid() != profile.uid())
            || (stat.mode() & 0o022 != 0 && stat.mode() & 0o1000 == 0)
        {
            return Ok(None);
        }
    }
    Ok(Some((
        profile.uid(),
        profile.gid(),
        profile.dev(),
        profile.ino(),
    )))
}

async fn reconcile_profile(directory: &Path, apply: bool) -> io::Result<bool> {
    #[cfg(unix)]
    if current_uid() == 0 {
        let Some((uid, gid, device, inode)) = trusted_profile(directory)? else {
            return Ok(false);
        };
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .uid(uid)
            .gid(gid)
            .env_clear()
            .current_dir(directory)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .arg("internal-qoder-token-usage")
            .args([
                uid.to_string(),
                gid.to_string(),
                device.to_string(),
                inode.to_string(),
            ])
            .arg(if apply { "apply" } else { "check" });
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), command.status())
            .await
            .map_err(io::Error::other)??;
        return match status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(io::Error::other("Qoder profile helper failed")),
        };
    }
    reconcile_file(directory, apply)
}

pub fn profile_helper(args: &[String]) -> i32 {
    #[cfg(unix)]
    if let [uid, gid, dev, ino, mode] = args {
        use std::os::unix::fs::MetadataExt;
        // The child is already running as the profile owner. Refuse to touch
        // another directory or run with unexpected group credentials.
        let Ok(stat) = fs::metadata(".") else {
            return 2;
        };
        // SAFETY: getegid and getgroups with a zero buffer length write nothing.
        let group_count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        if !(0..=1024).contains(&group_count) {
            return 2;
        }
        let mut groups = vec![0; group_count as usize];
        // SAFETY: the buffer has space for the number of gids requested.
        if unsafe { libc::getgroups(group_count, groups.as_mut_ptr()) } != group_count {
            return 2;
        }
        // SAFETY: getegid takes no parameters.
        let effective_gid = unsafe { libc::getegid() };
        if uid.parse().ok() != Some(current_uid())
            || stat.uid() != current_uid()
            || gid.parse().ok() != Some(effective_gid)
            || stat.gid() != effective_gid
            || groups.iter().any(|group| *group != effective_gid)
            || dev.parse().ok() != Some(stat.dev())
            || ino.parse().ok() != Some(stat.ino())
            || !matches!(mode.as_str(), "check" | "apply")
        {
            return 2;
        }
        return match reconcile_file(Path::new("."), mode == "apply") {
            Ok(true) => 0,
            Ok(false) => 1,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => 1,
            Err(_) => 2,
        };
    }
    let _ = args;
    2
}

pub(crate) async fn reconcile(def: &AgentDefinition, apply: bool) -> bool {
    let Some(hook) = def
        .hook
        .as_ref()
        .filter(|_| matches!(def.id.as_str(), "qoder" | "qoder-cn"))
    else {
        return false;
    };
    let settings = crate::utils::resolve_home(&hook.settings_path);
    let Some(directory) = Path::new(&settings).parent() else {
        return false;
    };
    match reconcile_profile(directory, apply).await {
        Ok(changed) => changed,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            tracing::warn!(agent = %def.id, %error, "Unable to reconcile Qoder token usage defaults");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_explicit_values_newlines_and_multiline_quotes() {
        assert_eq!(
            missing_defaults("\u{feff}export QODER_EXPOSE_TOKEN_USAGE = 0\r\n# comment"),
            "\r\nQODERCN_EXPOSE_TOKEN_USAGE=1\r\n"
        );
        assert_eq!(
            missing_defaults(
                "OTHER='a\nQODER_EXPOSE_TOKEN_USAGE=0\n'\nQODERCN_EXPOSE_TOKEN_USAGE=\n"
            ),
            "QODER_EXPOSE_TOKEN_USAGE=1\n"
        );
        assert!(missing_defaults("OTHER='open").is_empty());
    }

    #[test]
    fn writes_only_missing_defaults_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let env = directory.path().join(".env");
        fs::write(&env, "QODER_EXPOSE_TOKEN_USAGE=0\n").unwrap();
        assert!(reconcile_file(directory.path(), false).unwrap());
        assert!(reconcile_file(directory.path(), true).unwrap());
        assert!(!reconcile_file(directory.path(), true).unwrap());
        assert_eq!(
            fs::read_to_string(env).unwrap(),
            "QODER_EXPOSE_TOKEN_USAGE=0\nQODERCN_EXPOSE_TOKEN_USAGE=1\n"
        );
    }
}
