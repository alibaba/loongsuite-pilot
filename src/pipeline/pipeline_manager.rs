//! Loads pipeline JSON configs and owns their lifecycles.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::utils::{create_logger, ensure_dir};
use serde_json::{Map, Value};

use super::input::file::file_pipeline::FilePipelineHandle;
use super::input::qoder_api::qoder_api_pipeline::QoderApiPipeline;
use super::sleep_detector::{SleepDetector, WakeEvent};
use super::types::{
    FileInputConfig, FilePipelineOptions, PipelineConfig, PipelineInputConfig,
    PipelineManagerOptions, PipelineSlsFlusherConfig, QoderApiInputConfig, QoderApiPipelineOptions,
};

const RESCAN_INTERVAL_MS: u64 = 60_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("PipelineManager")
}

#[derive(Clone)]
enum Running {
    File(Arc<FilePipelineHandle>),
    Qoder(Arc<QoderApiPipeline>),
}

pub struct PipelineManager {
    opts: PipelineManagerOptions,
    pipelines: std::sync::Mutex<HashMap<String, Running>>,
    hashes: std::sync::Mutex<HashMap<String, String>>,
    lifecycle: tokio::sync::Mutex<()>,
    running: std::sync::atomic::AtomicBool,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    sleep: SleepDetector,
}

impl PipelineManager {
    pub fn new(opts: PipelineManagerOptions) -> Self {
        Self {
            opts,
            pipelines: std::sync::Mutex::new(HashMap::new()),
            hashes: std::sync::Mutex::new(HashMap::new()),
            lifecycle: tokio::sync::Mutex::new(()),
            running: std::sync::atomic::AtomicBool::new(false),
            task: std::sync::Mutex::new(None),
            sleep: SleepDetector::new(),
        }
    }

    pub async fn start(self: &Arc<Self>) {
        let _lifecycle = self.lifecycle.lock().await;
        if self.running.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        ensure_dir(&self.opts.config_dir).await;
        self.migrate_dir(&self.opts.state_dir, "pipeline", "file-collection")
            .await;
        self.migrate_dir(
            &self.opts.failed_log_dir,
            "pipeline-failed",
            "file-collection-failed",
        )
        .await;
        ensure_dir(&self.opts.state_dir).await;
        ensure_dir(&self.opts.failed_log_dir).await;
        self.rescan_locked().await;
        let this = Arc::clone(self);
        *self.task.lock().unwrap() = Some(tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(RESCAN_INTERVAL_MS));
            interval.tick().await;
            loop {
                interval.tick().await;
                this.rescan().await;
            }
        }));
        if cfg!(target_os = "macos") {
            self.sleep.start_manual(now_ms());
        }
        logger().info(
            "started",
            Some(&map(&[
                ("configDir", serde_json::json!(self.opts.config_dir.clone())),
                (
                    "pipelines",
                    serde_json::json!(self.pipelines.lock().unwrap().len()),
                ),
            ])),
        );
    }

    pub async fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        if !self
            .running
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        self.sleep.stop();
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        let running: Vec<(String, Running)> = self.pipelines.lock().unwrap().drain().collect();
        for (name, pipeline) in running {
            match pipeline {
                Running::File(pipeline) => pipeline.stop().await,
                Running::Qoder(pipeline) => pipeline.stop_handle().await,
            }
            let _ = name;
        }
        self.hashes.lock().unwrap().clear();
        logger().info("stopped", None);
    }

    pub async fn handle_wake(self: &Arc<Self>, event: WakeEvent) {
        // 与停止和重扫描串行；等待期间只持异步生命周期锁，不持组件表的同步锁。
        let _lifecycle = self.lifecycle.lock().await;
        if !self.running.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let snapshot: Vec<Running> = self.pipelines.lock().unwrap().values().cloned().collect();
        for pipeline in snapshot {
            match pipeline {
                Running::File(pipeline) => pipeline.handle_wake(event).await,
                Running::Qoder(pipeline) => pipeline.handle_wake_handle(event).await,
            }
        }
        self.rescan_locked().await;
    }

    async fn rescan(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        self.rescan_locked().await;
    }

    async fn rescan_locked(&self) {
        if !self.running.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let configs = self.scan().await;
        let names: std::collections::HashSet<String> = configs
            .iter()
            .map(|config| config.config_name.clone())
            .collect();
        let existing: Vec<String> = self.pipelines.lock().unwrap().keys().cloned().collect();
        for name in existing {
            if !names.contains(&name) {
                self.destroy(&name).await;
            }
        }
        for config in configs {
            let hash = stable_stringify(&config.raw);
            let known = self
                .hashes
                .lock()
                .unwrap()
                .get(&config.config_name)
                .cloned();
            if !self
                .pipelines
                .lock()
                .unwrap()
                .contains_key(&config.config_name)
            {
                self.create(config).await;
                self.hashes.lock().unwrap().insert(hash.0, hash.1);
            } else if known.as_deref() != Some(hash.1.as_str()) {
                let name = hash.0.clone();
                self.destroy(&name).await;
                self.create(config).await;
                self.hashes.lock().unwrap().insert(hash.0, hash.1);
            }
        }
    }

    async fn scan(&self) -> Vec<PipelineConfig> {
        let mut configs = Vec::new();
        let entries = match tokio::fs::read_dir(&self.opts.config_dir).await {
            Ok(entries) => entries,
            Err(_) => return configs,
        };
        let mut entries = entries;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let Ok(text) = tokio::fs::read_to_string(entry.path()).await else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                logger().warn(
                    "failed to parse config file",
                    Some(&map(&[("file", serde_json::json!(name))])),
                );
                continue;
            };
            if let Some(config) = validate_config(&parsed, &name) {
                configs.push(config);
            }
        }
        configs
    }

    async fn create(&self, config: PipelineConfig) {
        let Some(input) = config.inputs.first() else {
            return;
        };
        match input {
            PipelineInputConfig::File(_) if !self.opts.pipeline_config.file_enabled => {
                logger().info(
                    "file pipeline disabled, skipping",
                    Some(&map(&[(
                        "configName",
                        serde_json::json!(config.config_name.clone()),
                    )])),
                );
                return;
            }
            PipelineInputConfig::QoderApi(_) if !self.opts.pipeline_config.qoder_api_enabled => {
                logger().info(
                    "qoder-api pipeline disabled, skipping",
                    Some(&map(&[(
                        "configName",
                        serde_json::json!(config.config_name.clone()),
                    )])),
                );
                return;
            }
            _ => {}
        }
        let name = config.config_name.clone();
        let input_type = input.type_name().to_string();
        match input_type.as_str() {
            "input_file" => {
                let handle = FilePipelineHandle::new(FilePipelineOptions {
                    workspace_policy: self.opts.workspace_policy.clone(),
                    config,
                    state_dir: self.opts.state_dir.clone(),
                    failed_log_dir: self.opts.failed_log_dir.clone(),
                    data_dir: self.opts.data_dir.clone(),
                    sink: None,
                });
                if let Ok(handle) = handle {
                    handle.start().await;
                    self.pipelines
                        .lock()
                        .unwrap()
                        .insert(name, Running::File(Arc::new(handle)));
                    logger().info(
                        "pipeline created",
                        Some(&map(&[("configName", serde_json::json!(input_type))])),
                    );
                }
            }
            "input_qoder_api" => {
                let pipeline = Arc::new(QoderApiPipeline::new(QoderApiPipelineOptions {
                    workspace_policy: self.opts.workspace_policy.clone(),
                    config,
                    state_dir: self.opts.state_dir.clone(),
                    failed_log_dir: self.opts.failed_log_dir.clone(),
                    data_dir: self.opts.data_dir.clone(),
                    sink: None,
                }));
                if pipeline.start_handle().await.is_ok() {
                    self.pipelines
                        .lock()
                        .unwrap()
                        .insert(name, Running::Qoder(pipeline));
                }
            }
            _ => {}
        }
    }

    async fn destroy(&self, name: &str) {
        let pipeline = self.pipelines.lock().unwrap().remove(name);
        if let Some(pipeline) = pipeline {
            match pipeline {
                Running::File(pipeline) => pipeline.stop().await,
                Running::Qoder(pipeline) => pipeline.stop_handle().await,
            }
        }
        self.hashes.lock().unwrap().remove(name);
    }

    async fn migrate_dir(&self, new_dir: &str, new_suffix: &str, old_suffix: &str) {
        let path = Path::new(new_dir);
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return;
        };
        if name != new_suffix {
            return;
        }
        let Some(parent) = path.parent() else { return };
        let old = parent.join(old_suffix);
        if tokio::fs::metadata(&old).await.is_ok() && tokio::fs::metadata(new_dir).await.is_err() {
            let _ = tokio::fs::rename(&old, new_dir).await;
            logger().info(
                "migrated state directory",
                Some(&map(&[
                    ("from", serde_json::json!(old.display().to_string())),
                    ("to", serde_json::json!(new_dir)),
                ])),
            );
        }
    }
}

fn validate_config(value: &Value, file_name: &str) -> Option<PipelineConfig> {
    let object = value.as_object()?;
    let config_name = object
        .get("configName")
        .and_then(Value::as_str)
        .unwrap_or("");
    if config_name.is_empty() {
        logger().warn(
            "config missing configName",
            Some(&map(&[("file", serde_json::json!(file_name))])),
        );
        return None;
    }
    if !valid_name(config_name) {
        logger().warn(
            "config has invalid configName (must match [a-zA-Z0-9._-])",
            Some(&map(&[
                ("file", serde_json::json!(file_name)),
                ("configName", serde_json::json!(config_name)),
            ])),
        );
        return None;
    }
    let inputs = object.get("inputs").and_then(Value::as_array)?;
    let flushers = object.get("flushers").and_then(Value::as_array)?;
    if inputs.is_empty() || flushers.is_empty() {
        logger().warn(
            "config missing inputs",
            Some(&map(&[("file", serde_json::json!(file_name))])),
        );
        return None;
    }
    let flusher = flushers[0].as_object()?;
    let endpoint = flusher
        .get("Endpoint")
        .and_then(Value::as_str)
        .unwrap_or("");
    let project = flusher.get("Project").and_then(Value::as_str).unwrap_or("");
    let logstore = flusher
        .get("Logstore")
        .and_then(Value::as_str)
        .unwrap_or("");
    if endpoint.is_empty() || project.is_empty() || logstore.is_empty() {
        logger().warn(
            "config flusher missing required fields",
            Some(&map(&[("file", serde_json::json!(file_name))])),
        );
        return None;
    }
    let input_value = inputs[0].as_object()?;
    let input = match input_value.get("Type").and_then(Value::as_str) {
        Some("input_file") => {
            let paths = input_value
                .get("FilePaths")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if paths.is_empty() {
                logger().warn(
                    "config input missing FilePaths",
                    Some(&map(&[("file", serde_json::json!(file_name))])),
                );
                return None;
            }
            PipelineInputConfig::File(FileInputConfig {
                file_paths: paths,
                file_encoding: input_value
                    .get("FileEncoding")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                max_dir_search_depth: input_value
                    .get("MaxDirSearchDepth")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                allowing_included_by_multi_configs: input_value
                    .get("AllowingIncludedByMultiConfigs")
                    .and_then(Value::as_bool),
            })
        }
        Some("input_qoder_api") => {
            let api_key = input_value
                .get("ApiKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            let org_id = input_value
                .get("OrgId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if api_key.is_empty() || org_id.is_empty() {
                logger().warn(
                    "config input missing ApiKey or OrgId",
                    Some(&map(&[("file", serde_json::json!(file_name))])),
                );
                return None;
            }
            PipelineInputConfig::QoderApi(QoderApiInputConfig {
                api_key: api_key.into(),
                org_id: org_id.into(),
                api_base: input_value
                    .get("ApiBase")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                interval: input_value.get("Interval").and_then(Value::as_u64),
                backfill_days: input_value.get("BackfillDays").and_then(Value::as_u64),
            })
        }
        other => {
            logger().warn(
                "unknown input type",
                Some(&map(&[
                    ("file", serde_json::json!(file_name)),
                    ("type", serde_json::json!(other)),
                ])),
            );
            return None;
        }
    };
    Some(PipelineConfig {
        config_name: config_name.to_string(),
        inputs: vec![input],
        flushers: vec![PipelineSlsFlusherConfig {
            endpoint: endpoint.into(),
            project: project.into(),
            logstore: logstore.into(),
            region: flusher
                .get("Region")
                .and_then(Value::as_str)
                .map(str::to_string),
            aliuid: flusher
                .get("Aliuid")
                .and_then(Value::as_str)
                .map(str::to_string),
            telemetry_type: flusher
                .get("TelemetryType")
                .and_then(Value::as_str)
                .map(str::to_string),
        }],
        raw: value.clone(),
    })
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn stable_stringify(value: &Value) -> (String, String) {
    let name = value
        .get("configName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (
        name,
        serde_json::to_string(&sort_value(value)).unwrap_or_else(|_| "{}".into()),
    )
}

fn sort_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                if let Some(child) = map.get(key) {
                    sorted.insert(key.clone(), sort_value(child));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_value).collect()),
        other => other.clone(),
    }
}

fn map(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(root: &std::path::Path) -> PipelineManagerOptions {
        PipelineManagerOptions {
            workspace_policy: None,
            config_dir: root.join("config").to_string_lossy().to_string(),
            state_dir: root.join("state").to_string_lossy().to_string(),
            failed_log_dir: root.join("failed").to_string_lossy().to_string(),
            data_dir: root.join("data").to_string_lossy().to_string(),
            pipeline_config: crate::pipeline::types::PipelineToggle {
                enabled: true,
                file_enabled: true,
                qoder_api_enabled: true,
            },
        }
    }

    fn write_config(dir: &std::path::Path, name: &str) {
        let body = serde_json::json!({
            "configName": name,
            "inputs": [{"Type": "input_file", "FilePaths": [dir.join("isolated-logs").join(name).join("*.log")], "FileEncoding": "utf8", "MaxDirSearchDepth": 0}],
            "flushers": [{"Type": "flusher_sls", "Endpoint": "cn-hangzhou.log.aliyuncs.com", "Project": "test-project", "Logstore": "test-logstore"}]
        });
        std::fs::write(dir.join(format!("{name}.json")), body.to_string()).unwrap();
    }

    #[tokio::test]
    async fn starts_stops_and_skips_invalid_files() {
        let root = std::env::temp_dir().join(format!("fcm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let config = root.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let manager = Arc::new(PipelineManager::new(opts(&root)));
        manager.start().await;
        assert!(manager.pipelines.lock().unwrap().is_empty());
        manager.stop().await;
        manager.stop().await;

        write_config(&config, "app-logs");
        write_config(&config, "nginx-logs");
        std::fs::write(config.join("bad.json"), "not json").unwrap();
        std::fs::write(
            config.join("incomplete.json"),
            r#"{"configName":"incomplete"}"#,
        )
        .unwrap();
        std::fs::write(config.join("readme.txt"), "hello").unwrap();
        let manager = Arc::new(PipelineManager::new(opts(&root)));
        manager.start().await;
        {
            let pipelines = manager.pipelines.lock().unwrap();
            assert_eq!(pipelines.len(), 2);
            assert!(pipelines.contains_key("app-logs"));
            assert!(pipelines.contains_key("nginx-logs"));
        }
        manager.stop().await;
        assert!(manager.pipelines.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn wake_keeps_pipeline_identity_and_completes_without_recursive_lock() {
        let root = tempfile::tempdir().unwrap();
        let options = opts(root.path());
        let config = Path::new(&options.config_dir);
        std::fs::create_dir_all(config).unwrap();
        write_config(config, "wake-test");
        let manager = Arc::new(PipelineManager::new(options));
        manager.start().await;
        let before = manager
            .pipelines
            .lock()
            .unwrap()
            .get("wake-test")
            .cloned()
            .unwrap();
        let event = WakeEvent {
            sleep_duration_ms: 60_000,
        };
        // spawn 同时在编译期约束 Future: Send，防止同步 MutexGuard 跨 await 回归。
        let waking = Arc::clone(&manager);
        let mut task = tokio::spawn(async move { waking.handle_wake(event).await });
        match tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await {
            Ok(result) => result.unwrap(),
            Err(_) => {
                task.abort();
                panic!("Pipeline 唤醒未能有界完成");
            }
        }
        let after = manager
            .pipelines
            .lock()
            .unwrap()
            .get("wake-test")
            .cloned()
            .unwrap();
        match (before, after) {
            (Running::File(before), Running::File(after)) => assert!(Arc::ptr_eq(&before, &after)),
            _ => panic!("文件管道类型发生变化"),
        }
        manager.stop().await;
        assert!(manager.pipelines.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn concurrent_wake_rescan_and_stop_do_not_restore_stopped_pipelines() {
        let root = tempfile::tempdir().unwrap();
        let options = opts(root.path());
        std::fs::create_dir_all(&options.config_dir).unwrap();
        write_config(Path::new(&options.config_dir), "stop-test");
        let manager = Arc::new(PipelineManager::new(options));
        manager.start().await;
        let event = WakeEvent {
            sleep_duration_ms: 60_000,
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            tokio::join!(manager.handle_wake(event), manager.rescan(), manager.stop());
        })
        .await
        .unwrap();
        manager.handle_wake(event).await;
        manager.rescan().await;
        assert!(!manager.running.load(std::sync::atomic::Ordering::SeqCst));
        assert!(manager.pipelines.lock().unwrap().is_empty());
        assert!(manager.hashes.lock().unwrap().is_empty());
        assert!(manager.task.lock().unwrap().is_none());
    }

    #[test]
    fn sleep_detector_starts_and_stops() {
        let detector = SleepDetector::new();
        detector.start_manual(0);
        detector.stop();
    }
}
