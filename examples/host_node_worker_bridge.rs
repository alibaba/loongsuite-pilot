//! Optional host acceptance bridge; default Cargo tests do not require Node.
//! Build this example, then set PILOT_NATIVE_NODE_WORKER_BRIDGE for
//! npm run test:host:node-worker. Only synthetic private worker bundles are used.
use loongsuite_pilot::deployment::{WorkerManifestOptions, WorkerManifestSupervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    install_dir: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    worker_env: Option<HashMap<String, String>>,
    #[serde(default)]
    managed: bool,
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(64 * 1024 + 1)
        .read_to_end(&mut payload)?;
    if payload.len() > 64 * 1024 {
        return Err("host worker request exceeds 64 KiB".into());
    }
    let request: Request = serde_json::from_slice(&payload)?;
    if !Path::new(&request.install_dir).is_absolute() {
        return Err("host worker fixture must be absolute".into());
    }
    let env = request
        .worker_env
        .unwrap_or_else(|| std::env::vars().collect());
    let before = env.clone();
    let supervisor = match request.platform.as_deref() {
        Some(platform) => WorkerManifestSupervisor::with_platform(
            platform,
            &std::env::var("PILOT_NODE_BIN").unwrap_or_default(),
        ),
        None => WorkerManifestSupervisor::new(),
    };
    let options = WorkerManifestOptions {
        instance: request.managed.then(HashMap::new),
        ..Default::default()
    };
    let started = supervisor
        .start_if_present("host-node-worker", &request.install_dir, &env, &options)
        .await;
    let status_path = Path::new(&request.install_dir).join("worker-status.json");
    let status = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(bytes) = tokio::fs::read(&status_path).await {
                if let Ok(status) = serde_json::from_slice::<Value>(&bytes) {
                    if !started || status["state"] == "exited" || status["state"] == "failed" {
                        return status;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    serde_json::to_writer(
        std::io::stdout().lock(),
        &json!({"started": started, "status": status, "parentEnvironmentUnchanged": env == before}),
    )?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
