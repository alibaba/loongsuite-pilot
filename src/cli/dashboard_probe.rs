//! Dashboard config and loopback probe for the service launchers.

use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use crate::dashboard::{
    dashboard_instance_id, DASHBOARD_ID_HEADER, DASHBOARD_ID_VALUE, DASHBOARD_INSTANCE_HEADER,
};

fn dashboard_config(path: &Path) -> Result<(Value, crate::utils::fs_utils::ExpectedFileState)> {
    use crate::utils::fs_utils::ExpectedFileState;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok((serde_json::json!({}), ExpectedFileState::Missing))
        }
        Err(err) => return Err(err.into()),
    };
    let mut text = String::new();
    file.take(4 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    ensure!(text.len() <= 4 * 1024 * 1024, "配置文件过大");
    let config: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| anyhow::anyhow!("配置 JSON 无效"))?;
    ensure!(config.is_object(), "配置必须为 JSON 对象");
    Ok((config, ExpectedFileState::Present(text)))
}

fn configured_port(config: &Value) -> u16 {
    crate::dashboard::configured_port(config.pointer("/dashboard/port"))
}

async fn set_enabled(path: &Path, enabled: bool, port: Option<u16>) -> Result<()> {
    use crate::utils::fs_utils::{write_text_file_atomic, AtomicTextWriteOptions};
    let (mut config, expected) = dashboard_config(path)?;
    let dashboard = config
        .as_object_mut()
        .context("配置必须为 JSON 对象")?
        .entry("dashboard")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("dashboard 配置必须为 JSON 对象")?;
    dashboard.insert("enabled".into(), Value::Bool(enabled));
    if let Some(port) = port {
        dashboard.insert("port".into(), Value::from(port));
    }
    let text = format!("{}\n", serde_json::to_string_pretty(&config)?);
    ensure!(text.len() <= 4 * 1024 * 1024, "配置文件过大");
    write_text_file_atomic(
        path.to_str().context("配置路径不是有效 UTF-8")?,
        &text,
        &AtomicTextWriteOptions {
            expected: Some(expected),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

pub(crate) async fn configure(action: &str, args: &clap::ArgMatches) -> Result<i32> {
    let enable = action == "start";
    let port = if enable {
        args.get_one::<u16>("port").copied()
    } else {
        None
    };
    set_enabled(Path::new(&crate::utils::config_json_path()), enable, port).await?;
    Ok(0)
}

async fn available(port: u16, data_dir: &str) -> Result<bool> {
    // 不读代理环境，也不跟随重定向到其他端口或外部地址。
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(300))
        .build()?;
    let response = match client
        .head(format!("http://127.0.0.1:{port}/metrics-summary.json"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(false),
    };
    let headers = response.headers();
    let unique_header = |name| {
        let mut values = headers.get_all(name).iter();
        let first = values.next().and_then(|value| value.to_str().ok());
        if values.next().is_some() {
            None
        } else {
            first
        }
    };
    Ok(matches!(response.status().as_u16(), 200 | 503)
        && unique_header(DASHBOARD_ID_HEADER) == Some(DASHBOARD_ID_VALUE)
        && unique_header(DASHBOARD_INSTANCE_HEADER)
            == Some(dashboard_instance_id(data_dir).as_str()))
}

pub(crate) async fn run(args: &clap::ArgMatches) -> Result<i32> {
    let (config, _) = dashboard_config(Path::new(&crate::utils::config_json_path()))?;
    let port = configured_port(&config);
    let data_dir = crate::utils::resolve_data_dir(None);
    if args.get_flag("enabled") {
        return Ok(
            if config
                .pointer("/dashboard/enabled")
                .and_then(Value::as_bool)
                == Some(true)
            {
                0
            } else {
                1
            },
        );
    } else if args.get_flag("port") {
        println!("{port}");
    } else if args.get_flag("data-dir") {
        println!("{data_dir}");
    } else {
        return Ok(if available(port, &data_dir).await? {
            0
        } else {
            1
        });
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::{DashboardServer, DashboardServerOptions};

    #[tokio::test]
    async fn dashboard_config_updates_only_its_settings_and_preserves_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            "\u{feff}{\"dashboard\":{\"port\":9999},\"other\":true}",
        )
        .unwrap();
        set_enabled(&path, true, None).await.unwrap();
        let (config, _) = dashboard_config(&path).unwrap();
        assert_eq!(
            config["dashboard"],
            serde_json::json!({"enabled": true, "port": 9999})
        );
        assert_eq!(config["other"], true);
        set_enabled(&path, true, Some(9000)).await.unwrap();
        set_enabled(&path, false, None).await.unwrap();
        let (config, _) = dashboard_config(&path).unwrap();
        assert_eq!(
            config["dashboard"],
            serde_json::json!({"enabled": false, "port": 9000})
        );

        for invalid in ["broken", "{\"dashboard\":[]}"] {
            std::fs::write(&path, invalid).unwrap();
            assert!(set_enabled(&path, true, None).await.is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        }
    }

    #[test]
    fn port_validation_and_unicode_bom_config_are_read_only() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("配置 🚀.json");
        assert_eq!(configured_port(&dashboard_config(&path).unwrap().0), 8765);
        assert!(!path.exists());
        for (raw, expected) in [
            ("\u{feff}{\"dashboard\":{\"port\":9876}}", 9876),
            ("{\"dashboard\":{\"port\":0}}", 8765),
            ("{\"dashboard\":{\"port\":65536}}", 8765),
            ("{\"dashboard\":{\"port\":1.5}}", 8765),
        ] {
            std::fs::write(&path, raw).unwrap();
            assert_eq!(
                configured_port(&dashboard_config(&path).unwrap().0),
                expected
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        }
        std::fs::write(&path, "{broken").unwrap();
        assert!(dashboard_config(&path).is_err());
    }

    #[tokio::test]
    async fn real_head_probe_accepts_ready_and_pending_but_rejects_other_instances() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("数据 🚀");
        std::fs::create_dir_all(data.join("logs")).unwrap();
        let data = data.to_str().unwrap();
        let server = DashboardServer::new(DashboardServerOptions {
            data_dir: data.into(),
            asset_path: String::new(),
            host: None,
            port: Some(0),
        });
        server.start().unwrap();
        let port = reqwest::Url::parse(&server.address().unwrap())
            .unwrap()
            .port()
            .unwrap();
        assert!(available(port, data).await.unwrap());
        assert!(!available(port, root.path().to_str().unwrap())
            .await
            .unwrap());
        std::fs::write(Path::new(data).join("logs/metrics-summary.json"), "{}").unwrap();
        assert!(available(port, &format!("{data}/../数据 🚀"))
            .await
            .unwrap());
        server.stop();
        assert!(!available(port, data).await.unwrap());
    }
}
