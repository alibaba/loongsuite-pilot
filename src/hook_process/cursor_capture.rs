//! Shared Cursor capture decisions for the native command and history collector.

use serde_json::{json, Value};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub(crate) const CONFIG_MARKER: &str = "cursor-config-path";

#[derive(Default)]
pub(crate) struct Capture {
    pub(crate) available: bool,
    ide: bool,
    cli: bool,
}

impl Capture {
    pub(crate) fn load(
        root: &Path,
        fallback: PathBuf,
        implicit: bool,
        read: impl Fn(&Path) -> io::Result<String>,
    ) -> (Self, Option<PathBuf>) {
        let Ok(installed) = installed_path(root, &read) else {
            return (Self::default(), None);
        };
        let (path, implicit) = installed.unwrap_or((fallback, implicit));
        let value = match read(&path) {
            Ok(raw) => serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
                .ok()
                .filter(Value::is_object),
            Err(error) if error.kind() == io::ErrorKind::NotFound && implicit => Some(json!({})),
            Err(_) => None,
        };
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
            !policy
                .and_then(|policy| policy.get("captureMessageContent"))
                .is_some_and(|value| {
                    value.as_bool() == Some(false)
                        || value
                            .as_str()
                            .is_some_and(|text| text.trim().eq_ignore_ascii_case("false"))
                })
        };
        (
            Self {
                available: value.is_some(),
                ide: capture("cursor"),
                cli: capture("cursor-cli"),
            },
            Some(path),
        )
    }

    pub(crate) fn enabled(&self, agent: Option<&str>) -> bool {
        self.available
            && match agent {
                Some("cursor") => self.ide,
                Some("cursor-cli") => self.cli,
                _ => self.ide && self.cli,
            }
    }
}

fn installed_path(
    root: &Path,
    read: &impl Fn(&Path) -> io::Result<String>,
) -> io::Result<Option<(PathBuf, bool)>> {
    let raw = match read(&root.join("hooks").join(CONFIG_MARKER)) {
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

static IDE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^v?[0-9]{1,3}\.[0-9]+\.[0-9]+(?:-[a-z0-9_.-]+)?(?:\+[a-z0-9_.-]+)?$")
        .unwrap()
});
static CLI: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^v?[0-9]{4}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12][0-9]|3[01])(?:-[a-z0-9_.-]+)?(?:\+[a-z0-9_.-]+)?$").unwrap()
});

pub(crate) fn variant(version: Option<&Value>) -> Option<&'static str> {
    let version = version?.as_str()?;
    if CLI.is_match(version) {
        Some("cursor-cli")
    } else if IDE.is_match(version) {
        Some("cursor")
    } else {
        None
    }
}
