//! Native Dashboard shortcut command; JXA runs in the macOS system host.
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const ADAPTER: &str = include_str!("../../scripts/manage-dashboard-shortcut.js");

fn absolute_config(path: &Path, current: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        current.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    anyhow::ensure!(
        normalized.is_absolute(),
        "Expected an absolute configuration path."
    );
    Ok(normalized)
}

fn shortcut_url(config: &Path) -> String {
    let parsed = (|| -> Option<Value> {
        let mut text = String::new();
        std::fs::File::open(config)
            .ok()?
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .ok()?;
        if text.len() > 4 * 1024 * 1024 {
            return None;
        }
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
    })();
    let port = crate::dashboard::configured_port(
        parsed.as_ref().and_then(|v| v.pointer("/dashboard/port")),
    );
    format!("http://127.0.0.1:{port}/")
}

fn clean_owned_lock(lock: &Path, operation: &str) -> bool {
    let result = (|| -> std::io::Result<()> {
        let metadata = std::fs::symlink_metadata(lock)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("not an owned directory"));
        }
        let owner = lock.join("Owner");
        let metadata = std::fs::symlink_metadata(&owner)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || std::fs::read_to_string(&owner)? != operation
        {
            return Err(std::io::Error::other("different lock owner"));
        }
        std::fs::remove_file(owner)?;
        std::fs::remove_dir(lock)
    })();
    result.is_ok()
        || matches!(std::fs::symlink_metadata(lock),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutResult {
    shortcut_path: String,
    exists: bool,
    managed: bool,
    url: Option<String>,
    dock_matches: u64,
    dock_locked: bool,
    changed: bool,
    backup_path: Option<String>,
    warnings: Vec<String>,
}

fn response(bytes: &[u8]) -> std::result::Result<ShortcutResult, String> {
    #[derive(Deserialize)]
    struct Reply {
        ok: bool,
        result: Option<ShortcutResult>,
        error: Option<String>,
    }
    let reply: Reply = serde_json::from_slice(bytes)
        .map_err(|_| "Invalid macOS shortcut response.".to_string())?;
    if reply.ok {
        reply
            .result
            .ok_or_else(|| "Invalid macOS shortcut response.".into())
    } else {
        Err(reply
            .error
            .unwrap_or_else(|| "Shortcut operation failed.".into()))
    }
}

fn build_request(
    action: &str,
    config: &Path,
    operation: &str,
    icon: Option<&Path>,
) -> std::result::Result<Value, String> {
    let mut request = json!({"action":action, "configPath":config, "operationId":operation});
    if action == "install" {
        let icon = icon.ok_or_else(|| "Cannot read the bundled shortcut icon.".to_string())?;
        request["iconVersion"] = json!(crate::utils::runtime_paths::sha256_file(icon)
            .map_err(|_| "Cannot read the bundled shortcut icon.".to_string())?);
        request["iconPath"] = json!(icon);
        request["url"] = json!(shortcut_url(config));
    }
    Ok(request)
}

async fn invoke(
    action: &str,
    config: &Path,
    home: &Path,
) -> std::result::Result<ShortcutResult, String> {
    let operation = uuid::Uuid::new_v4().to_string();
    let icon = if action == "install" {
        let root = crate::utils::runtime_paths::resolve_resource_root(
            &crate::utils::resolve_data_dir(None),
            None,
            &[env!("CARGO_MANIFEST_DIR")],
        )
        .map_err(|_| "Repair the Pilot installation.".to_string())?;
        Some(
            crate::utils::runtime_paths::resource_file(
                &root,
                "assets/dashboard-shortcut/AppIcon.icns",
            )
            .map_err(|_| {
                "The bundled shortcut icon is missing or invalid. Repair the Pilot installation."
                    .to_string()
            })?,
        )
    } else {
        None
    };
    let request = build_request(action, config, &operation, icon.as_deref())?;
    let mut command = tokio::process::Command::new("/usr/bin/osascript");
    command
        .args(["-l", "JavaScript", "-e", ADAPTER])
        .arg(request.to_string());
    run_adapter(
        &mut command,
        action,
        home,
        &operation,
        Duration::from_secs(20),
    )
    .await
}

async fn run_adapter(
    command: &mut tokio::process::Command,
    action: &str,
    home: &Path,
    operation: &str,
    timeout: Duration,
) -> std::result::Result<ShortcutResult, String> {
    let output = crate::utils::candidate_process::output(command, timeout, 1024 * 1024).await;
    match output {
        Ok(output) if output.status.success() => response(&output.stdout),
        Ok(_) => Err("Check the Pilot configuration, installation files and permissions.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            if action == "status" {
                return Err(
                    "The macOS shortcut status check timed out; no changes were requested.".into(),
                );
            }
            let lock =
                home.join("Library/Application Support/LoongSuite Pilot/Shortcuts/Operation.lock");
            Err(if clean_owned_lock(&lock, operation) {
                "The macOS shortcut helper timed out. Its operation lock was removed; retry the command.".into()
            } else {
                format!(
                    "The macOS shortcut helper timed out. Its operation lock was not removed: {}",
                    lock.display()
                )
            })
        }
        Err(_) => Err("Check the Pilot configuration, installation files and permissions.".into()),
    }
}

fn display(result: &ShortcutResult, action: &str, zh: bool) -> (String, String) {
    let label = |chinese, english| if zh { chinese } else { english };
    let state = if !result.exists {
        label("未安装", "not installed")
    } else if result.managed {
        label("已安装", "installed")
    } else {
        label("未受本配置管理", "not managed by this configuration")
    };
    let mut out = format!(
        "{}: {state}\n{}: {}\n{}: {}\n{}: {}{}\n",
        label("快捷方式", "Shortcut"),
        label("文件位置", "File"),
        result.shortcut_path,
        label("目标网址", "Target URL"),
        result.url.as_deref().unwrap_or("-"),
        label("程序坞", "Dock"),
        if result.dock_matches > 0 {
            label("已添加", "added")
        } else {
            label("未添加", "not added")
        },
        if result.dock_locked {
            label("（已锁定）", " (locked)")
        } else {
            ""
        }
    );
    if result.dock_matches > 1 {
        out.push_str(label(
            "发现重复的程序坞入口，请手动清理。\n",
            "Duplicate Dock entries found; remove duplicates manually.\n",
        ));
    }
    if !result.exists && result.dock_matches > 0 {
        out.push_str(label(
            "文件已不存在，请手动移除残留的程序坞入口。\n",
            "The file is missing; remove its orphaned Dock entry manually.\n",
        ));
    }
    if action == "install" {
        out.push_str(label("端口变更后请重新执行此安装命令；此操作不会启停 Pilot。\n",
            "Run this install command again after changing the port. No Pilot service was started or stopped.\n"));
    }
    if action == "uninstall" && result.changed {
        out.push_str(label(
            "快捷文件已移到废纸篓；备份文件已保留。\n",
            "The shortcut file was moved to Trash; backups were preserved.\n",
        ));
    }
    if let Some(backup) = &result.backup_path {
        out.push_str(&format!(
            "{}: {backup}\n",
            label("程序坞备份", "Dock backup")
        ));
    }
    let err = result.warnings.iter().map(|s| format!("{s}\n")).collect();
    (out, err)
}

pub(crate) async fn run(args: &clap::ArgMatches) -> Result<i32> {
    let zh = std::env::var("LOONGSUITE_PILOT_LANG")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .starts_with("zh");
    if !cfg!(target_os = "macos") {
        eprintln!(
            "{}",
            if zh {
                "Dashboard 快捷方式目前仅支持 macOS。"
            } else {
                "Dashboard shortcuts currently support macOS only."
            }
        );
        return Ok(1);
    }
    let action = args.subcommand_name().context("Missing shortcut action")?;
    let config = absolute_config(
        Path::new(&crate::utils::config_json_path()),
        &std::env::current_dir()?,
    )?;
    let home = PathBuf::from(crate::utils::resolve_home("~"));
    match invoke(action, &config, &home).await {
        Ok(result) => {
            let (out, err) = display(&result, action, zh);
            print!("{out}");
            eprint!("{err}");
            Ok(0)
        }
        Err(error) => {
            eprintln!(
                "{}",
                if zh {
                    "快捷方式操作未完成。"
                } else {
                    "Shortcut operation did not complete."
                }
            );
            eprintln!("{error}");
            Ok(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ports_bom_and_reloads_match_defaults_without_writing() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("配置 O'Brien $() 🚀.json");
        assert_eq!(shortcut_url(&path), "http://127.0.0.1:8765/");
        assert!(!path.exists());
        for (raw, port) in [
            ("null", 8765),
            ("[]", 8765),
            ("{\"secret\":\"do-not-print\"", 8765),
            ("{}", 8765),
            ("{\"dashboard\":{\"port\":null}}", 8765),
            ("{\"dashboard\":{\"port\":0}}", 8765),
            ("{\"dashboard\":{\"port\":-1}}", 8765),
            ("{\"dashboard\":{\"port\":65536}}", 8765),
            ("{\"dashboard\":{\"port\":1.5}}", 8765),
            ("{\"dashboard\":{\"port\":9000.0}}", 9000),
            ("{\"dashboard\":{\"port\":\"9000\"}}", 8765),
            ("{\"dashboard\":{\"port\":[]}}", 8765),
            ("{\"dashboard\":{\"port\":{}}}", 8765),
            ("{\"dashboard\":{\"port\":\"\"}}", 8765),
            ("{\"dashboard\":{\"port\":1}}", 1),
            ("{\"dashboard\":{\"port\":80}}", 80),
            ("{\"dashboard\":{\"port\":9000}}", 9000),
            ("{\"dashboard\":{\"port\":65535}}", 65535),
            ("\u{feff}{\"dashboard\":{\"port\":9101}}", 9101),
            ("{\"dashboard\":{\"port\":9102}}", 9102),
        ] {
            std::fs::write(&path, raw).unwrap();
            assert_eq!(shortcut_url(&path), format!("http://127.0.0.1:{port}/"));
            let parsed = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok();
            let env = std::collections::HashMap::new();
            let sources = crate::core::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "fixture",
                config_path: path.to_str().unwrap(),
                global_poll_ms: None,
            };
            let config = crate::core::assemble_config(parsed.as_ref(), None, &sources).unwrap();
            assert_eq!(config.dashboard.port, port);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        }
    }
    #[test]
    fn requests_read_assets_and_configuration_only_for_install() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("missing config.json");
        for action in ["status", "uninstall"] {
            let request = build_request(action, &config, "own", None).unwrap();
            assert_eq!(
                request,
                json!({"action":action,"configPath":config,"operationId":"own"})
            );
            assert!(!config.exists());
        }
        let icon = root.path().join("icon.icns");
        std::fs::write(&icon, "fixture icon").unwrap();
        std::fs::write(&config, r#"{"dashboard":{"port":9001}}"#).unwrap();
        let request = build_request("install", &config, "own", Some(&icon)).unwrap();
        assert_eq!(request["url"], "http://127.0.0.1:9001/");
        assert_eq!(request["iconPath"], json!(icon));
        assert_eq!(
            request["iconVersion"],
            crate::utils::runtime_paths::sha256_file(&icon).unwrap()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_adapter_hides_process_output_and_preserves_status_locks() {
        let root = tempfile::tempdir().unwrap();
        let lock = root
            .path()
            .join("Library/Application Support/LoongSuite Pilot/Shortcuts/Operation.lock");
        for action in ["install", "uninstall", "status"] {
            std::fs::create_dir_all(&lock).unwrap();
            std::fs::write(lock.join("Owner"), "own").unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "printf synthetic-secret >&2; sleep 60"]);
            let error = run_adapter(
                &mut command,
                action,
                root.path(),
                "own",
                Duration::from_millis(100),
            )
            .await
            .unwrap_err();
            assert!(!error.contains("synthetic-secret"));
            assert_eq!(lock.exists(), action == "status");
        }
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf synthetic-secret >&2; exit 1"]);
        let error = run_adapter(
            &mut command,
            "install",
            root.path(),
            "own",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(!error.contains("synthetic-secret"));
    }

    #[test]
    fn paths_are_absolute_and_lexical_without_requiring_a_config_file() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            absolute_config(Path::new("nested/../配置 ' $().json"), root.path()).unwrap(),
            root.path().join("配置 ' $().json")
        );
        assert_eq!(
            absolute_config(root.path(), root.path()).unwrap(),
            root.path()
        );
    }
    #[test]
    fn timeout_cleanup_removes_only_the_exact_operation_lock() {
        let root = tempfile::tempdir().unwrap();
        let lock = root.path().join("Operation.lock");
        assert!(clean_owned_lock(&lock, "own"));
        std::fs::create_dir(&lock).unwrap();
        std::fs::write(lock.join("Owner"), "other").unwrap();
        assert!(!clean_owned_lock(&lock, "own"));
        assert_eq!(
            std::fs::read_to_string(lock.join("Owner")).unwrap(),
            "other"
        );
        std::fs::write(lock.join("Owner"), "own").unwrap();
        assert!(clean_owned_lock(&lock, "own"));
        assert!(!lock.exists());
    }
    #[cfg(unix)]
    #[test]
    fn timeout_cleanup_preserves_symlinks_and_unrelated_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("Owner"), "own").unwrap();
        let lock = root.path().join("Operation.lock");
        symlink(&external, &lock).unwrap();
        assert!(!clean_owned_lock(&lock, "own"));
        assert!(external.join("Owner").exists());
        std::fs::remove_file(&lock).unwrap();
        std::fs::create_dir(&lock).unwrap();
        symlink(external.join("Owner"), lock.join("Owner")).unwrap();
        assert!(!clean_owned_lock(&lock, "own"));
        assert!(external.join("Owner").exists());
        std::fs::remove_file(lock.join("Owner")).unwrap();
        std::fs::write(lock.join("Owner"), "own").unwrap();
        std::fs::write(lock.join("unrelated"), "keep").unwrap();
        assert!(!clean_owned_lock(&lock, "own"));
        assert_eq!(
            std::fs::read_to_string(lock.join("unrelated")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn responses_and_rendering_keep_status_url_warnings_and_backups() {
        let value = json!({"ok":true,"result":{
            "shortcutPath":"/home/Pilot.webloc","exists":true,"managed":true,
            "url":"http://127.0.0.1:9001/","dockMatches":2,"dockLocked":true,
            "changed":false,"backupPath":"/backup/dock.plist","warnings":["native warning"]
        }});
        let result = response(value.to_string().as_bytes()).unwrap();
        let (out, err) = display(&result, "status", true);
        assert!(out.contains("目标网址: http://127.0.0.1:9001/"));
        assert!(
            out.contains("已锁定") && out.contains("重复") && out.contains("/backup/dock.plist")
        );
        assert_eq!(err, "native warning\n");
        assert!(display(&result, "install", false)
            .0
            .contains("changing the port"));
        assert_eq!(
            response(b"{secret").unwrap_err(),
            "Invalid macOS shortcut response."
        );
        assert_eq!(
            response(b"{\"ok\":false,\"error\":\"controlled helper failure\"}").unwrap_err(),
            "controlled helper failure"
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "dashboard_shortcut_macos_contract_tests.rs"]
mod physical_macos_contract_tests;
