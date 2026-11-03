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

const MAX_WAKEUP_BYTES: usize = 16 * 1024;
const MAX_WAKEUPS_PER_SOURCE: usize = 128;

fn json_digest(value: &serde_json::Value) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}
fn bounded_string(value: Option<&serde_json::Value>, limit: usize) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= limit)
}
fn private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
fn lexical_absolute(path: &Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}
fn canonical_source_path(path: &Path) -> std::io::Result<std::path::PathBuf> {
    let mut candidate = lexical_absolute(path);
    let mut suffix = Vec::new();
    for _ in 0..64 {
        match std::fs::canonicalize(&candidate) {
            Ok(mut base) => {
                for part in suffix.iter().rev() {
                    base.push(part);
                }
                #[cfg(windows)]
                {
                    let text = base.to_string_lossy();
                    if let Some(tail) = text.strip_prefix(r"\\?\UNC\") {
                        return Ok(std::path::PathBuf::from(format!(r"\\{tail}")));
                    }
                    if let Some(tail) = text.strip_prefix(r"\\?\") {
                        return Ok(std::path::PathBuf::from(tail));
                    }
                }
                return Ok(base);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::symlink_metadata(&candidate) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        let link = std::fs::read_link(&candidate)?;
                        candidate = lexical_absolute(&if link.is_absolute() {
                            link
                        } else {
                            candidate.parent().unwrap_or(Path::new("/")).join(link)
                        });
                        continue;
                    }
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(error)
                    }
                    _ => {}
                }
                let name = candidate.file_name().ok_or(error)?.to_os_string();
                let Some(parent) = candidate.parent() else {
                    return Err(std::io::Error::other("source path has no parent"));
                };
                suffix.push(name);
                candidate = parent.to_path_buf();
            }
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other(
        "source path exceeds normalization budget",
    ))
}
fn atomic_metadata(file: &Path, value: &serde_json::Value, exclusive: bool) -> anyhow::Result<()> {
    use std::io::Write;
    let parent = file
        .parent()
        .ok_or_else(|| anyhow::anyhow!("metadata path has no parent"))?;
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    struct RemoveTemporary(std::path::PathBuf);
    impl Drop for RemoveTemporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _temporary = RemoveTemporary(temporary.clone());
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut output = open.open(&temporary)?;
    output.write_all(&serde_json::to_vec(value)?)?;
    drop(output);
    if exclusive {
        match std::fs::hard_link(&temporary, file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    } else {
        std::fs::rename(&temporary, file)?;
    }
    Ok(())
}
fn warn_capacity(root: &Path, reason: &str) {
    let Some(parent) = root.parent() else {
        return;
    };
    let file = parent.join("capacity.json");
    if std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(60))
    {
        return;
    }
    let _ = atomic_metadata(
        &file,
        &serde_json::json!({"schema":1,"reason":reason,"observedAt":now_ms()}),
        false,
    );
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn truthy(value: Option<&serde_json::Value>) -> bool {
    use serde_json::Value;
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(v)) => !v.is_empty(),
        Some(_) => true,
    }
}

/// Publish only bounded metadata. Neither transcript contents nor prompt/tool
/// values are read or copied. The descriptor is not a transcript cursor ACK.
pub fn publish_qoder_wakeup(
    payload: &serde_json::Value,
    data: &Path,
    agent: &str,
    identity: Option<&serde_json::Value>,
    resources: &serde_json::Map<String, serde_json::Value>,
    spans: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    publish_inner(payload, data, agent, identity, resources, spans).unwrap_or(false)
}
fn publish_inner(
    payload: &serde_json::Value,
    data: &Path,
    agent: &str,
    identity: Option<&serde_json::Value>,
    resources: &serde_json::Map<String, serde_json::Value>,
    spans: &serde_json::Map<String, serde_json::Value>,
) -> anyhow::Result<bool> {
    use serde_json::{json, Value};
    if !matches!(agent, "qoder" | "qoder-cn") || truthy(payload.get("stop_hooks_active")) {
        return Ok(false);
    }
    let Some(session) = bounded_string(
        payload
            .get("session_id")
            .filter(|v| !v.is_null())
            .or_else(|| payload.get("conversation_id")),
        512,
    ) else {
        return Ok(false);
    };
    let Some(supplied) = bounded_string(payload.get("transcript_path"), 4096) else {
        return Ok(false);
    };
    if !Path::new(supplied).is_absolute() {
        return Ok(false);
    }
    let path = canonical_source_path(Path::new(supplied))?;
    let stat = match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => Some(meta),
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let transcript = path.to_string_lossy();
    let root = data
        .join("state/qoder-transcripts")
        .join(agent)
        .join("sources");
    private_directory(&root)?;
    let key = json_digest(&json!([session, transcript]))?;
    let directory = root.join(&key);
    private_directory(&directory)?;
    let event = bounded_string(payload.get("hook_event_name"), 64)
        .filter(|e| {
            matches!(
                *e,
                "SessionStart"
                    | "UserPromptSubmit"
                    | "PreToolUse"
                    | "PostToolUse"
                    | "Stop"
                    | "SessionEnd"
            )
        })
        .unwrap_or("Stop");
    let mut record = json!({"schema":1,"key":key,"agentId":agent,"sessionId":session,
        "transcriptPath":transcript,"event":event,"observationId":uuid::Uuid::new_v4().to_string(),
        "observedSize":stat.as_ref().map_or(0,|m|m.len()),"observedAt":now_ms(),
        "resourceAttributes":resources,"spanAttributes":spans});
    if transcript != supplied {
        record["suppliedPath"] = json!(supplied);
    }
    #[cfg(unix)]
    if let Some(meta) = &stat {
        use std::os::unix::fs::MetadataExt;
        record["inode"] = json!(meta.ino());
    }
    #[cfg(windows)]
    if stat.is_some() {
        use std::os::windows::fs::OpenOptionsExt;
        // Attribute-only handle: publication never asks for transcript body access.
        let opened = std::fs::OpenOptions::new().access_mode(0x80).open(&path)?;
        let identity = crate::utils::file_identity::identity_from_open(&opened)?;
        record["inode"] = json!(identity.ino);
        record["observedSize"] = json!(identity.size);
    }
    if let Some(value) = bounded_string(payload.get("request_set_id"), 512) {
        record["requestSetId"] = json!(value);
    }
    if let Some(value) = bounded_string(payload.get("cwd"), 4096) {
        record["cwd"] = json!(value);
    }
    if payload
        .pointer("/parent_business_info/product")
        .and_then(Value::as_str)
        == Some("app")
    {
        record["desktop"] = json!(true);
    }
    if let Some(value) = identity.filter(|v| !v.is_null()) {
        record["userIdentity"] = value.clone();
    }
    if let Some(value) = payload
        .get("legacy_trigger_line")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= 9_007_199_254_740_991.0)
    {
        record["legacyTriggerLine"] = json!(value as u64);
    }
    if serde_json::to_vec(&record)?.len() > MAX_WAKEUP_BYTES {
        warn_capacity(&root, "metadata-bytes");
        return Ok(false);
    }
    let descriptor = directory.join("source.json");
    if !descriptor.exists() {
        atomic_metadata(&descriptor, &record, true)?;
    }
    let events = directory.join("events");
    private_directory(&events)?;
    let context = json_digest(&json!([
        record.get("userIdentity"),
        record.get("desktop"),
        record.get("cwd"),
        record["spanAttributes"],
        record["resourceAttributes"],
        record.get("legacyTriggerLine"),
        record.get("requestSetId")
    ]))?;
    let destination = events.join(format!(
        "{}-{event}-{}.json",
        record["observedSize"],
        &context[..24]
    ));
    let published = with_qoder_wakeup_lock(&directory, 25, || {
        if !destination.exists() {
            let mut count = 0;
            for entry in std::fs::read_dir(&events)? {
                let entry = entry?;
                if !entry.file_name().to_string_lossy().starts_with('.') {
                    count += 1;
                    if count >= MAX_WAKEUPS_PER_SOURCE {
                        warn_capacity(&root, "context-limit");
                        return Ok(false);
                    }
                }
            }
        }
        atomic_metadata(&destination, &record, false)?;
        Ok(true)
    })?;
    if published.is_none() {
        warn_capacity(&root, "context-lock");
    }
    Ok(published.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    fn publisher_fixture() -> (tempfile::TempDir, std::path::PathBuf, serde_json::Value) {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("native transcript.jsonl");
        std::fs::write(&transcript, b"private-transcript-body-not-metadata").unwrap();
        let payload = serde_json::json!({"session_id":"session","transcript_path":transcript,
            "hook_event_name":"Stop","tool_input":"private-tool-input","prompt":"private-prompt"});
        (root, transcript, payload)
    }
    fn source_directory(data: &Path) -> std::path::PathBuf {
        std::fs::read_dir(data.join("state/qoder-transcripts/qoder/sources"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    }
    #[test]
    fn publisher_coalesces_context_without_copying_payload_or_acknowledging_transcript() {
        use serde_json::json;
        let (root, transcript, mut payload) = publisher_fixture();
        let data = root.path().join("data");
        let attrs = serde_json::Map::new();
        assert!(publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        let directory = source_directory(&data);
        let first = std::fs::read(directory.join("source.json")).unwrap();
        let descriptor: serde_json::Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(descriptor["schema"], 1);
        assert_eq!(descriptor["sessionId"], "session");
        assert_eq!(
            descriptor["observedSize"],
            std::fs::metadata(&transcript).unwrap().len()
        );
        for _ in 0..3 {
            assert!(publish_qoder_wakeup(
                &payload, &data, "qoder", None, &attrs, &attrs
            ));
        }
        assert_eq!(
            std::fs::read_dir(directory.join("events")).unwrap().count(),
            1
        );
        assert_eq!(std::fs::read(directory.join("source.json")).unwrap(), first);
        payload["request_set_id"] = json!("new-context");
        assert!(publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        assert_eq!(
            std::fs::read_dir(directory.join("events")).unwrap().count(),
            2
        );
        for entry in std::fs::read_dir(directory.join("events")).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(bytes.len() <= MAX_WAKEUP_BYTES);
            let text = String::from_utf8(bytes).unwrap();
            for secret in [
                "private-transcript-body",
                "private-tool-input",
                "private-prompt",
            ] {
                assert!(!text.contains(secret));
            }
        }
        assert!(
            !data.join("hooks").exists(),
            "publisher must not write legacy line cursors/history"
        );
        assert_eq!(
            std::fs::read(&transcript).unwrap(),
            b"private-transcript-body-not-metadata"
        );
    }
    #[test]
    fn publisher_keeps_the_original_128_context_bound_and_16k_metadata_bound() {
        use serde_json::json;
        let (root, _, mut payload) = publisher_fixture();
        let data = root.path().join("data");
        let attrs = serde_json::Map::new();
        for index in 0..MAX_WAKEUPS_PER_SOURCE {
            payload["request_set_id"] = json!(format!("request-{index}"));
            assert!(publish_qoder_wakeup(
                &payload, &data, "qoder", None, &attrs, &attrs
            ));
        }
        payload["request_set_id"] = json!("overflow");
        assert!(!publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        let directory = source_directory(&data);
        assert_eq!(
            std::fs::read_dir(directory.join("events")).unwrap().count(),
            128
        );
        payload["request_set_id"] = json!("request-0");
        assert!(publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        let mut oversized = serde_json::Map::new();
        oversized.insert("large".into(), json!("x".repeat(16 * 1024)));
        let oversized_data = root.path().join("oversized");
        assert!(!publish_qoder_wakeup(
            &payload,
            &oversized_data,
            "qoder",
            None,
            &oversized,
            &attrs
        ));
        assert!(!source_directory(&oversized_data)
            .join("source.json")
            .exists());
    }
    #[cfg(unix)]
    #[test]
    fn canonical_aliases_and_not_yet_created_sources_share_a_key_without_opening_fifos() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("alias");
        let target = root.path().join("not-yet-created");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let data = root.path().join("data");
        let attrs = serde_json::Map::new();
        let mut payload = json!({"session_id":null,"conversation_id":"future","transcript_path":alias.join("nested/file.jsonl")});
        assert!(publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        let directory = source_directory(&data);
        std::fs::create_dir_all(target.join("nested")).unwrap();
        std::fs::write(target.join("nested/file.jsonl"), b"one\n").unwrap();
        payload["transcript_path"] = json!(target.join("nested/file.jsonl"));
        assert!(publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
        assert_eq!(source_directory(&data), directory);
        let fifo = root.path().join("named-pipe");
        let native = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
        payload["transcript_path"] = json!(fifo);
        assert!(!publish_qoder_wakeup(
            &payload, &data, "qoder", None, &attrs, &attrs
        ));
    }

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

#[cfg(test)]
mod native_file_identity_contracts {
    use super::*;
    #[test]
    fn real_publication_records_the_opened_file_identity_and_its_size_on_every_platform() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("identity.jsonl");
        std::fs::write(&file, b"{}\n").unwrap();
        let metadata =
            crate::utils::file_identity::identity_from_open(&std::fs::File::open(&file).unwrap())
                .unwrap();
        let empty = serde_json::Map::new();
        assert!(publish_qoder_wakeup(
            &serde_json::json!({"session_id":"fixture","transcript_path":file,"hook_event_name":"Stop"}),
            root.path(),
            "qoder",
            None,
            &empty,
            &empty
        ));
        let sources = root.path().join("state/qoder-transcripts/qoder/sources");
        let directory = std::fs::read_dir(sources)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let source: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("source.json")).unwrap()).unwrap();
        assert_eq!(source["inode"].as_u64(), Some(metadata.ino));
        assert_eq!(source["observedSize"].as_u64(), Some(metadata.size));
    }
}
