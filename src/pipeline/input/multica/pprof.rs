use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::io::Read;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use flate2::read::GzDecoder;
use prost::Message;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use super::config::{source_url, Input, ProfileKind};
use super::records::{digest, pod_labels, record, scalar, Record};
use super::source_http;
use super::sources::{Checkpoint, SourceResult};

const MAX_TABLE: usize = 100_000;
const MAX_STACK: usize = 512;
const MAX_TREE: usize = 100_000;
const MAX_FLAMEGRAPH_BYTES: usize = 8 * 1024 * 1024;
const MAX_INTEGER: u64 = (1 << 53) - 1;

#[derive(Message)]
struct Profile {
    #[prost(message, repeated, tag = "1")]
    sample_type: Vec<ValueType>,
    #[prost(message, repeated, tag = "2")]
    sample: Vec<Sample>,
    #[prost(message, repeated, tag = "4")]
    location: Vec<Location>,
    #[prost(message, repeated, tag = "5")]
    function: Vec<Function>,
    #[prost(string, repeated, tag = "6")]
    string_table: Vec<String>,
    #[prost(int64, tag = "9")]
    time_nanos: i64,
    #[prost(int64, tag = "10")]
    duration_nanos: i64,
    #[prost(message, optional, tag = "11")]
    period_type: Option<ValueType>,
    #[prost(int64, tag = "12")]
    period: i64,
}

#[derive(Message)]
struct ValueType {
    #[prost(int64, tag = "1")]
    r#type: i64,
    #[prost(int64, tag = "2")]
    unit: i64,
}

#[derive(Message)]
struct Sample {
    #[prost(uint64, repeated, tag = "1")]
    locations: Vec<u64>,
    #[prost(int64, repeated, tag = "2")]
    value: Vec<i64>,
}

#[derive(Message)]
struct Location {
    #[prost(uint64, tag = "1")]
    id: u64,
    #[prost(uint64, tag = "3")]
    address: u64,
    #[prost(message, repeated, tag = "4")]
    lines: Vec<Line>,
}

#[derive(Message)]
struct Line {
    #[prost(uint64, tag = "1")]
    function_id: u64,
    #[prost(int64, tag = "2")]
    line: i64,
}

#[derive(Message)]
struct Function {
    #[prost(uint64, tag = "1")]
    id: u64,
    #[prost(int64, tag = "2")]
    name: i64,
    #[prost(int64, tag = "4")]
    filename: i64,
}

#[derive(Default)]
struct Node {
    exclusive: u64,
    inclusive: u64,
    children: BTreeMap<String, Node>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Flame {
    names: Vec<String>,
    levels: Vec<Vec<u64>>,
    num_ticks: u64,
    max_self: u64,
}

impl Flame {
    fn walk(
        &mut self,
        names: &mut HashMap<String, u64>,
        name: &str,
        node: &Node,
        depth: usize,
        offset: u64,
    ) {
        let id = *names.entry(name.to_owned()).or_insert_with(|| {
            let id = self.names.len() as u64;
            self.names.push(name.to_owned());
            id
        });
        if self.levels.len() == depth {
            self.levels.push(Vec::new());
        }
        self.levels[depth].extend([offset, node.inclusive, node.exclusive, id]);
        self.max_self = self.max_self.max(node.exclusive);
        let mut next = offset + node.exclusive;
        for (name, child) in &node.children {
            self.walk(names, name, child, depth + 1, next);
            next += child.inclusive;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata<'a> {
    format: &'static str,
    sample_rate: f64,
    spy_name: &'static str,
    units: &'static str,
    name: &'a str,
}

#[derive(Serialize)]
struct Flamebearer<'a> {
    version: u8,
    flamebearer: Flame,
    metadata: Metadata<'a>,
}

impl ProfileKind {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Allocs => "allocs",
        }
    }
}

struct Converted<'a> {
    graph: Flamebearer<'a>,
    time_ms: i64,
    duration_ms: i64,
}

fn checked_number(number: i64) -> Result<u64, &'static str> {
    u64::try_from(number)
        .ok()
        .filter(|n| *n <= MAX_INTEGER)
        .ok_or("pprof_invalid_integer")
}

fn add(a: u64, b: u64) -> Result<u64, &'static str> {
    let sum = a + b;
    (sum <= MAX_INTEGER)
        .then_some(sum)
        .ok_or("pprof_sample_overflow")
}

fn decode(bytes: &[u8], limit: u64) -> Result<Profile, &'static str> {
    let unpacked;
    let data = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut raw = Vec::new();
        GzDecoder::new(bytes)
            .take(limit + 1)
            .read_to_end(&mut raw)
            .map_err(|_| "pprof_invalid_or_oversized_gzip")?;
        unpacked = raw;
        unpacked.as_slice()
    } else {
        bytes
    };
    if data.len() as u64 > limit {
        return Err("pprof_response_too_large");
    }
    Profile::decode(data).map_err(|_| "pprof_invalid_protobuf")
}

fn convert<'a>(
    bytes: &[u8],
    kind: ProfileKind,
    name: &'a str,
    limit: u64,
) -> Result<Converted<'a>, &'static str> {
    let profile = decode(bytes, limit)?;
    if profile
        .string_table
        .first()
        .is_none_or(|value| !value.is_empty())
        || profile.sample_type.is_empty()
        || [
            profile.sample.len(),
            profile.location.len(),
            profile.function.len(),
            profile.string_table.len(),
        ]
        .into_iter()
        .any(|len| len > MAX_TABLE)
    {
        return Err("pprof_invalid_or_oversized_tables");
    }
    let string = |index| -> Result<&str, &'static str> {
        profile
            .string_table
            .get(checked_number(index)? as usize)
            .map(String::as_str)
            .ok_or("pprof_invalid_string_reference")
    };
    let (sample_name, units) = match kind {
        ProfileKind::Cpu => ("samples", "count"),
        ProfileKind::Allocs => ("alloc_space", "bytes"),
    };
    let mut sample_index = None;
    for (i, sample) in profile.sample_type.iter().enumerate() {
        if string(sample.r#type)? == sample_name && string(sample.unit)? == units {
            sample_index = Some(i);
            break;
        }
    }
    let sample_index = sample_index.ok_or("pprof_unsupported_sample_type")?;
    let period = checked_number(profile.period)?;
    let unit = match kind {
        ProfileKind::Cpu => {
            let period_type = profile.period_type.ok_or("pprof_unsupported_cpu_period")?;
            if period == 0
                || string(period_type.r#type)? != "cpu"
                || string(period_type.unit)? != "nanoseconds"
            {
                return Err("pprof_unsupported_cpu_period");
            }
            "samples"
        }
        ProfileKind::Allocs => "bytes",
    };
    let mut functions = HashMap::new();
    for function in &profile.function {
        if function.id == 0 || functions.insert(function.id, function).is_some() {
            return Err("pprof_invalid_function_id");
        }
    }
    let mut locations = HashMap::new();
    for loc in &profile.location {
        if loc.id == 0 || locations.contains_key(&loc.id) {
            return Err("pprof_invalid_location_id");
        }
        if loc.lines.len() > MAX_STACK {
            return Err("pprof_stack_too_deep");
        }
        let mut frames = Vec::with_capacity(loc.lines.len().max(1));
        for line in loc.lines.iter().rev() {
            let function = functions
                .get(&line.function_id)
                .ok_or("pprof_missing_function")?;
            let source = string(function.filename)?;
            let function = super::diagnostics::redact(string(function.name)?);
            let function: String = function.chars().take(512).collect();
            let function = if function.is_empty() {
                "[unknown]"
            } else {
                &function
            };
            let frame = if source.is_empty() {
                function.to_owned()
            } else {
                let source: String = super::diagnostics::redact(source)
                    .chars()
                    .take(512)
                    .collect();
                format!("{function} {source}:{}", checked_number(line.line)?)
            };
            frames.push(frame);
        }
        if frames.is_empty() {
            frames.push(format!("[unknown address {}]", loc.address));
        }
        locations.insert(loc.id, frames);
    }
    let mut root = Node::default();
    let mut total_nodes = 1;
    for sample in &profile.sample {
        if sample.value.len() != profile.sample_type.len() {
            return Err("pprof_sample_type_mismatch");
        }
        let weight = checked_number(sample.value[sample_index])?;
        if weight == 0 {
            continue;
        }
        if sample.locations.len() > MAX_STACK {
            return Err("pprof_stack_too_deep");
        }
        let mut node = &mut root;
        node.inclusive = add(node.inclusive, weight)?;
        let mut depth = 0;
        for id in sample.locations.iter().rev() {
            let frames = locations.get(id).ok_or("pprof_missing_location")?;
            depth += frames.len();
            if depth > MAX_STACK {
                return Err("pprof_stack_too_deep");
            }
            for frame in frames {
                node = match node.children.entry(frame.clone()) {
                    std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        total_nodes += 1;
                        if total_nodes > MAX_TREE {
                            return Err("pprof_tree_too_large");
                        }
                        entry.insert(Node::default())
                    }
                };
                node.inclusive = add(node.inclusive, weight)?;
            }
        }
        node.exclusive = add(node.exclusive, weight)?;
    }
    let mut flame = Flame {
        num_ticks: root.inclusive,
        ..Default::default()
    };
    flame.walk(&mut HashMap::new(), "total", &root, 0, 0);
    for level in &mut flame.levels {
        let mut previous_end = 0;
        for frame in level.as_chunks_mut::<4>().0 {
            let offset = frame[0];
            frame[0] -= previous_end;
            previous_end = offset + frame[1];
        }
    }
    if profile.time_nanos < 0 || profile.duration_nanos < 0 {
        return Err("pprof_invalid_time");
    }
    Ok(Converted {
        graph: Flamebearer {
            version: 1,
            flamebearer: flame,
            metadata: Metadata {
                format: "single",
                sample_rate: if kind == ProfileKind::Cpu {
                    1e9 / period as f64
                } else {
                    1.0
                },
                spy_name: "go",
                units: unit,
                name,
            },
        },
        time_ms: profile.time_nanos / 1_000_000,
        duration_ms: profile.duration_nanos / 1_000_000,
    })
}

fn json_ascii(graph: &Flamebearer<'_>) -> Result<String, &'static str> {
    let raw = serde_json::to_string(graph).map_err(|_| "pprof_serialization_failed")?;
    let mut ascii = String::with_capacity(raw.len().min(MAX_FLAMEGRAPH_BYTES));
    for ch in raw.chars() {
        if ch.is_ascii() {
            ascii.push(ch);
        } else {
            for code in ch.encode_utf16(&mut [0; 2]) {
                write!(&mut ascii, "\\u{code:04x}").expect("writing to a string");
            }
        }
        if ascii.len() > MAX_FLAMEGRAPH_BYTES {
            return Err("pprof_flamegraph_too_large");
        }
    }
    Ok(ascii)
}

fn iso(time: i64) -> Result<String, &'static str> {
    DateTime::from_timestamp_millis(time)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or("pprof_invalid_time")
}

pub(crate) async fn collect(
    client: &Client,
    input: &Input,
    kind: ProfileKind,
) -> Result<SourceResult, String> {
    let source = input
        .pprof_base_url
        .as_deref()
        .ok_or("pprof_not_configured")?;
    let base = source_url(source).map_err(|_| "invalid_pprof_url")?;
    let (path, seconds) = match kind {
        ProfileKind::Cpu => (
            "/debug/pprof/profile",
            input.pprof_cpu_seconds.unwrap_or(30),
        ),
        ProfileKind::Allocs => (
            "/debug/pprof/allocs",
            input.pprof_allocs_seconds.unwrap_or(10),
        ),
    };
    let mut url = base.join(path).map_err(|_| "invalid_pprof_url")?;
    url.query_pairs_mut()
        .append_pair("seconds", &seconds.to_string());
    let requested = Utc::now().timestamp_millis();
    let limit = input.pprof_max_bytes.unwrap_or(16 * 1024 * 1024);
    let response = source_http::get(
        client,
        url,
        input.timeout() + Duration::from_secs(seconds),
        limit,
        None,
    )
    .await
    .map_err(|error| format!("pprof_{error}"))?;
    let received = Utc::now().timestamp_millis();
    let settings = input.clone();
    let source = source.to_owned();
    tokio::task::spawn_blocking(move || {
        convert_records(
            &settings,
            &source,
            kind,
            limit,
            requested,
            received,
            &response.bytes,
        )
    })
    .await
    .map_err(|_| "pprof_conversion_failed".to_string())?
}

fn convert_records(
    input: &Input,
    source: &str,
    kind: ProfileKind,
    limit: u64,
    requested: i64,
    received: i64,
    bytes: &[u8],
) -> Result<SourceResult, String> {
    let instance = input
        .instance
        .as_ref()
        .and_then(|value| scalar(&Value::String(value.clone())))
        .unwrap_or_else(|| "multica".into());
    let name = format!("{instance} {}", kind.name());
    let converted = convert(bytes, kind, &name, limit)?;
    if converted.duration_ms <= 0 {
        return Err("pprof_missing_interval".into());
    }
    let (started, ended) = if converted.time_ms > 0 {
        if kind == ProfileKind::Cpu {
            (converted.time_ms, converted.time_ms + converted.duration_ms)
        } else {
            (converted.time_ms - converted.duration_ms, converted.time_ms)
        }
    } else {
        (requested, received)
    };
    let raw = json_ascii(&converted.graph)?;
    let sha = digest(&raw);
    let labels = pod_labels(input, &format!("pprof:{source}:{}", kind.name()));
    let pod = ["pod_uid", "pod_name", "pod_ip"]
        .into_iter()
        .find_map(|key| labels.get(key));
    let scoped = pod.map_or_else(|| source.to_owned(), |pod| format!("{source}\0{pod}"));
    let id = format!(
        "{}-{}",
        kind.name(),
        &digest(format!("{scoped}:{ended}:{sha}"))[..24]
    );
    let parts = raw.len().div_ceil(1800).to_string();
    let start = iso(started)?;
    let end = iso(ended)?;
    let end_ms = ended.to_string();
    let duration = (converted.duration_ms as f64 / 1000.0).to_string();
    let total = converted.graph.flamebearer.num_ticks.to_string();
    let version = input
        .pprof_source_version
        .as_ref()
        .and_then(|value| scalar(&Value::String(value.clone())))
        .unwrap_or_default();
    let pod_name = input
        .pprof_pod_name
        .as_ref()
        .and_then(|value| scalar(&Value::String(value.clone())))
        .unwrap_or_default();
    let records: Vec<Record> = raw
        .as_bytes()
        .chunks(1800)
        .enumerate()
        .map(|(i, part)| {
            record([
                ("record_type", "pprof_profile_chunk"),
                ("source_type", "pprof"),
                ("entity_id", &format!("{id}:{i}")),
                ("profile_id", &id),
                ("profile_type", kind.name()),
                (
                    "profile_json_part",
                    std::str::from_utf8(part).expect("ASCII"),
                ),
                ("profile_part_index", &i.to_string()),
                ("profile_part_count", &parts),
                ("profile_sha256", &sha),
                ("profile_unit", converted.graph.metadata.units),
                ("profile_total", &total),
                ("profile_started_at", &start),
                ("profile_ended_at", &end),
                ("profile_end_ms", &end_ms),
                ("profile_duration_seconds", &duration),
                ("source_version", &version),
                ("pod_name", &pod_name),
                (
                    "profile_metadata_source",
                    if converted.time_ms > 0 {
                        "native_pprof"
                    } else {
                        "collector_clock"
                    },
                ),
            ])
        })
        .collect();
    Ok(SourceResult {
        records,
        checkpoint: Some(Checkpoint::next_profile(
            received + (input.pprof_interval_seconds.unwrap_or(900) as i64) * 1000,
        )),
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multica_pprof_preserves_cpu_and_delta_allocation_weights() {
        for (kind, input, weight) in [
            (
                ProfileKind::Cpu,
                include_bytes!("../../../../tests/fixtures/multica/cpu.pprof").as_slice(),
                17,
            ),
            (
                ProfileKind::Allocs,
                include_bytes!("../../../../tests/fixtures/multica/allocs.pprof").as_slice(),
                10_257_869,
            ),
        ] {
            let converted = convert(input, kind, "synthetic 测试", 16 * 1024 * 1024).unwrap();
            let flame = &converted.graph.flamebearer;
            assert_eq!(flame.num_ticks, weight);
            assert_eq!(flame.levels[0], vec![0, weight, 0, 0]);
            assert_eq!(
                flame
                    .levels
                    .iter()
                    .flat_map(|level| level.as_chunks::<4>().0.iter())
                    .map(|item| item[2])
                    .sum::<u64>(),
                weight,
            );
            let ascii = json_ascii(&converted.graph).unwrap();
            assert!(ascii.is_ascii());
            let json: Value = serde_json::from_str(&ascii).unwrap();
            assert_eq!(json["metadata"]["name"], "synthetic 测试");
            assert!(convert(input, kind, "oversize", 5).is_err());
        }
    }
}
