//! Remove leftover Claude OpenTelemetry plugin files. Codex assets are left alone.

use crate::utils::{create_logger, resolve_home};
use serde_json::Value;
use std::path::Path;

fn logger() -> crate::utils::BoundLogger {
    create_logger("PluginMigration")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginMigrationStepReport {
    pub stage: String,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginMigrationReport {
    pub claude: MigrationSide,
    pub codex: MigrationSide,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSide {
    pub migrated: bool,
    pub steps: Vec<PluginMigrationStepReport>,
}

pub async fn run_plugin_migration() -> Result<PluginMigrationReport, String> {
    run_plugin_migration_at(Path::new(&home())).await
}

async fn run_plugin_migration_at(home_dir: &Path) -> Result<PluginMigrationReport, String> {
    let claude = migrate_claude(home_dir).await;
    let codex = MigrationSide {
        migrated: false,
        steps: vec![PluginMigrationStepReport {
            stage: "detect".into(),
            ok: true,
            detail: Some(
                "skipped: legacy Codex OTel assets are not exclusively owned by Pilot".into(),
            ),
        }],
    };
    Ok(PluginMigrationReport { claude, codex })
}

async fn migrate_claude(home_dir: &Path) -> MigrationSide {
    let cache = home_dir
        .join(".cache")
        .join("opentelemetry.instrumentation.claude");
    if !cache.exists() {
        return MigrationSide {
            migrated: false,
            steps: vec![PluginMigrationStepReport {
                stage: "detect".into(),
                ok: true,
                detail: Some("no claude plugin residue".into()),
            }],
        };
    }
    logger().info("cleaning up old claude plugin residue", None);
    let mut steps = Vec::new();
    clean_claude_settings(home_dir, &mut steps).await;
    safe_unlink(
        &home_join(home_dir, ".claude/otel-config.json"),
        &mut steps,
        "claude_otel_config",
    )
    .await;
    clean_aliases(home_dir, &mut steps).await;
    safe_rm_rf(&cache.to_string_lossy(), &mut steps, "claude_cache_dir").await;
    MigrationSide {
        migrated: true,
        steps,
    }
}

fn home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| resolve_home("~"))
}

fn home_join(home_dir: &Path, relative: &str) -> String {
    home_dir.join(relative).to_string_lossy().into_owned()
}

fn is_claude_old_path(value: Option<&str>) -> bool {
    value.is_some_and(|text| {
        text.contains("otel-claude-hook")
            || text.contains(".cache/opentelemetry.instrumentation.claude")
    })
}

async fn clean_claude_settings(home_dir: &Path, steps: &mut Vec<PluginMigrationStepReport>) {
    let settings = home_join(home_dir, ".claude/settings.json");
    if !Path::new(&settings).exists() {
        steps.push(step("claude_settings", true, "settings.json not present"));
        return;
    }
    let Ok(raw) = tokio::fs::read_to_string(&settings).await else {
        steps.push(step("claude_settings", false, "settings.json unreadable"));
        return;
    };
    let mut data: Value = match serde_json::from_str(&raw) {
        Ok(data) => data,
        Err(_) => {
            steps.push(step("claude_settings", false, "settings.json invalid JSON"));
            return;
        }
    };
    if !data.get("hooks").is_some_and(Value::is_object) {
        steps.push(step("claude_settings", true, "no hooks section"));
        return;
    }
    let mut removed = 0usize;
    let events: Vec<String> = data["hooks"].as_object().unwrap().keys().cloned().collect();
    for event in events {
        let Some(arr) = data["hooks"][&event].as_array() else {
            continue;
        };
        let filtered: Vec<Value> = arr
            .iter()
            .filter_map(|entry| {
                if let Some(hooks) = entry.get("hooks").and_then(Value::as_array) {
                    let kept: Vec<Value> = hooks
                        .iter()
                        .filter(|hook| {
                            !is_claude_old_path(hook.get("command").and_then(Value::as_str))
                        })
                        .cloned()
                        .collect();
                    removed += hooks.len() - kept.len();
                    if kept.is_empty() {
                        None
                    } else if kept.len() == hooks.len() {
                        Some(entry.clone())
                    } else {
                        let mut next = entry.clone();
                        next["hooks"] = Value::Array(kept);
                        Some(next)
                    }
                } else if is_claude_old_path(entry.get("command").and_then(Value::as_str)) {
                    removed += 1;
                    None
                } else {
                    Some(entry.clone())
                }
            })
            .collect();
        if filtered.is_empty() {
            data["hooks"].as_object_mut().unwrap().remove(&event);
        } else {
            data["hooks"][&event] = Value::Array(filtered);
        }
    }
    if removed == 0 {
        steps.push(step("claude_settings", true, "no otel-claude-hook entries"));
        return;
    }
    match tokio::fs::write(
        &settings,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into())
        ),
    )
    .await
    {
        Ok(()) => steps.push(PluginMigrationStepReport {
            stage: "claude_settings".into(),
            ok: true,
            detail: Some(format!("removed {removed} entries")),
        }),
        Err(err) => steps.push(step("claude_settings", false, &err.to_string())),
    }
}

async fn clean_aliases(home_dir: &Path, steps: &mut Vec<PluginMigrationStepReport>) {
    let pattern =
        regex::Regex::new(r"\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?")
            .unwrap();
    for name in [".bashrc", ".zshrc", ".bash_profile"] {
        let path = home_join(home_dir, name);
        if !Path::new(&path).exists() {
            continue;
        }
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        if !content.contains("# BEGIN otel-claude-hook") {
            continue;
        }
        let replaced = pattern.replace_all(&content, "\n");
        match tokio::fs::write(&path, replaced.as_ref()).await {
            Ok(()) => steps.push(PluginMigrationStepReport {
                stage: "claude_alias".into(),
                ok: true,
                detail: Some(format!("cleaned {path}")),
            }),
            Err(err) => steps.push(PluginMigrationStepReport {
                stage: "claude_alias".into(),
                ok: false,
                detail: Some(format!("{path}: {err}")),
            }),
        }
    }
}

async fn safe_unlink(path: &str, steps: &mut Vec<PluginMigrationStepReport>, stage: &str) {
    if Path::new(path).exists() {
        match tokio::fs::remove_file(path).await {
            Ok(()) => steps.push(PluginMigrationStepReport {
                stage: stage.into(),
                ok: true,
                detail: Some(format!("removed {path}")),
            }),
            Err(err) => steps.push(PluginMigrationStepReport {
                stage: stage.into(),
                ok: false,
                detail: Some(format!("{path}: {err}")),
            }),
        }
    } else {
        steps.push(PluginMigrationStepReport {
            stage: stage.into(),
            ok: true,
            detail: Some(format!("not present {path}")),
        });
    }
}

async fn safe_rm_rf(path: &str, steps: &mut Vec<PluginMigrationStepReport>, stage: &str) {
    if Path::new(path).exists() {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => steps.push(PluginMigrationStepReport {
                stage: stage.into(),
                ok: true,
                detail: Some(format!("removed {path}")),
            }),
            Err(err) => steps.push(PluginMigrationStepReport {
                stage: stage.into(),
                ok: false,
                detail: Some(format!("{path}: {err}")),
            }),
        }
    } else {
        steps.push(PluginMigrationStepReport {
            stage: stage.into(),
            ok: true,
            detail: Some(format!("not present {path}")),
        });
    }
}

fn step(stage: &str, ok: bool, detail: &str) -> PluginMigrationStepReport {
    PluginMigrationStepReport {
        stage: stage.into(),
        ok,
        detail: Some(detail.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skips_when_the_claude_cache_is_absent() {
        // TypeScript points HOME at an empty temp directory. Checking the real
        // home after migration is wrong: a present cache is deleted, then the
        // absence check treats that deletion as "nothing was migrated".
        let home = tempfile::tempdir().unwrap();
        let report = run_plugin_migration_at(home.path()).await.unwrap();
        assert!(!report.codex.migrated);
        assert!(report.codex.steps[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("not exclusively owned"));
        assert!(!report.claude.migrated);
        assert_eq!(
            report.claude.steps[0].detail.as_deref(),
            Some("no claude plugin residue")
        );
    }
}

#[cfg(test)]
#[path = "plugin_migration_history_contract_tests.rs"]
mod plugin_migration_history_contract_tests;
