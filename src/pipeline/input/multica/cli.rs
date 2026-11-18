use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;

use super::{config, MulticaPipeline, Options};
use serde_json::{json, Value};

const MAX_CONFIG: u64 = 1024 * 1024;

pub(crate) async fn run(args: &clap::ArgMatches) -> anyhow::Result<i32> {
    let config_path = args
        .get_one::<String>("config")
        .expect("validated --config");
    let document = read_config(config_path).await?;
    let pilot = if let Some(path) = args.get_one::<String>("pilot-config") {
        read_config(path).await?;
        crate::core::check_config_at(path).await
    } else {
        crate::core::load_config().await
    }
    .map_err(|_| anyhow::anyhow!("could not resolve Pilot reporting configuration"))?;
    let state_dir = args
        .get_one::<String>("state-dir")
        .map(String::as_str)
        .unwrap_or("./multica-state");
    let activation_path = args
        .get_one::<String>("activation-state-file")
        .map(PathBuf::from);
    if let Some(path) = activation_path.as_deref() {
        crate::utils::write_json_file(
            &path.to_string_lossy(),
            &json!({
                "enabled": false, "mode": "off", "stopped": false, "expiresAt": 0,
            }),
        )
        .await
        .map_err(|_| anyhow::anyhow!("could not initialize Multica activation state"))?;
    }
    let name = document["configName"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Multica configName is required"))?;
    let raw = document["inputs"]
        .as_array()
        .and_then(|values| values.first())
        .filter(|input| input["Type"] == "input_multica")
        .ok_or_else(|| anyhow::anyhow!("expected input_multica"))?;
    let input = serde_json::from_value::<config::Input>(raw.clone())
        .map_err(|_| anyhow::anyhow!("invalid Multica source configuration"))?;
    let flusher = match document.get("flushers") {
        Some(Value::Array(values)) => values.first(),
        None => None,
        _ => anyhow::bail!("invalid Multica flushers"),
    };
    let pipeline = std::sync::Arc::new(MulticaPipeline::new(Options {
        name,
        input,
        destination: config::resolve_destination(flusher, pilot.flushers.sls.as_ref())?,
        state_dir: Path::new(state_dir),
        mode: pilot
            .pipeline
            .multica
            .mode
            .as_deref()
            .and_then(config::CollectionMode::parse)
            .unwrap_or_default(),
        enabled: pilot.pipeline.multica.enabled,
        prefix: &pilot.service_name_prefix,
        activation_path,
    })?);
    if args.get_flag("once") {
        let result = pipeline.collect_once().await;
        pipeline.stop().await;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(i32::from(result.failed_sources > 0));
    }
    pipeline.start().await;
    // A locked detector stays stopped until the process is explicitly restarted.
    crate::cli_main::wait_for_shutdown().await;
    pipeline.stop().await;
    Ok(0)
}

async fn read_config(path: &str) -> anyhow::Result<Value> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| anyhow::anyhow!("could not read Multica configuration"))?;
    anyhow::ensure!(
        file.metadata().await?.is_file(),
        "configuration must be a regular file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1).read_to_end(&mut bytes).await?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_CONFIG,
        "configuration exceeds 1 MiB"
    );
    let text =
        std::str::from_utf8(&bytes).map_err(|_| anyhow::anyhow!("configuration requires UTF-8"))?;
    let value = serde_json::from_str::<Value>(crate::utils::fs_utils::strip_bom(text))
        .map_err(|_| anyhow::anyhow!("invalid Multica JSON configuration"))?;
    anyhow::ensure!(value.is_object(), "configuration must be a JSON object");
    Ok(value)
}
