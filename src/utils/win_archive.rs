//! Port of `src/utils/win-archive.ts`.

use super::logger::create_logger;
use serde_json::{Map, Value};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use uuid::Uuid;

static ASCII_TEMP: Mutex<Option<String>> = Mutex::new(None);
static FORCE_ACL_FAILURE: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub struct WinArchiveError(pub String);

impl std::fmt::Display for WinArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WinArchiveError {}

/// Printable ASCII only — the same test the installers use (`[^\x20-\x7E]`).
pub fn is_ascii_path(path: &str) -> bool {
    path.chars().all(|ch| ('\u{20}'..='\u{7e}').contains(&ch))
}

pub async fn get_ascii_temp_root() -> String {
    if let Some(cached) = ASCII_TEMP
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
    {
        return cached;
    }
    let base = std::env::temp_dir().to_string_lossy().into_owned();
    if !cfg!(windows) || is_ascii_path(&base) {
        *ASCII_TEMP.lock().unwrap_or_else(|err| err.into_inner()) = Some(base.clone());
        return base;
    }
    let mut candidates = Vec::new();
    if let Ok(system_root) = std::env::var("SystemRoot") {
        candidates.push(
            Path::new(&system_root)
                .join("Temp")
                .to_string_lossy()
                .into_owned(),
        );
    }
    if let Ok(system_drive) = std::env::var("SystemDrive") {
        candidates.push(format!("{system_drive}\\loongsuite-pilot-tmp"));
    }
    candidates.push(r"C:\Windows\Temp".to_string());
    for candidate in candidates {
        if !is_ascii_path(&candidate) {
            continue;
        }
        if probe_temp(&candidate).await.is_ok() {
            *ASCII_TEMP.lock().unwrap_or_else(|err| err.into_inner()) = Some(candidate.clone());
            return candidate;
        }
    }
    let mut meta = Map::new();
    meta.insert("base".into(), Value::String(base.clone()));
    create_logger("WinArchive").warn(
        "no writable ASCII temp root found, tar staging may fail",
        Some(&meta),
    );
    *ASCII_TEMP.lock().unwrap_or_else(|err| err.into_inner()) = Some(base.clone());
    base
}

async fn probe_temp(candidate: &str) -> io::Result<()> {
    tokio::fs::create_dir_all(candidate).await?;
    let probe = Path::new(candidate).join(format!("pilot-w-{}.tmp", std::process::id()));
    tokio::fs::write(&probe, b"1").await?;
    let _ = tokio::fs::remove_file(probe).await;
    Ok(())
}

pub async fn make_tar_staging_dir(preferred: &str) -> String {
    if is_ascii_path(preferred) {
        let _ = tokio::fs::create_dir_all(preferred).await;
        return preferred.to_string();
    }
    let root = get_ascii_temp_root().await;
    let base = Path::new(preferred)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download-tmp");
    let safe: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let n = (Uuid::new_v4().as_u128() % 1_000_000) as u32;
    let dir = Path::new(&root).join(format!("pilot-{safe}-{}-{n}", std::process::id()));
    let dir_s = dir.to_string_lossy().into_owned();
    rm_rf(&dir_s).await;
    let _ = tokio::fs::create_dir_all(&dir).await;
    dir_s
}

pub async fn extract_tar_gz(
    archive: &str,
    dest_dir: &str,
    timeout_ms: u64,
) -> Result<(), WinArchiveError> {
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    if cfg!(windows) {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        candidates.push((
            Path::new(&system_root)
                .join("System32")
                .join("tar.exe")
                .to_string_lossy()
                .into_owned(),
            vec!["-xzf".into(), archive.into(), "-C".into(), dest_dir.into()],
        ));
        candidates.push((
            "tar".into(),
            vec![
                "-xzf".into(),
                archive.into(),
                "-C".into(),
                dest_dir.into(),
                "--force-local".into(),
            ],
        ));
    } else {
        candidates.push((
            "tar".into(),
            vec!["-xzf".into(), archive.into(), "-C".into(), dest_dir.into()],
        ));
    }
    let logger = create_logger("WinArchive");
    let mut last_err = WinArchiveError("tar extraction failed".into());
    for (bin, args) in candidates {
        match run_tar(&bin, &args, timeout_ms).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                let mut meta = Map::new();
                meta.insert("tar".into(), Value::String(bin));
                meta.insert("error".into(), Value::String(format!("Error: {err}")));
                logger.warn("tar extraction attempt failed", Some(&meta));
                last_err = WinArchiveError(err.to_string());
            }
        }
    }
    Err(last_err)
}

async fn run_tar(bin: &str, args: &[String], timeout_ms: u64) -> io::Result<()> {
    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let finished =
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), child.wait()).await;
    match finished {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(io::Error::other(format!(
            "tar exited {}",
            status.code().unwrap_or(-1)
        ))),
        Ok(Err(err)) => Err(err),
        Err(_) => {
            let _ = child.kill().await;
            Err(io::Error::other(format!(
                "tar timed out after {timeout_ms}ms"
            )))
        }
    }
}

pub async fn reset_inherited_acl(dir: &str) -> bool {
    if FORCE_ACL_FAILURE.load(Ordering::SeqCst) {
        return false;
    }
    if !cfg!(windows) {
        return true;
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let icacls = Path::new(&system_root)
        .join("System32")
        .join("icacls.exe")
        .to_string_lossy()
        .into_owned();
    match run_tar(
        &icacls,
        &[
            dir.to_string(),
            "/reset".into(),
            "/T".into(),
            "/C".into(),
            "/Q".into(),
        ],
        120_000,
    )
    .await
    {
        Ok(()) => true,
        Err(err) => {
            let mut meta = Map::new();
            meta.insert("dir".into(), Value::String(dir.to_string()));
            meta.insert("error".into(), Value::String(format!("Error: {err}")));
            create_logger("WinArchive").warn("could not reset inherited ACL", Some(&meta));
            false
        }
    }
}

pub async fn replace_dir_with(staged: &str, dest: &str) -> Result<(), WinArchiveError> {
    rm_rf(dest).await;
    let renamed = match tokio::fs::rename(staged, dest).await {
        Ok(()) => true,
        Err(err) if is_exdev(&err) => {
            copy_tree(Path::new(staged), Path::new(dest))
                .map_err(|err| WinArchiveError(err.to_string()))?;
            rm_rf(staged).await;
            false
        }
        Err(err) => return Err(WinArchiveError(err.to_string())),
    };
    if renamed && !reset_inherited_acl(dest).await {
        rm_rf(dest).await;
        return Err(WinArchiveError(format!(
            "could not reset inherited ACL on {dest}, discarded it"
        )));
    }
    Ok(())
}

async fn rm_rf(path: &str) {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) if meta.is_dir() => {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(path).await;
        }
        Err(_) => {}
    }
}

fn copy_tree(src: &Path, dest: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in walkdir::WalkDir::new(src) {
        let entry = entry.map_err(io::Error::other)?;
        let relative = entry.path().strip_prefix(src).unwrap_or(entry.path());
        let target = dest.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn is_exdev(err: &io::Error) -> bool {
    err.raw_os_error() == Some(18) || err.kind() == io::ErrorKind::CrossesDevices
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::Mutex;

    static REPLACE_LOCK: Mutex<()> = Mutex::const_new(());

    #[test]
    fn accepts_printable_ascii_and_rejects_anything_else() {
        assert!(is_ascii_path(r"C:\Users\lee\.loongsuite-pilot"));
        assert!(is_ascii_path("/tmp/pilot-node-modules"));
        assert!(!is_ascii_path("C:\\Users\\张三\\.loongsuite-pilot"));
        assert!(!is_ascii_path(r"C:\Users\太业.IZ1QMOR6W7C4BKZ\versions"));
        assert!(!is_ascii_path("C:\\a\tb"));
    }

    #[tokio::test]
    async fn keeps_an_ascii_preference_as_is() {
        let base = tempfile::tempdir().unwrap();
        let preferred = base.path().join("download-tmp");
        let dir = make_tar_staging_dir(preferred.to_str().unwrap()).await;
        assert_eq!(dir, preferred.to_str().unwrap());
        assert!(tokio::fs::metadata(&dir).await.unwrap().is_dir());
    }

    #[tokio::test]
    async fn redirects_a_non_ascii_preference_to_an_ascii_root() {
        let base = tempfile::tempdir().unwrap();
        let preferred = base.path().join("李四").join("download-tmp");
        let dir = make_tar_staging_dir(preferred.to_str().unwrap()).await;
        assert_ne!(dir, preferred.to_str().unwrap());
        assert!(is_ascii_path(&dir));
        assert!(tokio::fs::metadata(&dir).await.unwrap().is_dir());
        rm_rf(&dir).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replaces_an_existing_destination_with_the_staged_tree() {
        let _lock = REPLACE_LOCK.lock().await;
        FORCE_ACL_FAILURE.store(false, Ordering::SeqCst);
        let base = tempfile::tempdir().unwrap();
        let staged = base.path().join("stage").join("node_modules");
        tokio::fs::create_dir_all(&staged).await.unwrap();
        tokio::fs::write(staged.join("new.txt"), "new")
            .await
            .unwrap();
        let dest = base.path().join("node_modules");
        tokio::fs::create_dir_all(&dest).await.unwrap();
        tokio::fs::write(dest.join("stale.txt"), "stale")
            .await
            .unwrap();
        replace_dir_with(staged.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(dest.join("new.txt"))
                .await
                .unwrap(),
            "new"
        );
        assert!(tokio::fs::metadata(dest.join("stale.txt")).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discards_the_tree_and_throws_when_the_inherited_acl_cannot_be_repaired() {
        let _lock = REPLACE_LOCK.lock().await;
        FORCE_ACL_FAILURE.store(true, Ordering::SeqCst);
        let base = tempfile::tempdir().unwrap();
        let staged = base.path().join("stage");
        tokio::fs::create_dir_all(&staged).await.unwrap();
        tokio::fs::write(staged.join("new.txt"), "new")
            .await
            .unwrap();
        let dest = base.path().join("node_modules");
        let err = replace_dir_with(staged.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap_err();
        FORCE_ACL_FAILURE.store(false, Ordering::SeqCst);
        assert!(err.to_string().contains("could not reset inherited ACL on"));
        assert!(err.to_string().contains("discarded it"));
        assert!(tokio::fs::metadata(&dest).await.is_err());
    }

    #[test]
    fn native_update_extracts_inside_unicode_parent_without_touching_existing_install() {
        use crate::updater::{unpack_release_archive, ArchiveFormat};
        use std::io::{Cursor, Write};

        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("张三 安装 🚀");
        std::fs::create_dir(&parent).unwrap();
        let current = parent.join("current");
        std::fs::write(&current, "existing-version").unwrap();
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in [
            ("pkg/runtime-manifest.json", "{}"),
            ("pkg/bin/pilot.exe", "candidate"),
        ] {
            archive
                .start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(bytes.as_bytes()).unwrap();
        }
        let bytes = archive.finish().unwrap().into_inner();
        let unpacked = unpack_release_archive(&bytes, ArchiveFormat::Zip, &parent, "pkg").unwrap();
        assert!(unpacked.root.starts_with(&parent));
        assert_eq!(
            std::fs::read(unpacked.root.join("bin/pilot.exe")).unwrap(),
            b"candidate"
        );
        assert_eq!(std::fs::read(&current).unwrap(), b"existing-version");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::metadata(unpacked.root.parent().unwrap())
                .unwrap()
                .permissions();
            assert_eq!(permissions.mode() & 0o077, 0);
        }
        drop(unpacked);
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 1);
        let corrupt = &bytes[..bytes.len() / 2];
        assert!(unpack_release_archive(corrupt, ArchiveFormat::Zip, &parent, "pkg").is_err());
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 1);
        assert_eq!(std::fs::read(current).unwrap(), b"existing-version");
    }
}
