//! 供两端服务入口使用的只读 Dashboard 探测，不启动 collector。

use anyhow::{ensure, Result};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use crate::dashboard::{
    dashboard_instance_id, DASHBOARD_ID_HEADER, DASHBOARD_ID_VALUE, DASHBOARD_INSTANCE_HEADER,
};

fn configured_port(path: &Path) -> Result<u16> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(crate::dashboard::DEFAULT_DASHBOARD_PORT)
        }
        Err(err) => return Err(err.into()),
    };
    let mut text = String::new();
    file.take(4 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    ensure!(text.len() <= 4 * 1024 * 1024, "配置文件过大");
    let config: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| anyhow::anyhow!("配置 JSON 无效"))?;
    ensure!(config.is_object(), "配置必须为 JSON 对象");
    Ok(crate::dashboard::configured_port(
        config.pointer("/dashboard/port"),
    ))
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
    let port = configured_port(Path::new(&crate::utils::config_json_path()))?;
    let data_dir = crate::utils::resolve_data_dir(None);
    if args.get_flag("port") {
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

    #[test]
    fn port_validation_and_unicode_bom_config_are_read_only() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("配置 🚀.json");
        assert_eq!(configured_port(&path).unwrap(), 8765);
        assert!(!path.exists());
        for (raw, expected) in [
            ("\u{feff}{\"dashboard\":{\"port\":9876}}", 9876),
            ("{\"dashboard\":{\"port\":0}}", 8765),
            ("{\"dashboard\":{\"port\":65536}}", 8765),
            ("{\"dashboard\":{\"port\":1.5}}", 8765),
        ] {
            std::fs::write(&path, raw).unwrap();
            assert_eq!(configured_port(&path).unwrap(), expected);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        }
        std::fs::write(&path, "{broken").unwrap();
        assert!(configured_port(&path).is_err());
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
