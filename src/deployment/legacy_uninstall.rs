//! Legacy Claude uninstall policy, using the same configuration locks and
//! transaction as native Hook removal. Cache sessions survive ordinary uninstall.
use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::hook_assets::HookAssets;
use crate::utils::{edit_jsonc, parse_json_document, JsonEditOptions, JsonPathSeg, JsonSyntax};

const MAX_BYTES: u64 = 4 * 1024 * 1024;

fn targets(home: &Path) -> BTreeMap<String, PathBuf> {
    [
        ("settings", ".claude/settings.json"),
        ("otel", ".claude/otel-config.json"),
        ("bashrc", ".bashrc"),
        ("zshrc", ".zshrc"),
        ("bash-profile", ".bash_profile"),
    ]
    .into_iter()
    .map(|(key, relative)| (key.into(), home.join(relative)))
    .collect()
}

fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => {
            result?;
        }
    }
    ensure!(
        crate::utils::runtime_paths::runtime_metadata(path)?.is_file(),
        "Legacy cleanup target is not a regular file"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "Legacy cleanup target is too large"
    );
    Ok(Some(bytes))
}

fn json_object(raw: &str) -> Result<Value> {
    let data = parse_json_document(raw, JsonSyntax::Json)
        .map_err(|_| anyhow::anyhow!("Invalid legacy Claude configuration"))?;
    ensure!(
        data.is_object(),
        "Legacy Claude configuration must be an object"
    );
    Ok(data)
}

fn owned_command(value: &Value) -> bool {
    value.as_str().is_some_and(|command| {
        command.contains("otel-claude-hook") || command.contains("hook-entry.sh")
    })
}

fn remaining_hook_reference(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (key == "command" && owned_command(value)) || remaining_hook_reference(value)
        }),
        Value::Array(values) => values.iter().any(remaining_hook_reference),
        _ => false,
    }
}

fn settings(raw: &str) -> Result<String> {
    if !raw.contains("otel-claude-hook") && !raw.contains("hook-entry.sh") {
        return Ok(raw.into());
    }
    let data = json_object(raw)?;
    let Some(hooks) = data.get("hooks") else {
        return Ok(raw.into());
    };
    let hooks = hooks
        .as_object()
        .context("Invalid legacy Claude hooks object")?;
    let mut next = raw.to_owned();
    for (event, entries) in hooks {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        let mut changed = false;
        let mut kept = Vec::new();
        for entry in entries {
            let Some(nested) = entry.get("hooks").and_then(Value::as_array) else {
                if entry.get("command").is_some_and(owned_command) {
                    changed = true;
                } else {
                    kept.push(entry.clone());
                }
                continue;
            };
            let filtered: Vec<_> = nested
                .iter()
                .filter(|hook| {
                    !hook
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|command| {
                            command.contains("otel-claude-hook")
                                || command.contains("hook-entry.sh")
                        })
                })
                .cloned()
                .collect();
            changed |= filtered.len() != nested.len();
            if !filtered.is_empty() {
                let mut replacement = entry.clone();
                replacement["hooks"] = Value::Array(filtered);
                kept.push(replacement);
            } else if nested.is_empty() {
                // An already empty user matcher is not owned by Pilot.
                kept.push(entry.clone());
            }
        }
        if changed {
            let value = (!kept.is_empty()).then_some(Value::Array(kept));
            next = edit_jsonc(
                &next,
                &[
                    JsonPathSeg::Key("hooks".into()),
                    JsonPathSeg::Key(event.clone()),
                ],
                value.as_ref(),
                JsonEditOptions::default(),
            );
        }
    }
    if json_object(&next)?
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|hooks| hooks.is_empty())
    {
        next = edit_jsonc(
            &next,
            &[JsonPathSeg::Key("hooks".into())],
            None,
            JsonEditOptions::default(),
        );
    }
    let remaining = json_object(&next)?;
    ensure!(
        !remaining.get("hooks").is_some_and(remaining_hook_reference),
        "Unrecognized legacy Claude Hook reference; cache assets were preserved"
    );
    Ok(next)
}

fn otel(raw: &str) -> Result<String> {
    let data = json_object(raw)?;
    let mut next = raw.to_owned();
    for key in ["log_enabled", "log_dir", "log_filename_format"] {
        if data.get(key).is_some() {
            next = edit_jsonc(
                &next,
                &[JsonPathSeg::Key(key.into())],
                None,
                JsonEditOptions::default(),
            );
        }
    }
    json_object(&next)?;
    Ok(next)
}

fn marker_line(line: &str, prefix: &str, marker: &str) -> bool {
    let expected = format!("# {prefix} {marker}");
    line.strip_prefix(&expected)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
}

fn aliases(raw: &str) -> Result<String> {
    let mut active: Option<&str> = None;
    let mut next = String::new();
    for line in raw.split_inclusive('\n') {
        let trimmed = line.trim();
        let begin = ["otel-claude-hook-env", "otel-claude-hook"]
            .into_iter()
            .find(|marker| marker_line(trimmed, "BEGIN", marker));
        if let Some(marker) = begin {
            ensure!(active.is_none(), "Nested legacy Claude shell marker");
            active = Some(marker);
        } else if trimmed.starts_with("# BEGIN otel-claude-hook") {
            anyhow::bail!("Unrecognized legacy Claude shell marker");
        } else if let Some(marker) = active {
            if marker_line(trimmed, "END", marker) {
                active = None;
            }
        } else {
            ensure!(
                !trimmed.starts_with("# END otel-claude-hook"),
                "Unmatched legacy Claude shell marker"
            );
            next.push_str(line);
        }
    }
    ensure!(active.is_none(), "Incomplete legacy Claude shell marker");
    Ok(next)
}

fn plan(key: &str, bytes: Option<Vec<u8>>) -> Result<Option<String>> {
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let markers: &[&[u8]] = match key {
        "settings" => &[b"otel-claude-hook", b"hook-entry.sh"],
        "otel" => &[b"log_enabled", b"log_dir", b"log_filename_format"],
        _ => &[b"# BEGIN otel-claude-hook", b"# END otel-claude-hook"],
    };
    if !markers
        .iter()
        .any(|marker| bytes.windows(marker.len()).any(|part| part == *marker))
    {
        return Ok(None);
    }
    let raw = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("Legacy cleanup target is not UTF-8"))?;
    let next = match key {
        "settings" => settings(&raw)?,
        "otel" => otel(&raw)?,
        _ => aliases(&raw)?,
    };
    Ok((next != raw).then_some(next))
}

pub(super) fn preflight(home: &Path) -> Result<()> {
    for (key, path) in targets(home) {
        plan(&key, read(&path)?)?;
    }
    let cache = home.join(".cache/opentelemetry.instrumentation.claude");
    match std::fs::symlink_metadata(&cache) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        result => {
            result?;
            ensure!(
                crate::utils::runtime_paths::runtime_metadata(&cache)?.is_dir(),
                "Legacy Claude cache is not a regular directory"
            );
        }
    }
    Ok(())
}

pub(super) async fn run(home: &Path, data: &Path, purge: bool) -> Result<()> {
    preflight(home)?;
    let paths = targets(home);
    let changed = paths.iter().try_fold(false, |changed, (key, path)| {
        Ok::<_, anyhow::Error>(changed | plan(key, read(path)?)?.is_some())
    })?;
    if changed {
        let settings = paths["settings"].to_string_lossy().into_owned();
        HookAssets::configuration_cleanup(data)
            .apply(paths, Some(&settings), true, |transaction| {
                let mut edits = BTreeMap::new();
                for key in ["settings", "otel", "bashrc", "zshrc", "bash-profile"] {
                    if let Some(next) = plan(key, transaction.original_bytes(key)?)? {
                        edits.insert(key.into(), next);
                    }
                }
                Ok(edits)
            })
            .await?;
    }
    let cache = home.join(".cache/opentelemetry.instrumentation.claude");
    if cache.try_exists()? {
        if purge {
            std::fs::remove_dir_all(cache)?;
        } else {
            for entry in std::fs::read_dir(cache)? {
                let entry = entry?;
                if entry.file_name() == "sessions" {
                    continue;
                }
                let meta = entry.file_type()?;
                if meta.is_dir() {
                    std::fs::remove_dir_all(entry.path())?;
                } else {
                    std::fs::remove_file(entry.path())?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cleanup_preserves_sessions_other_fields_user_hooks_and_shell_bytes() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let data = root.path().join("data");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let cache = home.join(".cache/opentelemetry.instrumentation.claude");
        std::fs::create_dir_all(cache.join("sessions")).unwrap();
        std::fs::write(cache.join("sessions/history"), "history").unwrap();
        std::fs::write(cache.join("intercept.js"), "old preload").unwrap();
        let original = r#"{"private":"keep","hooks":{"Stop":[{"matcher":"","hooks":[{"command":"otel-claude-hook"},{"command":"user-hook"}]},{"command":"hook-entry.sh"},{"command":"direct-user-hook"}]}}"#;
        std::fs::write(home.join(".claude/settings.json"), original).unwrap();
        std::fs::write(home.join(".claude/otel-config.json"),
            "{\"log_enabled\":true,\"log_dir\":\"old\",\"log_filename_format\":\"old\",\"user\":1.0}\n").unwrap();
        std::fs::write(home.join(".bashrc"), "before\r\n# BEGIN otel-claude-hook-env (legacy)\r\nexport X=old\r\n# END otel-claude-hook-env (legacy)\r\nafter").unwrap();
        std::fs::write(home.join(".zshrc"), [0xff, 0xfe, 0x75, 0x73, 0x65, 0x72]).unwrap();
        preflight(&home).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
            original
        );
        for _ in 0..2 {
            run(&home, &data, false).await.unwrap();
            let settings =
                json_object(&std::fs::read_to_string(home.join(".claude/settings.json")).unwrap())
                    .unwrap();
            assert_eq!(settings["private"], "keep");
            assert_eq!(
                settings["hooks"]["Stop"][0]["hooks"],
                serde_json::json!([{"command":"user-hook"}])
            );
            assert_eq!(settings["hooks"]["Stop"][1]["command"], "direct-user-hook");
            assert_eq!(
                std::fs::read_to_string(home.join(".bashrc")).unwrap(),
                "before\r\nafter"
            );
            let otel = std::fs::read_to_string(home.join(".claude/otel-config.json")).unwrap();
            assert!(otel.contains("1.0"));
            assert_eq!(json_object(&otel).unwrap(), serde_json::json!({"user":1.0}));
            assert_eq!(
                std::fs::read_to_string(cache.join("sessions/history")).unwrap(),
                "history"
            );
            assert!(!cache.join("intercept.js").exists());
        }
        run(&home, &data, true).await.unwrap();
        assert!(!cache.exists());
        assert!(home.join(".claude/settings.json").is_file());
    }

    #[tokio::test]
    async fn invalid_config_or_unterminated_shell_block_preserves_all_files_and_cache() {
        for scenario in [
            "invalid-settings",
            "incomplete-shell",
            "unknown-hook-shape",
            "unknown-marker",
            "nested-marker",
        ] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            let data = root.path().join("data");
            std::fs::create_dir_all(home.join(".claude")).unwrap();
            let cache = home.join(".cache/opentelemetry.instrumentation.claude");
            std::fs::create_dir_all(&cache).unwrap();
            std::fs::write(cache.join("intercept.js"), "keep").unwrap();
            let settings = match scenario {
                "invalid-settings" => "broken otel-claude-hook",
                "unknown-hook-shape" => r#"{"hooks":{"Stop":{"command":"otel-claude-hook"}}}"#,
                _ => r#"{"hooks":{"Stop":[{"hooks":[{"command":"otel-claude-hook"}]}]}}"#,
            };
            std::fs::write(home.join(".claude/settings.json"), settings).unwrap();
            let shell = match scenario {
                "incomplete-shell" => "# BEGIN otel-claude-hook\nkeep\n",
                "unknown-marker" => "# BEGIN otel-claude-hook-custom\nkeep\n# END otel-claude-hook-custom\n",
                "nested-marker" => "# BEGIN otel-claude-hook\n# BEGIN otel-claude-hook-env\nkeep\n# END otel-claude-hook-env\n# END otel-claude-hook\n",
                _ => "# user\n",
            };
            std::fs::write(home.join(".bashrc"), shell).unwrap();
            let result = run(&home, &data, true).await;
            assert!(result.is_err());
            assert_eq!(
                std::fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
                settings
            );
            assert_eq!(
                std::fs::read_to_string(home.join(".bashrc")).unwrap(),
                shell
            );
            assert_eq!(
                std::fs::read_to_string(cache.join("intercept.js")).unwrap(),
                "keep"
            );
            assert!(!data.exists());
        }
    }
    #[tokio::test]
    async fn readonly_configuration_rolls_back_earlier_shell_edits_and_preserves_cache() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let data = root.path().join("data");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let cache = home.join(".cache/opentelemetry.instrumentation.claude");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("intercept.js"), "keep").unwrap();
        let path = home.join(".claude/settings.json");
        let settings = r#"{"hooks":{"Stop":[{"hooks":[{"command":"otel-claude-hook"}]}]}}"#;
        std::fs::write(&path, settings).unwrap();
        let original_permissions = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();
        let shell = "# BEGIN otel-claude-hook\nold-alias\n# END otel-claude-hook\n";
        std::fs::write(home.join(".bashrc"), shell).unwrap();
        let result = run(&home, &data, true).await;
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), settings);
        assert_eq!(
            std::fs::read_to_string(home.join(".bashrc")).unwrap(),
            shell
        );
        assert_eq!(
            std::fs::read_to_string(cache.join("intercept.js")).unwrap(),
            "keep"
        );
        assert!(!data.join(".hook-install/update-recovery.json").exists());
        std::fs::set_permissions(&path, original_permissions).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn foreign_config_and_cache_symlinks_are_refused_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        for link_config in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            let data = root.path().join("data");
            std::fs::create_dir_all(home.join(".claude")).unwrap();
            std::fs::create_dir_all(home.join(".cache")).unwrap();
            let foreign = root.path().join("foreign");
            std::fs::create_dir(&foreign).unwrap();
            std::fs::write(foreign.join("keep"), "foreign").unwrap();
            if link_config {
                symlink(foreign.join("keep"), home.join(".claude/settings.json")).unwrap();
            } else {
                symlink(
                    &foreign,
                    home.join(".cache/opentelemetry.instrumentation.claude"),
                )
                .unwrap();
            }
            assert!(run(&home, &data, true).await.is_err());
            assert_eq!(
                std::fs::read_to_string(foreign.join("keep")).unwrap(),
                "foreign"
            );
            assert!(!data.exists());
        }
    }
}
