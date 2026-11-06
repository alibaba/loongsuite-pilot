//! Port of `src/utils/logger.ts`.
//!
//! Log lines use pino's JSON shape from that module: uppercased level label,
//! ISO-8601 `time`, `pid`, `hostname`, child `tag`, then metadata, then `msg`.
//! File output goes through `tracing-appender`'s daily roller. Level gating
//! uses `tracing_subscriber::filter::LevelFilter`, and each record is also
//! emitted as a `tracing` event.

use serde_json::{Map, Value};
use std::io::{IsTerminal, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tracing::Level;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::LevelFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinoLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Silent,
}

impl PinoLevel {
    fn label(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Fatal => "FATAL",
            Self::Silent => "SILENT",
        }
    }

    fn as_tracing(self) -> Option<Level> {
        match self {
            Self::Trace => Some(Level::TRACE),
            Self::Debug => Some(Level::DEBUG),
            Self::Info => Some(Level::INFO),
            Self::Warn => Some(Level::WARN),
            Self::Error | Self::Fatal => Some(Level::ERROR),
            Self::Silent => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Destination {
    Stdout,
    Stderr,
    File,
}

struct LogState {
    destination: Destination,
    file_logging: bool,
    mirror_stdout: bool,
    appender: Option<RollingFileAppender>,
}

impl LogState {
    fn new() -> Self {
        Self {
            destination: Destination::Stdout,
            file_logging: false,
            mirror_stdout: false,
            appender: None,
        }
    }
}

fn state() -> &'static Mutex<LogState> {
    static STATE: OnceLock<Mutex<LogState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(LogState::new()))
}

fn lock_state() -> std::sync::MutexGuard<'static, LogState> {
    match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn configured_level() -> PinoLevel {
    static LEVEL: OnceLock<PinoLevel> = OnceLock::new();
    *LEVEL.get_or_init(|| {
        let raw = std::env::var("LOG_LEVEL")
            .ok()
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| "info".to_string());
        parse_level(&raw)
            .unwrap_or_else(|| panic!("default level:{raw} must be included in custom levels"))
    })
}

fn parse_level(raw: &str) -> Option<PinoLevel> {
    match raw {
        "trace" => Some(PinoLevel::Trace),
        "debug" => Some(PinoLevel::Debug),
        "info" => Some(PinoLevel::Info),
        "warn" => Some(PinoLevel::Warn),
        "error" => Some(PinoLevel::Error),
        "fatal" => Some(PinoLevel::Fatal),
        "silent" => Some(PinoLevel::Silent),
        _ => None,
    }
}

fn level_filter(level: PinoLevel) -> LevelFilter {
    match level {
        PinoLevel::Trace => LevelFilter::TRACE,
        PinoLevel::Debug => LevelFilter::DEBUG,
        PinoLevel::Info => LevelFilter::INFO,
        PinoLevel::Warn => LevelFilter::WARN,
        PinoLevel::Error | PinoLevel::Fatal => LevelFilter::ERROR,
        PinoLevel::Silent => LevelFilter::OFF,
    }
}

fn level_enabled(message: PinoLevel) -> bool {
    let configured = configured_level();
    if configured == PinoLevel::Silent {
        return false;
    }
    if configured == PinoLevel::Fatal {
        return message == PinoLevel::Fatal;
    }
    match message.as_tracing() {
        Some(level) => level_filter(configured) >= level,
        None => false,
    }
}

fn hostname() -> &'static str {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    })
    .as_str()
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn format_pino_line(
    level: &str,
    time: &str,
    pid: u32,
    host: &str,
    tag: &str,
    message: &str,
    meta: Option<&Map<String, Value>>,
) -> String {
    let mut buf = String::from("{");
    push_json(&mut buf, "level", &Value::String(level.to_string()));
    push_json(&mut buf, "time", &Value::String(time.to_string()));
    push_raw(&mut buf, "pid", &pid.to_string());
    push_json(&mut buf, "hostname", &Value::String(host.to_string()));
    push_json(&mut buf, "tag", &Value::String(tag.to_string()));
    if let Some(meta) = meta {
        for (key, value) in meta {
            if matches!(
                key.as_str(),
                "level" | "time" | "pid" | "hostname" | "tag" | "msg"
            ) {
                continue;
            }
            push_json(&mut buf, key, value);
        }
    }
    push_json(&mut buf, "msg", &Value::String(message.to_string()));
    buf.push('}');
    buf
}

fn push_json(buf: &mut String, key: &str, value: &Value) {
    let rendered = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    push_raw(buf, key, &rendered);
}

fn push_raw(buf: &mut String, key: &str, raw_json: &str) {
    if buf.len() > 1 {
        buf.push(',');
    }
    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
    buf.push_str(&key);
    buf.push(':');
    buf.push_str(raw_json);
}

fn emit(level: PinoLevel, tag: &str, message: &str, meta: Option<&Map<String, Value>>) {
    if !level_enabled(level) {
        return;
    }
    let line = format_pino_line(
        level.label(),
        &iso_now(),
        std::process::id(),
        hostname(),
        tag,
        message,
        meta,
    );
    {
        let mut state = lock_state();
        match state.destination {
            Destination::Stdout => {
                let _ = writeln!(std::io::stdout(), "{line}");
            }
            Destination::Stderr => {
                let _ = writeln!(std::io::stderr(), "{line}");
            }
            Destination::File => {
                if let Some(appender) = state.appender.as_mut() {
                    let _ = writeln!(appender, "{line}");
                }
                if state.mirror_stdout {
                    let _ = writeln!(std::io::stdout(), "{line}");
                }
            }
        }
    }
    emit_tracing(level, tag, message);
}

fn emit_tracing(level: PinoLevel, tag: &str, message: &str) {
    match level {
        PinoLevel::Trace => {
            tracing::trace!(target: "loongsuite_pilot", tag = %tag, message = %message, "log")
        }
        PinoLevel::Debug => {
            tracing::debug!(target: "loongsuite_pilot", tag = %tag, message = %message, "log")
        }
        PinoLevel::Info => {
            tracing::info!(target: "loongsuite_pilot", tag = %tag, message = %message, "log")
        }
        PinoLevel::Warn => {
            tracing::warn!(target: "loongsuite_pilot", tag = %tag, message = %message, "log")
        }
        PinoLevel::Error => {
            tracing::error!(target: "loongsuite_pilot", tag = %tag, message = %message, "log")
        }
        PinoLevel::Fatal => {
            tracing::error!(target: "loongsuite_pilot", tag = %tag, fatal = true, message = %message, "log")
        }
        PinoLevel::Silent => {}
    }
}

/// Keep machine-readable CLI stdout free of operational log records.
/// No-op after [`init_file_logging`].
pub fn redirect_root_logger_to_stderr() {
    let mut state = lock_state();
    if state.file_logging {
        return;
    }
    state.destination = Destination::Stderr;
}

/// Enable file logging with daily rotation.
///
/// Mirrors pino-roll's `frequency: daily`, `mkdir: true`, `dateFormat: yyyy-MM-dd`,
/// and `limit.count: 10`. `tracing-appender` names files `{stem}.{yyyy-MM-dd}.{ext}`
/// in UTC and does not rotate on the 50MB size cap or delete unrelated log files
/// (`removeOtherLogFiles`).
pub async fn init_file_logging(log_file_path: &str) -> std::io::Result<()> {
    {
        let mut state = lock_state();
        if state.file_logging {
            return Ok(());
        }
        state.file_logging = true;
    }

    let path = Path::new(log_file_path);
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("loongsuite-pilot.log");
    let parsed = Path::new(file_name);
    let stem = parsed
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(file_name);
    let suffix = parsed.extension().and_then(|ext| ext.to_str());
    let mut builder = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(stem)
        .max_log_files(10);
    if let Some(suffix) = suffix {
        builder = builder.filename_suffix(suffix);
    }
    let appender = builder.build(directory).map_err(std::io::Error::other)?;

    let use_stdout = std::io::stdout().is_terminal()
        || std::env::var("LOONGSUITE_PILOT_STDOUT").ok().as_deref() == Some("1");
    if !use_stdout {
        let _ = std::fs::write(log_file_path, "");
    }

    let mut state = lock_state();
    state.appender = Some(appender);
    state.mirror_stdout = use_stdout;
    state.destination = Destination::File;
    Ok(())
}

/// Synchronously flush buffered file-log writes. No-op before file logging starts.
pub fn flush_logs_sync() {
    let mut state = lock_state();
    if let Some(appender) = state.appender.as_mut() {
        let _ = appender.flush();
    }
}

#[derive(Debug, Clone)]
pub struct BoundLogger {
    tag: String,
}

impl BoundLogger {
    pub fn info(&self, message: &str, meta: Option<&Map<String, Value>>) {
        emit(PinoLevel::Info, &self.tag, message, meta);
    }

    pub fn warn(&self, message: &str, meta: Option<&Map<String, Value>>) {
        emit(PinoLevel::Warn, &self.tag, message, meta);
    }

    pub fn error(&self, message: &str, meta: Option<&Map<String, Value>>) {
        emit(PinoLevel::Error, &self.tag, message, meta);
    }

    pub fn debug(&self, message: &str, meta: Option<&Map<String, Value>>) {
        emit(PinoLevel::Debug, &self.tag, message, meta);
    }
}

pub fn create_logger(tag: &str) -> BoundLogger {
    BoundLogger {
        tag: tag.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flush_logs_sync_is_a_safe_noop_before_file_logging() {
        if !crate::utils::isolated_env_test() {
            return;
        }
        assert!(!lock_state().file_logging);
        assert!(lock_state().appender.is_none());
        flush_logs_sync();
        assert!(!lock_state().file_logging);
        assert!(lock_state().appender.is_none());
    }

    #[test]
    fn pino_line_uppercases_level_and_uses_iso_time() {
        let meta = json!({"count": 2, "error": "x"})
            .as_object()
            .cloned()
            .unwrap();
        let line = format_pino_line(
            "INFO",
            "2026-10-22T08:00:00.000Z",
            7,
            "host",
            "WinArchive",
            "hello",
            Some(&meta),
        );
        assert_eq!(
            line,
            r#"{"level":"INFO","time":"2026-10-22T08:00:00.000Z","pid":7,"hostname":"host","tag":"WinArchive","count":2,"error":"x","msg":"hello"}"#
        );
    }

    #[test]
    fn info_allows_warn_and_rejects_debug() {
        // The comparison itself is what pino's numeric levels do. The process
        // LOG_LEVEL is read once, so this checks the predicate directly.
        assert!(super::level_filter(PinoLevel::Info) >= Level::WARN);
        assert!(super::level_filter(PinoLevel::Info) >= Level::INFO);
        assert!((super::level_filter(PinoLevel::Info) < Level::DEBUG));
        assert!(!level_enabled_with(PinoLevel::Fatal, PinoLevel::Error));
        assert!(level_enabled_with(PinoLevel::Fatal, PinoLevel::Fatal));
        assert!(!level_enabled_with(PinoLevel::Silent, PinoLevel::Error));
    }

    fn level_enabled_with(configured: PinoLevel, message: PinoLevel) -> bool {
        if configured == PinoLevel::Silent {
            return false;
        }
        if configured == PinoLevel::Fatal {
            return message == PinoLevel::Fatal;
        }
        match message.as_tracing() {
            Some(level) => level_filter(configured) >= level,
            None => false,
        }
    }
}
