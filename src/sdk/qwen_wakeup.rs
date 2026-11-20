//! Bounded, content-free Qwen Work Stop notifications for the SDK source.
//!
//! The Hook can publish while the SDK host is stopped. The collector must
//! revalidate each transcript against the current policy before opening it.

use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PENDING: usize = 4096;
const MAX_FIELD: usize = 4096;

pub(super) fn publish(data: &Path, input: &[u8]) -> bool {
    if !data.is_absolute() || data.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let Ok(Value::Object(payload)) = serde_json::from_slice::<Value>(input) else {
        return false;
    };
    if payload.get("stop_hooks_active") == Some(&Value::Bool(true)) {
        return false;
    }
    let session_field = |name: &str| {
        payload
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
    };
    let Some(session) = session_field("session_id").or_else(|| session_field("conversation_id"))
    else {
        return false;
    };
    let Some(transcript) = payload
        .get("transcript_path")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= MAX_FIELD)
        .map(Path::new)
        .filter(|path| {
            path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir))
        })
    else {
        return false;
    };
    let policy_path = data.join("wakeups/qwen-work-cn-policy.json");
    if !private_path(&policy_path) {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(&policy_path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return false;
    }
    let Some(root) = fs::read(&policy_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|policy| policy["schema"] == 1 && policy["enabled"] == true)
        .and_then(|policy| policy["transcript_root"].as_str().map(str::to_owned))
        .map(std::path::PathBuf::from)
    else {
        return false;
    };
    if !private_path(transcript) || !private_path(&root) {
        return false;
    }
    let (Ok(resolved), Ok(root)) = (transcript.canonicalize(), root.canonicalize()) else {
        return false;
    };
    if !resolved.starts_with(root) {
        return false;
    }
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= MAX_FIELD)
        .unwrap_or("");
    let directory = data.join("wakeups").join("qwen-work-cn");
    if !private_path(&directory)
        || fs::create_dir_all(&directory).is_err()
        || !private_path(&directory)
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).is_err() {
            return false;
        }
    }
    let Ok(entries) = fs::read_dir(&directory) else {
        return false;
    };
    if entries.take(MAX_PENDING + 1).count() >= MAX_PENDING {
        // Never block the Agent. Surface the loss instead of silently treating
        // an unrecorded notification as accepted.
        eprintln!("loongsuite-pilot: qwen-work-cn wakeup queue is full; Stop notification was not recorded");
        return false;
    }
    let size = fs::metadata(transcript)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len());
    let marker = json!({"schema":1,"transcript_path":transcript,"session_id":session,
        "cwd":cwd,"snapshot_bytes":size});
    let Ok(bytes) = serde_json::to_vec(&marker) else {
        return false;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    for attempt in 0..8u8 {
        let name = format!(
            "{:020}-{:010}-{attempt}.json",
            now.as_nanos(),
            std::process::id()
        );
        let destination = directory.join(&name);
        let temporary = directory.join(format!(".{name}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&temporary) {
            Ok(mut file) => {
                let written = file
                    .write_all(&bytes)
                    .and_then(|()| file.sync_all())
                    .is_ok();
                drop(file);
                if written && fs::rename(&temporary, &destination).is_ok() {
                    return true;
                }
                let _ = fs::remove_file(&temporary);
                return false;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return false,
        }
    }
    false
}

fn private_path(path: &Path) -> bool {
    path.ancestors()
        .all(|part| match fs::symlink_metadata(part) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return false;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return false;
                    }
                }
                true
            }
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        })
}
