//! CLI dispatch ported from `src/index.ts`.
//!
//! `src/main.rs` is left unchanged. Call `loongsuite_pilot::cli_main::run` once
//! that module is wired, or invoke `run` from a `#[path]` include.
//!
//! Verbs: default collector, `menubar`, `token-usage`/`tokens`, `hook`,
//! `inject`, `deploy`. PI SDK agent and local-worker commands are handled
//! before those verbs. Exit codes match the TypeScript process: `0` when
//! collection is disabled or another collector holds the lock, `1` on fatal
//! startup, and the command's own code otherwise.

use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::Path;
use std::sync::Arc;

use crate::cli::{run_menubar_command, run_token_usage_command, MenubarIo};
use crate::core::{load_config, Orchestrator};
use crate::deployment::{
    deploy_loaded_config, inject_claude_directory, is_agent_gated_enabled,
    parse_inject_command_args, resolve_pilot_dir, run_hook_command_with_config, AgentDefLoader,
    AgentDefLoaderOptions,
};
use crate::local_workers::{handle_worker_cli, WorkerCliIo};
use crate::pi_sdk::{handle_pi_sdk_agent_cli, PiSdkCliIo};
use crate::utils::{
    acquire_single_instance_lock, clear_startup_crash, create_logger, flush_logs_sync,
    init_file_logging, read_installed_version, redirect_root_logger_to_stderr,
    remove_own_pid_file_sync, resolve_breadcrumb_data_dir, resolve_home, write_pid_file_sync,
    write_startup_crash, ReportedError, StartupCrashWrite, COLLECTOR_PROCESS_PATTERNS,
};

pub async fn run() -> anyhow::Result<i32> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    dispatch(&argv).await
}

pub async fn dispatch(argv: &[String]) -> anyhow::Result<i32> {
    // Native extension worker bypasses config, discovery and root logger setup.
    if argv.first().map(String::as_str) == Some("internal-span-enricher") {
        if argv.len() != 3 {
            return Ok(2);
        }
        let Ok(parent_pid) = argv[2].parse::<u32>() else {
            return Ok(2);
        };
        if parent_pid == 0 {
            return Ok(2);
        }
        return Ok(crate::flushers::run_span_enricher_worker(
            Path::new(&argv[1]),
            parent_pid,
        ));
    }
    // The startup path deliberately accepts unknown/older caller flags.
    // Dispatch before strict Clap or config/telemetry initialization.
    if argv.first().map(String::as_str) == Some("inject-hooks") {
        return Ok(crate::deployment::eager_injection::run_cli(&argv[1..]).await);
    }
    let parsed = match crate::cli::args::parse(argv) {
        Ok(parsed) => parsed,
        Err(err) => {
            let code = err.exit_code();
            err.print()?;
            return Ok(code);
        }
    };
    // 命令协议与日志分流必须早于配置读取及部署发现。
    if !matches!(
        parsed.subcommand_name(),
        None | Some("run") | Some("run-updater")
    ) {
        redirect_root_logger_to_stderr();
    }
    if let Some(check) = parsed.subcommand_matches("check") {
        return Ok(run_check(check).await);
    }
    if parsed
        .subcommand_matches("probe")
        .is_some_and(|args| args.get_flag("build-edition"))
    {
        println!("{}", crate::utils::runtime_paths::build_edition());
        return Ok(0);
    }
    if parsed
        .subcommand_name()
        .is_some_and(|name| crate::cli::service::COMMANDS.contains(&name))
    {
        return crate::cli::service::run(argv).await;
    }
    if let Some(helper) = parsed.subcommand_matches("installer-helper") {
        return crate::deployment::installer_helper::run(helper).await;
    }
    if let Some(helper) = parsed.subcommand_matches("service-helper") {
        if let Some(args) = helper.subcommand_matches("process-alive") {
            let alive = crate::utils::installed_process::is_installed_process(
                *args.get_one::<u32>("pid").expect("clap required pid"),
                args.get_one::<String>("role").expect("clap required role"),
                Path::new(
                    args.get_one::<String>("cache-dir")
                        .expect("clap required cache"),
                ),
                Path::new(
                    args.get_one::<String>("data-dir")
                        .expect("clap required data"),
                ),
            );
            return Ok(if alive { 0 } else { 1 });
        }
    }
    if let Some(args) = parsed.subcommand_matches("span-attr") {
        return crate::cli::span_attr::run(args).await;
    }
    if let Some(args) = parsed.subcommand_matches("dashboard") {
        if let Some(shortcut) = args.subcommand_matches("shortcut") {
            return crate::cli::dashboard_shortcut::run(shortcut).await;
        }
        if let Some(probe) = args.subcommand_matches("probe") {
            return crate::cli::dashboard_probe::run(probe).await;
        }
    }
    let mut pi_io = PiSdkCliIo {
        log: Vec::new(),
        err: Vec::new(),
        warn: Vec::new(),
        exit_code: None,
    };
    if handle_pi_sdk_agent_cli(argv, &mut pi_io).await {
        print_lines(&pi_io.log, &pi_io.err, &pi_io.warn);
        return Ok(pi_io.exit_code.unwrap_or(0));
    }
    let mut worker_io = WorkerCliIo {
        log: Vec::new(),
        err: Vec::new(),
        exit_code: None,
    };
    if handle_worker_cli(argv, &mut worker_io).await {
        print_lines(&worker_io.log, &worker_io.err, &[]);
        return Ok(worker_io.exit_code.unwrap_or(0));
    }
    let (command, args) = split_command(argv);
    if command == Some("hook-process") {
        let agent = args.first().map(String::as_str).unwrap_or("");
        return Ok(crate::hook_process::run_hook_process(agent));
    }
    match command {
        Some("menubar") => {
            let mut io = MenubarIo::default();
            let code = run_menubar_command(args, &mut io).await;
            print_lines(&io.log, &io.err, &io.warn);
            Ok(code)
        }
        Some("token-usage") | Some("tokens") => {
            let env = std::env::vars().collect::<HashMap<_, _>>();
            let width = terminal_width();
            let (code, stdout, stderr) =
                run_token_usage_command(args, &env, std::io::stdout().is_terminal(), width).await;
            if !stdout.is_empty() {
                println!("{stdout}");
            }
            if !stderr.is_empty() {
                eprintln!("{stderr}");
            }
            Ok(code)
        }
        Some("probe") => Ok(run_probe(args).await),
        Some("run-updater") => Ok(crate::updater::run_updater_main().await),
        Some("interceptor") => Ok(crate::interceptor::cli::run_cli(args).await),
        Some("hook") => {
            if let Ok(parsed) = crate::deployment::parse_hook_args(args) {
                if parsed.help || parsed.subcommand == "help" {
                    println!("Usage: loongsuite-pilot hook install [--agents <ids>] [--home <id>=<dir>]... [--config-dir PATH] [--json]\n       loongsuite-pilot hook status [--agents <ids>] [--json]");
                    return Ok(0);
                }
            }
            match load_config().await {
                Ok(config) => {
                    let env_agents = std::env::var("LOONGSUITE_PILOT_AGENTS").ok();
                    match run_hook_command_with_config(args, &config, env_agents.as_deref()).await {
                        Ok(code) => {
                            flush_logs_sync();
                            Ok(code)
                        }
                        Err(err) => {
                            eprintln!("loongsuite-pilot hook: {err}");
                            flush_logs_sync();
                            Ok(1)
                        }
                    }
                }
                Err(err) => {
                    eprintln!("loongsuite-pilot hook: {err}");
                    flush_logs_sync();
                    Ok(1)
                }
            }
        }
        Some("inject") => {
            flush_logs_sync();
            Ok(run_inject(args).await)
        }
        Some("deploy") => match load_config().await {
            Ok(config) => match deploy_loaded_config(&config, args, &[]).await {
                Ok((code, _results, _unmet)) => {
                    flush_logs_sync();
                    Ok(code)
                }
                Err(err) => {
                    eprintln!("loongsuite-pilot deploy: {err}");
                    flush_logs_sync();
                    Ok(1)
                }
            },
            Err(err) => {
                eprintln!("loongsuite-pilot deploy: {err}");
                flush_logs_sync();
                Ok(1)
            }
        },
        None | Some("run") => run_collector().await,
        _ => {
            eprintln!("未实现的命令分发");
            Ok(2)
        }
    }
}

async fn run_check(args: &clap::ArgMatches) -> i32 {
    use crate::utils::runtime_paths::{
        build_edition, build_target, is_development_root, resolve_resource_root, validate_runtime,
    };
    redirect_root_logger_to_stderr();
    let result = async {
        let config = crate::core::check_config().await?;
        let root = resolve_resource_root(
            &config.data_dir,
            args.get_one::<String>("resource-root").map(String::as_str),
            &[],
        )?;
        let development = is_development_root(&root);
        let manifest = if development {
            None
        } else {
            Some(validate_runtime(
                &root,
                env!("CARGO_PKG_VERSION"),
                build_target(),
                build_edition(),
            )?)
        };
        if let Some(manifest) = &manifest {
            // 只允许当前二进制检查自己的安装包，不能借另一份有效包掩盖损坏。
            anyhow::ensure!(
                std::fs::canonicalize(std::env::current_exe()?)?
                    == std::fs::canonicalize(root.join(&manifest.binary))?,
                "清单二进制不是当前执行文件"
            );
        }
        let mut agents = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(root.join("agents.d"))? {
            let path = entry?.path();
            if path.extension().is_some_and(|value| value == "json") {
                let definition: crate::types::AgentDefinition =
                    serde_json::from_slice(&std::fs::read(&path)?)
                        .map_err(|_| anyhow::anyhow!("Agent 声明无效：{}", path.display()))?;
                anyhow::ensure!(
                    !definition.id.is_empty() && agents.insert(definition.id),
                    "Agent 声明 ID 为空或重复"
                );
            }
        }
        anyhow::ensure!(!agents.is_empty(), "运行资源不包含 Agent 声明");
        Ok::<_, anyhow::Error>(serde_json::json!({
            "resourceRoot": root,
            "mode": if development { "development" } else { "installed" },
            "gitCommit": manifest.as_ref().map(|item| &item.git_commit),
            "runtimeCapabilities": {
                "containerServiceHelper": if cfg!(target_os = "linux") { 1 } else { 0 },
                "containerHookPin": if cfg!(target_os = "linux") { 1 } else { 0 },
            },
            "agentDefinitions": agents,
            "configValid": true,
        }))
    }
    .await;
    let success = result.is_ok();
    let report = match result {
        Ok(details) => serde_json::json!({"ok":true, "details":details}),
        Err(err) => serde_json::json!({"ok":false, "error":err.to_string()}),
    };
    let report = serde_json::json!({
        "schema":1, "runtime":"rust", "version":env!("CARGO_PKG_VERSION"),
        "target":build_target(), "edition":build_edition(),
        "ok":success, "check":report,
    });
    if args.get_flag("json") {
        println!("{report}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("JSON report")
        );
    }
    i32::from(!success)
}

async fn run_inject(args: &[String]) -> i32 {
    crate::utils::redirect_root_logger_to_stderr();
    let json = args.iter().any(|arg| arg == "--json");
    let failed = |error: String| -> i32 {
        if json {
            println!(
                "{}",
                serde_json::json!({ "status": "failed", "error": error })
            );
        } else {
            eprintln!("loongsuite-pilot inject: {error}");
        }
        1
    };
    let opts = match parse_inject_command_args(args) {
        Ok(opts) => opts,
        Err(err) => return failed(err),
    };
    if opts.help {
        println!(
            "Usage: loongsuite-pilot inject --agents=claude-code [--config-dir PATH] [--json]"
        );
        return 0;
    }
    let config = match load_config().await {
        Ok(config) => config,
        Err(err) => return failed(err.to_string()),
    };
    if !config.enabled
        || !is_agent_gated_enabled(&config, "claude-code")
        || config
            .listeners
            .get("claude-code-log")
            .is_some_and(|listener| !listener.enabled)
    {
        return failed("Claude Code collection is disabled".into());
    }
    let data_dir = resolve_home(if config.data_dir.is_empty() {
        "~/.loongsuite-pilot"
    } else {
        &config.data_dir
    });
    let pilot_dir = match resolve_pilot_dir(&data_dir, &[]) {
        Ok(root) => root,
        Err(err) => return failed(err),
    };
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: Path::new(&pilot_dir)
            .join("agents.d")
            .to_string_lossy()
            .into_owned(),
        local_dir: Path::new(&data_dir)
            .join("agents.d.local")
            .to_string_lossy()
            .into_owned(),
        pilot_dir,
        data_dir: data_dir.clone(),
    });
    let definitions = loader.load().await;
    let Some(hook) = definitions
        .iter()
        .find(|def| def.id == "claude-code")
        .and_then(|def| def.hook.clone())
    else {
        return failed("Claude Code hook definition not found".into());
    };
    let env_config_dir = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "~/.claude".to_string());
    let config_dir = resolve_home(
        opts.config_dir
            .as_deref()
            .unwrap_or(env_config_dir.as_str()),
    );
    match inject_claude_directory(&config_dir, &data_dir, &hook).await {
        Ok(result) => {
            if json {
                println!("{result}");
            } else if let (Some(status), Some(path)) = (
                result.get("status").and_then(|value| value.as_str()),
                result.get("settingsPath").and_then(|value| value.as_str()),
            ) {
                println!("{status}: {path}");
            } else {
                println!("{result}");
            }
            0
        }
        Err(err) => failed(err),
    }
}

async fn run_collector() -> anyhow::Result<i32> {
    let logger = create_logger("Main");
    let config = match load_config().await {
        Ok(config) => config,
        Err(err) => return Ok(fatal_startup(err)),
    };
    let data_dir = resolve_home(&config.data_dir);
    let log_path = Path::new(&data_dir)
        .join("logs")
        .join("loongsuite-pilot-service.log");
    if let Err(err) = init_file_logging(&log_path.to_string_lossy()).await {
        return Ok(fatal_startup(err.into()));
    }
    if !config.enabled {
        clear_startup_crash(&resolve_breadcrumb_data_dir());
        logger.info(
            "analytics disabled via config or LOONGSUITE_PILOT_ENABLED=false",
            None,
        );
        flush_logs_sync();
        return Ok(0);
    }
    let lock_path = Path::new(&data_dir).join("collector.lock");
    let acquired = acquire_single_instance_lock(
        &lock_path.to_string_lossy(),
        Some(COLLECTOR_PROCESS_PATTERNS),
    );
    let Some(lock) = acquired.lock else {
        logger.warn(
            "another collector instance already holds the lock; exiting",
            Some(&meta(serde_json::json!({
                "pid": std::process::id(),
                "holderPid": acquired.holder_pid,
                "lockPath": lock_path,
            }))),
        );
        flush_logs_sync();
        return Ok(0);
    };
    if let Some(recovered) = &acquired.recovered_stale_lock {
        logger.warn(
            "stale single-instance lock recovered",
            Some(&meta(serde_json::json!({
                "pid": std::process::id(),
                "previousHolderPid": recovered.previous_pid,
                "recoveryReason": format!("{:?}", recovered.reason),
                "lockPath": lock_path,
            }))),
        );
    }
    logger.info(
        "single-instance lock acquired",
        Some(&meta(
            serde_json::json!({ "pid": std::process::id(), "lockPath": lock_path }),
        )),
    );
    let spawn_lock = Path::new(&data_dir).join("daemon.spawn.lock");
    if std::env::var_os("KUBERNETES_SERVICE_HOST").is_some() || spawn_lock.exists() {
        if let Err(err) = std::fs::write(&spawn_lock, std::process::id().to_string()) {
            logger.warn(
                "cannot record daemon pid in spawn lock",
                Some(&meta(
                    serde_json::json!({ "spawnLockPath": spawn_lock, "error": err.to_string() }),
                )),
            );
        }
    }
    let pid_file = if cfg!(windows) {
        Some(
            Path::new(&data_dir)
                .join("loongsuite-pilot.pid")
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    if let Some(pid_file) = &pid_file {
        write_pid_file_sync(pid_file);
    }
    let outcome = async {
        let orchestrator = Arc::new(Orchestrator::new(config.clone()));
        orchestrator.start().await?;
        clear_startup_crash(&resolve_breadcrumb_data_dir());
        let enabled: Vec<&str> = ["sls", "jsonl", "http"].into_iter().filter(|name| flusher_enabled(&config, name)).collect();
        if !enabled.contains(&"sls") && std::env::var_os("LOONGSUITE_SLS_PROJECT").is_some() && std::env::var_os("LOONGSUITE_SLS_LOGSTORE").is_some() {
            logger.warn(
                "an SLS destination is set in the environment but the SLS flusher is NOT enabled — events will be collected locally and never uploaded. Those env vars are only read when the config file carries an \"sls\" section; check that the file exists and is readable.",
                Some(&meta(serde_json::json!({
                    "project": std::env::var("LOONGSUITE_SLS_PROJECT").unwrap_or_default(),
                    "logstore": std::env::var("LOONGSUITE_SLS_LOGSTORE").unwrap_or_default(),
                    "expectedConfigPath": std::env::var("AGENT_DATA_COLLECTION_CONFIG").unwrap_or_else(|_| "~/.loongsuite-pilot/config.json".into()),
                    "enabledFlushers": enabled,
                }))),
            );
        }
        logger.info("AI Agent Input is running", Some(&meta(serde_json::json!({ "dataDir": config.data_dir, "flushers": enabled }))));
        wait_for_shutdown().await;
        orchestrator.stop().await;
        Ok::<(), anyhow::Error>(())
    }.await;
    lock.release();
    if let Some(pid_file) = &pid_file {
        remove_own_pid_file_sync(pid_file);
    }
    release_spawn_lock(&spawn_lock);
    flush_logs_sync();
    match outcome {
        Ok(()) => Ok(0),
        Err(err) => Ok(fatal_startup(err)),
    }
}

fn fatal_startup(err: anyhow::Error) -> i32 {
    let logger = create_logger("Main");
    logger.error(
        "fatal startup error",
        Some(&meta(serde_json::json!({ "error": err.to_string() }))),
    );
    let breadcrumb = resolve_breadcrumb_data_dir();
    write_startup_crash(&StartupCrashWrite {
        data_dir: breadcrumb.clone(),
        phase: "startup".into(),
        version: read_installed_version(&breadcrumb),
        error: ReportedError::message(err.to_string()),
    });
    flush_logs_sync();
    1
}

fn flusher_enabled(config: &crate::types::AnalyticsConfig, name: &str) -> bool {
    match name {
        "sls" => config
            .flushers
            .sls
            .as_ref()
            .is_some_and(|item| item.enabled),
        "jsonl" => config
            .flushers
            .jsonl
            .as_ref()
            .is_some_and(|item| item.enabled),
        "http" => config
            .flushers
            .http
            .as_ref()
            .is_some_and(|item| item.enabled),
        _ => false,
    }
}

fn split_command(argv: &[String]) -> (Option<&str>, &[String]) {
    match argv.split_first() {
        Some((command, rest)) => (Some(command.as_str()), rest),
        None => (None, &[]),
    }
}

fn print_lines(log: &[String], err: &[String], warn: &[String]) {
    for line in log {
        println!("{line}");
    }
    for line in warn {
        eprintln!("{line}");
    }
    for line in err {
        eprintln!("{line}");
    }
    let _ = std::io::stdout().flush();
}

async fn run_probe(args: &[String]) -> i32 {
    redirect_root_logger_to_stderr();
    let installer = args.iter().any(|arg| arg == "--installer");
    let data_dir = std::env::var("LOONGSUITE_PILOT_DATA_DIR")
        .map(|value| resolve_home(&value))
        .unwrap_or_else(|_| resolve_home("~/.loongsuite-pilot"));
    let pilot_dir = match resolve_pilot_dir(&data_dir, &[]) {
        Ok(root) => root,
        Err(err) => {
            eprintln!("loongsuite-pilot probe: {err}");
            return 1;
        }
    };
    let builtin_dir = Path::new(&pilot_dir).join("agents.d");
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: builtin_dir.to_string_lossy().into_owned(),
        local_dir: Path::new(&data_dir)
            .join("agents.d.local")
            .to_string_lossy()
            .into_owned(),
        pilot_dir,
        data_dir,
    });
    let definitions = loader.load().await;
    if definitions.is_empty() {
        eprintln!("loongsuite-pilot probe: 没有有效的 Agent 声明");
        return 1;
    }
    let options = crate::deployment::CliProbeOptions {
        list_only: args.iter().any(|arg| arg == "--list"),
        installer,
        dsh_runtime_locator: None,
    };
    let results = match crate::deployment::try_probe_agent_definitions(&definitions, &options).await
    {
        Ok(results) => results,
        Err(error) => {
            eprintln!("loongsuite-pilot probe: {error}");
            return 1;
        }
    };
    let body = match serde_json::to_string(&results) {
        Ok(body) => body,
        Err(_) => {
            eprintln!("loongsuite-pilot probe: 无法编码探测结果");
            return 1;
        }
    };
    println!("{body}");
    0
}

fn terminal_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(80)
}

fn meta(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

fn release_spawn_lock(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if text.trim() == std::process::id().to_string() {
        let _ = std::fs::remove_file(path);
    }
}

pub(crate) async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(terminate) = terminate.as_mut() { terminate.recv().await; }
                else { std::future::pending::<()>().await; }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn menubar_without_arguments_exits_zero() {
        let code = dispatch(&["menubar".into()]).await.unwrap();
        assert_eq!(code, 0);
    }

    #[tokio::test]
    async fn hook_help_exits_zero() {
        let code = dispatch(&["hook".into(), "--help".into()]).await.unwrap();
        assert_eq!(code, 0);
    }
}
