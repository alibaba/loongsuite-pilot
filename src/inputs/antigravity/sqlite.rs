use anyhow::{ensure, Context, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

const PAGE: i64 = 256;
const BLOB_LIMIT: usize = 1024 * 1024;
const SESSION_LIMIT: usize = 16_384;

#[derive(Clone, Default, Debug)]
pub(super) struct Metadata {
    pub model: Option<String>,
    pub model_id: Option<u64>,
    pub turn: Option<String>,
    pub created: Option<i64>,
    pub completed: Option<i64>,
    pub first_token: Option<i64>,
    pub execution: Option<i64>,
    pub tool_id: Option<String>,
    pub tool_name: Option<String>,
    pub ttft: Option<u64>,
    pub stream: Option<u64>,
    pub steps: Vec<i64>,
    pub usages: Vec<(Option<usize>, Usage)>,
}

#[derive(Clone, Default, Debug)]
pub(super) struct Usage {
    pub model_id: Option<u64>,
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub reasoning: u64,
    pub ids: [Option<String>; 3],
}

impl Usage {
    fn has_tokens(&self) -> bool {
        [
            self.input,
            self.output,
            self.cache_creation,
            self.cache_read,
            self.reasoning,
        ]
        .into_iter()
        .any(|count| count > 0)
    }
}

#[derive(Default)]
pub(super) struct Snapshot {
    identity: Option<String>,
    pub roots: Vec<String>,
    pub timestamp: Option<i64>,
    pub steps: BTreeMap<i64, Metadata>,
    pub generated: BTreeMap<i64, Metadata>,
    step_offset: i64,
    generation_offset: i64,
    pub more: bool,
}

impl Snapshot {
    pub(super) fn scan(&mut self, path: &Path, changed_steps: &[i64], audit: bool) -> Result<()> {
        let opened = super::transcript::open_normal(path)?;
        let identity = crate::utils::file_identity::identity_from_open(&opened)?.checkpoint_key();
        if self.identity.as_deref() != Some(&identity) {
            *self = Self {
                identity: Some(identity),
                ..Self::default()
            };
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(Duration::from_millis(150))?;
        db.execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN DEFERRED;")?;
        if self.roots.is_empty() || audit {
            self.workspace(&db)?;
        }
        self.more = read_rows(
            &db,
            Table::Steps,
            &mut self.step_offset,
            &mut self.steps,
            changed_steps,
            audit,
        )? | read_rows(
            &db,
            Table::Generated,
            &mut self.generation_offset,
            &mut self.generated,
            changed_steps,
            audit,
        )?;
        db.execute_batch("COMMIT;")?;
        Ok(())
    }

    fn workspace(&mut self, db: &Connection) -> Result<()> {
        if !has_table(db, "trajectory_metadata_blob")? {
            return Ok(());
        }
        let mut query = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE typeof(data) = 'blob' AND length(data) <= ?1 ORDER BY rowid LIMIT 129")?;
        let mut rows = query.query([BLOB_LIMIT])?;
        let mut roots = Vec::new();
        let mut fallback = None;
        let mut index = 0;
        while let Some(row) = rows.next()? {
            index += 1;
            ensure!(index <= 128, "Antigravity workspace metadata limit");
            let data: Vec<u8> = row.get(0)?;
            let Ok(fields) = Proto::parse(&data) else {
                continue;
            };
            self.timestamp = self
                .timestamp
                .or_else(|| fields.sub(2).and_then(|time| timestamp(&time)));
            for workspace in fields
                .all(1)
                .filter_map(|message| Proto::parse(message).ok())
            {
                roots.extend(
                    [workspace.text(1), workspace.text(2)]
                        .into_iter()
                        .flatten()
                        .filter_map(local_uri),
                );
            }
            roots.extend(
                fields
                    .all(7)
                    .filter_map(|url| std::str::from_utf8(url).ok())
                    .filter_map(local_uri),
            );
            if fallback.is_none() && roots.is_empty() {
                fallback = workspace_fallback(&fields, 0);
            }
        }
        if roots.is_empty() {
            roots.extend(fallback);
        }
        let mut unique = std::collections::HashSet::new();
        roots.retain(|root| unique.insert(root.clone()));
        self.roots = roots;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Table {
    Steps,
    Generated,
}

impl Table {
    fn names(self) -> (&'static str, &'static str) {
        match self {
            Self::Steps => ("steps", "metadata"),
            Self::Generated => ("gen_metadata", "data"),
        }
    }

    fn parse(self, blob: &[u8]) -> Option<Metadata> {
        let fields = Proto::parse(blob).ok()?;
        match self {
            Self::Steps => Some(step_metadata(&fields)),
            Self::Generated => generation_metadata(&fields),
        }
    }
}

fn has_table(db: &Connection, table: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn read_rows(
    db: &Connection,
    table: Table,
    offset: &mut i64,
    values: &mut BTreeMap<i64, Metadata>,
    changed_steps: &[i64],
    audit: bool,
) -> Result<bool> {
    let (name, column) = table.names();
    if !has_table(db, name)? {
        return Ok(false);
    }
    let max = db
        .query_row(&format!("SELECT MAX(idx) FROM {name}"), [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .unwrap_or(-1);
    if values.is_empty() && *offset == 0 {
        *offset = -1;
    }
    if *offset > max {
        *offset = -1;
        values.clear();
    }
    let select = format!("SELECT idx, CASE WHEN typeof({column}) = 'blob' AND length({column}) <= {BLOB_LIMIT} THEN {column} END FROM {name}");
    let mut query = db.prepare(&format!("{select} WHERE idx > ?1 ORDER BY idx LIMIT ?2"))?;
    let mut rows = query.query(rusqlite::params![*offset, PAGE])?;
    let old_offset = *offset;
    while let Some(row) = rows.next()? {
        let idx: i64 = row.get(0)?;
        *offset = idx;
        let blob: Option<Vec<u8>> = row.get(1)?;
        ensure!(
            values.len() < SESSION_LIMIT,
            "Antigravity SQLite metadata capacity"
        );
        values.insert(
            idx,
            blob.and_then(|blob| table.parse(&blob)).unwrap_or_default(),
        );
    }
    let candidates = values
        .iter()
        .rev()
        .filter_map(|(idx, row)| {
            if *idx > old_offset {
                return None;
            }
            let point = match table {
                Table::Steps => {
                    changed_steps.contains(idx)
                        || (row.execution.is_some() && row.completed.is_none())
                }
                Table::Generated => row.steps.iter().any(|idx| changed_steps.contains(idx)),
            };
            (point
                || row.usages.is_empty()
                || row.usages.iter().any(|(_, usage)| !usage.has_tokens()))
            .then_some(*idx)
        })
        .take(64)
        .collect::<Vec<_>>();
    let mut point = db.prepare(&format!("{select} WHERE idx = ?1"))?;
    let mut touched = std::collections::HashSet::new();
    for idx in candidates.into_iter().chain(if audit {
        values.keys().rev().take(64).copied().collect::<Vec<_>>()
    } else {
        Vec::new()
    }) {
        if !touched.insert(idx) {
            continue;
        }
        let blob: Option<Vec<u8>> = point
            .query_row([idx], |row| row.get(1))
            .optional()?
            .flatten();
        if let Some(metadata) = blob.and_then(|blob| table.parse(&blob)) {
            values.insert(idx, metadata);
        }
    }
    Ok(*offset < max)
}

fn step_metadata(fields: &Proto<'_>) -> Metadata {
    let info = fields.sub(24);
    let tool = fields.sub(4);
    Metadata {
        model: info
            .as_ref()
            .and_then(|info| info.text(12).or_else(|| info.text(8)))
            .map(str::to_owned),
        model_id: info.and_then(|info| info.number(1)).filter(|id| *id > 0),
        turn: fields.text(12).map(str::to_owned),
        created: fields.sub(1).and_then(|time| timestamp(&time)),
        completed: fields.sub(8).and_then(|time| timestamp(&time)),
        first_token: fields.sub(6).and_then(|time| timestamp(&time)),
        execution: fields.sub(32).and_then(|time| timestamp(&time)),
        tool_id: tool
            .as_ref()
            .and_then(|tool| tool.text(1))
            .map(str::to_owned),
        tool_name: tool
            .as_ref()
            .and_then(|tool| tool.text(2))
            .map(str::to_owned),
        usages: usages(fields, 9, 28),
        ..Metadata::default()
    }
}

fn generation_metadata(fields: &Proto<'_>) -> Option<Metadata> {
    let model = fields.sub(1)?;
    let mut steps = fields
        .numbers(2)
        .filter_map(|number| i64::try_from(number).ok())
        .collect::<Vec<_>>();
    for mut packed in fields.all(2) {
        while !packed.is_empty() && steps.len() < 256 {
            let Ok(value) = varint(&mut packed) else {
                break;
            };
            if let Ok(value) = i64::try_from(value) {
                steps.push(value);
            }
        }
    }
    Some(Metadata {
        model: model.text(19).or_else(|| model.text(21)).map(str::to_owned),
        model_id: model.number(3).filter(|id| *id > 0),
        completed: model
            .sub(9)
            .and_then(|info| info.sub(4))
            .and_then(|time| timestamp(&time)),
        ttft: model.sub(11).and_then(|time| duration(&time)),
        stream: model.sub(12).and_then(|time| duration(&time)),
        usages: usages(&model, 4, 17),
        steps,
        ..Metadata::default()
    })
}

fn usages(fields: &Proto<'_>, primary: u32, retries: u32) -> Vec<(Option<usize>, Usage)> {
    fields
        .sub(primary)
        .and_then(usage)
        .map(|usage| (None, usage))
        .into_iter()
        .chain(
            fields
                .all(retries)
                .take(64)
                .enumerate()
                .filter_map(|(index, blob)| {
                    let retry = Proto::parse(blob).ok()?.sub(2)?;
                    Some((Some(index), usage(retry)?))
                }),
        )
        .collect()
}

fn usage(fields: Proto<'_>) -> Option<Usage> {
    if fields.0.is_empty() {
        return None;
    }
    let count = |field| fields.number(field).unwrap_or_default();
    let [input, output, cache_creation, cache_read, reasoning, visible] =
        [2, 3, 4, 5, 9, 10].map(count);
    if [
        input,
        output,
        cache_creation,
        cache_read,
        reasoning,
        visible,
    ]
    .into_iter()
    .any(|count| count > 100_000_000)
    {
        return None;
    }
    Some(Usage {
        model_id: fields.number(1).filter(|id| *id > 0),
        input,
        output: output.max(reasoning + visible),
        cache_creation,
        cache_read,
        reasoning,
        ids: [11, 12, 7].map(|id| fields.text(id).map(str::to_owned)),
    })
}

fn duration(time: &Proto<'_>) -> Option<u64> {
    let ns = time.number(2).unwrap_or_default();
    (ns < 1_000_000_000).then_some(())?;
    time.number(1)
        .unwrap_or_default()
        .checked_mul(1_000_000_000)?
        .checked_add(ns)
}

fn timestamp(time: &Proto<'_>) -> Option<i64> {
    let ms = i64::try_from(duration(time)? / 1_000_000).ok()?;
    (1_577_836_800_000..4_102_444_800_000)
        .contains(&ms)
        .then_some(ms)
}

fn local_uri(uri: &str) -> Option<String> {
    let url = reqwest::Url::parse(uri).ok()?;
    if url.scheme() != "file"
        || url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
    {
        return None;
    }
    let path = url.to_file_path().ok()?;
    let text = path.to_str()?;
    if path.parent().is_none()
        || text.starts_with("//")
        || text.starts_with("\\\\")
        || text.chars().any(char::is_control)
    {
        return None;
    }
    Some(text.to_owned())
}

fn workspace_fallback(fields: &Proto<'_>, depth: u8) -> Option<String> {
    if depth > 8 {
        return None;
    }
    fields.0.iter().find_map(|(_, field)| {
        let Field::Blob(bytes) = field else {
            return None;
        };
        std::str::from_utf8(bytes)
            .ok()
            .and_then(local_uri)
            .or_else(|| workspace_fallback(&Proto::parse(bytes).ok()?, depth + 1))
    })
}

enum Field<'a> {
    Number(u64),
    Blob(&'a [u8]),
}
struct Proto<'a>(Vec<(u32, Field<'a>)>);

impl<'a> Proto<'a> {
    fn parse(mut bytes: &'a [u8]) -> Result<Self> {
        let mut fields = Vec::new();
        while !bytes.is_empty() {
            let key = varint(&mut bytes)?;
            let field = u32::try_from(key >> 3)?;
            ensure!(
                field != 0 && fields.len() < 4096,
                "invalid Antigravity protobuf field"
            );
            let value = match key & 7 {
                0 => Field::Number(varint(&mut bytes)?),
                2 => {
                    let len = usize::try_from(varint(&mut bytes)?)?;
                    let (value, rest) = bytes
                        .split_at_checked(len)
                        .context("short Antigravity protobuf value")?;
                    bytes = rest;
                    Field::Blob(value)
                }
                1 | 5 => {
                    let len = if key & 7 == 1 { 8 } else { 4 };
                    bytes = bytes
                        .get(len..)
                        .context("short Antigravity protobuf fixed field")?;
                    continue;
                }
                _ => anyhow::bail!("unsupported Antigravity protobuf encoding"),
            };
            fields.push((field, value));
        }
        Ok(Self(fields))
    }

    fn numbers(&self, number: u32) -> impl Iterator<Item = u64> + '_ {
        self.0.iter().filter_map(move |(key, value)| match value {
            Field::Number(value) if *key == number => Some(*value),
            _ => None,
        })
    }

    fn number(&self, number: u32) -> Option<u64> {
        self.numbers(number).next()
    }

    fn all(&self, number: u32) -> impl Iterator<Item = &'a [u8]> + '_ {
        self.0.iter().filter_map(move |(key, value)| match value {
            Field::Blob(value) if *key == number => Some(*value),
            _ => None,
        })
    }

    fn text(&self, number: u32) -> Option<&'a str> {
        let text = std::str::from_utf8(self.all(number).next()?).ok()?;
        (!text.is_empty() && text.len() <= 2048 && !text.chars().any(char::is_control))
            .then_some(text)
    }

    fn sub(&self, number: u32) -> Option<Self> {
        Self::parse(self.all(number).next()?).ok()
    }
}

fn varint(bytes: &mut &[u8]) -> Result<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let (byte, rest) = bytes
            .split_first()
            .context("short Antigravity protobuf varint")?;
        *bytes = rest;
        ensure!(
            shift != 63 || *byte < 2,
            "Antigravity protobuf varint overflow"
        );
        value |= u64::from(byte & 127) << shift;
        if *byte < 128 {
            return Ok(value);
        }
    }
    anyhow::bail!("invalid Antigravity protobuf varint")
}
