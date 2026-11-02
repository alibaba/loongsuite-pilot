//! Bounded, fail-open timing exchange between short-lived Hooks and the collector.
//! Compatible with main's empty-file lock and hook-metrics JSONL protocol.
use crate::utils::sync_file_lock::with_file_lock;
use indexmap::IndexMap;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const HOOK_METRICS_SPOOL_MAX_BYTES: u64 = 1024 * 1024;
const MAX_TIMING_KEYS: usize = 64;
const MAX_DURATION_MS: f64 = 86_400_000.0;
const LOCK_STALE_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq)]
pub struct HookTimingStats {
    pub agent: String,
    pub hook_event: String,
    pub calls: u64,
    pub total_duration_ms: f64,
    pub max_duration_ms: f64,
}

pub fn is_hook_metric_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn directory(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join("hook-metrics")
}

fn suffix(path: &Path, value: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(value);
    PathBuf::from(name)
}

/// Duration is captured before calling this function, after stdout is flushed.
/// A busy lock, a full spool, or any filesystem error drops only this sample.
pub fn record_hook_timing(data_dir: &Path, agent: &str, event: &str, duration_ms: f64) {
    if !is_hook_metric_name(agent) || !duration_ms.is_finite() || duration_ms < 0.0 {
        return;
    }
    let event = if is_hook_metric_name(event) {
        event
    } else {
        "unknown"
    };
    let line = format!(
        "{}\n",
        serde_json::json!({"hook_event":event,"duration_ms":duration_ms.round()})
    );
    let file = directory(data_dir).join(format!("{agent}.jsonl"));
    #[cfg(test)]
    producer_stage("before-lock");
    let _ = with_file_lock(
        &suffix(&file, ".lock"),
        50,
        LOCK_STALE_MS,
        || -> io::Result<()> {
            #[cfg(test)]
            producer_stage("lock-acquired");
            let size = match fs::metadata(&file) {
                Ok(meta) => meta.len(),
                Err(err) if err.kind() == io::ErrorKind::NotFound => 0,
                Err(err) => return Err(err),
            };
            if size.saturating_add(line.len() as u64) <= HOOK_METRICS_SPOOL_MAX_BYTES {
                #[cfg(test)]
                producer_stage("append");
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file)?
                    .write_all(line.as_bytes())?;
            }
            Ok(())
        },
    );
}

fn rotate(active: &Path, pending: &Path) -> bool {
    with_file_lock(&suffix(active, ".lock"), 0, LOCK_STALE_MS, || {
        // exists() would treat an unreadable pending file as absent.
        match fs::symlink_metadata(pending) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            _ => return false,
        }
        fs::rename(active, pending).is_ok()
    })
    .unwrap_or(false)
}

#[derive(Clone)]
pub struct HookMetricsSpool {
    dir: PathBuf,
}

type Totals = IndexMap<(String, String), HookTimingStats>;

impl HookMetricsSpool {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: directory(data_dir),
        }
    }

    pub fn drain(&self) -> Vec<HookTimingStats> {
        self.drain_with_io(read_pending, |path| fs::remove_file(path))
    }

    fn drain_with_io(
        &self,
        read: impl Fn(&Path) -> io::Result<Option<Vec<u8>>>,
        remove: impl Fn(&Path) -> io::Result<()>,
    ) -> Vec<HookTimingStats> {
        let names = match fs::read_dir(&self.dir) {
            Ok(names) => names,
            Err(err) => {
                if err.kind() != io::ErrorKind::NotFound {
                    warn("hook timing spool directory unreadable");
                }
                return Vec::new();
            }
        };
        let agents: BTreeSet<String> = names
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let agent = name
                    .strip_suffix(".draining")
                    .unwrap_or(&name)
                    .strip_suffix(".jsonl")?;
                is_hook_metric_name(agent).then(|| agent.to_owned())
            })
            .collect();
        let mut totals = Totals::new();
        for agent in agents {
            let active = self.dir.join(format!("{agent}.jsonl"));
            let pending = suffix(&active, ".draining");
            if consume(&pending, &agent, &mut totals, &read, &remove).is_err() {
                warn("hook timing spool drain failed");
                continue;
            }
            if rotate(&active, &pending)
                && consume(&pending, &agent, &mut totals, &read, &remove).is_err()
            {
                warn("hook timing spool drain failed");
            }
        }
        totals.into_values().collect()
    }
}

fn warn(message: &str) {
    crate::utils::create_logger("HookMetricsSpool").warn(message, None);
}

fn read_pending(file: &Path) -> io::Result<Option<Vec<u8>>> {
    let handle = match fs::File::open(file) {
        Ok(handle) => handle,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    // A bounded read also protects against growth between stat and read.
    let mut bytes = Vec::new();
    handle
        .take(HOOK_METRICS_SPOOL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn consume<'a>(
    file: &'a Path,
    agent: &str,
    totals: &mut Totals,
    read: impl FnOnce(&'a Path) -> io::Result<Option<Vec<u8>>>,
    remove: impl FnOnce(&'a Path) -> io::Result<()>,
) -> io::Result<()> {
    let Some(bytes) = read(file)? else {
        return Ok(());
    };
    // Do not count on read or delete failure. Leave pending samples for retry.
    remove(file)?;
    if bytes.len() as u64 > HOOK_METRICS_SPOOL_MAX_BYTES {
        warn("discarded oversized hook timing spool");
        return Ok(());
    }
    #[derive(Deserialize)]
    struct Sample {
        hook_event: String,
        duration_ms: f64,
    }
    let mut rejected = false;
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let sample = match serde_json::from_slice::<Sample>(line) {
            Ok(sample)
                if is_hook_metric_name(&sample.hook_event)
                    && sample.duration_ms.is_finite()
                    && (0.0..=MAX_DURATION_MS).contains(&sample.duration_ms) =>
            {
                sample
            }
            _ => {
                rejected = true;
                continue;
            }
        };
        let key = (agent.to_owned(), sample.hook_event);
        if !totals.contains_key(&key) && totals.len() >= MAX_TIMING_KEYS {
            rejected = true;
            continue;
        }
        let row = totals
            .entry(key.clone())
            .or_insert_with(|| HookTimingStats {
                agent: key.0,
                hook_event: key.1,
                calls: 0,
                total_duration_ms: 0.0,
                max_duration_ms: 0.0,
            });
        row.calls += 1;
        row.total_duration_ms += sample.duration_ms;
        row.max_duration_ms = row.max_duration_ms.max(sample.duration_ms);
    }
    if rejected {
        warn("skipped invalid hook timing samples");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(root: &Path, name: &str, rows: &[serde_json::Value]) -> PathBuf {
        let dir = directory(root);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        fs::write(
            &file,
            rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
        file
    }

    #[test]
    fn roundtrip_sums_rounds_and_separates_dimensions_including_zero() {
        let root = tempfile::tempdir().unwrap();
        let spool = HookMetricsSpool::new(root.path());
        assert!(spool.drain().is_empty());
        for duration in [40.4, 250.0, 0.0] {
            record_hook_timing(root.path(), "codex", "stop", duration);
        }
        record_hook_timing(root.path(), "codex", "session-start", 35.0);
        record_hook_timing(root.path(), "qoder", "stop", 90.0);
        let rows = spool.drain();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            HookTimingStats {
                agent: "codex".into(),
                hook_event: "stop".into(),
                calls: 3,
                total_duration_ms: 290.0,
                max_duration_ms: 250.0
            }
        );
        assert_eq!(rows[1].total_duration_ms, 35.0);
        assert_eq!(rows[2].agent, "qoder");
        assert!(spool.drain().is_empty());
        assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 0);
    }

    #[test]
    fn identifier_validation_and_fail_open_unknown_event() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["", "../escape", "Codex", "-codex", "你好", &"a".repeat(65)] {
            record_hook_timing(root.path(), bad, "stop", 1.0);
            assert!(!is_hook_metric_name(bad));
        }
        assert!(!directory(root.path()).exists());
        record_hook_timing(root.path(), "codex", "Stop Event", 1.0);
        record_hook_timing(root.path(), "codex", "stop", f64::NAN);
        assert_eq!(
            HookMetricsSpool::new(root.path()).drain()[0].hook_event,
            "unknown"
        );
        // A broken data directory affects no Hook output or process behavior.
        let blocked = root.path().join("blocked");
        fs::write(&blocked, "file").unwrap();
        record_hook_timing(&blocked, "codex", "stop", 1.0);
    }

    #[test]
    fn producer_capacity_and_consumer_oversize_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        let file = write(root.path(), "codex.jsonl", &[]);
        fs::write(&file, vec![b'x'; HOOK_METRICS_SPOOL_MAX_BYTES as usize]).unwrap();
        record_hook_timing(root.path(), "codex", "stop", 1.0);
        assert_eq!(
            fs::metadata(&file).unwrap().len(),
            HOOK_METRICS_SPOOL_MAX_BYTES
        );
        fs::write(
            &file,
            vec![b'x'; HOOK_METRICS_SPOOL_MAX_BYTES as usize + 10],
        )
        .unwrap();
        assert!(HookMetricsSpool::new(root.path()).drain().is_empty());
        assert!(!file.exists());
    }

    #[test]
    fn pending_recovery_and_rotation_never_overwrite_unconsumed_samples() {
        let root = tempfile::tempdir().unwrap();
        let pending = write(
            root.path(),
            "codex.jsonl.draining",
            &[json!({"hook_event":"stop","duration_ms":10})],
        );
        let active = write(
            root.path(),
            "codex.jsonl",
            &[json!({"hook_event":"stop","duration_ms":30})],
        );
        assert!(!rotate(&active, &pending));
        assert!(fs::read_to_string(&pending).unwrap().contains("10"));
        assert!(fs::read_to_string(&active).unwrap().contains("30"));
        let rows = HookMetricsSpool::new(root.path()).drain();
        assert_eq!(rows[0].calls, 2);
        assert_eq!(rows[0].total_duration_ms, 40.0);
        assert_eq!(rows[0].max_duration_ms, 30.0);
        assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 0);
    }

    #[test]
    fn read_and_delete_failures_do_not_count_or_remove_pending_samples() {
        let root = tempfile::tempdir().unwrap();
        let pending = write(
            root.path(),
            "codex.jsonl.draining",
            &[json!({"hook_event":"stop","duration_ms":10})],
        );
        for read_fails in [true, false] {
            let mut totals = Totals::new();
            let read = |p: &Path| {
                if read_fails {
                    Err(io::Error::from(io::ErrorKind::PermissionDenied))
                } else {
                    read_pending(p)
                }
            };
            let remove = |_: &Path| -> io::Result<()> {
                assert!(!read_fails);
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            };
            assert!(consume(&pending, "codex", &mut totals, read, remove).is_err());
            assert!(totals.is_empty());
            assert!(pending.exists());
        }
        assert_eq!(HookMetricsSpool::new(root.path()).drain()[0].calls, 1);
    }

    #[test]
    fn contention_drops_only_sample_and_drain_waits_until_lock_clears() {
        let root = tempfile::tempdir().unwrap();
        let active = write(
            root.path(),
            "codex.jsonl",
            &[json!({"hook_event":"stop","duration_ms":20})],
        );
        let lock = suffix(&active, ".lock");
        fs::write(&lock, "holder").unwrap();
        record_hook_timing(root.path(), "codex", "stop", 30.0);
        assert_eq!(fs::read_to_string(&lock).unwrap(), "holder");
        assert!(HookMetricsSpool::new(root.path()).drain().is_empty());
        fs::remove_file(lock).unwrap();
        assert_eq!(
            HookMetricsSpool::new(root.path()).drain(),
            vec![HookTimingStats {
                agent: "codex".into(),
                hook_event: "stop".into(),
                calls: 1,
                total_duration_ms: 20.0,
                max_duration_ms: 20.0
            }]
        );
    }

    #[test]
    fn stale_empty_node_lock_is_reclaimed() {
        let root = tempfile::tempdir().unwrap();
        let active = write(
            root.path(),
            "codex.jsonl",
            &[json!({"hook_event":"stop","duration_ms":20})],
        );
        let lock = suffix(&active, ".lock");
        fs::write(&lock, "").unwrap();
        let file = OpenOptions::new().write(true).open(&lock).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            HookMetricsSpool::new(root.path()).drain(),
            vec![HookTimingStats {
                agent: "codex".into(),
                hook_event: "stop".into(),
                calls: 1,
                total_duration_ms: 20.0,
                max_duration_ms: 20.0
            }]
        );
        assert!(!lock.exists());
        assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 0);
    }

    #[test]
    fn malformed_rows_are_rejected_and_dimension_count_is_capped() {
        let root = tempfile::tempdir().unwrap();
        let file = write(
            root.path(),
            "codex.jsonl",
            &[
                json!(null),
                json!({"duration_ms":5}),
                json!({"hook_event":"Stop Event","duration_ms":1}),
                json!({"hook_event":"stop","duration_ms":"5"}),
                json!({"hook_event":"stop","duration_ms":-1}),
                json!({"hook_event":"stop","duration_ms":MAX_DURATION_MS+1.0}),
                json!({"hook_event":"stop","duration_ms":0}),
                json!({"hook_event":"stop","duration_ms":12.5}),
            ],
        );
        OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"{invalid\n")
            .unwrap();
        let rows = HookMetricsSpool::new(root.path()).drain();
        assert_eq!(rows[0].calls, 2);
        assert_eq!(rows[0].total_duration_ms, 12.5);
        let many: Vec<_> = (0..80)
            .map(|i| json!({"hook_event":format!("event-{i}"),"duration_ms":1}))
            .collect();
        write(root.path(), "codex.jsonl", &many);
        write(root.path(), "qoder.jsonl", &many);
        write(root.path(), "Codex Agent.jsonl", &many);
        write(root.path(), "codex.json", &many);
        assert_eq!(HookMetricsSpool::new(root.path()).drain().len(), 64);
        assert!(directory(root.path()).join("codex.json").exists());
        assert!(directory(root.path()).join("Codex Agent.jsonl").exists());
    }
}

#[cfg(test)]
type ProducerStage = std::sync::Arc<dyn Fn(&'static str) + Send + Sync>;
#[cfg(test)]
thread_local! {static PRODUCER_STAGE:std::cell::RefCell<Option<ProducerStage>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
fn producer_stage(stage: &'static str) {
    if let Some(hook) = PRODUCER_STAGE.with_borrow(Clone::clone) {
        hook(stage);
    }
}
#[cfg(test)]
#[path = "hook_spool_main_contract_tests.rs"]
mod main_contract_tests;
