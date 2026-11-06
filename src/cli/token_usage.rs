//! Port of `src/cli/token-usage.ts`.
//!
//! Column positions and compact numbers follow the TypeScript renderer so a
//! plain or colored snapshot lines up the same way.

use crate::utils::{is_process_alive, read_json_file, resolve_home};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricsRange {
    Today,
    SevenDays,
    ThirtyDays,
}

impl MetricsRange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::SevenDays => "sevenDays",
            Self::ThirtyDays => "thirtyDays",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Today => "Today",
            Self::SevenDays => "Last 7 days",
            Self::ThirtyDays => "Last 30 days",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TokenUsageOptions {
    pub range: MetricsRange,
    pub data_dir: Option<String>,
    pub color: bool,
    pub help: bool,
}

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub options: TokenUsageOptions,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TokenUsageViewData {
    pub data_dir: String,
    pub summary_path: String,
    pub runtime_path: String,
    pub summary: Option<Value>,
    pub runtime: Option<Value>,
    pub runtime_alive: bool,
    pub summary_error: Option<String>,
    pub runtime_error: Option<String>,
    pub now: String,
}

const TABLE_NAME_WIDTH: usize = 26;
const TABLE_VALUE_WIDTH: usize = 8;
const TABLE_METRIC_WIDTH: usize = 6;
const TABLE_META_WIDTH: usize = 4;
const TABLE_BAR_WIDTH: usize = 24;

pub fn parse_token_usage_args(
    args: &[String],
    env: &HashMap<String, String>,
    is_tty: bool,
) -> ParseResult {
    let mut options = TokenUsageOptions {
        range: MetricsRange::Today,
        data_dir: None,
        color: is_tty && !env.contains_key("NO_COLOR"),
        help: false,
    };
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--help" || arg == "-h" || arg == "help" {
            options.help = true;
        } else if arg == "--once" {
        } else if arg == "--no-color" {
            options.color = false;
        } else if arg == "--today" {
            options.range = MetricsRange::Today;
        } else if arg == "--7d" || arg == "--seven-days" {
            options.range = MetricsRange::SevenDays;
        } else if arg == "--30d" || arg == "--thirty-days" {
            options.range = MetricsRange::ThirtyDays;
        } else if let Some(value) = arg.strip_prefix("--range=") {
            match parse_range_value(value) {
                Some(range) => options.range = range,
                None => {
                    return ParseResult {
                        options,
                        error: Some(format!("Invalid range: {value}")),
                    }
                }
            }
        } else if arg == "--range" {
            index += 1;
            let value = args.get(index).map(String::as_str);
            match parse_range_value(value.unwrap_or("")) {
                Some(range) => options.range = range,
                None => {
                    return ParseResult {
                        options,
                        error: Some(format!("Invalid range: {}", value.unwrap_or(""))),
                    }
                }
            }
        } else if let Some(value) = arg.strip_prefix("--data-dir=") {
            options.data_dir = Some(value.to_string());
        } else if arg == "--data-dir" {
            index += 1;
            let Some(value) = args.get(index) else {
                return ParseResult {
                    options,
                    error: Some("Missing value for --data-dir".into()),
                };
            };
            options.data_dir = Some(value.clone());
        } else {
            return ParseResult {
                options,
                error: Some(format!("Unknown option: {arg}")),
            };
        }
        index += 1;
    }
    ParseResult {
        options,
        error: None,
    }
}

pub fn render_help() -> String {
    [
        "Usage: loongsuite-pilot token-usage [options]",
        "",
        "Shows token usage from logs/metrics-summary.json and service state from logs/runtime.json.",
        "",
        "Options:",
        "  --once                    Print once and exit (default)",
        "  --range <today|7d|30d>    Aggregation range (default: today)",
        "  --today, --7d, --30d      Shortcut range selectors",
        "  --data-dir <path>         Override LoongSuite Pilot data directory",
        "  --no-color                Disable ANSI colors",
        "  --help, -h                Show this help",
    ]
    .join("\n")
}

pub fn render_token_usage(
    data: &TokenUsageViewData,
    options: &TokenUsageOptions,
    width: usize,
) -> String {
    let color = Color::new(options.color);
    let empty = Value::Object(serde_json::Map::new());
    let range_data = data
        .summary
        .as_ref()
        .and_then(|summary| summary.get("ranges"))
        .and_then(|ranges| ranges.get(options.range.as_str()))
        .unwrap_or(&empty);
    let generated_at = data
        .summary
        .as_ref()
        .and_then(|summary| summary.get("generatedAt"))
        .and_then(Value::as_str)
        .and_then(format_date_time);
    let runtime_updated = data
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.get("updatedAt"))
        .and_then(Value::as_str)
        .and_then(format_date_time);
    let service_state = format_service_state(data, &color);
    let heading = format!(
        "{}  {service_state}",
        color.bold("LoongSuite Pilot Token Usage")
    );
    let range_line = format!(
        "Range {}  |  Generated {}  |  Runtime {}",
        options.range.label(),
        generated_at.unwrap_or_else(|| data
            .summary_error
            .clone()
            .unwrap_or_else(|| "not found".into())),
        runtime_updated.unwrap_or_else(|| data
            .runtime_error
            .clone()
            .unwrap_or_else(|| "not found".into()))
    );
    let version = data
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.get("packageVersion"))
        .and_then(Value::as_str)
        .or_else(|| {
            data.summary
                .as_ref()
                .and_then(|summary| summary.get("packageVersion"))
                .and_then(Value::as_str)
        })
        .unwrap_or("unknown");
    let version_line = format!(
        "Version {version}  |  Now {}",
        format_date_time(&data.now).unwrap_or_else(|| data.now.clone())
    );
    let mut lines = vec![heading, range_line, version_line, String::new()];
    if data.summary.is_none() {
        lines.push(color.yellow("No metrics summary found yet."));
        lines.push(
            "Start loongsuite-pilot and wait for the metrics summary writer to refresh.".into(),
        );
        return trim_lines(&lines, width);
    }
    lines.extend(render_kpis(range_data, &color));
    lines.push(String::new());
    lines.push(render_token_breakdown(range_data, width, &color));
    lines.push(String::new());
    lines.extend(render_share_section(
        "Providers",
        range_data.get("providerShares"),
        width,
        &color,
        "Provider",
        |item| item.get("provider"),
        None,
    ));
    lines.push(String::new());
    let model_detail = |item: &Value| {
        format!(
            "in {}, cache {}",
            compact_number(number(item.get("inputTokens"))),
            compact_number(number(item.get("cacheReadTokens")))
        )
    };
    lines.extend(render_share_section(
        "Models",
        range_data.get("modelShares"),
        width,
        &color,
        "Model",
        |item| item.get("model"),
        Some(&model_detail),
    ));
    lines.push(String::new());
    lines.extend(render_agent_section(
        range_data.get("agentShares"),
        width,
        &color,
    ));
    lines.push(String::new());
    lines.extend(render_repo_section(range_data.get("repoShares"), &color));
    lines.push(String::new());
    lines.extend(render_trend_section(
        options.range,
        data.summary.as_ref(),
        width,
        &color,
    ));
    trim_lines(&lines, width)
}

pub async fn run_token_usage_command(
    args: &[String],
    env: &HashMap<String, String>,
    is_tty: bool,
    width: usize,
) -> (i32, String, String) {
    let parsed = parse_token_usage_args(args, env, is_tty);
    if let Some(error) = &parsed.error {
        return (1, String::new(), format!("{error}\n\n{}\n", render_help()));
    }
    if parsed.options.help {
        return (0, format!("{}\n", render_help()), String::new());
    }
    let data = load_view_data(&parsed.options).await;
    let code = if data.summary.is_some() { 0 } else { 1 };
    (
        code,
        format!("{}\n", render_token_usage(&data, &parsed.options, width)),
        String::new(),
    )
}

pub async fn resolve_token_usage_data_dir(explicit: Option<&str>) -> String {
    if let Some(explicit) = explicit {
        return resolve_home(explicit);
    }
    if let Ok(env_dir) = std::env::var("LOONGSUITE_PILOT_DATA_DIR") {
        if !env_dir.is_empty() {
            return resolve_home(&env_dir);
        }
    }
    let config_path = resolve_home(
        &std::env::var("AGENT_DATA_COLLECTION_CONFIG")
            .unwrap_or_else(|_| "~/.loongsuite-pilot/config.json".into()),
    );
    let config = read_json_file::<Value>(&config_path).await;
    resolve_home(
        config
            .as_ref()
            .and_then(|value| value.get("dataDir"))
            .and_then(Value::as_str)
            .unwrap_or("~/.loongsuite-pilot"),
    )
}

pub async fn load_view_data(options: &TokenUsageOptions) -> TokenUsageViewData {
    let data_dir = resolve_token_usage_data_dir(options.data_dir.as_deref()).await;
    let summary_path = std::path::Path::new(&data_dir)
        .join("logs")
        .join("metrics-summary.json")
        .to_string_lossy()
        .into_owned();
    let runtime_path = std::path::Path::new(&data_dir)
        .join("logs")
        .join("runtime.json")
        .to_string_lossy()
        .into_owned();
    let (summary, summary_error) = read_json_with_error(&summary_path).await;
    let (runtime, runtime_error) = read_json_with_error(&runtime_path).await;
    let runtime_alive = runtime.as_ref().is_some_and(is_runtime_alive);
    TokenUsageViewData {
        data_dir,
        summary_path,
        runtime_path,
        summary,
        runtime,
        runtime_alive,
        summary_error,
        runtime_error,
        now: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

fn parse_range_value(value: &str) -> Option<MetricsRange> {
    match value.trim().to_lowercase().as_str() {
        "today" | "1d" | "day" => Some(MetricsRange::Today),
        "7d" | "7" | "seven" | "sevendays" | "seven-days" => Some(MetricsRange::SevenDays),
        "30d" | "30" | "thirty" | "thirtydays" | "thirty-days" => Some(MetricsRange::ThirtyDays),
        _ => None,
    }
}

async fn read_json_with_error(path: &str) -> (Option<Value>, Option<String>) {
    match tokio::fs::read_to_string(path).await {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(value) => (Some(value), None),
            Err(_) => (None, Some("unreadable".into())),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (None, Some("not found".into())),
        Err(_) => (None, Some("unreadable".into())),
    }
}

fn is_runtime_alive(runtime: &Value) -> bool {
    if runtime.get("status").and_then(Value::as_str) != Some("active") {
        return false;
    }
    let Some(pid) = runtime.get("pid").and_then(Value::as_u64) else {
        return false;
    };
    pid > 0 && pid <= u32::MAX as u64 && is_process_alive(pid as u32)
}

fn render_kpis(range_data: &Value, color: &Color) -> Vec<String> {
    let cells = [
        (
            "Tokens",
            compact_number(number(range_data.get("totalTokens"))),
            true,
        ),
        (
            "Input",
            compact_number(number(range_data.get("inputTokens"))),
            false,
        ),
        (
            "Output",
            compact_number(number(range_data.get("outputTokens"))),
            false,
        ),
        (
            "Cache",
            compact_number(number(range_data.get("cacheReadTokens"))),
            false,
        ),
        (
            "Sessions",
            number(range_data.get("totalSessions")).round().to_string(),
            false,
        ),
        (
            "Requests",
            number(range_data.get("totalRequests")).round().to_string(),
            false,
        ),
        (
            "Tools",
            number(range_data.get("totalToolCalls")).round().to_string(),
            false,
        ),
        (
            "Events",
            number(range_data.get("totalEvents")).round().to_string(),
            false,
        ),
    ];
    let width = 12;
    let mut rows = vec![color.bold("Summary")];
    for chunk in cells.chunks(4) {
        rows.push(format!(
            "  {}",
            chunk
                .iter()
                .map(|(label, _, _)| color.dim(&pad_right(label, width)))
                .collect::<Vec<_>>()
                .join("  ")
        ));
        rows.push(format!(
            "  {}",
            chunk
                .iter()
                .map(|(_, value, cyan)| {
                    let padded = pad_right(value, width);
                    if *cyan {
                        color.cyan(&padded)
                    } else {
                        padded
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
        ));
        if chunk.len() == 4 && chunk[0].0 != "Sessions" {
            rows.push(String::new());
        }
    }
    rows
}

fn render_token_breakdown(range_data: &Value, width: usize, color: &Color) -> String {
    let total = number(range_data.get("totalTokens"));
    let input = number(range_data.get("inputTokens"));
    let output = number(range_data.get("outputTokens"));
    let cache = number(range_data.get("cacheReadTokens"));
    let cache_creation = number(range_data.get("cacheCreationTokens"));
    let input_share = if total > 0.0 { input / total } else { 0.0 };
    let output_share = if total > 0.0 { output / total } else { 0.0 };
    let cache_share = if input > 0.0 { cache / input } else { 0.0 };
    let bar_width = table_bar_width(width);
    let mut lines = vec![
        color.bold("Token Breakdown"),
        table_row(
            "Input",
            &compact_number(input),
            &percent(input_share),
            "",
            &render_bar(input_share, bar_width, color),
            "",
        ),
        table_row(
            "Output",
            &compact_number(output),
            &percent(output_share),
            "",
            &render_bar(output_share, bar_width, color),
            "",
        ),
        table_row(
            "Cache read",
            &compact_number(cache),
            &percent(cache_share),
            "",
            &color.dim("of input"),
            "",
        ),
    ];
    if cache_creation > 0.0 {
        lines.push(table_row(
            "Cache write",
            &compact_number(cache_creation),
            "",
            "",
            "",
            "",
        ));
    }
    lines.join("\n")
}

fn render_share_section(
    title: &str,
    items: Option<&Value>,
    width: usize,
    color: &Color,
    name_header: &str,
    name: impl Fn(&Value) -> Option<&Value>,
    detail: Option<&dyn Fn(&Value) -> String>,
) -> Vec<String> {
    let mut lines = vec![color.bold(title)];
    let list = items.and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() {
        lines.push(color.dim("  no data"));
        return lines;
    }
    let bar_width = table_bar_width(width);
    lines.push(color.dim(&table_row(name_header, "Tokens", "Share", "", "Usage", "")));
    for item in list.iter().take(6) {
        let share = clamp_share(number(item.get("share")));
        let label = truncate_middle(
            name(item).and_then(Value::as_str).unwrap_or("unknown"),
            TABLE_NAME_WIDTH,
        );
        let detail_text = detail
            .map(|detail| format!("  {}", color.dim(&detail(item))))
            .unwrap_or_default();
        lines.push(table_row(
            &label,
            &compact_number(number(item.get("totalTokens"))),
            &percent(share),
            "",
            &render_bar(share, bar_width, color),
            &detail_text,
        ));
    }
    lines
}

fn render_agent_section(items: Option<&Value>, width: usize, color: &Color) -> Vec<String> {
    let mut lines = vec![color.bold("Agents")];
    let list = items.and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() {
        lines.push(color.dim("  no data"));
        return lines;
    }
    let bar_width = table_bar_width(width);
    lines.push(color.dim(&table_row(
        "Agent", "Tokens", "Events", "Sess", "Activity", "",
    )));
    for item in list.iter().take(8) {
        let share = clamp_share(number(item.get("share")));
        let name = truncate_middle(
            item.get("agentType")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            TABLE_NAME_WIDTH,
        );
        lines.push(table_row(
            &name,
            &compact_number(number(item.get("tokens"))),
            &number(item.get("events")).round().to_string(),
            &number(item.get("sessions")).round().to_string(),
            &render_bar(share, bar_width, color),
            "",
        ));
    }
    lines
}

fn render_repo_section(items: Option<&Value>, color: &Color) -> Vec<String> {
    let mut lines = vec![color.bold("Repositories")];
    let list = items.and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() {
        lines.push(color.dim("  no data"));
        return lines;
    }
    lines.push(color.dim(&table_row("Repository", "", "Events", "Sess", "", "")));
    for item in list.iter().take(6) {
        let repo = truncate_middle(
            item.get("repo")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            TABLE_NAME_WIDTH,
        );
        lines.push(table_row(
            &repo,
            "",
            &number(item.get("events")).round().to_string(),
            &number(item.get("sessions")).round().to_string(),
            "",
            "",
        ));
    }
    lines
}

fn render_trend_section(
    range: MetricsRange,
    summary: Option<&Value>,
    width: usize,
    color: &Color,
) -> Vec<String> {
    let count = if range == MetricsRange::ThirtyDays {
        30
    } else {
        7
    };
    let tokens = summary
        .and_then(|value| value.get("dailyTokens"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sessions = summary
        .and_then(|value| value.get("dailySessions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let token_points: Vec<_> = tokens
        .iter()
        .rev()
        .take(count)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .cloned()
        .collect();
    let title = if range == MetricsRange::ThirtyDays {
        "Token Trend (30d)"
    } else {
        "Token Trend (7d)"
    };
    let mut lines = vec![color.bold(title)];
    if token_points.is_empty() {
        lines.push(color.dim("  no trend data"));
        return lines;
    }
    let max_value = token_points
        .iter()
        .map(|point| number(point.get("value")))
        .fold(1.0_f64, f64::max);
    let bar_width = 26.min(8.max(width.saturating_sub(38)));
    lines.push(color.dim(&format!(
        "  {} {}  Trend{} Sessions",
        pad_right("Day", 5),
        pad_left("Tokens", 8),
        " ".repeat(bar_width.saturating_sub(3))
    )));
    for point in token_points {
        let value = number(point.get("value"));
        let day = point
            .get("day")
            .and_then(Value::as_str)
            .and_then(|text| text.get(5..))
            .unwrap_or("--");
        let session_value = sessions
            .iter()
            .find(|item| item.get("day") == point.get("day"))
            .map(|item| number(item.get("value")))
            .unwrap_or(0.0);
        lines.push(format!(
            "  {day} {}  {} {}",
            pad_left(&compact_number(value), 8),
            render_bar(value / max_value, bar_width, color),
            pad_left(&session_value.round().to_string(), 3)
        ));
    }
    lines
}

fn format_service_state(data: &TokenUsageViewData, color: &Color) -> String {
    if data.runtime_alive {
        let pid = data
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.get("pid"))
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".into());
        return color.green(&format!("active pid {pid}"));
    }
    if let Some(status) = data
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.get("status"))
        .and_then(Value::as_str)
    {
        let pid = data
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.get("pid"))
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".into());
        return color.yellow(&format!("{status} pid {pid}"));
    }
    color.yellow("service not running")
}

fn compact_number(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1_000_000_000.0 {
        format!("{}B", format_one_decimal(value / 1_000_000_000.0))
    } else if abs >= 1_000_000.0 {
        format!("{}M", format_one_decimal(value / 1_000_000.0))
    } else if abs >= 1_000.0 {
        format!("{}K", format_one_decimal(value / 1_000.0))
    } else {
        format!("{}", value.round() as i64)
    }
}

fn format_one_decimal(value: f64) -> String {
    format!("{:.1}", (value * 10.0).round() / 10.0)
}

fn percent(value: f64) -> String {
    format!("{}%", (clamp_share(value) * 100.0).round() as i64)
}

fn render_bar(value: f64, width: usize, color: &Color) -> String {
    let share = clamp_share(value);
    let filled = if share > 0.0 {
        1.max((width as f64 * share).round() as usize)
    } else {
        0
    };
    color.cyan(&format!(
        "[{}{}]",
        "#".repeat(filled),
        "-".repeat(width.saturating_sub(filled))
    ))
}

fn table_bar_width(width: usize) -> usize {
    TABLE_BAR_WIDTH.min(10.max(width.saturating_sub(58)))
}

fn table_row(
    name: &str,
    value: &str,
    metric: &str,
    meta: &str,
    tail: &str,
    detail: &str,
) -> String {
    let row = format!(
        "  {} {} {} {}",
        pad_right(name, TABLE_NAME_WIDTH),
        pad_left(value, TABLE_VALUE_WIDTH),
        pad_left(metric, TABLE_METRIC_WIDTH),
        pad_left(meta, TABLE_META_WIDTH)
    );
    let tail_part = if tail.is_empty() {
        String::new()
    } else {
        format!("  {tail}")
    };
    format!("{row}{tail_part}{detail}")
}

fn clamp_share(value: f64) -> f64 {
    if !value.is_finite() {
        0.0
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn format_date_time(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    Some(parsed.format("%m/%d %H:%M:%S").to_string())
}

fn trim_lines(lines: &[String], width: usize) -> String {
    lines
        .iter()
        .flat_map(|line| line.split('\n'))
        .map(|line| {
            if strip_ansi(line).chars().count() > width + 20 {
                truncate_ansi(line, width + 20)
            } else {
                line.to_string()
            }
        })
        .map(|line| line.trim_end_matches([' ', '\t']).to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_ansi(value: &str, max_length: usize) -> String {
    if strip_ansi(value).chars().count() <= max_length {
        return value.to_string();
    }
    format!(
        "{}...",
        value
            .chars()
            .take(max_length.saturating_sub(1))
            .collect::<String>()
    )
}

fn truncate_middle(value: &str, max_length: usize) -> String {
    if value.chars().count() <= max_length {
        return value.to_string();
    }
    if max_length <= 3 {
        return value.chars().take(max_length).collect();
    }
    let left = (max_length - 3).div_ceil(2);
    let right = (max_length - 3) / 2;
    let chars: Vec<char> = value.chars().collect();
    format!(
        "{}...{}",
        chars.iter().take(left).collect::<String>(),
        chars.iter().skip(chars.len() - right).collect::<String>()
    )
}

fn pad_right(value: &str, width: usize) -> String {
    let length = visible_len(value);
    if length >= width {
        value.to_string()
    } else {
        format!("{value}{}", " ".repeat(width - length))
    }
}

fn pad_left(value: &str, width: usize) -> String {
    let length = visible_len(value);
    if length >= width {
        value.to_string()
    } else {
        format!("{}{value}", " ".repeat(width - length))
    }
}

fn strip_ansi(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn visible_len(value: &str) -> usize {
    strip_ansi(value).chars().count()
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

struct Color {
    enabled: bool,
}

impl Color {
    fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.enabled {
            format!("\u{1b}[{code}m{text}\u{1b}[0m")
        } else {
            text.to_string()
        }
    }

    fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }
    fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }
    fn green(&self, text: &str) -> String {
        self.paint("32", text)
    }
    fn yellow(&self, text: &str) -> String {
        self.paint("33", text)
    }
    fn cyan(&self, text: &str) -> String {
        self.paint("36", text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn view() -> TokenUsageViewData {
        TokenUsageViewData {
            data_dir: "/tmp/loongsuite-pilot".into(),
            summary_path: "/tmp/loongsuite-pilot/logs/metrics-summary.json".into(),
            runtime_path: "/tmp/loongsuite-pilot/logs/runtime.json".into(),
            runtime_alive: true,
            now: "2026-06-24T11:35:00.000Z".into(),
            runtime: Some(
                json!({"status": "active", "packageVersion": "1.2.3", "pid": 1234, "updatedAt": "2026-06-24T11:34:30.000Z"}),
            ),
            summary_error: None,
            runtime_error: None,
            summary: Some(json!({
                "version": 1,
                "packageVersion": "1.2.3",
                "generatedAt": "2026-06-24T11:34:00.000Z",
                "ranges": {"today": {
                    "totalTokens": 1530,
                    "inputTokens": 1200,
                    "outputTokens": 330,
                    "cacheReadTokens": 600,
                    "cacheCreationTokens": 0,
                    "totalSessions": 2,
                    "totalRequests": 3,
                    "totalToolCalls": 4,
                    "totalEvents": 9,
                    "providerShares": [
                        {"provider": "openai", "totalTokens": 1200, "share": 0.78},
                        {"provider": "anthropic", "totalTokens": 330, "share": 0.22}
                    ],
                    "modelShares": [{"model": "gpt-5.5", "totalTokens": 1530, "inputTokens": 1200, "cacheReadTokens": 600, "share": 1}],
                    "agentShares": [{"agentType": "codex", "sessions": 2, "events": 9, "tokens": 1530, "share": 1}],
                    "repoShares": [{"repo": "sls/loongsuite-pilot", "sessions": 2, "events": 9}]
                }},
                "dailyTokens": [
                    {"day": "2026-06-18", "value": 0},
                    {"day": "2026-06-19", "value": 10},
                    {"day": "2026-06-20", "value": 20},
                    {"day": "2026-06-21", "value": 30},
                    {"day": "2026-06-22", "value": 40},
                    {"day": "2026-06-23", "value": 50},
                    {"day": "2026-06-24", "value": 1530}
                ],
                "dailySessions": [
                    {"day": "2026-06-18", "value": 0},
                    {"day": "2026-06-19", "value": 1},
                    {"day": "2026-06-20", "value": 1},
                    {"day": "2026-06-21", "value": 1},
                    {"day": "2026-06-22", "value": 1},
                    {"day": "2026-06-23", "value": 1},
                    {"day": "2026-06-24", "value": 2}
                ]
            })),
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn parses_range_data_dir_and_color() {
        let parsed = parse_token_usage_args(
            &strings(&[
                "--once",
                "--range",
                "30d",
                "--data-dir",
                "~/pilot-data",
                "--no-color",
            ]),
            &HashMap::new(),
            true,
        );
        assert!(parsed.error.is_none());
        assert_eq!(parsed.options.range, MetricsRange::ThirtyDays);
        assert_eq!(parsed.options.data_dir.as_deref(), Some("~/pilot-data"));
        assert!(!parsed.options.color);
        assert!(
            parse_token_usage_args(&[], &HashMap::new(), true)
                .options
                .color
        );
        assert!(
            !parse_token_usage_args(&[], &HashMap::new(), false)
                .options
                .color
        );
        let mut env = HashMap::new();
        env.insert("NO_COLOR".into(), String::new());
        assert!(!parse_token_usage_args(&[], &env, true).options.color);
    }

    #[test]
    fn renders_token_usage_and_keeps_columns_aligned() {
        let options = TokenUsageOptions {
            range: MetricsRange::Today,
            data_dir: None,
            color: false,
            help: false,
        };
        let output = render_token_usage(&view(), &options, 100);
        assert!(output.contains("LoongSuite Pilot Token Usage"));
        assert!(output.contains("active pid 1234"));
        assert!(output.contains("Tokens"));
        assert!(output.contains("1.5K"));
        assert!(regex::Regex::new(r"Cache read\s+600\s+50%")
            .unwrap()
            .is_match(&output));
        assert!(output.contains("Providers"));
        assert!(output.contains("openai"));
        assert!(output.contains("Agents"));
        assert!(output.contains("codex"));
        assert!(output.contains("Token Trend (7d)"));

        let colored = TokenUsageOptions {
            color: true,
            ..options
        };
        let output = render_token_usage(&view(), &colored, 100);
        let plain = strip_ansi(&output);
        let lines: Vec<&str> = plain.split('\n').collect();
        let provider_header = lines
            .iter()
            .find(|line| line.contains("Provider") && line.contains("Usage"))
            .unwrap();
        let openai = lines.iter().find(|line| line.contains("openai")).unwrap();
        let model_header = lines
            .iter()
            .find(|line| line.contains("Model") && line.contains("Usage"))
            .unwrap();
        let model = lines.iter().find(|line| line.contains("gpt-5.5")).unwrap();
        let agent_header = lines
            .iter()
            .find(|line| line.contains("Agent") && line.contains("Activity"))
            .unwrap();
        let agent = lines.iter().find(|line| line.contains("codex")).unwrap();
        let repo_header = lines
            .iter()
            .find(|line| line.contains("Repository") && line.contains("Events"))
            .unwrap();
        let breakdown_index = lines
            .iter()
            .position(|line| *line == "Token Breakdown")
            .unwrap();
        let token_breakdown = lines[breakdown_index + 1];
        assert_eq!(openai.find('['), provider_header.find("Usage"));
        assert_eq!(token_breakdown.find('['), provider_header.find("Usage"));
        assert_eq!(model.find('['), model_header.find("Usage"));
        assert_eq!(model_header.find("Usage"), provider_header.find("Usage"));
        assert_eq!(agent.find('['), agent_header.find("Activity"));
        assert_eq!(agent_header.find("Activity"), provider_header.find("Usage"));
        assert_eq!(repo_header.find("Events"), agent_header.find("Events"));
        let summary_label = lines
            .iter()
            .find(|line| {
                line.contains("Tokens") && line.contains("Input") && line.contains("Output")
            })
            .unwrap();
        let summary_value = lines[lines.iter().position(|line| line == summary_label).unwrap() + 1];
        assert_eq!(summary_value.find("1.5K"), summary_label.find("Tokens"));
        assert_eq!(summary_value.find("1.2K"), summary_label.find("Input"));
    }

    #[test]
    fn renders_an_empty_state_without_the_summary_path() {
        let mut data = view();
        data.summary = None;
        data.summary_error = Some("not found".into());
        let output = render_token_usage(
            &data,
            &TokenUsageOptions {
                range: MetricsRange::Today,
                data_dir: None,
                color: false,
                help: false,
            },
            100,
        );
        assert!(output.contains("No metrics summary found yet."));
        assert!(!output.contains("/tmp/loongsuite-pilot/logs/metrics-summary.json"));
    }
}
