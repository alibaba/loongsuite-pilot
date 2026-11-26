//! Isolated ingress for Cursor Hook-only capture. The short-lived Hook publishes
//! a single bounded payload. Assembly and history writes run on the SDK poller.

use super::{cursor_policy, Journal, Obj, Policy};
use crate::hook_process::common::Env;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
#[cfg(test)]
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_INBOX_FILES: usize = 4096;
const FILES_PER_POLL: usize = 64;
const MAX_EVENT_BYTES: u64 = 1024 * 1024;

fn directory(root: &Path) -> PathBuf {
    root.join("state").join("cursor").join("deferred")
}

fn read_deferred_event(path: &Path) -> io::Result<Obj> {
    crate::utils::source_access::private_path(path)?;
    let mut open = fs::OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = open.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Cursor deferred event file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_EVENT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_EVENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Cursor deferred event exceeds the collection budget",
        ));
    }
    let mut raw: Obj = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let Some(Value::Object(payload)) = raw.remove("cursor_hook") else {
        return Ok(raw);
    };
    let mut event = super::to_internal_event(&payload);
    if let Some(ns) = raw.get("captured_ns").and_then(Value::as_i64) {
        let timestamp = chrono::DateTime::from_timestamp_nanos(ns)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        event.insert("_journal_ts".into(), Value::String(timestamp));
    }
    if raw.get("redacted_prompt") == Some(&Value::Bool(true)) {
        event.insert("_pilot_redacted_prompt".into(), Value::Bool(true));
    }
    if raw.get("content_omitted") == Some(&Value::Bool(true))
        || raw.get("redacted_prompt") == Some(&Value::Bool(true))
    {
        cursor_policy::omit_content(&mut event);
    }
    if let Some(resources) = raw.remove("resource_attributes") {
        event.insert("resource_attributes".into(), resources);
    }
    Ok(event)
}

#[cfg(test)]
pub(super) fn enqueue(root: &Path, policy: &Policy, mut event: Obj) -> Result<(), String> {
    if !policy.capture(cursor_policy::variant(event.get("cursor_version"))) {
        cursor_policy::omit_content(&mut event);
    }
    // Native transcript access remains with the direct Hook path. An embedded
    // history SDK must not inherit authority to open arbitrary payload paths.
    event.remove("transcript_path");
    let dir = directory(root).join("inbox");
    crate::utils::source_access::private_path(&dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    crate::utils::source_access::private_path(&dir).map_err(|err| err.to_string())?;
    let pending = fs::read_dir(&dir).map_err(|err| err.to_string())?;
    if pending.take(MAX_INBOX_FILES).count() >= MAX_INBOX_FILES {
        eprintln!("loongsuite-pilot: Cursor deferred event queue is full");
        return Err("Cursor deferred event queue is full".into());
    }
    let encoded = serde_json::to_vec(&event).map_err(|err| err.to_string())?;
    if encoded.len() as u64 > MAX_EVENT_BYTES {
        eprintln!("loongsuite-pilot: Cursor deferred event exceeds the capture budget");
        return Err("Cursor deferred event exceeds the capture budget".into());
    }
    let name = format!(
        "{}-{}.json",
        crate::hook_process::common::now_unix_nanos(),
        uuid::Uuid::new_v4()
    );
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|err| err.to_string())?;
    temp.write_all(&encoded).map_err(|err| err.to_string())?;
    temp.persist_noclobber(dir.join(name))
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// Created only for the authorized standalone Pilot state, never for a
/// history-only policy. The ingress and the active journal are Pilot-owned.
pub(crate) struct DeferredCursor {
    root: PathBuf,
    transcript_root: Option<PathBuf>,
    recovered: Mutex<bool>,
}

impl DeferredCursor {
    pub(crate) fn new(root: PathBuf, transcript_root: Option<PathBuf>) -> Self {
        Self {
            root,
            transcript_root,
            recovered: Mutex::new(false),
        }
    }

    pub(crate) fn collect(&self) -> Result<(), String> {
        let root = &self.root;
        let dir = directory(root);
        let inbox = dir.join("inbox");
        let transition =
            crate::sdk::hook_ingress::transition_inbox(root).map_err(|err| err.to_string())?;
        let mut paths = Vec::new();
        for source in std::iter::once(&inbox).chain(&transition) {
            crate::utils::source_access::private_path(source).map_err(|err| err.to_string())?;
            let scanned = if source == &inbox {
                fs::read_dir(source)
            } else {
                crate::utils::source_access::read_dir(source)
            };
            let entries = match scanned {
                Ok(entries) => entries,
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => return Err(err.to_string()),
            };
            for entry in entries.take(MAX_INBOX_FILES) {
                let entry = entry.map_err(|err| err.to_string())?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".json") && (source == &inbox || name.starts_with("cursor-")) {
                    paths.push(entry.path());
                }
            }
        }
        let mut recovered = self.recovered.lock().map_err(|err| err.to_string())?;
        if paths.is_empty() && *recovered {
            return Ok(());
        }
        paths.sort_by_cached_key(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            name.strip_prefix("cursor-").unwrap_or(&name).to_owned()
        });
        let journal = Journal { dir };
        let env = Env::from([(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        let policy = Policy::load(root, &env);
        let mut current = Vec::new();
        let mut accepted = journal
            .read_all()?
            .iter()
            .filter_map(|event| event.get("_pilot_receipt").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        for path in paths.into_iter().take(FILES_PER_POLL) {
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if accepted.insert(id.to_owned()) {
                let mut event = match read_deferred_event(&path) {
                    Ok(event) => event,
                    Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                        // Cache and data directories can live on separate
                        // filesystems. Quarantine next to the source inbox.
                        let base = path
                            .parent()
                            .and_then(Path::parent)
                            .ok_or("Cursor inbox path has no parent")?;
                        let quarantine = base.join(if path.starts_with(&inbox) {
                            "quarantine"
                        } else {
                            ".sdk-hook-rollback-quarantine"
                        });
                        crate::utils::source_access::private_path(&quarantine)
                            .map_err(|err| err.to_string())?;
                        fs::create_dir_all(&quarantine).map_err(|err| err.to_string())?;
                        let target = quarantine.join(format!("{}-{id}", uuid::Uuid::new_v4()));
                        fs::rename(&path, &target).map_err(|err| err.to_string())?;
                        crate::utils::create_logger("CursorHook").warn(
                            &format!(
                                "quarantined invalid Cursor deferred event at {}: {error}",
                                target.display()
                            ),
                            None,
                        );
                        continue;
                    }
                    Err(error) => return Err(error.to_string()),
                };
                let authorized = self.transcript_root.as_deref().is_some_and(|root| {
                    event
                        .get("transcript_path")
                        .and_then(Value::as_str)
                        .is_some_and(|path| {
                            let path = Path::new(path);
                            path.is_absolute()
                                && crate::utils::source_access::private_path(path).is_ok()
                                && root
                                    .canonicalize()
                                    .ok()
                                    .zip(path.canonicalize().ok())
                                    .is_some_and(|(root, path)| path.starts_with(root))
                        })
                });
                if !authorized {
                    event.remove("transcript_path");
                }
                event.insert("_pilot_receipt".into(), Value::String(id.into()));
                event
                    .entry("_journal_id")
                    .or_insert_with(|| format!("inbox:{id}").into());
                journal.append_with_policy(&mut event, Some(&policy))?;
                if event.get("hook_event").and_then(Value::as_str) == Some("stop") {
                    current.push(event);
                }
            }
            // After a process restart, an already imported but not yet unlinked
            // receipt is recognized from the active journal.
            fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        *recovered = false;
        if policy.available() {
            journal.assemble_pending(root, &policy, &current)?;
            *recovered = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook_process::common::HookRequest;

    #[test]
    fn cursor_deferred_hook_only_enqueues_and_keeps_recovery() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let env = Env::from([(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        for (event, field, value) in [
            ("beforeSubmitPrompt", "prompt", "test prompt"),
            ("afterAgentResponse", "text", "test response"),
            ("stop", "status", "completed"),
        ] {
            let mut body = serde_json::json!({"hook_event_name":event,
                "conversation_id":"test-turn","generation_id":"g1","model":"test"});
            body[field] = Value::String(value.into());
            let bytes = serde_json::to_vec(&body).unwrap();
            let mut stdout = Vec::new();
            assert_eq!(
                super::super::run(&mut HookRequest {
                    args: &["--defer-assembly".into()],
                    stdin: &bytes,
                    env: &env,
                    stdout: &mut stdout,
                }),
                0
            );
            assert_eq!(stdout, b"{}\n");
        }
        let history = root.join("logs/cursor/history");
        assert!(!history.exists());
        let deferred = directory(&root);
        let invalid = deferred.join("inbox/0-truncated.json");
        fs::write(&invalid, b"{\"hook_event\":\"stop\"").unwrap();
        DeferredCursor::new(root.clone(), None).collect().unwrap();
        assert!(!invalid.exists());
        let quarantined = fs::read_dir(deferred.join("quarantine"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(quarantined.path()).unwrap(),
            b"{\"hook_event\":\"stop\""
        );
        let file = fs::read_dir(history)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .expect("Cursor history JSONL was written");
        let first = fs::read(&file).unwrap();
        assert_ne!(first.len(), 0);
        assert!(String::from_utf8_lossy(&first).contains("test response"));
        DeferredCursor::new(root, None).collect().unwrap();
        assert_eq!(fs::read(file).unwrap(), first);
    }
}
