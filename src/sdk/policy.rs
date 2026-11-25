use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Init {
    pub data_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub home_dir: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    #[serde(default)]
    pub user_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Delivery {
    pub max_events_per_batch: usize,
    pub max_batch_bytes: usize,
    pub max_event_bytes: usize,
    pub flush_interval_ms: u64,
    pub queue_memory_bytes: usize,
    pub queue_disk_bytes: usize,
    pub retry_initial_ms: u64,
    pub retry_max_ms: u64,
    pub backpressure_high_percent: usize,
    pub backpressure_low_percent: usize,
    pub retry_alarm_after_ms: u64,
    pub alarm_repeat_ms: u64,
}
impl Default for Delivery {
    fn default() -> Self {
        Self {
            max_events_per_batch: 128,
            max_batch_bytes: 8 * 1024 * 1024,
            max_event_bytes: 8 * 1024 * 1024,
            flush_interval_ms: 1000,
            queue_memory_bytes: 16 * 1024 * 1024,
            queue_disk_bytes: 256 * 1024 * 1024,
            retry_initial_ms: 1000,
            retry_max_ms: 30000,
            backpressure_high_percent: 80,
            backpressure_low_percent: 50,
            retry_alarm_after_ms: 60000,
            alarm_repeat_ms: 300000,
        }
    }
}
impl Delivery {
    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            (1..=4096).contains(&self.max_events_per_batch),
            "invalid batch count"
        );
        anyhow::ensure!(
            self.max_event_bytes > 0
                && self.max_event_bytes <= self.max_batch_bytes
                && self.max_batch_bytes <= 64 * 1024 * 1024,
            "invalid event/batch byte limits"
        );
        anyhow::ensure!(
            self.queue_memory_bytes >= self.max_batch_bytes
                && self.queue_memory_bytes <= 256 * 1024 * 1024
                && self.queue_disk_bytes >= self.max_batch_bytes
                && self.queue_disk_bytes <= 4 * 1024 * 1024 * 1024usize,
            "invalid queue capacities"
        );
        anyhow::ensure!(
            self.retry_initial_ms > 0
                && self.retry_initial_ms <= self.retry_max_ms
                && self.retry_max_ms <= 300000,
            "invalid retry limits"
        );
        anyhow::ensure!(
            self.flush_interval_ms > 0
                && self.flush_interval_ms <= 60000
                && self.retry_alarm_after_ms > 0
                && self.alarm_repeat_ms > 0,
            "invalid delivery intervals"
        );
        anyhow::ensure!(
            self.backpressure_low_percent < self.backpressure_high_percent
                && self.backpressure_high_percent <= 100,
            "invalid watermarks"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct AgentPlan {
    pub agent: String,
    pub profile: String,
    pub sources: Vec<Source>,
    pub allowed_roots: Vec<PathBuf>,
    pub max_files: usize,
    pub max_read_bytes: usize,
    pub poll_interval_ms: u64,
    pub mask: crate::types::MaskConfig,
    pub pilot_host: Option<PilotHostState>,
    #[serde(skip)]
    pub(super) codex_recovery_wakeup_namespace: Option<String>,
}

/// State and output controls owned by a standalone Pilot installation.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PilotHostState {
    pub data_dir: PathBuf,
    pub capture_message_content: Option<bool>,
    #[serde(default)]
    pub exclude_workspaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_link_ttl_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_rule_manifest: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub codex_rollout_owns_interrupted_turns: bool,
}
impl AgentPlan {
    pub(super) fn checkpoint_key(&self) -> &'static str {
        if let Some(profile) = super::hook_history::find(&self.agent) {
            return profile.listener;
        }
        match self.profile.as_str() {
            "codex_rollout_v1" => "codex-transcript",
            "codex_aborted_turn_v1" => "codex-aborted-turn",
            _ => "qoder-trace",
        }
    }

    pub fn namespace(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut bytes = serde_json::to_vec(&(
            &self.agent,
            &self.profile,
            &self.sources,
            &self.allowed_roots,
        ))
        .expect("source plan JSON");
        if let Some(state) = &self.pilot_host {
            bytes.extend_from_slice(b"standalone-");
            bytes.extend_from_slice(self.agent.as_bytes());
            bytes.extend(serde_json::to_vec(&state.data_dir).expect("Pilot state directory"));
        }
        hex::encode(Sha256::digest(bytes))
    }
}
#[derive(Clone)]
pub struct Policy {
    pub version: String,
    pub agents: BTreeMap<String, AgentPlan>,
    pub delivery: Delivery,
    pub hooks: Value,
    pub(super) codex_recovery: Option<AgentPlan>,
    pub(super) codex_hook_channel: Option<&'static str>,
    pub(super) offline_deny: super::hook_protocol::OfflineDenyRules,
}

impl Init {
    pub fn validate(&self) -> anyhow::Result<()> {
        for path in [&self.data_dir, &self.resource_dir] {
            anyhow::ensure!(
                path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir)),
                "SDK directories must be absolute without parent traversal"
            );
        }
        if let Some(home) = &self.home_dir {
            anyhow::ensure!(home.is_absolute(), "home_dir must be absolute");
        }
        if let Some(home) = &self.codex_home {
            anyhow::ensure!(
                home.is_absolute() && !home.components().any(|c| matches!(c, Component::ParentDir)),
                "codex_home must be absolute without parent traversal"
            );
            crate::utils::source_access::private_path(home)?;
        }
        Ok(())
    }
}

fn platform_path(value: &Value, init: &Init) -> anyhow::Result<PathBuf> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let text = value
        .as_str()
        .or_else(|| value.get(platform).and_then(Value::as_str))
        .ok_or_else(|| anyhow::anyhow!("missing path for {platform}"))?;
    let path = if let Some(rest) = text.strip_prefix("~/") {
        init.home_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("tilde paths require explicit home_dir"))?
            .join(rest)
    } else {
        PathBuf::from(text)
    };
    anyhow::ensure!(
        path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir)),
        "source path must be absolute without parent traversal"
    );
    Ok(path)
}

/// Resolve existing ancestors as well as missing leaf paths. A later open is
/// checked again by source_access; validation alone is never the IO boundary.
pub fn canonical_candidate(path: &Path) -> anyhow::Result<PathBuf> {
    let mut current = path;
    let mut missing = Vec::new();
    loop {
        match current.canonicalize() {
            Ok(mut root) => {
                for name in missing.iter().rev() {
                    root.push(name);
                }
                return Ok(root);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    current
                        .file_name()
                        .ok_or_else(|| anyhow::anyhow!("path has no existing root"))?
                        .to_owned(),
                );
                current = current
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("path has no parent"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn offline_deny_rules(
    hooks: &Value,
    agents: &BTreeMap<String, AgentPlan>,
    codex_channel: Option<&str>,
) -> anyhow::Result<super::hook_protocol::OfflineDenyRules> {
    let mut rules = BTreeMap::new();
    let Some(config) = hooks.get("offline_deny") else {
        return Ok(rules);
    };
    let config = config
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("offline_deny must map Agent IDs to event arrays"))?;
    for (agent, events) in config {
        let wire_ids: &[&str] = match agent.as_str() {
            "qoder" => &["qoder", "qodercli"],
            "codex" if codex_channel != Some("local") => &["codex"],
            _ => anyhow::bail!("offline_deny requires a supported cloud Hook Agent"),
        };
        anyhow::ensure!(
            agents.contains_key(agent) && hooks["sync_wait_enabled"].as_bool().unwrap_or(true),
            "offline_deny requires an enabled Agent and synchronous Hook verdicts"
        );
        let events = events
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("offline_deny events must be an array"))?;
        anyhow::ensure!(
            (1..=2).contains(&events.len()),
            "invalid offline_deny event count"
        );
        let mut selected = BTreeSet::new();
        for event in events {
            let event = event
                .as_str()
                .filter(|event| super::hook_protocol::can_deny_offline(event))
                .ok_or_else(|| {
                    anyhow::anyhow!("offline_deny supports PreToolUse and UserPromptSubmit")
                })?;
            anyhow::ensure!(
                selected.insert(event.to_owned()),
                "duplicate offline_deny event"
            );
        }
        let mut allowed = false;
        for wire in wire_ids {
            if hooks["blocking_agents"]
                .as_array()
                .is_none_or(|ids| ids.iter().any(|id| id == *wire))
            {
                rules.insert((*wire).to_owned(), selected.clone());
                allowed = true;
            }
        }
        anyhow::ensure!(allowed, "offline_deny conflicts with blocking_agents");
    }
    Ok(rules)
}

impl Policy {
    pub fn parse(raw: Value, init: &Init) -> anyhow::Result<Self> {
        if let Some(enabled) = raw.get("dynamic_observe_enabled") {
            anyhow::ensure!(
                enabled.is_boolean(),
                "dynamic_observe_enabled must be boolean"
            );
        }
        if let Some(version) = raw.get("version") {
            anyhow::ensure!(
                version
                    .as_str()
                    .is_some_and(|v| !v.is_empty() && v.len() <= 256),
                "invalid policy version"
            );
        }
        if let Some(options) = raw.get("sdk_options") {
            anyhow::ensure!(
                options.as_object().is_some_and(|o| o
                    .keys()
                    .all(|k| matches!(k.as_str(), "delivery" | "hooks" | "mask"))),
                "unsupported SDK option"
            );
        }
        let names = raw
            .get("agents")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("agents must be an array"))?;
        let configs = raw
            .pointer("/hcd/agent_configs")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow::anyhow!("hcd.agent_configs must be an object"))?;
        let delivery: Delivery = serde_json::from_value(
            raw.pointer("/sdk_options/delivery")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )?;
        delivery.validate()?;
        let mask: crate::types::MaskConfig = serde_json::from_value(
            raw.pointer("/sdk_options/mask")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"mode":"none","types":[]})),
        )?;
        if let Some(local) = raw.pointer("/sdk_options/hooks/local") {
            let options = local
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("local interception must be an object"))?;
            anyhow::ensure!(
                options
                    .keys()
                    .all(|key| matches!(key.as_str(), "mode" | "types")),
                "unsupported local interception option"
            );
            anyhow::ensure!(
                local
                    .get("mode")
                    .and_then(Value::as_str)
                    .is_some_and(|mode| matches!(mode, "none" | "all" | "custom")),
                "invalid local interception mode"
            );
            if let Some(types) = local.get("types") {
                anyhow::ensure!(
                    types
                        .as_array()
                        .is_some_and(|types| types.iter().all(|kind| kind.as_str().is_some_and(
                            |kind| crate::types::SUPPORTED_INTERCEPTOR_TYPES.contains(&kind)
                        ))),
                    "unsupported local interception type"
                );
            }
        }
        let local = crate::interceptor::build_interceptor_config_with(
            raw.pointer("/sdk_options/hooks/local"),
            |_| None,
        );
        let mask = crate::interceptor::ensure_mask_covers_interceptor(&mask, &local);
        let mut agents = BTreeMap::new();
        let mut codex_recovery = None;
        let mut codex_hook_channel = None;
        let mut seen = BTreeSet::new();
        for name in names {
            let agent = name
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("agent name must be a string"))?;
            anyhow::ensure!(
                matches!(agent, "qoder" | "codex" | "qoder-cn")
                    || super::hook_history::find(agent).is_some(),
                "unsupported SDK agent: {agent}"
            );
            anyhow::ensure!(seen.insert(agent), "duplicate agent");
            let collection = configs
                .get(agent)
                .and_then(|v| v.get("collection"))
                .ok_or_else(|| anyhow::anyhow!("missing collection for {agent}"))?;
            let enabled = collection
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow::anyhow!("collection.enabled must be boolean"))?;
            anyhow::ensure!(
                agent != "qoder-cn"
                    || (!enabled
                        && raw
                            .pointer("/sdk_options/hooks/pilot_qoder_use_host_collector")
                            .is_some()),
                "Qoder CN is a standalone local Hook profile"
            );
            if !enabled || raw.get("dynamic_observe_enabled") == Some(&Value::Bool(false)) {
                continue;
            }
            anyhow::ensure!(
                collection
                    .as_object()
                    .is_some_and(|o| o.keys().all(|k| matches!(
                        k.as_str(),
                        "enabled"
                            | "profile"
                            | "allowed_roots"
                            | "sources"
                            | "limits"
                            | "output"
                            | "pilot_qoder"
                            | "pilot_host"
                            | "codex_recovery"
                    ))),
                "unsupported collection option"
            );
            let profile = collection
                .get("profile")
                .and_then(Value::as_str)
                .unwrap_or("");
            anyhow::ensure!(
                matches!(
                    (agent, profile),
                    ("qoder", "qoder_trace_v1")
                        | ("codex", "codex_rollout_v1" | "codex_aborted_turn_v1")
                ) || super::hook_history::find(agent).is_some_and(|item| item.profile == profile),
                "unsupported agent/profile: {agent}/{profile}"
            );
            let roots = collection
                .get("allowed_roots")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("allowed_roots must be a nonempty array"))?;
            let allowed_roots = roots
                .iter()
                .map(|v| platform_path(v, init).and_then(|p| canonical_candidate(&p)))
                .collect::<anyhow::Result<Vec<_>>>()?;
            anyhow::ensure!(
                !allowed_roots.is_empty() && allowed_roots.len() <= 32,
                "invalid allowed_roots count"
            );
            let pilot_host = collection
                .get("pilot_host")
                .or_else(|| collection.get("pilot_qoder"))
                .map(|value| -> anyhow::Result<PilotHostState> {
                    let mut state: PilotHostState = serde_json::from_value(value.clone())?;
                    state.data_dir = canonical_candidate(&platform_path(
                        &serde_json::to_value(&state.data_dir)?,
                        init,
                    )?)?;
                    anyhow::ensure!(
                        allowed_roots
                            .iter()
                            .any(|root| state.data_dir.starts_with(root)),
                        "Pilot state outside allowed_roots"
                    );
                    Ok(state)
                })
                .transpose()?;
            anyhow::ensure!(
                collection.get("pilot_qoder").is_none() || agent == "qoder",
                "pilot_qoder requires the Qoder profile"
            );
            let enable_codex_recovery = if let Some(enabled) = collection.get("codex_recovery") {
                anyhow::ensure!(
                    profile == "codex_rollout_v1" && pilot_host.is_none(),
                    "codex_recovery requires an independent Codex rollout profile"
                );
                enabled
                    .as_bool()
                    .ok_or_else(|| anyhow::anyhow!("codex_recovery must be boolean"))?
            } else {
                false
            };
            let sources = collection
                .get("sources")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("sources must be an array"))?;
            anyhow::ensure!(
                !sources.is_empty() && sources.len() <= 16,
                "invalid sources count"
            );
            let mut ids = BTreeSet::new();
            let mut parsed = Vec::new();
            for source in sources {
                anyhow::ensure!(
                    source.as_object().is_some_and(|o| o
                        .keys()
                        .all(|k| matches!(k.as_str(), "id" | "type" | "path" | "read_mode"))),
                    "unsupported source option"
                );
                let id = source
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("source id is required"))?;
                anyhow::ensure!(ids.insert(id), "duplicate source id");
                if let Some(mode) = source.get("read_mode") {
                    anyhow::ensure!(mode == "tail", "unsupported source read mode");
                }
                let kind = source.get("type").and_then(Value::as_str).unwrap_or("");
                anyhow::ensure!(
                    matches!(
                        kind,
                        "hook_jsonl" | "transcript" | "sqlite" | "segments" | "intercept"
                    ) || (pilot_host.is_some() && kind == "sqlite_root"),
                    "unsupported source type"
                );
                if let Some(mode) = source.get("read_mode") {
                    anyhow::ensure!(mode == "tail", "unsupported read mode");
                }
                let path = platform_path(source.get("path").unwrap_or(&Value::Null), init)?;
                let resolved = canonical_candidate(&path)?;
                anyhow::ensure!(
                    allowed_roots.iter().any(|root| resolved.starts_with(root)),
                    "source outside allowed_roots"
                );
                parsed.push(Source {
                    id: id.into(),
                    kind: kind.into(),
                    path: resolved,
                });
            }
            if super::hook_history::find(agent).is_some() {
                anyhow::ensure!(
                    parsed.len() == 1 && parsed[0].kind == "hook_jsonl",
                    "this profile requires exactly one hook_jsonl source"
                );
            }
            if agent == "codex" {
                anyhow::ensure!(
                    parsed.iter().all(|source| source.kind == "transcript") && parsed.len() == 1,
                    "Codex requires exactly one transcript source"
                );
                if let Some(deployment) = configs[agent].get("hook_deployment") {
                    let home = init
                        .codex_home
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("managed Codex Hook requires codex_home"))?;
                    let fields = deployment.as_object().ok_or_else(|| {
                        anyhow::anyhow!("Codex hook_deployment must be an object")
                    })?;
                    anyhow::ensure!(
                        profile == "codex_rollout_v1"
                            && pilot_host.is_none()
                            && fields
                                .keys()
                                .all(|key| matches!(key.as_str(), "settings_path" | "channel")),
                        "invalid managed Codex rollout deployment"
                    );
                    let settings = platform_path(&deployment["settings_path"], init)?;
                    crate::utils::source_access::private_path(&settings)?;
                    anyhow::ensure!(
                        canonical_candidate(&settings)?
                            == canonical_candidate(&home.join("hooks.json"))?
                            && parsed[0].path == canonical_candidate(&home.join("sessions"))?,
                        "Codex Hook settings and transcript must belong to codex_home"
                    );
                    codex_hook_channel = Some(match fields.get("channel") {
                        None => "cloud",
                        Some(value) if value == "cloud" => "cloud",
                        Some(value) if value == "local" => "local",
                        _ => anyhow::bail!("invalid Codex Hook channel"),
                    });
                }
            }
            anyhow::ensure!(
                parsed.iter().filter(|s| s.kind == "hook_jsonl").count() <= 1
                    && parsed
                        .iter()
                        .any(|s| matches!(s.kind.as_str(), "hook_jsonl" | "transcript")),
                "profile requires exactly one primary source"
            );
            let limits = collection
                .get("limits")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let limit = |key: &str, default: usize, max: usize| -> anyhow::Result<usize> {
                match limits.get(key) {
                    None => Ok(default),
                    Some(v) => {
                        let n = v
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("{key} must be a positive integer"))?;
                        anyhow::ensure!(n > 0 && n <= max as u64, "invalid {key}");
                        Ok(n as usize)
                    }
                }
            };
            if let Some(values) = limits.as_object() {
                anyhow::ensure!(
                    values.keys().all(|k| matches!(
                        k.as_str(),
                        "max_files" | "max_read_bytes" | "poll_interval_ms"
                    )),
                    "unsupported collection limit"
                );
            } else {
                anyhow::bail!("limits must be an object");
            }
            if let Some(mode) = collection.pointer("/output/mode") {
                anyhow::ensure!(mode == "async_observe", "unsupported output mode");
            }
            if let Some(schema) = collection.pointer("/output/schema") {
                anyhow::ensure!(schema == "aah.activity.v2", "unsupported output schema");
            }
            let plan = AgentPlan {
                mask: mask.clone(),
                pilot_host,
                agent: agent.into(),
                profile: profile.into(),
                sources: parsed,
                allowed_roots,
                max_files: limit("max_files", 512, 16384)?,
                max_read_bytes: limit("max_read_bytes", 8 * 1024 * 1024, 64 * 1024 * 1024)?,
                poll_interval_ms: limit(
                    "poll_interval_ms",
                    1000,
                    if super::hook_history::find(agent).is_some()
                        && collection.get("pilot_host").is_some()
                    {
                        usize::MAX
                    } else {
                        300000
                    },
                )? as u64,
                codex_recovery_wakeup_namespace: None,
            };
            if enable_codex_recovery {
                let mut recovery = plan.clone();
                recovery.profile = "codex_aborted_turn_v1".into();
                recovery.codex_recovery_wakeup_namespace = Some(plan.namespace());
                codex_recovery = Some(recovery);
            }
            agents.insert(agent.into(), plan);
        }
        let mut hooks = raw
            .pointer("/sdk_options/hooks")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        anyhow::ensure!(hooks.is_object(), "hooks must be an object");
        hooks["agents"] = if raw.get("dynamic_observe_enabled") == Some(&Value::Bool(false)) {
            serde_json::json!([])
        } else {
            raw["agents"].clone()
        };
        // Internal collection context is compiled from validated HCD, never
        // accepted from the untrusted hook payload or sdk_options.
        hooks["collector_plans"] = serde_json::to_value(&agents)?;
        for (id, plan) in &agents {
            hooks["collector_plans"][id]["namespace"] = serde_json::json!(plan.namespace());
        }
        // The standalone shell can keep its existing collector for host-only
        // ACP/multimodal processing while using the SDK for Hook transport.
        let use_host_collector = hooks
            .as_object_mut()
            .expect("validated hooks")
            .remove("pilot_qoder_use_host_collector");
        if let Some(value) = use_host_collector {
            let (agent, standalone_path) = match hooks["agents"].as_array().map(Vec::as_slice) {
                Some([agent]) if agent == "qoder" => ("qoder", super::STANDALONE_QODER_DATA),
                Some([agent]) if agent == "qoder-cn" => {
                    ("qoder-cn", super::STANDALONE_QODER_CN_DATA)
                }
                _ => anyhow::bail!("invalid standalone Qoder Hook policy"),
            };
            anyhow::ensure!(
                agents.is_empty(),
                "invalid standalone Qoder Hook collection"
            );
            let data = init
                .data_dir
                .parent()
                .and_then(Path::parent)
                .filter(|data| data.join(standalone_path) == init.data_dir)
                .ok_or_else(|| anyhow::anyhow!("invalid standalone Qoder Hook directory"))?;
            let home = init
                .home_dir
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("standalone Qoder Hook requires home_dir"))?;
            let mut state: PilotHostState = serde_json::from_value(value)?;
            anyhow::ensure!(
                state.data_dir == data,
                "invalid standalone Qoder Hook state"
            );
            state.data_dir = canonical_candidate(data)?;
            hooks["collector_plans"][agent] = serde_json::json!({
                "pilot_host": state,
                "sources": [{"kind": "transcript", "path": canonical_candidate(home)?}],
            });
            hooks["relay_host_verdicts"] = Value::Bool(true);
        } else {
            hooks["relay_host_verdicts"] = Value::Bool(false);
        }
        hooks["managed_host_rules"] = Value::Bool(
            ["qoder", "codex", "qoder-cn"]
                .into_iter()
                .any(|agent| hooks["collector_plans"][agent]["pilot_host"].is_object())
                && hooks.pointer("/local/mode").and_then(Value::as_str) == Some("all"),
        );
        hooks["embedded_codex"] = serde_json::json!(init.codex_home.is_some());
        hooks["codex_hook_channel"] = serde_json::json!(codex_hook_channel);
        hooks["data_dir"] = serde_json::json!(init.data_dir);
        hooks["home_dir"] = serde_json::json!(init.home_dir);
        hooks["user_id"] = serde_json::json!(init.user_id);
        hooks["mask"] = serde_json::to_value(&mask)?;
        if let Some(sync) = hooks.get("sync_wait_enabled") {
            anyhow::ensure!(sync.is_boolean(), "sync_wait_enabled must be boolean");
        }
        if let Some(blocking) = hooks.get("blocking_agents") {
            anyhow::ensure!(
                blocking.as_array().is_some_and(|a| a.iter().all(|v| v
                    .as_str()
                    .is_some_and(|id| super::agent_hooks::AgentHook::for_wire_id(id).is_some()))),
                "unsupported blocking agent"
            );
        }
        let offline_deny = offline_deny_rules(&hooks, &agents, codex_hook_channel)?;
        let version = raw
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                use sha2::Digest;
                hex::encode(sha2::Sha256::digest(raw.to_string().as_bytes()))
            });
        Ok(Self {
            version,
            agents,
            delivery,
            hooks,
            codex_recovery,
            codex_hook_channel,
            offline_deny,
        })
    }
}
