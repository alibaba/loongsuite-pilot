//! A writer lease for durable Hook ingress, shared by the thin binary and installer.
//! A Node rollback keeps the exclusive lease through publication of the version
//! pointer. If the empty inbox closes before admission, the installed Node
//! capture process, not the retired Rust queue, owns that callback.

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
    Node(#[allow(dead_code, reason = "legacy capture belongs to the thin Hook")] NodeCutover),
}

/// Identifies the official Node release that won the cutover. No Hook input
/// can select a program: the binding and current pointer are install-owned.
#[allow(dead_code, reason = "the thin Hook executes the selected release")]
pub(crate) struct NodeCutover {
    cache: PathBuf,
    version: PathBuf,
}

#[allow(dead_code, reason = "used only by the thin Hook")]
#[derive(Clone, Copy)]
pub(crate) enum NodeCapture {
    Cursor,
    QwenStop,
}

#[allow(dead_code, reason = "used only by the thin Hook")]
impl NodeCutover {
    pub(crate) fn forward(
        &self,
        agent: NodeCapture,
        data: &Path,
        config: Option<&Path>,
        payload: &serde_json::Value,
    ) -> io::Result<()> {
        use std::process::{Command, Stdio};

        let data = match agent {
            NodeCapture::Cursor => data,
            NodeCapture::QwenStop => {
                let suffix = Path::new("state").join("standalone-qwen-work-cn-sdk");
                if !data.ends_with(suffix) {
                    return Err(io::Error::other("invalid legacy Qwen Hook data directory"));
                }
                data.parent()
                    .and_then(Path::parent)
                    .expect("checked suffix")
            }
        };
        // The v1 installer pins its runtime in the install cache/data
        // (PowerShell 5.1 can write the pin with a UTF-8 BOM). Do not run an
        // executable from the Agent working directory or fall back to PATH.
        let node = [&self.cache, data]
            .into_iter()
            .find_map(|directory| {
                let bytes = read_bounded(&directory.join("node-bin"), 16 * 1024).ok()?;
                let text = std::str::from_utf8(&bytes)
                    .ok()?
                    .trim_start_matches('\u{feff}')
                    .trim();
                let path = Path::new(text);
                (path.is_absolute() && path.is_file()).then(|| path.to_owned())
            })
            .ok_or_else(|| io::Error::other("invalid legacy Hook Node runtime"))?;
        let assets = self.version.join("assets");
        let hooks = assets.join("hooks");
        check_directory(&assets)?;
        check_directory(&hooks)?;
        let script = hooks.join(match agent {
            NodeCapture::Cursor => "cursor-hook-processor.mjs",
            NodeCapture::QwenStop => "qwen-work-cn-hook-processor.mjs",
        });
        open_file(&script, false)?;
        let mut command = Command::new(node);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
            .arg(script)
            .env("LOONGSUITE_PILOT_DATA_DIR", data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let config = config.map(Path::to_owned).or_else(|| {
            std::env::var_os("AGENT_DATA_COLLECTION_CONFIG")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        });
        command
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                config.unwrap_or_else(|| data.join("config.json")),
            )
            .env_remove("LOONGSUITE_CURSOR_RAW_TRACE");
        if matches!(agent, NodeCapture::QwenStop) {
            command.args(["--agent-id", "qwen-work-cn", "--log-prefix", "qwen-work-cn"]);
        }
        // Send directly to the official processor: no second inbox, payload
        // file, shell, or replay. The existing Hook watchdog bounds Agent wait.
        let bytes = serde_json::to_vec(payload)?;
        let mut child = command.spawn()?;
        let mut input = child.stdin.take().expect("piped legacy Hook stdin");
        let result = input.write_all(&bytes);
        drop(input);
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        if !child.wait()?.success() {
            return Err(io::Error::other(
                "legacy Hook capture failed during cutover",
            ));
        }
        Ok(())
    }
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

fn current_version(cache: &Path) -> io::Result<PathBuf> {
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
    let versions = cache.join("versions");
    check_directory(&versions)?;
    let version = versions.join(name);
    check_directory(&version)?;
    Ok(version)
}

fn is_rust_version(version: &Path) -> io::Result<bool> {
    let bytes = match read_bounded(&version.join("runtime-manifest.json"), 2 * 1024 * 1024) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    #[derive(serde::Deserialize)]
    struct Runtime {
        runtime: String,
    }
    let manifest: Runtime = serde_json::from_slice(&bytes)?;
    if manifest.runtime != "rust" {
        return Err(io::Error::other("unknown installed Hook runtime"));
    }
    Ok(true)
}

fn node_owner(cache: PathBuf, version: PathBuf) -> io::Result<WriterLease> {
    // The installer can already have written a tentative Node pointer. Only
    // closing the inbox commits it; never hand off while the gate still exists.
    match fs::symlink_metadata(cache.join(ROLLBACK_INBOX)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(_) => return Err(io::Error::other("Node Hook cutover has not committed")),
    }
    let package = read_bounded(&version.join("package.json"), 64 * 1024)?;
    let package: serde_json::Value = serde_json::from_slice(&package)?;
    let marker = read_bounded(&version.join("VERSION"), 64 * 1024)?;
    let release = std::str::from_utf8(&marker)
        .map_err(io::Error::other)?
        .lines()
        .find_map(|line| line.strip_prefix("version="));
    if package["name"] != "loongsuite-pilot"
        || package["version"].as_str() != release
        || !release.is_some_and(|version| version.starts_with("1."))
    {
        return Err(io::Error::other("invalid installed Node Pilot release"));
    }
    Ok(WriterLease::Node(NodeCutover { cache, version }))
}

fn is_contended(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
}

fn reserve(inbox: &Path, before_reserve: impl FnOnce()) -> io::Result<tempfile::NamedTempFile> {
    check_directory(inbox)?;
    before_reserve();
    tempfile::Builder::new()
        .prefix(&format!("{RESERVATION_PREFIX}{}-", std::process::id()))
        .suffix(".tmp")
        .tempfile_in(inbox)
}

/// Ordinary embedded SDKs have no install binding. For a bound installation,
/// never infer ownership from lock contention alone. Reserving a slot and
/// removing the empty directory are the mutually exclusive outcomes.
#[allow(
    dead_code,
    reason = "shared source is also compiled into the installer"
)]
pub(crate) fn lock_writer(root: &Path) -> io::Result<WriterLease> {
    lock_writer_before_reserve(root, || {})
}

#[allow(
    dead_code,
    reason = "used by the thin Hook and deterministic cutover regression"
)]
pub(crate) fn lock_writer_before_reserve(
    root: &Path,
    before_reserve: impl FnOnce(),
) -> io::Result<WriterLease> {
    let root = root.canonicalize()?;
    let lease = open_file(&root.join(LEASE), true)?;
    let cache = match fs2::FileExt::try_lock_shared(&lease) {
        Ok(()) => bound_cache(&root)?,
        Err(error) if is_contended(&error) => {
            let inbox = transition_inbox(&root)?.ok_or(error)?;
            match reserve(&inbox, before_reserve) {
                Ok(slot) => return Ok(WriterLease::Switching(slot)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // rmdir won before this callback could reserve. It is a
                    // successful handoff, not a dropped capture. Re-read the
                    // result rather than using the pre-cutover pointer.
                    let cache = inbox.parent().expect("install-bound inbox").to_path_buf();
                    match fs2::FileExt::try_lock_shared(&lease) {
                        Ok(()) => Some(cache),
                        Err(error) if is_contended(&error) => {
                            let version = current_version(&cache)?;
                            if is_rust_version(&version)? {
                                return Err(error);
                            }
                            return node_owner(cache, version);
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    if let Some(cache) = cache {
        let version = current_version(&cache)?;
        if !is_rust_version(&version)? {
            return node_owner(cache, version);
        }
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
