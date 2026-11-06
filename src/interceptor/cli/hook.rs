//! `interceptor hook` fail-opens unless the daemon identity matches.

use super::daemon_client::{DaemonClient, HookClient};
use super::qoder_surface::resolve_qoder_surface;
use crate::interceptor::access_log::{
    access_input_from_hook_request, access_input_from_payload, build_access_log_entry,
    write_interceptor_access_log, AccessLogAction, AccessLogLimits, InterceptorAccessInput,
    InterceptorAccessLogEntry, InterceptorAccessResult,
};
use crate::interceptor::adapters::{
    parse_hook_request, parse_openclaw_hook_request, parse_qwen_work_hook_request,
    render_openclaw_block, render_qoder_block, render_qwen_work_block, wrap_host_reason,
};
use crate::interceptor::paths::interceptor_runtime_path;
use crate::interceptor::types::QoderSurface;
use crate::interceptor::types::{HookRequest, InterceptorAgent, INTERCEPTOR_SERVICE};
use serde_json::{Map, Value};
use std::sync::Arc;

pub type HookLogger = Box<dyn FnMut(&str, Option<&Map<String, Value>>) + Send>;
pub type HookClientFactory = Box<dyn Fn(u16) -> Arc<dyn HookClient> + Send>;
pub type AccessLogWriter = Box<dyn FnMut(&InterceptorAccessLogEntry) + Send>;

pub struct HookCliDeps {
    pub read_stdin: Box<dyn Fn() -> Result<String, ()> + Send>,
    pub write_stdout: Box<dyn FnMut(String) + Send>,
    pub log: HookLogger,
    pub runtime_path: Option<String>,
    pub resolve_surface: Option<Box<dyn Fn() -> Option<QoderSurface> + Send>>,
    pub create_client: Option<HookClientFactory>,
    pub write_access_log: Option<AccessLogWriter>,
}

struct RuntimeIdentity {
    pid: u64,
    version: String,
    daemon_port: u16,
}

pub async fn run_hook(args: &[String], deps: &mut HookCliDeps) -> i32 {
    let raw = match (deps.read_stdin)() {
        Ok(raw) => raw,
        Err(_) => {
            (deps.log)("failed to read stdin", None);
            record_fail_open(
                deps,
                "unknown",
                InterceptorAccessInput {
                    raw_text: Some(String::new()),
                    ..InterceptorAccessInput::default()
                },
                "failed to read stdin",
                None,
                None,
                None,
            );
            return 0;
        }
    };
    let payload = match parse_payload(&raw) {
        Ok(payload) => payload,
        Err(_) => {
            (deps.log)("failed to parse host stdin", None);
            record_fail_open(
                deps,
                "unknown",
                InterceptorAccessInput {
                    raw_text: Some(raw),
                    ..InterceptorAccessInput::default()
                },
                "failed to parse host stdin",
                None,
                None,
                None,
            );
            return 0;
        }
    };
    let event_hint = flag_value(args, "--event");
    let event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .or_else(|| payload.get("openclaw_hook").and_then(Value::as_str))
        .unwrap_or(event_hint.unwrap_or("unknown"));
    let event_name = event_name.to_string();
    let input = access_input_from_payload(&payload);
    let agent_flag = flag_value(args, "--agent");
    let surface = if agent_flag == Some("qoder-auto") {
        match &deps.resolve_surface {
            Some(resolve) => resolve().map(|surface| surface.as_agent()),
            None => resolve_qoder_surface().map(|surface| surface.as_agent()),
        }
    } else {
        agent_flag.and_then(InterceptorAgent::parse)
    };
    let Some(surface) = surface else {
        (deps.log)("hook target is missing or unknown, fail-open", None);
        record_fail_open(
            deps,
            &event_name,
            input,
            "hook target is missing or unknown",
            None,
            None,
            None,
        );
        return 0;
    };
    let request = match surface {
        InterceptorAgent::OpenClaw => parse_openclaw_hook_request(&payload, event_hint),
        InterceptorAgent::QwenWorkCn => parse_qwen_work_hook_request(&payload, event_hint),
        other => parse_hook_request(&payload, other, event_hint),
    };
    let Some(request) = request else {
        (deps.log)("skipping unsupported hook event", None);
        record_fail_open(
            deps,
            &event_name,
            input,
            "unsupported hook event",
            Some(surface.as_str()),
            None,
            None,
        );
        return 0;
    };
    let runtime_path = deps
        .runtime_path
        .clone()
        .unwrap_or_else(|| interceptor_runtime_path(None).to_string_lossy().to_string());
    let Some(runtime) = read_runtime(&runtime_path) else {
        (deps.log)("interceptor runtime missing, fail-open", None);
        record_fail_open(
            deps,
            request.event.as_str(),
            access_input_from_hook_request(&request),
            "interceptor runtime missing",
            Some(request.agent.as_str()),
            request.session_id.as_deref(),
            request.tool_use_id.as_deref(),
        );
        return 0;
    };
    let client: Arc<dyn HookClient> = match &deps.create_client {
        Some(create) => create(runtime.daemon_port),
        None => Arc::new(DaemonClient::new(runtime.daemon_port)),
    };
    match client.health().await {
        Ok(health) if health.version == runtime.version && health.pid == runtime.pid => {
            match client.check_hook(&request).await {
                Ok(verdict) => emit_verdict(
                    &request,
                    verdict.action.as_str(),
                    verdict.reason.as_deref(),
                    &mut deps.write_stdout,
                ),
                Err(err) => {
                    let mut extra = Map::new();
                    extra.insert("error".to_string(), Value::String(err.message.clone()));
                    (deps.log)("daemon hook request failed, fail-open", Some(&extra));
                    record_fail_open(
                        deps,
                        request.event.as_str(),
                        access_input_from_hook_request(&request),
                        &err.message,
                        Some(request.agent.as_str()),
                        request.session_id.as_deref(),
                        request.tool_use_id.as_deref(),
                    );
                }
            }
        }
        Ok(health) => {
            let mut extra = Map::new();
            extra.insert("runtimeVersion".to_string(), Value::String(runtime.version));
            extra.insert("healthVersion".to_string(), Value::String(health.version));
            extra.insert("runtimePid".to_string(), Value::from(runtime.pid));
            extra.insert("healthPid".to_string(), Value::from(health.pid));
            (deps.log)("daemon identity mismatch, fail-open", Some(&extra));
            record_fail_open(
                deps,
                request.event.as_str(),
                access_input_from_hook_request(&request),
                "daemon identity mismatch",
                Some(request.agent.as_str()),
                request.session_id.as_deref(),
                request.tool_use_id.as_deref(),
            );
        }
        Err(err) => {
            let mut extra = Map::new();
            extra.insert("error".to_string(), Value::String(err.message.clone()));
            (deps.log)("daemon hook request failed, fail-open", Some(&extra));
            record_fail_open(
                deps,
                request.event.as_str(),
                access_input_from_hook_request(&request),
                &err.message,
                Some(request.agent.as_str()),
                request.session_id.as_deref(),
                request.tool_use_id.as_deref(),
            );
        }
    }
    0
}

fn record_fail_open(
    deps: &mut HookCliDeps,
    event: &str,
    input: InterceptorAccessInput,
    error: &str,
    agent: Option<&str>,
    session_id: Option<&str>,
    tool_use_id: Option<&str>,
) {
    let entry = build_access_log_entry(InterceptorAccessLogEntry {
        ts: String::new(),
        event: event.to_string(),
        agent: agent.map(str::to_string),
        session_id: session_id.map(str::to_string),
        tool_use_id: tool_use_id.map(str::to_string),
        input,
        result: InterceptorAccessResult {
            action: AccessLogAction::FailOpen,
            reason: None,
            rule_id: None,
            evaluated_rules: None,
            error: Some(error.to_string()),
        },
    });
    if let Some(write) = deps.write_access_log.as_mut() {
        write(&entry);
    } else {
        write_interceptor_access_log(&entry, None, AccessLogLimits::default());
    }
}

pub fn emit_verdict(
    request: &HookRequest,
    action: &str,
    reason: Option<&str>,
    write_stdout: &mut dyn FnMut(String),
) {
    if action != "block" {
        return;
    }
    let text = match request.agent {
        InterceptorAgent::OpenClaw => render_openclaw_block(request, reason),
        InterceptorAgent::QwenWorkCn => render_qwen_work_block(request, reason),
        _ => render_qoder_block(request, &wrap_host_reason(request.event, reason)),
    };
    write_stdout(text);
}

fn flag_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).map(String::as_str)
}

fn parse_payload(raw: &str) -> Result<Map<String, Value>, ()> {
    if raw.trim().is_empty() {
        return Err(());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    value.as_object().cloned().ok_or(())
}

fn read_runtime(path: &str) -> Option<RuntimeIdentity> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    if obj.get("service")?.as_str()? != INTERCEPTOR_SERVICE {
        return None;
    }
    if obj.get("status")?.as_str()? != "ok" {
        return None;
    }
    let port = obj.get("daemon_port")?.as_i64()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    Some(RuntimeIdentity {
        pid: obj.get("pid").and_then(Value::as_u64).unwrap_or(0),
        version: obj
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        daemon_port: port as u16,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::access_log::{AccessLogAction, InterceptorAccessLogEntry};
    use crate::interceptor::adapters::wrap_host_reason;
    use crate::interceptor::cli::daemon_client::HookClient;
    use crate::interceptor::types::QoderSurface;
    use crate::interceptor::types::{
        EvaluateHookResponse, HookEventName, HookRequest, InterceptorAgent, InterceptorHealth,
        VerdictAction,
    };
    use async_trait::async_trait;
    use serde_json::Map;
    use std::sync::{Arc, Mutex};

    struct ScriptedClient {
        health: Mutex<Result<InterceptorHealth, String>>,
        verdict: EvaluateHookResponse,
    }

    #[async_trait]
    impl HookClient for ScriptedClient {
        async fn check_hook(
            &self,
            _: &HookRequest,
        ) -> Result<EvaluateHookResponse, crate::interceptor::cli::daemon_client::DaemonClientError>
        {
            Ok(self.verdict.clone())
        }
        async fn health(
            &self,
        ) -> Result<InterceptorHealth, crate::interceptor::cli::daemon_client::DaemonClientError>
        {
            self.health.lock().unwrap().clone().map_err(|message| {
                crate::interceptor::cli::daemon_client::DaemonClientError {
                    code: "unavailable".to_string(),
                    message,
                }
            })
        }
    }

    fn health_ok() -> InterceptorHealth {
        InterceptorHealth {
            service: INTERCEPTOR_SERVICE.to_string(),
            status: "ok".to_string(),
            pid: 4242,
            version: "1.0.2".to_string(),
            daemon_port: 18791,
        }
    }

    fn runtime_file(pid: u64, version: &str) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::json!({
                    "service": INTERCEPTOR_SERVICE,
                    "status": "ok",
                    "pid": pid,
                    "version": version,
                    "daemon_port": 18791,
                    "packageVersion": version,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                })
            ),
        )
        .unwrap();
        std::mem::forget(dir);
        path.to_string_lossy().to_string()
    }

    fn deps(
        stdin: String,
        stdout: Arc<Mutex<Vec<String>>>,
        logs: Arc<Mutex<Vec<String>>>,
        access: Arc<Mutex<Vec<InterceptorAccessLogEntry>>>,
        runtime: Option<String>,
        client: Option<Arc<dyn HookClient>>,
    ) -> HookCliDeps {
        HookCliDeps {
            read_stdin: Box::new(move || Ok(stdin.clone())),
            write_stdout: Box::new({
                let stdout = stdout.clone();
                move |text| stdout.lock().unwrap().push(text)
            }),
            log: Box::new({
                let logs = logs.clone();
                move |message, _| logs.lock().unwrap().push(message.to_string())
            }),
            runtime_path: runtime
                .or_else(|| Some("/tmp/missing-interceptor-runtime.json".to_string())),
            resolve_surface: Some(Box::new(|| Some(QoderSurface::Qoder))),
            create_client: client.map(|client| {
                Box::new(move |_port| client.clone())
                    as Box<dyn Fn(u16) -> Arc<dyn HookClient> + Send>
            }),
            write_access_log: Some(Box::new({
                let access = access.clone();
                move |entry| access.lock().unwrap().push(entry.clone())
            })),
        }
    }

    #[tokio::test]
    async fn fail_opens_on_illegal_stdin() {
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let mut hook_deps = deps(
            "{".to_string(),
            stdout.clone(),
            logs.clone(),
            access.clone(),
            None,
            None,
        );
        let code = run_hook(&["--agent".into(), "qoder-auto".into()], &mut hook_deps).await;
        assert_eq!(code, 0);
        assert!(stdout.lock().unwrap().is_empty());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("parse")));
        let entries = access.lock().unwrap().clone();
        assert_eq!(entries[0].event, "unknown");
        assert_eq!(entries[0].input.raw_text.as_deref(), Some("{"));
        assert_eq!(entries[0].result.action, AccessLogAction::FailOpen);
        assert_eq!(
            entries[0].result.error.as_deref(),
            Some("failed to parse host stdin")
        );
    }

    #[tokio::test]
    async fn fail_opens_when_runtime_is_missing() {
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            access.clone(),
            Some("/tmp/missing-interceptor-runtime.json".into()),
            None,
        );
        let code = run_hook(&["--agent".into(), "qoder".into()], &mut hook_deps).await;
        assert_eq!(code, 0);
        assert!(stdout.lock().unwrap().is_empty());
        let entries = access.lock().unwrap().clone();
        assert_eq!(entries[0].event, "UserPromptSubmit");
        assert_eq!(entries[0].input.prompt.as_deref(), Some("hello"));
        assert_eq!(entries[0].result.action, AccessLogAction::FailOpen);
        assert_eq!(
            entries[0].result.error.as_deref(),
            Some("interceptor runtime missing")
        );
    }

    #[tokio::test]
    async fn fail_opens_when_health_identity_does_not_match() {
        let path = runtime_file(4242, "1.0.2");
        let access = Arc::new(Mutex::new(Vec::new()));
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(InterceptorHealth {
                pid: 1,
                version: "other".to_string(),
                ..health_ok()
            })),
            verdict: EvaluateHookResponse::block("x".into(), "demo".into(), vec![]),
        });
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            access.clone(),
            Some(path),
            Some(client),
        );
        let code = run_hook(&["--agent".into(), "qoder".into()], &mut hook_deps).await;
        assert_eq!(code, 0);
        assert!(stdout.lock().unwrap().is_empty());
        assert_eq!(
            access.lock().unwrap()[0].result.error.as_deref(),
            Some("daemon identity mismatch")
        );
        let entries = access.lock().unwrap();
        assert_eq!(entries[0].event, "UserPromptSubmit");
        assert_eq!(entries[0].result.action, AccessLogAction::FailOpen);
    }

    #[tokio::test]
    async fn fail_opens_when_the_daemon_request_throws() {
        let path = runtime_file(4242, "1.0.2");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ScriptedClient {
            health: Mutex::new(Err("timeout".into())),
            verdict: EvaluateHookResponse::allow(vec![]),
        });
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            access.clone(),
            Some(path),
            Some(client),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qoder".into()], &mut hook_deps).await,
            0
        );
        assert_eq!(
            access.lock().unwrap()[0].result.error.as_deref(),
            Some("timeout")
        );
        assert!(stdout.lock().unwrap().is_empty());
        let entries = access.lock().unwrap();
        assert_eq!(entries[0].event, "UserPromptSubmit");
        assert_eq!(entries[0].result.action, AccessLogAction::FailOpen);
    }

    #[tokio::test]
    async fn emits_host_stdout_for_a_blocking_tool_hook() {
        let path = runtime_file(4242, "1.0.2");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let allow = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(health_ok())),
            verdict: EvaluateHookResponse::allow(vec!["apiKey".into()]),
        });
        let mut allow_deps = deps(
            serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "qwen-s1", "tool_use_id": "qwen-post-1", "tool_name": "Bash", "tool_response": {"stdout": "ok"}}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Some(path.clone()),
            Some(allow),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qwen-work-cn".into()], &mut allow_deps).await,
            0
        );
        let block = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(health_ok())),
            verdict: EvaluateHookResponse::block(
                "[APIKEY_MASKED]".into(),
                "apiKey".into(),
                vec!["apiKey".into()],
            ),
        });
        let mut block_deps = deps(
            serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "qoder-s1", "tool_use_id": "qoder-pre-1", "tool_name": "Bash", "tool_input": {"command": "id"}}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Some(path),
            Some(block),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qoder".into()], &mut block_deps).await,
            0
        );
        let lines = stdout.lock().unwrap().clone();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("permissionDecision"));
    }

    #[tokio::test]
    async fn tool_hook_missing_runtime_never_evaluates_or_creates_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name":"PreToolUse","session_id":"s1","tool_use_id":"call-1","tool_name":"Bash","tool_input":{"command":"id"}}).to_string(),
            stdout.clone(), Arc::new(Mutex::new(Vec::new())), access.clone(),
            Some(root.path().join("missing-runtime.json").to_string_lossy().into_owned()), None,
        );
        hook_deps.create_client = Some(Box::new(|_| {
            panic!("missing runtime must not create a client")
        }));
        assert_eq!(
            run_hook(&["--agent".into(), "qodercli".into()], &mut hook_deps).await,
            0
        );
        assert!(stdout.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        let entries = access.lock().unwrap();
        assert_eq!(entries[0].event, "PreToolUse");
        assert_eq!(entries[0].tool_use_id.as_deref(), Some("call-1"));
        assert_eq!(entries[0].result.action, AccessLogAction::FailOpen);
    }

    #[tokio::test]
    async fn successful_allow_keeps_stdout_and_cli_access_log_empty() {
        let path = runtime_file(4242, "1.0.2");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(health_ok())),
            verdict: EvaluateHookResponse::allow(vec![]),
        });
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name":"UserPromptSubmit","prompt":"hello","session_id":"s1"}).to_string(),
            stdout.clone(), Arc::new(Mutex::new(Vec::new())), access.clone(),Some(path),Some(client),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qoder".into()], &mut hook_deps).await,
            0
        );
        assert!(stdout.lock().unwrap().is_empty());
        assert!(access.lock().unwrap().is_empty());
    }

    #[test]
    fn qwen_prompt_emit_wraps_reason_exactly_once() {
        let request = HookRequest {
            agent: InterceptorAgent::QwenWorkCn,
            event: HookEventName::UserPromptSubmit,
            session_id: None,
            transcript_path: None,
            cwd: None,
            tool_name: None,
            tool_input: None,
            tool_response: None,
            tool_use_id: None,
            prompt: None,
            raw: Map::new(),
        };
        let mut chunks = Vec::new();
        emit_verdict(&request, "block", Some("[APIKEY_MASKED]"), &mut |text| {
            chunks.push(text)
        });
        assert_eq!(
            chunks.join(""),
            format!(
                "{}\n",
                serde_json::json!({
                    "decision":"block",
                    "reason":wrap_host_reason(HookEventName::UserPromptSubmit,Some("[APIKEY_MASKED]"))
                })
            )
        );
    }

    #[tokio::test]
    async fn writes_desktop_block_json_on_a_blocking_verdict() {
        let path = runtime_file(4242, "1.0.2");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let access = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(health_ok())),
            verdict: EvaluateHookResponse::block(
                "blocked".into(),
                "demo".into(),
                vec!["demo".into()],
            ),
        });
        let mut hook_deps = deps(
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "hello", "session_id": "s1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            access.clone(),
            Some(path),
            Some(client),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qoder".into()], &mut hook_deps).await,
            0
        );
        let expected = format!(
            "{}\n",
            serde_json::json!({
                "decision": "block",
                "reason": wrap_host_reason(HookEventName::UserPromptSubmit, Some("blocked"))
            })
        );
        assert_eq!(stdout.lock().unwrap().join(""), expected);
        assert!(access.lock().unwrap().is_empty());
    }

    #[test]
    fn wraps_pre_and_post_tool_reasons_for_the_host() {
        let mut chunks = Vec::new();
        emit_verdict(
            &HookRequest {
                agent: InterceptorAgent::Qoder,
                event: HookEventName::PreToolUse,
                session_id: None,
                transcript_path: None,
                cwd: None,
                tool_name: None,
                tool_input: None,
                tool_response: None,
                tool_use_id: None,
                prompt: None,
                raw: Map::new(),
            },
            "block",
            Some("内容非法"),
            &mut |text| chunks.push(text),
        );
        assert_eq!(
            chunks.join(""),
            format!(
                "{}\n",
                serde_json::json!({
                    "hookSpecificOutput":{
                        "hookEventName":"PreToolUse", "permissionDecision":"deny",
                        "permissionDecisionReason":wrap_host_reason(HookEventName::PreToolUse,Some("内容非法"))
                    }
                })
            )
        );
        chunks.clear();
        emit_verdict(
            &HookRequest {
                agent: InterceptorAgent::Qoder,
                event: HookEventName::PostToolUse,
                session_id: None,
                transcript_path: None,
                cwd: None,
                tool_name: None,
                tool_input: None,
                tool_response: None,
                tool_use_id: None,
                prompt: None,
                raw: Map::new(),
            },
            "block",
            Some("内容非法"),
            &mut |text| chunks.push(text),
        );
        assert_eq!(
            chunks.join(""),
            format!(
                "{}\n",
                serde_json::json!({
                    "hookSpecificOutput":{
                        "hookEventName":"PostToolUse",
                        "updatedToolOutput":wrap_host_reason(HookEventName::PostToolUse,Some("内容非法"))
                    }
                })
            )
        );
        chunks.clear();
        emit_verdict(
            &HookRequest {
                agent: InterceptorAgent::Qoder,
                event: HookEventName::UserPromptSubmit,
                session_id: None,
                transcript_path: None,
                cwd: None,
                tool_name: None,
                tool_input: None,
                tool_response: None,
                tool_use_id: None,
                prompt: None,
                raw: Map::new(),
            },
            "maybe",
            Some("x"),
            &mut |text| chunks.push(text),
        );
        assert!(chunks.is_empty());
    }

    #[tokio::test]
    async fn writes_openclaw_and_qwen_block_json() {
        let path = runtime_file(4242, "1.0.2");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ScriptedClient {
            health: Mutex::new(Ok(health_ok())),
            verdict: EvaluateHookResponse {
                action: VerdictAction::Block,
                reason: Some("[APIKEY_MASKED]".into()),
                rule_id: Some("apiKey".into()),
                evaluated_rules: vec!["apiKey".into()],
                fail_open: None,
            },
        });
        let mut openclaw = deps(
            serde_json::json!({"openclaw_hook": "before_tool_call", "toolName": "exec", "params": {"command": "env"}, "toolCallId": "call_1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Some(path.clone()),
            Some(client.clone()),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "openclaw".into()], &mut openclaw).await,
            0
        );
        assert_eq!(
            stdout.lock().unwrap().join(""),
            format!(
                "{}\n",
                serde_json::json!({
                    "block":true,
                    "blockReason":wrap_host_reason(HookEventName::PreToolUse,Some("[APIKEY_MASKED]"))
                })
            )
        );
        stdout.lock().unwrap().clear();
        let mut qwen = deps(
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "export KEY=sk-test", "session_id": "s1"}).to_string(),
            stdout.clone(),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Some(path),
            Some(client),
        );
        assert_eq!(
            run_hook(&["--agent".into(), "qwen-work-cn".into()], &mut qwen).await,
            0
        );
        assert_eq!(
            stdout.lock().unwrap().join(""),
            format!(
                "{}\n",
                serde_json::json!({
                    "decision":"block",
                    "reason":wrap_host_reason(HookEventName::UserPromptSubmit,Some("[APIKEY_MASKED]"))
                })
            )
        );
    }
}
