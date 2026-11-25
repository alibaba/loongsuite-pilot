use super::common::{hook_config_path, Env, Obj};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub(crate) const CONFIG_MARKER: &str = "cursor-config-path";

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

fn installed_path(root: &Path) -> io::Result<Option<(PathBuf, bool)>> {
    let raw = match fs::read_to_string(root.join("hooks").join(CONFIG_MARKER)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let trimmed = raw.trim();
    let bad = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid deployed Cursor configuration path",
        )
    };
    let (path, implicit) = if trimmed.starts_with('{') {
        let marker: Value = serde_json::from_str(trimmed).map_err(|_| bad())?;
        (
            PathBuf::from(marker["path"].as_str().ok_or_else(bad)?),
            marker["implicitDefault"] == true,
        )
    } else {
        (PathBuf::from(trimmed), false)
    };
    if !path.is_absolute() {
        return Err(bad());
    }
    Ok(Some((path, implicit)))
}

pub(super) struct Policy {
    pub(super) env: Env,
    available: bool,
    ide_capture: bool,
    cli_capture: bool,
}

impl Policy {
    pub(super) fn load(root: &Path, env: &Env) -> Self {
        let (fallback, explicit) = hook_config_path(env);
        let mut env = env.clone();
        let location = installed_path(root).map(|marker| marker.unwrap_or((fallback, !explicit)));
        let value = location.ok().and_then(|(path, implicit)| {
            env.insert(
                "AGENT_DATA_COLLECTION_CONFIG".into(),
                path.to_string_lossy().into_owned(),
            );
            match fs::read_to_string(path) {
                Ok(raw) => serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
                    .ok()
                    .filter(Value::is_object),
                Err(error) if error.kind() == io::ErrorKind::NotFound && implicit => {
                    Some(json!({}))
                }
                Err(_) => None,
            }
        });
        let capture = |key| {
            let Some(config) = &value else {
                return false;
            };
            let agents = &config["agents"];
            let policy = agents
                .get(key)
                .filter(|policy| policy.is_object())
                .or_else(|| {
                    (key == "cursor-cli")
                        .then(|| agents.get("cursor"))
                        .flatten()
                });
            let value = policy.and_then(|policy| policy.get("captureMessageContent"));
            !value.is_some_and(|value| {
                value.as_bool() == Some(false)
                    || value
                        .as_str()
                        .is_some_and(|text| text.trim().eq_ignore_ascii_case("false"))
            })
        };
        Self {
            env,
            available: value.is_some(),
            ide_capture: capture("cursor"),
            cli_capture: capture("cursor-cli"),
        }
    }

    pub(super) fn available(&self) -> bool {
        self.available
    }

    pub(super) fn capture(&self, variant: Option<&str>) -> bool {
        match variant {
            Some("cursor") => self.ide_capture,
            Some("cursor-cli") => self.cli_capture,
            _ => self.ide_capture && self.cli_capture,
        }
    }
}

static IDE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^v?[0-9]{1,3}\.[0-9]+\.[0-9]+(?:-[a-z0-9_.-]+)?(?:\+[a-z0-9_.-]+)?$")
        .unwrap()
});
static CLI: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^v?[0-9]{4}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12][0-9]|3[01])(?:-[a-z0-9_.-]+)?(?:\+[a-z0-9_.-]+)?$").unwrap()
});

pub(super) fn variant(version: Option<&Value>) -> Option<&'static str> {
    let version = version?.as_str()?;
    if CLI.is_match(version) {
        Some("cursor-cli")
    } else if IDE.is_match(version) {
        Some("cursor")
    } else {
        None
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
