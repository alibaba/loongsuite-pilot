use super::common::{hook_config_path, Env, Obj};
use serde_json::json;
use std::path::Path;

#[path = "cursor_capture.rs"]
mod capture;
pub(super) use capture::variant;
use capture::Capture;
pub(crate) use capture::CONFIG_MARKER;

pub(crate) fn cursor_config_record(root: &Path) -> anyhow::Result<String> {
    let mut env: Env = std::env::vars().collect();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        root.to_string_lossy().into_owned(),
    );
    let (path, explicit) = hook_config_path(&env);
    let path = std::path::absolute(path)?;
    Ok(format!(
        "{}\n",
        json!({"path":path,"implicitDefault":!explicit})
    ))
}

pub(super) struct Policy {
    pub(super) env: Env,
    capture: Capture,
}

impl Policy {
    pub(super) fn load(root: &Path, env: &Env) -> Self {
        let (fallback, explicit) = hook_config_path(env);
        let (capture, selected) = Capture::load(root, fallback, !explicit, |path| {
            std::fs::read_to_string(path)
        });
        let mut env = env.clone();
        if let Some(path) = selected {
            env.insert(
                "AGENT_DATA_COLLECTION_CONFIG".into(),
                path.to_string_lossy().into_owned(),
            );
        }
        Self { env, capture }
    }

    pub(super) fn available(&self) -> bool {
        self.capture.available
    }

    pub(super) fn capture(&self, variant: Option<&str>) -> bool {
        self.capture.enabled(variant)
    }
}

pub(super) fn omit_content(event: &mut Obj) {
    for key in [
        "prompt",
        "attachments",
        "text",
        "tool_input",
        "tool_output",
        "error_message",
        "task",
        "description",
    ] {
        event.remove(key);
    }
    event.insert("content_omitted".into(), true.into());
}
