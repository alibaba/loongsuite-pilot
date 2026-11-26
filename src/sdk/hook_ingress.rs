//! A writer lease for durable Hook ingress, shared by the thin binary and installer.
//! A Node rollback keeps the exclusive lease through publication of the version
//! pointer. A delayed Rust Hook then observes Node, not an empty Rust inbox.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const LEASE: &str = ".sdk-hook-ingress.lock";
const INSTALL: &str = ".sdk-hook-ingress-install.json";
pub(crate) const ROLLBACK_INBOX: &str = ".sdk-hook-rollback-inbox";
const RESERVATION_PREFIX: &str = ".pilot-hook-reservation-";

pub(crate) enum WriterLease {
    Active {
        _guard: File,
    },
    Switching(
        #[allow(dead_code, reason = "reserved slot is used in the thin Hook")]
        tempfile::NamedTempFile,
    ),
}

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
    let cache = cache.canonicalize()?;
    let gate = cache.join(ROLLBACK_INBOX);
    let mut dir = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dir.mode(0o700);
    }
    match dir.create(&gate) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    check_directory(&gate)?;
    // Establish the contingency destination *before* a producer can observe
    // contention. The active pointer is not modified under this preparation.
    let mut binding = tempfile::NamedTempFile::new_in(&root)?;
    binding.write_all(&serde_json::to_vec(&cache)?)?;
    binding.as_file().sync_all()?;
    binding
        .persist(root.join(INSTALL))
        .map_err(|error| error.error)?;
    let lease = open_file(&root.join(LEASE), true)?;
    fs2::FileExt::try_lock_exclusive(&lease)?;
    Ok(lease)
}

fn check_directory(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(io::Error::other("invalid Hook ingress directory"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other(
                "Hook ingress directory reparse point rejected",
            ));
        }
    }
    Ok(())
}

fn bound_cache(root: &Path) -> io::Result<Option<PathBuf>> {
    let bytes = match read_bounded(&root.join(INSTALL), 16 * 1024) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let cache: PathBuf = serde_json::from_slice(&bytes)?;
    if !cache.is_absolute() || cache.canonicalize()? != cache {
        return Err(io::Error::other("invalid Hook ingress install binding"));
    }
    Ok(Some(cache))
}

pub(crate) fn transition_inbox(root: &Path) -> io::Result<Option<PathBuf>> {
    Ok(bound_cache(root)?.map(|cache| cache.join(ROLLBACK_INBOX)))
}

#[allow(
    dead_code,
    reason = "installer cleanup; shared source is also compiled into the Hook"
)]
pub(crate) fn prune_dead_reservations(
    directory: &Path,
    is_alive: impl Fn(u32) -> bool,
) -> io::Result<()> {
    check_directory(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let pid = name
            .to_str()
            .and_then(|name| name.strip_prefix(RESERVATION_PREFIX))
            .and_then(|name| name.split_once('-'))
            .and_then(|(pid, nonce)| nonce.ends_with(".tmp").then_some(pid))
            .and_then(|pid| pid.parse::<u32>().ok())
            .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32);
        if pid.is_some_and(|pid| !is_alive(pid)) && entry.file_type()?.is_file() {
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

/// Switching already owns a reservation inside the gate; rmdir cannot win
/// against either this unfinished slot or the completed JSON record.
#[allow(
    dead_code,
    reason = "shared source is also compiled into the installer"
)]
pub(crate) fn publish_transition(
    mut pending: tempfile::NamedTempFile,
    name: &str,
    body: &[u8],
) -> io::Result<()> {
    let destination = pending.path().with_file_name(name);
    pending.write_all(body)?;
    pending.as_file().sync_all()?;
    pending
        .persist_noclobber(destination)
        .map_err(|error| error.error)?;
    Ok(())
}

/// Ordinary embedded SDKs have no install binding. For a bound installation
/// the kernel lease serializes publishing with rollback, and the same version
/// pointer used by the installer handles abort, retry and later re-upgrade.
#[allow(
    dead_code,
    reason = "shared source is also compiled into the installer"
)]
pub(crate) fn lock_writer(root: &Path) -> io::Result<WriterLease> {
    let root = root.canonicalize()?;
    let lease = open_file(&root.join(LEASE), true)?;
    match fs2::FileExt::try_lock_shared(&lease) {
        Ok(()) => {}
        Err(error)
            if error.kind() == io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            if let Some(inbox) = transition_inbox(&root)? {
                check_directory(&inbox)?;
                let pending = tempfile::Builder::new()
                    .prefix(&format!("{RESERVATION_PREFIX}{}-", std::process::id()))
                    .suffix(".tmp")
                    .tempfile_in(inbox)?;
                return Ok(WriterLease::Switching(pending));
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    }
    let Some(cache) = bound_cache(&root)? else {
        return Ok(WriterLease::Active { _guard: lease });
    };
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
    Ok(WriterLease::Active { _guard: lease })
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
        let WriterLease::Switching(slot) = lock_writer(&sdk).unwrap() else {
            panic!("contended publisher needs a durable owner");
        };
        let inbox = slot.path().parent().unwrap().to_owned();
        // Pause immediately after Switching, before there are any JSON bytes.
        prune_dead_reservations(&inbox, |pid| pid == std::process::id()).unwrap();
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 1);
        assert!(fs::remove_dir(&inbox).is_err());
        drop(rollback); // Failed handoff, native is still the active version.
        publish_transition(slot, "qwen-pending.json", b"{}").unwrap();
        assert!(lock_writer(&sdk).is_ok());
        assert_eq!(fs::read(inbox.join("qwen-pending.json")).unwrap(), b"{}");
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 1);
        fs::remove_file(inbox.join("qwen-pending.json")).unwrap();
        let rollback = lock_for_rollback(&sdk, &cache).unwrap();
        fs::write(cache.join("current"), "legacy\n").unwrap();
        fs::remove_dir(&inbox).unwrap();
        assert!(lock_writer(&sdk).is_err());
        drop(rollback);
        assert!(lock_writer(&sdk).is_err());
        fs::write(cache.join("current"), "native\n").unwrap();
        assert!(lock_writer(&sdk).is_ok());
    }
}
