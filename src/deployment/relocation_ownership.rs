//! Read-only ownership evidence shared by the two bounded relocation paths.
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
pub(super) fn valid_install_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control) && id.trim() == id
}
pub(super) fn open_owned(path: &Path, directory: bool) -> io::Result<File> {
    open_owned_checked(path, directory, || {})
}
fn open_owned_checked(
    path: &Path,
    directory: bool,
    after_metadata: impl FnOnce(),
) -> io::Result<File> {
    let _ = std::fs::symlink_metadata(path)?;
    let meta = crate::utils::runtime_paths::runtime_metadata(path).map_err(io::Error::other)?;
    if if directory {
        !meta.is_dir()
    } else {
        !meta.is_file()
    } {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "relocation evidence has an invalid file type",
        ));
    }
    after_metadata();
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if if directory {
        !opened.is_dir()
    } else {
        !opened.is_file()
    } {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened relocation evidence has an invalid type",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "opened relocation evidence is a reparse point",
            ));
        }
    }
    if !owned_by_current_user(&file)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "relocation evidence belongs to another owner",
        ));
    }
    Ok(file)
}
#[cfg(unix)]
fn owned_by_current_user(file: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no arguments or pointers.
    Ok(file.metadata()?.uid() == unsafe { libc::geteuid() })
}
#[cfg(windows)]
#[path = "relocation_windows_owner.rs"]
mod windows_owner;
#[cfg(windows)]
fn owned_by_current_user(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    windows_owner::owned_by_current_user_handle(file.as_raw_handle())
}
#[cfg(not(any(unix, windows)))]
fn owned_by_current_user(_file: &File) -> io::Result<bool> {
    Ok(false)
}

pub(super) fn read_owned_bytes(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match open_owned(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("relocation evidence is not an owned regular file".into()),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read bounded relocation evidence")?;
    if bytes.len() as u64 > limit {
        return Err("relocation evidence exceeds read budget".into());
    }
    Ok(Some(bytes))
}
pub(super) fn read_install_id(path: &Path) -> Result<Option<String>, String> {
    let Some(bytes) = read_owned_bytes(path, MAX_CONFIG_BYTES)? else {
        return Ok(None);
    };
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err("install ownership configuration must be an object".into());
    }
    // Deserialize only the two identity-bearing keys; unknown config values
    // are discarded. Value enforces object shape at the nested boundary too.
    #[derive(serde::Deserialize)]
    struct Identity {
        #[serde(default, rename = "autoUpdate", deserialize_with = "present_value")]
        auto: Option<serde_json::Value>,
        #[serde(default, rename = "installId", deserialize_with = "present_value")]
        legacy: Option<serde_json::Value>,
    }
    fn present_value<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<serde_json::Value>, D::Error> {
        Ok(Some(serde::Deserialize::deserialize(deserializer)?))
    }
    fn id(value: Option<&serde_json::Value>) -> Result<Option<String>, String> {
        value
            .map(|value| {
                value
                    .as_str()
                    .filter(|id| valid_install_id(id))
                    .map(str::to_owned)
                    .ok_or_else(|| "install ownership identity is invalid".into())
            })
            .transpose()
    }
    let parsed: Identity =
        serde_json::from_slice(bytes).map_err(|_| "install ownership configuration is invalid")?;
    let nested = match parsed.auto.as_ref() {
        Some(serde_json::Value::Null) => None,
        Some(value) => id(value
            .as_object()
            .ok_or("autoUpdate ownership configuration must be an object")?
            .get("installId"))?,
        None => None,
    };
    let legacy = id(parsed.legacy.as_ref())?;
    if nested.is_some() && legacy.is_some() && nested != legacy {
        return Err("conflicting install ownership identities".into());
    }
    Ok(nested.or(legacy))
}
pub(super) fn effective_install_id(
    config: &crate::types::AnalyticsConfig,
) -> Result<Option<String>, String> {
    let configured = config
        .auto_update
        .as_ref()
        .and_then(|update| update.install_id.clone());
    if configured
        .as_deref()
        .is_some_and(|id| !valid_install_id(id))
    {
        return Err("effective install identity is invalid".into());
    }
    let disk = match config.source_config_path.as_deref() {
        Some(path) => read_install_id(Path::new(path))?,
        None => None,
    };
    if configured.is_some() && disk.is_some() && configured != disk {
        return Err("effective config and persisted install identities conflict".into());
    }
    Ok(configured.or(disk))
}

#[cfg(test)]
#[path = "relocation_identity_tests.rs"]
mod identity_tests;

/// Existing config must be an owned regular file. Missing declared config is
/// allowed only when the first existing ancestor is an owned plain directory.
pub(super) fn validate_owned_target(path: &Path, allow_missing: bool) -> anyhow::Result<()> {
    match open_owned(path, false) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound && allow_missing => {}
        Err(error) => return Err(error.into()),
    }
    let mut parent = path
        .parent()
        .ok_or_else(|| io::Error::other("target has no parent"))?;
    loop {
        match open_owned(parent, true) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                parent = parent
                    .parent()
                    .ok_or_else(|| io::Error::other("target has no existing parent"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(super) fn validate_owned_directory(path: &Path) -> anyhow::Result<()> {
    let mut current = path;
    loop {
        match open_owned(current, true) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                current = current
                    .parent()
                    .ok_or_else(|| io::Error::other("directory has no owned ancestor"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}
