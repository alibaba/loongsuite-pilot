use async_trait::async_trait;
use loongsuite_pilot::flushers::{BaseFlusher, FlushError};
use loongsuite_pilot::types::AgentActivityEntry;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
pub async fn run_host(executable: &str, args: &[String], root: &Path) {
    run_host_output(executable, args, root, Duration::from_secs(30)).await;
}
pub fn host_command(executable: &str, args: &[String], root: &Path) -> tokio::process::Command {
    let home = root.join("isolated-host-home");
    std::fs::create_dir_all(&home).unwrap();
    let mut cmd = tokio::process::Command::new(executable);
    cmd.args(args)
        .current_dir(repo())
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("LOONGSUITE_PILOT_DATA_DIR", root)
        .env("LOONGSUITE_PILOT_USER_ID", "")
        .env("LOONGSUITE_USER_ID", "")
        .env("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", "")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("AGENT_DATA_COLLECTION_CONFIG", root.join("config.json"));
    // Required only to find the real OS loader on native Windows runners.
    for key in ["SYSTEMROOT", "WINDIR"] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    cmd
}
pub async fn run_host_output(
    executable: &str,
    args: &[String],
    root: &Path,
    timeout: Duration,
) -> std::process::Output {
    let mut cmd = host_command(executable, args, root);
    let out = loongsuite_pilot::utils::candidate_process::output(&mut cmd, timeout, 1024 * 1024)
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{executable}: status={:?} stdout={} stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}
#[derive(Default)]
pub struct Records(pub Mutex<Vec<Vec<AgentActivityEntry>>>);
#[async_trait]
impl BaseFlusher for Records {
    fn name(&self) -> &str {
        "host-records"
    }
    async fn send(&self, e: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.0.lock().unwrap().push(vec![e]);
        Ok(())
    }
    async fn send_batch(
        &self,
        e: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        self.0.lock().unwrap().push(e);
        Ok(())
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}
