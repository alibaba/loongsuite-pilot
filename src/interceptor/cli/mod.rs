//! `interceptor-cli` commands: hook, status, version.

mod daemon_client;
mod hook;
mod qoder_surface;

use crate::interceptor::access_log::{write_interceptor_access_log, AccessLogLimits};
use crate::interceptor::paths::{default_pilot_data_dir, interceptor_runtime_path};
use crate::utils::{create_logger, read_installed_version};
use daemon_client::DaemonClient;
use hook::run_hook;
use serde_json::Value;
use std::io::{self, Read, Write};

pub use daemon_client::{parse_single_json, DaemonClientError, HookClient};
pub use hook::{emit_verdict, HookCliDeps};
pub use qoder_surface::{classify_executable, resolve_qoder_surface, resolve_qoder_surface_with};

pub async fn run_cli(args: &[String]) -> i32 {
    let logger = create_logger("InterceptorCli");
    let command = args.first().map(String::as_str);
    match command {
        Some("--version" | "version") => {
            let _ = writeln!(
                io::stdout(),
                "{}",
                read_installed_version(&default_pilot_data_dir())
            );
            0
        }
        Some("status") => run_status().await,
        Some("hook") => {
            let mut deps = HookCliDeps {
                read_stdin: Box::new(read_stdin_sync),
                write_stdout: Box::new(|text| {
                    let _ = io::stdout().write_all(text.as_bytes());
                }),
                log: Box::new(move |message, extra| logger.warn(message, extra)),
                runtime_path: None,
                resolve_surface: None,
                create_client: None,
                write_access_log: Some(Box::new(|entry| {
                    write_interceptor_access_log(entry, None, AccessLogLimits::default());
                })),
            };
            run_hook(&args[1..], &mut deps).await
        }
        _ => {
            let _ = writeln!(
                io::stderr(),
                "usage: interceptor-cli hook [--event <name>] --agent <name>\n       interceptor-cli status\n       interceptor-cli version"
            );
            0
        }
    }
}

async fn run_status() -> i32 {
    let runtime_path = interceptor_runtime_path(None);
    let raw = match std::fs::read_to_string(&runtime_path) {
        Ok(raw) => raw,
        Err(err) => {
            let _ = writeln!(io::stdout(), "interceptor: not running ({err})");
            return 0;
        }
    };
    let raw = raw.trim_start_matches('\u{feff}');
    let runtime: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(err) => {
            let _ = writeln!(io::stdout(), "interceptor: not running ({err})");
            return 0;
        }
    };
    let port = runtime
        .get("daemon_port")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if port == 0 || port > 65535 {
        let _ = writeln!(
            io::stdout(),
            "interceptor: runtime present but port missing"
        );
        return 0;
    }
    match DaemonClient::new(port as u16).health_timeout(200).await {
        Ok(health) => {
            let _ = writeln!(
                io::stdout(),
                "interceptor: ok pid={} port={} version={}",
                health.pid,
                health.daemon_port,
                health.version
            );
        }
        Err(err) => {
            let _ = writeln!(io::stdout(), "interceptor: not running ({err})");
        }
    }
    0
}

fn read_stdin_sync() -> Result<String, ()> {
    let mut buf = String::new();
    io::stdin().read_to_string(&mut buf).map_err(|_| ())?;
    Ok(buf)
}
