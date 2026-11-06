//! Loopback client used by the hook CLI.

use crate::interceptor::types::{
    EvaluateHookResponse, HookRequest, InterceptorHealth, VerdictAction,
    INTERCEPTOR_HOOK_TIMEOUT_MS, INTERCEPTOR_SERVICE,
};
use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct DaemonClientError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for DaemonClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for DaemonClientError {}

impl DaemonClientError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait HookClient: Send + Sync {
    async fn check_hook(
        &self,
        request: &HookRequest,
    ) -> Result<EvaluateHookResponse, DaemonClientError>;
    async fn health(&self) -> Result<InterceptorHealth, DaemonClientError>;
}

pub struct DaemonClient {
    port: u16,
}

impl DaemonClient {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    async fn do_json(
        &self,
        pathname: &str,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<Value, DaemonClientError> {
        let url = format!("http://127.0.0.1:{}{pathname}", self.port);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|err| DaemonClientError::new("unavailable", err.to_string()))?;
        let request = if let Some(body) = body {
            client
                .post(url)
                .header("Content-Type", "application/json")
                .json(body)
        } else {
            client.get(url)
        };
        let response = request
            .send()
            .await
            .map_err(|err| DaemonClientError::new("unavailable", err.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(DaemonClientError::new(
                "non-2xx-response",
                format!("daemon {pathname}: HTTP {status}"),
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|err| DaemonClientError::new("unavailable", err.to_string()))?;
        parse_single_json(&text)
    }
}

#[async_trait]
impl HookClient for DaemonClient {
    async fn check_hook(
        &self,
        request: &HookRequest,
    ) -> Result<EvaluateHookResponse, DaemonClientError> {
        let body = serde_json::to_value(request)
            .map_err(|err| DaemonClientError::new("invalid-response", err.to_string()))?;
        let parsed = self
            .do_json(
                "/v1/hooks/evaluate",
                Some(&body),
                INTERCEPTOR_HOOK_TIMEOUT_MS,
            )
            .await?;
        let verdict: EvaluateHookResponse =
            serde_json::from_value(parsed.clone()).map_err(|_| {
                DaemonClientError::new(
                    "invalid-response",
                    format!(
                        "unknown action {}",
                        parsed.get("action").unwrap_or(&Value::Null)
                    ),
                )
            })?;
        if !matches!(verdict.action, VerdictAction::Allow | VerdictAction::Block) {
            return Err(DaemonClientError::new("invalid-response", "unknown action"));
        }
        Ok(verdict)
    }

    async fn health(&self) -> Result<InterceptorHealth, DaemonClientError> {
        self.health_timeout(200).await
    }
}

impl DaemonClient {
    pub async fn health_timeout(
        &self,
        timeout_ms: u64,
    ) -> Result<InterceptorHealth, DaemonClientError> {
        let parsed = self.do_json("/health", None, timeout_ms).await?;
        let body: InterceptorHealth = serde_json::from_value(parsed)
            .map_err(|err| DaemonClientError::new("invalid-response", err.to_string()))?;
        if body.service != INTERCEPTOR_SERVICE || body.status != "ok" {
            return Err(DaemonClientError::new(
                "invalid-response",
                "health identity does not match",
            ));
        }
        if body.pid == 0 {
            return Err(DaemonClientError::new(
                "invalid-response",
                "health pid is invalid",
            ));
        }
        if body.daemon_port != self.port {
            return Err(DaemonClientError::new(
                "invalid-response",
                "health port does not match",
            ));
        }
        Ok(body)
    }
}

pub fn parse_single_json(text: &str) -> Result<Value, DaemonClientError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(DaemonClientError::new(
            "invalid-response",
            "empty JSON response",
        ));
    }
    serde_json::from_str(trimmed)
        .map_err(|_| DaemonClientError::new("invalid-response", "invalid JSON response"))
}
