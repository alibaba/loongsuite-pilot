//! Loopback server, runtime heartbeat, and verdict checkpoint shared by the
//! standalone daemon and the collector process.

use crate::interceptor::access_log::{
    write_interceptor_access_log, AccessLogLimits, InterceptorAccessLogEntry,
};
use crate::interceptor::config::{load_interceptor_config, resolve_enabled_rule_ids};
use crate::interceptor::daemon::runtime::{remove_own_pid, write_runtime, RuntimeWriteOptions};
use crate::interceptor::daemon::server::{
    create_interceptor_server, InterceptorServer, InterceptorServerOptions,
};
use crate::interceptor::paths::{interceptor_access_log_path, interceptor_tool_verdict_path};
use crate::interceptor::rules::{builtin_rules, RuleEngine};
use crate::interceptor::tool_verdict_store::{ToolVerdictAction, ToolVerdictKey, ToolVerdictStore};
use crate::interceptor::types::INTERCEPTOR_DEFAULT_PORT;
use crate::types::AgentActivityEntry;
use crate::utils::create_logger;
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

const RUNTIME_HEARTBEAT: Duration = Duration::from_secs(30);

pub struct InterceptorService {
    pub port: u16,
    pub verdict_store: Arc<ToolVerdictStore>,
    server: InterceptorServer,
    heartbeat: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    data_dir: String,
    stopped: std::sync::atomic::AtomicBool,
}

pub struct StartInterceptorServiceOptions {
    pub data_dir: String,
    pub version: String,
    pub git_commit: Option<String>,
    pub verdict_store: Option<Arc<ToolVerdictStore>>,
    pub emit_blocked_prompt: Option<Arc<dyn Fn(AgentActivityEntry) + Send + Sync>>,
}

pub async fn start_interceptor_service(
    opts: StartInterceptorServiceOptions,
) -> std::io::Result<InterceptorService> {
    start_interceptor_service_at_port(opts, INTERCEPTOR_DEFAULT_PORT).await
}

pub(crate) async fn start_interceptor_service_at_port(
    opts: StartInterceptorServiceOptions,
    port: u16,
) -> std::io::Result<InterceptorService> {
    let logger = create_logger("InterceptorDaemon");
    let interceptor_config = load_interceptor_config(None).await;
    let engine = RuleEngine::new(
        builtin_rules(),
        resolve_enabled_rule_ids(&interceptor_config),
    );
    let created = opts.verdict_store.is_none();
    let verdict_store = opts.verdict_store.unwrap_or_else(|| {
        Arc::new(ToolVerdictStore::new(interceptor_tool_verdict_path(Some(
            &opts.data_dir,
        ))))
    });
    if created {
        verdict_store.restore(chrono::Utc::now().timestamp_millis());
    }
    let access_log = interceptor_access_log_path(Some(&opts.data_dir));
    let server = create_interceptor_server(InterceptorServerOptions {
        version: opts.version.clone(),
        engine,
        write_access_log: Some(Arc::new(move |entry: InterceptorAccessLogEntry| {
            write_interceptor_access_log(&entry, Some(&access_log), AccessLogLimits::default());
        })),
        write_tool_verdict: Some({
            let store = Arc::clone(&verdict_store);
            Arc::new(move |key: ToolVerdictKey, result: ToolVerdictAction| {
                store.put(&key, result, chrono::Utc::now().timestamp_millis());
            })
        }),
        emit_blocked_prompt: opts.emit_blocked_prompt,
    });
    let port = match server.listen(port).await {
        Ok(port) => port,
        Err(err) => {
            server.close().await;
            return Err(err);
        }
    };
    if let Err(err) = write_runtime(&RuntimeWriteOptions {
        data_dir: Some(&opts.data_dir),
        port,
        version: &opts.version,
        git_commit: opts.git_commit.as_deref(),
    })
    .await
    {
        server.close().await;
        return Err(err);
    }
    let mut meta = Map::new();
    meta.insert(
        "addr".to_string(),
        Value::String(format!("127.0.0.1:{port}")),
    );
    logger.info("interceptor HTTP server starting", Some(&meta));
    verdict_store.start_checkpoint_loop(
        crate::interceptor::tool_verdict_store::TOOL_VERDICT_CHECKPOINT_INTERVAL_MS,
    );

    let data_dir = opts.data_dir.clone();
    let version = opts.version.clone();
    let git_commit = opts.git_commit.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RUNTIME_HEARTBEAT);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(err) = write_runtime(&RuntimeWriteOptions {
                data_dir: Some(&data_dir),
                port,
                version: &version,
                git_commit: git_commit.as_deref(),
            })
            .await
            {
                let mut meta = Map::new();
                meta.insert("error".to_string(), Value::String(err.to_string()));
                logger.warn("interceptor runtime heartbeat failed", Some(&meta));
            }
        }
    });

    Ok(InterceptorService {
        port,
        verdict_store,
        server,
        heartbeat: tokio::sync::Mutex::new(Some(heartbeat)),
        data_dir: opts.data_dir,
        stopped: std::sync::atomic::AtomicBool::new(false),
    })
}

impl InterceptorService {
    pub async fn stop(&self) {
        if self.stopped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if let Some(task) = self.heartbeat.lock().await.take() {
            task.abort();
        }
        if let Err(err) = self
            .verdict_store
            .stop_checkpoint_loop(chrono::Utc::now().timestamp_millis())
        {
            let logger = create_logger("InterceptorDaemon");
            let mut meta = Map::new();
            meta.insert("error".to_string(), Value::String(err.to_string()));
            logger.warn("interceptor verdict checkpoint failed", Some(&meta));
        }
        remove_own_pid(Some(&self.data_dir));
        self.server.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::paths::interceptor_runtime_path;
    use serde_json::Value;

    #[tokio::test]
    async fn listens_writes_runtime_and_releases_the_port() {
        const CHILD: &str = "PILOT_INTERCEPTOR_LIFECYCLE_FIXTURE";
        if std::env::var_os(CHILD).is_none() {
            // Keep listener descriptors out of unrelated concurrent tests'
            // fork/pre_exec windows, and never read the developer's real HOME.
            let home = tempfile::tempdir().unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.env_clear().args([
                "--exact",
                "interceptor::daemon::lifecycle::tests::listens_writes_runtime_and_releases_the_port",
            ]).env(CHILD, "1")
                .env("HOME", home.path()).env("USERPROFILE", home.path())
                .env("APPDATA", home.path().join("appdata"))
                .env("LOCALAPPDATA", home.path().join("localappdata"))
                .env("XDG_CONFIG_HOME", home.path().join("config"))
                .env("LOONGSUITE_PILOT_DATA_DIR", home.path().join("data"))
                .env("PATH", home.path().join("empty-path"))
                .env("TMPDIR", home.path()).env("TMP", home.path()).env("TEMP", home.path());
            for key in [
                "SystemRoot",
                "WINDIR",
                "ComSpec",
                "ProgramData",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "PATHEXT",
            ] {
                if let Some(value) = std::env::var_os(key) {
                    child.env(key, value);
                }
            }
            let output = child.output().unwrap();
            assert!(
                output.status.success(),
                "isolated interceptor lifecycle failed: {output:?}"
            );
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_string_lossy().to_string();
        let service = start_interceptor_service_at_port(
            StartInterceptorServiceOptions {
                data_dir: data_dir.clone(),
                version: "9.9.9".into(),
                git_commit: Some("abc123".into()),
                verdict_store: None,
                emit_blocked_prompt: None,
            },
            0,
        )
        .await
        .unwrap();
        let runtime: Value = serde_json::from_str(
            &std::fs::read_to_string(interceptor_runtime_path(Some(&data_dir))).unwrap(),
        )
        .unwrap();
        assert_eq!(runtime["status"], "ok");
        assert_eq!(runtime["pid"], u64::from(std::process::id()));
        assert_eq!(runtime["packageVersion"], "9.9.9");
        assert_eq!(runtime["gitCommit"], "abc123");
        assert_eq!(runtime["daemon_port"], service.port);
        let client = reqwest::Client::new();
        let health: Value = client
            .get(format!("http://127.0.0.1:{}/health", service.port))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["pid"], u64::from(std::process::id()));
        assert_eq!(health["daemon_port"], service.port);
        let port = service.port;
        service.stop().await;
        assert!(std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(200),
        )
        .is_err());
    }
}
