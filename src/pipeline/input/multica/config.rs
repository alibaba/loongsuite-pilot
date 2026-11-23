use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{ensure, Context};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;

use crate::types::{SlsEndpoint, SlsEndpointKind, SlsFlusherConfig, SlsMode};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CollectionMode {
    On,
    #[default]
    Off,
}

impl CollectionMode {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "on" => Some(Self::On),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfileKind {
    Cpu,
    Allocs,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Experiment {
    pub(crate) kind: String,
    pub(crate) workload_type: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
pub(crate) struct Input {
    pub(crate) collection_mode: Option<CollectionMode>,
    pub(crate) detection_failure_threshold: Option<u64>,
    pub(crate) api_base: Option<String>,
    pub(crate) backend_identity_url: Option<String>,
    pub(crate) local_daemon_pid: Option<u32>,
    #[serde(skip)]
    pub(crate) local_token: Option<String>,
    pub(crate) token_env: Option<String>,
    pub(crate) token_file: Option<PathBuf>,
    pub(crate) workspace_ids: Vec<String>,
    pub(crate) metrics_urls: Vec<String>,
    pub(crate) daemon_health_urls: Vec<String>,
    pub(crate) pprof_base_url: Option<String>,
    pub(crate) pprof_types: Option<Vec<ProfileKind>>,
    pub(crate) pprof_interval_seconds: Option<u64>,
    pub(crate) pprof_cpu_seconds: Option<u64>,
    pub(crate) pprof_allocs_seconds: Option<u64>,
    pub(crate) pprof_max_bytes: Option<u64>,
    pub(crate) pprof_source_version: Option<String>,
    pub(crate) pprof_pod_name: Option<String>,
    pub(crate) log_files: Vec<PathBuf>,
    pub(crate) stat_files: Vec<PathBuf>,
    pub(crate) interval_seconds: Option<u64>,
    pub(crate) timeout_ms: Option<u64>,
    pub(crate) max_pages: Option<u64>,
    pub(crate) max_response_bytes: Option<u64>,
    pub(crate) max_log_bytes: Option<u64>,
    pub(crate) max_line_bytes: Option<u64>,
    pub(crate) usage_days: Option<u64>,
    pub(crate) instance: Option<String>,
    pub(crate) pod_uid: Option<String>,
    pub(crate) pod_ip: Option<String>,
    pub(crate) environment: Option<String>,
    pub(crate) namespace: Option<String>,
    pub(crate) collect_entity_names: Option<bool>,
    pub(crate) evidence_kind: Option<String>,
    pub(crate) agent_evidence: Option<BTreeMap<String, Experiment>>,
    pub(crate) test_case: Option<String>,
}

fn evidence_kind(value: &str) -> bool {
    matches!(value, "observed" | "fault_injection" | "fixture")
}

pub(crate) fn valid_name(value: &str, allow_dot: bool) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-') || (ch == b'.' && allow_dot)
        })
}

pub(crate) fn valid_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
}

pub(crate) fn source_url(value: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("invalid Multica source URL"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Multica source requires HTTP(S) without credentials, queries or fragments"
    );
    Ok(url)
}

impl Input {
    pub(crate) fn collect_entity_names(&self) -> bool {
        self.collect_entity_names.unwrap_or(true)
    }

    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        for list in [
            &self.workspace_ids,
            &self.metrics_urls,
            &self.daemon_health_urls,
        ] {
            ensure!(
                list.len() <= 100 && list.iter().all(|item| !item.is_empty()),
                "invalid Multica source list"
            );
        }
        for list in [&self.log_files, &self.stat_files] {
            ensure!(
                list.len() <= 100 && list.iter().all(|item| !item.as_os_str().is_empty()),
                "invalid Multica file list"
            );
        }
        if let Some(types) = &self.pprof_types {
            ensure!(
                !types.is_empty()
                    && types.len() <= 2
                    && types.iter().collect::<HashSet<_>>().len() == types.len(),
                "invalid PprofTypes"
            );
        }
        for url in self
            .api_base
            .iter()
            .chain(&self.backend_identity_url)
            .chain(&self.pprof_base_url)
            .chain(&self.metrics_urls)
            .chain(&self.daemon_health_urls)
        {
            source_url(url)?;
        }
        if let Some(origin) = &self.pprof_base_url {
            ensure!(
                source_url(origin)?.path() == "/",
                "PprofBaseUrl must be an origin"
            );
        }
        ensure!(
            self.api_base.is_none() || !self.workspace_ids.is_empty(),
            "ApiBase requires WorkspaceIds"
        );
        ensure!(
            self.token_env.is_none() || self.token_file.is_none(),
            "Use only one of TokenEnv and TokenFile"
        );
        ensure!(
            self.evidence_kind.as_deref().is_none_or(evidence_kind),
            "invalid EvidenceKind"
        );
        if let Some(experiments) = &self.agent_evidence {
            ensure!(experiments.len() <= 1000, "too many AgentEvidence rules");
            for (id, experiment) in experiments {
                ensure!(
                    valid_agent_id(id)
                        && evidence_kind(&experiment.kind)
                        && matches!(
                            experiment.workload_type.as_str(),
                            "real_llm" | "simulated_cli" | "fault_injection"
                        ),
                    "invalid AgentEvidence rule"
                );
            }
        }
        for (name, value, min, max) in [
            (
                "DetectionFailureThreshold",
                self.detection_failure_threshold,
                1,
                30,
            ),
            (
                "PprofIntervalSeconds",
                self.pprof_interval_seconds,
                300,
                86400,
            ),
            ("PprofCpuSeconds", self.pprof_cpu_seconds, 1, 60),
            ("PprofAllocsSeconds", self.pprof_allocs_seconds, 1, 30),
            (
                "PprofMaxBytes",
                self.pprof_max_bytes,
                1024,
                16 * 1024 * 1024,
            ),
            ("IntervalSeconds", self.interval_seconds, 1, 86400),
            ("TimeoutMs", self.timeout_ms, 100, 120_000),
            ("MaxPages", self.max_pages, 1, 100),
            (
                "MaxResponseBytes",
                self.max_response_bytes,
                1024,
                16 * 1024 * 1024,
            ),
            ("MaxLogBytes", self.max_log_bytes, 1024, 4 * 1024 * 1024),
            ("MaxLineBytes", self.max_line_bytes, 256, 65536),
            ("UsageDays", self.usage_days, 1, 90),
        ] {
            ensure!(
                value.is_none_or(|value| (min..=max).contains(&value)),
                "invalid {name}"
            );
        }
        ensure!(
            self.max_log_bytes.unwrap_or(1024 * 1024) > self.max_line_bytes.unwrap_or(16 * 1024),
            "MaxLogBytes must exceed MaxLineBytes"
        );
        Ok(())
    }

    pub(crate) fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(10_000))
    }
}

#[derive(Clone)]
pub(crate) struct Destination {
    pub(crate) endpoint: String,
    pub(crate) project: String,
    pub(crate) logstore: String,
    pub(crate) api_key: Option<String>,
}

fn target(raw: &str, project: &str) -> anyhow::Result<(String, String)> {
    let project = project.trim();
    ensure!(valid_name(project, false), "invalid Multica SLS project");
    let endpoint = raw.trim();
    ensure!(!endpoint.is_empty(), "invalid Multica SLS endpoint");
    let owned;
    let endpoint = if endpoint.contains("://") {
        endpoint
    } else {
        owned = format!("https://{endpoint}");
        &owned
    };
    let url = source_url(endpoint)?;
    ensure!(url.path() == "/", "Multica SLS endpoint must be an origin");
    ensure!(
        !url.host_str()
            .is_some_and(|host| host.starts_with(&format!("{project}."))
                && host.ends_with(".log.aliyuncs.com")),
        "Multica SLS endpoint includes its project prefix"
    );
    Ok((url.origin().ascii_serialization(), project.to_owned()))
}

fn same_credentials(first: &SlsEndpoint, second: &SlsEndpoint) -> bool {
    let text = |value: &Option<String>| value.as_ref().is_some_and(|value| !value.is_empty());
    let eq = |a: &Option<String>, b: &Option<String>| (!text(a) && !text(b)) || a == b;
    first.mode == second.mode
        && eq(&first.api_key, &second.api_key)
        && eq(&first.access_key_id, &second.access_key_id)
        && eq(&first.access_key_secret, &second.access_key_secret)
}

pub(crate) fn resolve_destination(
    flusher: Option<&Value>,
    installed: Option<&SlsFlusherConfig>,
) -> anyhow::Result<Destination> {
    if let Some(flusher) = flusher {
        ensure!(
            flusher["Type"] == "flusher_sls",
            "expected Multica SLS flusher"
        );
    }
    let explicit = match (
        flusher.and_then(|v| v.get("Endpoint")),
        flusher.and_then(|v| v.get("Project")),
    ) {
        (None, None) => None,
        (Some(Value::String(endpoint)), Some(Value::String(project))) => {
            Some(target(endpoint, project)?)
        }
        _ => anyhow::bail!("Multica SLS Endpoint and Project must be configured together"),
    };
    let logstore = match flusher.and_then(|v| v.get("Logstore")) {
        None => "multica-logs",
        Some(Value::String(value)) => value.trim(),
        _ => anyhow::bail!("invalid Multica SLS logstore"),
    };
    ensure!(valid_name(logstore, false), "invalid Multica SLS logstore");
    let mut inherited: Option<((String, String), &SlsEndpoint)> = None;
    if let Some(installed) = installed {
        for endpoint in installed
            .endpoints
            .iter()
            .filter(|e| e.kind == SlsEndpointKind::AgentActivity)
        {
            let normalized = match target(&endpoint.endpoint, &endpoint.project) {
                Ok(value) => value,
                Err(_) if explicit.is_some() => continue,
                Err(error) => {
                    return Err(error).context("invalid inherited Multica SLS destination")
                }
            };
            if explicit
                .as_ref()
                .is_some_and(|wanted| wanted != &normalized)
            {
                continue;
            }
            ensure!(
                installed.enabled,
                "inherited Multica SLS output is disabled"
            );
            if let Some((wanted, previous)) = &inherited {
                ensure!(
                    wanted == &normalized && same_credentials(previous, endpoint),
                    "ambiguous Multica SLS destination"
                );
            }
            inherited = Some((normalized, endpoint));
        }
    }
    let mut api_key = None;
    if let Some((_, endpoint)) = &inherited {
        if endpoint.api_key.as_ref().is_some_and(|v| !v.is_empty()) {
            ensure!(
                endpoint.access_key_id.as_ref().is_none_or(String::is_empty)
                    && endpoint
                        .access_key_secret
                        .as_ref()
                        .is_none_or(String::is_empty),
                "ambiguous Multica SLS credentials"
            );
        }
        match endpoint.mode {
            SlsMode::Webtracking => {}
            SlsMode::ApiKey => {
                api_key = Some(
                    endpoint
                        .api_key
                        .as_ref()
                        .filter(|key| !key.trim().is_empty())
                        .context("missing Multica SLS API key")?
                        .clone(),
                );
            }
            SlsMode::Ak => anyhow::bail!("Multica SLS accepts apiKey or webtracking"),
        }
    }
    let (endpoint, project) = explicit
        .or_else(|| inherited.map(|item| item.0))
        .context("Multica requires SLS or explicit Endpoint and Project")?;
    Ok(Destination {
        endpoint,
        project,
        logstore: logstore.to_owned(),
        api_key,
    })
}

#[cfg(test)]
mod tests {
    use super::Input;
    use serde_json::json;

    #[test]
    fn collect_entity_names_defaults_to_enabled_with_explicit_opt_out() {
        for (value, expected) in [
            (json!({}), true),
            (json!({"CollectEntityNames": true}), true),
            (json!({"CollectEntityNames": false}), false),
        ] {
            let input: Input = serde_json::from_value(value).unwrap();
            assert_eq!(input.collect_entity_names(), expected);
        }
        assert!(Input::default().collect_entity_names());
    }
}
