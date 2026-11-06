//! Loopback HTTP API: `/health`, `/v1/hooks/evaluate`, `/v1/hooks/qwenwork`.

use crate::interceptor::access_log::{
    access_input_from_hook_request, access_input_from_payload, build_access_log_entry,
    write_interceptor_access_log, AccessLogAction, AccessLogLimits, InterceptorAccessInput,
    InterceptorAccessLogEntry, InterceptorAccessResult,
};
use crate::interceptor::adapters::{
    parse_qwen_work_hook_request, qwen_work_allow_body, qwen_work_block_body,
};
use crate::interceptor::blocked_prompt::build_blocked_qoder_prompt_entry;
use crate::interceptor::rules::RuleEngine;
use crate::interceptor::tool_verdict_store::{
    is_tool_intercept_phase, ToolVerdictAction, ToolVerdictKey,
};
use crate::interceptor::types::{
    EvaluateHookResponse, HookEventName, HookRequest, InterceptorAgent, InterceptorHealth,
    VerdictAction, INTERCEPTOR_SERVICE,
};
use crate::types::AgentActivityEntry;
use crate::utils::create_logger;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const MAX_HOOK_BODY_BYTES: usize = 5 * 1024 * 1024;

pub struct InterceptorServerOptions {
    pub version: String,
    pub engine: RuleEngine,
    pub write_access_log: Option<Arc<dyn Fn(InterceptorAccessLogEntry) + Send + Sync>>,
    pub write_tool_verdict: Option<Arc<dyn Fn(ToolVerdictKey, ToolVerdictAction) + Send + Sync>>,
    pub emit_blocked_prompt: Option<Arc<dyn Fn(AgentActivityEntry) + Send + Sync>>,
}

struct ServerState {
    version: String,
    engine: RuleEngine,
    port: AtomicU16,
    write_access_log: Option<Arc<dyn Fn(InterceptorAccessLogEntry) + Send + Sync>>,
    write_tool_verdict: Option<Arc<dyn Fn(ToolVerdictKey, ToolVerdictAction) + Send + Sync>>,
    emit_blocked_prompt: Option<Arc<dyn Fn(AgentActivityEntry) + Send + Sync>>,
    logger: crate::utils::BoundLogger,
}

pub struct InterceptorServer {
    state: Arc<ServerState>,
    cancel: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

pub fn create_interceptor_server(opts: InterceptorServerOptions) -> InterceptorServer {
    let (cancel, _) = watch::channel(false);
    InterceptorServer {
        state: Arc::new(ServerState {
            version: opts.version,
            engine: opts.engine,
            port: AtomicU16::new(0),
            write_access_log: opts.write_access_log,
            write_tool_verdict: opts.write_tool_verdict,
            emit_blocked_prompt: opts.emit_blocked_prompt,
            logger: create_logger("InterceptorServer"),
        }),
        cancel,
        task: tokio::sync::Mutex::new(None),
    }
}

impl InterceptorServer {
    pub async fn listen(&self, preferred: u16) -> std::io::Result<u16> {
        let listener = match TcpListener::bind(("127.0.0.1", preferred)).await {
            Ok(listener) => listener,
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse && preferred != 0 => {
                TcpListener::bind(("127.0.0.1", 0)).await?
            }
            Err(err) => return Err(err),
        };
        let port = listener.local_addr()?.port();
        self.state.port.store(port, Ordering::SeqCst);
        let state = Arc::clone(&self.state);
        let mut cancel = self.cancel.subscribe();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            let _ = handle_connection(socket, state).await;
                        });
                    }
                }
            }
        });
        *self.task.lock().await = Some(task);
        Ok(port)
    }

    pub async fn close(&self) {
        let _ = self.cancel.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }

    pub fn port(&self) -> u16 {
        self.state.port.load(Ordering::SeqCst)
    }
}

async fn handle_connection(mut socket: TcpStream, state: Arc<ServerState>) -> std::io::Result<()> {
    let request = match read_request(&mut socket).await {
        Ok(request) => request,
        Err(ReadError::TooLarge { path }) => {
            record_access(
                &state,
                "unknown",
                None,
                None,
                None,
                InterceptorAccessInput::default(),
                access_result(
                    AccessLogAction::FailOpen,
                    None,
                    None,
                    None,
                    Some("request body too large"),
                ),
            );
            let body = if path == "/v1/hooks/qwenwork" {
                qwen_work_allow_body()
            } else {
                serde_json::to_value(EvaluateHookResponse::fail_open(Vec::new()))
                    .unwrap_or(serde_json::json!({}))
            };
            write_json(&mut socket, 200, &body).await?;
            return Ok(());
        }
        Err(_) => return Ok(()),
    };
    let response = dispatch(&state, &request).await;
    write_json(&mut socket, response.status, &response.body).await
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    body: Value,
}

async fn dispatch(state: &ServerState, request: &HttpRequest) -> HttpResponse {
    if request.method == "GET" && request.path == "/health" {
        let body = serde_json::to_value(InterceptorHealth {
            service: INTERCEPTOR_SERVICE.to_string(),
            status: "ok".to_string(),
            pid: u64::from(std::process::id()),
            version: state.version.clone(),
            daemon_port: state.port.load(Ordering::SeqCst),
        })
        .unwrap_or(serde_json::json!({}));
        return HttpResponse { status: 200, body };
    }
    if request.method == "POST" && request.path == "/v1/hooks/qwenwork" {
        return handle_qwen(state, &request.body).await;
    }
    if request.method == "POST" && request.path == "/v1/hooks/evaluate" {
        return handle_evaluate(state, &request.body).await;
    }
    HttpResponse {
        status: 404,
        body: serde_json::json!({"error": "not-found"}),
    }
}

async fn handle_evaluate(state: &ServerState, body: &[u8]) -> HttpResponse {
    let parsed = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(err) => {
            record_access(
                state,
                "unknown",
                None,
                None,
                None,
                InterceptorAccessInput::default(),
                access_result(
                    AccessLogAction::FailOpen,
                    None,
                    None,
                    None,
                    Some(&err.to_string()),
                ),
            );
            return HttpResponse {
                status: 500,
                body: serde_json::json!({"error": "internal"}),
            };
        }
    };
    let Some(request) = hook_request_from_value(&parsed) else {
        let event = parsed
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let agent = parsed.get("agent").and_then(Value::as_str);
        let input =
            parsed
                .as_object()
                .map(access_input_from_payload)
                .unwrap_or(InterceptorAccessInput {
                    raw: Some(parsed.clone()),
                    ..InterceptorAccessInput::default()
                });
        record_access(
            state,
            event,
            agent,
            None,
            None,
            input,
            access_result(
                AccessLogAction::FailOpen,
                None,
                None,
                None,
                Some("invalid-request"),
            ),
        );
        return HttpResponse {
            status: 400,
            body: serde_json::json!({"error": "invalid-request"}),
        };
    };
    let verdict = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.engine.evaluate(&request)
    }));
    let verdict = match verdict {
        Ok(verdict) => verdict,
        Err(_) => EvaluateHookResponse::fail_open(Vec::new()),
    };
    record_tool_verdict(
        state,
        &request,
        if verdict.fail_open == Some(true) {
            None
        } else {
            Some(verdict.action)
        },
    );
    record_access(
        state,
        request.event.as_str(),
        Some(request.agent.as_str()),
        request.session_id.as_deref(),
        request.tool_use_id.as_deref(),
        access_input_from_hook_request(&request),
        access_result(
            match verdict.action {
                VerdictAction::Allow => AccessLogAction::Allow,
                VerdictAction::Block => AccessLogAction::Block,
            },
            verdict.reason.as_deref(),
            verdict.rule_id.as_deref(),
            Some(verdict.evaluated_rules.clone()),
            None,
        ),
    );
    let body = serde_json::to_value(&verdict).unwrap_or(serde_json::json!({}));
    emit_blocked_prompt(state, &request, &verdict);
    HttpResponse { status: 200, body }
}

async fn handle_qwen(state: &ServerState, body: &[u8]) -> HttpResponse {
    let parsed = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(err) => {
            record_access(
                state,
                "unknown",
                Some("qwen-work-cn"),
                None,
                None,
                InterceptorAccessInput::default(),
                access_result(
                    AccessLogAction::FailOpen,
                    None,
                    None,
                    None,
                    Some(&err.to_string()),
                ),
            );
            return HttpResponse {
                status: 200,
                body: qwen_work_allow_body(),
            };
        }
    };
    let payload = parsed.as_object().cloned();
    let request = payload
        .as_ref()
        .and_then(|payload| parse_qwen_work_hook_request(payload, None));
    let Some(request) = request else {
        let event = payload
            .as_ref()
            .and_then(|payload| payload.get("hook_event_name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let input =
            payload
                .as_ref()
                .map(access_input_from_payload)
                .unwrap_or(InterceptorAccessInput {
                    raw: Some(parsed),
                    ..InterceptorAccessInput::default()
                });
        record_access(
            state,
            event,
            Some("qwen-work-cn"),
            None,
            None,
            input,
            access_result(
                AccessLogAction::FailOpen,
                None,
                None,
                None,
                Some("unsupported hook event"),
            ),
        );
        return HttpResponse {
            status: 200,
            body: qwen_work_allow_body(),
        };
    };
    let verdict = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.engine.evaluate(&request)
    })) {
        Ok(verdict) => verdict,
        Err(err) => {
            record_tool_verdict(state, &request, None);
            record_access(
                state,
                request.event.as_str(),
                Some(request.agent.as_str()),
                request.session_id.as_deref(),
                request.tool_use_id.as_deref(),
                access_input_from_hook_request(&request),
                access_result(
                    AccessLogAction::FailOpen,
                    None,
                    None,
                    None,
                    Some(&panic_message(&err)),
                ),
            );
            return HttpResponse {
                status: 200,
                body: qwen_work_allow_body(),
            };
        }
    };
    record_tool_verdict(
        state,
        &request,
        if verdict.fail_open == Some(true) {
            None
        } else {
            Some(verdict.action)
        },
    );
    record_access(
        state,
        request.event.as_str(),
        Some(request.agent.as_str()),
        request.session_id.as_deref(),
        request.tool_use_id.as_deref(),
        access_input_from_hook_request(&request),
        access_result(
            match verdict.action {
                VerdictAction::Allow => AccessLogAction::Allow,
                VerdictAction::Block => AccessLogAction::Block,
            },
            verdict.reason.as_deref(),
            verdict.rule_id.as_deref(),
            Some(verdict.evaluated_rules.clone()),
            None,
        ),
    );
    if verdict.action != VerdictAction::Block {
        return HttpResponse {
            status: 200,
            body: qwen_work_allow_body(),
        };
    }
    let body = qwen_work_block_body(&request, verdict.reason.as_deref());
    emit_blocked_prompt(state, &request, &verdict);
    HttpResponse { status: 200, body }
}

fn emit_blocked_prompt(state: &ServerState, request: &HookRequest, verdict: &EvaluateHookResponse) {
    let Some(emit) = &state.emit_blocked_prompt else {
        return;
    };
    if verdict.fail_open == Some(true) || verdict.action != VerdictAction::Block {
        return;
    }
    if request.event != HookEventName::UserPromptSubmit {
        return;
    }
    if request.agent != InterceptorAgent::Qoder && request.agent != InterceptorAgent::QoderCli {
        return;
    }
    let entry = build_blocked_qoder_prompt_entry(request, None);
    if let Err(err) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(entry))) {
        let mut meta = Map::new();
        meta.insert("error".to_string(), Value::String(panic_message(&err)));
        state.logger.warn("blocked prompt emit failed", Some(&meta));
    }
}

fn record_tool_verdict(state: &ServerState, request: &HookRequest, action: Option<VerdictAction>) {
    let Some(write) = &state.write_tool_verdict else {
        return;
    };
    let Some(tool_use_id) = request.tool_use_id.clone() else {
        return;
    };
    if tool_use_id.is_empty() {
        return;
    }
    let Some(phase) = is_tool_intercept_phase(request.event) else {
        return;
    };
    let Some(action) = action else {
        return;
    };
    let result = match action {
        VerdictAction::Allow => ToolVerdictAction::Allow,
        VerdictAction::Block => ToolVerdictAction::Block,
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        write(
            ToolVerdictKey {
                session_id: request.session_id.clone(),
                tool_use_id,
                phase,
            },
            result,
        );
    }));
}

fn record_access(
    state: &ServerState,
    event: &str,
    agent: Option<&str>,
    session_id: Option<&str>,
    tool_use_id: Option<&str>,
    input: InterceptorAccessInput,
    result: InterceptorAccessResult,
) {
    let entry = build_access_log_entry(InterceptorAccessLogEntry {
        ts: String::new(),
        event: event.to_string(),
        agent: agent.map(str::to_string),
        session_id: session_id.map(str::to_string),
        tool_use_id: tool_use_id.map(str::to_string),
        input,
        result,
    });
    if let Some(write) = &state.write_access_log {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| write(entry)));
    } else {
        write_interceptor_access_log(&entry, None, AccessLogLimits::default());
    }
}

fn access_result(
    action: AccessLogAction,
    reason: Option<&str>,
    rule_id: Option<&str>,
    evaluated_rules: Option<Vec<String>>,
    error: Option<&str>,
) -> InterceptorAccessResult {
    InterceptorAccessResult {
        action,
        reason: reason.map(str::to_string),
        rule_id: rule_id.map(str::to_string),
        evaluated_rules,
        error: error.map(str::to_string),
    }
}

fn hook_request_from_value(value: &Value) -> Option<HookRequest> {
    let obj = value.as_object()?;
    let event = obj.get("event")?.as_str()?;
    if !crate::interceptor::types::SUPPORTED_HOOK_EVENTS.contains(&event) {
        return None;
    }
    let agent = obj.get("agent")?.as_str()?;
    InterceptorAgent::parse(agent)?;
    serde_json::from_value(value.clone()).ok()
}

fn panic_message(err: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = err.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = err.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    "internal".to_string()
}

enum ReadError {
    TooLarge { path: String },
    Other,
}

async fn read_request(socket: &mut TcpStream) -> Result<HttpRequest, ReadError> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let header_end = loop {
        if buf.len() > 64 * 1024 {
            return Err(ReadError::TooLarge {
                path: String::new(),
            });
        }
        let n = socket.read(&mut tmp).await.map_err(|_| ReadError::Other)?;
        if n == 0 {
            return Err(ReadError::Other);
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts
        .next()
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    let mut content_length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length > MAX_HOOK_BODY_BYTES {
        // Closing a Windows TCP socket with unread request bytes resets the
        // connection and can discard the fail-open response. Drain only small
        // overflows, without retaining or parsing their content. Both the byte
        // budget and time budget bound an incomplete/untrusted upload.
        if content_length <= MAX_HOOK_BODY_BYTES.saturating_add(64 * 1024) {
            let mut remaining = content_length.saturating_sub(buf.len() - header_end - 4);
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), async {
                while remaining > 0 {
                    let limit = remaining.min(tmp.len());
                    let n = socket.read(&mut tmp[..limit]).await?;
                    if n == 0 {
                        break;
                    }
                    remaining -= n;
                }
                Ok::<(), std::io::Error>(())
            })
            .await;
        }
        return Err(ReadError::TooLarge { path });
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = socket.read(&mut tmp).await.map_err(|_| ReadError::Other)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
        if body.len() > MAX_HOOK_BODY_BYTES {
            return Err(ReadError::TooLarge { path: path.clone() });
        }
    }
    body.truncate(content_length);
    Ok(HttpRequest { method, path, body })
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn write_json(socket: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let payload = format!(
        "{}\n",
        serde_json::to_string(body).unwrap_or_else(|_| "null".to_string())
    );
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(payload.as_bytes()).await?;
    socket.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::adapters::wrap_host_reason;
    use crate::interceptor::rules::{LocalRule, RuleEngine};
    use crate::interceptor::types::{HookEventName, HookRequest, InterceptorAgent, RuleResult};
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    struct Demo {
        throws: bool,
    }

    impl LocalRule for Demo {
        fn id(&self) -> &str {
            if self.throws {
                "boom"
            } else {
                "demo"
            }
        }
        fn supports(&self, _: &HookRequest) -> bool {
            true
        }
        fn evaluate(&self, request: &HookRequest) -> Result<RuleResult, String> {
            if self.throws {
                return Err("rule failed".into());
            }
            let secret_prompt = request.prompt.as_deref() == Some("secret");
            let secret_command = request
                .tool_input
                .as_ref()
                .and_then(|value| value.get("command"))
                .and_then(Value::as_str)
                == Some("secret");
            let bash = request.tool_name.as_deref() == Some("Bash");
            if secret_prompt
                || secret_command
                || (bash
                    && request.event == HookEventName::PreToolUse
                    && request.agent == InterceptorAgent::QwenWorkCn)
            {
                let reason = if request.agent == InterceptorAgent::QwenWorkCn {
                    "[APIKEY_MASKED]"
                } else {
                    "blocked by demo"
                };
                return Ok(RuleResult::Match {
                    reason: reason.to_string(),
                });
            }
            Ok(RuleResult::Miss)
        }
    }

    struct AlwaysBlock;

    impl LocalRule for AlwaysBlock {
        fn id(&self) -> &str {
            "demo"
        }
        fn supports(&self, _: &HookRequest) -> bool {
            true
        }
        fn evaluate(&self, _: &HookRequest) -> Result<RuleResult, String> {
            Ok(RuleResult::Match {
                reason: "blocked by demo".into(),
            })
        }
    }

    fn engine(rule: Arc<dyn LocalRule>) -> RuleEngine {
        let id = rule.id().to_string();
        RuleEngine::new(vec![rule], std::collections::HashSet::from([id]))
    }

    async fn listen(
        rule: Arc<dyn LocalRule>,
    ) -> (
        InterceptorServer,
        u16,
        Arc<Mutex<Vec<Value>>>,
        Arc<Mutex<Vec<Value>>>,
    ) {
        let access = Arc::new(Mutex::new(Vec::new()));
        let verdicts = Arc::new(Mutex::new(Vec::new()));
        let access_cb = access.clone();
        let verdict_cb = verdicts.clone();
        let server = create_interceptor_server(InterceptorServerOptions {
            version: "1.2.3".into(),
            engine: engine(rule),
            write_access_log: Some(Arc::new(move |entry| {
                access_cb
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(&entry).unwrap());
            })),
            write_tool_verdict: Some(Arc::new(move |key, result| {
                verdict_cb.lock().unwrap().push(serde_json::json!({
                    "sessionId": key.session_id,
                    "toolUseId": key.tool_use_id,
                    "phase": key.phase,
                    "result": result.as_str(),
                }));
            })),
            emit_blocked_prompt: None,
        });
        let port = server.listen(0).await.unwrap();
        (server, port, access, verdicts)
    }

    async fn post(port: u16, path: &str, body: Value) -> (u16, Value) {
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{port}{path}"))
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&body).unwrap())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(text.trim()).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn serves_health_and_writes_access_logs() {
        let (server, port, access, verdicts) = listen(Arc::new(Demo { throws: false })).await;
        let client = reqwest::Client::new();
        let health: Value = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["service"], INTERCEPTOR_SERVICE);
        assert_eq!(health["status"], "ok");
        assert_eq!(health["version"], "1.2.3");
        assert_eq!(health["daemon_port"], port);

        let (_, allowed) = post(port, "/v1/hooks/evaluate", serde_json::json!({
            "agent": "qoder", "event": "PostToolUse", "prompt": "hello", "toolName": "Bash",
            "toolResponse": {"stdout": "ok"}, "toolUseId": "qoder-post-1", "sessionId": "qoder-session",
            "raw": {"hook_event_name": "PostToolUse"}
        })).await;
        assert_eq!(allowed["action"], "allow");
        let (_, blocked) = post(
            port,
            "/v1/hooks/evaluate",
            serde_json::json!({
                "agent": "qoder", "event": "UserPromptSubmit", "prompt": "secret", "raw": {}
            }),
        )
        .await;
        assert_eq!(blocked["action"], "block");
        assert_eq!(blocked["reason"], "blocked by demo");
        assert_eq!(blocked["ruleId"], "demo");
        let (_, openclaw) = post(port, "/v1/hooks/evaluate", serde_json::json!({
            "agent": "openclaw", "event": "PreToolUse", "toolName": "exec",
            "toolInput": {"command": "secret"}, "toolUseId": "open-pre-1", "sessionId": "open-session",
            "raw": {"openclaw_hook": "before_tool_call"}
        })).await;
        assert_eq!(openclaw["action"], "block");
        assert_eq!(openclaw["reason"], "blocked by demo");
        assert_eq!(openclaw["ruleId"], "demo");
        {
            let logs = access.lock().unwrap();
            assert_eq!(logs.len(), 3);
            assert_eq!(logs[0]["event"], "PostToolUse");
            assert_eq!(logs[0]["input"]["prompt"], "hello");
            assert_eq!(logs[0]["input"]["toolName"], "Bash");
            assert_eq!(
                logs[0]["input"]["toolResponse"],
                serde_json::json!({"stdout":"ok"})
            );
            assert_eq!(logs[0]["result"]["action"], "allow");
            assert_eq!(logs[1]["event"], "UserPromptSubmit");
            assert_eq!(logs[1]["input"]["prompt"], "secret");
            assert_eq!(logs[1]["result"]["action"], "block");
            assert_eq!(logs[1]["result"]["reason"], "blocked by demo");
            assert_eq!(logs[1]["result"]["ruleId"], "demo");
            assert_eq!(logs[2]["event"], "PreToolUse");
            assert_eq!(logs[2]["agent"], "openclaw");
            assert_eq!(logs[2]["result"]["action"], "block");
            assert_eq!(logs[2]["result"]["reason"], "blocked by demo");
            assert_eq!(logs[2]["result"]["ruleId"], "demo");
        }
        assert_eq!(
            *verdicts.lock().unwrap(),
            vec![
                serde_json::json!({"sessionId":"qoder-session","toolUseId":"qoder-post-1","phase":"PostToolUse","result":"allow"}),
                serde_json::json!({"sessionId":"open-session","toolUseId":"open-pre-1","phase":"PreToolUse","result":"block"})
            ]
        );
        assert_eq!(access.lock().unwrap().len(), 3);
        assert_eq!(verdicts.lock().unwrap().len(), 2);
        assert_eq!(verdicts.lock().unwrap()[0]["result"], "allow");
        assert_eq!(verdicts.lock().unwrap()[1]["phase"], "PreToolUse");
        server.close().await;
    }

    #[tokio::test]
    async fn serves_qwenwork_http_hooks() {
        let (server, port, access, verdicts) = listen(Arc::new(Demo { throws: false })).await;
        let (status, blocked) = post(port, "/v1/hooks/qwenwork", serde_json::json!({
            "event": "UserPromptSubmit", "hook_event_name": "UserPromptSubmit", "prompt": "secret", "session_id": "session-xxxx"
        })).await;
        assert_eq!(status, 200);
        assert_eq!(blocked["decision"], "block");
        assert_eq!(
            blocked["reason"],
            wrap_host_reason(HookEventName::UserPromptSubmit, Some("[APIKEY_MASKED]"))
        );
        let (status, pre) = post(port, "/v1/hooks/qwenwork", serde_json::json!({
            "event": "PreToolUse", "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": "id"}, "tool_use_id": "qwen-pre-1", "session_id": "qwen-session"
        })).await;
        assert_eq!(status, 200);
        assert_eq!(
            blocked,
            serde_json::json!({
                "decision":"block","reason":wrap_host_reason(HookEventName::UserPromptSubmit,Some("[APIKEY_MASKED]"))
            })
        );
        assert_eq!(
            pre,
            serde_json::json!({"hookSpecificOutput":{
                "hookEventName":"PreToolUse","permissionDecision":"deny",
                "permissionDecisionReason":wrap_host_reason(HookEventName::PreToolUse,Some("[APIKEY_MASKED]"))
            }})
        );
        let client = reqwest::Client::new();
        let malformed = client
            .post(format!("http://127.0.0.1:{port}/v1/hooks/qwenwork"))
            .header("Content-Type", "application/json")
            .body("{")
            .send()
            .await
            .unwrap();
        assert_eq!(malformed.status(), 200);
        assert_eq!(malformed.text().await.unwrap().trim(), "{}");
        let (allowed_status, allowed) = post(
            port,
            "/v1/hooks/qwenwork",
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello"}),
        )
        .await;
        assert_eq!(allowed_status, 200);
        assert_eq!(allowed, serde_json::json!({}));
        let (skipped_status, skipped) = post(
            port,
            "/v1/hooks/qwenwork",
            serde_json::json!({"hook_event_name": "Stop"}),
        )
        .await;
        assert_eq!(skipped_status, 200);
        assert_eq!(skipped, serde_json::json!({}));
        let logged = access.lock().unwrap().clone();
        assert_eq!(
            logged.last().unwrap()["result"]["error"],
            "unsupported hook event"
        );
        assert!(verdicts
            .lock()
            .unwrap()
            .iter()
            .any(|item| item==&serde_json::json!({
                "sessionId":"qwen-session","toolUseId":"qwen-pre-1","phase":"PreToolUse","result":"block"
            })));
        server.close().await;
    }

    #[tokio::test]
    async fn does_not_store_a_verdict_when_a_rule_throws() {
        let (server, port, _, verdicts) = listen(Arc::new(Demo { throws: true })).await;
        let (_, body) = post(port, "/v1/hooks/evaluate", serde_json::json!({
            "agent": "qodercli", "event": "PreToolUse", "toolName": "Bash", "toolUseId": "cli-pre-1", "sessionId": "cli-session", "raw": {}
        })).await;
        assert_eq!(body["action"], "allow");
        assert_eq!(body["failOpen"], true);
        assert!(verdicts.lock().unwrap().is_empty());
        server.close().await;
    }

    #[tokio::test]
    async fn emits_an_llm_request_only_for_a_denied_qoder_user_prompt() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let emitted_cb = emitted.clone();
        let server = create_interceptor_server(InterceptorServerOptions {
            version: "1.2.3".into(),
            engine: engine(Arc::new(Demo { throws: false })),
            write_access_log: Some(Arc::new(|_| {})),
            write_tool_verdict: None,
            emit_blocked_prompt: Some(Arc::new(move |entry| {
                emitted_cb
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(&entry).unwrap());
            })),
        });
        let port = server.listen(0).await.unwrap();
        let (_, desktop_verdict) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "qoder", "event": "UserPromptSubmit", "prompt": "secret", "sessionId": "s-desktop", "cwd": "/tmp/desktop", "raw": {}})).await;
        let (_, cli_verdict) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "qodercli", "event": "UserPromptSubmit", "prompt": "secret", "sessionId": "s-cli", "raw": {}})).await;
        let (_, allow) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "qoder", "event": "UserPromptSubmit", "prompt": "hello", "raw": {}})).await;
        assert_eq!(allow["action"], "allow");
        let (_, tool_verdict) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "qoder", "event": "PreToolUse", "prompt": "secret", "toolName": "Bash", "toolUseId": "tool-1", "raw": {}})).await;
        let (_, open_verdict) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "openclaw", "event": "UserPromptSubmit", "prompt": "secret", "raw": {}})).await;
        for verdict in [desktop_verdict, cli_verdict, tool_verdict, open_verdict] {
            assert_eq!(verdict["action"], "block");
        }
        let rows = emitted.lock().unwrap().clone();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["event.name"], "llm.request");
        assert_eq!(rows[0]["gen_ai.session.id"], "s-desktop");
        assert_eq!(rows[0]["workspace.path"], "/tmp/desktop");
        assert_eq!(rows[0]["agent.source"], "interceptor");
        assert_eq!(rows[0]["gen_ai.agent.type"], "qoder-cli");
        assert_eq!(rows[0]["gen_ai.guardrail.action"], "block");
        assert_eq!(rows[1]["gen_ai.agent.type"], "qoder-cli");
        assert_eq!(rows[1]["gen_ai.guardrail.triggered"], true);
        assert_eq!(rows[1]["gen_ai.session.id"], "s-cli");
        assert!(rows[1].get("workspace.path").is_none());
        server.close().await;
    }

    #[tokio::test]
    async fn sink_error_still_blocks_the_host_and_qwen_does_not_emit() {
        let fail_open_emitted = Arc::new(Mutex::new(0));
        let fail_open = create_interceptor_server(InterceptorServerOptions {
            version: "1.2.3".into(),
            engine: engine(Arc::new(Demo { throws: true })),
            write_access_log: Some(Arc::new(|_| {})),
            write_tool_verdict: None,
            emit_blocked_prompt: Some(Arc::new({
                let emitted = fail_open_emitted.clone();
                move |_| *emitted.lock().unwrap() += 1
            })),
        });
        let port = fail_open.listen(0).await.unwrap();
        let (_, verdict) = post(
            port,
            "/v1/hooks/evaluate",
            serde_json::json!({
                "agent":"qodercli","event":"UserPromptSubmit","prompt":"secret","raw":{}
            }),
        )
        .await;
        assert_eq!(verdict["action"], "allow");
        assert_eq!(verdict["failOpen"], true);
        assert_eq!(*fail_open_emitted.lock().unwrap(), 0);
        fail_open.close().await;
        let server = create_interceptor_server(InterceptorServerOptions {
            version: "1.2.3".into(),
            engine: engine(Arc::new(AlwaysBlock)),
            write_access_log: Some(Arc::new(|_| {})),
            write_tool_verdict: None,
            emit_blocked_prompt: Some(Arc::new(|_| panic!("sink failed"))),
        });
        let port = server.listen(0).await.unwrap();
        let (status, body) = post(port, "/v1/hooks/evaluate", serde_json::json!({"agent": "qoder", "event": "UserPromptSubmit", "prompt": "secret", "raw": {}})).await;
        assert_eq!(status, 200);
        assert_eq!(body["action"], "block");
        assert_eq!(body["ruleId"], "demo");
        server.close().await;

        let emitted = Arc::new(Mutex::new(0u32));
        let emitted_cb = emitted.clone();
        let qwen = create_interceptor_server(InterceptorServerOptions {
            version: "1.2.3".into(),
            engine: engine(Arc::new(AlwaysBlock)),
            write_access_log: Some(Arc::new(|_| {})),
            write_tool_verdict: None,
            emit_blocked_prompt: Some(Arc::new(move |_| {
                *emitted_cb.lock().unwrap() += 1;
            })),
        });
        let port = qwen.listen(0).await.unwrap();
        let (status, body) = post(
            port,
            "/v1/hooks/qwenwork",
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "secret"}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["decision"], "block");
        assert_eq!(*emitted.lock().unwrap(), 0);
        qwen.close().await;
    }

    #[tokio::test]
    async fn oversized_advertised_body_does_not_wait_for_an_unsent_upload() {
        let (server, port, _, _) = listen(Arc::new(Demo { throws: false })).await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("POST /v1/hooks/evaluate HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n\r\n", MAX_HOOK_BODY_BYTES + 1);
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            socket.read_to_string(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        let body: Value =
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1.trim()).unwrap();
        assert_eq!(body["action"], "allow");
        assert_eq!(body["failOpen"], true);
        server.close().await;
    }

    #[tokio::test]
    async fn fail_opens_an_oversized_evaluate_body() {
        let (server, port, _, _) = listen(Arc::new(Demo { throws: false })).await;
        let huge = format!("{{\"prompt\":\"{}\"}}", "x".repeat(MAX_HOOK_BODY_BYTES));
        let client = reqwest::Client::new();
        let evaluated = client
            .post(format!("http://127.0.0.1:{port}/v1/hooks/evaluate"))
            .header("Content-Type", "application/json")
            .body(huge.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(evaluated.status(), 200);
        let body: Value = serde_json::from_str(evaluated.text().await.unwrap().trim()).unwrap();
        assert_eq!(body["action"], "allow");
        assert_eq!(body["failOpen"], true);
        let qwen = client
            .post(format!("http://127.0.0.1:{port}/v1/hooks/qwenwork"))
            .header("Content-Type", "application/json")
            .body(huge)
            .send()
            .await
            .unwrap();
        assert_eq!(qwen.status(), 200);
        assert_eq!(qwen.json::<Value>().await.unwrap(), serde_json::json!({}));
        server.close().await;
    }
}
