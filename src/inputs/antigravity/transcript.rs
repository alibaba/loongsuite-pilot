use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

const MAX_LINE: usize = 4 * 1024 * 1024;
const READ_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
pub(super) struct Step {
    pub step_index: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: Option<String>,
    pub created_at: Option<String>,
    pub content: Option<String>,
    pub thinking: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<Tool>,
    #[serde(default)]
    pub media: Vec<Media>,
}

impl Step {
    pub(super) fn prompt(&self) -> bool {
        matches!(self.kind.as_str(), "USER_INPUT" | "SYSTEM_MESSAGE")
    }
    pub(super) fn planner(&self) -> bool {
        self.kind == "PLANNER_RESPONSE"
    }
    pub(super) fn running(&self) -> bool {
        self.status.as_ref().is_some_and(|status| {
            matches!(
                status.to_ascii_uppercase().as_str(),
                "RUNNING" | "PENDING" | "IN_PROGRESS" | "GENERATING" | "WAITING"
            )
        })
    }
    pub(super) fn tool_result(&self) -> bool {
        !matches!(
            self.kind.as_str(),
            "PLANNER_RESPONSE"
                | "USER_INPUT"
                | "SYSTEM_MESSAGE"
                | "CHECKPOINT"
                | "CONVERSATION_HISTORY"
                | "KNOWLEDGE_ARTIFACTS"
                | "TASK_BOUNDARY"
        )
    }
    pub(super) fn timestamp(&self) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(self.created_at.as_deref()?)
            .ok()
            .map(|time| time.timestamp_millis())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(super) struct Tool {
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default, alias = "arguments")]
    pub args: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(super) struct Media {
    pub uri: String,
    pub mime_type: Option<String>,
}

#[derive(Default)]
pub(super) struct Transcript {
    identity: String,
    mtime: Option<SystemTime>,
    observed_size: u64,
    offset: u64,
    buffer: Vec<u8>,
    skipping_long: bool,
    witnesses: Vec<(u64, Vec<u8>)>,
    steps: BTreeMap<i64, Step>,
    provisional: Option<Step>,
    pub more: bool,
    stored_bytes: usize,
}

impl Transcript {
    pub(super) fn scan(&mut self, path: &Path) -> Result<Vec<i64>> {
        let file = match open_normal(path) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
            {
                *self = Self::default();
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };
        self.read_file(file)
    }

    fn read_file(&mut self, mut file: File) -> Result<Vec<i64>> {
        let stat = crate::utils::file_identity::identity_from_open(&file)?;
        let identity = stat.checkpoint_key();
        let mtime = file.metadata()?.modified().ok();
        if !self.more
            && self.observed_size == stat.size
            && self.identity == identity
            && self.mtime == mtime
        {
            return Ok(Vec::new());
        }
        let mut trusted = self.identity == identity && self.offset <= stat.size;
        if trusted && mtime != self.mtime {
            if stat.size <= self.observed_size {
                trusted = false;
            } else {
                for (position, bytes) in &self.witnesses {
                    file.seek(SeekFrom::Start(*position))?;
                    let mut current = vec![0; bytes.len()];
                    file.read_exact(&mut current)?;
                    if current != *bytes {
                        trusted = false;
                        break;
                    }
                }
            }
        }
        if !trusted {
            *self = Self {
                identity,
                ..Self::default()
            };
        }
        self.mtime = mtime;
        self.observed_size = stat.size;
        self.provisional = None;
        let mut changed = Vec::new();
        let mut current = vec![0; READ_LIMIT.min(stat.size.saturating_sub(self.offset)) as usize];
        file.seek(SeekFrom::Start(self.offset))?;
        file.read_exact(&mut current)?;
        ensure!(
            file.metadata()?.len() >= stat.size,
            "Antigravity transcript shrank during read"
        );
        self.offset += current.len() as u64;
        self.more = self.offset < stat.size;
        for part in current.split_inclusive(|byte| *byte == b'\n') {
            let complete = part.last() == Some(&b'\n');
            if !self.skipping_long && self.buffer.len().saturating_add(part.len()) <= MAX_LINE {
                self.buffer.extend_from_slice(part);
            } else {
                self.buffer.clear();
                self.skipping_long = !complete;
            }
            if complete {
                if let Some(step) = parse(&self.buffer) {
                    let id = step.step_index;
                    if self.steps.get(&id) != Some(&step) {
                        let cost = size(&step);
                        let prev = self.steps.get(&id).map_or(0, size);
                        let total = self.stored_bytes.saturating_sub(prev).saturating_add(cost);
                        ensure!(
                            total <= 32 * 1024 * 1024 && (self.steps.len() < 24_576 || prev > 0),
                            "Antigravity transcript cache capacity"
                        );
                        self.stored_bytes = total;
                        self.steps.insert(id, step);
                        changed.push(id);
                    }
                }
                self.buffer.clear();
            }
        }
        if !self.more && !self.skipping_long {
            self.provisional = parse(&self.buffer);
            if let Some(step) = &self.provisional {
                changed.push(step.step_index);
            }
        }
        self.witnesses.clear();
        for position in [0, self.offset.saturating_sub(64)] {
            if self
                .witnesses
                .last()
                .is_some_and(|(seen, _)| *seen == position)
            {
                continue;
            }
            let mut bytes = vec![0; (self.offset - position).min(64) as usize];
            file.seek(SeekFrom::Start(position))?;
            file.read_exact(&mut bytes)?;
            self.witnesses.push((position, bytes));
        }
        Ok(changed)
    }

    pub(super) fn rows(&self) -> BTreeMap<i64, &Step> {
        let mut rows: BTreeMap<_, _> = self.steps.iter().map(|(idx, step)| (*idx, step)).collect();
        if let Some(step) = &self.provisional {
            rows.insert(step.step_index, step);
        }
        rows
    }
}

fn size(step: &Step) -> usize {
    512 + step.content.as_ref().map_or(0, String::len)
        + step.thinking.as_ref().map_or(0, String::len)
        + step
            .tool_calls
            .iter()
            .map(|tool| {
                tool.name.len()
                    + tool.id.as_ref().map_or(0, String::len)
                    + tool.args.as_ref().map_or(0, |args| args.to_string().len())
            })
            .sum::<usize>()
        + step
            .media
            .iter()
            .map(|media| media.uri.len() + media.mime_type.as_ref().map_or(0, String::len))
            .sum::<usize>()
}

fn parse(bytes: &[u8]) -> Option<Step> {
    let mut step = serde_json::from_slice::<Step>(bytes).ok()?;
    if step.kind.is_empty() || step.step_index < 0 {
        return None;
    }
    if let Some(text) = &step.content {
        if text.is_empty() {
            step.content = None;
        }
    }
    step.tool_calls.retain(|tool| !tool.name.trim().is_empty());
    Some(step)
}

pub(super) fn open_normal(path: &Path) -> Result<File> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file(),
        "Antigravity source is not a regular file"
    );
    crate::utils::runtime_paths::runtime_metadata(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let opened = crate::utils::file_identity::path_from_opened_file(&file)?;
    ensure!(
        opened.canonicalize()? == path.canonicalize()?,
        "Antigravity source changed while opening"
    );
    ensure!(
        file.metadata()
            .context("stat Antigravity source")?
            .is_file(),
        "Antigravity source changed type"
    );
    Ok(file)
}
