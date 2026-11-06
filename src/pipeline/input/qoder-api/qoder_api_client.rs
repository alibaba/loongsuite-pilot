//! Qoder OpenAPI client. Bearer tokens are not logged.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::create_logger;
use serde_json::{json, Value};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const RETRY_MAX_ATTEMPTS: u32 = 3;
const RETRY_BASE_DELAY_MS: u64 = 1_000;
const RETRYABLE: &[u16] = &[408, 425, 429, 500, 502, 503, 504];

fn logger() -> crate::utils::BoundLogger {
    create_logger("QoderApiClient")
}

#[derive(Debug)]
pub struct QoderApiHttpError {
    pub status: u16,
    pub url: String,
    pub message: String,
}

impl std::fmt::Display for QoderApiHttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for QoderApiHttpError {}

pub struct QoderApiClient {
    pub api_base: String,
    pub org_id: String,
    api_key: String,
    timeout_ms: u64,
}

impl QoderApiClient {
    pub fn new(
        api_base: &str,
        api_key: &str,
        org_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<Self, String> {
        if api_key.is_empty() {
            return Err("QoderApiClient: apiKey is required".into());
        }
        if api_base.is_empty() {
            return Err("QoderApiClient: apiBase is required".into());
        }
        if org_id.is_empty() {
            return Err("QoderApiClient: orgId is required".into());
        }
        Ok(Self {
            api_base: api_base.trim_end_matches('/').to_string(),
            org_id: org_id.to_string(),
            api_key: api_key.to_string(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        })
    }

    pub async fn list_members(
        &self,
        org_id: &str,
        next_token: Option<&str>,
        max_results: Option<u64>,
        include_deleted: bool,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("maxResults", Some(max_results.unwrap_or(100).to_string())),
            ("nextToken", next_token.map(str::to_string)),
            ("includeDeleted", include_deleted.then(|| "true".into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/members{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_member_usage_events(
        &self,
        org_id: &str,
        member_id: &str,
        start: Option<&str>,
        end: Option<&str>,
        next_credits: Option<&str>,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("startDate", start.map(str::to_string)),
            ("endDate", end.map(str::to_string)),
            ("maxResults", Some("100".into())),
            ("nextCredits", next_credits.map(str::to_string)),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/members/{}/usage-events{query}",
            encode(org_id),
            encode(member_id)
        ))
        .await
    }

    pub async fn get_member_quota(
        &self,
        org_id: &str,
        member_id: &str,
    ) -> Result<Value, QoderApiHttpError> {
        self.request(&format!(
            "/v1/organizations/{}/members/{}/quota",
            encode(org_id),
            encode(member_id)
        ))
        .await
    }

    pub async fn list_ai_code_changes(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
        page: u64,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("startDate", Some(start.into())),
            ("endDate", Some(end.into())),
            ("page", Some(page.to_string())),
            ("pageSize", Some("200".into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code-tracking/changes{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_ai_code_commits(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
        page: u64,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("startDate", Some(start.into())),
            ("endDate", Some(end.into())),
            ("page", Some(page.to_string())),
            ("pageSize", Some("200".into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code-tracking/commits{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_org_usage_events(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
        next_token: Option<&str>,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("startDate", Some(start.into())),
            ("endDate", Some(end.into())),
            ("maxResults", Some("100".into())),
            ("nextToken", next_token.map(str::to_string)),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/usage-events{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn get_member_usage_summary(
        &self,
        org_id: &str,
        member_id: &str,
        start: &str,
        end: &str,
        group_by: &str,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("startDate", Some(start.into())),
            ("endDate", Some(end.into())),
            ("groupBy", Some(group_by.into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/members/{}/usage-summary{query}",
            encode(org_id),
            encode(member_id)
        ))
        .await
    }

    pub async fn list_resource_packages(
        &self,
        org_id: &str,
        next_token: Option<&str>,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("maxResults", Some("100".into())),
            ("nextToken", next_token.map(str::to_string)),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/resource-packages{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_seat_month_batches(
        &self,
        org_id: &str,
        page_token: Option<&str>,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("pageSize", Some("100".into())),
            ("pageToken", page_token.map(str::to_string)),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/seat-month-batches{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn get_ai_code_stats_overview(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("start_date", Some(start.into())),
            ("end_date", Some(end.into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code/stats/overview{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn get_ai_code_daily_trend(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("start_date", Some(start.into())),
            ("end_date", Some(end.into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code/stats/daily-trend{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn get_ai_code_member_ranking(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
        limit: u64,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("start_date", Some(start.into())),
            ("end_date", Some(end.into())),
            ("limit", Some(limit.to_string())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code/stats/member-ranking{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_ai_code_repos(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
        page: u64,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("start_date", Some(start.into())),
            ("end_date", Some(end.into())),
            ("page", Some(page.to_string())),
            ("per_page", Some("100".into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code/repos{query}",
            encode(org_id)
        ))
        .await
    }

    pub async fn list_ai_code_file_extensions(
        &self,
        org_id: &str,
        start: &str,
        end: &str,
    ) -> Result<Value, QoderApiHttpError> {
        let query = to_query(&[
            ("start_date", Some(start.into())),
            ("end_date", Some(end.into())),
        ]);
        self.request(&format!(
            "/v1/organizations/{}/ai-code/file-extensions{query}",
            encode(org_id)
        ))
        .await
    }

    async fn request(&self, path_and_query: &str) -> Result<Value, QoderApiHttpError> {
        let url = format!("{}{path_and_query}", self.api_base);
        let mut last = QoderApiHttpError {
            status: 0,
            url: url.clone(),
            message: "unknown".into(),
        };
        for attempt in 0..RETRY_MAX_ATTEMPTS {
            let started = now_ms();
            let client = reqwest::Client::new();
            match client
                .get(&url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Accept", "application/json")
                .timeout(std::time::Duration::from_millis(self.timeout_ms))
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status().as_u16();
                    if !response.status().is_success() {
                        let text = response.text().await.unwrap_or_default();
                        let err = QoderApiHttpError {
                            status,
                            url: url.clone(),
                            message: format!(
                                "Qoder API {status} {url}: {}",
                                &text[..text.len().min(256)]
                            ),
                        };
                        if !RETRYABLE.contains(&status) || attempt + 1 == RETRY_MAX_ATTEMPTS {
                            return Err(err);
                        }
                        last = err;
                    } else {
                        let json = response.json::<Value>().await.unwrap_or(Value::Null);
                        logger().debug(
                            "qoder api ok",
                            Some(&map(&[
                                ("method", json!("GET")),
                                ("path", json!(path_and_query)),
                                ("elapsedMs", json!(now_ms() - started)),
                            ])),
                        );
                        return Ok(json);
                    }
                }
                Err(error) => {
                    last = QoderApiHttpError {
                        status: 0,
                        url: url.clone(),
                        message: redact(&error.to_string()),
                    };
                    if attempt + 1 == RETRY_MAX_ATTEMPTS {
                        break;
                    }
                }
            }
            let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
            logger().warn(
                "qoder api retrying",
                Some(&map(&[
                    ("method", json!("GET")),
                    ("path", json!(path_and_query)),
                    ("attempt", json!(attempt + 1)),
                    ("delayMs", json!(delay)),
                    ("error", json!(redact(&last.message))),
                ])),
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        Err(last)
    }
}

fn to_query(params: &[(&str, Option<String>)]) -> String {
    let mut parts = Vec::new();
    for (key, value) in params {
        let Some(value) = value.as_ref().filter(|value| !value.is_empty()) else {
            continue;
        };
        parts.push(format!("{}={}", encode(key), encode(value)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

fn encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn redact(message: &str) -> String {
    let mut out = message.to_string();
    if let Some(index) = out.find("Bearer ") {
        let rest = &out[index + 7..];
        let end = rest
            .find(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '.' | '_' | '-'))
            .unwrap_or(rest.len());
        out.replace_range(index..index + 7 + end, "Bearer <redacted>");
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}
