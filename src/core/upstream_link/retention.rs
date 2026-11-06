//! Deletes stale files under `{dataDir}/acp-correlate`.
//! Port of `acp-correlate-retention-service.ts`.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;

use crate::types::UpstreamLinkConfig;

use super::super::{fields, logger};
use super::trace_linker::TraceLinker;

const STARTUP_DELAY_MS: u64 = 30_000;
const INTERVAL_MS: u64 = 21_600_000;

pub struct AcpCorrelateRetentionService {
    dir: PathBuf,
    ttl_ms: u64,
    linker: Option<std::sync::Arc<TraceLinker>>,
    startup: std::sync::Mutex<Option<JoinHandle<()>>>,
    interval: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl AcpCorrelateRetentionService {
    pub fn new(
        data_dir: impl AsRef<std::path::Path>,
        config: &UpstreamLinkConfig,
        linker: Option<std::sync::Arc<TraceLinker>>,
    ) -> Self {
        Self {
            dir: data_dir.as_ref().join("acp-correlate"),
            ttl_ms: config.ttl_ms,
            linker,
            startup: std::sync::Mutex::new(None),
            interval: std::sync::Mutex::new(None),
        }
    }

    pub fn start(self: &std::sync::Arc<Self>) {
        logger("AcpCorrelateRetention").info(
            "scheduling acp-correlate retention",
            Some(&fields(serde_json::json!({ "ttlMs": self.ttl_ms }))),
        );
        let this = std::sync::Arc::clone(self);
        *self.startup.lock().expect("startup") = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STARTUP_DELAY_MS)).await;
            this.run_cleanup().await;
            let service = std::sync::Arc::clone(&this);
            *this.interval.lock().expect("interval") = Some(tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(INTERVAL_MS));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    service.run_cleanup().await;
                }
            }));
        }));
    }

    pub fn stop(&self) {
        if let Some(task) = self.startup.lock().expect("startup").take() {
            task.abort();
        }
        if let Some(task) = self.interval.lock().expect("interval").take() {
            task.abort();
        }
    }

    pub async fn run_cleanup(&self) -> (u64, u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let cutoff = now.saturating_sub(self.ttl_ms as u128);
        if let Some(linker) = &self.linker {
            linker.prune_idle(cutoff);
        }
        let mut deleted = 0;
        let mut errors = 0;
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return (0, 0);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::metadata(&path) else {
                errors += 1;
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            if mtime >= cutoff {
                continue;
            }
            if let Some(session) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(claim_session)
            {
                match std::fs::metadata(self.dir.join(format!("{session}.jsonl"))) {
                    Ok(source) => {
                        if source
                            .modified()
                            .ok()
                            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                            .is_some_and(|duration| duration.as_millis() >= cutoff)
                        {
                            continue;
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {
                        errors += 1;
                        continue;
                    }
                }
            }
            match std::fs::remove_file(&path) {
                Ok(()) => deleted += 1,
                Err(err) => {
                    errors += 1;
                    logger("AcpCorrelateRetention").warn("failed to clean correlation file", Some(&fields(serde_json::json!({ "file": path.display().to_string(), "error": err.to_string() }))));
                }
            }
        }
        if deleted > 0 || errors > 0 {
            logger("AcpCorrelateRetention").info(
                "acp-correlate retention complete",
                Some(&fields(
                    serde_json::json!({ "deleted": deleted, "errors": errors }),
                )),
            );
        }
        (deleted, errors)
    }
}

fn claim_session(name: &str) -> Option<&str> {
    if let Some(session) = name.strip_suffix(".session-context.done") {
        return Some(session);
    }
    let (session, suffix) = name.strip_suffix(".done")?.rsplit_once(".turn-context-")?;
    let (index, hash) = suffix.split_once('-')?;
    (!index.is_empty()
        && index.bytes().all(|ch| ch.is_ascii_digit())
        && hash.len() == 64
        && hash
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch)))
    .then_some(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deletes_files_older_than_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let correlate = dir.path().join("acp-correlate");
        std::fs::create_dir(&correlate).unwrap();
        let stale = correlate.join("old.jsonl");
        std::fs::write(&stale, b"x").unwrap();
        let old = SystemTime::now() - Duration::from_secs(10);
        let _ = filetime_set(&stale, old);
        let service = AcpCorrelateRetentionService::new(
            dir.path(),
            &UpstreamLinkConfig {
                enabled: true,
                propagate_to_tools: false,
                propagate_to_llm: false,
                generate_trace_when_missing: false,
                ttl_ms: 1_000,
            },
            None,
        );
        let (deleted, _) = service.run_cleanup().await;
        assert_eq!(deleted, 1);
        assert!(!stale.exists());
    }

    fn filetime_set(path: &std::path::Path, time: SystemTime) -> std::io::Result<()> {
        let file = std::fs::File::options().write(true).open(path)?;
        file.set_modified(time)
    }
}
