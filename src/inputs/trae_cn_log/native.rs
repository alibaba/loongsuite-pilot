use chrono::{NaiveDate, TimeDelta};
use ciborium::value::Value;
use flate2::read::DeflateDecoder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, Metadata};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_COMPRESSED: u64 = 16 * 1024 * 1024;
const MAX_DECODED: u64 = 64 * 1024 * 1024;

type Sequences = BTreeSet<u64>;

#[derive(Default)]
pub(super) struct NativeIndex {
    sources: Vec<FileStamp>,
    receipts: HashMap<(PathBuf, String), Receipt>,
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

struct Receipt {
    session: String,
    turn: String,
    conflicted: bool,
    done: bool,
    calls: HashSet<String>,
    histories: BTreeMap<String, i64>,
    expected: HashMap<String, Sequences>,
    streams: Vec<Stream>,
    active: Option<usize>,
    ambiguous: bool,
}

#[derive(Default)]
struct Stream {
    owner: String,
    request: String,
    headers_at: Option<i64>,
    initial: bool,
    terminal: bool,
    closed: bool,
    continuation: Option<String>,
    histories: HashSet<String>,
    tools: BTreeSet<String>,
    todo_starts: BTreeMap<String, i64>,
    reports: BTreeSet<(String, u64)>,
    result_count: Option<usize>,
    committed_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Round {
    pub id: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_ids: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub initial: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub shared: bool,
    #[serde(skip)]
    pub reports: Vec<(String, u64)>,
    #[serde(skip)]
    pub todos: Vec<Todo>,
}

pub(super) struct Todo {
    pub call: String,
    pub start: i64,
    pub committed_at: i64,
}

pub(super) struct Evidence<'a> {
    pub trace: &'a str,
    receipt: &'a Receipt,
}

impl NativeIndex {
    pub fn refresh(&mut self, root: &Path) {
        let sources = find_sources(root);
        if self.sources == sources {
            return;
        }
        self.receipts.clear();
        for source in &sources {
            let Some(folder) = source.path.parent() else {
                continue;
            };
            let folder = folder.to_owned();
            if let Some(mut decoder) = decoder(&source.path, root, source.bytes) {
                while let Ok(record) = ciborium::de::from_reader::<Value, _>(&mut decoder) {
                    visit(&mut self.receipts, &folder, &record);
                }
            }
        }
        self.sources = sources;
    }

    pub fn evidence(&self, session: &str, tools: &HashSet<String>) -> Option<Evidence<'_>> {
        if tools.is_empty() {
            return None;
        }
        let mut records = self
            .receipts
            .iter()
            .filter(|(_, receipt)| receipt.session == session && !receipt.calls.is_disjoint(tools));
        let ((_, trace), receipt) = records.next()?;
        (records.next().is_none() && receipt.done && !receipt.conflicted)
            .then_some(Evidence { trace, receipt })
    }
}

impl Evidence<'_> {
    pub fn expected(&self, reply: &str) -> Option<&Sequences> {
        self.receipt.expected.get(reply)
    }

    pub fn matches_owner(&self, trace: &str, reply: &str) -> bool {
        self.trace == trace && (self.receipt.expected.is_empty() || self.expected(reply).is_some())
    }

    pub fn owns_tools(&self, reply: &str, tools: &HashSet<String>) -> bool {
        let receipt = self.receipt;
        if self.expected(reply).is_none() {
            return false;
        }
        if receipt.expected.len() == 1 {
            return true;
        }
        if receipt.ambiguous {
            return false;
        }
        let mut owners = receipt.streams.iter().filter(|stream| {
            stream
                .tools
                .iter()
                .any(|id| tools.contains(id) && receipt.calls.contains(id))
        });
        let Some(owner) = owners.next().filter(|owner| owner.closed) else {
            return false;
        };
        owners.next().is_none()
            && !owner.reports.is_empty()
            && owner.reports.iter().all(|(observed, _)| observed == reply)
    }

    pub fn complete(&self, reply: &str, actual: impl Iterator<Item = u64>, len: usize) -> bool {
        self.receipt.expected.len() == 1
            && self.expected(reply).is_some_and(|expected| {
                expected.len() == len && actual.into_iter().all(|seq| expected.contains(&seq))
            })
    }

    pub fn rounds(&self, tools: &HashSet<String>) -> Vec<Round> {
        let receipt = self.receipt;
        let exact_turn =
            receipt.expected.len() <= 1 && tools.iter().all(|id| receipt.calls.contains(id));
        let mut histories: Vec<_> = receipt.histories.iter().collect();
        histories.sort_by_key(|(id, at)| (**at, *id));
        histories
            .into_iter()
            .map(|(id, at)| {
                let mut round = Round {
                    id: id.clone(),
                    at: at.to_string(),
                    request: None,
                    headers_at: None,
                    continuation: None,
                    tool_ids: Vec::new(),
                    initial: false,
                    terminal: false,
                    shared: false,
                    reports: Vec::new(),
                    todos: Vec::new(),
                };
                let mut owners = receipt
                    .streams
                    .iter()
                    .enumerate()
                    .filter(|(_, stream)| stream.histories.contains(id));
                let Some((index, stream)) = owners.next() else {
                    return round;
                };
                if receipt.ambiguous
                    || owners.next().is_some()
                    || !stream.closed
                    || receipt
                        .streams
                        .iter()
                        .filter(|other| other.request == stream.request)
                        .count()
                        != 1
                {
                    return round;
                }
                round.tool_ids =
                    stream
                        .tools
                        .iter()
                        .filter(|tool| {
                            receipt.calls.contains(*tool)
                                && receipt.streams.iter().enumerate().all(
                                    |(other, other_stream)| {
                                        index == other || !other_stream.tools.contains(*tool)
                                    },
                                )
                        })
                        .cloned()
                        .collect();
                round.shared = stream.histories.len() > 1;
                round.reports =
                    stream
                        .reports
                        .iter()
                        .filter(|report| {
                            !(!round.shared && stream.reports.len() != 1)
                                && receipt.streams.iter().enumerate().all(
                                    |(other, other_stream)| {
                                        index == other || !other_stream.reports.contains(*report)
                                    },
                                )
                        })
                        .cloned()
                        .collect();
                round.request = Some(stream.request.clone());
                round.continuation = stream.continuation.clone();
                round.initial = index == 0 && stream.initial;
                round.terminal = index + 1 == receipt.streams.len() && stream.terminal;
                if !round.shared {
                    round.headers_at = stream
                        .headers_at
                        .filter(|headers| *headers < *at)
                        .map(|t| t.to_string());
                }
                if let Some(committed_at) = stream.committed_at.filter(|_| exact_turn) {
                    round.todos = stream
                        .todo_starts
                        .iter()
                        .filter(|(call, start)| {
                            **start <= committed_at && round.tool_ids.contains(*call)
                        })
                        .map(|(call, start)| Todo {
                            call: call.clone(),
                            start: *start,
                            committed_at,
                        })
                        .collect();
                }
                round
            })
            .collect()
    }
}

fn find_sources(root: &Path) -> Vec<FileStamp> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir())
            || !run_folder(&entry.file_name().to_string_lossy())
        {
            continue;
        }
        let folder = entry.path().join("Modular");
        if !folder.symlink_metadata().is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("ai_agent-") || !name.ends_with(".alaudalog") {
                continue;
            }
            let path = entry.path();
            let Some((bytes, modified)) = path.symlink_metadata().ok().and_then(recent) else {
                continue;
            };
            paths.push(FileStamp {
                path,
                bytes,
                modified,
            });
        }
    }
    // Work on the latest active files and replay each rotation in append order.
    paths.sort_by_key(|stamp| (stamp.modified, stamp.path.clone()));
    if paths.len() > 16 {
        paths.drain(..paths.len() - 16);
    }
    paths
}

fn run_folder(name: &str) -> bool {
    name.len() == 15
        && name.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 8 {
                *b == b'T'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn recent(stat: Metadata) -> Option<(u64, SystemTime)> {
    let modified = stat.modified().ok()?;
    (stat.is_file()
        && (178..=MAX_COMPRESSED).contains(&stat.len())
        && modified.elapsed().unwrap_or_default() < Duration::from_secs(3600))
    .then_some((stat.len(), modified))
}

fn decoder(
    path: &Path,
    root: &Path,
    bytes: u64,
) -> Option<std::io::Take<DeflateDecoder<BufReader<std::fs::File>>>> {
    let mut file = crate::utils::source_access::open_under(path, root).ok()?;
    let mut header = [0; 178];
    file.read_exact(&mut header).ok()?;
    if &header[..4] != b"AalG" || &header[152..156] != b"AALG" {
        return None;
    }
    let start = 172 + u64::from(u32::from_le_bytes(header[168..172].try_into().ok()?));
    if !(172..=1024).contains(&start) || start >= bytes {
        return None;
    }
    file.seek(SeekFrom::Start(start)).ok()?;
    Some(DeflateDecoder::new(BufReader::new(file)).take(MAX_DECODED))
}

fn visit(records: &mut HashMap<(PathBuf, String), Receipt>, folder: &Path, row: &Value) {
    let Some(fields) = field(row, "fields") else {
        return;
    };
    let Some(trace) = field_text(fields, "trace_id").filter(|id| hex(id, 32)) else {
        return;
    };
    let Some(message) = field_text(fields, "message") else {
        return;
    };
    let key = (folder.to_owned(), trace.to_owned());
    if message == "context resolve applied to task request" {
        let Some((session, turn)) = field_text(fields, "session_id")
            .zip(field_text(fields, "turn_id"))
            .filter(|(session, turn)| hex(session, 24) && hex(turn, 24))
        else {
            return;
        };
        if records.len() >= 4096 && !records.contains_key(&key) {
            return;
        }
        let receipt = records.entry(key).or_insert_with(|| Receipt {
            session: session.into(),
            turn: turn.into(),
            done: false,
            conflicted: false,
            calls: HashSet::new(),
            histories: BTreeMap::new(),
            expected: HashMap::new(),
            streams: Vec::new(),
            active: None,
            ambiguous: false,
        });
        receipt.conflicted |= receipt.session != session || receipt.turn != turn;
        return;
    }
    let Some(receipt) = records.get_mut(&key).filter(|receipt| !receipt.conflicted) else {
        return;
    };
    let owner = field(row, "span").and_then(|span| {
        wire_text(span)
            .map(str::to_owned)
            .or_else(|| integer(span).map(|value| value.to_string()))
    });
    if message == "cloud stream response headers" {
        if let Some(url) = field_text(fields, "url") {
            let initial = url.ends_with("/api/agent/v3/create_agent_task");
            if initial || url.ends_with("/api/agent/v3/commit_toolcall_result") {
                receipt.ambiguous |= receipt.active.take().is_some();
                match (
                    owner.as_deref(),
                    field_text(fields, "resp_logid").filter(|id| !id.is_empty() && id.len() <= 128),
                ) {
                    (Some(owner), Some(request)) if receipt.streams.len() < 512 => {
                        let continuation = receipt
                            .streams
                            .last()
                            .filter(|last| {
                                !initial && last.closed && !last.terminal && last.owner == owner
                            })
                            .map(|last| last.request.clone());
                        receipt.active = Some(receipt.streams.len());
                        receipt.streams.push(Stream {
                            owner: owner.into(),
                            request: request.into(),
                            headers_at: timestamp(row),
                            initial,
                            continuation,
                            ..Stream::default()
                        });
                    }
                    _ => receipt.ambiguous = true,
                }
            }
        }
    }
    receipt.ambiguous |= flag(fields, "has_async_child") == Some(true)
        || flag(fields, "has_foreground") == Some(true);
    let active = receipt
        .active
        .and_then(|i| receipt.streams.get_mut(i))
        .filter(|stream| owner.as_deref() == Some(stream.owner.as_str()));
    let call = field_text(fields, "toolcall_id").filter(|id| !id.is_empty() && id.len() <= 256);
    let usage = (message == "[Hub] task event contract"
        && field_text(fields, "event_type") == Some("token_usage")
        && field_text(fields, "conversation_id") == Some(&receipt.session))
    .then(|| {
        field_text(fields, "task_id")
            .filter(|reply| hex(reply, 24))
            .zip(field(fields, "event_seq").and_then(integer))
    })
    .flatten();
    let history = (message == "recording history entry"
        && field_text(fields, "history_source") == Some("Server")
        && field_text(fields, "source") == Some("llm_default"))
    .then(|| field_text(fields, "history_id").filter(|id| hex(id, 24)))
    .flatten();
    if let Some(stream) = active {
        match message {
            "streaming ToolCall dispatch"
                if flag(fields, "require_local_execution") == Some(true) =>
            {
                if let Some(id) = call.filter(|_| stream.tools.len() < 256) {
                    stream.tools.insert(id.into());
                }
            }
            "tool execution started" if field_text(fields, "tool_name") == Some("TodoWrite") => {
                if let Some((id, at)) = call
                    .filter(|id| stream.tools.contains(*id))
                    .zip(timestamp(row))
                {
                    stream.todo_starts.insert(id.into(), at);
                }
            }
            "routing CommitReady"
                if flag(fields, "has_async_child") == Some(false)
                    && flag(fields, "has_foreground") == Some(false) =>
            {
                stream.result_count = field(fields, "parent_result_count")
                    .and_then(integer)
                    .and_then(|n| usize::try_from(n).ok());
            }
            "commit_results" | "resolving explicit Cloud task completion as terminal" => {
                stream.terminal = message != "commit_results";
                let count = stream.tools.len();
                stream.closed = if stream.terminal {
                    count == 0
                } else {
                    field_text(fields, "conversation_id") == Some(&receipt.session)
                        && stream.result_count == Some(count)
                        && field(fields, "result_count").and_then(integer) == Some(count as u64)
                };
                if stream.closed && !stream.terminal {
                    stream.committed_at = timestamp(row);
                }
                receipt.active = None;
            }
            _ => {}
        }
        if let Some(id) = history.filter(|_| stream.histories.len() < 512) {
            stream.histories.insert(id.into());
        }
        if let Some((reply, seq)) = usage.filter(|_| stream.reports.len() < 512) {
            stream.reports.insert((reply.into(), seq));
        }
    }
    if message == "tool execution started" {
        if let Some(id) = call.filter(|_| receipt.calls.len() < 512) {
            receipt.calls.insert(id.into());
        }
    }
    if let Some((id, at)) = history
        .filter(|_| receipt.histories.len() < 512)
        .zip(timestamp(row))
    {
        receipt.histories.entry(id.into()).or_insert(at);
    }
    if let Some((reply, seq)) = usage
        .filter(|(reply, _)| receipt.expected.len() < 512 || receipt.expected.contains_key(*reply))
    {
        let report = receipt.expected.entry(reply.into()).or_default();
        if report.len() < 512 {
            report.insert(seq);
        } else {
            receipt.conflicted = true;
        }
    }
    if message == "chat: runner completed" && field_text(fields, "turn_id") == Some(&receipt.turn) {
        receipt.done = true;
    }
}

pub(super) fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value
        .as_map()?
        .iter()
        .find(|(candidate, _)| wire_text(candidate) == Some(key))
        .map(|(_, item)| item)
}
fn wire_text(value: &Value) -> Option<&str> {
    match value {
        Value::Text(text) => Some(text),
        Value::Bytes(data) => std::str::from_utf8(data).ok(),
        _ => None,
    }
}
fn field_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    field(value, key).and_then(wire_text)
}
fn flag(value: &Value, key: &str) -> Option<bool> {
    field(value, key)?.as_bool()
}
fn integer(value: &Value) -> Option<u64> {
    value.as_integer().and_then(|n| u64::try_from(n).ok())
}

fn timestamp(row: &Value) -> Option<i64> {
    let parts = field(row, "time")?.as_array()?;
    let [year, day, hour, min, sec, nanos, off_hour, off_min, off_sec] = parts.as_slice() else {
        return None;
    };
    let signed = |value: &Value| i64::try_from(value.as_integer()?).ok();
    let unsigned = |value: &Value| u32::try_from(integer(value)?).ok();
    let offset = signed(off_hour)?
        .checked_mul(3600)?
        .checked_add(signed(off_min)?.checked_mul(60)?)?
        .checked_add(signed(off_sec)?)?;
    NaiveDate::from_yo_opt(i32::try_from(signed(year)?).ok()?, unsigned(day)?)?
        .and_hms_nano_opt(
            unsigned(hour)?,
            unsigned(min)?,
            unsigned(sec)?,
            unsigned(nanos)?,
        )?
        .checked_sub_signed(TimeDelta::try_seconds(offset)?)?
        .and_utc()
        .timestamp_nanos_opt()
}
