//! `loongsuite-pilot hook` argument parsing.

use super::hook_install_service::{run_hook_install, to_public_report, HookInstallRunOptions};
use crate::types::AnalyticsConfig;
use crate::utils::{redirect_root_logger_to_stderr, resolve_home};
use std::collections::HashMap;

use super::deploy_command::{is_agent_gated_enabled, resolve_pilot_dir};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHookArgs {
    pub subcommand: String,
    pub agents: Option<String>,
    pub homes: HashMap<String, String>,
    pub config_dir: Option<String>,
    pub json: bool,
    pub pilot_dir: Option<String>,
    pub help: bool,
}

pub fn parse_hook_args(argv: &[String]) -> Result<ParsedHookArgs, String> {
    let mut out = ParsedHookArgs {
        subcommand: "help".into(),
        agents: None,
        homes: HashMap::new(),
        config_dir: None,
        json: false,
        pilot_dir: None,
        help: false,
    };
    let mut rest = argv.to_vec();
    let first = rest.first().cloned();
    match first.as_deref() {
        Some("install") | Some("status") => {
            out.subcommand = first.unwrap();
            rest.remove(0);
        }
        Some("--help") | Some("-h") | None => {
            out.help = true;
            return Ok(out);
        }
        Some(other) => return Err(format!("Unknown hook command: {other}")),
    }
    let mut index = 0;
    while index < rest.len() {
        let arg = rest[index].clone();
        if arg == "--json" {
            out.json = true;
            index += 1;
            continue;
        }
        if arg == "--help" || arg == "-h" {
            out.help = true;
            index += 1;
            continue;
        }
        let (key, inline) = match arg.split_once('=') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if !matches!(
            key.as_str(),
            "--agents" | "--home" | "--config-dir" | "--pilot-dir"
        ) {
            return Err(format!("Unknown option: {arg}"));
        }
        let value = match inline {
            Some(value) => value,
            None => {
                index += 1;
                rest.get(index).cloned().unwrap_or_default()
            }
        };
        if value.trim().is_empty() || value.starts_with("--") {
            return Err(format!("Missing value for {key}"));
        }
        match key.as_str() {
            "--agents" => out.agents = Some(value),
            "--config-dir" => out.config_dir = Some(value),
            "--pilot-dir" => out.pilot_dir = Some(value),
            _ => {
                let Some((id, dir)) = value.split_once('=') else {
                    return Err(format!("--home must be <agent-id>=<dir>, got {value}"));
                };
                if id.is_empty() || dir.is_empty() {
                    return Err(format!("--home must be <agent-id>=<dir>, got {value}"));
                }
                out.homes.insert(id.to_string(), dir.to_string());
            }
        }
        index += 1;
    }
    Ok(out)
}

pub fn hook_usage() -> &'static str {
    "Usage: loongsuite-pilot hook install [--agents <ids>] [--home <id>=<dir>]... [--config-dir PATH] [--json]\n       loongsuite-pilot hook status [--agents <ids>] [--json]\n\nDetects every agent when --agents and LOONGSUITE_PILOT_AGENTS are unset.\nThe exact value none skips injection. The literal null is treated as unset."
}

pub async fn run_hook_command_with_config(
    argv: &[String],
    config: &AnalyticsConfig,
    env_agents: Option<&str>,
) -> Result<i32, String> {
    redirect_root_logger_to_stderr();
    let parsed = parse_hook_args(argv)?;
    if parsed.help || parsed.subcommand == "help" {
        println!("{}", hook_usage());
        return Ok(0);
    }
    let data_dir = node_data_dir(&config.data_dir);
    let pilot_dir = match &parsed.pilot_dir {
        Some(dir) => crate::utils::runtime_paths::resolve_resource_root(&data_dir, Some(dir), &[])
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .into_owned(),
        None => resolve_pilot_dir(&data_dir, &[])?,
    };
    let mut homes = parsed.homes.clone();
    if let Some(config_dir) = &parsed.config_dir {
        homes
            .entry("claude-code".into())
            .or_insert_with(|| config_dir.clone());
    }
    let result = run_hook_install(HookInstallRunOptions {
        data_dir,
        pilot_dir,
        builtin_agents_dir: None,
        agents_flag: parsed.agents.clone(),
        env_agents: if parsed.agents.is_none() {
            env_agents.map(|value| value.to_string())
        } else {
            None
        },
        homes,
        write_result: parsed.subcommand == "install",
        deploy_modes: None,
        enabled: Some(&|id| is_agent_gated_enabled(config, id)),
        euid: None,
        identity: None,
        mode: if parsed.subcommand == "status" {
            "status"
        } else {
            "install"
        },
    })
    .await;
    for warning in &result.warnings {
        eprintln!("{warning}");
    }
    if parsed.json {
        println!(
            "{}",
            serde_json::to_string(&to_public_report(&result.report))
                .unwrap_or_else(|_| "{}".into())
        );
    }
    Ok(result.exit_code)
}

fn node_data_dir(data_dir: &str) -> String {
    super::paths::node_resolve(&resolve_home(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_install_homes_and_rejects_unknown_options() {
        let parsed = parse_hook_args(&[
            "install".into(),
            "--agents".into(),
            "codex".into(),
            "--home".into(),
            "grok-build=/work/.grok".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(parsed.subcommand, "install");
        assert_eq!(parsed.agents.as_deref(), Some("codex"));
        assert_eq!(
            parsed.homes.get("grok-build").map(String::as_str),
            Some("/work/.grok")
        );
        assert!(parsed.json);
        assert!(parse_hook_args(&["nope".into()]).is_err());
        assert!(parse_hook_args(&["install".into(), "--home".into(), "missing".into()]).is_err());
        assert!(
            parse_hook_args(&[String::new()])
                .unwrap_or(ParsedHookArgs {
                    subcommand: "x".into(),
                    agents: None,
                    homes: HashMap::new(),
                    config_dir: None,
                    json: false,
                    pilot_dir: None,
                    help: false
                })
                .help
                || parse_hook_args(&[]).unwrap().help
        );
    }
}
