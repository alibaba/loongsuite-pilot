//! Qoder / Qoder-CN hook transcript processor.
//!
//! Port of `assets/hooks/qoder-hook-processor.mjs` and the helpers it calls.
//! The shell invokes `hook-process qoder` or `hook-process qoder-cn`, with
//! optional `--agent-id` and `--log-prefix`. A missing log prefix uses the
//! agent id, matching `parseArgs`. A missing agent id uses the `hook-process`
//! token, then `qoder`.

use super::common::{
    agent_name_patch, append_history_rows, collect_resource_attributes, data_dir, decode_payload,
    filter_workspace_records, home_dir, hostname, load_runtime_config, local_date,
    local_stamp_seconds, now_unix_nanos, parse_span_attributes, record_upstream_context_once,
    sanitize_record, sha256_hex, with_file_lock, write_empty, Env, HookRequest, Obj,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_USER_IDENTITY_VALUE_LENGTH: usize = 512;
const QODER_CLI_STATUS_TIMEOUT_MS: u64 = 3_000;
const QODER_CLI_STATUS_FAILURE_TTL_MS: u64 = 60_000;
const RETRY_LOCK_MAX_AGE_MS: i64 = 60_000;
const RETRY_LOCK_WAIT_TIMEOUT_MS: i64 = 15_000;
const RETRY_LOCK_POLL_INTERVAL_MS: i64 = 25;
const CLI_STDOUT_LIMIT: usize = 64 * 1024;

const TERMINAL_STOP_REASONS: &[&str] = &[
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "refusal",
    "stop",
    "cancelled",
    "error",
];

const QODER_MAPPED_SOURCE_KEYS: &[&str] = &[
    "conversation_id",
    "cwd",
    "entrypoint",
    "event.id",
    "event_type",
    "gen_ai.session.id",
    "hookEvent",
    "hook_event_name",
    "message",
    "observed_time_unix_nano",
    "sessionId",
    "session_id",
    "sessionid",
    "timestamp",
    "time_unix_nano",
    "toolUseResult",
    "tool_input",
    "tool_name",
    "tool_use_id",
    "turn_id",
    "type",
    "user.id",
    "userId",
    "user_id",
    "uuid",
];

struct UserIdentity {
    name: Option<String>,
    email: Option<String>,
}

struct Stamp {
    span: Obj,
    agent_name: Option<String>,
    resources: Obj,
}

struct HookCtx<'a> {
    env: &'a Env,
    agent_id: String,
    log_prefix: String,
    user_id: String,
    stamp: Stamp,
}

struct Snapshot {
    line_count: usize,
    rows: Vec<Option<Value>>,
    content_hash: String,
    reason: &'static str,
}

struct LineRange {
    start: usize,
    end: usize,
    reason: &'static str,
}

struct TurnWindow {
    complete: bool,
    reason: String,
    start_line: Option<usize>,
    stop_line: Option<usize>,
    end_line: Option<usize>,
}

struct Progress {
    hook_event: String,
}

struct Boundary {
    start_ts: String,
    end_ts: String,
    content_start: usize,
    content_end: usize,
}

struct ToolCall {
    id: Option<String>,
    name: Option<String>,
    input: Option<Value>,
    call_ts: Option<String>,
}

struct ToolResult {
    tool_id: Option<String>,
    result: Option<Value>,
    is_error: bool,
    result_ts: Option<String>,
}

struct ProcessOpts {
    delay_applied: bool,
    range_reason: String,
    fixed_turn_window: bool,
    snapshot: Snapshot,
}

struct LockGuard<'a> {
    env: &'a Env,
    agent_id: &'a str,
    transcript: PathBuf,
    active: bool,
}

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            release_retry_lock(self.env, self.agent_id, &self.transcript);
        }
    }
}

enum CliQuery {
    Ready(Option<CliIdentity>),
    TimedOut,
}

struct CliIdentity {
    logged_in: bool,
    name: Option<String>,
    email: Option<String>,
}

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    if has_flag(request.args, "--wakeup-only") {
        write_empty(request.stdout);
        publish_hook_notice(request);
        return 0;
    }
    let (agent_id, log_prefix) = parse_agent_args(request.args);
    let runtime = load_runtime_config(request.env);
    let ctx = HookCtx {
        env: request.env,
        agent_id,
        log_prefix,
        user_id: runtime.user_id,
        stamp: build_stamp(request.env),
    };
    if has_flag(request.args, "--retry") {
        run_retry(&ctx, request.args, request.stdin);
    } else {
        write_empty(request.stdout);
        run_normal(&ctx, request.stdin);
    }
    0
}

// The native command retains its legacy inline mode for existing installed
// wrappers during binary-only upgrades. Newly generated wrappers select the
// collector-owned metadata path explicitly.
fn publish_hook_notice(request: &HookRequest<'_>) {
    if request.stdin.len() > 1024 * 1024 {
        return;
    }
    let (mut agent, _) = parse_agent_args(request.args);
    if agent == "qoder-cli" {
        agent = "qoder".into();
    }
    let mut value: Value =
        serde_json::from_str(decode_payload(request.stdin).trim()).unwrap_or(Value::Null);
    if has_flag(request.args, "--retry") {
        value = json!({
            "session_id":flag_value(request.args,"--session"),
            "transcript_path":flag_value(request.args,"--transcript"),
            "hook_event_name":"Stop",
            "cwd":flag_value(request.args,"--cwd"),
            "extra":{"user":value},
        });
        if let Some(line) =
            flag_value(request.args, "--trigger-end-line").and_then(|v| v.parse::<u64>().ok())
        {
            value["legacy_trigger_line"] = json!(line);
        }
    }
    if !value.is_object() {
        return;
    }
    let identity = resolve_qoder_hook_user_identity(request.env, &agent, &value);
    let identity = identity
        .as_ref()
        .and_then(|id| serde_json::from_str::<Value>(&identity_json(id)).ok());
    // A native terminal hook has resolved the current account, including a
    // known absence after logout. Preserve that empty result explicitly so a
    // source created during an earlier account cannot reuse its descriptor.
    // Legacy/raw notices without account context retain their fallback.
    let terminal = value
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_none_or(|event| matches!(event, "Stop" | "SessionEnd"));
    let identity = identity.or_else(|| terminal.then(|| json!({"name":"","email":""})));
    let stamp = build_stamp(request.env);
    if super::qoder_wakeup::publish_qoder_wakeup(
        &value,
        &data_dir(request.env),
        &agent,
        identity.as_ref(),
        &stamp.resources,
        &stamp.span,
    ) && value["hook_event_name"] != "SubagentStop"
    {
        if let Some(session) = value
            .get("session_id")
            .or_else(|| value.get("conversation_id"))
            .and_then(Value::as_str)
        {
            record_upstream_context_once(request.env, &agent, session);
        }
    }
}

// Product metadata owns account selection. Transcript shape never selects an
// account, and CLI auth/cache files are isolated by Qoder product flavor.
fn resolve_qoder_hook_user_identity(
    env: &Env,
    agent: &str,
    payload: &Value,
) -> Option<UserIdentity> {
    if !["qoder", "qoder-cn"].contains(&agent) {
        return None;
    }
    match payload
        .pointer("/parent_business_info/product")
        .and_then(Value::as_str)
    {
        Some("cli") => payload
            .pointer("/parent_business_info/version")
            .and_then(Value::as_str)
            .and_then(|version| resolve_qoder_product_cli_user_identity(env, agent, version))
            .or_else(|| read_qoder_app_user_identity(env, agent)),
        Some("app") => read_qoder_app_user_identity(env, agent),
        _ => payload
            .get("extra")
            .and_then(Value::as_object)
            .and_then(extract_user_identity),
    }
}

fn run_normal(ctx: &HookCtx<'_>, stdin: &[u8]) {
    let Some(payload) = parse_payload(ctx, stdin) else {
        return;
    };
    if !payload.session.is_empty() {
        record_upstream_context_once(ctx.env, &ctx.agent_id, &payload.session);
    }
    let snapshot = read_snapshot(Path::new(&payload.transcript), false);
    let cli_transcript = ctx.agent_id == "qoder"
        && snapshot
            .rows
            .iter()
            .flatten()
            .any(|row| infer_variant(Some(row), &ctx.agent_id) == "qoder-cli");
    let identity = if ctx.agent_id == "qoder-cn" {
        payload
            .extra
            .as_ref()
            .and_then(extract_qoder_cn_user_identity)
            .or_else(|| {
                payload
                    .desktop_invocation
                    .then(|| read_qoder_app_user_identity(ctx.env, &ctx.agent_id))
                    .flatten()
            })
    } else if ctx.agent_id == "qoder" && payload.desktop_invocation {
        // Desktop embeds CLI-format transcripts but has its own account.
        // A partial Hook identity is a complete snapshot, not a merge input.
        payload
            .extra
            .as_ref()
            .and_then(extract_user_identity)
            .or_else(|| read_qoder_app_user_identity(ctx.env, &ctx.agent_id))
    } else if cli_transcript {
        resolve_qoder_cli_user_identity(ctx.env)
    } else if ctx.agent_id == "qoder" {
        payload.extra.as_ref().and_then(extract_user_identity)
    } else {
        None
    };
    let Some(range) = line_range(
        ctx.env,
        &ctx.agent_id,
        Path::new(&payload.transcript),
        &payload.session,
        snapshot.line_count,
    ) else {
        return;
    };
    let parsed = slice_kept(&snapshot, range.start, range.end);
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!(
            "Read {} lines (range: {}-{})",
            parsed.len(),
            range.start,
            range.end
        ),
    );
    if parsed.is_empty() {
        handle_empty_range(ctx, &payload, identity.as_ref());
        return;
    }
    let has_last_prompt = parsed.iter().any(|row| typ(row) == "last-prompt");
    if !has_last_prompt {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!(
                "Transcript incomplete ({} lines, no last-prompt marker). Spawning background retry in 5s.",
                parsed.len()
            ),
        );
        spawn_delayed_retry(
            ctx,
            &payload.transcript,
            &payload.session,
            payload.cwd.as_deref(),
            range.end,
            identity.as_ref(),
        );
        return;
    }
    if !try_acquire_retry_lock(
        ctx.env,
        &ctx.agent_id,
        Path::new(&payload.transcript),
        &payload.session,
    ) {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!(
                "Stop deferred: transcript lock held for {}",
                payload.transcript
            ),
        );
        spawn_delayed_retry(
            ctx,
            &payload.transcript,
            &payload.session,
            payload.cwd.as_deref(),
            range.end,
            identity.as_ref(),
        );
        return;
    }
    let _guard = LockGuard {
        env: ctx.env,
        agent_id: &ctx.agent_id,
        transcript: PathBuf::from(&payload.transcript),
        active: true,
    };
    let locked_snapshot = read_snapshot(Path::new(&payload.transcript), false);
    let Some(locked_range) = line_range(
        ctx.env,
        &ctx.agent_id,
        Path::new(&payload.transcript),
        &payload.session,
        locked_snapshot.line_count,
    ) else {
        return;
    };
    let committed = process_transcript(
        ctx,
        Path::new(&payload.transcript),
        &payload.session,
        locked_range.start..locked_range.end,
        identity.as_ref(),
        payload.cwd.as_deref(),
        ProcessOpts {
            delay_applied: false,
            range_reason: locked_range.reason.to_string(),
            fixed_turn_window: false,
            snapshot: locked_snapshot,
        },
    );
    if !committed {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!("Stop commit failed; rescheduling {}", payload.transcript),
        );
        spawn_delayed_retry(
            ctx,
            &payload.transcript,
            &payload.session,
            payload.cwd.as_deref(),
            range.end,
            identity.as_ref(),
        );
    }
}

fn handle_empty_range(ctx: &HookCtx<'_>, payload: &Payload, identity: Option<&UserIdentity>) {
    if !try_acquire_retry_lock(
        ctx.env,
        &ctx.agent_id,
        Path::new(&payload.transcript),
        &payload.session,
    ) {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!(
                "Empty range deferred: transcript lock held for {}",
                payload.transcript
            ),
        );
        return;
    }
    let _guard = LockGuard {
        env: ctx.env,
        agent_id: &ctx.agent_id,
        transcript: PathBuf::from(&payload.transcript),
        active: true,
    };
    let locked_snapshot = read_snapshot(Path::new(&payload.transcript), false);
    let Some(locked_range) = line_range(
        ctx.env,
        &ctx.agent_id,
        Path::new(&payload.transcript),
        &payload.session,
        locked_snapshot.line_count,
    ) else {
        return;
    };
    let locked_rows = slice_kept(&locked_snapshot, locked_range.start, locked_range.end);
    if locked_rows.is_empty() {
        update_line_record(
            ctx.env,
            &ctx.agent_id,
            Path::new(&payload.transcript),
            &payload.session,
            locked_range.end,
        );
    } else {
        spawn_delayed_retry(
            ctx,
            &payload.transcript,
            &payload.session,
            payload.cwd.as_deref(),
            locked_range.end,
            identity,
        );
    }
}

fn run_retry(ctx: &HookCtx<'_>, args: &[String], stdin: &[u8]) {
    let transcript = flag_value(args, "--transcript").unwrap_or_default();
    let session = flag_value(args, "--session").unwrap_or_default();
    if transcript.is_empty() || session.is_empty() {
        return;
    }
    let cwd = flag_value(args, "--cwd");
    let trigger_end = flag_value(args, "--trigger-end-line").and_then(|value| parse_js_int(&value));
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("Retry: processing {transcript} for session {session}"),
    );
    let identity = read_retry_user_identity(stdin);
    let transcript_path = PathBuf::from(&transcript);
    let wait_started = Instant::now();
    if !acquire_retry_lock(ctx.env, &ctx.agent_id, &transcript_path, &session) {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!("Retry lock wait timed out; rescheduling {transcript}"),
        );
        spawn_delayed_retry(
            ctx,
            &transcript,
            &session,
            cwd.as_deref(),
            trigger_end.unwrap_or(0).max(0) as usize,
            identity.as_ref(),
        );
        return;
    }
    let _guard = LockGuard {
        env: ctx.env,
        agent_id: &ctx.agent_id,
        transcript: transcript_path.clone(),
        active: true,
    };
    if let Some(delay) = positive_retry_delay(ctx.env) {
        let elapsed = wait_started.elapsed().as_millis() as i64;
        if delay > elapsed {
            std::thread::sleep(Duration::from_millis((delay - elapsed) as u64));
        }
    }
    if let Some(trigger_end) = trigger_end {
        let interval = clamp_integer(
            ctx.env
                .get("HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS")
                .map(String::as_str),
            1_000,
            10,
            5_000,
        );
        let mut previous_key: Option<String> = None;
        let mut window = waiting("unknown");
        let mut snapshot = read_snapshot(&transcript_path, true);
        let mut range = LineRange {
            start: 0,
            end: 0,
            reason: "incremental",
        };
        for poll in 0..3 {
            snapshot = read_snapshot(&transcript_path, true);
            match line_range(
                ctx.env,
                &ctx.agent_id,
                &transcript_path,
                &session,
                snapshot.line_count,
            ) {
                Some(info) => range = info,
                None => return,
            }
            window = find_triggered_turn_window(&snapshot, trigger_end);
            if window.complete {
                break;
            }
            let (key, updated) = assess_stable_eof(previous_key.as_deref(), window, &snapshot);
            previous_key = key;
            window = updated;
            if window.complete {
                break;
            }
            if poll + 1 < 3 {
                std::thread::sleep(Duration::from_millis(interval as u64));
            }
        }
        if !window.complete {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!(
                    "Retry deferred: target turn is not complete ({})",
                    window.reason
                ),
            );
            return;
        }
        let (Some(start_line), Some(end_line), Some(stop_line)) =
            (window.start_line, window.end_line, window.stop_line)
        else {
            return;
        };
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!(
                "Retry target window: trigger={trigger_end}, range={start_line}-{end_line}, stop={stop_line}, terminal={}",
                window.reason
            ),
        );
        if range.start >= end_line {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!(
                    "Retry skipped: cursor {} already passed target {end_line}",
                    range.start
                ),
            );
            return;
        }
        let committed = process_transcript(
            ctx,
            &transcript_path,
            &session,
            start_line..end_line,
            identity.as_ref(),
            cwd.as_deref(),
            ProcessOpts {
                delay_applied: true,
                range_reason: range.reason.to_string(),
                fixed_turn_window: true,
                snapshot,
            },
        );
        if !committed {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!("Retry commit failed; rescheduling {transcript}"),
            );
            spawn_delayed_retry(
                ctx,
                &transcript,
                &session,
                cwd.as_deref(),
                trigger_end.max(0) as usize,
                identity.as_ref(),
            );
        }
        return;
    }

    let snapshot = read_snapshot(&transcript_path, false);
    let Some(range) = line_range(
        ctx.env,
        &ctx.agent_id,
        &transcript_path,
        &session,
        snapshot.line_count,
    ) else {
        return;
    };
    let committed = process_transcript(
        ctx,
        &transcript_path,
        &session,
        range.start..range.end,
        identity.as_ref(),
        cwd.as_deref(),
        ProcessOpts {
            delay_applied: true,
            range_reason: range.reason.to_string(),
            fixed_turn_window: false,
            snapshot,
        },
    );
    if !committed {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!("Retry commit failed; rescheduling {transcript}"),
        );
        spawn_delayed_retry(
            ctx,
            &transcript,
            &session,
            cwd.as_deref(),
            0,
            identity.as_ref(),
        );
    }
}

/// Context already resolved by the collector; this adapter performs no file,
/// configuration, history, retry, or process operations.
pub struct CollectedTranscriptTurnContext<'a> {
    pub agent_id: &'a str,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub runtime_user: &'a str,
    pub cwd: Option<&'a str>,
    pub user_name: Option<&'a str>,
    pub user_email: Option<&'a str>,
    pub agent_name: Option<&'a str>,
    pub span_attributes: &'a serde_json::Map<String, Value>,
    pub resource_attributes: &'a serde_json::Map<String, Value>,
}

pub fn build_collected_transcript_turn(
    rows: &[Value],
    context: CollectedTranscriptTurnContext<'_>,
) -> Vec<Value> {
    let name = context.user_name.map(|s| Value::String(s.to_owned()));
    let email = context.user_email.map(|s| Value::String(s.to_owned()));
    let identity = identity_from_fields(name.as_ref(), email.as_ref());
    let stamp = Stamp {
        span: context.span_attributes.clone(),
        resources: context.resource_attributes.clone(),
        agent_name: context
            .agent_name
            .map(str::to_owned)
            .or_else(|| agent_name_patch(context.resource_attributes)),
    };
    let (_, content) = split_progress_content(rows);
    let boundaries = build_llm_boundaries(&content);
    build_events_from_boundaries_with_tool_values(
        &boundaries,
        &content,
        rows,
        context.turn_id,
        BoundaryContext {
            session_id: context.session_id,
            agent_id: context.agent_id,
            runtime_user: context.runtime_user,
            identity: identity.as_ref(),
            cwd: context.cwd,
            stamp: &stamp,
        },
        true,
    )
    .into_iter()
    .map(|mut record| {
        // New collector-owned records always expose the account projection;
        // compatibility inline output keeps its older optional-field behavior.
        record.entry("user.name").or_insert(json!(""));
        record.entry("user.email").or_insert(json!(""));
        Value::Object(record)
    })
    .collect()
}

/// Same configured-id/hostname policy used by Hook normalization. Account IDs
/// from a transcript or status payload never become the collection identity.
pub(crate) fn resolve_collected_qoder_user_id(data: &Path) -> String {
    let mut env = Env::new();
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        data.to_string_lossy().into_owned(),
    );
    for key in ["AGENT_DATA_COLLECTION_CONFIG", "LOONGSUITE_PILOT_USER_ID"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    load_runtime_config(&env).user_id
}

pub fn qoder_is_real_user_prompt(row: &Value) -> bool {
    is_real_user_prompt(row) && !is_control_user_row(row)
}

pub fn qoder_is_control_user_row(row: &Value) -> bool {
    is_control_user_row(row)
}

pub fn qoder_has_cn_terminal(rows: &[Value]) -> bool {
    let progress: Vec<_> = rows
        .iter()
        .filter(|row| typ(row) == "progress")
        .map(|row| Progress {
            hook_event: hook_event(Some(row)).to_owned(),
        })
        .collect();
    has_qoder_cn_terminal(&progress, rows)
}

pub fn qoder_legacy_retry_lock_path(data: &Path, transcript: &Path) -> PathBuf {
    data.join("hooks").join(".retry-locks").join(format!(
        "{}.lock",
        sha1_hex(transcript.to_string_lossy().as_bytes())
    ))
}

/// Compatibility CLI identity lookup for native integrations. New Hook notices
/// resolve the explicit product/version at publication; Source never guesses it.
pub async fn resolve_qoder_collector_cli_identity(data: &Path) -> Option<Value> {
    resolve_qoder_collector_cli_identity_with_env(data, std::env::vars().collect()).await
}

/// Explicit environment for isolated callers. Reuses the existing bounded native
/// status/cache implementation and moves its filesystem/child work off the input.
pub async fn resolve_qoder_collector_cli_identity_with_env(
    data: &Path,
    mut env: std::collections::HashMap<String, String>,
) -> Option<Value> {
    env.insert(
        "LOONGSUITE_PILOT_DATA_DIR".into(),
        data.to_string_lossy().into_owned(),
    );
    let identity = tokio::task::spawn_blocking(move || resolve_qoder_cli_user_identity(&env))
        .await
        .ok()
        .flatten()?;
    let mut value = Obj::new();
    if let Some(name) = identity.name {
        value.insert("name".into(), Value::String(name));
    }
    if let Some(email) = identity.email {
        value.insert("email".into(), Value::String(email));
    }
    Some(Value::Object(value))
}

fn process_transcript(
    ctx: &HookCtx<'_>,
    transcript: &Path,
    session: &str,
    range: std::ops::Range<usize>,
    identity: Option<&UserIdentity>,
    cwd: Option<&str>,
    opts: ProcessOpts,
) -> bool {
    if !opts.delay_applied {
        if let Some(delay) = positive_retry_delay(ctx.env) {
            std::thread::sleep(Duration::from_millis(delay as u64));
        }
    }
    let snapshot = opts.snapshot;
    let mut end = range.end;
    let mut start = range.start;
    if !opts.fixed_turn_window {
        if snapshot.line_count > end {
            end = snapshot.line_count;
        }
        if opts.range_reason == "incremental" {
            end = find_incremental_turn_end(&snapshot, start, end);
        }
    }
    let mut parsed = slice_kept(&snapshot, start, end);
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("Processing {} lines (range: {start}-{end})", parsed.len()),
    );
    if parsed.is_empty() {
        update_line_record(ctx.env, &ctx.agent_id, transcript, session, end);
        return true;
    }
    let (progress, mut content) = split_progress_content(&parsed);
    if ctx.agent_id == "qoder-cn" {
        if !has_qoder_cn_terminal(&progress, &parsed) {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                "Transcript not yet complete (no terminal marker). Skipping processing.",
            );
            return true;
        }
        if opts.fixed_turn_window {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!("Processing precise QoderCN turn window {start}-{end}"),
            );
        } else {
            start = 0;
            parsed = slice_kept(&snapshot, start, end);
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!(
                    "Reprocessing snapshot from 0-{end} ({} lines)",
                    parsed.len()
                ),
            );
            content = split_progress_content(&parsed).1;
        }
    }
    let all_turns = split_turns(&content);
    let turns = select_turn_segments(all_turns, &opts.range_reason, &ctx.agent_id);
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("Split transcript segment into {} turn(s)", turns.len()),
    );
    let mut records = Vec::new();
    for turn in &turns {
        let turn_id = uuid_v4();
        let boundaries = build_llm_boundaries(turn);
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!("detected {} LLM call(s)", boundaries.len()),
        );
        records.extend(build_events_from_boundaries(
            &boundaries,
            turn,
            &parsed,
            &turn_id,
            BoundaryContext {
                session_id: session,
                agent_id: &ctx.agent_id,
                runtime_user: &ctx.user_id,
                identity,
                cwd,
                stamp: &ctx.stamp,
            },
        ));
    }
    let cursor_mode = if opts.range_reason == "incremental" {
        "incremental"
    } else {
        "bootstrap"
    };
    let batch_id = uuid_v4();
    for record in &mut records {
        record.insert(
            "agent.transcript.cursor_mode".into(),
            Value::String(cursor_mode.into()),
        );
        record.insert(
            "agent.transcript.cursor_reason".into(),
            Value::String(opts.range_reason.clone()),
        );
        record.insert(
            "agent.transcript.cursor_batch_id".into(),
            Value::String(batch_id.clone()),
        );
    }
    if !append_history(ctx.env, &ctx.agent_id, &ctx.log_prefix, &records) {
        return false;
    }
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("Appended {} rows", records.len()),
    );
    update_line_record(ctx.env, &ctx.agent_id, transcript, session, end);
    true
}

struct Payload {
    transcript: String,
    session: String,
    cwd: Option<String>,
    extra: Option<Obj>,
    desktop_invocation: bool,
}

fn parse_payload(ctx: &HookCtx<'_>, stdin: &[u8]) -> Option<Payload> {
    let raw = decode_payload(stdin);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("stdin payload: {} bytes", raw.len()),
    );
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(err) => {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!("Failed to parse stdin JSON: {err}"),
            );
            return None;
        }
    };
    let obj = value.as_object()?;
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!(
            "event: {}, session: {}",
            obj.get("hook_event_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            obj.get("session_id").and_then(Value::as_str).unwrap_or("")
        ),
    );
    if js_truthy(obj.get("stop_hooks_active")) {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            "stop_hooks_active=true, exiting to avoid recursion",
        );
        return None;
    }
    let transcript = nonempty_str(obj.get("transcript_path")).unwrap_or("");
    let session = nonempty_str(obj.get("session_id"))
        .or_else(|| nonempty_str(obj.get("conversation_id")))
        .unwrap_or("");
    if transcript.is_empty() || session.is_empty() {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            "No transcript_path or session_id in payload",
        );
        return None;
    }
    if !Path::new(transcript).exists() {
        log_debug(
            ctx.env,
            &ctx.agent_id,
            &format!("Transcript file not found: {transcript}"),
        );
        return None;
    }
    let cwd = nonempty_str(obj.get("cwd")).map(str::to_owned);
    let extra = obj.get("extra").and_then(Value::as_object).cloned();
    Some(Payload {
        transcript: transcript.to_string(),
        session: session.to_string(),
        cwd,
        extra,
        desktop_invocation: obj
            .get("parent_business_info")
            .and_then(Value::as_object)
            .and_then(|parent| parent.get("product"))
            .and_then(Value::as_str)
            == Some("app"),
    })
}

fn parse_agent_args(args: &[String]) -> (String, String) {
    let mut agent_id = flag_value(args, "--agent-id").unwrap_or_default();
    if agent_id.is_empty() {
        agent_id = argv_hook_agent().unwrap_or_default();
    }
    if agent_id.is_empty() {
        agent_id = "qoder".into();
    }
    let log_prefix = flag_value(args, "--log-prefix")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| agent_id.clone());
    (agent_id, log_prefix)
}

fn argv_hook_agent() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == "hook-process")?;
    let agent = args.get(index + 1)?;
    if agent.is_empty() || agent.starts_with('-') {
        None
    } else {
        Some(agent.clone())
    }
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1)
        .cloned()
        .filter(|value| !value.is_empty())
}

fn build_stamp(env: &Env) -> Stamp {
    let resources = collect_resource_attributes(env, "qoder");
    Stamp {
        span: parse_span_attributes(env, "qoder", true),
        agent_name: agent_name_patch(&resources),
        resources,
    }
}

fn spawn_delayed_retry(
    ctx: &HookCtx<'_>,
    transcript: &str,
    session: &str,
    cwd: Option<&str>,
    trigger_end_line: usize,
    identity: Option<&UserIdentity>,
) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(exe);
    command
        .arg("hook-process")
        .arg(&ctx.agent_id)
        .arg("--agent-id")
        .arg(&ctx.agent_id)
        .arg("--log-prefix")
        .arg(&ctx.log_prefix)
        .arg("--retry")
        .arg("--transcript")
        .arg(transcript)
        .arg("--session")
        .arg(session)
        .arg("--trigger-end-line")
        .arg(trigger_end_line.to_string());
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        command.arg("--cwd").arg(cwd);
    }
    command
        .envs(
            ctx.env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .env("HOOK_RETRY_DELAY", "5000")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            log_debug(
                ctx.env,
                &ctx.agent_id,
                &format!("ERROR spawning retry: {err}"),
            );
            return;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let body = identity.map(identity_json).unwrap_or_default();
        let _ = stdin.write_all(body.as_bytes());
    }
    log_debug(
        ctx.env,
        &ctx.agent_id,
        &format!("Spawned retry subprocess (PID {})", child.id()),
    );
}

fn detach_command(command: &mut Command) {
    #[cfg(not(unix))]
    let _ = command;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                extern "C" {
                    fn setsid() -> i32;
                }
                let _ = setsid();
                Ok(())
            });
        }
    }
}

fn identity_json(identity: &UserIdentity) -> String {
    serde_json::to_string(&json!({
        "name": identity.name.as_deref().unwrap_or_default(),
        "email": identity.email.as_deref().unwrap_or_default(),
    }))
    .unwrap_or_default()
}

fn positive_retry_delay(env: &Env) -> Option<i64> {
    let raw = env
        .get("HOOK_RETRY_DELAY")
        .map(String::as_str)
        .unwrap_or("");
    let raw = if raw.is_empty() { "0" } else { raw };
    let parsed = parse_js_int(raw)?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}

fn read_snapshot(path: &Path, include_hash: bool) -> Snapshot {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Snapshot {
                line_count: 0,
                rows: Vec::new(),
                content_hash: String::new(),
                reason: "transcript-missing",
            };
        }
        Err(_) => {
            return Snapshot {
                line_count: 0,
                rows: Vec::new(),
                content_hash: String::new(),
                reason: "read-failed",
            };
        }
    };
    let content = String::from_utf8_lossy(&bytes);
    let line_count = if content.is_empty() {
        0
    } else if content.ends_with('\n') {
        content.bytes().filter(|byte| *byte == b'\n').count()
    } else {
        content.bytes().filter(|byte| *byte == b'\n').count() + 1
    };
    // `split` yields one more piece than the newline count when the file ends
    // with a newline. The cursor counts every physical line, including a final
    // unterminated line, and drops the empty piece after a trailing newline.
    let mut rows = vec![None; line_count];
    for (index, line) in content.split('\n').take(line_count).enumerate() {
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            rows[index] = Some(value);
        }
    }
    let content_hash = if include_hash {
        sha1_hex(content.as_bytes())
    } else {
        String::new()
    };
    Snapshot {
        line_count,
        rows,
        content_hash,
        reason: "ok",
    }
}

fn slice_kept(snapshot: &Snapshot, start: usize, end: usize) -> Vec<Value> {
    snapshot
        .rows
        .iter()
        .take(end)
        .skip(start)
        .filter_map(|row| row.as_ref().filter(|value| js_truthy(Some(value))).cloned())
        .collect()
}

fn line_range(
    env: &Env,
    agent_id: &str,
    transcript: &Path,
    session: &str,
    current: usize,
) -> Option<LineRange> {
    let record = load_line_record(env, agent_id, session);
    let recorded_count = json_f64(record.get("last_line_count")).filter(|value| *value >= 0.0);
    let mut reason = if recorded_count.is_some() {
        "incremental"
    } else {
        "missing-cursor"
    };
    let mut last = recorded_count.unwrap_or(0.0).floor() as usize;
    let recorded_session = nonempty_str(record.get("session_id")).unwrap_or("");
    let recorded_transcript = nonempty_str(record.get("transcript_path")).unwrap_or("");
    if !recorded_session.is_empty() && recorded_session != session {
        log_debug(
            env,
            agent_id,
            &format!("Session changed: {recorded_session} -> {session}, reset to 0"),
        );
        last = 0;
        reason = "session-changed";
    }
    let transcript_text = transcript.to_string_lossy();
    if !recorded_transcript.is_empty() && recorded_transcript != transcript_text {
        log_debug(
            env,
            agent_id,
            &format!("Transcript changed for session {session}, reset to 0"),
        );
        last = 0;
        reason = "transcript-changed";
    }
    if current == 0 {
        log_debug(env, agent_id, "Transcript is empty");
        return None;
    }
    if current == last {
        log_debug(env, agent_id, &format!("No new lines (count: {current})"));
        return None;
    }
    if current < last {
        log_debug(
            env,
            agent_id,
            &format!("File truncated ({last} -> {current}), sending all"),
        );
        last = 0;
        reason = "truncated";
    }
    log_debug(
        env,
        agent_id,
        &format!("Range: {last} -> {current} ({reason})"),
    );
    Some(LineRange {
        start: last,
        end: current,
        reason,
    })
}

fn load_line_record(env: &Env, agent_id: &str, session: &str) -> Value {
    if session.is_empty() {
        return Value::Object(Obj::new());
    }
    reconcile_aggregate_line_record(env, agent_id, session);
    read_json_object(&session_line_record_file(env, agent_id, session))
        .unwrap_or_else(|| Value::Object(Obj::new()))
}

fn reconcile_aggregate_line_record(env: &Env, agent_id: &str, session: &str) {
    let target = session_line_record_file(env, agent_id, session);
    for source in [
        aggregate_line_record_file(env, agent_id),
        legacy_line_record_file(env, agent_id),
    ] {
        let Some(Value::Object(records)) = read_json_object(&source) else {
            continue;
        };
        for (transcript_path, value) in records {
            let Some(value) = value.as_object() else {
                continue;
            };
            let Some(session_id) = nonempty_str(value.get("session_id")) else {
                continue;
            };
            if session_id != session {
                continue;
            }
            let mut candidate = value.clone();
            candidate.insert("session_id".into(), Value::String(session_id.to_string()));
            candidate.insert(
                "transcript_path".into(),
                Value::String(transcript_path.clone()),
            );
            let existing = read_json_object(&target);
            if existing.is_none()
                || existing.as_ref().is_some_and(|existing| {
                    line_record_newer(&Value::Object(candidate.clone()), existing)
                })
            {
                save_json_object(&target, &Value::Object(candidate));
            }
        }
    }
}

fn line_record_newer(candidate: &Value, existing: &Value) -> bool {
    let same_transcript = nonempty_str(candidate.get("transcript_path"))
        == nonempty_str(existing.get("transcript_path"));
    if same_transcript {
        return match (
            json_f64(candidate.get("last_line_count")),
            json_f64(existing.get("last_line_count")),
        ) {
            (Some(candidate), Some(existing)) => candidate > existing,
            _ => false,
        };
    }
    let candidate_updated = nonempty_str(candidate.get("updated_at")).unwrap_or("");
    let existing_updated = nonempty_str(existing.get("updated_at")).unwrap_or("");
    !candidate_updated.is_empty()
        && (existing_updated.is_empty() || candidate_updated > existing_updated)
}

fn update_line_record(
    env: &Env,
    agent_id: &str,
    transcript: &Path,
    session: &str,
    end_line: usize,
) {
    let transcript_text = transcript.to_string_lossy().into_owned();
    let record = json!({
        "session_id": session,
        "transcript_path": transcript_text,
        "last_line_count": end_line,
        "updated_at": local_stamp_seconds(),
    });
    let ok = save_json_object(&session_line_record_file(env, agent_id, session), &record);
    if ok {
        log_debug(
            env,
            agent_id,
            &format!("Updated record: {transcript_text} -> {end_line} lines"),
        );
        for shadow in rollback_shadow_files(env, agent_id) {
            if !update_aggregate_shadow(&shadow, &transcript_text, &record) {
                log_debug(
                    env,
                    agent_id,
                    &format!(
                        "Warning: Failed to update rollback cursor shadow {}",
                        shadow.display()
                    ),
                );
            }
        }
    } else {
        log_debug(env, agent_id, "Warning: Failed to save line records");
    }
}

fn update_aggregate_shadow(file: &Path, transcript: &str, record: &Value) -> bool {
    let lock = PathBuf::from(format!("{}.lock", file.display()));
    let updated = with_file_lock(&lock, 1_000, 30_000, || {
        let mut records = match read_json_object(file) {
            Some(Value::Object(map)) => map,
            _ => Obj::new(),
        };
        if let Some(existing) = records.get(transcript).and_then(Value::as_object) {
            if nonempty_str(existing.get("session_id")) == nonempty_str(record.get("session_id")) {
                if let (Some(old), Some(new)) = (
                    json_f64(existing.get("last_line_count")),
                    json_f64(record.get("last_line_count")),
                ) {
                    if old > new {
                        return true;
                    }
                }
            }
        }
        let mut shadow = Obj::new();
        if let Some(session_id) = nonempty_str(record.get("session_id")) {
            shadow.insert("session_id".into(), Value::String(session_id.to_string()));
        }
        if let Some(count) = record.get("last_line_count") {
            shadow.insert("last_line_count".into(), count.clone());
        }
        if let Some(updated_at) = nonempty_str(record.get("updated_at")) {
            shadow.insert("updated_at".into(), Value::String(updated_at.to_string()));
        }
        records.insert(transcript.to_string(), Value::Object(shadow));
        save_json_object(file, &Value::Object(records))
    });
    updated.unwrap_or(false)
}

fn rollback_shadow_files(env: &Env, agent_id: &str) -> Vec<PathBuf> {
    vec![
        aggregate_line_record_file(env, agent_id),
        legacy_line_record_file(env, agent_id),
    ]
}

fn session_line_record_file(env: &Env, agent_id: &str, session: &str) -> PathBuf {
    data_dir(env)
        .join("state")
        .join("hooks")
        .join(format!("{agent_id}-line-records"))
        .join(format!("{}.json", sha256_hex(session.as_bytes())))
}

fn aggregate_line_record_file(env: &Env, agent_id: &str) -> PathBuf {
    data_dir(env)
        .join("state")
        .join("hooks")
        .join(format!("{agent_id}-line-records.json"))
}

fn legacy_line_record_file(env: &Env, agent_id: &str) -> PathBuf {
    data_dir(env)
        .join("hooks")
        .join(format!(".line_records.{agent_id}.json"))
}

fn read_json_object(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    if value.is_object() {
        Some(value)
    } else {
        None
    }
}

fn save_json_object(path: &Path, value: &Value) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    let tmp = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        now_ms()
    ));
    let body = match serde_json::to_string_pretty(value) {
        Ok(body) => body,
        Err(_) => return false,
    };
    if fs::write(&tmp, body).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

fn append_history(env: &Env, agent_id: &str, log_prefix: &str, records: &[Obj]) -> bool {
    if records.is_empty() {
        return filter_workspace_records(env, records, agent_id).is_ok();
    }
    let filtered = match filter_workspace_records(env, records, agent_id) {
        Ok(filtered) => filtered,
        Err(err) => {
            log_debug(
                env,
                agent_id,
                &format!("ERROR appending rows to history: {err}"),
            );
            return false;
        }
    };
    if filtered.is_empty() {
        return true;
    }
    let mut lines = Vec::with_capacity(filtered.len());
    for record in filtered {
        match serde_json::to_string(&Value::Object(record)) {
            Ok(line) => lines.push(line),
            Err(err) => {
                log_debug(
                    env,
                    agent_id,
                    &format!("ERROR appending rows to history: {err}"),
                );
                return false;
            }
        }
    }
    let history = data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("history")
        .join(format!("{log_prefix}-{}.jsonl", local_date()));
    let lock = PathBuf::from(format!("{}.lock", history.display()));
    match with_file_lock(&lock, 15_000, 10_000, || {
        append_history_rows(env, agent_id, log_prefix, &lines)
    }) {
        Some(true) => true,
        Some(false) => {
            log_debug(
                env,
                agent_id,
                "ERROR appending rows to history: write failed",
            );
            false
        }
        None => {
            log_debug(
                env,
                agent_id,
                &format!(
                    "ERROR appending rows to history: timed out waiting for {}",
                    lock.display()
                ),
            );
            false
        }
    }
}

fn retry_lock_dir(env: &Env, agent_id: &str) -> PathBuf {
    let _ = agent_id;
    data_dir(env).join("hooks").join(".retry-locks")
}

fn retry_lock_path(env: &Env, agent_id: &str, transcript: &Path) -> PathBuf {
    let hash = sha1_hex(transcript.to_string_lossy().as_bytes());
    retry_lock_dir(env, agent_id).join(format!("{hash}.lock"))
}

fn try_acquire_retry_lock(env: &Env, agent_id: &str, transcript: &Path, session: &str) -> bool {
    let dir = retry_lock_dir(env, agent_id);
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let path = retry_lock_path(env, agent_id, transcript);
    let payload = json!({
        "pid": std::process::id(),
        "sessionId": session,
        "startedAt": now_ms(),
    })
    .to_string();
    if write_exclusive(&path, &payload) {
        return true;
    }
    if lock_is_stale(read_json_object(&path).as_ref()) {
        let _ = fs::remove_file(&path);
        return write_exclusive(&path, &payload);
    }
    false
}

fn write_exclusive(path: &Path, payload: &str) -> bool {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(payload.as_bytes()).is_ok(),
        Err(_) => false,
    }
}

fn acquire_retry_lock(env: &Env, agent_id: &str, transcript: &Path, session: &str) -> bool {
    let wait = clamp_integer(
        env.get("HOOK_RETRY_LOCK_WAIT_MS").map(String::as_str),
        RETRY_LOCK_WAIT_TIMEOUT_MS,
        0,
        60_000,
    );
    let poll = clamp_integer(
        env.get("HOOK_RETRY_LOCK_POLL_MS").map(String::as_str),
        RETRY_LOCK_POLL_INTERVAL_MS,
        5,
        1_000,
    );
    let deadline = Instant::now() + Duration::from_millis(wait.max(0) as u64);
    loop {
        if try_acquire_retry_lock(env, agent_id, transcript, session) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(poll.max(0) as u64)));
    }
}

fn release_retry_lock(env: &Env, agent_id: &str, transcript: &Path) {
    let path = retry_lock_path(env, agent_id, transcript);
    let Some(existing) = read_json_object(&path) else {
        return;
    };
    if json_u32(existing.get("pid")) == Some(std::process::id()) {
        let _ = fs::remove_file(path);
    }
}

fn lock_is_stale(lock: Option<&Value>) -> bool {
    let Some(lock) = lock else {
        return true;
    };
    let started = json_f64(lock.get("startedAt")).unwrap_or(0.0) as i64;
    if now_ms().saturating_sub(started) > RETRY_LOCK_MAX_AGE_MS {
        return true;
    }
    !pid_alive(json_u32(lock.get("pid")).unwrap_or(0))
}

fn pid_alive(pid: u32) -> bool {
    // The shared probe handles EPERM, oversized Unix PIDs and terminated
    // Windows process handles; a non-Unix constant would keep dead retry locks.
    crate::utils::is_process_alive(pid)
}

fn waiting(reason: &str) -> TurnWindow {
    TurnWindow {
        complete: false,
        reason: reason.to_string(),
        start_line: None,
        stop_line: None,
        end_line: None,
    }
}

fn find_triggered_turn_window(snapshot: &Snapshot, trigger_end_line: i64) -> TurnWindow {
    if snapshot.reason != "ok" {
        return waiting(if snapshot.reason.is_empty() {
            "read-failed"
        } else {
            snapshot.reason
        });
    }
    let rows = &snapshot.rows;
    let limit = snapshot.line_count;
    let trigger_limit = (trigger_end_line.max(0) as usize).min(limit);
    let mut trigger_prompt = None;
    for index in (0..trigger_limit).rev() {
        if hook_event(rows[index].as_ref()) == "UserPromptSubmit" {
            trigger_prompt = Some(index);
            break;
        }
    }
    if trigger_prompt.is_none() {
        for index in (0..trigger_limit).rev() {
            if rows[index].as_ref().is_some_and(is_real_user_prompt) {
                trigger_prompt = Some(index);
                break;
            }
        }
    }
    let Some(trigger_prompt) = trigger_prompt else {
        return waiting("prompt-not-found");
    };
    let mut stop_line = None;
    let mut assistant_stop = None;
    for (index, row) in rows.iter().enumerate().take(limit).skip(trigger_prompt + 1) {
        let row = row.as_ref();
        let event = hook_event(row);
        if event == "Stop" {
            stop_line = Some(index);
            break;
        }
        if assistant_stop.is_none()
            && row.is_some_and(|row| {
                typ(row) == "assistant" && stop_reason(row).is_some_and(is_terminal_stop_reason)
            })
        {
            assistant_stop = Some(index);
            continue;
        }
        if index >= trigger_limit
            && (event == "UserPromptSubmit" || row.is_some_and(is_real_user_prompt))
        {
            if assistant_stop.is_none() {
                return waiting("next-prompt-before-stop");
            }
            break;
        }
    }
    if stop_line.is_none() {
        stop_line = assistant_stop;
    }
    let Some(stop_line) = stop_line else {
        return waiting("stop-not-found");
    };
    let mut start_line = None;
    for index in (0..stop_line).rev() {
        if hook_event(rows[index].as_ref()) == "UserPromptSubmit" {
            start_line = Some(index);
            break;
        }
    }
    if let Some(start) = start_line {
        if !rows[start..stop_line]
            .iter()
            .any(|row| row.as_ref().is_some_and(is_real_user_prompt))
        {
            for index in (0..start).rev() {
                let row = rows[index].as_ref();
                if row.is_some_and(|row| matches!(typ(row), "assistant" | "last-prompt"))
                    || matches!(hook_event(row), "Stop" | "SessionEnd")
                {
                    break;
                }
                if row.is_some_and(is_real_user_prompt) {
                    start_line = Some(index);
                    break;
                }
            }
        }
    }
    if start_line.is_none() {
        for index in (0..stop_line).rev() {
            if rows[index].as_ref().is_some_and(is_real_user_prompt) {
                start_line = Some(index);
                break;
            }
        }
    }
    let Some(start_line) = start_line else {
        return waiting("turn-start-not-found");
    };
    for (index, row) in rows.iter().enumerate().take(limit).skip(stop_line + 1) {
        let row = row.as_ref();
        let event = hook_event(row);
        if event == "SessionEnd" {
            return TurnWindow {
                complete: true,
                reason: "session-end".into(),
                start_line: Some(start_line),
                stop_line: Some(stop_line),
                end_line: Some(index + 1),
            };
        }
        if row.is_some_and(|row| typ(row) == "last-prompt") {
            return TurnWindow {
                complete: true,
                reason: "last-prompt".into(),
                start_line: Some(start_line),
                stop_line: Some(stop_line),
                end_line: Some(index + 1),
            };
        }
        if event == "UserPromptSubmit" || row.is_some_and(is_real_user_prompt) {
            return TurnWindow {
                complete: true,
                reason: "next-prompt".into(),
                start_line: Some(start_line),
                stop_line: Some(stop_line),
                end_line: Some(index),
            };
        }
    }
    TurnWindow {
        complete: false,
        reason: "stop-at-eof".into(),
        start_line: Some(start_line),
        stop_line: Some(stop_line),
        end_line: Some(limit),
    }
}

fn assess_stable_eof(
    previous: Option<&str>,
    window: TurnWindow,
    snapshot: &Snapshot,
) -> (Option<String>, TurnWindow) {
    if window.reason != "stop-at-eof" || snapshot.content_hash.is_empty() {
        return (None, window);
    }
    let key = format!(
        "{}:{}:{}:{}",
        window.start_line.unwrap_or(0),
        window.stop_line.unwrap_or(0),
        window.end_line.unwrap_or(0),
        snapshot.content_hash
    );
    if previous != Some(key.as_str()) {
        return (Some(key), window);
    }
    (
        Some(key),
        TurnWindow {
            complete: true,
            reason: "stable-stop-eof".into(),
            ..window
        },
    )
}

fn find_incremental_turn_end(snapshot: &Snapshot, start: usize, scan_end: usize) -> usize {
    let mut saw_stop = false;
    let end = scan_end.min(snapshot.rows.len());
    for index in start..end {
        let Some(row) = snapshot.rows[index].as_ref() else {
            continue;
        };
        let event = hook_event(Some(row));
        if event == "Stop" {
            saw_stop = true;
        } else if saw_stop && (event == "UserPromptSubmit" || is_real_user_prompt(row)) {
            return index;
        }
    }
    scan_end
}

fn has_qoder_cn_terminal(progress: &[Progress], rows: &[Value]) -> bool {
    progress.iter().any(|event| event.hook_event == "Stop")
        || rows.iter().any(|row| typ(row) == "last-prompt")
        || rows.iter().any(|row| {
            typ(row) == "assistant" && stop_reason(row).is_some_and(is_terminal_stop_reason)
        })
}

fn is_terminal_stop_reason(reason: &str) -> bool {
    TERMINAL_STOP_REASONS.contains(&reason)
}

fn split_progress_content(parsed: &[Value]) -> (Vec<Progress>, Vec<Value>) {
    let mut progress = Vec::new();
    let mut content = Vec::new();
    let mut last = String::new();
    for row in parsed {
        if typ(row) == "progress" {
            let event = hook_event(Some(row)).to_string();
            if !event.is_empty() && event != last {
                progress.push(Progress {
                    hook_event: event.clone(),
                });
            }
            if !event.is_empty() {
                last = event;
            }
        } else {
            last.clear();
            if typ(row) == "user" || typ(row) == "assistant" {
                content.push(row.clone());
            }
        }
    }
    (progress, content)
}

fn select_turn_segments(
    mut turns: Vec<Vec<Value>>,
    reason: &str,
    agent_id: &str,
) -> Vec<Vec<Value>> {
    if reason != "incremental" || agent_id == "qoder-cn" {
        turns.pop().map(|turn| vec![turn]).unwrap_or_default()
    } else {
        turns
    }
}

fn split_turns(events: &[Value]) -> Vec<Vec<Value>> {
    let mut turns = Vec::new();
    let mut current = Vec::new();
    for row in events {
        if is_control_user_row(row) {
            continue;
        }
        if is_real_user_prompt(row) {
            if !current.is_empty() {
                turns.push(std::mem::take(&mut current));
            }
            current.push(row.clone());
        } else {
            current.push(row.clone());
        }
    }
    if !current.is_empty() {
        turns.push(current);
    }
    turns
}

fn build_llm_boundaries(content: &[Value]) -> Vec<Boundary> {
    struct Group {
        start: usize,
        end: usize,
        first: usize,
        last: usize,
    }
    let mut groups = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut current_start = 0usize;
    let mut current_tools = HashSet::<String>::new();
    let mut resolved = HashSet::<String>::new();
    let mut response_complete = false;
    let flush_at = |groups: &mut Vec<Group>,
                    current: &mut Vec<usize>,
                    current_start: &mut usize,
                    current_tools: &mut HashSet<String>,
                    resolved: &mut HashSet<String>,
                    response_complete: &mut bool,
                    end: usize| {
        if let (Some(first), Some(last)) = (current.first().copied(), current.last().copied()) {
            groups.push(Group {
                start: *current_start,
                end,
                first,
                last,
            });
        }
        current.clear();
        *current_start = 0;
        current_tools.clear();
        resolved.clear();
        *response_complete = false;
    };
    for (index, row) in content.iter().enumerate() {
        if typ(row) != "assistant" {
            if is_tool_result(row) {
                for block in message_blocks(row) {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if let Some(id) = nonempty_str(block.get("tool_use_id")) {
                            resolved.insert(id.to_string());
                        }
                    }
                }
            }
            continue;
        }
        if timestamp_order_nanos(timestamp_str(row).unwrap_or("")).is_none() {
            continue;
        }
        let tool_cycle_complete = !current.is_empty()
            && !current_tools.is_empty()
            && current_tools.iter().all(|id| resolved.contains(id));
        if response_complete || tool_cycle_complete {
            flush_at(
                &mut groups,
                &mut current,
                &mut current_start,
                &mut current_tools,
                &mut resolved,
                &mut response_complete,
                index,
            );
        }
        if current.is_empty() {
            current_start = index;
        }
        current.push(index);
        for block in message_blocks(row) {
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                if let Some(id) = nonempty_str(block.get("id")) {
                    current_tools.insert(id.to_string());
                }
            }
        }
        if stop_reason(row).is_some() {
            response_complete = true;
        }
    }
    flush_at(
        &mut groups,
        &mut current,
        &mut current_start,
        &mut current_tools,
        &mut resolved,
        &mut response_complete,
        content.len(),
    );
    groups
        .into_iter()
        .filter_map(|group| {
            let start_ts = timestamp_str(&content[group.first])?.to_string();
            let end_ts = timestamp_str(&content[group.last])?.to_string();
            if timestamp_order_nanos(&start_ts).is_none()
                || timestamp_order_nanos(&end_ts).is_none()
            {
                return None;
            }
            Some(Boundary {
                start_ts,
                end_ts,
                content_start: group.start,
                content_end: group.end,
            })
        })
        .collect()
}

struct BoundaryContext<'a> {
    session_id: &'a str,
    agent_id: &'a str,
    runtime_user: &'a str,
    identity: Option<&'a UserIdentity>,
    cwd: Option<&'a str>,
    stamp: &'a Stamp,
}

fn build_events_from_boundaries(
    boundaries: &[Boundary],
    content_events: &[Value],
    all_parsed: &[Value],
    turn_id: &str,
    context: BoundaryContext<'_>,
) -> Vec<Obj> {
    build_events_from_boundaries_with_tool_values(
        boundaries,
        content_events,
        all_parsed,
        turn_id,
        context,
        false,
    )
}

fn build_events_from_boundaries_with_tool_values(
    boundaries: &[Boundary],
    content_events: &[Value],
    all_parsed: &[Value],
    turn_id: &str,
    context: BoundaryContext<'_>,
    preserve_tool_values: bool,
) -> Vec<Obj> {
    let BoundaryContext {
        session_id,
        agent_id,
        runtime_user,
        identity,
        cwd,
        stamp,
    } = context;
    let mut records = Vec::new();
    let observed = now_unix_nanos();
    let user_row = content_events
        .iter()
        .find(|row| is_real_user_prompt(row))
        .or_else(|| {
            content_events
                .iter()
                .find(|row| typ(row) == "user" && !is_tool_result(row))
        });
    let user_text = user_row.map(extract_first_text).unwrap_or_default();
    let user_id = resolve_user_id(user_row.or_else(|| content_events.first()), runtime_user);
    let agent_type = infer_variant(user_row.or_else(|| content_events.first()), agent_id);
    let provider = infer_provider_name(None, None, &agent_type);
    if user_row.is_some() && !user_text.is_empty() {
        let user_model = content_events
            .iter()
            .find_map(row_model)
            .unwrap_or("unknown");
        let mut record = Obj::new();
        record.insert("event.id".into(), Value::String(uuid_v4()));
        record.insert("event.name".into(), Value::String("other".into()));
        record.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
        record.insert("gen_ai.session.id".into(), Value::String(session_id.into()));
        record.insert(
            "gen_ai.agent.type".into(),
            Value::String(agent_type.clone()),
        );
        record.insert(
            "gen_ai.provider.name".into(),
            Value::String(provider.clone()),
        );
        record.insert(
            "gen_ai.request.model".into(),
            Value::String(user_model.into()),
        );
        record.insert("user.id".into(), Value::String(user_id.clone()));
        record.insert(
            "gen_ai.input.messages_delta".into(),
            json!([{
                "role": "user",
                "parts": build_user_message_parts(&user_text, content_events, &agent_type),
            }]),
        );
        record.insert(
            "agent.source".into(),
            Value::String("qoder-transcript-hook".into()),
        );
        record.insert("agent.qoder.raw_type".into(), Value::String("user".into()));
        record.insert(
            "agent.qoder.content_type".into(),
            Value::String("text".into()),
        );
        record.insert(
            "time_unix_nano".into(),
            Value::String(timestamp_to_unix_nanos(user_row.and_then(timestamp_str))),
        );
        record.insert(
            "observed_time_unix_nano".into(),
            Value::String(observed.clone()),
        );
        if let Some(attachments) = cli_attachment_fields(&agent_type, user_row, all_parsed) {
            record.insert("agent.qoder.attachments".into(), attachments);
        }
        records.push(record);
    }
    if boundaries.is_empty() {
        let residual: Vec<&Value> = content_events
            .iter()
            .filter(|row| typ(row) == "assistant" || is_tool_result(row))
            .collect();
        build_legacy_events(&residual, turn_id, agent_id, runtime_user, &mut records);
        finalize_records(&mut records, cwd, identity, stamp);
        return records;
    }

    let mut tool_calls_for_next: Vec<ToolCall> = Vec::new();
    let mut tool_results_for_next: Vec<ToolResult> = Vec::new();
    let mut previous_response_nanos = String::new();
    for (index, boundary) in boundaries.iter().enumerate() {
        let step_id = format!("{turn_id}:s{}", index + 1);
        let content =
            &content_events[boundary.content_start..boundary.content_end.min(content_events.len())];
        let candidate_end = {
            let end = iso_to_unix_nanos(&boundary.end_ts);
            if end.is_empty() {
                iso_to_unix_nanos(&boundary.start_ts)
            } else {
                end
            }
        };
        let mut preceding = Vec::new();
        if index == 0 && user_row.and_then(timestamp_str).is_some() {
            preceding.push(iso_to_unix_nanos(
                user_row.and_then(timestamp_str).unwrap_or(""),
            ));
        } else {
            preceding.push(previous_response_nanos.clone());
            for result in &tool_results_for_next {
                if let Some(ts) = &result.result_ts {
                    preceding.push(iso_to_unix_nanos(ts));
                }
            }
        }
        let (start_nanos, response_end_nanos) = ordered_llm_interval(
            &preceding,
            &candidate_end,
            &iso_to_unix_nanos(&boundary.start_ts),
        );
        let previous_ids: HashSet<String> = tool_calls_for_next
            .iter()
            .filter_map(|call| call.id.clone())
            .filter(|id| !id.is_empty())
            .collect();
        let current_results = extract_tool_results(content);
        let mut input_results = Vec::new();
        for result in tool_results_for_next.iter().chain(current_results.iter()) {
            let Some(id) = result.tool_id.clone() else {
                continue;
            };
            if !previous_ids.contains(&id) {
                continue;
            }
            if let Some(existing) = input_results
                .iter_mut()
                .find(|item: &&mut ToolResult| item.tool_id.as_deref() == Some(id.as_str()))
            {
                *existing = clone_tool_result(result);
            } else {
                input_results.push(clone_tool_result(result));
            }
        }
        let step_model = content.iter().find_map(row_model).unwrap_or("auto");
        let event_context = EventContext {
            step_id: &step_id,
            turn_id,
            session_id,
            agent_type: &agent_type,
            provider: &provider,
            model: step_model,
            user_id: &user_id,
        };
        let mut input_delta = None;
        let mut emit_request = index > 0;
        if index == 0 && user_row.is_some() {
            input_delta = Some(vec![json!({
                "role": "user",
                "parts": build_user_message_parts(&user_text, content_events, &agent_type),
            })]);
            emit_request = true;
        } else if !input_results.is_empty() {
            let mut delta = Vec::new();
            if !tool_calls_for_next.is_empty() {
                let parts: Vec<Value> = tool_calls_for_next.iter().map(tool_call_part).collect();
                delta.push(json!({"role": "assistant", "parts": parts}));
            }
            for result in &input_results {
                delta.push(json!({
                    "role": "tool",
                    "parts": [tool_response_part(result)],
                }));
            }
            input_delta = Some(delta);
        }
        if emit_request {
            let mut record = base_event("llm.request", &event_context, &start_nanos, &observed);
            if let Some(delta) = input_delta {
                record.insert("gen_ai.input.messages_delta".into(), Value::Array(delta));
            }
            if index == 0 {
                if let Some(attachments) = cli_attachment_fields(&agent_type, user_row, all_parsed)
                {
                    record.insert("agent.qoder.attachments".into(), attachments);
                }
            }
            records.push(record);
        }

        let mut output_parts = Vec::new();
        let mut tool_calls = Vec::new();
        let mut response_id = None;
        let mut client_request_id = None;
        let mut native_usage = None;
        let mut first_assistant_ts = None;
        for row in content {
            if typ(row) != "assistant" {
                continue;
            }
            let msg = message_map(row);
            if response_id.is_none() {
                if let Some(id) = msg.and_then(|msg| msg.get("id")) {
                    if js_truthy(Some(id)) {
                        response_id = Some(id.clone());
                    }
                }
            }
            let usage = msg.and_then(|msg| msg.get("usage"));
            if agent_type == "qoder-cli" {
                if let Some(usage) = usage {
                    let input = usage.get("input_tokens").and_then(Value::as_i64);
                    let output = usage.get("output_tokens").and_then(Value::as_i64);
                    // Stream fragments and CLI versions with hidden usage emit
                    // zero-filled placeholders. Keep the latest completed sample.
                    if let (Some(input @ 0..), Some(output @ 0..)) = (input, output) {
                        if input > 0 || output > 0 {
                            native_usage = Some((input, output, usage));
                        }
                    }
                }
            }
            if client_request_id.is_none() {
                let usable_id = |value: &&Value| value.as_str().is_some_and(|id| !id.is_empty());
                client_request_id = usage
                    .and_then(|usage| usage.get("request_id"))
                    .filter(usable_id)
                    .or_else(|| {
                        row.pointer("/requestTokenAnchor/requestId")
                            .filter(usable_id)
                    })
                    .cloned();
            }
            if first_assistant_ts.is_none() {
                if let Some(ts) = timestamp_str(row) {
                    first_assistant_ts = Some(ts.to_string());
                }
            }
            for block in message_blocks(row) {
                match block.get("type").and_then(Value::as_str) {
                    Some("thinking") => {
                        let mut part = Obj::new();
                        part.insert("type".into(), Value::String("reasoning".into()));
                        part.insert("content".into(), js_or_empty(block.get("thinking")));
                        output_parts.push(Value::Object(part));
                    }
                    Some("redacted_thinking") => {}
                    Some("text") => {
                        let mut part = Obj::new();
                        part.insert("type".into(), Value::String("text".into()));
                        part.insert("content".into(), js_or_empty(block.get("text")));
                        output_parts.push(Value::Object(part));
                    }
                    Some("tool_use") => {
                        let mut part = Obj::new();
                        part.insert("type".into(), Value::String("tool_call".into()));
                        copy_present(&mut part, block, "id", "id");
                        copy_present(&mut part, block, "name", "name");
                        if let Some(input) = block.get("input") {
                            part.insert("arguments".into(), input.clone());
                        }
                        output_parts.push(Value::Object(part));
                        tool_calls.push(ToolCall {
                            id: nonempty_str(block.get("id")).map(str::to_owned),
                            name: nonempty_str(block.get("name")).map(str::to_owned),
                            input: block.get("input").cloned(),
                            call_ts: timestamp_str(row).map(str::to_owned),
                        });
                    }
                    _ => {}
                }
            }
        }
        let current_ids: HashSet<String> = tool_calls
            .iter()
            .filter_map(|call| call.id.clone())
            .filter(|id| !id.is_empty())
            .collect();
        tool_results_for_next = current_results
            .into_iter()
            .filter(|result| {
                result
                    .tool_id
                    .as_ref()
                    .is_some_and(|id| current_ids.contains(id))
            })
            .collect();
        tool_calls_for_next = tool_calls
            .iter()
            .map(|call| ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                call_ts: None,
            })
            .collect();
        let last_stop = content.iter().rev().find_map(|row| {
            if typ(row) == "assistant" {
                stop_reason(row).map(str::to_owned)
            } else {
                None
            }
        });
        let finish = finish_reason_for(
            tool_calls.len(),
            last_stop.as_deref(),
            index + 1 == boundaries.len(),
        );
        if !output_parts.is_empty() {
            let mut record = base_event(
                "llm.response",
                &event_context,
                &response_end_nanos,
                &observed,
            );
            record.insert(
                "gen_ai.response.model".into(),
                Value::String(step_model.into()),
            );
            if let Some(id) = response_id {
                record.insert("gen_ai.response.id".into(), id);
            }
            if let Some(finish) = &finish {
                record.insert("gen_ai.response.finish_reasons".into(), json!([finish]));
            }
            let mut message = Obj::new();
            message.insert("role".into(), Value::String("assistant".into()));
            message.insert("parts".into(), Value::Array(output_parts));
            if let Some(finish) = &finish {
                message.insert("finish_reason".into(), Value::String(finish.clone()));
            }
            record.insert(
                "gen_ai.output.messages".into(),
                Value::Array(vec![Value::Object(message)]),
            );
            if let Some(reason) = &last_stop {
                record.insert("agent.stop_reason".into(), Value::String(reason.clone()));
            }
            if let Some(id) = client_request_id {
                record.insert("agent.client_request_id".into(), id);
            }
            if let Some((input, output, usage)) = native_usage {
                record.insert("gen_ai.usage.input_tokens".into(), json!(input));
                record.insert("gen_ai.usage.output_tokens".into(), json!(output));
                record.insert(
                    "gen_ai.usage.total_tokens".into(),
                    json!(input.saturating_add(output)),
                );
                for (source, target) in [
                    (
                        "cache_read_input_tokens",
                        "gen_ai.usage.cache_read.input_tokens",
                    ),
                    (
                        "cache_creation_input_tokens",
                        "gen_ai.usage.cache_creation.input_tokens",
                    ),
                ] {
                    if let Some(count @ 0..) = usage.get(source).and_then(Value::as_i64) {
                        record.insert(target.into(), json!(count));
                    }
                }
            }
            if let Some(ts) = first_assistant_ts.as_deref() {
                if let Some(ms) = date_parse_millis(ts) {
                    record.insert("agent.qoder.match_ts".into(), json!(ms));
                }
            }
            records.push(record);
        }
        previous_response_nanos = response_end_nanos.clone();
        for call in &tool_calls {
            let tool_call_ts = match call.call_ts.as_deref() {
                Some(ts) => {
                    let nanos = iso_to_unix_nanos(ts);
                    if nanos.is_empty() {
                        response_end_nanos.clone()
                    } else {
                        nanos
                    }
                }
                None => response_end_nanos.clone(),
            };
            let mut call_record = Obj::new();
            call_record.insert("event.id".into(), Value::String(uuid_v4()));
            call_record.insert("event.name".into(), Value::String("tool.call".into()));
            call_record.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
            call_record.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
            call_record.insert("gen_ai.session.id".into(), Value::String(session_id.into()));
            call_record.insert(
                "gen_ai.agent.type".into(),
                Value::String(agent_type.clone()),
            );
            if let Some(name) = &call.name {
                call_record.insert("gen_ai.tool.name".into(), Value::String(name.clone()));
            }
            if let Some(id) = &call.id {
                call_record.insert("gen_ai.tool.call.id".into(), Value::String(id.clone()));
                call_record.insert("gen_ai.tool.call.exec.id".into(), Value::String(id.clone()));
            }
            let arguments = if preserve_tool_values {
                call.input.clone()
            } else {
                arguments_string(&call.input).map(Value::String)
            };
            if let Some(arguments) = arguments {
                call_record.insert("gen_ai.tool.call.arguments".into(), arguments);
            }
            call_record.insert("user.id".into(), Value::String(user_id.clone()));
            call_record.insert(
                "agent.source".into(),
                Value::String("qoder-transcript-hook".into()),
            );
            call_record.insert("time_unix_nano".into(), Value::String(tool_call_ts.clone()));
            call_record.insert(
                "observed_time_unix_nano".into(),
                Value::String(observed.clone()),
            );
            records.push(call_record);
            let matched = call.id.as_ref().and_then(|id| {
                tool_results_for_next
                    .iter()
                    .find(|result| result.tool_id.as_deref() == Some(id.as_str()))
            });
            if let Some(result) = matched {
                let candidate = result
                    .result_ts
                    .as_deref()
                    .map(iso_to_unix_nanos)
                    .unwrap_or_default();
                let tool_result_ts = ensure_end_after_start(&tool_call_ts, &candidate);
                let duration = compute_duration_ms(&tool_call_ts, &tool_result_ts);
                let mut result_record = Obj::new();
                result_record.insert("event.id".into(), Value::String(uuid_v4()));
                result_record.insert("event.name".into(), Value::String("tool.result".into()));
                result_record.insert("gen_ai.step.id".into(), Value::String(step_id.clone()));
                result_record.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
                result_record.insert("gen_ai.session.id".into(), Value::String(session_id.into()));
                result_record.insert(
                    "gen_ai.agent.type".into(),
                    Value::String(agent_type.clone()),
                );
                if let Some(name) = &call.name {
                    result_record.insert("gen_ai.tool.name".into(), Value::String(name.clone()));
                }
                if let Some(id) = &call.id {
                    result_record.insert("gen_ai.tool.call.id".into(), Value::String(id.clone()));
                    result_record
                        .insert("gen_ai.tool.call.exec.id".into(), Value::String(id.clone()));
                }
                if let Some(body) = &result.result {
                    result_record.insert("gen_ai.tool.call.result".into(), body.clone());
                }
                result_record.insert(
                    "tool.result.status".into(),
                    Value::String(if result.is_error { "error" } else { "success" }.into()),
                );
                if duration > 0 {
                    result_record.insert("gen_ai.tool.call.duration".into(), json!(duration));
                }
                result_record.insert("user.id".into(), Value::String(user_id.clone()));
                result_record.insert(
                    "agent.source".into(),
                    Value::String("qoder-transcript-hook".into()),
                );
                result_record.insert("time_unix_nano".into(), Value::String(tool_result_ts));
                result_record.insert(
                    "observed_time_unix_nano".into(),
                    Value::String(observed.clone()),
                );
                records.push(result_record);
            }
        }
    }
    finalize_records(&mut records, cwd, identity, stamp);
    records
}

fn clone_tool_result(result: &ToolResult) -> ToolResult {
    ToolResult {
        tool_id: result.tool_id.clone(),
        result: result.result.clone(),
        is_error: result.is_error,
        result_ts: result.result_ts.clone(),
    }
}

fn tool_call_part(call: &ToolCall) -> Value {
    let mut part = Obj::new();
    part.insert("type".into(), Value::String("tool_call".into()));
    if let Some(id) = &call.id {
        part.insert("id".into(), Value::String(id.clone()));
    }
    if let Some(name) = &call.name {
        part.insert("name".into(), Value::String(name.clone()));
    }
    if let Some(input) = &call.input {
        part.insert("arguments".into(), input.clone());
    }
    Value::Object(part)
}

fn tool_response_part(result: &ToolResult) -> Value {
    let mut part = Obj::new();
    part.insert("type".into(), Value::String("tool_call_response".into()));
    if let Some(id) = &result.tool_id {
        part.insert("id".into(), Value::String(id.clone()));
    }
    if let Some(body) = &result.result {
        part.insert("response".into(), body.clone());
    }
    Value::Object(part)
}

struct EventContext<'a> {
    step_id: &'a str,
    turn_id: &'a str,
    session_id: &'a str,
    agent_type: &'a str,
    provider: &'a str,
    model: &'a str,
    user_id: &'a str,
}

fn base_event(name: &str, context: &EventContext<'_>, time_nanos: &str, observed: &str) -> Obj {
    let EventContext {
        step_id,
        turn_id,
        session_id,
        agent_type,
        provider,
        model,
        user_id,
    } = *context;
    let mut record = Obj::new();
    record.insert("event.id".into(), Value::String(uuid_v4()));
    record.insert("event.name".into(), Value::String(name.into()));
    record.insert("gen_ai.step.id".into(), Value::String(step_id.into()));
    record.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
    record.insert("gen_ai.session.id".into(), Value::String(session_id.into()));
    record.insert("gen_ai.agent.type".into(), Value::String(agent_type.into()));
    record.insert(
        "gen_ai.provider.name".into(),
        Value::String(provider.into()),
    );
    record.insert("gen_ai.request.model".into(), Value::String(model.into()));
    record.insert("user.id".into(), Value::String(user_id.into()));
    record.insert(
        "agent.source".into(),
        Value::String("qoder-transcript-hook".into()),
    );
    record.insert("time_unix_nano".into(), Value::String(time_nanos.into()));
    record.insert(
        "observed_time_unix_nano".into(),
        Value::String(observed.into()),
    );
    record
}

fn finish_reason_for(
    tool_calls: usize,
    last_stop: Option<&str>,
    last_boundary: bool,
) -> Option<String> {
    if tool_calls > 0 {
        return Some("tool_call".into());
    }
    if last_stop == Some("max_tokens") {
        return Some("max_tokens".into());
    }
    if last_stop == Some("end_turn") || last_boundary {
        return Some("end_turn".into());
    }
    if let Some(reason) = last_stop {
        return normalize_finish_reason(reason).map(str::to_owned);
    }
    Some("stop".into())
}

fn normalize_finish_reason(reason: &str) -> Option<&str> {
    let mapped = match reason {
        "tool_use" => "tool_call",
        "stop_sequence" => "stop",
        "refusal" => "stop",
        "model_context_window_exceeded" => "length",
        other => other,
    };
    crate::normalization::VALID_FINISH_REASONS
        .contains(&mapped)
        .then_some(mapped)
}

fn finalize_records(
    records: &mut [Obj],
    cwd: Option<&str>,
    identity: Option<&UserIdentity>,
    stamp: &Stamp,
) {
    mark_turn_boundaries(records);
    for record in records.iter_mut() {
        if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
            record.insert("agent.qoder.cwd".into(), Value::String(cwd.to_string()));
        }
        if let Some(identity) = identity {
            if let Some(name) = &identity.name {
                record.insert("user.name".into(), Value::String(name.clone()));
            }
            if let Some(email) = &identity.email {
                record.insert("user.email".into(), Value::String(email.clone()));
            }
        }
        for (key, value) in &stamp.span {
            record.insert(key.clone(), value.clone());
        }
        if let Some(name) = &stamp.agent_name {
            record.insert("gen_ai.agent.name".into(), Value::String(name.clone()));
        }
        if !stamp.resources.is_empty() {
            record.insert(
                "resourceAttributes".into(),
                Value::Object(stamp.resources.clone()),
            );
        }
    }
}

fn mark_turn_boundaries(records: &mut [Obj]) {
    if records.is_empty() {
        return;
    }
    let agent = records[0]
        .get("gen_ai.agent.type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if agent != "qoder" && agent != "qoder-cn" {
        return;
    }
    records[0].insert("gen_ai.turn.start".into(), Value::Bool(true));
    let mut closing = records.len() - 1;
    for index in (0..records.len()).rev() {
        if records[index].get("event.name").and_then(Value::as_str) == Some("llm.response") {
            closing = index;
            break;
        }
    }
    records[closing].insert("gen_ai.turn.end".into(), Value::Bool(true));
}

fn build_legacy_events(
    rows: &[&Value],
    turn_id: &str,
    agent_id: &str,
    runtime_user: &str,
    records: &mut Vec<Obj>,
) {
    for row in rows {
        if let Some(record) = build_qoder_hook_record(row, agent_id, runtime_user, turn_id) {
            records.push(record);
        }
    }
    let mut step_counter = 0i64;
    let mut last_response_ts: Option<f64> = None;
    for record in records.iter_mut() {
        if record.get("agent.qoder.raw_type").and_then(Value::as_str) == Some("user") {
            continue;
        }
        if record.get("event.name").and_then(Value::as_str) == Some("llm.response") {
            let response_ts = record
                .get("time_unix_nano")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok());
            let diff = match (last_response_ts, response_ts) {
                (None, _) => f64::INFINITY,
                (Some(previous), Some(current)) => (current - previous).abs(),
                _ => 0.0,
            };
            if diff > 100_000_000.0 {
                step_counter += 1;
            }
            if let Some(current) = response_ts {
                last_response_ts = Some(current);
            }
        }
        if step_counter == 0 {
            step_counter = 1;
        }
        record.insert(
            "gen_ai.step.id".into(),
            Value::String(format!("{turn_id}:s{step_counter}")),
        );
    }
}

fn build_qoder_hook_record(
    row: &Value,
    agent_id: &str,
    runtime_user: &str,
    turn_id: &str,
) -> Option<Obj> {
    let row_type = nonempty_str(row.get("type"))?;
    if matches!(
        row_type,
        "ai-title" | "last-prompt" | "session_meta" | "progress"
    ) {
        return None;
    }
    if row_type != "assistant" && row_type != "user" {
        return None;
    }
    let content = select_dominant_content(message(row).and_then(|value| value.get("content")))?;
    let content_map = content.as_object()?;
    let variant = infer_legacy_variant(row, agent_id);
    let namespace = source_namespace(&variant);
    let content_type = nonempty_str(content_map.get("type")).unwrap_or("");
    let event_name = if content_type == "tool_result" {
        "tool.result"
    } else if content_type == "tool_use" {
        "tool.call"
    } else if row_type == "assistant" {
        "llm.response"
    } else {
        "other"
    };
    let model = if row_type == "user" {
        None
    } else {
        Some(
            message_map(row)
                .and_then(|msg| nonempty_str(msg.get("model")))
                .unwrap_or("unknown")
                .to_string(),
        )
    };
    let mut record = Obj::new();
    record.insert(
        "event.id".into(),
        Value::String(
            nonempty_str(row.get("event.id"))
                .or_else(|| nonempty_str(row.get("uuid")))
                .map(str::to_owned)
                .unwrap_or_else(uuid_v4),
        ),
    );
    record.insert("event.name".into(), Value::String(event_name.into()));
    record.insert(
        "user.id".into(),
        Value::String(legacy_user_id(row, runtime_user)),
    );
    record.insert(
        "gen_ai.session.id".into(),
        Value::String(legacy_session_id(row)),
    );
    if matches!(variant.as_str(), "qoder-cli" | "qoder" | "qoder-cn") {
        record.insert("gen_ai.turn.id".into(), Value::String(turn_id.into()));
    } else if let Some(turn) = nonempty_str(row.get("turn_id")) {
        record.insert("gen_ai.turn.id".into(), Value::String(turn.to_string()));
    }
    record.insert("gen_ai.agent.type".into(), Value::String(variant.clone()));
    record.insert(
        "gen_ai.provider.name".into(),
        Value::String(infer_provider_name(None, model.as_deref(), &variant)),
    );
    if let Some(model) = &model {
        record.insert("gen_ai.request.model".into(), Value::String(model.clone()));
        record.insert("gen_ai.response.model".into(), Value::String(model.clone()));
    }
    if event_name == "llm.response" {
        if let Some(id) = message_map(row).and_then(|msg| nonempty_str(msg.get("id"))) {
            record.insert("gen_ai.response.id".into(), Value::String(id.to_string()));
        }
    }
    if let Some(reason) = message_map(row).and_then(|msg| nonempty_str(msg.get("stop_reason"))) {
        record.insert(
            "gen_ai.response.finish_reasons".into(),
            Value::String(reason.to_string()),
        );
    }
    if event_name == "llm.request" || (event_name == "other" && row_type == "user") {
        if let Some(text) = nonempty_str(content_map.get("text"))
            .or_else(|| nonempty_str(content_map.get("content")))
        {
            record.insert(
                "gen_ai.input.messages_delta".into(),
                json!([{ "role": "user", "parts": [{ "type": "text", "content": text }] }]),
            );
        }
    }
    if event_name == "llm.response" {
        if let Some(messages) = legacy_output_messages(content_map) {
            record.insert("gen_ai.output.messages".into(), messages);
        }
    }
    let tool_id = nonempty_str(content_map.get("id"))
        .or_else(|| nonempty_str(content_map.get("tool_use_id")));
    if event_name == "tool.call" {
        if let Some(name) = nonempty_str(content_map.get("name")) {
            record.insert("gen_ai.tool.name".into(), Value::String(name.to_string()));
        }
    }
    if matches!(event_name, "tool.call" | "tool.result") {
        if let Some(id) = tool_id {
            record.insert("gen_ai.tool.call.id".into(), Value::String(id.to_string()));
            record.insert(
                "gen_ai.tool.call.exec.id".into(),
                Value::String(id.to_string()),
            );
        }
    }
    if event_name == "tool.call" {
        if let Some(input) = content_map.get("input").and_then(to_json_value) {
            record.insert("gen_ai.tool.call.arguments".into(), input);
        }
    }
    if event_name == "tool.result" {
        let source = if row
            .get("toolUseResult")
            .is_some_and(|value| !value.is_null())
        {
            row.get("toolUseResult")
        } else {
            content_map.get("content")
        };
        if let Some(result) = source.and_then(to_json_value) {
            record.insert("gen_ai.tool.call.result".into(), result);
        }
        if let Some(status) = match content_map.get("is_error") {
            Some(Value::Bool(true)) => Some("failure"),
            Some(Value::Bool(false)) => Some("success"),
            _ => None,
        } {
            record.insert("tool.result.status".into(), Value::String(status.into()));
        }
    }
    record.insert("host.name".into(), Value::String(hostname()));
    if let Some(cwd) = nonempty_str(row.get("cwd")) {
        record.insert(
            "workspace.current_root".into(),
            Value::String(cwd.to_string()),
        );
        record.insert(
            format!("agent.{namespace}.cwd"),
            Value::String(cwd.to_string()),
        );
    }
    record.insert(
        "agent.source".into(),
        Value::String("qoder-transcript-hook".into()),
    );
    record.insert(format!("agent.{namespace}.variant"), Value::String(variant));
    record.insert(
        format!("agent.{namespace}.raw_type"),
        Value::String(row_type.to_string()),
    );
    record.insert(
        format!("agent.{namespace}.content_type"),
        Value::String(content_type.to_string()),
    );
    record.insert("time_unix_nano".into(), Value::String(legacy_time(row)));
    record.insert(
        "observed_time_unix_nano".into(),
        Value::String(now_unix_nanos()),
    );
    add_source_attributes(&mut record, namespace, row);
    Some(sanitize_record(record))
}

fn legacy_output_messages(content: &Obj) -> Option<Value> {
    let kind = nonempty_str(content.get("type")).unwrap_or("");
    let text = nonempty_str(content.get("text"))
        .or_else(|| nonempty_str(content.get("thinking")))
        .or_else(|| nonempty_str(content.get("content")))?;
    let part_type = if kind == "thinking" {
        "reasoning"
    } else {
        "text"
    };
    Some(json!([{
        "role": "assistant",
        "parts": [{ "type": part_type, "content": text }],
    }]))
}

fn select_dominant_content(raw: Option<&Value>) -> Option<Value> {
    match raw? {
        Value::String(text) => Some(json!({"type": "text", "text": text})),
        Value::Array(blocks) => {
            let objects: Vec<&Obj> = blocks.iter().filter_map(Value::as_object).collect();
            let chosen =
                objects
                    .iter()
                    .copied()
                    .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                    .or_else(|| {
                        objects.iter().copied().find(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_use")
                        })
                    })
                    .or_else(|| {
                        objects
                            .iter()
                            .copied()
                            .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    })
                    .or_else(|| {
                        objects.iter().copied().find(|block| {
                            block.get("type").and_then(Value::as_str) == Some("thinking")
                        })
                    })?;
            Some(Value::Object(chosen.clone()))
        }
        _ => None,
    }
}

fn add_source_attributes(record: &mut Obj, namespace: &str, raw: &Value) {
    let Some(map) = raw.as_object() else {
        return;
    };
    for (key, value) in map {
        if QODER_MAPPED_SOURCE_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let Some(json) = to_json_value(value) {
            record.insert(format!("agent.{namespace}.{key}"), json);
        }
    }
}

fn to_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.clone()),
        Value::Array(items) => {
            let list: Vec<Value> = items.iter().filter_map(to_json_value).collect();
            if list.is_empty() {
                None
            } else {
                Some(Value::Array(list))
            }
        }
        Value::Object(map) => {
            let mut out = Obj::new();
            for (key, item) in map {
                if let Some(json) = to_json_value(item) {
                    out.insert(key.clone(), json);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(Value::Object(out))
            }
        }
    }
}

fn source_namespace(variant: &str) -> &'static str {
    match variant {
        "qoder-work" => "qoderwork",
        "qoder-cn" => "qodercn",
        "qoder-idea" => "qoderidea",
        _ => "qoder",
    }
}

fn infer_legacy_variant(row: &Value, agent_id: &str) -> String {
    if agent_id == "qoder-work" {
        return "qoder-work".into();
    }
    if agent_id == "qoder-cn" {
        return "qoder-cn".into();
    }
    if nonempty_str(row.get("entrypoint")) == Some("cli")
        || row.get("promptId").is_some()
        || row.get("permissionMode").is_some()
        || row.get("userType").is_some()
    {
        return "qoder-cli".into();
    }
    "qoder".into()
}

fn legacy_user_id(row: &Value, runtime_user: &str) -> String {
    for key in ["user.id", "user_id", "userId", "identity"] {
        if let Some(value) = nonempty_str(row.get(key)) {
            return value.to_string();
        }
    }
    if !runtime_user.is_empty() {
        runtime_user.to_string()
    } else {
        hostname()
    }
}

fn legacy_session_id(row: &Value) -> String {
    for key in [
        "gen_ai.session.id",
        "sessionId",
        "session_id",
        "sessionid",
        "conversation_id",
    ] {
        if let Some(value) = nonempty_str(row.get(key)) {
            return value.to_string();
        }
    }
    String::new()
}

fn legacy_time(row: &Value) -> String {
    if let Some(value) = row.get("time_unix_nano").filter(|value| !value.is_null()) {
        return normalizer_time_value(value);
    }
    if let Some(value) = row.get("timestamp").filter(|value| !value.is_null()) {
        return normalizer_time_value(value);
    }
    now_unix_nanos()
}

fn normalizer_time_value(value: &Value) -> String {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty()
                && trimmed.len() >= 16
                && trimmed.bytes().all(|byte| byte.is_ascii_digit())
            {
                return trimmed.to_string();
            }
            if let Some(number) = trimmed
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
            {
                return normalizer_number_nanos(number);
            }
            match date_parse_millis(trimmed) {
                Some(ms) => normalizer_number_nanos(ms as f64),
                None => now_unix_nanos(),
            }
        }
        Value::Number(number) => normalizer_number_nanos(number.as_f64().unwrap_or(f64::NAN)),
        _ => now_unix_nanos(),
    }
}

fn normalizer_number_nanos(value: f64) -> String {
    if !value.is_finite() {
        return now_unix_nanos();
    }
    if value >= 1e16 {
        return format!("{}", value.trunc() as i128);
    }
    if value >= 1e12 {
        return format!("{}000000", value.trunc() as i128);
    }
    format!("{}000000", (value * 1000.0).trunc() as i128)
}

fn extract_tool_results(rows: &[Value]) -> Vec<ToolResult> {
    let mut results = Vec::new();
    for row in rows {
        if typ(row) != "user" || !is_tool_result(row) {
            continue;
        }
        for block in message_blocks(row) {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            results.push(ToolResult {
                tool_id: nonempty_str(block.get("tool_use_id")).map(str::to_owned),
                result: tool_result_body(block.get("content")),
                is_error: block.get("is_error") == Some(&Value::Bool(true)),
                result_ts: timestamp_str(row).map(str::to_owned),
            });
        }
    }
    results
}

fn tool_result_body(content: Option<&Value>) -> Option<Value> {
    match content {
        None => None,
        Some(Value::String(text)) => Some(Value::String(text.clone())),
        Some(other) => serde_json::to_string(other).ok().map(Value::String),
    }
}

fn arguments_string(input: &Option<Value>) -> Option<String> {
    match input {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => serde_json::to_string(other).ok(),
    }
}

fn build_user_message_parts(user_text: &str, events: &[Value], agent_type: &str) -> Vec<Value> {
    let mut parts = vec![json!({"type": "text", "content": user_text})];
    if agent_type != "qoder-cli" {
        return parts;
    }
    let mut seen = HashSet::new();
    seen.insert(user_text.to_string());
    for row in events {
        if typ(row) != "user" || is_tool_result(row) {
            continue;
        }
        for text in extract_user_texts(row) {
            if text.is_empty() || !seen.insert(text.clone()) {
                continue;
            }
            parts.push(json!({"type": "text", "content": text}));
        }
    }
    parts
}

fn extract_first_text(row: &Value) -> String {
    extract_user_texts(row)
        .into_iter()
        .next()
        .unwrap_or_default()
}

fn extract_user_texts(row: &Value) -> Vec<String> {
    let Some(content) = message(row).and_then(|value| value.get("content")) else {
        return Vec::new();
    };
    match content {
        Value::String(text) if !text.is_empty() => vec![text.clone()],
        Value::Array(items) => {
            let mut texts = Vec::new();
            for block in items {
                match block {
                    Value::String(text) if !text.is_empty() => texts.push(text.clone()),
                    Value::Object(map)
                        if map.get("type").and_then(Value::as_str) == Some("text") =>
                    {
                        if let Some(text) = nonempty_str(map.get("text")) {
                            texts.push(text.to_string());
                        }
                    }
                    _ => {}
                }
            }
            texts
        }
        _ => Vec::new(),
    }
}

fn cli_attachment_fields(
    agent_type: &str,
    user_row: Option<&Value>,
    all_parsed: &[Value],
) -> Option<Value> {
    if agent_type != "qoder-cli" {
        return None;
    }
    let user = user_row?;
    let uuid = nonempty_str(user.get("uuid")).unwrap_or("");
    if uuid.is_empty() {
        return None;
    }
    let mut attachments = Vec::new();
    for row in all_parsed {
        if typ(row) != "attachment" || row.get("parentUuid").and_then(Value::as_str) != Some(uuid) {
            continue;
        }
        let Some(attachment) = row.get("attachment").and_then(Value::as_object) else {
            continue;
        };
        if attachment.get("type").and_then(Value::as_str) != Some("image_file") {
            continue;
        }
        let Some(filename) = nonempty_str(attachment.get("filename")).map(str::trim) else {
            continue;
        };
        if filename.is_empty() {
            continue;
        }
        let mut slim = Obj::new();
        slim.insert("type".into(), Value::String("image_file".into()));
        slim.insert("filename".into(), Value::String(filename.to_string()));
        if let Some(path) = nonempty_str(attachment.get("displayPath")).map(str::trim) {
            if !path.is_empty() {
                slim.insert("displayPath".into(), Value::String(path.to_string()));
            }
        }
        if let Some(media) = nonempty_str(attachment.get("mediaType")).map(str::trim) {
            if !media.is_empty() {
                slim.insert("mediaType".into(), Value::String(media.to_string()));
            }
        }
        attachments.push(Value::Object(slim));
    }
    if attachments.is_empty() {
        None
    } else {
        Some(Value::Array(attachments))
    }
}

fn is_control_user_row(row: &Value) -> bool {
    if typ(row) != "user" || is_tool_result(row) || js_truthy(row.get("promptId")) {
        return false;
    }
    if row.get("entrypoint").and_then(Value::as_str) != Some("cli") {
        return false;
    }
    let Some(Value::String(content)) = message(row).and_then(|value| value.get("content")) else {
        return false;
    };
    let Some(tags) = scan_control_envelopes(content) else {
        return false;
    };
    is_control_sequence(&tags, row)
}

fn is_control_sequence(tags: &[String], row: &Value) -> bool {
    if tags.len() == 1 {
        return is_caveat_or_output(&tags[0]) && is_meta_user(row);
    }
    tags.len() == 2 && tags[0] == "command-message" && tags[1] == "command-name"
}

fn is_caveat_or_output(tag: &str) -> bool {
    matches!(
        tag,
        "local-command-caveat" | "local-command-stdout" | "local-command-stderr"
    )
}

fn is_control_tag(tag: &str) -> bool {
    matches!(
        tag,
        "local-command-caveat"
            | "command-message"
            | "command-name"
            | "local-command-stdout"
            | "local-command-stderr"
    )
}

fn scan_control_envelopes(text: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    let mut tags = Vec::new();
    while index < chars.len() {
        while index < chars.len() && is_envelope_space(chars[index]) {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        if chars[index] != '<' {
            return None;
        }
        let open_end = chars[index + 1..]
            .iter()
            .position(|ch| *ch == '>')
            .map(|offset| index + 1 + offset)?;
        let tag: String = chars[index + 1..open_end].iter().collect();
        if !is_control_tag(&tag) {
            return None;
        }
        let close: Vec<char> = format!("</{tag}>").chars().collect();
        let close_at = chars[open_end + 1..]
            .windows(close.len())
            .position(|window| window == close.as_slice())
            .map(|offset| open_end + 1 + offset)?;
        tags.push(tag);
        index = close_at + close.len();
    }
    if tags.is_empty() {
        None
    } else {
        Some(tags)
    }
}

fn is_envelope_space(ch: char) -> bool {
    matches!(ch, ' ' | '\n' | '\r' | '\t')
}

fn is_real_user_prompt(row: &Value) -> bool {
    typ(row) == "user" && !is_tool_result(row) && !is_meta_user(row)
}

fn is_meta_user(row: &Value) -> bool {
    match row.get("isMeta") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(value)) if value == "true" => true,
        _ => false,
    }
}

fn is_tool_result(row: &Value) -> bool {
    let Some(Value::Array(content)) = message(row).and_then(|value| value.get("content")) else {
        return false;
    };
    content
        .first()
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str)
        == Some("tool_result")
}

fn infer_variant(row: Option<&Value>, agent_id: &str) -> String {
    if agent_id == "qoder-cn" {
        return "qoder-cn".into();
    }
    let Some(row) = row else {
        return if agent_id == "qoder" {
            "qoder".into()
        } else {
            "qoder-cli".into()
        };
    };
    if row.get("entrypoint").and_then(Value::as_str) == Some("cli")
        || js_truthy(row.get("promptId"))
        || js_truthy(row.get("permissionMode"))
        || js_truthy(row.get("userType"))
    {
        "qoder-cli".into()
    } else {
        "qoder".into()
    }
}

fn infer_provider_name(explicit: Option<&str>, model: Option<&str>, agent_type: &str) -> String {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return explicit.to_string();
    }
    let model = model.unwrap_or("").to_ascii_lowercase();
    if model.contains("claude") || model.contains("anthropic") {
        return "anthropic".into();
    }
    if model.contains("gpt") || model.contains("openai") || model.contains("codex") {
        return "openai".into();
    }
    if model.contains("qwen") || model.contains("tongyi") {
        return "qwen".into();
    }
    if model.contains("deepseek") {
        return "deepseek".into();
    }
    if model.contains("gemini") {
        return "gcp.gemini".into();
    }
    if model.contains("grok") || model.contains("xai") || model.contains("x_ai") {
        return "x_ai".into();
    }
    let agent = agent_type.to_ascii_lowercase();
    if agent.contains("codex") {
        return "openai".into();
    }
    if agent.contains("claude") {
        return "anthropic".into();
    }
    if agent.contains("qoder") || agent.contains("qwen") {
        return "qwen".into();
    }
    if agent.contains("gemini") {
        return "gcp.gemini".into();
    }
    "unknown".into()
}

fn resolve_user_id(row: Option<&Value>, runtime_user: &str) -> String {
    if !runtime_user.is_empty() {
        return runtime_user.to_string();
    }
    if let Some(row) = row {
        if let Some(value) = row.get("userId").filter(|value| !value.is_null()) {
            return match value {
                Value::String(text) => text.clone(),
                Value::Number(number) => number.to_string(),
                Value::Bool(flag) => flag.to_string(),
                _ => String::new(),
            };
        }
    }
    String::new()
}

fn resolve_qoder_cli_user_identity(env: &Env) -> Option<UserIdentity> {
    // Compatibility entry for already-installed inline wrappers.
    let home = home_dir(env).join(".qoder");
    resolve_cached_cli_user_identity(
        env,
        &home.join(".auth").join("user"),
        &identity_cache_file(env),
        cli_executable(&home),
    )
}

fn resolve_qoder_product_cli_user_identity(
    env: &Env,
    agent: &str,
    version: &str,
) -> Option<UserIdentity> {
    let (home, flavor, cache) = match agent {
        "qoder" => (".qoder", "qodercli", "qoder-cli-user-identity.json"),
        "qoder-cn" => (".qoder-cn", "qoderclicn", "qoder-cn-cli-user-identity.json"),
        _ => return None,
    };
    let home = home_dir(env).join(home);
    // The advertised product version must exist even for a cache hit.
    let executable = cli_executable_for_version(&home, flavor, version.trim())?;
    resolve_cached_cli_user_identity(
        env,
        &home.join(".auth").join("user"),
        &data_dir(env).join("state/hooks").join(cache),
        Some(executable),
    )
}

fn resolve_cached_cli_user_identity(
    env: &Env,
    auth_path: &Path,
    cache_path: &Path,
    executable: Option<PathBuf>,
) -> Option<UserIdentity> {
    let meta = fs::metadata(auth_path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = mtime_ms(&meta)?;
    let size = meta.len();
    let auth_text = auth_path.to_string_lossy().into_owned();
    if let Some(cached) = read_json_object(cache_path).and_then(|value| value.as_object().cloned())
    {
        let fingerprint_matches = json_i64(cached.get("schemaVersion")) == Some(1)
            && nonempty_str(cached.get("authPath")) == Some(auth_text.as_str())
            && json_f64(cached.get("mtimeMs")).is_some_and(|value| value == mtime_ms)
            && json_u64(cached.get("size")) == Some(size);
        if fingerprint_matches {
            if let Some(until) = json_f64(cached.get("failedUntil")) {
                if (now_ms() as f64) < until {
                    return None;
                }
            } else if cached.get("loggedIn") == Some(&Value::Bool(false)) {
                return None;
            } else {
                return identity_from_fields(cached.get("name"), cached.get("email"));
            }
        }
    }
    let executable = executable?;
    let status = query_cli(env, &executable);
    let body = match &status {
        CliQuery::Ready(Some(identity)) => {
            let mut map = Obj::new();
            map.insert("schemaVersion".into(), json!(1));
            map.insert("authPath".into(), Value::String(auth_text));
            map.insert("mtimeMs".into(), f64_value(mtime_ms));
            map.insert("size".into(), json!(size));
            map.insert("loggedIn".into(), Value::Bool(identity.logged_in));
            if let Some(name) = &identity.name {
                map.insert("name".into(), Value::String(name.clone()));
            }
            if let Some(email) = &identity.email {
                map.insert("email".into(), Value::String(email.clone()));
            }
            Value::Object(map)
        }
        _ => json!({
            "schemaVersion": 1,
            "authPath": auth_text,
            "mtimeMs": mtime_ms,
            "size": size,
            "failedUntil": now_ms() + QODER_CLI_STATUS_FAILURE_TTL_MS as i64,
        }),
    };
    write_identity_cache(cache_path, &body);
    match status {
        CliQuery::Ready(Some(identity)) if identity.logged_in => Some(UserIdentity {
            name: identity.name,
            email: identity.email,
        }),
        _ => None,
    }
}

fn cli_executable(qoder_home: &Path) -> Option<PathBuf> {
    let cli_dir = qoder_home.join("bin").join("qodercli");
    let version = fs::read_to_string(cli_dir.join("version.txt")).ok()?;
    cli_executable_for_version(qoder_home, "qodercli", version.trim())
}

fn cli_executable_for_version(home: &Path, flavor: &str, version: &str) -> Option<PathBuf> {
    if !valid_cli_version(version) {
        return None;
    }
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let path = home
        .join("bin")
        .join(flavor)
        .join(format!("{flavor}-{version}{suffix}"));
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

fn valid_cli_version(version: &str) -> bool {
    let mut parts = version.split('.');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn query_cli(env: &Env, executable: &Path) -> CliQuery {
    let mut command = Command::new(executable);
    command
        .args(["status", "--output", "json"])
        .envs(
            env.iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    detach_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return CliQuery::Ready(None),
    };
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_child(&mut child);
            return CliQuery::Ready(None);
        }
    };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => {
                    let _ = sender.send(Ok(buffer));
                    return;
                }
                Ok(size) => {
                    buffer.extend_from_slice(&chunk[..size]);
                    if buffer.len() > CLI_STDOUT_LIMIT {
                        let _ = sender.send(Err(()));
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(Ok(buffer));
                    return;
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_millis(QODER_CLI_STATUS_TIMEOUT_MS);
    let now = Instant::now();
    if now >= deadline {
        kill_child(&mut child);
        return CliQuery::TimedOut;
    }
    match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
        Ok(Ok(buffer)) => {
            // stdout may close before a broken CLI exits. Keep process exit
            // inside the same status deadline rather than blocking in wait().
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => break,
                    Ok(Some(_)) => return CliQuery::Ready(None),
                    Err(_) => {
                        kill_child(&mut child);
                        return CliQuery::Ready(None);
                    }
                    Ok(None) => {
                        let Some(remaining) = deadline.checked_duration_since(Instant::now())
                        else {
                            kill_child(&mut child);
                            return CliQuery::TimedOut;
                        };
                        if remaining.is_zero() {
                            kill_child(&mut child);
                            return CliQuery::TimedOut;
                        }
                        std::thread::sleep(remaining.min(Duration::from_millis(5)));
                    }
                }
            }
            let text = String::from_utf8_lossy(&buffer);
            CliQuery::Ready(parse_cli_status(text.trim()))
        }
        Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            kill_child(&mut child);
            CliQuery::Ready(None)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_child(&mut child);
            CliQuery::TimedOut
        }
    }
}

fn parse_cli_status(stdout: &str) -> Option<CliIdentity> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let obj = value.as_object()?;
    match obj.get("logged_in") {
        Some(Value::Bool(false)) => Some(CliIdentity {
            logged_in: false,
            name: None,
            email: None,
        }),
        Some(Value::Bool(true)) => {
            let name = identity_text(obj.get("username"));
            let email = account_email(obj.get("email"));
            if name.is_none() && email.is_none() {
                None
            } else {
                Some(CliIdentity {
                    logged_in: true,
                    name,
                    email,
                })
            }
        }
        _ => None,
    }
}

fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let _ = kill(-(child.id() as i32), 9);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn identity_cache_file(env: &Env) -> PathBuf {
    data_dir(env)
        .join("state")
        .join("hooks")
        .join("qoder-cli-user-identity.json")
}

fn write_identity_cache(path: &Path, value: &Value) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let tmp = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        now_ms()
    ));
    let Ok(body) = serde_json::to_string(value) else {
        return;
    };
    if fs::write(&tmp, body).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

fn read_retry_user_identity(stdin: &[u8]) -> Option<UserIdentity> {
    let text = decode_payload(stdin);
    if text.trim().is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    let obj = value.as_object()?;
    identity_from_fields(obj.get("name"), obj.get("email"))
}

fn account_email(value: Option<&Value>) -> Option<String> {
    let email = identity_text(value)?;
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || email
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '\u{feff}')
    {
        return None;
    }
    Some(email)
}

fn extract_qoder_cn_user_identity(extra: &Obj) -> Option<UserIdentity> {
    let user = extra.get("user").and_then(Value::as_object);
    let name = identity_text(user.and_then(|user| user.get("name")));
    let email = account_email(user.and_then(|user| user.get("email")))
        .or_else(|| account_email(extra.get("email")));
    (name.is_some() || email.is_some()).then_some(UserIdentity { name, email })
}

fn read_qoder_app_user_identity(env: &Env, agent_id: &str) -> Option<UserIdentity> {
    let product = match agent_id {
        "qoder" => "qoder",
        "qoder-cn" => "qodercn",
        _ => return None,
    };
    // This public projection changes with the account, without a heartbeat.
    // Read it on each Stop and let the existing retry payload freeze the result.
    const LIMIT: u64 = 16 * 1024;
    let path = home_dir(env)
        .join(format!(".{agent_id}"))
        .join(".qoder-app-status.json");
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > LIMIT {
        return None;
    }
    let status: Value = serde_json::from_slice(&bytes).ok()?;
    if status.get("schema_version").and_then(Value::as_f64) != Some(1.0)
        || status.get("product").and_then(Value::as_str) != Some(product)
        || status.get("writer").and_then(Value::as_str) != Some("main")
        || status.get("logged_in").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    let snapshot = status
        .get("snapshot_at")
        .and_then(Value::as_str)
        .and_then(date_parse_millis)?;
    if snapshot > now_ms().saturating_add(5 * 60_000) {
        return None;
    }
    let name = identity_text(status.get("name"));
    let email = account_email(status.get("email"));
    (name.is_some() || email.is_some()).then_some(UserIdentity { name, email })
}

fn extract_user_identity(extra: &Obj) -> Option<UserIdentity> {
    let user = extra.get("user")?.as_object()?;
    identity_from_fields(user.get("name"), user.get("email"))
}

fn identity_from_fields(name: Option<&Value>, email: Option<&Value>) -> Option<UserIdentity> {
    let name = identity_text(name);
    let email = account_email(email);
    if name.is_none() && email.is_none() {
        None
    } else {
        Some(UserIdentity { name, email })
    }
}

fn identity_text(value: Option<&Value>) -> Option<String> {
    let text = value?
        .as_str()?
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
    if text.is_empty() || text.encode_utf16().count() > MAX_USER_IDENTITY_VALUE_LENGTH {
        None
    } else {
        Some(text.to_string())
    }
}

fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    let modified = meta.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0)
}

fn timestamp_order_nanos(value: &str) -> Option<i128> {
    if value.is_empty() {
        return None;
    }
    if let Some((whole, fraction, zone)) = split_iso_timestamp(value) {
        let composed = format!("{whole}{zone}");
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&composed) {
            let fraction = format!("{fraction}000000000");
            let fraction_nanos = fraction
                .chars()
                .take(9)
                .collect::<String>()
                .parse::<i128>()
                .unwrap_or(0);
            return Some(parsed.timestamp_millis() as i128 * 1_000_000 + fraction_nanos);
        }
    }
    date_parse_millis(value).map(|millis| millis as i128 * 1_000_000)
}

fn iso_to_unix_nanos(value: &str) -> String {
    timestamp_order_nanos(value)
        .map(|nanos| nanos.to_string())
        .unwrap_or_default()
}

fn timestamp_to_unix_nanos(value: Option<&str>) -> String {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return now_unix_nanos();
    };
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return value.to_string();
    }
    timestamp_order_nanos(value)
        .map(|nanos| nanos.to_string())
        .unwrap_or_else(now_unix_nanos)
}

fn date_parse_millis(value: &str) -> Option<i64> {
    if let Some((whole, fraction, zone)) = split_iso_timestamp(value) {
        let composed = format!("{whole}{zone}");
        let parsed = chrono::DateTime::parse_from_rfc3339(&composed).ok()?;
        let extra = format!("{fraction}000");
        let millis: i64 = extra.chars().take(3).collect::<String>().parse().ok()?;
        return Some(parsed.timestamp_millis() + millis);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn split_iso_timestamp(value: &str) -> Option<(&str, &str, String)> {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let zone_len = if bytes[bytes.len() - 1] == b'Z' || bytes[bytes.len() - 1] == b'z' {
        1
    } else if bytes.len() >= 6 {
        let end = bytes.len();
        let sign = bytes[end - 6];
        if (sign == b'+' || sign == b'-')
            && bytes[end - 5].is_ascii_digit()
            && bytes[end - 4].is_ascii_digit()
            && bytes[end - 3] == b':'
            && bytes[end - 2].is_ascii_digit()
            && bytes[end - 1].is_ascii_digit()
        {
            6
        } else {
            return None;
        }
    } else {
        return None;
    };
    let head = &value[..value.len() - zone_len];
    let zone_raw = &value[value.len() - zone_len..];
    let zone = if zone_raw.eq_ignore_ascii_case("z") {
        "Z".to_string()
    } else {
        zone_raw.to_string()
    };
    if let Some(dot) = head.rfind('.') {
        let fraction = &head[dot + 1..];
        if !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()) && dot > 0 {
            return Some((&head[..dot], fraction, zone));
        }
    }
    Some((head, "", zone))
}

fn ordered_llm_interval(preceding: &[String], candidate: &str, fallback: &str) -> (String, String) {
    let preceding: Vec<i128> = preceding
        .iter()
        .filter_map(|value| parse_digits(value))
        .collect();
    let fallback = parse_digits(fallback);
    let mut response = parse_digits(candidate);
    let mut request = if let Some(latest) = preceding.into_iter().max() {
        Some(latest + 1)
    } else {
        fallback
    };
    if request.is_none() {
        request = response.map(|value| value - 1);
    }
    let Some(request) = request else {
        return (String::new(), String::new());
    };
    if response.is_none_or(|value| value <= request) {
        response = Some(request + 1);
    }
    let response = response.unwrap_or(request + 1);
    (
        if request >= 0 {
            request.to_string()
        } else {
            String::new()
        },
        if response >= 0 {
            response.to_string()
        } else {
            String::new()
        },
    )
}

fn ensure_end_after_start(start: &str, candidate: &str) -> String {
    match (parse_digits(start), parse_digits(candidate)) {
        (Some(start), Some(end)) if end > start && !candidate.is_empty() => candidate.to_string(),
        (Some(start), _) => (start + 1).to_string(),
        _ if !candidate.is_empty() => candidate.to_string(),
        _ => start.to_string(),
    }
}

fn compute_duration_ms(start: &str, end: &str) -> i64 {
    if start.is_empty() || end.is_empty() || start == end {
        return 0;
    }
    let Some(start) = parse_digits(start) else {
        return 0;
    };
    let Some(end) = parse_digits(end) else {
        return 0;
    };
    let diff = end - start;
    if diff <= 0 {
        return 0;
    }
    i64::try_from(diff / 1_000_000).unwrap_or(0)
}

fn parse_digits(value: &str) -> Option<i128> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn message(row: &Value) -> Option<&Value> {
    row.get("message")
}

fn message_map(row: &Value) -> Option<&Obj> {
    message(row)?.as_object()
}

fn message_blocks(row: &Value) -> Vec<&Obj> {
    match message(row).and_then(|value| value.get("content")) {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

fn typ(row: &Value) -> &str {
    row.get("type").and_then(Value::as_str).unwrap_or("")
}

fn hook_event(row: Option<&Value>) -> &str {
    let Some(row) = row else {
        return "";
    };
    if typ(row) != "progress" {
        return "";
    }
    row.get("data")
        .and_then(|data| data.get("hookEvent"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn timestamp_str(row: &Value) -> Option<&str> {
    nonempty_str(row.get("timestamp"))
}

fn row_model(row: &Value) -> Option<&str> {
    if typ(row) != "assistant" {
        return None;
    }
    nonempty_str(message_map(row)?.get("model"))
}

fn stop_reason(row: &Value) -> Option<&str> {
    let reason = message_map(row)?.get("stop_reason")?;
    match reason {
        Value::String(text) if !text.is_empty() => Some(text.as_str()),
        _ => None,
    }
}

fn copy_present(target: &mut Obj, source: &Obj, from: &str, to: &str) {
    if let Some(value) = source.get(from) {
        target.insert(to.to_string(), value.clone());
    }
}

fn js_or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Value::String(text.clone()),
        Some(Value::Number(number)) if number.as_f64() != Some(0.0) => {
            Value::Number(number.clone())
        }
        Some(Value::Bool(true)) => Value::Bool(true),
        Some(Value::Array(items)) if !items.is_empty() => Value::Array(items.clone()),
        Some(Value::Object(map)) if !map.is_empty() => Value::Object(map.clone()),
        _ => Value::String(String::new()),
    }
}

fn nonempty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    json_u64(value).and_then(|value| u32::try_from(value).ok())
}

fn f64_value(number: f64) -> Value {
    serde_json::Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_js_int(value: &str) -> Option<i64> {
    let value = value.trim_start();
    if value.is_empty() {
        return None;
    }
    let (sign, digits) = if let Some(rest) = value.strip_prefix('+') {
        (1i64, rest)
    } else if let Some(rest) = value.strip_prefix('-') {
        (-1i64, rest)
    } else {
        (1i64, value)
    };
    let mut number: i64 = 0;
    let mut seen = false;
    for byte in digits.bytes() {
        if !byte.is_ascii_digit() {
            break;
        }
        seen = true;
        number = number
            .saturating_mul(10)
            .saturating_add((byte - b'0') as i64);
    }
    if seen {
        Some(number.saturating_mul(sign))
    } else {
        None
    }
}

fn clamp_integer(value: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    match value.and_then(parse_js_int) {
        Some(parsed) => parsed.clamp(min, max),
        None => fallback,
    }
}

fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn sha1_hex(bytes: &[u8]) -> String {
    hex::encode(crate::multimodal::digest::sha1(bytes))
}

fn log_debug(env: &Env, agent_id: &str, message: &str) {
    let path = data_dir(env)
        .join("logs")
        .join(agent_id)
        .join("debug")
        .join(format!("{agent_id}-debug-{}.log", local_date()));
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let line = format!("[{}] {message}\n", local_stamp_seconds());
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

#[cfg(test)]
mod tests {
    use super::super::common::{Env, HookRequest, Obj};
    use super::{
        build_events_from_boundaries, build_llm_boundaries, date_parse_millis, json_f64,
        normalize_finish_reason, now_ms, release_retry_lock, retry_lock_path, run, sha1_hex,
        timestamp_order_nanos, try_acquire_retry_lock, BoundaryContext, Stamp,
    };
    use serde_json::{json, Value};
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    pub(super) fn invoke(
        root: &Path,
        args: &[&str],
        stdin: &str,
        extra: &[(&str, &str)],
    ) -> (i32, String) {
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        env.insert("HOME".into(), root.to_string_lossy().into_owned());
        env.insert("USERPROFILE".into(), root.to_string_lossy().into_owned());
        env.insert("LOONGSUITE_PILOT_USER_ID".into(), "user-1".into());
        for (key, value) in extra {
            env.insert((*key).to_string(), (*value).to_string());
        }
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &args,
            stdin: stdin.as_bytes(),
            env: &env,
            stdout: &mut stdout,
        };
        let code = run(&mut request);
        (code, String::from_utf8(stdout).expect("utf8"))
    }

    pub(super) fn write_transcript(path: &Path, rows: &[Value]) {
        let body = rows
            .iter()
            .map(|row| serde_json::to_string(row).expect("row"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(path, body).expect("transcript");
    }

    pub(super) fn read_history(root: &Path, agent: &str) -> Vec<Value> {
        let dir = root.join("logs").join(agent).join("history");
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut files: Vec<_> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .collect();
        files.sort();
        let mut rows = Vec::new();
        for file in files {
            let text = fs::read_to_string(file).unwrap_or_default();
            for line in text.lines().filter(|line| !line.is_empty()) {
                rows.push(serde_json::from_str(line).expect("history json"));
            }
        }
        rows
    }

    fn names(records: &[Value]) -> Vec<&str> {
        records
            .iter()
            .filter_map(|record| record.get("event.name").and_then(Value::as_str))
            .collect()
    }

    #[test]
    fn preserves_sub_millisecond_transcript_order() {
        let second = timestamp_order_nanos("2026-09-05T02:36:00Z").expect("second");
        assert_eq!(
            timestamp_order_nanos("2026-09-05T02:36:00.000100Z"),
            Some(second + 100_000)
        );
        assert_eq!(
            timestamp_order_nanos("2026-09-05T02:36:00.000900Z"),
            Some(second + 900_000)
        );
        let rows = vec![
            json!({
                "type": "user",
                "timestamp": "2026-08-03T09:22:25.100000Z",
                "message": {"role": "user", "content": "run two tools"}
            }),
            json!({
                "type": "assistant",
                "timestamp": "2026-08-03T09:22:25.555446Z",
                "message": {"content": [{"type": "tool_use", "id": "tool-b", "name": "Read", "input": {}}]}
            }),
            json!({
                "type": "user",
                "timestamp": "2026-08-03T09:22:26.668419Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "tool-b", "content": "ok"}]}
            }),
            json!({
                "type": "assistant",
                "timestamp": "2026-08-03T09:22:26.999890Z",
                "message": {"content": [{"type": "tool_use", "id": "tool-c", "name": "Read", "input": {}}]}
            }),
        ];
        let boundaries = build_llm_boundaries(&rows);
        assert_eq!(
            boundaries
                .iter()
                .map(|boundary| boundary.start_ts.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-08-03T09:22:25.555446Z", "2026-08-03T09:22:26.999890Z"]
        );
        let user_ms = date_parse_millis("2026-08-03T09:22:25.100Z").expect("user ms");
        let tool_ms = date_parse_millis("2026-08-03T09:22:26.668Z").expect("tool ms");
        let records = build_events_from_boundaries(
            &boundaries,
            &rows,
            &rows,
            "turn-microseconds",
            BoundaryContext {
                session_id: "session-1",
                agent_id: "qoder",
                runtime_user: "user-1",
                identity: None,
                cwd: None,
                stamp: &Stamp {
                    span: Obj::new(),
                    agent_name: None,
                    resources: Obj::new(),
                },
            },
        );
        let requests: Vec<_> = records
            .iter()
            .filter(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("llm.request")
            })
            .map(|record| {
                record
                    .get("time_unix_nano")
                    .and_then(Value::as_str)
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            requests,
            vec![
                (user_ms as i128 * 1_000_000 + 1).to_string(),
                (tool_ms as i128 * 1_000_000 + 419_001).to_string(),
            ]
        );
    }

    #[test]
    fn qoder_cli_uses_completed_native_usage_without_double_counting_cache() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"user","entrypoint":"cli","uuid":"native-user",
                    "timestamp":"2026-07-20T10:00:01.000Z","message":{"role":"user","content":"hello"}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:02.000Z",
                    "requestTokenAnchor":{"requestId":"native-request"},
                    "message":{"id":"native-response","model":"qoder-test",
                    "content":[{"type":"thinking","thinking":"fixture"}],
                    "usage":{"input_tokens":0,"output_tokens":0}}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:03.000Z",
                    "requestTokenAnchor":{"requestId":"native-request"},
                    "message":{"id":"native-response","model":"qoder-test",
                    "content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":3789,"output_tokens":93,
                             "cache_read_input_tokens":3072,"cache_creation_input_tokens":0}}}),
                json!({"type":"last-prompt","lastPrompt":"hello"}),
            ],
        );
        let (code, _) = invoke(
            root,
            &["--agent-id", "qoder", "--log-prefix", "qoder"],
            &json!({"session_id":"native-session","transcript_path":transcript,"cwd":root})
                .to_string(),
            &[],
        );
        assert_eq!(code, 0);
        let records = read_history(root, "qoder");
        let responses: Vec<_> = records
            .iter()
            .filter(|event| event["event.name"] == "llm.response")
            .collect();
        assert_eq!(responses.len(), 1);
        let response = responses[0];
        assert_eq!(response["gen_ai.agent.type"], "qoder-cli");
        assert_eq!(response["agent.client_request_id"], "native-request");
        assert_eq!(response["gen_ai.usage.input_tokens"], 3789);
        assert_eq!(response["gen_ai.usage.output_tokens"], 93);
        assert_eq!(response["gen_ai.usage.total_tokens"], 3882);
        assert_eq!(response["gen_ai.usage.cache_read.input_tokens"], 3072);
        assert_eq!(response["gen_ai.usage.cache_creation.input_tokens"], 0);
    }

    #[test]
    fn finish_reason_maps_vendor_values_and_drops_unknown() {
        assert_eq!(normalize_finish_reason("tool_use"), Some("tool_call"));
        assert_eq!(normalize_finish_reason("stop_sequence"), Some("stop"));
        assert_eq!(normalize_finish_reason("refusal"), Some("stop"));
        assert_eq!(
            normalize_finish_reason("model_context_window_exceeded"),
            Some("length")
        );
        assert_eq!(normalize_finish_reason("end_turn"), Some("end_turn"));
        assert_eq!(normalize_finish_reason("cancelled"), Some("cancelled"));
        assert_eq!(normalize_finish_reason("pause_turn"), None);
        assert_eq!(normalize_finish_reason("some_future_reason"), None);
        assert_eq!(normalize_finish_reason(""), None);
    }

    #[test]
    fn merges_thinking_text_and_tools_and_splits_turns() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"progress","timestamp":"2026-07-20T10:00:00.000Z","data":{"hookEvent":"UserPromptSubmit","hookName":"pilot"}}),
                json!({"type":"user","uuid":"user-1","timestamp":"2026-07-20T10:00:01.000Z","message":{"role":"user","content":"list the files"}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:02.000Z","requestTokenAnchor":{"requestId":"req-native-1"},"message":{"model":"qwen-max","content":[
                    {"type":"thinking","thinking":"look"},
                    {"type":"text","text":"running"},
                    {"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"ls"}},
                    {"type":"tool_use","id":"call-2","name":"Read","input":{"path":"a.txt"}}
                ],"stop_reason":"tool_use"}}),
                json!({"type":"user","timestamp":"2026-07-20T10:00:05.000Z","message":{"content":[
                    {"type":"tool_result","tool_use_id":"call-2","content":"data"},
                    {"type":"tool_result","tool_use_id":"call-1","content":"a.txt"}
                ]}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:06.000Z","requestTokenAnchor":{"requestId":"req-native-2"},"message":{
                    "id":"message-2","model":"qwen-max",
                    "content":[{"type":"text","text":"there is a.txt"}],
                    "stop_reason":"end_turn",
                    "usage":{"request_id":"req-2"}
                }}),
                json!({"type":"progress","timestamp":"2026-07-20T10:00:07.000Z","data":{"hookEvent":"Stop"}}),
                json!({"type":"last-prompt","lastPrompt":"list the files"}),
            ],
        );
        let traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
        let (code, stdout) = invoke(
            root,
            &["--agent-id", "qoder", "--log-prefix", "qoder"],
            &json!({
                "session_id": "session-ide",
                "transcript_path": transcript,
                "cwd": "/tmp/qoder-project",
            })
            .to_string(),
            &[
                ("TRACEPARENT", traceparent),
                (
                    "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                    "multica.issue.id=AGE-992,gen_ai.session.id=env-session,gen_ai.agent.name=blocked",
                ),
                ("AGENTTEAMS_WORKER_NAME", "worker-a"),
            ],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let records = read_history(root, "qoder");
        assert!(names(&records).contains(&"other"));
        assert_eq!(
            records
                .iter()
                .filter(|record| record.get("gen_ai.turn.start") == Some(&Value::Bool(true)))
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.get("gen_ai.turn.end") == Some(&Value::Bool(true)))
                .count(),
            1
        );
        assert_eq!(
            records[0].get("event.name").and_then(Value::as_str),
            Some("other")
        );
        assert_eq!(
            records
                .last()
                .and_then(|record| record.get("event.name"))
                .and_then(Value::as_str),
            Some("llm.response")
        );
        let responses: Vec<_> = records
            .iter()
            .filter(|record| {
                record.get("event.name").and_then(Value::as_str) == Some("llm.response")
            })
            .collect();
        assert_eq!(responses.len(), 2);
        let first_parts = &responses[0]["gen_ai.output.messages"][0]["parts"];
        assert_eq!(
            first_parts
                .as_array()
                .unwrap()
                .iter()
                .map(|part| part.get("type").and_then(Value::as_str).unwrap())
                .collect::<Vec<_>>(),
            vec!["reasoning", "text", "tool_call", "tool_call"]
        );
        assert_eq!(
            responses[0]["gen_ai.response.finish_reasons"],
            json!(["tool_call"])
        );
        assert_eq!(responses[0]["agent.stop_reason"], json!("tool_use"));
        assert_eq!(
            responses[0]["agent.client_request_id"],
            json!("req-native-1")
        );
        assert_eq!(responses[1]["agent.client_request_id"], json!("req-2"));
        assert_eq!(responses[1]["gen_ai.response.id"], json!("message-2"));
        assert_eq!(responses[1]["gen_ai.turn.end"], json!(true));
        let calls: Vec<_> = records
            .iter()
            .filter(|record| record.get("event.name").and_then(Value::as_str) == Some("tool.call"))
            .collect();
        assert_eq!(calls[0]["gen_ai.tool.call.id"], json!("call-1"));
        assert_eq!(
            calls[0]["gen_ai.tool.call.arguments"],
            json!("{\"command\":\"ls\"}")
        );
        assert_eq!(
            records[records
                .iter()
                .position(|record| record.get("event.name") == Some(&json!("tool.call")))
                .unwrap()
                + 1]["gen_ai.tool.call.result"],
            json!("a.txt")
        );
        assert_eq!(calls[1]["gen_ai.tool.call.id"], json!("call-2"));
        assert!(records.iter().all(|record| {
            let event = record.get("event.name").and_then(Value::as_str);
            if !matches!(event, Some("other" | "llm.request" | "llm.response")) {
                return true;
            }
            record.get("gen_ai.provider.name") == Some(&json!("qwen"))
        }));
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.type") == Some(&json!("qoder"))));
        assert!(records
            .iter()
            .all(|record| record.get("agent.qoder.cwd") == Some(&json!("/tmp/qoder-project"))));
        assert!(records
            .iter()
            .all(|record| record.get("agent.transcript.cursor_mode") == Some(&json!("bootstrap"))));
        assert!(records
            .iter()
            .all(|record| record.get("agent.transcript.cursor_reason")
                == Some(&json!("missing-cursor"))));
        assert!(records
            .iter()
            .all(|record| record.get("multica.issue.id") == Some(&json!("AGE-992"))));
        assert!(records
            .iter()
            .all(|record| record.get("agent.pilot.invocation.session.id")
                == Some(&json!("env-session"))));
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.name") == Some(&json!("worker-a"))));
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.name") != Some(&json!("blocked"))));
        let correlate = fs::read_to_string(root.join("acp-correlate").join("session-ide.jsonl"))
            .expect("upstream");
        assert!(correlate.contains(traceparent));
        let second_request = records
            .iter()
            .find(|record| {
                record.get("event.name") == Some(&json!("llm.request"))
                    && record
                        .get("gen_ai.step.id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.ends_with(":s2"))
            })
            .expect("second request");
        assert_eq!(
            second_request["gen_ai.input.messages_delta"][0]["parts"][0]["id"],
            json!("call-1")
        );
        assert_eq!(
            second_request["gen_ai.input.messages_delta"][1]["parts"][0]["response"],
            json!("data")
        );
    }

    #[test]
    fn cold_start_keeps_only_the_latest_turn_then_incremental() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        let turn = |index: i32, prompt: &str| {
            vec![
                json!({"type":"user","timestamp": format!("2026-07-20T10:00:{:02}.000Z", 10 + index), "message":{"content": prompt}}),
                json!({"type":"assistant","timestamp": format!("2026-07-20T10:00:{:02}.500Z", 10 + index), "message":{"content":[{"type":"text","text": format!("answer {index}")}], "stop_reason":"end_turn"}}),
            ]
        };
        let mut rows = turn(1, "historical prompt 1");
        rows.extend(turn(2, "historical prompt 2"));
        rows.push(json!({"type":"last-prompt","lastPrompt":"historical prompt 2"}));
        write_transcript(&transcript, &rows);
        let (code, _) = invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"session-old","transcript_path": transcript, "cwd":"/tmp/p"})
                .to_string(),
            &[],
        );
        assert_eq!(code, 0);
        let history = read_history(root, "qoder");
        let prompts: Vec<_> = history
            .iter()
            .filter(|record| record.get("event.name") == Some(&json!("other")))
            .map(|record| {
                record["gen_ai.input.messages_delta"][0]["parts"][0]["content"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(prompts, vec!["historical prompt 2".to_string()]);
        assert!(history
            .iter()
            .all(|record| record.get("agent.transcript.cursor_mode") == Some(&json!("bootstrap"))));
        let before = history.len();
        rows.extend(turn(3, "new prompt 3"));
        rows.push(json!({"type":"last-prompt","lastPrompt":"new prompt 3"}));
        write_transcript(&transcript, &rows);
        invoke(
            root,
            &["--agent-id", "qoder", "--log-prefix", "qoder"],
            &json!({"session_id":"session-old","transcript_path": transcript}).to_string(),
            &[],
        );
        let added = &read_history(root, "qoder")[before..];
        let prompts: Vec<_> = added
            .iter()
            .filter(|record| record.get("event.name") == Some(&json!("other")))
            .map(|record| {
                record["gen_ai.input.messages_delta"][0]["parts"][0]["content"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(prompts, vec!["new prompt 3"]);
        assert!(added.iter().all(
            |record| record.get("agent.transcript.cursor_mode") == Some(&json!("incremental"))
        ));
    }

    #[test]
    fn drops_cli_control_rows_and_keeps_one_legacy_other() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"user","entrypoint":"cli","isMeta":true,"timestamp":"2026-08-27T06:50:52.808Z","message":{"content":"<local-command-caveat>Caveat text</local-command-caveat>"}}),
                json!({"type":"user","entrypoint":"cli","timestamp":"2026-08-27T06:50:53.808Z","message":{"content":"<command-message>model</command-message>\n<command-name>/model</command-name>"}}),
                json!({"type":"user","entrypoint":"cli","isMeta":true,"timestamp":"2026-08-27T06:50:54.808Z","message":{"content":"<local-command-stdout>Model set</local-command-stdout>"}}),
                json!({"type":"user","entrypoint":"cli","promptId":"p1","timestamp":"2026-08-27T06:50:56.000Z","message":{"content":"杭州天气"}}),
                json!({"type":"assistant","timestamp":"2026-08-27T06:50:57.000Z","message":{"model":"auto","content":[{"type":"text","text":"多云"}],"stop_reason":"end_turn"}}),
                json!({"type":"last-prompt","lastPrompt":"杭州天气"}),
            ],
        );
        let (code, stdout) = invoke(
            root,
            &["--agent-id", "qoder", "--log-prefix", "qoder"],
            &json!({"session_id":"cli","transcript_path": transcript}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let records = read_history(root, "qoder");
        let others: Vec<_> = records
            .iter()
            .filter(|record| record.get("event.name") == Some(&json!("other")))
            .collect();
        assert_eq!(others.len(), 1);
        assert_eq!(
            others[0]["gen_ai.input.messages_delta"][0]["parts"][0]["content"],
            json!("杭州天气")
        );
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.type") == Some(&json!("qoder-cli"))));
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.turn.start").is_none()
                && record.get("gen_ai.turn.end").is_none()));
        assert!(records.iter().all(|record| {
            let text = record.to_string();
            !text.contains("local-command-caveat")
        }));
    }

    #[test]
    fn legacy_prompt_without_assistant_emits_one_other_and_keeps_tool_result() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"user","entrypoint":"cli","promptId":"p1","userType":"external","timestamp":"2026-08-27T06:50:56.000Z","message":{"content":"跑一下测试"}}),
                json!({"type":"user","entrypoint":"cli","userType":"external","timestamp":"2026-08-27T06:50:58.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]},"toolUseResult":"ok"}),
                json!({"type":"last-prompt","lastPrompt":"跑一下测试"}),
            ],
        );
        invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"sess-1","transcript_path": transcript, "cwd":"/tmp"}).to_string(),
            &[],
        );
        let records = read_history(root, "qoder");
        assert_eq!(names(&records), vec!["other", "tool.result"]);
        assert_eq!(records[1]["gen_ai.tool.call.id"], json!("toolu_1"));
        let ids: HashSet<_> = records
            .iter()
            .filter(|record| record.get("event.name") == Some(&json!("other")))
            .map(|record| {
                record
                    .get("event.id")
                    .and_then(Value::as_str)
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn empty_transcript_stop_hooks_and_missing_file_write_empty_object() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("empty.jsonl");
        fs::write(&transcript, "").expect("empty");
        let (code, stdout) = invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"s","transcript_path": transcript}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(read_history(root, "qoder").is_empty());
        let (code, stdout) = invoke(
            root,
            &["--agent-id", "qoder-cn", "--log-prefix", "qoder-cn"],
            &json!({"stop_hooks_active": true, "session_id":"s","transcript_path": transcript})
                .to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        assert!(read_history(root, "qoder-cn").is_empty());
        let (code, stdout) = invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"s","transcript_path": root.join("missing.jsonl")}).to_string(),
            &[],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        let (code, stdout) = invoke(root, &["--agent-id", "qoder"], "", &[]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
    }

    #[test]
    fn qoder_cn_stamps_invocation_identity_and_turn_ends() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"user","timestamp":"2026-07-20T10:00:01.000Z","message":{"content":"list the files"}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:02.000Z","message":{"model":"qwen-max","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}),
                json!({"type":"last-prompt","lastPrompt":"list the files"}),
            ],
        );
        let (code, _) = invoke(
            root,
            &["--agent-id", "qoder-cn", "--log-prefix", "qoder-cn"],
            &json!({"session_id":"session-ide","transcript_path": transcript, "cwd":"/tmp/qoder-project", "extra":{"user":{"name":"cn-account"}}}).to_string(),
            &[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "gen_ai.session.id=env-session,gen_ai.user.id=env-user",
            )],
        );
        assert_eq!(code, 0);
        let records = read_history(root, "qoder-cn");
        assert!(!records.is_empty());
        assert!(records
            .iter()
            .all(|record| record.get("gen_ai.agent.type") == Some(&json!("qoder-cn"))));
        assert!(records
            .iter()
            .all(|record| record.get("agent.pilot.invocation.session.id")
                == Some(&json!("env-session"))));
        assert!(
            records
                .iter()
                .all(|record| record.get("agent.pilot.invocation.user.id")
                    == Some(&json!("env-user")))
        );
        assert!(records
            .iter()
            .all(|record| record.get("user.name") == Some(&json!("cn-account"))));
        assert_eq!(records[0].get("gen_ai.turn.start"), Some(&json!(true)));
        assert_eq!(
            records.last().unwrap().get("gen_ai.turn.end"),
            Some(&json!(true))
        );
    }

    #[test]
    fn retry_commits_the_anchored_turn_and_leaves_the_queued_prompt() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let transcript = root.join("transcript.jsonl");
        let rows = vec![
            json!({"type":"user","timestamp":"2026-07-20T10:00:10.000Z","message":{"content":"historical prompt"}}),
            json!({"type":"assistant","timestamp":"2026-07-20T10:00:10.500Z","message":{"content":[{"type":"text","text":"old"}],"stop_reason":"end_turn"}}),
            json!({"type":"progress","timestamp":"2026-07-31T04:33:41.000Z","data":{"hookEvent":"UserPromptSubmit","hookName":"UserPromptSubmit"}}),
            json!({"type":"user","timestamp":"2026-07-20T10:00:14.000Z","message":{"content":"target prompt"}}),
            json!({"type":"assistant","timestamp":"2026-07-20T10:00:14.500Z","message":{"content":[{"type":"text","text":"target"}],"stop_reason":"end_turn"}}),
            json!({"type":"progress","timestamp":"2026-07-31T04:33:41.000Z","data":{"hookEvent":"Stop","hookName":"Stop"}}),
            json!({"type":"progress","timestamp":"2026-07-31T04:33:41.000Z","data":{"hookEvent":"Stop","hookName":"Stop"}}),
            json!({"type":"session_meta","sessionId":"session-old"}),
            json!({"type":"progress","timestamp":"2026-07-31T04:33:41.000Z","data":{"hookEvent":"UserPromptSubmit","hookName":"UserPromptSubmit"}}),
            json!({"type":"user","uuid":"queued-user","timestamp":"2026-07-31T04:33:46.000Z","message":{"content":"queued prompt"}}),
        ];
        write_transcript(&transcript, &rows);
        let (code, stdout) = invoke(
            root,
            &[
                "--agent-id",
                "qoder",
                "--log-prefix",
                "qoder",
                "--retry",
                "--transcript",
                &transcript.to_string_lossy(),
                "--session",
                "session-old",
                "--trigger-end-line",
                "5",
                "--cwd",
                "/tmp/qoder-project",
            ],
            &json!({"name":"retry-user","email":"retry@example.com"}).to_string(),
            &[
                ("HOOK_RETRY_DELAY", "0"),
                ("HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS", "10"),
            ],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "");
        let records = read_history(root, "qoder");
        let prompts: Vec<_> = records
            .iter()
            .filter(|record| record.get("event.name") == Some(&json!("other")))
            .map(|record| {
                record["gen_ai.input.messages_delta"][0]["parts"][0]["content"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(prompts, vec!["target prompt"]);
        assert!(records
            .iter()
            .all(|record| record.get("user.name") == Some(&json!("retry-user"))));
        let cursor_dir = root.join("state").join("hooks").join("qoder-line-records");
        let cursor_file = fs::read_dir(&cursor_dir)
            .expect("cursor dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .expect("cursor");
        let cursor: Value =
            serde_json::from_str(&fs::read_to_string(cursor_file).unwrap()).unwrap();
        assert_eq!(cursor["last_line_count"], json!(8));
    }

    #[test]
    fn retry_lock_is_stable_and_replaces_a_dead_owner() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        let dir = tempfile::tempdir().expect("temp");
        let mut env = Env::new();
        env.insert(
            "LOONGSUITE_PILOT_DATA_DIR".into(),
            dir.path().to_string_lossy().into_owned(),
        );
        let transcript = PathBuf::from("/tmp/same-transcript.jsonl");
        let first = retry_lock_path(&env, "qoder", &transcript);
        let second = retry_lock_path(&env, "qoder", &transcript);
        assert_eq!(first, second);
        assert_ne!(
            first,
            retry_lock_path(&env, "qoder", Path::new("/tmp/other.jsonl"))
        );
        assert!(try_acquire_retry_lock(
            &env,
            "qoder",
            &transcript,
            "session"
        ));
        assert!(!try_acquire_retry_lock(
            &env,
            "qoder",
            &transcript,
            "session"
        ));
        release_retry_lock(&env, "qoder", &transcript);
        let stale = json!({"pid": u32::MAX, "sessionId": "other", "startedAt": now_ms()});
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::write(&first, stale.to_string()).unwrap();
        assert!(try_acquire_retry_lock(
            &env,
            "qoder",
            &transcript,
            "session"
        ));
        release_retry_lock(&env, "qoder", &transcript);
    }

    #[test]
    fn identity_cache_mtime_survives_json_roundtrip() {
        for fraction in 0..10_000 {
            let mtime = 1_780_000_000_000_f64 + fraction as f64 / 10_000.0;
            let body = serde_json::to_string(&json!({"mtimeMs":mtime})).unwrap();
            let parsed: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(json_f64(parsed.get("mtimeMs")), Some(mtime), "{body}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn cli_identity_is_cached_until_the_auth_file_changes() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let qoder = root.join(".qoder");
        let cli_dir = qoder.join("bin").join("qodercli");
        fs::create_dir_all(&cli_dir).unwrap();
        fs::create_dir_all(qoder.join(".auth")).unwrap();
        fs::write(cli_dir.join("version.txt"), "1.0.0\n").unwrap();
        let executable = cli_dir.join("qodercli-1.0.0");
        fs::write(
            &executable,
            "#!/bin/sh\ncount=0\nif [ -f \"$QODER_FAKE_COUNTER\" ]; then count=$(cat \"$QODER_FAKE_COUNTER\"); fi\ncount=$((count + 1))\nprintf '%s\\n' \"$count\" > \"$QODER_FAKE_COUNTER\"\nmode=$(cat \"$QODER_FAKE_MODE\")\ncase \"$mode\" in\n  logged-out) printf '%s\\n' '{\"logged_in\":false,\"username\":\"old\",\"email\":\"old@example.com\"}' ;;\n  switched) printf '%s\\n' '{\"logged_in\":true,\"username\":\"other\",\"email\":\"other@example.com\"}' ;;\n  *) printf '%s\\n' '{\"logged_in\":true,\"username\":\" cli-user \",\"email\":\" cli@example.com \"}' ;;\nesac\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let counter = root.join("counter.txt");
        let mode = root.join("mode.txt");
        fs::write(qoder.join(".auth").join("user"), "auth-a").unwrap();
        fs::write(&mode, "ok").unwrap();
        let transcript = root.join("session.jsonl");
        let turn = |index: i32, prompt: &str| {
            vec![
                json!({"type":"user","entrypoint":"cli","timestamp": format!("2026-07-20T10:00:{:02}.000Z", 10 + index), "message":{"content": prompt}}),
                json!({"type":"assistant","timestamp": format!("2026-07-20T10:00:{:02}.500Z", 10 + index), "message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
                json!({"type":"last-prompt","lastPrompt": prompt}),
            ]
        };
        let mut rows = turn(1, "cli prompt");
        write_transcript(&transcript, &rows);
        let counter_text = counter.to_string_lossy().into_owned();
        let mode_text = mode.to_string_lossy().into_owned();
        let extra = [
            ("QODER_FAKE_COUNTER", counter_text.as_str()),
            ("QODER_FAKE_MODE", mode_text.as_str()),
        ];
        invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"session-old","transcript_path": &transcript}).to_string(),
            &extra,
        );
        let history = read_history(root, "qoder");
        assert!(history
            .iter()
            .all(|record| record.get("user.name") == Some(&json!("cli-user"))
                && record.get("user.email") == Some(&json!("cli@example.com"))));
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1");
        rows.extend(turn(2, "second cli prompt"));
        write_transcript(&transcript, &rows);
        invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"session-old","transcript_path": &transcript}).to_string(),
            &extra,
        );
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1");
        fs::write(&mode, "switched").unwrap();
        fs::write(qoder.join(".auth").join("user"), "auth-b-changed").unwrap();
        rows.extend(turn(3, "switched prompt"));
        write_transcript(&transcript, &rows);
        let before = read_history(root, "qoder").len();
        invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"session-old","transcript_path": &transcript}).to_string(),
            &extra,
        );
        assert!(read_history(root, "qoder")[before..]
            .iter()
            .all(|record| record.get("user.name") == Some(&json!("other"))));
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "2");
    }

    #[cfg(unix)]
    #[test]
    fn logged_out_cli_status_is_cached_and_ide_identity_does_not_spawn() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path();
        let qoder = root.join(".qoder");
        let cli_dir = qoder.join("bin").join("qodercli");
        fs::create_dir_all(&cli_dir).unwrap();
        fs::create_dir_all(qoder.join(".auth")).unwrap();
        fs::write(cli_dir.join("version.txt"), "1.0.0\n").unwrap();
        let executable = cli_dir.join("qodercli-1.0.0");
        fs::write(
            &executable,
            "#!/bin/sh\ncount=0\nif [ -f \"$QODER_FAKE_COUNTER\" ]; then count=$(cat \"$QODER_FAKE_COUNTER\"); fi\ncount=$((count + 1))\nprintf '%s\\n' \"$count\" > \"$QODER_FAKE_COUNTER\"\nprintf '%s\\n' '{\"logged_in\":false}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let counter = root.join("counter.txt");
        fs::write(qoder.join(".auth").join("user"), "auth-a").unwrap();
        let transcript = root.join("session.jsonl");
        write_transcript(
            &transcript,
            &[
                json!({"type":"user","entrypoint":"cli","timestamp":"2026-07-20T10:00:11.000Z","message":{"content":"logged out prompt"}}),
                json!({"type":"assistant","timestamp":"2026-07-20T10:00:11.500Z","message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
                json!({"type":"last-prompt"}),
            ],
        );
        let payload =
            json!({"session_id":"session-old","transcript_path": &transcript}).to_string();
        invoke(
            root,
            &["--agent-id", "qoder"],
            &payload,
            &[("QODER_FAKE_COUNTER", counter.to_string_lossy().as_ref())],
        );
        assert!(read_history(root, "qoder")
            .iter()
            .all(|record| record.get("user.name").is_none()));
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1");
        let mut rows = vec![
            json!({"type":"user","entrypoint":"cli","timestamp":"2026-07-20T10:00:11.000Z","message":{"content":"logged out prompt"}}),
            json!({"type":"assistant","timestamp":"2026-07-20T10:00:11.500Z","message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
            json!({"type":"user","entrypoint":"cli","timestamp":"2026-07-20T10:00:13.000Z","message":{"content":"still logged out"}}),
            json!({"type":"assistant","timestamp":"2026-07-20T10:00:13.500Z","message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
        ];
        write_transcript(&transcript, &rows);
        invoke(
            root,
            &["--agent-id", "qoder"],
            &payload,
            &[("QODER_FAKE_COUNTER", counter.to_string_lossy().as_ref())],
        );
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1");

        let ide = root.join("ide.jsonl");
        rows = vec![
            json!({"type":"user","timestamp":"2026-07-20T10:00:11.000Z","message":{"content":"IDE prompt"}}),
            json!({"type":"assistant","timestamp":"2026-07-20T10:00:11.500Z","message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
            json!({"type":"last-prompt"}),
        ];
        write_transcript(&ide, &rows);
        invoke(
            root,
            &["--agent-id", "qoder"],
            &json!({"session_id":"ide-session","transcript_path": &ide, "extra":{"user":{"name":" ide-user ","email":" ide@example.com "}}}).to_string(),
            &[("QODER_FAKE_COUNTER", counter.to_string_lossy().as_ref())],
        );
        let ide_records = read_history(root, "qoder")
            .into_iter()
            .filter(|record| record.get("gen_ai.session.id") == Some(&json!("ide-session")))
            .collect::<Vec<_>>();
        assert!(!ide_records.is_empty());
        assert!(ide_records
            .iter()
            .all(|record| record.get("user.name") == Some(&json!("ide-user"))
                && record.get("user.email") == Some(&json!("ide@example.com"))));
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1");
    }

    #[test]
    fn parallel_tools_stay_one_response_until_the_cycle_completes() {
        let assistant = |timestamp: &str, content: Value, stop: Option<&str>| {
            let mut message = json!({"role": "assistant", "content": content});
            if let Some(stop) = stop {
                message["stop_reason"] = json!(stop);
            }
            json!({"type":"assistant","timestamp": timestamp, "message": message})
        };
        let tool_result = |timestamp: &str, id: &str| json!({"type":"user","timestamp": timestamp, "message":{"content":[{"type":"tool_result","tool_use_id": id, "content":"ok"}]}});
        let merged = vec![
            assistant(
                "2026-07-30T01:00:00.000Z",
                json!([{"type":"thinking","thinking":"reason"}]),
                None,
            ),
            assistant(
                "2026-07-30T01:00:05.000Z",
                json!([{"type":"text","text":"summary"}]),
                None,
            ),
            assistant(
                "2026-07-30T01:00:06.000Z",
                json!([{"type":"tool_use","id":"tool-a","name":"Read","input":{}}]),
                None,
            ),
            assistant(
                "2026-07-30T01:00:06.001Z",
                json!([{"type":"tool_use","id":"tool-b","name":"Read","input":{}}]),
                None,
            ),
        ];
        assert_eq!(build_llm_boundaries(&merged).len(), 1);
        let interleaved = vec![
            assistant(
                "2026-07-30T01:00:00.000Z",
                json!([{"type":"tool_use","id":"tool-a","name":"Read","input":{}}]),
                None,
            ),
            assistant(
                "2026-07-30T01:00:00.001Z",
                json!([{"type":"tool_use","id":"tool-b","name":"Read","input":{}}]),
                None,
            ),
            tool_result("2026-07-30T01:00:00.002Z", "tool-a"),
            assistant(
                "2026-07-30T01:00:00.003Z",
                json!([{"type":"tool_use","id":"tool-c","name":"Read","input":{}}]),
                None,
            ),
        ];
        assert_eq!(build_llm_boundaries(&interleaved).len(), 1);
        let sequential = vec![
            assistant(
                "2026-07-30T01:00:00.000Z",
                json!([{"type":"tool_use","id":"tool-a","name":"Read","input":{}}]),
                None,
            ),
            tool_result("2026-07-30T01:00:01.000Z", "tool-a"),
            assistant(
                "2026-07-30T01:00:02.000Z",
                json!([{"type":"tool_use","id":"tool-b","name":"Read","input":{}}]),
                None,
            ),
        ];
        assert_eq!(build_llm_boundaries(&sequential).len(), 2);
    }
}

#[cfg(test)]
#[path = "qoder_compat_contract_tests.rs"]
mod compat_contract_tests;

#[cfg(test)]
#[path = "qoder_finish_boundary_contract_tests.rs"]
mod finish_boundary_contract_tests;

#[cfg(test)]
#[path = "qoder_identity_tests.rs"]
mod identity_tests;

#[cfg(test)]
#[path = "qoder_retry_lock_history_tests.rs"]
mod retry_lock_history_tests;

#[cfg(test)]
#[path = "qoder_retry_boundary_history_tests.rs"]
mod retry_boundary_history_tests;

#[cfg(test)]
#[path = "qoder_retry_window_history_tests.rs"]
mod retry_window_history_tests;

#[cfg(test)]
#[path = "qoder_collected_typed_arguments_tests.rs"]
mod collected_typed_arguments_tests;

#[cfg(test)]
#[path = "../normalization/qoder_agent_event_history_tests.rs"]
mod qoder_agent_event_history_tests;

#[cfg(test)]
#[path = "shared_privacy_history_tests.rs"]
mod shared_privacy_history_tests;

#[cfg(test)]
#[path = "qoder_main522_identity_contract_tests.rs"]
mod main522_identity_contract_tests;
