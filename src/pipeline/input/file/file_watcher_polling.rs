//! Portable non-recursive hints when the native directory backend is unavailable.
//! Work is bounded per drain; directory iterators retain progress and rotate fairly.
use std::collections::{HashMap, VecDeque};
use std::fs::ReadDir;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub(super) const POLL_WORK_BUDGET: usize = 256;
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    identity: Option<(u64, u64)>,
    kind: u8,
    #[cfg(unix)]
    changed: (i64, i64),
}
fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino()))
    };
    #[cfg(windows)]
    let (meta, identity) = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let opened = if meta.is_file() {
            std::fs::OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .open(path)
                .ok()
                .and_then(|file| {
                    let id = crate::utils::file_identity::identity_from_open(&file).ok()?;
                    Some((file.metadata().ok()?, Some((id.dev, id.ino))))
                })
        } else {
            None
        };
        opened.unwrap_or((meta, None))
    };
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (meta.ctime(), meta.ctime_nsec())
    };
    Some(Stamp {
        size: meta.len(),
        modified: meta.modified().ok(),
        created: meta.created().ok(),
        identity,
        kind: if meta.is_file() {
            1
        } else if meta.is_dir() {
            2
        } else if meta.file_type().is_symlink() {
            3
        } else {
            0
        },
        #[cfg(unix)]
        changed,
    })
}
struct Directory {
    path: String,
    known: HashMap<PathBuf, (Option<Stamp>, u64)>,
    order: VecDeque<PathBuf>,
    reader: Option<ReadDir>,
    sweep_remaining: Option<usize>,
    generation: u64,
    priming: bool,
    started: SystemTime,
}
impl Directory {
    fn new(path: String) -> Self {
        Self {
            path,
            known: HashMap::new(),
            order: VecDeque::new(),
            reader: None,
            sweep_remaining: None,
            generation: 1,
            priming: true,
            started: SystemTime::now(),
        }
    }
    fn finish_round(&mut self) {
        self.reader = None;
        self.sweep_remaining = None;
        self.priming = false;
        self.generation = self.generation.wrapping_add(1);
    }
    fn scan(&mut self, budget: usize, dirty: &mut Vec<String>) -> usize {
        if budget == 0 {
            return 0;
        }
        let mut work = 0;
        if self.reader.is_none() && self.sweep_remaining.is_none() {
            work += 1;
            match std::fs::read_dir(&self.path) {
                Ok(reader) => self.reader = Some(reader),
                Err(error) => {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        self.sweep_remaining = Some(self.known.len());
                    } else {
                        return work;
                    }
                }
            }
        }
        while work < budget {
            if let Some(remaining) = self.sweep_remaining {
                if remaining == 0 {
                    self.finish_round();
                    return work;
                }
                work += 1;
                let path = self
                    .order
                    .pop_front()
                    .expect("snapshot queue matches known entries");
                if self
                    .known
                    .get(&path)
                    .is_some_and(|(_, seen)| *seen == self.generation)
                {
                    self.order.push_back(path);
                } else {
                    self.known.remove(&path);
                    dirty.push(path.to_string_lossy().into_owned());
                }
                self.sweep_remaining = Some(remaining - 1);
                if remaining == 1 {
                    self.finish_round();
                    return work;
                }
                continue;
            }
            work += 1;
            match self.reader.as_mut().expect("directory cursor").next() {
                Some(Ok(entry)) => {
                    let path = entry.path();
                    let next = stamp(&path);
                    let changed = match self.known.get(&path) {
                        Some((old, _)) => old != &next,
                        None => {
                            !self.priming
                                || next.as_ref().is_none_or(|value| {
                                    value.modified.is_some_and(|time| time >= self.started)
                                        || value.created.is_some_and(|time| time >= self.started)
                                })
                        }
                    };
                    if changed {
                        dirty.push(path.to_string_lossy().into_owned());
                    }
                    if !self.known.contains_key(&path) {
                        self.order.push_back(path.clone());
                    }
                    self.known.insert(path, (next, self.generation));
                }
                Some(Err(_)) => {}
                None => {
                    self.reader = None;
                    self.sweep_remaining = Some(self.known.len());
                    if self.known.is_empty() {
                        self.finish_round();
                        return work;
                    }
                }
            }
        }
        work
    }
}
pub(super) struct PollingFallback {
    dirs: Vec<Directory>,
    next_dir: usize,
    #[cfg(test)]
    pub(super) last_work: usize,
}
impl PollingFallback {
    pub(super) fn new(dirs: &[String]) -> Self {
        Self {
            dirs: dirs.iter().cloned().map(Directory::new).collect(),
            next_dir: 0,
            #[cfg(test)]
            last_work: 0,
        }
    }
    pub(super) fn sync_dirs(&mut self, dirs: &[String]) {
        self.dirs.retain(|entry| dirs.contains(&entry.path));
        for path in dirs {
            if !self.dirs.iter().any(|entry| &entry.path == path) {
                self.dirs.push(Directory::new(path.clone()));
            }
        }
        if self.next_dir >= self.dirs.len() {
            self.next_dir = 0;
        }
    }
    pub(super) fn poll(&mut self) -> Vec<String> {
        let mut dirty = Vec::new();
        let count = self.dirs.len();
        let mut work = 0;
        for _ in 0..count {
            if work >= POLL_WORK_BUDGET {
                break;
            }
            let index = self.next_dir;
            self.next_dir = (index + 1) % count;
            work += self.dirs[index].scan(POLL_WORK_BUDGET - work, &mut dirty);
        }
        #[cfg(test)]
        {
            self.last_work = work;
        }
        dirty
    }
}
