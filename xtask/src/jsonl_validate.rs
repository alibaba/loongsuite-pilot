//! 原生 AgentActivityEntry 校验：承接远程校验器的类型、关联与字段覆盖率合同。

use anyhow::{bail, ensure, Context, Result};
use clap::{Args, ValueEnum};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};

const DEFAULT_FILTER: &str = "claude-code,codex,qoder-cli,cursor-cli,qwen-code-cli,opencode";
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;
const COMMON: &[&str] = &[
    "time_unix_nano",
    "event.id",
    "user.id",
    "event.name",
    "gen_ai.session.id",
    "gen_ai.agent.type",
    "gen_ai.provider.name",
];
const EVENTS: &[&str] = &[
    "gen_ai.model.request",
    "gen_ai.model.response",
    "gen_ai.tool.call",
    "gen_ai.tool.result",
    "gen_ai.agent.invoke",
    "gen_ai.agent.result",
    "llm.request",
    "llm.response",
    "tool.call",
    "tool.result",
    "skill.use",
    "tool.approve",
    "agent.input",
    "react.step",
    "other",
];
const COVERAGE: &[&str] = &[
    "time_unix_nano",
    "event.id",
    "user.id",
    "event.name",
    "gen_ai.session.id",
    "gen_ai.agent.type",
    "gen_ai.provider.name",
    "gen_ai.agent.invocation.id",
    "gen_ai.agent.parent.invocation.id",
    "gen_ai.agent.peer.id",
    "gen_ai.agent.peer.name",
    "trace_id",
    "span_id",
    "gen_ai.turn.id",
    "gen_ai.step.id",
    "gen_ai.turn.start",
    "gen_ai.turn.end",
    "gen_ai.request.id",
    "gen_ai.request.model",
    "gen_ai.response.id",
    "gen_ai.response.model",
    "gen_ai.response.finish_reasons",
    "gen_ai.input.messages_delta",
    "gen_ai.output.messages",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.tool.name",
    "gen_ai.tool.call.id",
    "gen_ai.tool.call.duration",
    "tool.result.status",
    "error.type",
];
const NUMBERS: &[&str] = &[
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.usage.input_cost",
    "gen_ai.usage.output_cost",
    "gen_ai.usage.cache_read.input_cost",
    "gen_ai.usage.cache_creation.input_cost",
    "gen_ai.usage.total_cost",
];
const ARRAYS: &[&str] = &[
    "gen_ai.response.finish_reasons",
    "gen_ai.input.messages",
    "gen_ai.input.messages_delta",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "gen_ai.tool.definitions",
];
const CATEGORIES: &[&str] = &[
    "missing_required",
    "bad_event_name",
    "parse_error",
    "type_error",
    "duplicate_event_id",
    "model_pair_error",
    "tool_pair_error",
    "turn_boundary_error",
    "empty_window",
    "empty_input",
    "no_files",
];

#[derive(Args)]
pub struct Options {
    /// 默认使用 _JV_LOG_DIR、E2E_JSONL_LOG_DIR 或隔离 HOME 下的日志目录。
    #[arg(long)]
    input_dir: Option<PathBuf>,
    #[arg(long)]
    agent_filter: Option<String>,
    #[arg(long)]
    since_seconds: Option<u64>,
    #[arg(long)]
    max_samples: Option<usize>,
    /// 错误返回 1；诊断模式仍输出全部问题，但不作为通过凭据。
    #[arg(long)]
    strict: bool,
    #[arg(long, value_enum, default_value = "text")]
    format: Format,
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Text,
    Json,
}

struct Settings {
    directory: PathBuf,
    filter: Vec<String>,
    since_seconds: u64,
    max_samples: usize,
    strict: bool,
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn env_number<T: std::str::FromStr>(key: &str) -> Result<Option<T>> {
    env_nonempty(key)
        .map(|value| {
            value
                .parse()
                .map_err(|_| anyhow::anyhow!("{key} 必须是非负整数"))
        })
        .transpose()
}

impl Settings {
    fn resolve(options: &Options) -> Result<Self> {
        let directory = options
            .input_dir
            .clone()
            .or_else(|| env_nonempty("_JV_LOG_DIR").map(PathBuf::from))
            .or_else(|| env_nonempty("E2E_JSONL_LOG_DIR").map(PathBuf::from))
            .or_else(|| {
                env_nonempty("HOME")
                    .or_else(|| env_nonempty("USERPROFILE"))
                    .map(|home| Path::new(&home).join(".loongsuite-pilot/logs/output"))
            })
            .context("必须指定 --input-dir 或 HOME/USERPROFILE")?;
        let raw_filter = options
            .agent_filter
            .clone()
            .filter(|v| !v.is_empty())
            .or_else(|| env_nonempty("E2E_JSONL_AGENT_FILTER"))
            .unwrap_or_else(|| DEFAULT_FILTER.into());
        let raw_filter = raw_filter.trim().to_ascii_lowercase();
        let filter = if matches!(raw_filter.as_str(), "all" | "*") {
            Vec::new()
        } else {
            let values: Vec<_> = raw_filter
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            ensure!(
                !values.is_empty(),
                "Agent 过滤器不能为空；使用 all 显式关闭过滤"
            );
            values
        };
        let since_seconds = match options.since_seconds {
            Some(value) => value,
            None => env_number("E2E_JSONL_SINCE_SECONDS")?.unwrap_or(0),
        };
        let max_samples = match options.max_samples {
            Some(value) => value,
            None => env_number("E2E_JSONL_MAX_SAMPLES")?.unwrap_or(3),
        };
        ensure!(max_samples <= 1000, "max-samples 不能超过 1000");
        let strict = if options.strict {
            true
        } else {
            match env_nonempty("E2E_JSONL_STRICT").as_deref() {
                None | Some("0") => false,
                Some("1") => true,
                Some(_) => bail!("E2E_JSONL_STRICT 只能为 0 或 1"),
            }
        };
        Ok(Self {
            directory,
            filter,
            since_seconds,
            max_samples,
            strict,
        })
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema: u32,
    entries: u64,
    windowed: u64,
    hard_issues: u64,
    issue_counts: BTreeMap<&'static str, u64>,
    files: Vec<FileStat>,
    coverage: BTreeMap<String, EventCoverage>,
    event_names: BTreeMap<String, u64>,
    agent_types: BTreeMap<String, u64>,
    providers: BTreeMap<String, u64>,
    suspicious_placeholders: u64,
    samples: Vec<Sample>,
}
#[derive(Default, Serialize)]
struct FileStat {
    file: String,
    entries: u64,
    windowed: u64,
    issues: u64,
    events: BTreeMap<String, u64>,
}
#[derive(Default, Serialize)]
struct EventCoverage {
    count: u64,
    fields: BTreeMap<&'static str, u64>,
}
#[derive(Serialize)]
struct Sample {
    file: String,
    category: &'static str,
    fields: Vec<&'static str>,
}

impl Report {
    fn issue(
        &mut self,
        file: Option<usize>,
        category: &'static str,
        mut fields: Vec<&'static str>,
        limit: usize,
    ) {
        self.hard_issues += 1;
        *self.issue_counts.entry(category).or_default() += 1;
        if let Some(index) = file {
            self.files[index].issues += 1;
        }
        if self.samples.len() < limit {
            fields.sort_unstable();
            fields.dedup();
            self.samples.push(Sample {
                file: file
                    .map(|index| self.files[index].file.clone())
                    .unwrap_or_default(),
                category,
                fields,
            });
        }
    }
}

fn has(value: &Value) -> bool {
    !value.is_null() && value.as_str() != Some("")
}
fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}
fn digits(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn valid_id(value: &Value, length: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == length
            && s.bytes().all(|b| b.is_ascii_hexdigit())
            && s.bytes().any(|b| b != b'0')
    })
}
fn types(entry: &Value) -> Vec<&'static str> {
    let mut bad = Vec::new();
    for field in ["time_unix_nano", "observed_time_unix_nano"] {
        if has(&entry[field]) && !digits(&entry[field]) {
            bad.push(field);
        }
    }
    for field in &COMMON[1..] {
        if has(&entry[*field]) && !entry[*field].is_string() {
            bad.push(*field);
        }
    }
    for (field, length) in [("trace_id", 32), ("span_id", 16), ("parent_span_id", 16)] {
        if has(&entry[field]) && !valid_id(&entry[field], length) {
            bad.push(field);
        }
    }
    for field in NUMBERS {
        if has(&entry[*field])
            && !entry[*field]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
        {
            bad.push(*field);
        }
    }
    let duration = "gen_ai.tool.call.duration";
    if has(&entry[duration])
        && !entry[duration]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        bad.push(duration);
    }
    for field in ARRAYS {
        if has(&entry[*field]) && !entry[*field].is_array() {
            bad.push(*field);
        }
    }
    for field in ["gen_ai.turn.start", "gen_ai.turn.end"] {
        if has(&entry[field]) && !entry[field].is_boolean() {
            bad.push(field);
        }
    }
    for field in ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"] {
        if entry[field]
            .as_str()
            .is_some_and(|s| s.trim_start().starts_with(['[', '{']))
        {
            bad.push(field);
        }
    }
    bad
}

fn normalized_agent(agent: &str) -> String {
    agent
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn terminal(entry: &Value) -> bool {
    let agent = normalized_agent(&text(&entry["gen_ai.agent.type"]));
    if entry["gen_ai.agent.scope"] == "subagent" && agent != "codex" {
        return false;
    }
    if entry["gen_ai.turn.end"] == true {
        return true;
    }
    match agent.as_str() {
        // Status annotates every Codex record. Only its native end marker
        // closes a turn, including a child turn.
        "codex" => false,
        "openclaw" => entry["agent.openclaw.hook"] == "llm_output",
        _ => entry["gen_ai.response.finish_reasons"]
            .as_array()
            .is_some_and(|reasons| {
                reasons.iter().any(|r| {
                    matches!(
                        r.as_str(),
                        Some("stop" | "end_turn" | "cancelled" | "error")
                    )
                })
            }),
    }
}

// 关联检查只保留 ID 与计数，不保存 prompt、工具参数或结果。
struct Row {
    file: usize,
    event_id: String,
    event: String,
    agent: String,
    session: String,
    turn: String,
    step: String,
    call: String,
    tool: String,
    subagent: bool,
    codex: bool,
    start: bool,
    end: bool,
    terminal: bool,
}
impl Row {
    fn new(file: usize, entry: &Value) -> Self {
        Self {
            file,
            event_id: text(&entry["event.id"]),
            event: text(&entry["event.name"]),
            agent: text(&entry["gen_ai.agent.type"]),
            session: text(&entry["gen_ai.session.id"]),
            turn: text(&entry["gen_ai.turn.id"]),
            step: text(&entry["gen_ai.step.id"]),
            call: text(&entry["gen_ai.tool.call.id"]),
            tool: text(&entry["gen_ai.tool.name"]),
            subagent: entry["gen_ai.agent.scope"] == "subagent",
            codex: normalized_agent(&text(&entry["gen_ai.agent.type"])) == "codex",
            start: entry["gen_ai.turn.start"] == true,
            end: entry["gen_ai.turn.end"] == true,
            terminal: terminal(entry),
        }
    }
}

fn record(report: &mut Report, index: usize, entry: &Value, limit: usize) {
    let event = entry["event.name"].as_str().unwrap_or("<missing>");
    let mut missing: Vec<_> = COMMON
        .iter()
        .copied()
        .filter(|field| !has(&entry[*field]))
        .collect();
    let conditional: &[&str] = match event {
        "tool.call" | "tool.result" | "gen_ai.tool.call" | "gen_ai.tool.result" => {
            &["gen_ai.tool.name", "gen_ai.tool.call.id"]
        }
        "skill.use" => &["gen_ai.skill.name"],
        "gen_ai.agent.invoke" | "gen_ai.agent.result" => &["gen_ai.agent.invocation.id"],
        _ => &[],
    };
    missing.extend(
        conditional
            .iter()
            .copied()
            .filter(|field| !has(&entry[*field])),
    );
    let failed = entry["tool.result.status"].as_str().is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "failure" | "failed" | "error"
        )
    });
    let error_finish = entry["gen_ai.response.finish_reasons"]
        .as_array()
        .is_some_and(|r| r.iter().any(|v| v == "error"));
    if (failed || error_finish || has(&entry["error.message"])) && !has(&entry["error.type"]) {
        missing.push("error.type");
    }
    if !missing.is_empty() {
        report.issue(Some(index), "missing_required", missing, limit);
    }
    if entry.get("event.name").is_some() && !EVENTS.contains(&event) {
        report.issue(Some(index), "bad_event_name", vec!["event.name"], limit);
    }
    let bad = types(entry);
    if !bad.is_empty() {
        report.issue(Some(index), "type_error", bad, limit);
    }
    // 非法事件字段可能混入任意用户正文，不把其值写入诊断。
    let label = if EVENTS.contains(&event) {
        event
    } else {
        "<missing-or-invalid>"
    };
    *report.files[index].events.entry(label.into()).or_default() += 1;
    *report.event_names.entry(label.into()).or_default() += 1;
    for (field, counts) in [
        ("gen_ai.agent.type", &mut report.agent_types),
        ("gen_ai.provider.name", &mut report.providers),
    ] {
        if let Some(value) = entry[field].as_str().filter(|v| !v.is_empty()) {
            *counts.entry(value.into()).or_default() += 1;
        }
    }
    let coverage = report.coverage.entry(label.into()).or_default();
    coverage.count += 1;
    for field in COVERAGE {
        if has(&entry[*field]) {
            *coverage.fields.entry(*field).or_default() += 1;
        }
    }
    for field in [
        "gen_ai.provider.name",
        "gen_ai.request.model",
        "gen_ai.response.model",
    ] {
        if entry[field].as_str().is_some_and(|s| {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "unknown" | "n/a" | "na" | "none" | "null" | "undefined"
            )
        }) {
            report.suspicious_placeholders += 1;
        }
    }
}

fn canonical_event(event: &str) -> &str {
    match event {
        "gen_ai.model.request" => "llm.request",
        "gen_ai.model.response" => "llm.response",
        "gen_ai.tool.call" => "tool.call",
        "gen_ai.tool.result" => "tool.result",
        _ => event,
    }
}

fn graph(report: &mut Report, rows: &[Row], limit: usize) {
    let mut ids = BTreeSet::new();
    let mut steps: BTreeMap<_, Vec<&Row>> = BTreeMap::new();
    let mut tools: BTreeMap<_, Vec<&Row>> = BTreeMap::new();
    let mut turns: BTreeMap<_, Vec<&Row>> = BTreeMap::new();
    for row in rows {
        if !row.event_id.is_empty() && !ids.insert(&row.event_id) {
            report.issue(
                Some(row.file),
                "duplicate_event_id",
                vec!["event.id"],
                limit,
            );
        }
        if matches!(canonical_event(&row.event), "llm.request" | "llm.response")
            && !row.step.is_empty()
        {
            steps
                .entry((&row.session, &row.turn, &row.step))
                .or_default()
                .push(row);
        }
        if matches!(canonical_event(&row.event), "tool.call" | "tool.result")
            && !row.call.is_empty()
        {
            tools
                .entry((&row.session, &row.call))
                .or_default()
                .push(row);
        }
        if !row.turn.is_empty()
            && (!row.subagent || row.codex)
            && !matches!(
                row.event.as_str(),
                "gen_ai.agent.invoke" | "gen_ai.agent.result"
            )
        {
            turns
                .entry((&row.agent, &row.session, &row.turn))
                .or_default()
                .push(row);
        }
    }
    for group in steps.values() {
        if group
            .iter()
            .filter(|r| canonical_event(&r.event) == "llm.request")
            .count()
            != 1
            || group
                .iter()
                .filter(|r| canonical_event(&r.event) == "llm.response")
                .count()
                != 1
        {
            report.issue(
                Some(group[0].file),
                "model_pair_error",
                vec!["event.name", "gen_ai.step.id"],
                limit,
            );
        }
    }
    for group in tools.values() {
        let names: BTreeSet<_> = group
            .iter()
            .map(|r| &r.tool)
            .filter(|name| !name.is_empty())
            .collect();
        if group
            .iter()
            .filter(|r| canonical_event(&r.event) == "tool.call")
            .count()
            != 1
            || group
                .iter()
                .filter(|r| canonical_event(&r.event) == "tool.result")
                .count()
                != 1
            || names.len() != 1
        {
            report.issue(
                Some(group[0].file),
                "tool_pair_error",
                vec!["event.name", "gen_ai.tool.call.id", "gen_ai.tool.name"],
                limit,
            );
        }
    }
    for group in turns.values() {
        if group.iter().filter(|r| r.start).count() != 1
            || group.iter().filter(|r| r.end).count()
                != usize::from(group.iter().any(|r| r.terminal))
        {
            report.issue(
                Some(group[0].file),
                "turn_boundary_error",
                vec!["gen_ai.turn.start", "gen_ai.turn.end"],
                limit,
            );
        }
    }
}

fn scan(settings: &Settings) -> Result<Report> {
    let mut report = Report {
        schema: 1,
        issue_counts: CATEGORIES.iter().map(|c| (*c, 0)).collect(),
        ..Default::default()
    };
    let mut paths = Vec::new();
    match fs::read_dir(&settings.directory) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.context("无法枚举输入目录")?;
                let name = entry.file_name();
                let name = name.to_str().context("JSONL 文件名不是 UTF-8")?;
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let base = name.trim_end_matches(".jsonl").to_ascii_lowercase();
                if settings.filter.is_empty()
                    || settings
                        .filter
                        .iter()
                        .any(|a| base == *a || base.starts_with(&format!("{a}-")))
                {
                    ensure!(
                        entry.file_type()?.is_file(),
                        "JSONL 输入必须为普通文件，不能是链接或目录"
                    );
                    paths.push(entry.path());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => bail!("无法读取 JSONL 输入目录"),
    }
    paths.sort();
    if paths.is_empty() {
        report.issue(None, "no_files", Vec::new(), settings.max_samples);
        return Ok(report);
    }
    let now = u128::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0) * 1_000_000;
    let since = u128::from(settings.since_seconds) * 1_000_000_000;
    let mut bytes = 0_u64;
    let mut rows = Vec::new();
    for path in paths {
        let index = report.files.len();
        report.files.push(FileStat {
            file: path.file_name().unwrap().to_string_lossy().into_owned(),
            ..Default::default()
        });
        let mut reader = BufReader::new(File::open(path).context("无法打开 JSONL 输入文件")?);
        loop {
            let mut line = Vec::new();
            let length = reader
                .by_ref()
                .take(MAX_LINE_BYTES + 1)
                .read_until(b'\n', &mut line)
                .context("无法读取 JSONL 输入")?;
            if length == 0 {
                break;
            }
            bytes += length as u64;
            ensure!(
                length as u64 <= MAX_LINE_BYTES && bytes <= MAX_INPUT_BYTES,
                "JSONL 输入超过资源上限"
            );
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            report.entries += 1;
            report.files[index].entries += 1;
            let entry: Value = match serde_json::from_slice(&line) {
                Ok(value) => value,
                Err(_) => {
                    report.issue(Some(index), "parse_error", Vec::new(), settings.max_samples);
                    continue;
                }
            };
            if !entry.is_object() {
                report.issue(Some(index), "type_error", Vec::new(), settings.max_samples);
                continue;
            }
            // 坏时间字段必须进入类型诊断，不能借时间窗口过滤而逃过严格校验。
            let timestamp = entry["time_unix_nano"]
                .as_str()
                .filter(|_| digits(&entry["time_unix_nano"]))
                .and_then(|s| s.parse::<u128>().ok());
            if since > 0 && timestamp.is_some_and(|ns| now.saturating_sub(ns) > since) {
                continue;
            }
            report.windowed += 1;
            report.files[index].windowed += 1;
            record(&mut report, index, &entry, settings.max_samples);
            rows.push(Row::new(index, &entry));
        }
        if report.files[index].entries == 0 {
            report.issue(Some(index), "empty_input", Vec::new(), settings.max_samples);
        }
    }
    graph(&mut report, &rows, settings.max_samples);
    if since > 0 && report.windowed == 0 {
        report.issue(Some(0), "empty_window", Vec::new(), settings.max_samples);
    }
    Ok(report)
}

fn counts(values: &BTreeMap<String, u64>) -> String {
    if values.is_empty() {
        "<none>".into()
    } else {
        values
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}
fn render(report: &Report, settings: &Settings) -> String {
    let mut out = String::new();
    use std::fmt::Write;
    if report.files.is_empty() {
        out.push_str("[jsonl-validate] no .jsonl files\n");
    }
    for stat in &report.files {
        let _ = writeln!(
            out,
            "[jsonl-validate] {} {} entries={} windowed={} issues={} event.name{{{}}}",
            if stat.issues == 0 { "OK" } else { "FAIL" },
            stat.file,
            stat.entries,
            stat.windowed,
            stat.issues,
            counts(&stat.events)
        );
    }
    let _ = writeln!(
        out,
        "\n=== [jsonl-validate] summary ===\n  files={} entries={} windowed={}",
        report.files.len(),
        report.entries,
        report.windowed
    );
    for category in CATEGORIES {
        let _ = writeln!(out, "  {category}={}", report.issue_counts[category]);
    }
    let _ = writeln!(
        out,
        "  suspicious_placeholders={} (reported, not a universal failure)",
        report.suspicious_placeholders
    );
    for (field, values) in [
        ("event.name", &report.event_names),
        ("gen_ai.agent.type", &report.agent_types),
        ("gen_ai.provider.name", &report.providers),
    ] {
        let _ = writeln!(out, "  {field}: {}", counts(values));
    }
    out.push_str("  per-event field coverage:\n");
    for (event, coverage) in &report.coverage {
        let _ = writeln!(out, "    {event} count={}", coverage.count);
        for field in COVERAGE {
            let count = coverage.fields.get(field).copied().unwrap_or(0);
            let percent = count as f64 * 100.0 / coverage.count as f64;
            let _ = writeln!(out, "      {field}={count} ({percent:.1}%)");
        }
    }
    if !report.samples.is_empty() {
        let _ = writeln!(
            out,
            "  issue samples (field names only, up to {}):",
            settings.max_samples
        );
        for sample in &report.samples {
            let _ = writeln!(
                out,
                "    - file={} category={} fields=[{}]",
                sample.file,
                sample.category,
                sample.fields.join(",")
            );
        }
    }
    out
}

pub fn run(options: Options) -> u8 {
    let result = (|| -> Result<u8> {
        let settings = Settings::resolve(&options)?;
        let report = scan(&settings)?;
        let output = match options.format {
            Format::Text => render(&report, &settings),
            Format::Json => format!("{}\n", serde_json::to_string_pretty(&report)?),
        };
        std::io::stdout().lock().write_all(output.as_bytes())?;
        Ok(u8::from(settings.strict && report.hard_issues > 0))
    })();
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("[jsonl-validate] {error}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loongsuite_pilot::normalization::{build_agent_activity_entry, normalize_event_name};
    use loongsuite_pilot::types::{ActionType, AgentEventName, ClientType};
    use serde_json::json;

    fn schema_report(entry: &Value) -> Report {
        let mut report = Report {
            files: vec![FileStat::default()],
            ..Report::default()
        };
        record(&mut report, 0, entry, 10);
        report
    }

    #[test]
    fn activity_contract_accepts_real_builder_outputs_optional_fields_and_every_enum_value() {
        let uuid = regex::Regex::new(
            r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        .unwrap();
        // Pin the pre-migration enums independently: iterating only the new
        // Rust enum would otherwise miss a variant accidentally lost in porting.
        let baseline: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/activity-contract-enums.json"
        ))
        .unwrap();
        assert_eq!(
            baseline["baselineCommit"],
            "ef8953de1b5d2aa6d719cb0409cb5f48f2b99b42"
        );
        let clients: BTreeSet<_> = ClientType::ALL
            .iter()
            .map(|client| client.as_str())
            .collect();
        let actions: BTreeSet<_> = ActionType::ALL
            .iter()
            .map(|action| action.as_str())
            .collect();
        for client in baseline["clients"].as_array().unwrap() {
            assert!(
                clients.contains(client.as_str().unwrap()),
                "historical ClientType was dropped"
            );
        }
        for action in baseline["actions"].as_array().unwrap() {
            assert!(
                actions.contains(action.as_str().unwrap()),
                "historical ActionType was dropped"
            );
        }
        let mut options = vec![
            json!({"sessionId":"sess-1","userId":"user-1","agentType":"qoder","actionType":"edit","filePath":"/tmp/test.ts"}),
            json!({"sessionId":"sess-2","userId":"user-2","agentType":"qoder-work","actionType":"create","filePath":"/tmp/new-file.ts",
                "content":"const x = 1;","inlineDiffMessage":"+const x = 1;","extra":{"toolName":"write_file","model":"claude-3"}}),
        ];
        for client in ClientType::ALL {
            options.push(json!({"sessionId":"sess","userId":"u","agentType":client.as_str(),"actionType":"edit","filePath":"/f.ts"}));
        }
        for action in ActionType::ALL {
            options.push(json!({"sessionId":"sess","userId":"u","agentType":"qoder","actionType":action.as_str(),"filePath":"/f.ts"}));
        }
        let mut ids = BTreeSet::new();
        for (index, options) in options.iter().enumerate() {
            let entry = serde_json::to_value(build_agent_activity_entry(options)).unwrap();
            assert_eq!(
                schema_report(&entry).hard_issues,
                0,
                "contract scenario {index}"
            );
            let id = entry["event.id"].as_str().unwrap();
            assert!(
                uuid.is_match(id),
                "UUID v4 must retain version and variant bits"
            );
            assert!(ids.insert(id.to_owned()));
            let timestamp = entry["time_unix_nano"].as_str().unwrap();
            assert!(timestamp.bytes().all(|byte| byte.is_ascii_digit()));
            assert!(timestamp.parse::<u128>().unwrap() > 0);
            if index == 1 {
                assert_eq!(entry["agent.content"], "const x = 1;");
                assert_eq!(entry["agent.inline_diff_message"], "+const x = 1;");
            }
        }
        let input = json!({"time_unix_nano":"1700000000000000000","event.id":"agent-input-event","event.name":"agent.input",
            "user.id":"u","gen_ai.session.id":"sess","gen_ai.agent.type":"qoder","gen_ai.provider.name":"qwen"});
        assert_eq!(schema_report(&input).hard_issues, 0);
        assert_eq!(
            normalize_event_name(input.get("event.name")),
            AgentEventName::AgentInput
        );
        assert_eq!(input["event.name"], "agent.input");
    }

    #[test]
    fn main_activity_standard_events_preserve_child_and_delegation_identity() {
        for event in [
            "gen_ai.model.request",
            "gen_ai.model.response",
            "gen_ai.tool.call",
            "gen_ai.tool.result",
            "gen_ai.agent.invoke",
            "gen_ai.agent.result",
        ] {
            let options = json!({
                "event.name": event,
                "gen_ai.session.id": "child-session",
                "gen_ai.turn.id": "child-turn",
                "gen_ai.step.id": "child-step",
                "gen_ai.agent.type": ClientType::CodexCliHook.as_str(),
                "gen_ai.agent.id": "child-agent",
                "gen_ai.agent.parent.id": "parent-agent",
                "gen_ai.agent.peer.id": "grandchild-agent",
                "gen_ai.agent.invocation.id": "outgoing",
                "gen_ai.agent.parent.invocation.id": "incoming"
            });
            let entry = serde_json::to_value(build_agent_activity_entry(&options)).unwrap();
            // The original contract checks the entry schema, which permits
            // empty user IDs and omits optional tool fields. The operational
            // JSONL validator additionally requires complete tool/audit records.
            assert!(types(&entry).is_empty(), "{event}");
            assert!(EVENTS.contains(&entry["event.name"].as_str().unwrap()));
            assert!(entry["time_unix_nano"]
                .as_str()
                .is_some_and(|s| { !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) }));
            assert!(entry["event.id"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(entry["user.id"].is_string());
            assert!(entry["gen_ai.session.id"].is_string());
            for key in ["gen_ai.agent.type", "gen_ai.provider.name"] {
                assert!(entry[key].as_str().is_some_and(|s| !s.is_empty()));
            }
            serde_json::from_value::<loongsuite_pilot::types::AgentActivityEntry>(entry.clone())
                .unwrap();
            for (key, value) in options.as_object().unwrap() {
                assert_eq!(&entry[key], value, "{event}: {key}");
            }
        }
    }

    #[test]
    fn activity_contract_rejects_missing_required_fields_invalid_event_names_and_non_numeric_time()
    {
        let minimal = json!({"time_unix_nano":"1700000000000000000","event.id":"event-1","event.name":"other",
            "user.id":"u","gen_ai.session.id":"sess","gen_ai.agent.type":"qoder","gen_ai.provider.name":"qwen"});
        let missing = schema_report(&json!({"sessionId":"sess"}));
        assert!(missing.issue_counts["missing_required"] > 0);
        let mut invalid = minimal.clone();
        invalid["event.name"] = json!("invalid-action");
        assert!(schema_report(&invalid).issue_counts["bad_event_name"] > 0);
        let mut non_numeric = minimal;
        non_numeric["time_unix_nano"] = json!("not-a-time");
        let report = schema_report(&non_numeric);
        assert!(report.issue_counts["type_error"] > 0);
        assert!(report
            .samples
            .iter()
            .any(|sample| sample.fields.contains(&"time_unix_nano")));
    }
}
