//! Raw source files retain their identity across rotation.
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

pub(crate) const SEGMENT_BYTES: u64 = 100 * 1024 * 1024;
pub(crate) const CYCLE_BYTES: u64 = 8 * 1024 * 1024;
static SEGMENT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^(.*)\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$").unwrap());

pub(crate) fn segment(name: &str) -> Option<(&str, u64)> {
    let caps = SEGMENT.captures(name)?;
    Some((caps.get(1)?.as_str(), caps.get(2)?.as_str().parse().ok()?))
}

pub(crate) async fn daily_files(dir: &Path, prefix: &str) -> anyhow::Result<Vec<String>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        if let Some(name) = name.to_str().filter(|name| day(name, prefix).is_some()) {
            if entry.file_type().await?.is_file() {
                names.push(name.to_owned());
            }
        }
    }
    names.sort_by_cached_key(|name| (base_name(name), segment(name).map_or(0, |(_, seq)| seq)));
    Ok(names)
}

pub(crate) fn base_name(name: &str) -> String {
    segment(name).map_or_else(|| name.to_owned(), |(stem, _)| format!("{stem}.jsonl"))
}

pub(crate) fn day<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    let name = segment(name)
        .map(|(stem, _)| stem)
        .or_else(|| name.strip_suffix(".jsonl"))?;
    let date = name.strip_prefix(prefix)?.strip_prefix('-')?;
    (date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok())
        .then_some(date)
}

pub(crate) fn gate(dir: &Path, wait: Duration) -> anyhow::Result<rusqlite::Connection> {
    let path = dir.join(".raw-source-gate.sqlite");
    let mut create = OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create.mode(0o600);
    }
    match create.open(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    anyhow::ensure!(
        crate::utils::runtime_paths::runtime_metadata(&path)?.is_file(),
        "invalid raw source lock"
    );
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(wait)?;
    connection.execute_batch("BEGIN IMMEDIATE")?;
    // Closing the connection releases its transaction without unlinking the lock.
    Ok(connection)
}

pub(crate) fn active(base: &Path) -> anyhow::Result<Option<String>> {
    let pointer = pointer_path(base);
    match fs::symlink_metadata(&pointer) {
        Ok(meta) => anyhow::ensure!(
            meta.is_file() && meta.len() <= 1024,
            "invalid raw source pointer"
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut name = String::new();
    fs::File::open(pointer)?
        .take(1025)
        .read_to_string(&mut name)?;
    let (stem, sequence) =
        segment(&name).ok_or_else(|| anyhow::anyhow!("invalid raw source pointer"))?;
    anyhow::ensure!(
        sequence > 0
            && Some(stem) == base.file_stem().and_then(|v| v.to_str())
            && !name.contains(['/', '\\']),
        "invalid raw source pointer"
    );
    Ok(Some(name))
}

fn pointer_path(base: &Path) -> PathBuf {
    let mut path = base.as_os_str().to_owned();
    path.push(".active");
    path.into()
}

pub(crate) fn append(base: &Path, body: &[u8]) -> anyhow::Result<()> {
    append_with_limit(base, body, SEGMENT_BYTES, None)
}

pub(crate) fn append_diagnostic(base: &Path, body: &[u8]) -> anyhow::Result<()> {
    append_with_limit(base, body, 10 * 1024 * 1024, Some(100 * 1024 * 1024))
}

fn append_with_limit(
    base: &Path,
    body: &[u8],
    limit: u64,
    diagnostic_budget: Option<u64>,
) -> anyhow::Result<()> {
    let dir = base
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing raw source directory"))?;
    fs::create_dir_all(dir)?;
    let _gate = gate(dir, Duration::from_secs(15))?;
    let previous = active(base)?;
    let mut target = previous
        .as_ref()
        .map_or_else(|| base.to_owned(), |name| dir.join(name));
    let size = match fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => anyhow::bail!("invalid raw source file"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    let mut options = OpenOptions::new();
    options.append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    if size > 0 && size.saturating_add(body.len() as u64) > limit {
        let next = previous
            .as_deref()
            .and_then(segment)
            .map_or(1, |(_, seq)| seq + 1);
        anyhow::ensure!(next < 1_000_000_000_000, "raw source sequence exhausted");
        let stem = base
            .file_stem()
            .and_then(|v| v.to_str())
            .ok_or_else(|| anyhow::anyhow!("invalid raw source name"))?;
        let name = format!(
            "{stem}.segment-{next:012}-{}.jsonl",
            uuid::Uuid::new_v4().simple()
        );
        let pointer = pointer_path(base);
        let temporary = dir.join(format!(
            ".raw-pointer-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        target = dir.join(&name);
        options.create_new(true).open(&target)?;
        let result = (|| -> io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(name.as_bytes())?;
            drop(file);
            fs::rename(&temporary, pointer)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        options.create_new(false);
    }
    let mut file = options.create(true).open(&target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(body)?;
    if let Some(maximum) = diagnostic_budget {
        let mut candidates = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let sequence = if base.file_name() == Some(std::ffi::OsStr::new(name)) {
                0
            } else if let Some((stem, sequence)) = segment(name)
                .filter(|(stem, _)| Some(*stem) == base.file_stem().and_then(|s| s.to_str()))
            {
                let _ = stem;
                sequence
            } else {
                continue;
            };
            if entry.file_type()?.is_file() {
                candidates.push((sequence, entry.path(), entry.metadata()?.len()));
            }
        }
        candidates.sort_by_key(|(seq, _, _)| *seq);
        let mut total = candidates
            .iter()
            .fold(0_u64, |sum, (_, _, size)| sum.saturating_add(*size));
        for (_, path, bytes) in candidates {
            if total <= maximum {
                break;
            }
            if path != target && fs::remove_file(path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_original_source_and_publishes_a_successor() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("hook-2026-11-01.jsonl");
        append_with_limit(&base, b"first\n", 8, None).unwrap();
        append_with_limit(&base, b"second\n", 8, None).unwrap();
        let name = active(&base).unwrap().unwrap();
        assert_eq!(segment(&name).unwrap().1, 1);
        assert_eq!(fs::read(&base).unwrap(), b"first\n");
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), b"second\n");
    }
}
