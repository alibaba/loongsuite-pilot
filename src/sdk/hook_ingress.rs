//! A writer lease for durable Hook ingress, shared by the thin binary and installer.
//! A Node rollback keeps the exclusive lease through publication of the version
//! pointer. A delayed Rust Hook then observes Node, not an empty Rust inbox.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const LEASE: &str = ".sdk-hook-ingress.lock";
const INSTALL: &str = ".sdk-hook-ingress-install.json";

fn open_file(path: &Path, create_lock: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(create_lock).create(create_lock);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("Hook ingress requires a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Hook ingress reparse point rejected"));
        }
    }
    Ok(file)
}

fn read_bounded(path: &Path, max: usize) -> io::Result<Vec<u8>> {
    let file = open_file(path, false)?;
    let mut bytes = Vec::new();
    file.take((max + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(io::Error::other(
            "Hook ingress configuration exceeds its size limit",
        ));
    }
    Ok(bytes)
}

/// The exclusive side never waits for an Agent callback. If a writer is
/// already publishing, the installer cannot claim a quiescent snapshot.
#[allow(
    dead_code,
    reason = "shared source is also compiled into the thin Hook"
)]
pub(crate) fn lock_for_rollback(root: &Path, cache: &Path) -> io::Result<File> {
    let root = root.canonicalize()?;
    let lease = open_file(&root.join(LEASE), true)?;
    fs2::FileExt::try_lock_exclusive(&lease)?;
    let cache = cache.canonicalize()?;
    let mut binding = tempfile::NamedTempFile::new_in(&root)?;
    binding.write_all(&serde_json::to_vec(&cache)?)?;
    binding.as_file().sync_all()?;
    binding
        .persist(root.join(INSTALL))
        .map_err(|error| error.error)?;
    Ok(lease)
}

/// Ordinary embedded SDKs have no install binding. For a bound installation
/// the kernel lease serializes publishing with rollback, and the same version
/// pointer used by the installer handles abort, retry and later re-upgrade.
#[allow(
    dead_code,
    reason = "shared source is also compiled into the installer"
)]
pub(crate) fn lock_writer(root: &Path) -> io::Result<File> {
    let root = root.canonicalize()?;
    let lease = open_file(&root.join(LEASE), true)?;
    fs2::FileExt::try_lock_shared(&lease)?;
    let bytes = match read_bounded(&root.join(INSTALL), 16 * 1024) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(lease),
        Err(error) => return Err(error),
    };
    let cache: PathBuf = serde_json::from_slice(&bytes)?;
    if !cache.is_absolute() {
        return Err(io::Error::other("invalid Hook ingress install binding"));
    }
    let current = read_bounded(&cache.join("current"), 256)?;
    let name = std::str::from_utf8(&current)
        .map_err(io::Error::other)?
        .trim();
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(io::Error::other("invalid Hook ingress install binding"));
    }
    // Check the active runtime, not the stale executable's directory. Never
    // authorize a Node version just because it is now the current pointer.
    let version = cache.join("versions").join(name);
    let manifest = version.join("runtime-manifest.json");
    for path in [cache.join("versions"), version] {
        let entry = fs::symlink_metadata(&path)?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            return Err(io::Error::other("invalid Hook ingress version directory"));
        }
    }
    #[derive(serde::Deserialize)]
    struct Runtime {
        runtime: String,
    }
    let manifest: Runtime = serde_json::from_slice(&read_bounded(&manifest, 2 * 1024 * 1024)?)?;
    if manifest.runtime != "rust" {
        return Err(io::Error::other("Rust Hook ingress is inactive"));
    }
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_hooks_and_node_switch_cannot_overlap() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let sdk = root.path().join("sdk");
        fs::create_dir(&sdk).unwrap();
        for (version, runtime) in [("native", "rust"), ("legacy", "node")] {
            let dir = cache.join("versions").join(version);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("runtime-manifest.json"),
                serde_json::json!({"runtime":runtime}).to_string(),
            )
            .unwrap();
        }
        fs::write(cache.join("current"), "native\n").unwrap();
        let writer = lock_writer(&sdk).unwrap();
        assert!(lock_for_rollback(&sdk, &cache).is_err());
        drop(writer);
        let rollback = lock_for_rollback(&sdk, &cache).unwrap();
        assert!(lock_writer(&sdk).is_err());
        drop(rollback); // Failed handoff, native is still the active version.
        assert!(lock_writer(&sdk).is_ok());
        let rollback = lock_for_rollback(&sdk, &cache).unwrap();
        fs::write(cache.join("current"), "legacy\n").unwrap();
        drop(rollback);
        assert!(lock_writer(&sdk).is_err());
        fs::write(cache.join("current"), "native\n").unwrap();
        assert!(lock_writer(&sdk).is_ok());
    }
}
