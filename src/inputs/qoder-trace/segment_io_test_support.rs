//! Task-local injection at native IO boundaries; successful paths still use actual files.
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
#[derive(Default)]
pub(super) struct Faults {
    pub open: usize,
    pub stable_open: usize,
    pub root: usize,
    pub directory: usize,
    pub stat: usize,
    pub read_at: usize,
}
pub(super) struct Probe {
    pub read_calls: usize,
    pub read_bytes: usize,
    pub max_read_bytes: usize,
    pub root_attempts: usize,
    pub directory_attempts: usize,
    pub stat_attempts: usize,
    pub metadata_opens: usize,
    pub body_opens: usize,
    pub read_attempts: usize,
    pub faults: Faults,
    pub append_after_read: Option<(std::path::PathBuf, String)>,
}
impl Default for Probe {
    fn default() -> Self {
        Self {
            read_calls: 0,
            read_bytes: 0,
            max_read_bytes: usize::MAX,
            root_attempts: 0,
            directory_attempts: 0,
            stat_attempts: 0,
            metadata_opens: 0,
            body_opens: 0,
            read_attempts: 0,
            faults: Faults::default(),
            append_after_read: None,
        }
    }
}
tokio::task_local! {pub(super) static PROBE:Arc<Mutex<Probe>>;}
fn busy() -> io::Error {
    io::Error::from(io::ErrorKind::ResourceBusy)
}
fn touch(f: impl FnOnce(&mut Probe) -> io::Result<()>) -> io::Result<()> {
    PROBE
        .try_with(|p| f(&mut p.lock().unwrap()))
        .unwrap_or(Ok(()))
}
pub(super) fn root() -> io::Result<()> {
    touch(|p| {
        p.root_attempts += 1;
        if p.faults.root > 0 {
            p.faults.root -= 1;
            Err(busy())
        } else {
            Ok(())
        }
    })
}
pub(super) fn directory() -> io::Result<()> {
    touch(|p| {
        p.directory_attempts += 1;
        if p.faults.directory > 0 {
            p.faults.directory -= 1;
            Err(busy())
        } else {
            Ok(())
        }
    })
}
pub(super) fn open() -> io::Result<()> {
    touch(|p| {
        p.metadata_opens += 1;
        if p.faults.stable_open > 0 {
            p.faults.stable_open -= 1;
            p.body_opens += 1;
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        if p.faults.open > 0 {
            p.faults.open -= 1;
            p.body_opens += 1;
            return Err(busy());
        }
        Ok(())
    })
}
pub(super) fn stat() -> io::Result<()> {
    touch(|p| {
        p.stat_attempts += 1;
        if p.faults.stat > 0 {
            p.faults.stat -= 1;
            Err(busy())
        } else {
            Ok(())
        }
    })
}
pub(super) fn body_open() {
    let _ = touch(|p| {
        p.body_opens += 1;
        Ok(())
    });
}
pub(super) fn before_read() -> io::Result<()> {
    touch(|p| {
        p.read_attempts += 1;
        if p.faults.read_at == p.read_attempts {
            Err(busy())
        } else {
            Ok(())
        }
    })
}
pub(super) fn read_limit(wanted: usize) -> usize {
    PROBE
        .try_with(|p| wanted.min(p.lock().unwrap().max_read_bytes.max(1)))
        .unwrap_or(wanted)
}
pub(super) fn read_completed(bytes: usize) {
    let appended = PROBE
        .try_with(|p| {
            let mut p = p.lock().unwrap();
            p.read_calls += 1;
            p.read_bytes += bytes;
            p.append_after_read.take()
        })
        .ok()
        .flatten();
    if let Some((path, text)) = appended {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
}
