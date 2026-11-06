//! 字段填充率工具：保留旧脚本的字段、分组、舍入与报告结构；严格模式用于验收门禁。

use anyhow::{ensure, Context, Result};
use clap::{Args, ValueEnum};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};

const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
const SPECS: &[(&str, &[(&str, &str)])] = &[
    (
        "llm.request",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.turn.id", "turn.id"),
            ("gen_ai.step.id", "step.id"),
            ("gen_ai.provider.name", "provider"),
            ("gen_ai.request.model", "request.model"),
            ("gen_ai.input.messages_delta", "input.msg_delta"),
        ],
    ),
    (
        "llm.response",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.step.id", "step.id"),
            ("gen_ai.response.id", "response.id"),
            ("gen_ai.response.model", "response.model"),
            ("gen_ai.response.finish_reasons", "finish_reasons"),
            ("gen_ai.usage.input_tokens", "input_tokens"),
            ("gen_ai.usage.output_tokens", "output_tokens"),
            ("gen_ai.output.messages", "output.msg"),
        ],
    ),
    (
        "tool.call",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.step.id", "step.id"),
            ("gen_ai.tool.name", "tool.name"),
            ("gen_ai.tool.call.id", "tool.call.id"),
            ("gen_ai.tool.call.arguments", "tool.call.args"),
        ],
    ),
    (
        "tool.result",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.step.id", "step.id"),
            ("gen_ai.tool.name", "tool.name"),
            ("gen_ai.tool.call.id", "tool.call.id"),
            ("gen_ai.tool.call.duration", "tool.call.dur"),
        ],
    ),
    (
        "gen_ai.agent.invoke",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.turn.id", "turn.id"),
            ("gen_ai.agent.invocation.id", "invocation.id"),
        ],
    ),
    (
        "gen_ai.agent.result",
        &[
            ("event.id", "event.id"),
            ("user.id", "user.id"),
            ("gen_ai.session.id", "session.id"),
            ("gen_ai.turn.id", "turn.id"),
            ("gen_ai.agent.invocation.id", "invocation.id"),
        ],
    ),
];

#[derive(Args)]
pub struct Options {
    /// 逗号分隔的 Agent 文件名前缀。
    #[arg(long, short = 'a')]
    agents: String,
    #[arg(long, short = 'd')]
    date: Option<String>,
    #[arg(long, short = 't', default_value = "90", value_parser = threshold)]
    threshold: f64,
    #[arg(long, short = 'f', value_enum, default_value = "text")]
    format: Format,
    #[arg(long, short = 'o')]
    output: Option<PathBuf>,
    /// 默认读取 ~/.loongsuite-pilot/logs/output；可显式指定隔离的输入目录。
    #[arg(long)]
    input_dir: Option<PathBuf>,
    /// 缺文件、坏 JSON、非对象和每个输入无相关事件均使验收失败。
    #[arg(long)]
    strict: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Text,
    Json,
}

fn threshold(raw: &str) -> std::result::Result<f64, String> {
    let number: f64 = raw.parse().map_err(|_| "阈值必须是 0 到 100 的有限数值")?;
    if !number.is_finite() || !(0.0..=100.0).contains(&number) {
        return Err("阈值必须是 0 到 100 的有限数值".into());
    }
    Ok(number)
}

#[derive(Serialize)]
struct Report {
    threshold: f64,
    tables: Vec<Table>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    event_name: &'static str,
    rows: Vec<Row>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    agent_type: String,
    total: u64,
    avg: f64,
    fields: Vec<Field>,
}
#[derive(Serialize)]
struct Field {
    label: &'static str,
    key: &'static str,
    pct: f64,
    pass: bool,
}

struct Bucket {
    agent: String,
    total: u64,
    filled: Vec<u64>,
}
type Stats = Vec<Vec<Bucket>>;

// 旧脚本使用 String(value)，空数组与 [null] 不算填充，0/false/空对象算填充。
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}

fn is_filled(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        if value.is_null() {
            return false;
        }
        let text = js_string(value);
        !text.is_empty() && text != "null"
    })
}

fn add_entry(stats: &mut Stats, entry: &Value) -> bool {
    let event_name = match entry["event.name"].as_str().unwrap_or("") {
        "gen_ai.model.request" => "llm.request",
        "gen_ai.model.response" => "llm.response",
        "gen_ai.tool.call" => "tool.call",
        "gen_ai.tool.result" => "tool.result",
        name => name,
    };
    let Some(index) = SPECS.iter().position(|(event, _)| event_name == *event) else {
        return false;
    };
    let agent = match entry.get("gen_ai.agent.type") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => "unknown".into(),
        Some(Value::String(text)) if text.is_empty() => "unknown".into(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => "unknown".into(),
        Some(value) => js_string(value),
    };
    let fields = SPECS[index].1;
    let buckets = &mut stats[index];
    let at = buckets
        .iter()
        .position(|bucket| bucket.agent == agent)
        .unwrap_or_else(|| {
            buckets.push(Bucket {
                agent,
                total: 0,
                filled: vec![0; fields.len()],
            });
            buckets.len() - 1
        });
    let bucket = &mut buckets[at];
    bucket.total += 1;
    for (i, (key, _)) in fields.iter().enumerate() {
        if is_filled(entry.get(*key)) {
            bucket.filled[i] += 1;
        }
    }
    true
}

fn collect_file(stats: &mut Stats, path: &Path, strict: bool) -> Result<()> {
    let file = File::open(path).with_context(|| format!("无法读取 {}", path.display()))?;
    ensure!(
        file.metadata()?.is_file(),
        "输入不是普通文件：{}",
        path.display()
    );
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut relevant = 0;
    let mut invalid = 0;
    let mut number = 0;
    loop {
        line.clear();
        let length = reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_line(&mut line)?;
        if length == 0 {
            break;
        }
        number += 1;
        ensure!(
            length as u64 <= MAX_LINE_BYTES,
            "{}:{number} JSONL 行超过 16 MiB",
            path.display()
        );
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(value) if value.is_object() => {
                if add_entry(stats, &value) {
                    relevant += 1;
                }
            }
            _ => {
                ensure!(!strict, "{}:{number} 不是有效 JSON 对象", path.display());
                invalid += 1;
            }
        }
    }
    if invalid > 0 {
        eprintln!(
            "warning: {} 跳过 {invalid} 行无效记录（门禁请启用 --strict）",
            path.display()
        );
    }
    ensure!(
        !strict || relevant > 0,
        "{} 无相关事件，不能作为字段验收成功",
        path.display()
    );
    Ok(())
}

fn report(stats: Stats, threshold: f64) -> Report {
    let tables = stats
        .into_iter()
        .enumerate()
        .map(|(index, buckets)| {
            let mut rows: Vec<_> = buckets
                .into_iter()
                .map(|bucket| {
                    let fields: Vec<_> = SPECS[index]
                        .1
                        .iter()
                        .enumerate()
                        .map(|(i, (key, label))| {
                            let pct = (bucket.filled[i] as f64 / bucket.total as f64 * 1000.0)
                                .round()
                                / 10.0;
                            Field {
                                key,
                                label,
                                pct,
                                pass: pct >= threshold,
                            }
                        })
                        .collect();
                    let avg = (fields.iter().map(|field| field.pct).sum::<f64>()
                        / fields.len() as f64
                        * 10.0)
                        .round()
                        / 10.0;
                    Row {
                        agent_type: bucket.agent,
                        total: bucket.total,
                        avg,
                        fields,
                    }
                })
                .collect();
            // 稳定排序，同事件数沿用首次遇到顺序。
            rows.sort_by_key(|row| std::cmp::Reverse(row.total));
            Table {
                event_name: SPECS[index].0,
                rows,
            }
        })
        .collect();
    Report { threshold, tables }
}

fn pad(text: &str, width: usize, left: bool) -> String {
    let spaces = " ".repeat(width.saturating_sub(text.encode_utf16().count()));
    if left {
        format!("{spaces}{text}")
    } else {
        format!("{text}{spaces}")
    }
}

fn format_text(report: &Report) -> String {
    let mut lines = Vec::new();
    let mut failures = Vec::new();
    for (index, table) in report.tables.iter().enumerate() {
        if table.rows.is_empty() {
            lines.push(format!("\n═══ {} 填充率 ═══", table.event_name));
            lines.push("  (无数据)".into());
            continue;
        }
        lines.push(format!(
            "\n═══ {} 填充率 (阈值: {}%) ═══\n",
            table.event_name, report.threshold
        ));
        let fields = SPECS[index].1;
        let mut widths = vec![
            table
                .rows
                .iter()
                .map(|row| row.agent_type.encode_utf16().count() + 2)
                .max()
                .unwrap_or(12)
                .max(12),
            6,
            7,
        ];
        widths.extend(fields.iter().map(|(_, label)| (label.len() + 1).max(7)));
        let headers: Vec<_> = ["agent_type", "事件数", "综合(%)"]
            .into_iter()
            .chain(fields.iter().map(|(_, label)| *label))
            .enumerate()
            .map(|(i, text)| pad(text, widths[i], false))
            .collect();
        let header = headers.join(" | ");
        lines.push(format!("  {header}"));
        lines.push(format!("  {}", "-".repeat(header.encode_utf16().count())));
        for row in &table.rows {
            let mut cells = vec![
                pad(&row.agent_type, widths[0], false),
                pad(&row.total.to_string(), widths[1], true),
                pad(&format!("{:.1}", row.avg), widths[2], true),
            ];
            cells.extend(row.fields.iter().enumerate().map(|(i, field)| {
                pad(
                    &format!("{:.1}{}", field.pct, if field.pass { "" } else { "❌" }),
                    widths[i + 3],
                    true,
                )
            }));
            lines.push(format!("  {}", cells.join(" | ")));
            let failing: Vec<_> = row
                .fields
                .iter()
                .filter(|field| !field.pass)
                .map(|field| format!("{}({:.1}%)", field.label, field.pct))
                .collect();
            if !failing.is_empty() {
                failures.push(format!(
                    "  {} / {}: {}",
                    row.agent_type,
                    table.event_name,
                    failing.join(", ")
                ));
            }
        }
    }
    if failures.is_empty() {
        lines.push("\n✅ 所有字段填充率均达标！".into());
    } else {
        lines.push(format!("\n⚠️  未达标字段 (< {}%):\n", report.threshold));
        lines.extend(failures);
    }
    lines.push(String::new());
    lines.join("\n")
}

fn agent_names(raw: &str) -> Result<Vec<&str>> {
    let mut names = Vec::new();
    for name in raw.split(',').map(str::trim) {
        ensure!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "Agent 文件名前缀无效"
        );
        ensure!(!names.contains(&name), "Agent 文件名前缀重复：{name}");
        names.push(name);
    }
    Ok(names)
}

fn execute(options: Options) -> Result<u8> {
    let agents = agent_names(&options.agents)?;
    let date = options
        .date
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let parsed =
        chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").context("日期必须为 YYYY-MM-DD")?;
    ensure!(
        date == parsed.format("%Y-%m-%d").to_string(),
        "日期必须为 YYYY-MM-DD"
    );
    let directory = match options.input_dir {
        Some(path) => path,
        None => {
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .context("未设置用户目录，请指定 --input-dir")?;
            PathBuf::from(home).join(".loongsuite-pilot/logs/output")
        }
    };
    eprintln!(
        "[field-coverage] agents: {} | date: {date} | threshold: {}%",
        agents.join(", "),
        options.threshold
    );
    let mut files = Vec::new();
    for agent in agents {
        let path = directory.join(format!("{agent}-{date}.jsonl"));
        if path.is_file() {
            files.push(path);
        } else {
            ensure!(
                !options.strict,
                "指定输入文件不存在或不是普通文件：{}",
                path.display()
            );
            let mut available: Vec<_> = fs::read_dir(&directory)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                    (name.starts_with(&format!("{agent}-")) && name.ends_with(".jsonl"))
                        .then_some(name)
                })
                .collect();
            available.sort_by(|a, b| b.cmp(a));
            available.truncate(3);
            eprintln!(
                "warning: {} 未找到。可用文件：{}",
                path.display(),
                if available.is_empty() {
                    "none".into()
                } else {
                    available.join(", ")
                }
            );
        }
    }
    ensure!(!files.is_empty(), "未找到有效输入文件");
    if let Some(output) = &options.output {
        if let Ok(output) = fs::canonicalize(output) {
            ensure!(
                !files
                    .iter()
                    .any(|file| fs::canonicalize(file).is_ok_and(|file| file == output)),
                "输出文件不能覆盖输入 JSONL"
            );
        }
    }
    eprintln!("[field-coverage] loaded {} file(s)", files.len());
    let mut stats: Stats = (0..SPECS.len()).map(|_| Vec::new()).collect();
    for path in &files {
        collect_file(&mut stats, path, options.strict)?;
    }
    let report = report(stats, options.threshold);
    let rendered = match options.format {
        Format::Json => serde_json::to_string_pretty(&report)?,
        Format::Text => format_text(&report),
    };
    if let Some(path) = options.output {
        let parent = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(rendered.as_bytes())?;
        temp.as_file().sync_all()?;
        temp.persist(&path)?;
        eprintln!("[field-coverage] report written to {}", path.display());
    } else {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{rendered}")?;
    }
    Ok(u8::from(report.tables.iter().any(|table| {
        table
            .rows
            .iter()
            .any(|row| row.fields.iter().any(|field| !field.pass))
    })))
}

pub fn run(options: Options) -> u8 {
    match execute(options) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("field-coverage: {error:#}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_legacy_string_filling_including_zero_false_and_arrays() {
        for value in [
            Value::Null,
            json!(""),
            json!("null"),
            json!([]),
            json!([null]),
            json!(["null"]),
        ] {
            assert!(!is_filled(Some(&value)), "{value}");
        }
        assert!(!is_filled(None));
        for value in [
            json!(0),
            json!(false),
            json!({}),
            json!(" "),
            json!([0]),
            json!([null, null]),
        ] {
            assert!(is_filled(Some(&value)), "{value}");
        }
    }

    #[test]
    fn groups_by_event_agent_and_keeps_stable_counts_rounding_and_schema() {
        let mut stats: Stats = (0..SPECS.len()).map(|_| Vec::new()).collect();
        for event in SPECS {
            for index in 0..3 {
                let mut entry = json!({"event.name": event.0, "gen_ai.agent.type": "实际 Agent🚀"});
                for (key, _) in event.1 {
                    entry[*key] = if index == 0 { json!(0) } else { Value::Null };
                }
                assert!(add_entry(&mut stats, &entry));
            }
            assert!(add_entry(&mut stats, &json!({"event.name": event.0})));
        }
        assert!(!add_entry(
            &mut stats,
            &json!({"event.name": "session.start"})
        ));
        let result = report(stats, 33.3);
        assert_eq!(result.tables.len(), 6);
        for (index, table) in result.tables.iter().enumerate() {
            assert_eq!(table.event_name, SPECS[index].0);
            assert_eq!(table.rows[0].agent_type, "实际 Agent🚀");
            assert_eq!(table.rows[0].total, 3);
            assert_eq!(table.rows[0].avg, 33.3);
            assert!(table.rows[0]
                .fields
                .iter()
                .all(|field| field.pct == 33.3 && field.pass));
            assert_eq!(table.rows[1].agent_type, "unknown");
            assert!(table.rows[1]
                .fields
                .iter()
                .all(|field| field.pct == 0.0 && !field.pass));
        }
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["tables"][0]["eventName"], "llm.request");
        assert_eq!(json["tables"][0]["rows"][0]["agentType"], "实际 Agent🚀");
        assert_eq!(
            json["tables"][0]["rows"][0]["fields"][0],
            json!({"key":"event.id", "label":"event.id", "pct":33.3, "pass":true})
        );
        assert!(format_text(&result).contains("unknown / llm.request: event.id(0.0%)"));
    }

    #[test]
    fn rejects_invalid_thresholds_dates_and_path_components() {
        for value in ["NaN", "inf", "-1", "101", "x"] {
            assert!(threshold(value).is_err());
        }
        assert_eq!(threshold("0").unwrap(), 0.0);
        assert_eq!(threshold("100").unwrap(), 100.0);
        for names in ["", "a,", "a,a", "../a", "a/b", "a\\b", "C:a"] {
            assert!(agent_names(names).is_err());
        }
        assert_eq!(
            agent_names("cursor, qoder-cli").unwrap(),
            ["cursor", "qoder-cli"]
        );
    }

    #[test]
    fn strict_mode_rejects_bad_records_and_empty_inputs_without_exposing_content() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("events.jsonl");
        for body in [
            "",
            "\n",
            "{\"secret\":broken}",
            "[]",
            "null",
            "{\"event.name\":\"session.start\"}",
        ] {
            fs::write(&file, body).unwrap();
            let mut stats: Stats = (0..SPECS.len()).map(|_| Vec::new()).collect();
            let error = collect_file(&mut stats, &file, true)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("secret"));
            assert!(collect_file(&mut stats, &file, false).is_ok());
        }
        fs::write(&file, "\r\n{\"event.name\":\"tool.call\"}\r\n").unwrap();
        let mut stats: Stats = (0..SPECS.len()).map(|_| Vec::new()).collect();
        collect_file(&mut stats, &file, true).unwrap();
        assert_eq!(report(stats, 90.0).tables[2].rows[0].total, 1);
    }
}
