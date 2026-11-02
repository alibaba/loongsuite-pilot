//! Short, process-owned metadata gate shared by native Hook publication and ACK.
use std::path::Path;
use std::time::{Duration, Instant};

/// None means the metadata gate was unavailable. Never unlink the database:
/// doing so while another process holds it would create a second lock domain.
/// The caller action must perform only short metadata publication/reclamation.
pub fn with_qoder_wakeup_lock<T>(
    directory: &Path,
    wait_ms: u64,
    action: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<Option<T>> {
    use rusqlite::{Connection, Error, ErrorCode, OpenFlags};
    let deadline = Instant::now() + Duration::from_millis(wait_ms.min(25));
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    if builder.create(directory).is_err() {
        return Ok(None);
    }
    let file = directory.join(".wakeup-gate.sqlite");
    let mut create = std::fs::OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create.mode(0o600);
    }
    match create.open(&file) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Ok(None),
    }
    if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let Ok(database) = Connection::open_with_flags(&file, flags) else {
        return Ok(None);
    };
    if database.busy_timeout(Duration::ZERO).is_err() {
        return Ok(None);
    }
    loop {
        match database.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => break,
            Err(Error::SqliteFailure(code, _))
                if matches!(
                    code.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return Ok(None);
                };
                if remaining.is_zero() {
                    return Ok(None);
                }
                std::thread::sleep(remaining.min(Duration::from_millis(5)));
            }
            Err(_) => return Ok(None),
        }
    }
    let result = action();
    let _ = database.execute_batch("ROLLBACK");
    result.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_sqlite_connections_share_a_persistent_gate_and_release_after_error() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("source");
        let result = with_qoder_wakeup_lock(&directory, 25, || {
            assert!(with_qoder_wakeup_lock(&directory, 0, || Ok(99))?.is_none());
            Err::<(), _>(anyhow::anyhow!("fixture publication failed"))
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("fixture publication failed"));
        let gate = directory.join(".wakeup-gate.sqlite");
        let first =
            crate::utils::file_identity::identity_from_open(&std::fs::File::open(&gate).unwrap())
                .unwrap();
        assert_eq!(
            with_qoder_wakeup_lock(&directory, 0, || Ok(42)).unwrap(),
            Some(42)
        );
        let after =
            crate::utils::file_identity::identity_from_open(&std::fs::File::open(&gate).unwrap())
                .unwrap();
        assert_eq!((first.dev, first.ino), (after.dev, after.ino));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&gate).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_never_accepted_as_the_gate_database() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("source");
        std::fs::create_dir(&directory).unwrap();
        let foreign = root.path().join("foreign");
        std::fs::write(&foreign, b"preserve").unwrap();
        std::os::unix::fs::symlink(&foreign, directory.join(".wakeup-gate.sqlite")).unwrap();
        assert!(with_qoder_wakeup_lock(&directory, 25, || Ok(()))
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read(foreign).unwrap(), b"preserve");
    }
}
