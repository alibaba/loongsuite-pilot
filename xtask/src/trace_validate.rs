//! 原生 Trace 校验入口：保留规则 ID、级别与报告字段，纳秒运算不经过浮点数。
mod messages;
mod semantics;

#[cfg(test)]
mod delegated_history_tests;

use anyhow::{ensure, Context, Result};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};

const KINDS: &[&str] = &[
    "ENTRY",
    "AGENT",
    "STEP",
    "LLM",
    "TOOL",
    "CHAIN",
    "RETRIEVER",
    "RERANKER",
    "EMBEDDING",
    "TASK",
];
const TOKENS: &[&str] = &[
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
];
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE: u64 = 16 * 1024 * 1024;

#[derive(Args)]
pub struct Options {
    #[arg(
        long,
        short = 'i',
        required_unless_present = "latest",
        conflicts_with = "latest"
    )]
    input: Option<PathBuf>,
    #[arg(long)]
    latest: bool,
    #[arg(long, short = 'r')]
    rules: Option<PathBuf>,
    #[arg(long, short = 'f', value_enum, default_value = "text")]
    format: Format,
    #[arg(long, short = 'o')]
    output: Option<PathBuf>,
    #[arg(long)]
    trace_id: Option<String>,
    #[arg(long, value_enum, default_value = "warn")]
    severity: Severity,
}
#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Text,
    Json,
    Summary,
}
#[derive(Clone, Copy, ValueEnum)]
enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span {
    #[serde(default)]
    trace_id: String,
    #[serde(default)]
    span_id: String,
    #[serde(default)]
    parent_span_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    start_time_unix_nano: Value,
    #[serde(default)]
    end_time_unix_nano: Value,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    resource: Value,
}
impl Span {
    fn kind(&self) -> &str {
        self.attributes["gen_ai.span.kind"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("UNKNOWN")
    }
    fn start(&self) -> Option<u128> {
        nanos(&self.start_time_unix_nano)
    }
    fn end(&self) -> Option<u128> {
        nanos(&self.end_time_unix_nano)
    }
}
fn nanos(value: &Value) -> Option<u128> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
}
fn present(value: &Value) -> bool {
    !value.is_null() && value.as_str() != Some("")
}
fn truthy(value: &Value) -> bool {
    present(value) && value != false && value.as_f64() != Some(0.0)
}
fn integer(value: &Value) -> Option<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_name: Option<String>,
}
impl Check {
    fn new(id: &str, status: &'static str, detail: String, span: Option<&Span>) -> Self {
        Self {
            id: id.into(),
            status,
            detail,
            span_id: span.map(|s| s.span_id.clone()),
            span_name: span.map(|s| s.name.clone()),
        }
    }
    fn pass(id: &str) -> Self {
        Self::new(id, "pass", String::new(), None)
    }
    fn skipped(id: &str) -> Self {
        Self::new(id, "skipped", "未观察到消息正文".into(), None)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    key: String,
    #[serde(default)]
    expected_value: Option<Value>,
    #[serde(default, rename = "type")]
    value_type: Option<String>,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    requires_message_content: bool,
}
#[derive(Deserialize)]
struct AttributeRules {
    must: Vec<Definition>,
    should: Vec<Definition>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KindRules {
    attributes: AttributeRules,
    #[serde(default)]
    name_pattern: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    version: String,
    common_attributes: AttributeRules,
    resource_attributes: AttributeRules,
    span_kinds: BTreeMap<String, KindRules>,
    time_rules: Vec<Value>,
    #[serde(default)]
    operation_kind_mapping: BTreeMap<String, String>,
}

struct Trace<'a> {
    spans: Vec<&'a Span>,
    by_id: BTreeMap<&'a str, &'a Span>,
    children: BTreeMap<&'a str, Vec<&'a Span>>,
    has_content: bool,
}
impl<'a> Trace<'a> {
    fn new(spans: Vec<&'a Span>) -> Self {
        let by_id: BTreeMap<_, _> = spans.iter().map(|s| (s.span_id.as_str(), *s)).collect();
        let mut children: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for span in &spans {
            if let Some(parent) = span
                .parent_span_id
                .as_deref()
                .filter(|p| by_id.contains_key(p))
            {
                children.entry(parent).or_default().push(*span);
            }
        }
        // 已出现但类型损坏的字段仍须校验，不能把 false/0/空串当作未采集正文。
        let has_content = spans.iter().any(|s| {
            !s.attributes["gen_ai.input.messages"].is_null()
                || !s.attributes["gen_ai.output.messages"].is_null()
        });
        Self {
            spans,
            by_id,
            children,
            has_content,
        }
    }
    fn kind(&self, kind: &str) -> Vec<&'a Span> {
        self.spans
            .iter()
            .copied()
            .filter(|s| s.kind() == kind)
            .collect()
    }
    fn children(&self, span: &Span) -> &[&'a Span] {
        self.children
            .get(span.span_id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    fn external_delegation(&self, span: &Span) -> bool {
        span.kind() == "AGENT"
            && span.parent_span_id.as_deref().is_some_and(|id| {
                id.len() == 16
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    && id.bytes().any(|b| b != b'0')
                    && !self.by_id.contains_key(id)
            })
            && (truthy(&span.attributes["gen_ai.agent.parent.invocation.id"])
                || truthy(&span.attributes["gen_ai.subagent.parent_tool_call.id"]))
    }
    fn execution(&self, agent: &'a Span) -> Vec<&'a Span> {
        let mut pending = vec![agent];
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some(span) = pending.pop() {
            if seen.insert(span.span_id.as_str()) {
                result.push(span);
                pending.extend(
                    self.children(span)
                        .iter()
                        .copied()
                        .filter(|child| child.kind() != "AGENT"),
                );
            }
        }
        result
    }
    fn parent(&self, span: &Span) -> Option<&'a Span> {
        span.parent_span_id
            .as_deref()
            .and_then(|id| self.by_id.get(id).copied())
    }
}

fn structure(trace: &Trace<'_>) -> Vec<Check> {
    let mut checks = Vec::new();
    let entries = trace.kind("ENTRY");
    let agents = trace.kind("AGENT");
    let external: Vec<_> = agents
        .iter()
        .copied()
        .filter(|s| trace.external_delegation(s))
        .collect();
    checks.push(
        if entries.len() == 1 || (entries.is_empty() && !external.is_empty()) {
            Check::pass("structure.single_entry")
        } else {
            Check::new(
                "structure.single_entry",
                "error",
                "必须有一个 ENTRY 或明确的外部派工片段".into(),
                None,
            )
        },
    );
    checks.push(
        if !agents.is_empty()
            && entries.iter().all(|entry| {
                trace
                    .children(entry)
                    .iter()
                    .filter(|s| s.kind() == "AGENT")
                    .count()
                    == 1
            })
        {
            Check::pass("structure.single_agent")
        } else {
            Check::new(
                "structure.single_agent",
                "error",
                "每个 ENTRY 必须有一个根 AGENT，可包含独立派工 AGENT".into(),
                None,
            )
        },
    );
    if entries.len() == 1 {
        let entry = entries[0];
        checks.push(if trace.parent(entry).is_none() {
            Check::pass("structure.entry_is_root")
        } else {
            Check::new(
                "structure.entry_is_root",
                "error",
                "ENTRY 在本 Trace 中存在父节点".into(),
                Some(entry),
            )
        });
    }
    if entries.len() == 1 || !external.is_empty() {
        let mut pending = entries.clone();
        pending.extend_from_slice(&external);
        let mut seen = BTreeSet::new();
        while let Some(span) = pending.pop() {
            if seen.insert(&span.span_id) {
                pending.extend_from_slice(trace.children(span));
            }
        }
        checks.push(if seen.len() == trace.spans.len() {
            Check::pass("structure.no_orphan_spans")
        } else {
            Check::new(
                "structure.no_orphan_spans",
                "error",
                "存在孤立或重复 Span".into(),
                None,
            )
        });
    }
    for agent in agents {
        checks.push(
            if trace
                .parent(agent)
                .is_some_and(|p| matches!(p.kind(), "ENTRY" | "TOOL"))
                || trace.external_delegation(agent)
            {
                Check::pass("structure.agent_under_entry")
            } else {
                Check::new(
                    "structure.agent_under_entry",
                    "error",
                    "AGENT 必须属于 ENTRY、派工 TOOL 或明确的外部派工上下文".into(),
                    Some(agent),
                )
            },
        );
        if trace.external_delegation(agent) {
            checks.push(Check::new(
                "structure.external_parent_context",
                "warn",
                "派工父节点在本地 Trace 片段之外".into(),
                Some(agent),
            ));
        }
    }
    for (kind, parent, id) in [
        ("STEP", "AGENT", "structure.step_under_agent"),
        ("LLM", "STEP", "structure.llm_under_step"),
        ("TOOL", "STEP", "structure.tool_under_step"),
    ] {
        let spans = trace.kind(kind);
        let mut valid = true;
        for span in &spans {
            if trace.parent(span).map(Span::kind) != Some(parent) {
                valid = false;
                checks.push(Check::new(
                    id,
                    "error",
                    format!("{kind} 父节点必须为 {parent}"),
                    Some(span),
                ));
            }
        }
        if valid && (!spans.is_empty() || kind == "TOOL") {
            checks.push(Check::pass(id));
        }
    }
    let steps = trace.kind("STEP");
    let mut one_llm = true;
    let mut order = true;
    for step in &steps {
        let children = trace.children(step);
        let llms: Vec<_> = children.iter().filter(|s| s.kind() == "LLM").collect();
        if llms.len() != 1 {
            one_llm = false;
            checks.push(Check::new(
                "structure.step_has_one_llm",
                "error",
                format!("STEP 包含 {} 个 LLM，应为 1", llms.len()),
                Some(step),
            ));
        }
        if let Some(llm) = llms.first() {
            for tool in children.iter().filter(|s| s.kind() == "TOOL") {
                if llm.start().zip(tool.start()).is_some_and(|(l, t)| t < l) {
                    order = false;
                    checks.push(Check::new(
                        "structure.llm_before_tools",
                        "error",
                        "TOOL 早于 LLM 开始".into(),
                        Some(tool),
                    ));
                }
            }
        }
    }
    if !steps.is_empty() {
        if one_llm {
            checks.push(Check::pass("structure.step_has_one_llm"));
        }
        if order {
            checks.push(Check::pass("structure.llm_before_tools"));
        }
    }
    checks
}

fn attributes(trace: &Trace<'_>, rules: &Rules) -> Vec<Check> {
    let mut checks = Vec::new();
    for span in &trace.spans {
        for (level, definitions) in [
            ("must", &rules.common_attributes.must),
            ("should", &rules.common_attributes.should),
        ] {
            for definition in definitions {
                if !present(&span.attributes[&definition.key]) {
                    checks.push(Check::new(
                        &format!("attr.common.{level}.{}", definition.key),
                        if level == "must" { "error" } else { "warn" },
                        format!("缺少 {}", definition.key),
                        Some(span),
                    ));
                }
            }
        }
        if let Some(kind) = rules.span_kinds.get(span.kind()) {
            for (level, definitions) in [
                ("must", &kind.attributes.must),
                ("should", &kind.attributes.should),
            ] {
                for definition in definitions {
                    let short = definition.key.rsplit('.').next().unwrap_or(&definition.key);
                    let id = format!("attr.{}.{level}.{short}", span.kind());
                    if level == "should"
                        && definition.requires_message_content
                        && !trace.has_content
                    {
                        checks.push(Check::skipped(&id));
                        continue;
                    }
                    let value = &span.attributes[&definition.key];
                    let expected_bad = definition
                        .expected_value
                        .as_ref()
                        .is_some_and(|expected| expected != value);
                    let integer_bad = level == "should"
                        && definition.value_type.as_deref() == Some("integer")
                        && (integer(value).is_none()
                            || definition
                                .min
                                .zip(value.as_f64())
                                .is_some_and(|(min, n)| n < min));
                    if value.is_null() || expected_bad || integer_bad {
                        checks.push(Check::new(
                            &id,
                            if level == "must" { "error" } else { "warn" },
                            format!("{} 缺失或不符合规则", definition.key),
                            Some(span),
                        ));
                    }
                }
            }
        }
        for (level, definitions) in [
            ("must", &rules.resource_attributes.must),
            ("should", &rules.resource_attributes.should),
        ] {
            for definition in definitions {
                let value = &span.resource[&definition.key];
                if !truthy(value)
                    || (level == "should"
                        && definition
                            .expected_value
                            .as_ref()
                            .is_some_and(|expected| truthy(expected) && expected != value))
                {
                    checks.push(Check::new(
                        &format!(
                            "attr.resource.{level}.{}",
                            definition.key.rsplit('.').next().unwrap_or(&definition.key)
                        ),
                        if level == "must" { "error" } else { "warn" },
                        format!("resource {} 缺失或不符合规则", definition.key),
                        Some(span),
                    ));
                }
            }
        }
    }
    checks
}

fn timing(trace: &Trace<'_>, rules: &Rules) -> Vec<Check> {
    let mut checks = Vec::new();
    let mut valid = true;
    let mut contained = true;
    let mut reasonable = true;
    let max_ms = rules
        .time_rules
        .iter()
        .find(|r| r["id"] == "time.reasonable_duration")
        .and_then(|r| r["maxMs"].as_u64())
        .filter(|n| *n > 0)
        .unwrap_or(600_000);
    for span in &trace.spans {
        let Some((start, end)) = span.start().zip(span.end()) else {
            valid = false;
            checks.push(Check::new(
                "schema.timestamp_format",
                "error",
                "纳秒时间必须为无符号整数字符串且不溢出".into(),
                Some(span),
            ));
            continue;
        };
        if end <= start {
            valid = false;
            checks.push(Check::new(
                "time.non_zero_duration",
                "error",
                "结束时间必须晚于开始时间".into(),
                Some(span),
            ));
        }
        if span.kind() == "LLM" && end.saturating_sub(start) > u128::from(max_ms) * 1_000_000 {
            reasonable = false;
            checks.push(Check::new(
                "time.reasonable_duration",
                "warn",
                format!("LLM 时长超过 {max_ms}ms"),
                Some(span),
            ));
        }
        for child in trace.children(span) {
            if child.start().zip(child.end()).is_some_and(|(a, b)| {
                a < start || (b > end && !(span.kind() == "TOOL" && child.kind() == "AGENT"))
            }) {
                contained = false;
                checks.push(Check::new(
                    "time.parent_contains_children",
                    "error",
                    "子节点时间超出父节点".into(),
                    Some(child),
                ));
            }
        }
    }
    if valid {
        checks.push(Check::pass("time.non_zero_duration"));
    }
    if contained {
        checks.push(Check::pass("time.parent_contains_children"));
    }
    if reasonable {
        checks.push(Check::pass("time.reasonable_duration"));
    }
    let mut overlap = false;
    let mut chronological = true;
    for agent in trace.kind("AGENT") {
        let mut steps: Vec<_> = trace
            .children(agent)
            .iter()
            .copied()
            .filter(|s| s.kind() == "STEP")
            .collect();
        steps.sort_by_key(|s| s.start());
        for pair in steps.windows(2) {
            if pair[0]
                .end()
                .zip(pair[1].start())
                .is_some_and(|(a, b)| a > b)
            {
                overlap = true;
                checks.push(Check::new(
                    "time.no_step_overlap",
                    "error",
                    "同一 AGENT 的相邻 STEP 时间重叠".into(),
                    Some(pair[0]),
                ));
            }
        }
        let rounds: Vec<_> = steps
            .iter()
            .filter_map(|s| s.attributes["gen_ai.react.round"].as_f64())
            .collect();
        if rounds.windows(2).any(|p| p[0] >= p[1]) {
            chronological = false;
            checks.push(Check::new(
                "time.chronological_steps",
                "warn",
                "同一 AGENT 的 STEP round 未随时间递增".into(),
                Some(agent),
            ));
        }
    }
    if !overlap {
        checks.push(Check::pass("time.no_step_overlap"));
    }
    if chronological {
        checks.push(Check::pass("time.chronological_steps"));
    }
    checks
}

fn schema(trace: &Trace<'_>) -> Vec<Check> {
    let mut checks = Vec::new();
    let mut seen = BTreeSet::new();
    for span in &trace.spans {
        if !seen.insert(&span.span_id) {
            checks.push(Check::new(
                "schema.duplicate_span_id",
                "error",
                "Span ID 重复".into(),
                Some(span),
            ));
        }
    }
    for (id, key, len) in [
        ("schema.trace_id_format", true, 32),
        ("schema.span_id_format", false, 16),
    ] {
        let mut valid = true;
        for span in &trace.spans {
            let text = if key { &span.trace_id } else { &span.span_id };
            if text.len() != len
                || !text
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || text.bytes().all(|b| b == b'0')
            {
                valid = false;
                checks.push(Check::new(
                    id,
                    "error",
                    "ID 必须为非零小写十六进制且长度正确".into(),
                    Some(span),
                ));
            }
        }
        if valid {
            checks.push(Check::pass(id));
        }
    }
    let mut kinds = true;
    let mut tokens = true;
    let mut sums = true;
    for span in &trace.spans {
        if span.kind() != "UNKNOWN" && !KINDS.contains(&span.kind()) {
            kinds = false;
            checks.push(Check::new(
                "schema.span_kind_enum",
                "error",
                "未知 Span kind".into(),
                Some(span),
            ));
        }
        for key in TOKENS {
            if !span.attributes[*key].is_null()
                && integer(&span.attributes[*key]).is_none_or(|n| n < 0)
            {
                tokens = false;
                checks.push(Check::new(
                    "schema.tokens_positive",
                    "error",
                    format!("{key} 必须为非负整数"),
                    Some(span),
                ));
            }
        }
        if let (Some(input), Some(output), Some(total)) = (
            integer(&span.attributes[TOKENS[0]]),
            integer(&span.attributes[TOKENS[1]]),
            integer(&span.attributes[TOKENS[2]]),
        ) {
            if input + output != total {
                sums = false;
                checks.push(Check::new(
                    "schema.tokens_sum",
                    "error",
                    "total_tokens 不等于 input_tokens + output_tokens".into(),
                    Some(span),
                ));
            }
        }
        let reasons = &span.attributes["gen_ai.response.finish_reasons"];
        if !reasons.is_null()
            && !messages::parsed(reasons)
                .is_some_and(|v| v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
        {
            checks.push(Check::new(
                "schema.finish_reasons",
                "warn",
                "finish_reasons 必须为 string array".into(),
                Some(span),
            ));
        }
        if trace.has_content {
            checks.extend(messages::validate(
                span,
                "gen_ai.input.messages",
                "schema.input_messages",
            ));
            checks.extend(messages::validate(
                span,
                "gen_ai.output.messages",
                "schema.output_messages",
            ));
        }
    }
    for (valid, id) in [
        (kinds, "schema.span_kind_enum"),
        (tokens, "schema.tokens_positive"),
        (sums, "schema.tokens_sum"),
    ] {
        if valid {
            checks.push(Check::pass(id));
        }
    }
    if !trace.has_content {
        checks.extend([
            Check::skipped("schema.input_messages"),
            Check::skipped("schema.output_messages"),
        ]);
    }
    checks
}

fn load_input(path: &Path) -> Result<Vec<Span>> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Trace 输入必须是普通文件"
    );
    let mut reader = BufReader::new(File::open(path)?);
    let mut spans = Vec::new();
    let mut bytes = 0;
    loop {
        let mut line = Vec::new();
        let length = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut line)?;
        if length == 0 {
            break;
        }
        bytes += length as u64;
        ensure!(
            length as u64 <= MAX_LINE && bytes <= MAX_BYTES,
            "Trace 输入超过资源上限"
        );
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: Value =
            serde_json::from_slice(&line).map_err(|_| anyhow::anyhow!("Trace 包含无效 JSON 行"))?;
        // 失败落盘不能成为成功证据，也不静默跳过坏行。
        ensure!(
            value.is_object() && !truthy(&value["_error"]),
            "Trace 包含失败记录或非对象行"
        );
        let span: Span = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("Trace Span 字段类型无效"))?;
        ensure!(
            span.attributes.is_null() || span.attributes.is_object(),
            "Span attributes 必须是 object"
        );
        ensure!(
            span.resource.is_null() || span.resource.is_object(),
            "Span resource 必须是 object"
        );
        spans.push(span);
    }
    ensure!(!spans.is_empty(), "Trace 输入为空");
    Ok(spans)
}
fn latest() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("HOME/USERPROFILE 缺失")?;
    let directory = Path::new(&home).join(".loongsuite-pilot/logs/otlp-debug");
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).context("无法读取 otlp-debug 目录")? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|e| e == "jsonl") {
            files.push((entry.metadata()?.modified()?, entry.path()));
        }
    }
    files.sort();
    files
        .pop()
        .map(|(_, path)| path)
        .context("otlp-debug 中没有 .jsonl 文件")
}

fn report(spans: &[Span], input: &Path, rules: &Rules, options: &Options) -> Result<Value> {
    let mut grouped: BTreeMap<&str, Vec<&Span>> = BTreeMap::new();
    for span in spans {
        if options
            .trace_id
            .as_deref()
            .is_none_or(|id| span.trace_id == id)
        {
            grouped.entry(&span.trace_id).or_default().push(span);
        }
    }
    ensure!(!grouped.is_empty(), "未找到符合过滤条件的 Trace");
    let mut reports = Vec::new();
    let mut totals = BTreeMap::from([
        ("total", 0),
        ("pass", 0),
        ("warn", 0),
        ("error", 0),
        ("skipped", 0),
    ]);
    let mut total_spans = 0;
    let mut has_content = false;
    for (id, spans) in grouped {
        let trace = Trace::new(spans);
        let mut checks = structure(&trace);
        checks.extend(attributes(&trace, rules));
        checks.extend(timing(&trace, rules));
        checks.extend(schema(&trace));
        checks.extend(semantics::validate(&trace, rules));
        let mut seen = BTreeSet::new();
        checks.retain(|c| {
            if c.status == "warn" && matches!(options.severity, Severity::Error) {
                return false;
            }
            seen.insert((
                c.id.clone(),
                if c.status == "pass" {
                    None
                } else {
                    c.span_id.clone()
                },
                c.status,
            ))
        });
        let failed = checks.iter().any(|c| c.status == "error");
        for check in &checks {
            *totals.get_mut("total").unwrap() += 1;
            *totals.get_mut(check.status).unwrap() += 1;
        }
        let counts = json!({"entry":trace.kind("ENTRY").len(),"agent":trace.kind("AGENT").len(),"steps":trace.kind("STEP").len(),"llms":trace.kind("LLM").len(),"tools":trace.kind("TOOL").len(),"other":trace.spans.iter().filter(|s| !["ENTRY","AGENT","STEP","LLM","TOOL"].contains(&s.kind())).count()});
        total_spans += trace.spans.len();
        has_content |= trace.has_content;
        reports.push(json!({"traceId":id,"agent":trace.kind("AGENT").first().and_then(|s| s.attributes["gen_ai.agent.name"].as_str()).unwrap_or("unknown"),"spans":trace.spans.len(),"structure":counts,"verdict":if failed {"FAIL"} else {"PASS"},"checks":checks}));
    }
    Ok(
        json!({"meta":{"tool":"validate-trace","version":rules.version,"rulesVersion":rules.version,"timestamp":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"input":input.file_name().unwrap_or_default().to_string_lossy(),"captureMessageContent":has_content},"summary":{"traces":reports.len(),"spans":total_spans,"checks":totals,"verdict":if totals["error"] > 0 {"FAIL"} else {"PASS"}},"traces":reports}),
    )
}
fn summary(report: &Value) -> String {
    let s = &report["summary"];
    format!(
        "{} traces, {} spans, {} errors, {} warnings, {} skipped\n",
        s["traces"], s["spans"], s["checks"]["error"], s["checks"]["warn"], s["checks"]["skipped"]
    )
}
fn render(report: &Value) -> String {
    let mut text = String::from("GenAI Trace 校验报告\n");
    use std::fmt::Write;
    for trace in report["traces"].as_array().unwrap() {
        let _ = writeln!(
            text,
            "Trace {}: {}",
            trace["traceId"].as_str().unwrap(),
            trace["verdict"].as_str().unwrap()
        );
        for check in trace["checks"].as_array().unwrap() {
            let _ = writeln!(
                text,
                "  [{}] {} {}",
                check["status"].as_str().unwrap(),
                check["id"].as_str().unwrap(),
                check["detail"].as_str().unwrap_or("")
            );
        }
    }
    text.push_str(&summary(report));
    text
}
pub fn run(root: &Path, options: Options) -> u8 {
    let result = (|| -> Result<u8> {
        let input = match &options.input {
            Some(path) => path.clone(),
            None => latest()?,
        };
        let rules_path = options
            .rules
            .clone()
            .unwrap_or_else(|| root.join("docs/trace-validation-rules.json"));
        ensure!(
            fs::symlink_metadata(&rules_path)
                .context("规则缺失；先运行 update-validation-rules 或指定 --rules")?
                .is_file(),
            "规则必须为普通文件"
        );
        let mut bytes = Vec::new();
        File::open(&rules_path)?
            .take(MAX_LINE + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 <= MAX_LINE, "规则文件过大");
        let rules: Rules = serde_json::from_slice(&bytes).context("规则结构无效")?;
        ensure!(
            !rules.version.is_empty() && !rules.span_kinds.is_empty(),
            "规则版本及 Span 定义不能为空"
        );
        let spans = load_input(&input)?;
        let report = report(&spans, &input, &rules, &options)?;
        let output = match options.format {
            Format::Json => format!("{}\n", serde_json::to_string_pretty(&report)?),
            Format::Summary => summary(&report),
            Format::Text => render(&report),
        };
        if let Some(path) = &options.output {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let canonical = |p: &Path| fs::canonicalize(p).ok();
            ensure!(
                canonical(path).is_none_or(|out| Some(out.clone()) != canonical(&input)
                    && Some(out) != canonical(&rules_path)),
                "报告不能覆盖输入或规则"
            );
            ensure!(
                !fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()),
                "报告目标不能是链接或目录"
            );
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            temp.write_all(output.as_bytes())?;
            temp.as_file().sync_all()?;
            temp.persist(path).map_err(|e| e.error)?;
        } else {
            std::io::stdout().lock().write_all(output.as_bytes())?;
        }
        Ok(u8::from(report["summary"]["verdict"] == "FAIL"))
    })();
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("[validate-trace] {error}");
            2
        }
    }
}
