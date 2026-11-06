//! Port of `src/pi-sdk/pi-sdk-agent-cli.ts`.

use super::pi_sdk_agent_registry::{
    doctor_pi_sdk_agent, list_registered_pi_sdk_agents, register_pi_sdk_agent,
    unregister_pi_sdk_agent, PiSdkAgentRegistrationRequest,
};
use crate::types::AgentDefinition;
use crate::utils::{read_json_file, redirect_root_logger_to_stderr, resolve_home};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct PiSdkCliIo {
    pub log: Vec<String>,
    pub err: Vec<String>,
    pub warn: Vec<String>,
    pub exit_code: Option<i32>,
}

struct ParsedArgs {
    flags: HashMap<String, Vec<String>>,
    positional: Vec<String>,
}

pub async fn handle_pi_sdk_agent_cli(argv: &[String], io: &mut PiSdkCliIo) -> bool {
    handle_pi_sdk_agent_cli_with(argv, io, None).await
}

pub async fn handle_pi_sdk_agent_cli_with(
    argv: &[String],
    io: &mut PiSdkCliIo,
    data_dir: Option<String>,
) -> bool {
    if argv.first().map(String::as_str) != Some("agent") {
        return false;
    }
    if argv
        .iter()
        .any(|arg| arg == "--json" || arg.starts_with("--json="))
    {
        redirect_root_logger_to_stderr();
    }
    let command = argv.get(1).map(String::as_str).unwrap_or("");
    let resolved = match data_dir {
        Some(dir) => dir,
        None => match resolve_agent_cli_data_dir().await {
            Ok(dir) => dir,
            Err(err) => {
                io.err.push(format!("loongsuite-pilot agent: {err}"));
                io.exit_code = Some(1);
                return true;
            }
        },
    };
    let result = async {
        match command {
            "register" => register_command(&resolved, &argv[2..], io).await,
            "list" => list_command(&resolved, &argv[2..], io).await,
            "doctor" | "status" => doctor_command(&resolved, &argv[2..], io).await,
            "unregister" => unregister_command(&resolved, &argv[2..], io).await,
            _ => {
                print_usage(io);
                io.exit_code = if command.is_empty() { Some(0) } else { Some(1) };
                Ok(())
            }
        }
    }
    .await;
    if let Err(err) = result {
        io.err.push(format!("loongsuite-pilot agent: {err}"));
        io.exit_code = Some(1);
    }
    true
}

async fn register_command(
    data_dir: &str,
    argv: &[String],
    io: &mut PiSdkCliIo,
) -> Result<(), String> {
    if argv.first().map(String::as_str) != Some("pi-sdk") {
        return Err("register currently supports only: pi-sdk".into());
    }
    let args = parse_args(&argv[1..]);
    validate_flags(
        &args,
        &[
            "id",
            "name",
            "agent-dir",
            "detect-path",
            "detect-command",
            "json",
        ],
    )?;
    if let Some(extra) = args.positional.first() {
        return Err(format!("unexpected argument: {extra}"));
    }
    let result = register_pi_sdk_agent(PiSdkAgentRegistrationRequest {
        data_dir: data_dir.to_string(),
        id: required_single(&args, "id")?,
        name: required_single(&args, "name")?,
        agent_dir: required_single(&args, "agent-dir")?,
        detection_paths: values(&args, "detect-path"),
        detection_commands: values(&args, "detect-command"),
    })
    .await?;
    if has_flag(&args, "json") {
        io.log.push(
            serde_json::to_string_pretty(&json!({
                "id": result.definition.id,
                "name": result.definition.display_name,
                "agentDir": result.definition.pi_sdk.as_ref().map(|sdk| sdk.agent_dir.clone()),
                "settingsPath": result.settings_path,
                "definitionPath": result.definition_path,
                "wrapperPath": result.wrapper_path,
                "warnings": result.warnings,
                "collectorRestartRecommended": true,
            }))
            .unwrap_or_else(|_| "{}".into()),
        );
        return Ok(());
    }
    io.log
        .push(format!("registered PI SDK Agent: {}", result.definition.id));
    io.log
        .push(format!("name:       {}", result.definition.display_name));
    io.log.push(format!(
        "agentDir:   {}",
        result
            .definition
            .pi_sdk
            .as_ref()
            .map(|sdk| sdk.agent_dir.as_str())
            .unwrap_or("")
    ));
    io.log.push(format!("settings:   {}", result.settings_path));
    io.log
        .push(format!("definition: {}", result.definition_path));
    for warning in result.warnings {
        io.warn.push(format!("warning: {warning}"));
    }
    io.log.push(
        "Restart the custom Agent (or reload its AgentSession) if it is already running.".into(),
    );
    Ok(())
}

async fn list_command(data_dir: &str, argv: &[String], io: &mut PiSdkCliIo) -> Result<(), String> {
    let args = parse_args(argv);
    validate_flags(&args, &["json"])?;
    if let Some(extra) = args.positional.first() {
        return Err(format!("unexpected argument: {extra}"));
    }
    let definitions = list_registered_pi_sdk_agents(data_dir).await;
    if has_flag(&args, "json") {
        io.log.push(
            serde_json::to_string_pretty(&Value::Array(
                definitions.iter().map(to_list_record).collect(),
            ))
            .unwrap_or_else(|_| "[]".into()),
        );
        return Ok(());
    }
    if definitions.is_empty() {
        io.log.push("No registered PI SDK Agents.".into());
        return Ok(());
    }
    let mut rows = vec![vec!["ID".into(), "NAME".into(), "AGENT DIR".into()]];
    for definition in definitions {
        rows.push(vec![
            definition.id,
            definition.display_name,
            definition
                .pi_sdk
                .map(|sdk| sdk.agent_dir)
                .unwrap_or_else(|| "-".into()),
        ]);
    }
    print_table(io, &rows);
    Ok(())
}

async fn doctor_command(
    data_dir: &str,
    argv: &[String],
    io: &mut PiSdkCliIo,
) -> Result<(), String> {
    let args = parse_args(argv);
    validate_flags(&args, &["json"])?;
    let id = args.positional.first().ok_or("agent id is required")?;
    if args.positional.len() > 1 {
        return Err(format!("unexpected argument: {}", args.positional[1]));
    }
    let result = doctor_pi_sdk_agent(data_dir, id).await?;
    if has_flag(&args, "json") {
        io.log.push(
            serde_json::to_string_pretty(&json!({
                "id": result.id,
                "name": result.name,
                "agentDir": result.agent_dir,
                "detected": result.detected,
                "wrapperPresent": result.wrapper_present,
                "runtimePresent": result.runtime_present,
                "injectionPresent": result.injection_present,
                "healthy": result.healthy,
            }))
            .unwrap_or_else(|_| "{}".into()),
        );
        return Ok(());
    }
    io.log.push(format!("ID:        {}", result.id));
    io.log.push(format!("Name:      {}", result.name));
    io.log.push(format!("Agent dir: {}", result.agent_dir));
    io.log
        .push(format!("Detected:  {}", yes_no(result.detected)));
    io.log
        .push(format!("Runtime:   {}", yes_no(result.runtime_present)));
    io.log
        .push(format!("Wrapper:   {}", yes_no(result.wrapper_present)));
    io.log
        .push(format!("Injected:  {}", yes_no(result.injection_present)));
    io.log
        .push(format!("Healthy:   {}", yes_no(result.healthy)));
    Ok(())
}

async fn unregister_command(
    data_dir: &str,
    argv: &[String],
    io: &mut PiSdkCliIo,
) -> Result<(), String> {
    let args = parse_args(argv);
    validate_flags(&args, &["json"])?;
    let id = args.positional.first().ok_or("agent id is required")?;
    if args.positional.len() > 1 {
        return Err(format!("unexpected argument: {}", args.positional[1]));
    }
    let result = unregister_pi_sdk_agent(data_dir, id).await?;
    if has_flag(&args, "json") {
        io.log.push(serde_json::to_string_pretty(&json!({"id": result.id, "injectionRemoved": result.injection_removed, "definitionRemoved": result.definition_removed, "collectorRestartRecommended": true})).unwrap_or_else(|_| "{}".into()));
        return Ok(());
    }
    io.log
        .push(format!("unregistered PI SDK Agent: {}", result.id));
    Ok(())
}

async fn resolve_agent_cli_data_dir() -> Result<String, String> {
    if let Ok(env_dir) = std::env::var("LOONGSUITE_PILOT_DATA_DIR") {
        if !env_dir.trim().is_empty() {
            return Ok(resolve_home(env_dir.trim()));
        }
    }
    let config_path = resolve_home(
        &std::env::var("AGENT_DATA_COLLECTION_CONFIG")
            .unwrap_or_else(|_| "~/.loongsuite-pilot/config.json".into()),
    );
    let config = read_json_file::<Value>(&config_path).await;
    let data_dir = config
        .as_ref()
        .and_then(|value| value.get("dataDir"))
        .and_then(Value::as_str)
        .unwrap_or("~/.loongsuite-pilot");
    Ok(resolve_home(data_dir))
}

fn parse_args(argv: &[String]) -> ParsedArgs {
    let mut flags = HashMap::new();
    let mut positional = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if !arg.starts_with("--") {
            positional.push(arg.clone());
            index += 1;
            continue;
        }
        if let Some(eq) = arg.find('=').filter(|eq| *eq > 2) {
            push_flag(&mut flags, &arg[2..eq], &arg[eq + 1..]);
            index += 1;
            continue;
        }
        let name = arg[2..].to_string();
        if let Some(next) = argv.get(index + 1) {
            if !next.starts_with("--") {
                push_flag(&mut flags, &name, next);
                index += 2;
                continue;
            }
        }
        push_flag(&mut flags, &name, "true");
        index += 1;
    }
    ParsedArgs { flags, positional }
}

fn push_flag(flags: &mut HashMap<String, Vec<String>>, name: &str, value: &str) {
    flags
        .entry(name.to_string())
        .or_default()
        .push(value.to_string());
}

fn validate_flags(args: &ParsedArgs, allowed: &[&str]) -> Result<(), String> {
    for name in args.flags.keys() {
        if !allowed.contains(&name.as_str()) {
            return Err(format!("unknown option --{name}"));
        }
    }
    Ok(())
}

fn required_single(args: &ParsedArgs, name: &str) -> Result<String, String> {
    let all = values(args, name);
    if all.is_empty() || all[0].trim().is_empty() {
        return Err(format!("--{name} is required"));
    }
    if all.len() > 1 {
        return Err(format!("--{name} may only be provided once"));
    }
    Ok(all[0].clone())
}

fn values(args: &ParsedArgs, name: &str) -> Vec<String> {
    args.flags.get(name).cloned().unwrap_or_default()
}

fn has_flag(args: &ParsedArgs, name: &str) -> bool {
    args.flags.contains_key(name)
}

fn to_list_record(definition: &AgentDefinition) -> Value {
    json!({
        "id": definition.id,
        "name": definition.display_name,
        "agentDir": definition.pi_sdk.as_ref().map(|sdk| sdk.agent_dir.clone()),
        "detection": {"paths": definition.detection.paths, "commands": definition.detection.commands},
    })
}

fn print_table(io: &mut PiSdkCliIo, rows: &[Vec<String>]) {
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

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn print_usage(io: &mut PiSdkCliIo) {
    io.log.push("Usage:\n  loongsuite-pilot agent register pi-sdk --id <id> --name <name> --agent-dir <dir> \\\n    [--detect-path <path> ...] [--detect-command <command> ...]\n  loongsuite-pilot agent list [--json]\n  loongsuite-pilot agent doctor <id> [--json]\n  loongsuite-pilot agent unregister <id> [--json]\n\nThe registered Agent must use @earendil-works/pi-coding-agent's high-level SDK\nand load extensions from the supplied agentDir.".into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_string()).collect()
    }

    async fn runtime(data: &std::path::Path) {
        tokio::fs::create_dir_all(data.join("plugins").join("pi-coding-agent"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(data.join("plugins").join("shared"))
            .await
            .unwrap();
        tokio::fs::write(
            data.join("plugins")
                .join("pi-coding-agent")
                .join("index.mjs"),
            "export {}\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            data.join("plugins")
                .join("shared")
                .join("resource-context.mjs"),
            "export {}\n",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn registers_repeated_detection_flags_and_rejects_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("pilot-data");
        runtime(&data).await;
        let agent = dir.path().join("agent-dir");
        let path_a = dir.path().join("detected-a");
        let path_b = dir.path().join("detected-b");
        let mut io = PiSdkCliIo::default();
        assert!(
            handle_pi_sdk_agent_cli_with(
                &args(&[
                    "agent",
                    "register",
                    "pi-sdk",
                    "--id",
                    "acme-code",
                    "--name",
                    "Acme Code",
                    "--agent-dir",
                    agent.to_str().unwrap(),
                    "--detect-path",
                    path_a.to_str().unwrap(),
                    "--detect-path",
                    path_b.to_str().unwrap(),
                    "--detect-command",
                    "acme-code"
                ]),
                &mut io,
                Some(data.to_string_lossy().into_owned())
            )
            .await
        );
        assert!(io.exit_code.is_none());
        let definition: Value = serde_json::from_str(
            &std::fs::read_to_string(data.join("agents.d.local").join("acme-code.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            definition["detection"],
            json!({"paths":[path_a.to_string_lossy().as_ref(),path_b.to_string_lossy().as_ref()],"commands":["acme-code"]})
        );
        let mut unregister = PiSdkCliIo::default();
        assert!(
            handle_pi_sdk_agent_cli_with(
                &args(&["agent", "unregister", "acme-code"]),
                &mut unregister,
                Some(data.to_string_lossy().into_owned())
            )
            .await
        );
        assert!(!data.join("agents.d.local").join("acme-code.json").exists());

        let mut other = PiSdkCliIo::default();
        assert!(!handle_pi_sdk_agent_cli(&args(&["worker", "list"]), &mut other).await);
        let mut invalid = PiSdkCliIo::default();
        assert!(
            handle_pi_sdk_agent_cli_with(
                &args(&["agent", "register", "pi-sdk", "--id", "missing-fields"]),
                &mut invalid,
                Some(data.to_string_lossy().into_owned())
            )
            .await
        );
        assert_eq!(invalid.exit_code, Some(1));
        assert!(invalid
            .err
            .iter()
            .any(|line| line.contains("--name is required")));
    }

    #[tokio::test]
    async fn json_mode_prints_one_object() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("pilot-data");
        runtime(&data).await;
        let mut io = PiSdkCliIo::default();
        assert!(
            handle_pi_sdk_agent_cli_with(
                &args(&[
                    "agent",
                    "register",
                    "pi-sdk",
                    "--id",
                    "json-code",
                    "--name",
                    "JSON Code",
                    "--agent-dir",
                    dir.path().join("json-agent-dir").to_str().unwrap(),
                    "--detect-path",
                    dir.path().join("json-detected").to_str().unwrap(),
                    "--json"
                ]),
                &mut io,
                Some(data.to_string_lossy().into_owned())
            )
            .await
        );
        assert!(io.exit_code.is_none());
        assert_eq!(io.log.len(), 1);
        let parsed: Value = serde_json::from_str(&io.log[0]).unwrap();
        assert_eq!(parsed["id"], "json-code");
        assert_eq!(parsed["name"], "JSON Code");
    }
}

#[cfg(test)]
#[path = "pi_sdk_agent_cli_history.rs"]
mod historical_contracts;
