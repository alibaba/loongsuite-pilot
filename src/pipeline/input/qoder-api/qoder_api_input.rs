//! Qoder API collection. Sliding window is persisted in [`StateStore`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::utils::{create_logger, ensure_dir};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::qoder_api_client::{QoderApiClient, QoderApiHttpError};

const MEMBER_CONCURRENCY: usize = 5;
const MAX_MEMBER_PAGES: usize = 50;
const MAX_OFFSET_PAGES: usize = 50;
const WINDOW_KEY: &str = "qoder-api-window";

pub struct QoderApiInput {
    client: QoderApiClient,
    org_id: String,
    config_name: String,
    backfill_days: u64,
    state_store: StateStore,
    state_file_path: String,
    state_loaded: AtomicBool,
    fatal_auth_error: AtomicBool,
    in_flight: AtomicBool,
    pending_window_end: std::sync::Mutex<Option<String>>,
}

impl QoderApiInput {
    pub fn new(
        client: QoderApiClient,
        org_id: &str,
        config_name: &str,
        state_dir: &str,
        backfill_days: u64,
    ) -> Self {
        let state_file_path = Path::new(state_dir)
            .join(format!("{config_name}.json"))
            .to_string_lossy()
            .to_string();
        Self {
            client,
            org_id: org_id.to_string(),
            config_name: config_name.to_string(),
            backfill_days,
            state_store: StateStore::new(&state_file_path),
            state_file_path,
            state_loaded: AtomicBool::new(false),
            fatal_auth_error: AtomicBool::new(false),
            in_flight: AtomicBool::new(false),
            pending_window_end: std::sync::Mutex::new(None),
        }
    }

    pub fn has_fatal_auth_error(&self) -> bool {
        self.fatal_auth_error.load(Ordering::SeqCst)
    }

    pub async fn collect(&self) -> Vec<HashMap<String, String>> {
        if self.fatal_auth_error.load(Ordering::SeqCst) {
            return Vec::new();
        }
        if self.in_flight.swap(true, Ordering::SeqCst) {
            create_logger(&format!("QoderApiInput:{}", self.config_name))
                .warn("previous cycle still running; skipping", None);
            return Vec::new();
        }
        let rows = self.run_cycle().await;
        self.in_flight.store(false, Ordering::SeqCst);
        rows
    }

    pub async fn confirm_cycle(&self) {
        let end = self.pending_window_end.lock().unwrap().take();
        if let Some(end) = end {
            let mut extra = self.window_extra();
            extra.insert("lastWindowEnd".into(), Value::String(end));
            self.state_store.update(
                WINDOW_KEY,
                InputStatePatch {
                    extra: Some(Value::Object(extra)),
                    ..InputStatePatch::default()
                },
            );
            let _ = self.state_store.save().await;
        }
    }

    async fn run_cycle(&self) -> Vec<HashMap<String, String>> {
        if !self.state_loaded.swap(true, Ordering::SeqCst) {
            if let Some(parent) = Path::new(&self.state_file_path).parent() {
                ensure_dir(&parent.to_string_lossy()).await;
            }
            self.state_store.load().await;
        }
        let window_end = chrono::Utc::now();
        let backfill_ms = self.backfill_days as i64 * 24 * 60 * 60 * 1000;
        let last = self
            .window_extra()
            .get("lastWindowEnd")
            .and_then(Value::as_str)
            .map(str::to_string);
        let window_start = if let Some(last) = last
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        {
            last.with_timezone(&chrono::Utc)
        } else {
            window_end - chrono::Duration::milliseconds(backfill_ms)
        };
        let start_iso = iso(window_start);
        let end_iso = iso(window_end);
        let mut advance = true;
        let mut logs = Vec::new();
        let seven =
            iso(window_end - chrono::Duration::milliseconds(7 * 24 * 60 * 60 * 1000 - 60_000));
        let ninety =
            iso(window_end - chrono::Duration::milliseconds(90 * 24 * 60 * 60 * 1000 - 60_000));
        let seven = later(&start_iso, &seven);
        let ninety = later(&start_iso, &ninety);

        let members = match self.fetch_members().await {
            Ok(members) => members,
            Err(error) => {
                advance = self.handle_error("listMembers", &error) && advance;
                Vec::new()
            }
        };
        for member in members.chunks(MEMBER_CONCURRENCY).flatten() {
            match self.fetch_member(member, &start_iso, &end_iso).await {
                Ok(rows) => logs.extend(rows),
                Err(error) => {
                    advance = self.handle_error(
                        &format!(
                            "member {}",
                            member.get("id").and_then(Value::as_str).unwrap_or("")
                        ),
                        &error,
                    ) && advance;
                }
            }
        }
        match self.fetch_changes(&start_iso, &end_iso).await {
            Ok(rows) => logs.extend(rows),
            Err(error) => advance = self.handle_error("listAiCodeChanges", &error) && advance,
        }
        match self.fetch_commits(&start_iso, &end_iso).await {
            Ok(rows) => logs.extend(rows),
            Err(error) => advance = self.handle_error("listAiCodeCommits", &error) && advance,
        }
        match self.fetch_org_usage(&start_iso, &end_iso).await {
            Ok(rows) => logs.extend(rows),
            Err(error) => advance = self.handle_error("listOrgUsageEvents", &error) && advance,
        }
        for member in &members {
            if let Ok(resp) = self
                .client
                .get_member_usage_summary(
                    &self.org_id,
                    member.get("id").and_then(Value::as_str).unwrap_or(""),
                    &seven,
                    &end_iso,
                    "source",
                )
                .await
            {
                logs.push(transform_summary(
                    "usage.member_summary_by_source",
                    &self.org_id,
                    member,
                    "source",
                    &resp,
                    &seven,
                    &end_iso,
                ));
            }
            if let Ok(resp) = self
                .client
                .get_member_usage_summary(
                    &self.org_id,
                    member.get("id").and_then(Value::as_str).unwrap_or(""),
                    &seven,
                    &end_iso,
                    "operation",
                )
                .await
            {
                logs.push(transform_summary(
                    "usage.member_summary_by_operation",
                    &self.org_id,
                    member,
                    "operation",
                    &resp,
                    &seven,
                    &end_iso,
                ));
            }
        }
        if let Ok(resp) = self
            .client
            .get_ai_code_stats_overview(&self.org_id, &ninety, &end_iso)
            .await
        {
            logs.push(transform_overview(&self.org_id, &resp, &ninety, &end_iso));
        }
        let _ = advance;
        *self.pending_window_end.lock().unwrap() =
            if advance { Some(end_iso.clone()) } else { None };
        logs
    }

    async fn fetch_commits(
        &self,
        start: &str,
        end: &str,
    ) -> Result<Vec<HashMap<String, String>>, QoderApiHttpError> {
        let mut out = Vec::new();
        for page in 1..=MAX_OFFSET_PAGES as u64 {
            let resp = self
                .client
                .list_ai_code_commits(&self.org_id, start, end, page)
                .await?;
            let items = resp
                .pointer("/data/items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &items {
                let mut log = base(
                    "code.tracking_commit",
                    &self.org_id,
                    item.get("userId").and_then(Value::as_str).unwrap_or(""),
                    item.get("userEmail").and_then(Value::as_str).unwrap_or(""),
                    start,
                    end,
                );
                log.insert("raw_json".into(), item.to_string());
                set_if(&mut log, "commit_hash", item.get("commitHash"));
                set_if(&mut log, "repo_name", item.get("repoName"));
                set_if(&mut log, "commit_ts", item.get("commitTs"));
                log.insert(
                    "event_id".into(),
                    sha256(&[
                        "code.tracking_commit",
                        &self.org_id,
                        item.get("commitHash").and_then(Value::as_str).unwrap_or(""),
                        item.get("userId").and_then(Value::as_str).unwrap_or(""),
                        item.get("commitTs").and_then(Value::as_str).unwrap_or(""),
                    ]),
                );
                out.push(log);
            }
            let total = resp
                .pointer("/data/pagination/totalPages")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            if page >= total || items.is_empty() {
                break;
            }
        }
        Ok(out)
    }

    async fn fetch_org_usage(
        &self,
        start: &str,
        end: &str,
    ) -> Result<Vec<HashMap<String, String>>, QoderApiHttpError> {
        let mut out = Vec::new();
        let mut next = None;
        let mut index = 0u64;
        for _ in 0..MAX_OFFSET_PAGES {
            let resp = self
                .client
                .list_org_usage_events(&self.org_id, start, end, next.as_deref())
                .await?;
            for usage in resp
                .get("usages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let mut log = base(
                    "usage.org_event",
                    &self.org_id,
                    usage.get("userId").and_then(Value::as_str).unwrap_or(""),
                    usage.get("userEmail").and_then(Value::as_str).unwrap_or(""),
                    start,
                    end,
                );
                log.insert("raw_json".into(), usage.to_string());
                set_if(&mut log, "source", usage.get("source"));
                log.insert(
                    "event_id".into(),
                    sha256(&[
                        "usage.org_event",
                        &self.org_id,
                        usage.get("userId").and_then(Value::as_str).unwrap_or(""),
                        &index.to_string(),
                    ]),
                );
                index += 1;
                out.push(log);
            }
            next = resp
                .get("nextToken")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string);
            if next.is_none() {
                break;
            }
        }
        Ok(out)
    }

    async fn fetch_members(&self) -> Result<Vec<Value>, QoderApiHttpError> {
        let mut out = Vec::new();
        let mut next = None;
        for _ in 0..MAX_MEMBER_PAGES {
            let resp = self
                .client
                .list_members(&self.org_id, next.as_deref(), Some(100), false)
                .await?;
            if let Some(members) = resp.get("members").and_then(Value::as_array) {
                for member in members {
                    let status = member.get("status").and_then(Value::as_str);
                    if status.is_some_and(|status| status != "ENABLED") {
                        continue;
                    }
                    out.push(member.clone());
                }
            }
            next = resp
                .get("nextToken")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string);
            if next.is_none() {
                break;
            }
        }
        Ok(out)
    }

    async fn fetch_member(
        &self,
        member: &Value,
        start: &str,
        end: &str,
    ) -> Result<Vec<HashMap<String, String>>, QoderApiHttpError> {
        let mut out = Vec::new();
        let member_id = member.get("id").and_then(Value::as_str).unwrap_or("");
        let mut next = None;
        let mut index = 0u64;
        for _ in 0..MAX_OFFSET_PAGES {
            let resp = self
                .client
                .list_member_usage_events(
                    &self.org_id,
                    member_id,
                    Some(start),
                    Some(end),
                    next.as_deref(),
                )
                .await?;
            for usage in resp
                .get("usages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                out.push(transform_usage(
                    "usage.member_event",
                    &self.org_id,
                    member,
                    usage,
                    start,
                    end,
                    index,
                ));
                index += 1;
            }
            next = resp
                .get("nextCredits")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string);
            if next.is_none() {
                break;
            }
        }
        match self.client.get_member_quota(&self.org_id, member_id).await {
            Ok(quota) => out.push(transform_quota(&self.org_id, member, &quota, start, end)),
            Err(error) => {
                create_logger(&format!("QoderApiInput:{}", self.config_name)).warn(
                    "quota fetch failed (continuing)",
                    Some(&err_meta(&error.message)),
                );
            }
        }
        Ok(out)
    }

    async fn fetch_changes(
        &self,
        start: &str,
        end: &str,
    ) -> Result<Vec<HashMap<String, String>>, QoderApiHttpError> {
        let mut out = Vec::new();
        for page in 1..=MAX_OFFSET_PAGES as u64 {
            let resp = self
                .client
                .list_ai_code_changes(&self.org_id, start, end, page)
                .await?;
            let items = resp
                .pointer("/data/items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &items {
                out.push(transform_change(&self.org_id, item, start, end));
            }
            let total = resp
                .pointer("/data/pagination/totalPages")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            if page >= total || items.is_empty() {
                break;
            }
        }
        Ok(out)
    }

    fn window_extra(&self) -> serde_json::Map<String, Value> {
        self.state_store
            .get(WINDOW_KEY)
            .extra()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn handle_error(&self, stage: &str, error: &QoderApiHttpError) -> bool {
        let message = redact(&error.message);
        if error.status == 401 || error.status == 403 {
            self.fatal_auth_error.store(true, Ordering::SeqCst);
            create_logger(&format!("QoderApiInput:{}", self.config_name)).error(
                "qoder-api authentication failed; halting input",
                Some(&err_meta(&message)),
            );
            let _ = stage;
            return false;
        }
        create_logger(&format!("QoderApiInput:{}", self.config_name)).warn(
            "qoder-api stage failed",
            Some(&err_meta(&format!("{stage}: {message}"))),
        );
        false
    }
}

fn transform_usage(
    kind: &str,
    org: &str,
    member: &Value,
    usage: &Value,
    start: &str,
    end: &str,
    index: u64,
) -> HashMap<String, String> {
    let mut log = base(
        kind,
        org,
        member.get("id").and_then(Value::as_str).unwrap_or(""),
        member
            .get("email")
            .and_then(Value::as_str)
            .or_else(|| usage.get("userEmail").and_then(Value::as_str))
            .unwrap_or(""),
        start,
        end,
    );
    log.insert("raw_json".into(), usage.to_string());
    set_if(&mut log, "event_ts_ms", usage.get("timestamp"));
    set_if(&mut log, "source", usage.get("source"));
    set_if(&mut log, "operation", usage.get("operation"));
    set_if(&mut log, "model_tier", usage.get("modelTier"));
    set_if(&mut log, "credits", usage.get("credits"));
    set_if(&mut log, "cost", usage.get("cost"));
    log.insert(
        "event_id".into(),
        sha256(&[
            kind,
            org,
            log.get("member_id").map(String::as_str).unwrap_or(""),
            usage
                .get("timestamp")
                .map(|v| v.to_string())
                .as_deref()
                .unwrap_or(""),
            usage.get("source").and_then(Value::as_str).unwrap_or(""),
            usage.get("operation").and_then(Value::as_str).unwrap_or(""),
            usage.get("modelTier").and_then(Value::as_str).unwrap_or(""),
            &usage
                .get("credits")
                .map(|v| v.to_string())
                .unwrap_or_default(),
            &index.to_string(),
        ]),
    );
    log
}

fn transform_quota(
    org: &str,
    member: &Value,
    quota: &Value,
    start: &str,
    end: &str,
) -> HashMap<String, String> {
    let mut log = base(
        "usage.member_quota",
        org,
        member.get("id").and_then(Value::as_str).unwrap_or(""),
        member.get("email").and_then(Value::as_str).unwrap_or(""),
        start,
        end,
    );
    log.insert("raw_json".into(), quota.to_string());
    set_if(&mut log, "quota_key", quota.get("quotaKey"));
    set_if(
        &mut log,
        "total_used",
        quota.pointer("/totalQuota/quotaSummary/usedValue"),
    );
    set_if(
        &mut log,
        "total_limit",
        quota.pointer("/totalQuota/quotaSummary/limitValue"),
    );
    set_if(&mut log, "quota_status", quota.get("status"));
    let day = end.chars().take(10).collect::<String>();
    log.insert(
        "event_id".into(),
        sha256(&[
            "usage.member_quota",
            org,
            log.get("member_id").map(String::as_str).unwrap_or(""),
            &day,
        ]),
    );
    log
}

fn transform_change(org: &str, change: &Value, start: &str, end: &str) -> HashMap<String, String> {
    let mut log = base(
        "code.tracking_change",
        org,
        change.get("userId").and_then(Value::as_str).unwrap_or(""),
        change
            .get("userEmail")
            .and_then(Value::as_str)
            .unwrap_or(""),
        start,
        end,
    );
    log.insert("raw_json".into(), change.to_string());
    set_if(&mut log, "change_id", change.get("changeId"));
    set_if(&mut log, "change_source", change.get("source"));
    set_if(&mut log, "model", change.get("model"));
    set_if(&mut log, "lines_added", change.get("totalLinesAdded"));
    set_if(&mut log, "lines_deleted", change.get("totalLinesDeleted"));
    set_if(&mut log, "created_at", change.get("createdAt"));
    if change.get("metadata").and_then(Value::as_array).is_some() {
        log.insert(
            "metadata_json".into(),
            change.get("metadata").unwrap().to_string(),
        );
    }
    log.insert(
        "event_id".into(),
        sha256(&[
            "code.tracking_change",
            org,
            change.get("changeId").and_then(Value::as_str).unwrap_or(""),
            change.get("userId").and_then(Value::as_str).unwrap_or(""),
            change
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ]),
    );
    log
}

fn transform_summary(
    kind: &str,
    org: &str,
    member: &Value,
    group_by: &str,
    resp: &Value,
    start: &str,
    end: &str,
) -> HashMap<String, String> {
    let summary = resp
        .get("summary")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));
    let mut total = 0.0;
    if let Some(object) = summary.as_object() {
        for value in object.values() {
            if let Some(number) = value.as_f64() {
                if number.is_finite() {
                    total += number;
                }
            }
        }
    }
    let mut log = base(
        kind,
        org,
        member.get("id").and_then(Value::as_str).unwrap_or(""),
        member.get("email").and_then(Value::as_str).unwrap_or(""),
        start,
        end,
    );
    log.insert("raw_json".into(), resp.to_string());
    log.insert("group_by".into(), group_by.into());
    log.insert("summary_json".into(), summary.to_string());
    log.insert("total_credits".into(), format!("{total:.4}"));
    log.insert(
        "group_count".into(),
        summary
            .as_object()
            .map(|object| object.len())
            .unwrap_or(0)
            .to_string(),
    );
    let day = end.chars().take(10).collect::<String>();
    log.insert(
        "event_id".into(),
        sha256(&[
            kind,
            org,
            log.get("member_id").map(String::as_str).unwrap_or(""),
            &day,
        ]),
    );
    log
}

fn transform_overview(
    org: &str,
    overview: &Value,
    start: &str,
    end: &str,
) -> HashMap<String, String> {
    let mut log = base("code.stats_overview", org, "", "", start, end);
    log.insert("raw_json".into(), overview.to_string());
    set_if(&mut log, "ai_share_rate", overview.get("aiShareRate"));
    let day = end.chars().take(10).collect::<String>();
    log.insert(
        "event_id".into(),
        sha256(&["code.stats_overview", org, &day]),
    );
    log
}

fn base(
    kind: &str,
    org: &str,
    member_id: &str,
    email: &str,
    start: &str,
    end: &str,
) -> HashMap<String, String> {
    HashMap::from([
        ("kind".into(), kind.into()),
        ("org_id".into(), org.into()),
        ("member_id".into(), member_id.into()),
        ("member_email".into(), email.into()),
        ("window_start".into(), start.into()),
        ("window_end".into(), end.into()),
        ("report_ts".into(), end.into()),
    ])
}

fn set_if(log: &mut HashMap<String, String>, key: &str, value: Option<&Value>) {
    let Some(value) = value else { return };
    match value {
        Value::Null => {}
        Value::String(text) if text.is_empty() => {}
        Value::String(text) => {
            log.insert(key.into(), text.clone());
        }
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                log.insert(key.into(), int.to_string());
            } else if let Some(float) = number.as_f64() {
                if float.is_finite() {
                    log.insert(key.into(), js_number(float));
                }
            }
        }
        Value::Bool(flag) => {
            log.insert(key.into(), if *flag { "true" } else { "false" }.into());
        }
        other => {
            log.insert(key.into(), other.to_string());
        }
    }
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn sha256(parts: &[&str]) -> String {
    hex::encode(Sha256::digest(parts.join("\0").as_bytes()))
}

fn iso(time: chrono::DateTime<chrono::Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn later(start: &str, clamped: &str) -> String {
    if clamped > start {
        clamped.to_string()
    } else {
        start.to_string()
    }
}

fn redact(message: &str) -> String {
    message.replace("Bearer ", "Bearer <redacted> ")
}

fn err_meta(message: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("error".into(), Value::String(message.into()));
    map
}
