//! Isolated ingress for Cursor Hook-only capture. The short-lived Hook publishes
//! a single bounded payload. Assembly and history writes run on the SDK poller.

use super::{assemble_stop, stable_event_key, Env, Journal, Obj};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_INBOX_FILES: usize = 4096;
const FILES_PER_POLL: usize = 64;
const MAX_EVENT_BYTES: u64 = 1024 * 1024;

fn directory(root: &Path) -> PathBuf {
    root.join("state").join("cursor").join("deferred")
}

pub(super) fn enqueue(root: &Path, env: &Env, mut event: Obj) -> Result<(), String> {
    if super::message_capture_disabled(root, env)? {
        for key in [
            "prompt",
            "text",
            "attachments",
            "tool_input",
            "tool_output",
            "error_message",
            "task",
        ] {
            event.remove(key);
        }
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
    recovered: Mutex<bool>,
}

impl DeferredCursor {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            recovered: Mutex::new(false),
        }
    }

    pub(crate) fn collect(&self) -> Result<(), String> {
        let root = &self.root;
        let dir = directory(root);
        let inbox = dir.join("inbox");
        crate::utils::source_access::private_path(&inbox).map_err(|err| err.to_string())?;
        let mut paths = match fs::read_dir(&inbox) {
            Ok(entries) => entries
                .take(MAX_INBOX_FILES)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
                .into_iter()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect::<Vec<_>>(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.to_string()),
        };
        let mut recovered = self.recovered.lock().map_err(|err| err.to_string())?;
        if paths.is_empty() && *recovered {
            return Ok(());
        }
        paths.sort_unstable();
        let journal = Journal { dir };
        let mut events = journal.read_all()?;
        let mut accepted = events
            .iter()
            .filter_map(|event| event.get("_pilot_receipt").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        for path in paths.into_iter().take(FILES_PER_POLL) {
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if accepted.insert(id.to_owned()) {
                let mut open = fs::OpenOptions::new();
                open.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                crate::utils::source_access::private_path(&path).map_err(|err| err.to_string())?;
                let file = open.open(&path).map_err(|err| err.to_string())?;
                if !file.metadata().map_err(|err| err.to_string())?.is_file() {
                    return Err("invalid Cursor deferred event file".into());
                }
                let mut bytes = Vec::new();
                file.take(MAX_EVENT_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|err| err.to_string())?;
                if bytes.len() as u64 > MAX_EVENT_BYTES {
                    return Err("Cursor deferred event exceeds the collection budget".into());
                }
                let mut event: Obj =
                    serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
                event.remove("transcript_path");
                event.insert("_pilot_receipt".into(), Value::String(id.into()));
                journal.append(&event)?;
                events.push(Value::Object(event));
            }
            // After a process restart, an already imported but not yet unlinked
            // receipt is recognized from the active journal.
            fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        let env = Env::from([(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        let mut seen = HashSet::new();
        for event in &events {
            if event["hook_event"] == "stop" && seen.insert(stable_event_key(event)) {
                if let Some(event) = event.as_object() {
                    // CLI Stop remains in the journal until its response arrives.
                    assemble_stop(root, &env, &journal, event)?;
                }
            }
        }
        *recovered = true;
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
        DeferredCursor::new(root.clone()).collect().unwrap();
        let file = fs::read_dir(history)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let first = fs::read(&file).unwrap();
        assert_ne!(first.len(), 0);
        assert!(String::from_utf8_lossy(&first).contains("test response"));
        DeferredCursor::new(root).collect().unwrap();
        assert_eq!(fs::read(file).unwrap(), first);
    }
}
