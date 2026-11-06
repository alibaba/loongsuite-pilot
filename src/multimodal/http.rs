//! Fetch stand-in. Production calls go through reqwest. Tests install a
//! task-local handler so vitest's `vi.stubGlobal('fetch')` cases stay local.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug)]
pub struct HttpCall {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Set when the caller's deadline or abort flag fires.
    pub aborted: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct HttpReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub error: Option<String>,
}

pub type HttpHandler = Arc<dyn Fn(HttpCall) -> BoxFut<Result<HttpReply, String>> + Send + Sync>;

tokio::task_local! {
    pub static HTTP_HANDLER: HttpHandler;
}

/// Keep an explicitly installed transport context across processor work tasks.
/// Without a scoped handler, requests retain the production reqwest path.
pub(crate) fn spawn_with_http_context<F>(work: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handler = HTTP_HANDLER.try_with(Arc::clone).ok();
    tokio::spawn(async move {
        match handler {
            Some(handler) => HTTP_HANDLER.scope(handler, work).await,
            None => work.await,
        }
    })
}

pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

pub async fn http_exchange(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    timeout_ms: u64,
    external_abort: Option<&Arc<AtomicBool>>,
) -> Result<HttpReply, String> {
    if external_abort.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err("aborted".to_string());
    }
    let aborted = Arc::new(AtomicBool::new(false));
    let call = HttpCall {
        method: method.to_string(),
        url: url.to_string(),
        headers: headers.to_vec(),
        body: body.unwrap_or_default().to_vec(),
        aborted: Arc::clone(&aborted),
    };

    let handler = HTTP_HANDLER.try_with(|handler| handler.clone()).ok();
    let work = async {
        if let Some(handler) = handler {
            return handler(call).await;
        }
        real_reqwest(method, url, headers, body).await
    };

    let timeout = Duration::from_millis(timeout_ms.max(1));
    tokio::select! {
        biased;
        _ = wait_abort(external_abort) => {
            aborted.store(true, Ordering::SeqCst);
            Err("aborted".to_string())
        }
        _ = tokio::time::sleep(timeout) => {
            aborted.store(true, Ordering::SeqCst);
            Err("aborted".to_string())
        }
        result = work => result,
    }
}

async fn wait_abort(flag: Option<&Arc<AtomicBool>>) {
    let Some(flag) = flag else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if flag.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn real_reqwest(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
) -> Result<HttpReply, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client.request(method.parse().unwrap_or(reqwest::Method::GET), url);
    let mut header_map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            header_map.insert(name, value);
        }
    }
    request = request.headers(header_map);
    if let Some(body) = body {
        request = request.body(body.to_vec());
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_string(), value.to_string()))
                })
                .collect();
            let body = response
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .unwrap_or_default();
            Ok(HttpReply {
                status,
                headers,
                body,
                error: None,
            })
        }
        Err(err) => Err(err.to_string()),
    }
}

pub fn log_meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

/// Node `encodeURIComponent`, then the OSS/SLS extra escapes.
pub fn uri_encode(value: &str, keep_slashes: bool) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b'/' if keep_slashes => encoded.push('/'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Node `Buffer.from(text, 'base64')`: ignore non-alphabet characters.
/// Empty or undecodable input is `None`.
pub fn decode_base64_lenient(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let filtered: String = text
        .chars()
        .filter(|ch| matches!(ch, 'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' | '='))
        .collect();
    if filtered.is_empty() {
        return None;
    }
    let mut padded = filtered.trim_end_matches('=').to_string();
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()?;
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

pub fn js_number_string(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}
