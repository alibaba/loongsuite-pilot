//! Port of `src/pi-sdk/pi-sdk-agent-registry.ts`.
//!
//! Settings injection for the flat `extensions` array is implemented here
//! because `PluginInjectStrategy` is still TypeScript. OpenClaw's nested shape
//! is not part of PI SDK registration.

use super::pi_sdk_agent_identity::{
    is_reserved_pi_sdk_agent_id, is_valid_pi_sdk_agent_id, validate_pi_sdk_agent_id,
};
use crate::types::{
    AgentDefinition, AgentDetectionConfig, AgentInputConfig, DeployMode, PiSdkIntegrationConfig,
    PluginInjectConfig,
};
use crate::utils::{
    acquire_single_instance_lock, ensure_dir, file_exists, is_command_match, read_json_file,
    resolve_home, write_json_file, write_text_file_atomic, AtomicTextWriteOptions,
    ProcessCommandPattern, COLLECTOR_PROCESS_PATTERNS,
};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const PI_SDK_INPUT_TYPE: &str = "pi-sdk-jsonl";
pub const PI_SDK_REGISTRY_LOCK_FILE: &str = "pi-sdk-registry.lock";
const WRAPPER_RETRY_DELAYS_MS: [u64; 2] = [100, 300];
const DEFAULT_PI_CODING_AGENT_DIR: &str = "~/.pi/agent";

pub fn pi_sdk_registry_process_patterns() -> Vec<ProcessCommandPattern<'static>> {
    let mut patterns = COLLECTOR_PROCESS_PATTERNS.to_vec();
    patterns.push(ProcessCommandPattern::Regex(
        r"(?:^|[\s/\\])(?:dist[\\/]index\.js|src[\\/]index\.ts)\s+agent\s+(?:register|unregister)(?:\s|$)",
    ));
    patterns.push(ProcessCommandPattern::Regex(
        r"(?:^|[\s/\\])loongsuite-pilot(?:\.ps1)?\s+agent\s+(?:register|unregister)(?:\s|$)",
    ));
    patterns
}

#[derive(Debug)]
pub struct PiSdkRegistryBusyError {
    pub holder_pid: Option<i64>,
}

impl std::fmt::Display for PiSdkRegistryBusyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let holder = self
            .holder_pid
            .map(|pid| format!(" (held by pid {pid})"))
            .unwrap_or_default();
        write!(
            f,
            "PI SDK Agent registry is busy{holder}; retry the command"
        )
    }
}

impl std::error::Error for PiSdkRegistryBusyError {}

pub fn is_pi_sdk_registry_busy_error(message: impl std::fmt::Display) -> bool {
    message
        .to_string()
        .contains("PI SDK Agent registry is busy")
}

#[derive(Debug, Clone)]
pub struct PiSdkAgentRegistrationRequest {
    pub data_dir: String,
    pub id: String,
    pub name: String,
    pub agent_dir: String,
    pub detection_paths: Vec<String>,
    pub detection_commands: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PiSdkAgentRegistrationResult {
    pub definition: AgentDefinition,
    pub definition_path: String,
    pub wrapper_path: String,
    pub settings_path: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiSdkAgentDoctorResult {
    pub id: String,
    pub name: String,
    pub agent_dir: String,
    pub detected: bool,
    pub wrapper_present: bool,
    pub runtime_present: bool,
    pub injection_present: bool,
    pub healthy: bool,
}

pub fn build_pi_sdk_agent_definition(
    request: &PiSdkAgentRegistrationRequest,
) -> Result<AgentDefinition, String> {
    let id = validate_pi_sdk_agent_id(&request.id)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err("agent name is required".into());
    }
    if name.chars().count() > 128 {
        return Err("agent name must not exceed 128 characters".into());
    }
    let agent_dir = resolve_absolute_path(&request.agent_dir, "agent directory", false)?;
    let mut detection_paths = Vec::new();
    for path in &request.detection_paths {
        detection_paths.push(resolve_absolute_path(path, "detection path", true)?);
    }
    detection_paths.sort();
    detection_paths.dedup();
    let commands = unique_strings(&request.detection_commands, "detection command")?;
    if detection_paths.is_empty() && commands.is_empty() {
        return Err("at least one --detect-path or --detect-command is required".into());
    }
    let settings_path = Path::new(&agent_dir)
        .join("settings.json")
        .to_string_lossy()
        .into_owned();
    let relative_wrapper = format!("plugins/pi-coding-agent/agents/{id}.mjs");
    Ok(AgentDefinition {
        id: id.clone(),
        display_name: name.to_string(),
        deploy_mode: DeployMode::PluginInject,
        detection: AgentDetectionConfig {
            paths: detection_paths,
            commands,
        },
        local_worker_runtime: None,
        hook: None,
        plugin_probe: None,
        plugin_inject: Some(PluginInjectConfig {
            config_paths: vec![settings_path],
            plugin_spec: format!("$PILOT_DATA/{relative_wrapper}"),
            plugin_id: format!("loongsuite-pilot-pi-sdk-{id}"),
            replace_specs: None,
            config_shape: None,
            entry_config: None,
            config_key: Some("extensions".into()),
            create_if_missing: Some(true),
        }),
        copilot_plugin: None,
        pi_sdk: Some(PiSdkIntegrationConfig {
            schema_version: 1,
            agent_dir,
        }),
        directory_plugin: None,
        dsh_yaml_patch: None,
        input: Some(AgentInputConfig {
            input_type: PI_SDK_INPUT_TYPE.into(),
            log_dir: Some("$PILOT_DATA/logs/pi-coding-agent".into()),
            extra: Map::new(),
        }),
        runtime: None,
    })
}

pub async fn register_pi_sdk_agent(
    request: PiSdkAgentRegistrationRequest,
) -> Result<PiSdkAgentRegistrationResult, String> {
    let data_dir = resolve_absolute_path(&request.data_dir, "Pilot data directory", false)?;
    with_lock(&data_dir, || {
        register_locked(data_dir.clone(), request.clone())
    })
    .await
    .map_err(|error| error.to_string())
}

async fn register_locked(
    data_dir: String,
    request: PiSdkAgentRegistrationRequest,
) -> Result<PiSdkAgentRegistrationResult, String> {
    let definition = build_pi_sdk_agent_definition(&request)?;
    let definition_path = definition_path(&data_dir, &definition.id);
    let wrapper_path = wrapper_path(&data_dir, &definition.id);
    let settings_path = definition.plugin_inject.as_ref().unwrap().config_paths[0].clone();
    let mut warnings = Vec::new();
    let existing = read_json_file::<AgentDefinition>(&definition_path).await;
    if existing
        .as_ref()
        .is_some_and(|definition| !is_pi_sdk_agent_definition(definition))
    {
        return Err(format!(
            "local Agent definition already exists and is not managed as PI SDK: {}",
            definition.id
        ));
    }
    assert_dedicated_agent_dir(&data_dir, &definition).await?;
    ensure_dir(
        &Path::new(&wrapper_path)
            .parent()
            .unwrap_or(Path::new("."))
            .to_string_lossy(),
    )
    .await;
    ensure_dir(
        &Path::new(&definition_path)
            .parent()
            .unwrap_or(Path::new("."))
            .to_string_lossy(),
    )
    .await;
    let missing = find_missing_runtime_assets(&data_dir).await;
    if !missing.is_empty() {
        return Err(format!(
            "Pilot PI extension runtime is missing; reinstall or repair Pilot: {}",
            missing.join(", ")
        ));
    }
    let previous_wrapper = tokio::fs::read_to_string(&wrapper_path).await.ok();
    write_text_file_atomic(
        &wrapper_path,
        &render_pi_sdk_wrapper(&definition),
        &AtomicTextWriteOptions::default(),
    )
    .await
    .map_err(|err| err.to_string())?;
    tighten_private_file(&wrapper_path).await;
    if let Err(err) = inject_extension(&data_dir, &definition).await {
        restore_wrapper(&wrapper_path, previous_wrapper.as_deref()).await;
        return Err(err);
    }
    if let Err(err) = write_json_file(&definition_path, &definition).await {
        let same_settings = existing
            .as_ref()
            .and_then(|item| item.plugin_inject.as_ref())
            .map(|inject| {
                inject.config_paths.first().map(String::as_str) == Some(settings_path.as_str())
            })
            .unwrap_or(false);
        if !same_settings {
            let _ = remove_extension(&data_dir, &definition).await;
        }
        restore_wrapper(&wrapper_path, previous_wrapper.as_deref()).await;
        return Err(err.to_string());
    }
    tighten_private_file(&definition_path).await;
    if let Some(existing) = existing.as_ref() {
        let old_settings = existing
            .plugin_inject
            .as_ref()
            .and_then(|inject| inject.config_paths.first());
        if old_settings.map(String::as_str) != Some(settings_path.as_str())
            && !remove_extension(&data_dir, existing).await
        {
            if let Some(old) = old_settings {
                warnings.push(format!("old PI settings entry could not be removed: {old}"));
            }
        }
    }
    Ok(PiSdkAgentRegistrationResult {
        definition,
        definition_path,
        wrapper_path,
        settings_path,
        warnings,
    })
}

pub async fn unregister_pi_sdk_agent(
    data_dir: &str,
    id_value: &str,
) -> Result<UnregisterResult, String> {
    let data_dir = resolve_absolute_path(data_dir, "Pilot data directory", false)?;
    let id = id_value.to_string();
    with_lock(&data_dir, || {
        unregister_locked(data_dir.clone(), id.clone())
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnregisterResult {
    pub id: String,
    pub injection_removed: bool,
    pub definition_removed: bool,
}

async fn unregister_locked(data_dir: String, id_value: String) -> Result<UnregisterResult, String> {
    unregister_locked_with_cleanup(data_dir, id_value, |data_dir, definition| async move {
        remove_extension(&data_dir, &definition).await
    })
    .await
}

async fn unregister_locked_with_cleanup<F, Fut>(
    data_dir: String,
    id_value: String,
    cleanup: F,
) -> Result<UnregisterResult, String>
where
    F: FnOnce(String, AgentDefinition) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let id = validate_pi_sdk_agent_id(&id_value)?;
    let definition_path = definition_path(&data_dir, &id);
    let definition = read_json_file::<AgentDefinition>(&definition_path).await;
    let Some(definition) = definition.filter(is_pi_sdk_agent_definition) else {
        return Err(format!("registered PI SDK Agent not found: {id}"));
    };
    if !cleanup(data_dir.clone(), definition.clone()).await {
        let paths = definition
            .plugin_inject
            .as_ref()
            .map(|inject| inject.config_paths.join(", "))
            .unwrap_or_default();
        return Err(format!(
            "failed to remove PI SDK extension from {paths}; registration preserved for retry"
        ));
    }
    tokio::fs::remove_file(&definition_path)
        .await
        .map_err(|err| err.to_string())?;
    match tokio::fs::remove_file(wrapper_path(&data_dir, &id)).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    Ok(UnregisterResult {
        id,
        injection_removed: true,
        definition_removed: true,
    })
}

pub async fn list_registered_pi_sdk_agents(data_dir: &str) -> Vec<AgentDefinition> {
    let Ok(data_dir) = resolve_absolute_path(data_dir, "Pilot data directory", false) else {
        return Vec::new();
    };
    let dir = Path::new(&data_dir).join("agents.d.local");
    let mut names = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    let mut definitions = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        if let Some(definition) =
            read_json_file::<AgentDefinition>(&dir.join(name).to_string_lossy()).await
        {
            if is_pi_sdk_agent_definition(&definition) {
                definitions.push(definition);
            }
        }
    }
    definitions
}

pub async fn ensure_registered_pi_sdk_wrappers(data_dir: &str) -> anyhow::Result<u32> {
    let data_dir = resolve_absolute_path(data_dir, "Pilot data directory", false)
        .map_err(anyhow::Error::msg)?;
    let mut attempt = 0;
    loop {
        match with_lock(&data_dir, || ensure_wrappers_locked(data_dir.clone())).await {
            Ok(count) => return Ok(count),
            Err(err) if err.downcast_ref::<PiSdkRegistryBusyError>().is_some() => {
                if let Some(delay) = WRAPPER_RETRY_DELAYS_MS.get(attempt) {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
                    continue;
                }
                return Err(err);
            }
            Err(err) => return Err(err),
        }
    }
}

async fn ensure_wrappers_locked(data_dir: String) -> Result<u32, String> {
    let definitions = list_registered_pi_sdk_agents(&data_dir).await;
    if definitions.is_empty() {
        return Ok(0);
    }
    let missing = find_missing_runtime_assets(&data_dir).await;
    if !missing.is_empty() {
        return Err(format!(
            "Pilot PI extension runtime is missing; reinstall or repair Pilot: {}",
            missing.join(", ")
        ));
    }
    let mut restored = 0;
    for definition in definitions {
        validate_pi_sdk_agent_id(&definition.id)?;
        let wrapper_path = wrapper_path(&data_dir, &definition.id);
        let expected = render_pi_sdk_wrapper(&definition);
        let current = tokio::fs::read_to_string(&wrapper_path).await.ok();
        if current.as_deref() == Some(expected.as_str()) {
            continue;
        }
        ensure_dir(
            &Path::new(&wrapper_path)
                .parent()
                .unwrap_or(Path::new("."))
                .to_string_lossy(),
        )
        .await;
        write_text_file_atomic(&wrapper_path, &expected, &AtomicTextWriteOptions::default())
            .await
            .map_err(|err| err.to_string())?;
        tighten_private_file(&wrapper_path).await;
        restored += 1;
    }
    Ok(restored)
}

pub async fn doctor_pi_sdk_agent(
    data_dir: &str,
    id_value: &str,
) -> Result<PiSdkAgentDoctorResult, String> {
    let data_dir = resolve_absolute_path(data_dir, "Pilot data directory", false)?;
    let id = validate_pi_sdk_agent_id(id_value)?;
    let definition = read_json_file::<AgentDefinition>(&definition_path(&data_dir, &id)).await;
    let Some(definition) = definition.filter(is_pi_sdk_agent_definition) else {
        return Err(format!("registered PI SDK Agent not found: {id}"));
    };
    let detected = detect_agent(&definition.detection).await;
    let wrapper_present = file_exists(&wrapper_path(&data_dir, &id)).await;
    let runtime_present = find_missing_runtime_assets(&data_dir).await.is_empty();
    let injection_present = !needs_extension(&data_dir, &definition).await;
    Ok(PiSdkAgentDoctorResult {
        id: id.clone(),
        name: definition.display_name.clone(),
        agent_dir: definition
            .pi_sdk
            .as_ref()
            .map(|sdk| sdk.agent_dir.clone())
            .unwrap_or_default(),
        detected,
        wrapper_present,
        runtime_present,
        injection_present,
        healthy: detected && runtime_present && wrapper_present && injection_present,
    })
}

pub fn is_pi_sdk_agent_definition(definition: &AgentDefinition) -> bool {
    let Some(plugin) = definition.plugin_inject.as_ref() else {
        return false;
    };
    let Some(sdk) = definition.pi_sdk.as_ref() else {
        return false;
    };
    definition.deploy_mode == DeployMode::PluginInject
        && is_valid_pi_sdk_agent_id(&definition.id)
        && !is_reserved_pi_sdk_agent_id(&definition.id)
        && sdk.schema_version == 1
        && !sdk.agent_dir.is_empty()
        && plugin.config_key.as_deref() == Some("extensions")
        && plugin.plugin_id == format!("loongsuite-pilot-pi-sdk-{}", definition.id)
        && plugin.plugin_spec
            == format!(
                "$PILOT_DATA/plugins/pi-coding-agent/agents/{}.mjs",
                definition.id
            )
}

pub fn render_pi_sdk_wrapper(definition: &AgentDefinition) -> String {
    let identity = json!({
        "agentType": definition.id,
        "agentId": definition.id,
        "agentName": definition.display_name,
        "agentSystem": "pi",
        "framework": "pi-coding-agent",
    });
    let pretty = serde_json::to_string_pretty(&identity).unwrap_or_else(|_| "{}".into());
    format!("// Generated by loongsuite-pilot. Re-register the Agent instead of editing this file.\nimport {{ createPiTelemetryExtension }} from '../index.mjs';\n\nexport default createPiTelemetryExtension({pretty});\n")
}

fn definition_path(data_dir: &str, id: &str) -> String {
    Path::new(data_dir)
        .join("agents.d.local")
        .join(format!("{id}.json"))
        .to_string_lossy()
        .into_owned()
}

fn wrapper_path(data_dir: &str, id: &str) -> String {
    Path::new(data_dir)
        .join("plugins")
        .join("pi-coding-agent")
        .join("agents")
        .join(format!("{id}.mjs"))
        .to_string_lossy()
        .into_owned()
}

fn resolved_spec(data_dir: &str, definition: &AgentDefinition) -> String {
    // Every caller validates the managed SDK definition. Use the same native
    // path returned to callers; placeholder substitution mixed separators on
    // Windows and made settings disagree with the published wrapper path.
    wrapper_path(data_dir, &definition.id)
}

fn equivalent_spec(value: &Value, spec: &str) -> bool {
    value
        .as_str()
        .is_some_and(|value| comparable_path(value) == comparable_path(spec))
}

async fn inject_extension(data_dir: &str, definition: &AgentDefinition) -> Result<(), String> {
    let Some(config) = definition.plugin_inject.as_ref() else {
        return Err("missing pluginInject config".into());
    };
    let path = find_or_create_config(
        &config.config_paths,
        config.create_if_missing.unwrap_or(false),
    )
    .await?;
    let mut json = read_settings(&path).await?;
    let spec = resolved_spec(data_dir, definition);
    let key = config
        .config_key
        .clone()
        .unwrap_or_else(|| "extensions".into());
    let list = json
        .as_object_mut()
        .unwrap()
        .entry(key)
        .or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let array = list.as_array_mut().unwrap();
    let mut found = false;
    let mut changed = false;
    array.retain_mut(|entry| {
        if !equivalent_spec(entry, &spec) {
            return true;
        }
        if found {
            changed = true;
            return false;
        }
        found = true;
        if entry.as_str() != Some(spec.as_str()) {
            *entry = Value::String(spec.clone());
            changed = true;
        }
        true
    });
    if !found {
        array.push(Value::String(spec));
        changed = true;
    }
    if changed {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&json).unwrap_or_else(|_| "{}".into())
        );
        tokio::fs::write(&path, text)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

async fn remove_extension(data_dir: &str, definition: &AgentDefinition) -> bool {
    let Some(config) = definition.plugin_inject.as_ref() else {
        return false;
    };
    let Some(path) = find_existing_config(&config.config_paths).await else {
        return true;
    };
    let Ok(mut json) = read_settings(&path).await else {
        return false;
    };
    let spec = resolved_spec(data_dir, definition);
    let key = config
        .config_key
        .clone()
        .unwrap_or_else(|| "extensions".into());
    let Some(array) = json.get_mut(&key).and_then(Value::as_array_mut) else {
        return true;
    };
    let before = array.len();
    array.retain(|entry| !equivalent_spec(entry, &spec));
    if array.len() < before {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&json).unwrap_or_else(|_| "{}".into())
        );
        if tokio::fs::write(&path, text).await.is_err() {
            return false;
        }
    }
    true
}

async fn needs_extension(data_dir: &str, definition: &AgentDefinition) -> bool {
    let Some(config) = definition.plugin_inject.as_ref() else {
        return true;
    };
    let Some(path) = find_existing_config(&config.config_paths).await else {
        return true;
    };
    let Ok(json) = read_settings(&path).await else {
        return true;
    };
    let spec = resolved_spec(data_dir, definition);
    let key = config.config_key.as_deref().unwrap_or("extensions");
    json.get(key)
        .and_then(Value::as_array)
        .map(|array| !array.iter().any(|entry| equivalent_spec(entry, &spec)))
        .unwrap_or(true)
}

async fn find_or_create_config(paths: &[String], create: bool) -> Result<String, String> {
    if let Some(path) = find_existing_config(paths).await {
        return Ok(path);
    }
    if create && !paths.is_empty() {
        let resolved = resolve_home(&paths[0]);
        if let Some(parent) = Path::new(&resolved).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| err.to_string())?;
        }
        if tokio::fs::metadata(&resolved).await.is_err() {
            tokio::fs::write(&resolved, "{}\n")
                .await
                .map_err(|err| err.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&resolved, std::fs::Permissions::from_mode(0o600));
            }
        }
        return Ok(resolved);
    }
    Err(format!("no config file found in: {}", paths.join(", ")))
}

async fn find_existing_config(paths: &[String]) -> Option<String> {
    for path in paths {
        let resolved = resolve_home(path);
        if file_exists(&resolved).await {
            return Some(resolved);
        }
    }
    None
}

async fn read_settings(path: &str) -> Result<Value, String> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|err| err.to_string())?;
    let parsed = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
        .unwrap_or_else(|_| json!({}));
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Ok(json!({}))
    }
}

async fn detect_agent(detection: &AgentDetectionConfig) -> bool {
    if detection.paths.is_empty() && detection.commands.is_empty() {
        return false;
    }
    for path in &detection.paths {
        let resolved = resolve_home(path);
        if resolved.contains('*') || resolved.contains('?') {
            if glob::glob(&resolved)
                .ok()
                .and_then(|mut items| items.next())
                .is_some()
            {
                return true;
            }
            continue;
        }
        if tokio::fs::metadata(&resolved).await.is_ok() {
            return true;
        }
    }
    for command in &detection.commands {
        if which::which(command).is_ok() {
            return true;
        }
    }
    false
}

async fn find_missing_runtime_assets(data_dir: &str) -> Vec<String> {
    let candidates = [
        Path::new(data_dir)
            .join("plugins")
            .join("pi-coding-agent")
            .join("index.mjs"),
        Path::new(data_dir)
            .join("plugins")
            .join("shared")
            .join("resource-context.mjs"),
    ];
    let mut missing = Vec::new();
    for candidate in candidates {
        if !file_exists(&candidate.to_string_lossy()).await {
            missing.push(candidate.to_string_lossy().into_owned());
        }
    }
    missing
}

async fn assert_dedicated_agent_dir(
    data_dir: &str,
    definition: &AgentDefinition,
) -> Result<(), String> {
    let agent_dir = comparable_path(&definition.pi_sdk.as_ref().unwrap().agent_dir);
    let built_in = comparable_path(&resolve_home(&resolve_pi_coding_agent_dir()));
    if agent_dir == built_in {
        return Err("agentDir must be dedicated to this custom Agent; the built-in PI directory is owned by the pi-coding-agent integration".into());
    }
    for candidate in list_registered_pi_sdk_agents(data_dir).await {
        if candidate.id != definition.id
            && comparable_path(&candidate.pi_sdk.as_ref().unwrap().agent_dir) == agent_dir
        {
            return Err(format!(
                "agentDir is already registered to PI SDK Agent {}: {agent_dir}",
                candidate.id
            ));
        }
    }
    let settings_path = &definition.plugin_inject.as_ref().unwrap().config_paths[0];
    let settings = read_json_file::<Value>(settings_path)
        .await
        .unwrap_or(Value::Null);
    let extensions = settings
        .get("extensions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let own = comparable_path(&wrapper_path(data_dir, &definition.id));
    for entry in extensions {
        let Some(text) = entry.as_str() else { continue };
        let normalized = comparable_path(text.trim_start_matches("file://"));
        let built_in_plugin =
            normalized.ends_with(&comparable_path("plugins/pi-coding-agent/index.mjs"));
        let another = normalized.contains(&comparable_path("plugins/pi-coding-agent/agents/"))
            && normalized != own;
        if built_in_plugin || another {
            return Err(format!(
                "agentDir already loads another Pilot PI telemetry extension: {text}"
            ));
        }
    }
    Ok(())
}

fn resolve_pi_coding_agent_dir() -> String {
    std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PI_CODING_AGENT_DIR.into())
}

fn comparable_path(value: &str) -> String {
    let normalized = Path::new(value)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn resolve_absolute_path(raw: &str, label: &str, allow_glob: bool) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.contains('\0') {
        return Err(format!("{label} contains an invalid null byte"));
    }
    if !allow_glob && (value.contains('*') || value.contains('?')) {
        return Err(format!("{label} must not contain glob characters"));
    }
    let expanded = resolve_home(value);
    let path = Path::new(&expanded);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    Ok(absolute
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned())
}

fn unique_strings(values: &[String], label: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in values {
        let value = raw.trim();
        if value.is_empty() {
            return Err(format!("{label} must not be empty"));
        }
        if value.contains('\0') {
            return Err(format!("{label} contains an invalid null byte"));
        }
        if value.chars().count() > 512 {
            return Err(format!("{label} is too long"));
        }
        if !out.iter().any(|existing: &String| existing == value) {
            out.push(value.to_string());
        }
    }
    Ok(out)
}

async fn tighten_private_file(path: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

async fn restore_wrapper(path: &str, previous: Option<&str>) {
    if let Some(previous) = previous {
        let _ = write_text_file_atomic(path, previous, &AtomicTextWriteOptions::default()).await;
        tighten_private_file(path).await;
    } else {
        let _ = tokio::fs::remove_file(path).await;
    }
}

// Release the exact owner on success, failure, panic, and future cancellation.
// Registry cancellation must not strand the same-process owner map or lock file.
struct RegistryLock(crate::utils::SingleInstanceLock);
impl Drop for RegistryLock {
    fn drop(&mut self) {
        self.0.release();
    }
}

async fn with_lock<T, F, Fut>(data_dir: &str, operation: F) -> anyhow::Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let patterns = pi_sdk_registry_process_patterns();
    let lock_path = Path::new(data_dir)
        .join(PI_SDK_REGISTRY_LOCK_FILE)
        .to_string_lossy()
        .into_owned();
    let acquired = acquire_single_instance_lock(&lock_path, Some(&patterns));
    let Some(lock) = acquired.lock else {
        return Err(anyhow::Error::new(PiSdkRegistryBusyError {
            holder_pid: acquired.holder_pid,
        }));
    };
    let _guard = RegistryLock(lock);
    operation().await.map_err(anyhow::Error::msg)
}

#[allow(dead_code)]
pub fn command_matches_registry(command: &str) -> bool {
    let patterns = pi_sdk_registry_process_patterns();
    is_command_match(command, &patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn install_runtime(data_dir: &std::path::Path) {
        tokio::fs::create_dir_all(data_dir.join("plugins").join("pi-coding-agent"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(data_dir.join("plugins").join("shared"))
            .await
            .unwrap();
        tokio::fs::write(
            data_dir
                .join("plugins")
                .join("pi-coding-agent")
                .join("index.mjs"),
            "export {}\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            data_dir
                .join("plugins")
                .join("shared")
                .join("resource-context.mjs"),
            "export {}\n",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn registers_injects_and_unregisters() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("pilot-data");
        let agent = dir.path().join("acme-agent");
        let detected = dir.path().join("acme-installed");
        tokio::fs::create_dir_all(&detected).await.unwrap();
        install_runtime(&data).await;
        let result = register_pi_sdk_agent(PiSdkAgentRegistrationRequest {
            data_dir: data.to_string_lossy().into_owned(),
            id: "acme-code".into(),
            name: "Acme Code Agent".into(),
            agent_dir: agent.to_string_lossy().into_owned(),
            detection_paths: vec![detected.to_string_lossy().into_owned()],
            detection_commands: vec!["acme-code".into()],
        })
        .await
        .unwrap();
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["extensions"][0], result.wrapper_path);
        let definition: Value =
            serde_json::from_str(&std::fs::read_to_string(&result.definition_path).unwrap())
                .unwrap();
        assert_eq!(definition["id"], "acme-code");
        assert_eq!(definition["deployMode"], "plugin-inject");
        assert_eq!(definition["piSdk"]["schemaVersion"], 1);
        assert_eq!(
            definition["piSdk"]["agentDir"],
            agent.to_string_lossy().as_ref()
        );
        assert_eq!(
            definition["detection"]["paths"],
            json!([detected.to_string_lossy().as_ref()])
        );
        assert_eq!(settings["extensions"], json!([&result.wrapper_path]));
        assert_eq!(definition["pluginInject"]["configKey"], "extensions");
        assert_eq!(
            definition["pluginInject"]["pluginId"],
            "loongsuite-pilot-pi-sdk-acme-code"
        );
        let wrapper = std::fs::read_to_string(&result.wrapper_path).unwrap();
        assert!(wrapper.contains("createPiTelemetryExtension"));
        assert!(wrapper.contains("\"agentType\": \"acme-code\""));
        assert!(wrapper.contains("\"framework\": \"pi-coding-agent\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&result.wrapper_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&result.definition_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        register_pi_sdk_agent(PiSdkAgentRegistrationRequest {
            data_dir: data.to_string_lossy().into_owned(),
            id: "acme-code".into(),
            name: "Acme Code Agent".into(),
            agent_dir: agent.to_string_lossy().into_owned(),
            detection_paths: vec![detected.to_string_lossy().into_owned()],
            detection_commands: Vec::new(),
        })
        .await
        .unwrap();
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["extensions"].as_array().unwrap().len(), 1);
        let doctor = doctor_pi_sdk_agent(data.to_str().unwrap(), "acme-code")
            .await
            .unwrap();
        assert!(
            doctor.detected
                && doctor.runtime_present
                && doctor.wrapper_present
                && doctor.injection_present
                && doctor.healthy
        );
        let removed = unregister_pi_sdk_agent(data.to_str().unwrap(), "acme-code")
            .await
            .unwrap();
        assert!(removed.injection_removed && removed.definition_removed);
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("settings.json")).unwrap())
                .unwrap();
        assert!(settings["extensions"].as_array().unwrap().is_empty());
        assert!(!Path::new(&result.wrapper_path).exists());
    }

    #[tokio::test]
    async fn rejects_reserved_ids_unrelated_definitions_and_duplicate_dirs() {
        assert!(validate_pi_sdk_agent_id("claude-code").is_err());
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("pilot-data");
        install_runtime(&data).await;
        let definition_path = data.join("agents.d.local").join("custom-tool.json");
        tokio::fs::create_dir_all(definition_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&definition_path, r#"{"id":"custom-tool","displayName":"Custom","deployMode":"hook","detection":{"paths":[],"commands":[]}}"#).await.unwrap();
        let err = register_pi_sdk_agent(PiSdkAgentRegistrationRequest {
            data_dir: data.to_string_lossy().into_owned(),
            id: "custom-tool".into(),
            name: "Custom".into(),
            agent_dir: dir.path().join("agent").to_string_lossy().into_owned(),
            detection_paths: vec![dir.path().join("detected").to_string_lossy().into_owned()],
            detection_commands: Vec::new(),
        })
        .await
        .unwrap_err();
        assert!(err.contains("not managed as PI SDK"));
        assert!(command_matches_registry(
            "node dist/index.js agent register --id acme"
        ));
    }
}

#[cfg(test)]
#[path = "pi_sdk_agent_registry_history.rs"]
mod historical_contracts;
