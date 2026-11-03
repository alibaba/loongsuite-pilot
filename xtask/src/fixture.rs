//! 注入/服务测试专用的独立原生假 CLI；绝不随 Pilot 运行包发布。

use anyhow::{bail, Context, Result};
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::Duration;

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let Some(path) = std::env::var_os("PILOT_FIXTURE_LOG") {
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(
            file,
            "{}",
            json!({"pid":std::process::id(), "args":args,
            "data":std::env::var("LOONGSUITE_PILOT_DATA_DIR").ok(),
            "cache":std::env::var("LOONGSUITE_PILOT_CACHE_DIR").ok(),
            "config":std::env::var("AGENT_DATA_COLLECTION_CONFIG").ok(),
            "install": {
                "sourceDir":std::env::var("LP_SOURCE_DIR").ok(),
                "cacheDir":std::env::var("LP_CACHE_DIR").ok(),
                "dataDir":std::env::var("LP_DATA_DIR").ok(),
                "configPath":std::env::var("LP_CONFIG_PATH").ok(),
                "binDir":std::env::var("LP_BIN_DIR").ok()
            }})
        )?;
        file.sync_all()?;
    }
    match std::env::var("PILOT_FIXTURE_MODE").as_deref() {
        Ok("wait") => {
            std::thread::sleep(Duration::from_secs(60));
            return Ok(());
        }
        Ok("hermes-rollback-delegate") => {
            // Test-only transport: execute the actual built production CLI, never
            // PATH, the installed user binary, or this fixture recursively.
            if args != ["installer-helper", "cleanup-rollback-hermes", "--input-env"] {
                bail!("unexpected native Hermes delegation arguments");
            }
            if std::env::var_os("PILOT_FIXTURE_DELEGATED").is_some() {
                bail!("recursive native fixture delegation");
            }
            let helper = std::path::PathBuf::from(
                std::env::var_os("PILOT_FIXTURE_NATIVE_HELPER")
                    .context("missing explicit native Hermes helper")?,
            );
            if !helper.is_absolute()
                || helper.canonicalize()? == std::env::current_exe()?.canonicalize()?
            {
                bail!("invalid native Hermes delegation executable");
            }
            let status = std::process::Command::new(helper)
                .args(&args)
                .env("PILOT_FIXTURE_DELEGATED", "1")
                .status()?;
            std::process::exit(status.code().unwrap_or(1));
        }
        Ok("restart-stderr") => {
            eprintln!("synthetic schtasks refusal");
            eprintln!();
            std::process::exit(7);
        }
        Ok("exit") => return Ok(()),
        Ok("fail") => bail!("测试请求的激活失败"),
        Ok(other) => bail!("未知 fixture 模式：{other}"),
        Err(_) => {}
    }
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--version"] | ["version"] => println!("pilot-fixture 1.0.0"),
        ["plugins", action, "loongsuite-pilot"] if matches!(*action, "enable" | "disable") => {
            let state =
                std::env::var_os("PILOT_FIXTURE_PLUGIN_STATE").context("未指定隔离插件状态")?;
            fs::write(state, action.as_bytes())?;
        }
        _ => bail!("fixture 不支持这些参数：{args:?}"),
    }
    Ok(())
}
