//! Port of `src/cli/menubar.ts`.
//!
//! Persistence of `enableStatusBarApp` and the command text match the
//! TypeScript CLI. App start/stop is injected so the command can be tested
//! without a macOS menu bar process. The default runner uses
//! [`crate::status_bar::StatusBarAppManager`].

use crate::status_bar::{
    ProcessOps, StatusBarAppManager, StatusBarAppStartResult, StatusBarAppStopResult,
};
use crate::utils::{
    config_json_path, is_process_alive, read_json_file, resolve_data_dir, resolve_home,
    write_text_file_atomic, AtomicTextWriteOptions, ExpectedFileState,
};
use serde_json::{json, Value};
use std::collections::HashMap;

const HELP: &str = "Usage: loongsuite-pilot menubar <start|stop>\n\nStart or stop the macOS menu bar app without restarting or stopping the collector.\nstart persists enableStatusBarApp=true and requires a running collector.\nstop persists enableStatusBarApp=false and also works when the collector is stopped.\nRun this command from a terminal in your macOS desktop session (without sudo).";

#[derive(Debug, Default)]
pub struct MenubarIo {
    pub log: Vec<String>,
    pub err: Vec<String>,
    pub warn: Vec<String>,
}

pub type AppFuture<T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send>>;
pub type StartApp =
    Box<dyn Fn(&str, &str) -> AppFuture<Option<StatusBarAppStartResult>> + Send + Sync>;
pub type StopApp = Box<dyn Fn(&str, &str) -> AppFuture<StatusBarAppStopResult> + Send + Sync>;

pub struct MenubarContext {
    pub darwin: bool,
    pub env: HashMap<String, String>,
    pub config_path: String,
    pub data_dir: String,
    pub is_alive: Box<dyn Fn(u32) -> bool + Send + Sync>,
    pub start_app: StartApp,
    pub stop_app: StopApp,
}

pub async fn run_menubar_command(args: &[String], io: &mut MenubarIo) -> i32 {
    let env = std::env::vars().collect();
    let config_path = config_json_path();
    let data_dir = resolve_data_dir(None);
    let context = MenubarContext {
        darwin: cfg!(target_os = "macos"),
        env,
        config_path,
        data_dir: data_dir.clone(),
        is_alive: Box::new(is_process_alive),
        start_app: Box::new(|data_dir, version| {
            let (data_dir, version) = (data_dir.to_owned(), version.to_owned());
            Box::pin(async move {
                let root = crate::deployment::resolve_pilot_dir(&data_dir, &[])?;
                StatusBarAppManager::new(&data_dir, version, ProcessOps::native(&data_dir))
                    .with_source_roots(vec![root])
                    .start()
                    .await
            })
        }),
        stop_app: Box::new(|data_dir, reason| {
            let (data_dir, reason) = (data_dir.to_owned(), reason.to_owned());
            Box::pin(async move {
                // 包资源缺失时仍允许清理已记录、且身份仍匹配的 UI 进程。
                let roots = crate::deployment::resolve_pilot_dir(&data_dir, &[])
                    .ok()
                    .into_iter()
                    .collect();
                StatusBarAppManager::new(
                    &data_dir,
                    env!("CARGO_PKG_VERSION"),
                    ProcessOps::native(&data_dir),
                )
                .with_source_roots(roots)
                .stop(&reason)
                .await
            })
        }),
    };
    let _ = data_dir;
    run_menubar_with(args, io, &context).await
}

pub async fn run_menubar_with(
    args: &[String],
    io: &mut MenubarIo,
    context: &MenubarContext,
) -> i32 {
    if args.is_empty()
        || (args.len() == 1 && matches!(args[0].as_str(), "help" | "--help" | "-h"))
        || (args.len() == 2
            && matches!(args[0].as_str(), "start" | "stop")
            && matches!(args[1].as_str(), "--help" | "-h"))
    {
        io.log.push(HELP.into());
        return 0;
    }
    if args.len() != 1 || !matches!(args[0].as_str(), "start" | "stop") {
        io.err.push(HELP.into());
        return 1;
    }
    if !context.darwin {
        io.err
            .push("The menu bar app is only supported on macOS.".into());
        return 1;
    }
    if args[0] == "start" && status_bar_env_override(&context.env) == Some(false) {
        io.err.push("The menu bar app is disabled by LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP. Unset it or set it to true, then retry.".into());
        return 1;
    }
    let enabled = args[0] == "start";
    let config_path = match persist_status_bar_enabled(&context.config_path, enabled).await {
        Ok(path) => path,
        Err(err) => {
            io.err.push(format!("loongsuite-pilot menubar: {err}"));
            return 1;
        }
    };
    if args[0] == "stop" {
        match (context.stop_app)(&context.data_dir, "cli-request").await {
            Ok(result) => {
                if result.status == "stopped" {
                    io.log.push(format!("Menu bar app stopped (PID {}). Collector was not stopped. Auto-start disabled in {config_path}.", result.pids.iter().map(|pid| pid.to_string()).collect::<Vec<_>>().join(", ")));
                } else {
                    io.log.push(format!("Menu bar app is already stopped. Collector was not stopped. Auto-start disabled in {config_path}."));
                }
                if status_bar_env_override(&context.env) == Some(true) {
                    io.warn.push("Warning: LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP still enables the menu bar and overrides config.json for future Pilot starts.".into());
                }
                0
            }
            Err(err) => {
                io.err.push(format!("loongsuite-pilot menubar: {err}"));
                1
            }
        }
    } else {
        let runtime_path = std::path::Path::new(&context.data_dir)
            .join("logs")
            .join("runtime.json")
            .to_string_lossy()
            .into_owned();
        let runtime = read_json_file::<Value>(&runtime_path).await;
        let pid = runtime
            .as_ref()
            .and_then(|value| value.get("pid"))
            .and_then(|value| value.as_i64());
        let alive = pid
            .is_some_and(|pid| pid > 0 && pid <= u32::MAX as i64 && (context.is_alive)(pid as u32));
        if runtime
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            != Some("active")
            || !alive
        {
            io.err.push(format!("Menu bar auto-start was enabled in {config_path}, but Pilot is not running or is still starting. Run \"loongsuite-pilot start\", wait for startup to finish, then retry."));
            return 1;
        }
        let version = runtime
            .as_ref()
            .and_then(|value| value.get("packageVersion"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        match (context.start_app)(&context.data_dir, version).await {
            Ok(Some(result)) => {
                let verb = if result.status == "started" {
                    "started"
                } else {
                    "is already running"
                };
                io.log.push(format!("Menu bar app {verb} (PID {}). Collector was not restarted. Auto-start enabled in {config_path}.", result.pid));
                0
            }
            Ok(None) => {
                io.err.push(format!(
                    "Menu bar app failed to start. Check logs in {}.",
                    std::path::Path::new(&context.data_dir)
                        .join("logs")
                        .join("app-status-bar")
                        .to_string_lossy()
                ));
                1
            }
            Err(err) => {
                io.err.push(format!("loongsuite-pilot menubar: {err}"));
                1
            }
        }
    }
}

fn status_bar_env_override(env: &HashMap<String, String>) -> Option<bool> {
    let value = env.get("LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP")?;
    let value = if cfg!(windows) {
        value.trim()
    } else {
        value.as_str()
    };
    if value.trim().is_empty() {
        return None;
    }
    Some(value != "false" && value != "0")
}

async fn persist_status_bar_enabled(config_path: &str, enabled: bool) -> Result<String, String> {
    let mut existing_text = None;
    #[cfg(unix)]
    let mut mode = 0o600_u32;
    #[cfg(not(unix))]
    let mode = 0o600_u32;
    match tokio::fs::read_to_string(config_path).await {
        Ok(text) => {
            if let Ok(meta) = tokio::fs::metadata(config_path).await {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    mode = meta.permissions().mode() & 0o777;
                }
                let _ = meta;
            }
            existing_text = Some(text);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    let mut config = json!({});
    if let Some(text) = existing_text.as_ref() {
        let parsed: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|_| format!("refusing to overwrite invalid JSON config: {config_path}"))?;
        if !parsed.is_object() {
            return Err(format!(
                "refusing to overwrite non-object JSON config: {config_path}"
            ));
        }
        if parsed.get("enableStatusBarApp").and_then(Value::as_bool) == Some(enabled) {
            return Ok(config_path.to_string());
        }
        config = parsed;
    }
    config
        .as_object_mut()
        .unwrap()
        .insert("enableStatusBarApp".into(), Value::Bool(enabled));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".into())
    );
    let expected = match existing_text {
        None => ExpectedFileState::Missing,
        Some(text) => ExpectedFileState::Present(text),
    };
    write_text_file_atomic(
        config_path,
        &body,
        &AtomicTextWriteOptions {
            expected: Some(expected),
            backup_path: None,
            mode: Some(mode),
        },
    )
    .await
    .map_err(|err| err.to_string())?;
    Ok(config_path.to_string())
}

#[allow(dead_code)]
fn _home(path: &str) -> String {
    resolve_home(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(dir: &std::path::Path, darwin: bool) -> MenubarContext {
        MenubarContext {
            darwin,
            env: HashMap::from([(
                "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP".into(),
                String::new(),
            )]),
            config_path: dir.join("config.json").to_string_lossy().into_owned(),
            data_dir: dir.to_string_lossy().into_owned(),
            is_alive: Box::new(|_| true),
            start_app: Box::new(|_, _| {
                Box::pin(async {
                    Ok(Some(StatusBarAppStartResult {
                        status: "started",
                        pid: 12345,
                    }))
                })
            }),
            stop_app: Box::new(|_, reason| {
                assert_eq!(reason, "cli-request");
                Box::pin(async {
                    Ok(StatusBarAppStopResult {
                        status: "stopped",
                        pids: vec![12345],
                    })
                })
            }),
        }
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_string()).collect()
    }

    #[tokio::test]
    async fn persists_enablement_and_prints_start_and_stop_results() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("logs")).unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            "{\n  \"keepMe\": \"unchanged\",\n  \"enableStatusBarApp\": false\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("logs").join("runtime.json"),
            r#"{"status":"active","pid":6789,"packageVersion":"1.0.0"}"#,
        )
        .unwrap();
        let runtime_before =
            std::fs::read_to_string(dir.path().join("logs").join("runtime.json")).unwrap();
        let mut context = context(dir.path(), true);
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["start"]), &mut io, &context).await,
            0
        );
        assert!(io.log[0].contains("started (PID 12345)"));
        assert!(io.log[0].contains("Auto-start enabled"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("logs").join("runtime.json")).unwrap(),
            runtime_before
        );
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(config["enableStatusBarApp"], true);
        assert_eq!(config["keepMe"], "unchanged");

        context.start_app = Box::new(|_, _| {
            Box::pin(async {
                Ok(Some(StatusBarAppStartResult {
                    status: "already-running",
                    pid: 12345,
                }))
            })
        });
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["start"]), &mut io, &context).await,
            0
        );
        assert!(io.log[0].contains("already running"));

        std::fs::set_permissions(dir.path().join("config.json"), {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::Permissions::from_mode(0o640)
            }
            #[cfg(not(unix))]
            {
                std::fs::metadata(dir.path().join("config.json"))
                    .unwrap()
                    .permissions()
            }
        })
        .unwrap();
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["stop"]), &mut io, &context).await,
            0
        );
        assert!(io.log[0].contains("stopped (PID 12345)"));
        assert!(io.log[0].contains("Auto-start disabled"));
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(config["enableStatusBarApp"], false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("config.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o640
            );
        }

        context.env.insert(
            "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP".into(),
            "false".into(),
        );
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["start"]), &mut io, &context).await,
            1
        );
        assert!(io.err[0].contains("disabled by LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP"));

        context.env.insert(
            "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP".into(),
            String::new(),
        );
        context.is_alive = Box::new(|_| false);
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"enableStatusBarApp":false}"#,
        )
        .unwrap();
        std::fs::remove_file(dir.path().join("logs").join("runtime.json")).unwrap();
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["start"]), &mut io, &context).await,
            1
        );
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(config["enableStatusBarApp"], true);
        assert!(io.err[0].contains("loongsuite-pilot start"));

        let mut linux = context;
        linux.darwin = false;
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["start"]), &mut io, &linux).await,
            1
        );
        assert!(io.err[0].contains("only supported on macOS"));
        let mut io = MenubarIo::default();
        assert_eq!(
            run_menubar_with(&args(&["--help"]), &mut io, &linux).await,
            0
        );
        assert!(io.log[0].contains("menubar <start|stop>"));
    }
}

#[cfg(test)]
#[path = "menubar_history.rs"]
mod historical_contracts;
