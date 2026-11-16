//! Loopback client used by the hook CLI.

use crate::interceptor::types::{
    EvaluateHookResponse, HookRequest, InterceptorHealth, VerdictAction,
    INTERCEPTOR_HOOK_TIMEOUT_MS, INTERCEPTOR_SERVICE,
};
use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::net::Ipv4Addr;
use std::time::Duration;
use tokio::net::TcpStream;

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
        let port = self.port;
        tokio::time::timeout(Duration::from_millis(timeout_ms), async {
            let unavailable = |error: &dyn std::fmt::Display| {
                DaemonClientError::new("unavailable", error.to_string())
            };
            let (method, bytes) = if let Some(body) = body {
                (
                    Method::POST,
                    serde_json::to_vec(body).map_err(|err| unavailable(&err))?,
                )
            } else {
                (Method::GET, Vec::new())
            };
            let mut request = Request::builder()
                .method(method)
                .uri(pathname)
                .header(HOST, format!("127.0.0.1:{port}"))
                .header(CONNECTION, "close");
            if body.is_some() {
                request = request.header(CONTENT_TYPE, "application/json");
            }
            let request = request
                .body(Full::new(Bytes::from(bytes)))
                .map_err(|err| unavailable(&err))?;
            let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .map_err(|err| unavailable(&err))?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(socket))
                    .await
                    .map_err(|err| unavailable(&err))?;
            let receive = async {
                let response = sender
                    .send_request(request)
                    .await
                    .map_err(|err| unavailable(&err))?;
                let status = response.status();
                if !status.is_success() {
                    return Err(DaemonClientError::new(
                        "non-2xx-response",
                        format!("daemon {pathname}: HTTP {status}"),
                    ));
                }
                let bytes = response
                    .into_body()
                    .collect()
                    .await
                    .map_err(|err| unavailable(&err))?
                    .to_bytes();
                parse_single_json(&String::from_utf8_lossy(&bytes))
            };
            // Drive the socket and read the response under the same deadline.
            // Dropping this request also drops its dedicated connection.
            tokio::pin!(connection);
            tokio::pin!(receive);
            tokio::select! {
                biased;
                result = &mut receive => result,
                result = &mut connection => {
                    result.map_err(|err| unavailable(&err))?;
                    receive.await
                }
            }
        })
        .await
        .map_err(|_| DaemonClientError::new("unavailable", "daemon request timed out"))?
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

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn loopback_hook_client_deadline_covers_an_incomplete_response() {
        use super::{DaemonClient, Duration};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n{")
                .await
                .unwrap();
            tokio::io::copy(&mut socket, &mut tokio::io::sink())
                .await
                .unwrap();
        });

        let result = tokio::time::timeout(
            Duration::from_secs(3),
            DaemonClient::new(port).health_timeout(500),
        )
        .await
        .expect("the incomplete body must respect the request deadline")
        .unwrap_err();
        assert_eq!(result.code, "unavailable");
        assert_eq!(result.message, "daemon request timed out");
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .expect("timed-out request closes its socket")
            .unwrap();
    }
}
