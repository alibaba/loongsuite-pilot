//! Port of `src/local-workers/worker-cli.ts`.
//!
//! Argument parsing keeps runtime options after `--` out of Pilot's own flags.
//! Command text matches the TypeScript CLI, including the status field labels.

use super::instance_store::{
    bootstrap_token_path, connect_local_worker, delete_local_worker_instance,
    list_local_worker_views, read_local_worker_instance, read_local_worker_view,
    reconnect_local_worker, set_local_worker_enabled, ConnectLocalWorkerOptions,
    LocalWorkerInstance, ReconnectLocalWorkerOptions, RuntimeOptionValue, RuntimeOptions,
};
use crate::utils::{read_json_file, resolve_home};
use serde_json::Value;

#[derive(Debug, Default)]
pub struct WorkerCliIo {
    pub log: Vec<String>,
    pub err: Vec<String>,
    pub exit_code: Option<i32>,
}

struct ParsedArgs {
    flags: Vec<(String, FlagValue)>,
    positional: Vec<String>,
    passthrough: Vec<String>,
    passthrough_provided: bool,
}

#[derive(Clone, Debug)]
enum FlagValue {
    Text(String),
    Bool(bool),
}

pub async fn handle_worker_cli(argv: &[String], io: &mut WorkerCliIo) -> bool {
    handle_worker_cli_with(argv, io, None).await
}

pub async fn handle_worker_cli_with(
    argv: &[String],
    io: &mut WorkerCliIo,
    data_dir: Option<String>,
) -> bool {
    if argv.first().map(String::as_str) != Some("worker") {
        return false;
    }
    let command = argv.get(1).map(String::as_str).unwrap_or("");
    let resolved = match data_dir {
        Some(dir) => dir,
        None => match resolve_worker_data_dir().await {
            Ok(dir) => dir,
            Err(err) => {
                io.err.push(format!("loongsuite-pilot worker: {err}"));
                io.exit_code = Some(1);
                return true;
            }
        },
    };
    let result = async {
        match command {
            "connect" => connect_command(&resolved, &parse_args(&argv[2..]), io).await,
            "list" => list_command(&resolved, &parse_args(&argv[2..]), io).await,
            "status" => status_command(&resolved, &parse_args(&argv[2..]), io).await,
            "disconnect" => disconnect_command(&resolved, &parse_args(&argv[2..]), io).await,
            "delete" => delete_command(&resolved, &parse_args(&argv[2..]), io).await,
            _ => {
                print_usage(io);
                io.exit_code = if command.is_empty() { Some(0) } else { Some(1) };
                Ok(())
            }
        }
    }
    .await;
    if let Err(err) = result {
        io.err.push(format!("loongsuite-pilot worker: {err}"));
        io.exit_code = Some(1);
    }
    true
}

async fn resolve_worker_data_dir() -> Result<String, String> {
    if let Ok(env_dir) = std::env::var("LOONGSUITE_PILOT_DATA_DIR") {
        if !env_dir.trim().is_empty() {
            return Ok(resolve_home(env_dir.trim()));
        }
    }
    let config_path = resolve_home(
        &std::env::var("AGENT_DATA_COLLECTION_CONFIG")
            .unwrap_or_else(|_| "~/.loongsuite-pilot/config.json".into()),
    );
    let file = read_json_file::<Value>(&config_path).await;
    let data_dir = file
        .as_ref()
        .and_then(|value| value.get("dataDir"))
        .and_then(Value::as_str)
        .unwrap_or("~/.loongsuite-pilot");
    Ok(resolve_home(data_dir))
}

async fn connect_command(
    data_dir: &str,
    args: &ParsedArgs,
    io: &mut WorkerCliIo,
) -> Result<(), String> {
    validate_flags(
        args,
        &["runtime", "bootstrap-token", "work-dir", "json"],
        true,
    )?;
    if let Some(existing_id) = args.positional.first() {
        if optional_string(args, "runtime").is_some() {
            return Err("--runtime is only valid when creating a new local worker".into());
        }
        let instance = reconnect_local_worker(ReconnectLocalWorkerOptions {
            data_dir,
            instance_id: existing_id,
            bootstrap_token: optional_string(args, "bootstrap-token"),
            work_dir: optional_string(args, "work-dir"),
            runtime_options: if args.passthrough_provided {
                Some(parse_runtime_options(&args.passthrough)?)
            } else {
                None
            },
        })
        .await?;
        print_instance(io, &instance, args, "reconnected");
        return Ok(());
    }
    let instance = connect_local_worker(ConnectLocalWorkerOptions {
        data_dir,
        runtime: required_string(args, "runtime")?,
        bootstrap_token: required_string(args, "bootstrap-token")?,
        work_dir: optional_string(args, "work-dir"),
        runtime_options: Some(parse_runtime_options(&args.passthrough)?),
    })
    .await?;
    print_instance(io, &instance, args, "connected");
    Ok(())
}

fn print_instance(
    io: &mut WorkerCliIo,
    instance: &LocalWorkerInstance,
    args: &ParsedArgs,
    verb: &str,
) {
    if flag_bool(args, "json") {
        io.log
            .push(serde_json::to_string_pretty(instance).unwrap_or_else(|_| "{}".into()));
        return;
    }
    io.log.push(format!("{verb} {}", instance.id));
    io.log.push(format!("runtime: {}", instance.runtime));
    io.log.push(format!("workDir: {}", instance.work_dir));
}

async fn list_command(
    data_dir: &str,
    args: &ParsedArgs,
    io: &mut WorkerCliIo,
) -> Result<(), String> {
    validate_flags(args, &["json"], false)?;
    let views = list_local_worker_views(data_dir).await?;
    if flag_bool(args, "json") {
        io.log.push(
            serde_json::to_string_pretty(&views_json(&views)).unwrap_or_else(|_| "[]".into()),
        );
        return Ok(());
    }
    if views.is_empty() {
        io.log.push("No local workers.".into());
        return Ok(());
    }
    let mut rows = vec![vec![
        "ID".into(),
        "RUNTIME".into(),
        "STATE".into(),
        "WORKDIR".into(),
        "WORKER".into(),
        "UPDATED".into(),
    ]];
    for view in &views {
        rows.push(vec![
            view.id.clone(),
            view.runtime.clone(),
            view.state.clone(),
            view.work_dir.clone(),
            view.worker_name.clone().unwrap_or_else(|| "-".into()),
            view.updated_at.clone(),
        ]);
    }
    print_table(io, &rows);
    Ok(())
}

async fn status_command(
    data_dir: &str,
    args: &ParsedArgs,
    io: &mut WorkerCliIo,
) -> Result<(), String> {
    validate_flags(args, &["json"], false)?;
    let Some(id) = args.positional.first() else {
        return list_command(data_dir, args, io).await;
    };
    let instance = read_local_worker_instance(data_dir, id)
        .await?
        .ok_or_else(|| format!("local worker not found: {id}"))?;
    let view = read_local_worker_view(data_dir, &instance).await?;
    if flag_bool(args, "json") {
        io.log
            .push(serde_json::to_string_pretty(&view_json(&view)).unwrap_or_else(|_| "{}".into()));
        return Ok(());
    }
    io.log.push(format!("ID:          {}", view.id));
    io.log.push(format!("Runtime:     {}", view.runtime));
    io.log.push(format!("State:       {}", view.state));
    if let Some(reason) = &view.reason {
        io.log.push(format!("Reason:      {reason}"));
    }
    if let Some(message) = &view.message {
        io.log.push(format!("Message:     {message}"));
    }
    if let Some(pid) = view.pid {
        io.log.push(format!("PID:         {pid}"));
    }
    io.log.push(format!("WorkDir:     {}", view.work_dir));
    io.log.push(format!(
        "Worker:      {}",
        view.worker_name.unwrap_or_else(|| "-".into())
    ));
    io.log.push(format!(
        "Team:        {}",
        view.team_name.unwrap_or_else(|| "-".into())
    ));
    io.log.push(format!(
        "Matrix:      {}",
        view.matrix.unwrap_or_else(|| "-".into())
    ));
    io.log.push(format!(
        "Room:        {}",
        view.room_id.unwrap_or_else(|| "-".into())
    ));
    io.log.push(format!(
        "Heartbeat:   {}",
        view.heartbeat.unwrap_or_else(|| "-".into())
    ));
    io.log.push(format!("Log:         {}", view.log_path));
    Ok(())
}

async fn disconnect_command(
    data_dir: &str,
    args: &ParsedArgs,
    io: &mut WorkerCliIo,
) -> Result<(), String> {
    validate_flags(args, &["json"], false)?;
    let id = args.positional.first().ok_or("instance id is required")?;
    let instance = set_local_worker_enabled(data_dir, id, false).await?;
    if flag_bool(args, "json") {
        io.log
            .push(serde_json::to_string_pretty(&instance).unwrap_or_else(|_| "{}".into()));
    } else {
        io.log.push(format!("disconnect requested {}", instance.id));
    }
    Ok(())
}

async fn delete_command(
    data_dir: &str,
    args: &ParsedArgs,
    io: &mut WorkerCliIo,
) -> Result<(), String> {
    validate_flags(args, &["json"], false)?;
    let id = args.positional.first().ok_or("instance id is required")?;
    delete_local_worker_instance(data_dir, id).await?;
    if flag_bool(args, "json") {
        io.log.push(
            serde_json::to_string_pretty(&serde_json::json!({"id": id, "deleted": true}))
                .unwrap_or_else(|_| "{}".into()),
        );
    } else {
        io.log.push(format!("deleted {id}"));
    }
    Ok(())
}

fn parse_args(argv: &[String]) -> ParsedArgs {
    let mut flags = Vec::new();
    let mut positional = Vec::new();
    let mut passthrough = Vec::new();
    let mut passthrough_provided = false;
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if passthrough_provided {
            passthrough.push(arg.clone());
            index += 1;
            continue;
        }
        if arg == "--" {
            passthrough_provided = true;
            index += 1;
            continue;
        }
        if !arg.starts_with("--") {
            positional.push(arg.clone());
            index += 1;
            continue;
        }
        if let Some(eq) = arg.find('=').filter(|eq| *eq > 0) {
            flags.push((
                arg[2..eq].to_string(),
                FlagValue::Text(arg[eq + 1..].to_string()),
            ));
            index += 1;
            continue;
        }
        let key = arg[2..].to_string();
        if let Some(next) = argv.get(index + 1) {
            if !next.starts_with("--") {
                flags.push((key, FlagValue::Text(next.clone())));
                index += 2;
                continue;
            }
        }
        flags.push((key, FlagValue::Bool(true)));
        index += 1;
    }
    ParsedArgs {
        flags,
        positional,
        passthrough,
        passthrough_provided,
    }
}

fn validate_flags(
    args: &ParsedArgs,
    allowed: &[&str],
    allow_runtime_options: bool,
) -> Result<(), String> {
    for (name, _) in &args.flags {
        if !allowed.contains(&name.as_str()) {
            return Err(format!(
                "unknown option --{name}; pass runtime worker arguments after \"--\""
            ));
        }
    }
    if !allow_runtime_options && args.passthrough_provided {
        return Err("runtime worker arguments are only supported by connect".into());
    }
    Ok(())
}

fn parse_runtime_options(argv: &[String]) -> Result<RuntimeOptions, String> {
    let mut options = RuntimeOptions::new();
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if !arg.starts_with("--") || arg == "--" {
            return Err(format!("runtime worker argument must be an option: {arg}"));
        }
        let body = &arg[2..];
        if let Some(eq) = body.find('=') {
            let key = &body[..eq];
            if key.is_empty() {
                return Err(format!("runtime worker argument has empty name: {arg}"));
            }
            options.insert(
                key.to_string(),
                RuntimeOptionValue::Text(body[eq + 1..].to_string()),
            );
            index += 1;
            continue;
        }
        if body.is_empty() {
            return Err(format!("runtime worker argument has empty name: {arg}"));
        }
        if let Some(next) = argv.get(index + 1) {
            if !next.starts_with("--") {
                options.insert(body.to_string(), RuntimeOptionValue::Text(next.clone()));
                index += 2;
                continue;
            }
        }
        options.insert(body.to_string(), RuntimeOptionValue::Bool(true));
        index += 1;
    }
    Ok(options)
}

fn required_string<'a>(args: &'a ParsedArgs, name: &str) -> Result<&'a str, String> {
    optional_string(args, name).ok_or_else(|| format!("--{name} is required"))
}

fn optional_string<'a>(args: &'a ParsedArgs, name: &str) -> Option<&'a str> {
    args.flags
        .iter()
        .rev()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match value {
            FlagValue::Text(text) if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
}

fn flag_bool(args: &ParsedArgs, name: &str) -> bool {
    args.flags.iter().any(|(key, value)| {
        key == name && matches!(value, FlagValue::Bool(true) | FlagValue::Text(_))
    })
}

fn print_table(io: &mut WorkerCliIo, rows: &[Vec<String>]) {
    if rows.is_empty() {
        return;
    }
    let widths: Vec<usize> = (0..rows[0].len())
        .map(|index| rows.iter().map(|row| row[index].len()).max().unwrap_or(0))
        .collect();
    for row in rows {
        io.log.push(
            row.iter()
                .enumerate()
                .map(|(index, cell)| format!("{cell:<width$}", width = widths[index]))
                .collect::<Vec<_>>()
                .join("  "),
        );
    }
}

fn views_json(views: &[super::instance_store::LocalWorkerView]) -> Value {
    Value::Array(views.iter().map(view_json).collect())
}

fn view_json(view: &super::instance_store::LocalWorkerView) -> Value {
    serde_json::json!({
        "id": view.id,
        "runtime": view.runtime,
        "workDir": view.work_dir,
        "enabled": view.enabled,
        "state": view.state,
        "reason": view.reason,
        "message": view.message,
        "pid": view.pid,
        "workerName": view.worker_name,
        "teamName": view.team_name,
        "matrix": view.matrix,
        "roomId": view.room_id,
        "heartbeat": view.heartbeat,
        "updatedAt": view.updated_at,
        "logPath": view.log_path,
    })
}

fn print_usage(io: &mut WorkerCliIo) {
    io.log.push("Usage:\n  loongsuite-pilot worker connect --runtime claude-code --bootstrap-token <token> [--work-dir <dir>] [-- <runtime-options...>]\n  loongsuite-pilot worker connect <instanceId> [--bootstrap-token <token>] [--work-dir <dir>] [-- <runtime-options...>]\n  loongsuite-pilot worker list [--json]\n  loongsuite-pilot worker status [instanceId] [--json]\n  loongsuite-pilot worker disconnect <instanceId>\n  loongsuite-pilot worker delete <instanceId>\n\nNotes:\n  connect <instanceId> reconnects an existing disconnected worker without\n  requiring the bootstrap token again. Pass --bootstrap-token to rotate the\n  saved token file for that instance. Options after \"--\" are stored as runtime\n  options and expanded by worker.manifest.json instance placeholders.".into());
}

#[allow(dead_code)]
fn _token_path(data_dir: &str, instance: &LocalWorkerInstance) -> String {
    bootstrap_token_path(data_dir, instance)
}

#[cfg(test)]
mod tests {
    use super::super::instance_store::{read_local_worker_instance, state_dir};
    use super::RuntimeOptionValue;
    use super::*;
    use base64::Engine;

    fn token(worker: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(format!(
            r#"{{"workerUuid":"{worker}","matrixUrl":"https://matrix.example.com","controllerUrl":"https://controller.example.com","modelGatewayUrl":"https://model.example.com"}}"#
        ))
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_string()).collect()
    }

    #[tokio::test]
    async fn reconnects_stores_runtime_options_and_prints_waiting_status() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").to_string_lossy().into_owned();
        let project = dir.path().join("project").to_string_lossy().into_owned();
        let mut io = WorkerCliIo::default();
        assert!(
            handle_worker_cli_with(
                &args(&[
                    "worker",
                    "connect",
                    "--runtime",
                    "claude-code",
                    "--bootstrap-token",
                    &token("550e8400-e29b-41d4-a716-446655440000"),
                    "--work-dir",
                    &project,
                    "--",
                    "--model-config-mode",
                    "managed-global",
                    "--plugin-install-scope=global",
                    "--enable-trace-hook"
                ]),
                &mut io,
                Some(data.clone())
            )
            .await
        );
        let instance_id = io.log[0].trim_start_matches("connected ").to_string();
        let instance = read_local_worker_instance(&data, &instance_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            instance.runtime_options.get("model-config-mode"),
            Some(&RuntimeOptionValue::Text("managed-global".into()))
        );
        assert_eq!(
            instance.runtime_options.get("plugin-install-scope"),
            Some(&RuntimeOptionValue::Text("global".into()))
        );
        assert_eq!(
            instance.runtime_options.get("enable-trace-hook"),
            Some(&RuntimeOptionValue::Bool(true))
        );

        io.log.clear();
        handle_worker_cli_with(
            &args(&["worker", "disconnect", &instance_id]),
            &mut io,
            Some(data.clone()),
        )
        .await;
        io.log.clear();
        handle_worker_cli_with(
            &args(&["worker", "connect", &instance_id]),
            &mut io,
            Some(data.clone()),
        )
        .await;
        assert!(io
            .log
            .iter()
            .any(|line| line == &format!("reconnected {instance_id}")));
        let instance = read_local_worker_instance(&data, &instance_id)
            .await
            .unwrap()
            .unwrap();
        assert!(instance.enabled);
        assert_eq!(
            std::fs::read_to_string(bootstrap_token_path(&data, &instance)).unwrap(),
            token("550e8400-e29b-41d4-a716-446655440000")
        );

        let rotated = token("rotated-worker-uuid");
        io.log.clear();
        handle_worker_cli_with(
            &args(&[
                "worker",
                "connect",
                &instance_id,
                "--bootstrap-token",
                &rotated,
            ]),
            &mut io,
            Some(data.clone()),
        )
        .await;
        let instance = read_local_worker_instance(&data, &instance_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(bootstrap_token_path(&data, &instance)).unwrap(),
            rotated
        );

        let mut rejected = WorkerCliIo::default();
        handle_worker_cli_with(
            &args(&[
                "worker",
                "connect",
                "--runtime",
                "claude-code",
                "--bootstrap-token",
                &token("550e8400-e29b-41d4-a716-446655440000"),
                "--model-config-mode",
                "managed-global",
            ]),
            &mut rejected,
            Some(data.clone()),
        )
        .await;
        assert_eq!(rejected.exit_code, Some(1));

        let mut passthrough = WorkerCliIo::default();
        handle_worker_cli_with(
            &args(&[
                "worker",
                "list",
                "--",
                "--model-config-mode",
                "managed-global",
            ]),
            &mut passthrough,
            Some(data.clone()),
        )
        .await;
        assert_eq!(passthrough.exit_code, Some(1));

        let s_dir = state_dir(&data, &instance_id);
        std::fs::write(
            std::path::Path::new(&s_dir).join("supervisor-status.json"),
            format!(r#"{{"state":"running","pid":{}}}"#, std::process::id()),
        )
        .unwrap();
        std::fs::write(std::path::Path::new(&s_dir).join("status.json"), r#"{"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"runtime command is not installed"}"#).unwrap();
        let mut status = WorkerCliIo::default();
        handle_worker_cli_with(
            &args(&["worker", "status", &instance_id]),
            &mut status,
            Some(data),
        )
        .await;
        assert!(status.log.iter().any(|line| line == "State:       waiting"));
        assert!(status
            .log
            .iter()
            .any(|line| line == "Reason:      RuntimeCommandNotFound"));
        assert!(status
            .log
            .iter()
            .any(|line| line == "Message:     runtime command is not installed"));
    }

    #[tokio::test]
    async fn unrelated_commands_are_not_claimed() {
        let mut io = WorkerCliIo::default();
        assert!(!handle_worker_cli(&args(&["agent", "list"]), &mut io).await);
    }
}

#[cfg(test)]
#[path = "worker_cli_history_contract_tests.rs"]
mod history_contract_tests;
