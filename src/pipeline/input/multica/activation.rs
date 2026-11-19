use std::collections::HashSet;
use std::time::{Duration, Instant};

use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;

use super::config::{source_url, CollectionMode, Input};
use super::{records, source_http};

#[derive(Clone, Copy)]
enum ProbeKind {
    Api,
    Daemon,
    Metrics,
}

impl ProbeKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Api => "api_detected",
            Self::Daemon => "daemon_detected",
            Self::Metrics => "metrics_detected",
        }
    }

    fn matches(self, body: &[u8], expected_pid: Option<u32>) -> bool {
        if matches!(self, Self::Metrics) {
            return String::from_utf8_lossy(body)
                .lines()
                .any(records::is_multica_metric);
        }
        let Ok(body) = serde_json::from_slice::<Value>(body) else {
            return false;
        };
        match self {
            Self::Api => api_fingerprint(&body),
            Self::Daemon => {
                daemon_fingerprint(&body)
                    && expected_pid.is_none_or(|pid| body["pid"].as_u64() == Some(u64::from(pid)))
            }
            Self::Metrics => false,
        }
    }
}

struct Probe {
    kind: ProbeKind,
    url: Url,
}

pub(crate) struct Gate {
    detected: bool,
    misses: u64,
    stopped: bool,
    offset: usize,
    probes: Vec<Probe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub(crate) enabled: bool,
    pub(crate) mode: &'static str,
    pub(crate) reason: &'static str,
    pub(crate) consecutive_misses: u64,
    pub(crate) stopped: bool,
}

impl Gate {
    pub(crate) fn new(input: &Input) -> Self {
        let mut probes = Vec::new();
        if let Some(url) = input
            .backend_identity_url
            .as_deref()
            .and_then(|url| source_url(url).ok())
        {
            probes.push(Probe {
                kind: ProbeKind::Api,
                url,
            });
        }
        if let Some(base) = &input.api_base {
            let url = format!("{}/api/config", base.trim_end_matches('/'));
            if let Ok(url) = source_url(&url) {
                probes.push(Probe {
                    kind: ProbeKind::Api,
                    url,
                });
            }
        }
        let mut seen = HashSet::new();
        let health = &input.daemon_health_urls;
        let metrics = &input.metrics_urls;
        for index in 0..health.len().max(metrics.len()) {
            for (kind, addresses) in [(ProbeKind::Daemon, health), (ProbeKind::Metrics, metrics)] {
                if let Some(address) = addresses.get(index) {
                    if seen.insert((kind.label(), address)) {
                        if let Ok(url) = source_url(address) {
                            probes.push(Probe { kind, url });
                        }
                    }
                }
            }
        }
        Self {
            detected: false,
            misses: 0,
            stopped: false,
            offset: 0,
            probes,
        }
    }

    pub(crate) async fn evaluate(
        &mut self,
        client: &Client,
        input: &Input,
        default_mode: CollectionMode,
        enabled: bool,
    ) -> Status {
        if !enabled {
            return self.disabled("pipeline_disabled");
        }
        let legacy = std::env::var("LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED").ok();
        if legacy.as_deref().is_some_and(|value| {
            matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "0")
        }) {
            return self.disabled("legacy_disabled");
        }
        let requested = std::env::var("LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE").ok();
        let mode = match requested.as_deref() {
            None => input.collection_mode.unwrap_or(default_mode),
            Some(requested) => match CollectionMode::parse(requested) {
                Some(mode) => mode,
                None => return self.disabled("invalid_collection_mode"),
            },
        };
        if mode == CollectionMode::Off {
            return self.disabled("forced_off");
        }
        if self.stopped {
            return self.status(false, "detection_stopped");
        }
        let (detected, reason) = self.detect(client, input).await;
        if detected {
            self.detected = true;
            self.misses = 0;
        } else {
            self.misses += 1;
            if self.misses >= input.detection_failure_threshold.unwrap_or(3) {
                self.stopped = true;
                return self.status(false, "detection_failure_threshold");
            }
        }
        self.status(self.detected, reason)
    }

    fn disabled(&mut self, reason: &'static str) -> Status {
        self.detected = false;
        self.misses = 0;
        self.stopped = false;
        self.offset = 0;
        Status {
            enabled: false,
            mode: "off",
            reason,
            consecutive_misses: 0,
            stopped: false,
        }
    }

    fn status(&self, enabled: bool, reason: &'static str) -> Status {
        Status {
            enabled,
            mode: "on",
            reason,
            consecutive_misses: self.misses,
            stopped: self.stopped,
        }
    }

    async fn detect(&mut self, client: &Client, input: &Input) -> (bool, &'static str) {
        if self.probes.is_empty() {
            return (false, "no_probe_sources");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let begin = self.offset;
        let mut responded = false;
        for attempt in 0..self.probes.len() {
            let index = (begin + attempt) % self.probes.len();
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let probe = &self.probes[index];
            self.offset = (index + 1) % self.probes.len();
            let timeout = remaining.min(Duration::from_secs(1)).min(input.timeout());
            let limit = input
                .max_response_bytes
                .unwrap_or(256 * 1024)
                .min(256 * 1024);
            // Product recognition never reads or sends credentials.
            if let Ok(response) =
                source_http::get(client, probe.url.clone(), timeout, limit, None).await
            {
                responded = true;
                if probe.kind.matches(&response.bytes, input.local_daemon_pid) {
                    self.offset = index;
                    return (true, probe.kind.label());
                }
            }
        }
        (
            false,
            if responded {
                "not_detected"
            } else {
                "probe_unavailable"
            },
        )
    }
}

fn api_fingerprint(body: &Value) -> bool {
    body["allow_signup"].is_boolean()
        && body["cdn_domain"].is_string()
        && (matches!(
            body["daemon_setup_target"].as_str(),
            Some("cloud" | "self_host")
        ) || (body["local_worktree_supported"].is_boolean()
            && body["agent_conversation_starters_supported"].is_boolean()))
}

fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().all(Value::is_string))
}

fn daemon_fingerprint(body: &Value) -> bool {
    matches!(body["status"].as_str(), Some("running" | "starting"))
        && body["pid"]
            .as_u64()
            .is_some_and(|pid| pid > 0 && pid < (1 << 53))
        && ["uptime", "daemon_id"]
            .into_iter()
            .all(|key| body[key].as_str().is_some_and(|text| !text.is_empty()))
        && body["device_name"].is_string()
        && body["server_url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"))
        && string_array(&body["agents"])
        && body.get("workspaces").is_some_and(|workspaces| {
            workspaces.is_null()
                || workspaces.as_array().is_some_and(|values| {
                    values.iter().all(|value| {
                        value["id"].is_string()
                            && value
                                .get("runtimes")
                                .is_some_and(|rows| rows.is_null() || string_array(rows))
                    })
                })
        })
}
