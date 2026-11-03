//! Configuration load order: environment, config file, then defaults.
//! Port of `config-loader.ts`.
//!
//! `load_config` reads `config.json` (or `AGENT_DATA_COLLECTION_CONFIG`) and
//! `{dataDir}/configs/inner/data_config.json`. `assemble_config` is the same
//! merge with the documents and environment already in hand, so unit tests do
//! not touch the process environment.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::interceptor::{build_interceptor_config_with, ensure_mask_covers_interceptor};
use crate::normalization::{parse_key_value_attributes, sanitize_attributes};
use crate::types::{
    AgentConfig, AgentMultimodalConfig, AgentsConfig, AnalyticsConfig, AutoUpdateConfig, CmsConfig,
    CmsEndpointEntry, DashboardConfig, FlusherConfig, HookWatchdogConfig, HttpFlusherConfig,
    InnerTraceConfig, JsonlFlusherConfig, ListenerConfig, LogRetentionConfig, MaskConfig, MaskMode,
    MaskReplacementMode, MaskType, MultimodalAkAuth, MultimodalApiKeyAuth,
    MultimodalCredentialAuth, MultimodalOssTarget, MultimodalRuntimeConfig, MultimodalSlsAuthMode,
    MultimodalSlsTarget, MultimodalStorage, MultimodalStorageAuth, MultimodalUploadMode,
    OtlpEndpoint, OtlpProtocol, OtlpTraceFlusherConfig, OtlpTraceRawConfig, PipelineSectionToggle,
    PipelineToggle, PrivacyConfig, SlsEndpoint, SlsEndpointKind, SlsFlusherConfig, SlsMode,
    StatusBarConfig, UpstreamLinkConfig, MULTIMODAL_SLS_AUTH_MODES, MULTIMODAL_UPLOAD_MODES,
    SUPPORTED_MASK_TYPES,
};
use crate::updater::build_auto_update_config_with;
use crate::utils::{
    config_json_path, global_poll_interval_ms, pick_data_dir, read_json_file, resolve_home,
    Platform, DEFAULT_POLL_INTERVAL_MS,
};

use super::{fields, logger};

const SLS_PUBLIC_HOST_SUFFIX: &str = ".log.aliyuncs.com";
const DEFAULT_UPSTREAM_TTL_MS: u64 = 86_400_000;

pub struct ConfigSources<'a> {
    pub env: &'a HashMap<String, String>,
    pub platform: Platform,
    pub hostname: &'a str,
    pub config_path: &'a str,
    pub global_poll_ms: Option<u64>,
}

pub async fn load_config() -> anyhow::Result<AnalyticsConfig> {
    load_config_impl(false).await
}

/// 预检只读配置；已存在但损坏的文件和无效显式路径不能退回默认值。
pub async fn check_config() -> anyhow::Result<AnalyticsConfig> {
    load_config_impl(true).await
}

async fn read_checked_config(path: &str, required: bool) -> anyhow::Result<Option<Value>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if !required && err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => anyhow::bail!("无法读取配置 {path}：{}", err.kind()),
    };
    let text =
        std::str::from_utf8(&bytes).map_err(|_| anyhow::anyhow!("配置不是 UTF-8：{path}"))?;
    let value: Value =
        serde_json::from_str(crate::utils::fs_utils::strip_bom(text)).map_err(|err| {
            anyhow::anyhow!(
                "配置 JSON 无效：{path}，行 {}，列 {}",
                err.line(),
                err.column()
            )
        })?;
    anyhow::ensure!(value.is_object(), "配置必须为 JSON 对象：{path}");
    Ok(Some(value))
}

fn inner_config_path(data_dir: &str) -> String {
    // Windows 的 canonicalize 结果带 verbatim 前缀，不能再用 '/' 字符串拼接。
    std::path::Path::new(&resolve_home(data_dir))
        .join("configs")
        .join("inner")
        .join("data_config.json")
        .to_string_lossy()
        .into_owned()
}

async fn load_config_impl(strict: bool) -> anyhow::Result<AnalyticsConfig> {
    let config_path = config_json_path();
    let file = if strict {
        let required = std::env::var("AGENT_DATA_COLLECTION_CONFIG")
            .is_ok_and(|value| !value.trim().is_empty());
        read_checked_config(&config_path, required).await?
    } else {
        read_json_file::<Value>(&config_path).await
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    let host = hostname_string();
    let sources = ConfigSources {
        env: &env,
        platform: Platform::current(),
        hostname: &host,
        config_path: &config_path,
        global_poll_ms: global_poll_interval_ms(),
    };
    let data_dir = pick_data_dir(
        env_get(&sources, "LOONGSUITE_PILOT_DATA_DIR").as_deref(),
        json_str(file.as_ref().and_then(|value| value.get("dataDir"))),
    );
    let inner_path = inner_config_path(&data_dir);
    let inner = if strict {
        read_checked_config(&inner_path, false).await?
    } else {
        read_json_file::<Value>(&inner_path).await
    };
    let log = logger("ConfigLoader");
    if file.is_some() {
        log.info(
            "loaded config file",
            Some(&fields(serde_json::json!({ "path": config_path }))),
        );
    } else {
        log.debug(
            "no config file found, using env + defaults",
            Some(&fields(serde_json::json!({ "path": config_path }))),
        );
    }
    let config = assemble_config(file.as_ref(), inner.as_ref(), &sources)?;
    if !strict {
        crate::internal::configure_telemetry(&config.data_dir).await;
    }
    Ok(config)
}

pub fn assemble_config(
    file: Option<&Value>,
    inner: Option<&Value>,
    sources: &ConfigSources<'_>,
) -> anyhow::Result<AnalyticsConfig> {
    if let Some(file) = file {
        warn_ignored_capture(file);
    }
    let data_dir = pick_data_dir(
        env_get(sources, "LOONGSUITE_PILOT_DATA_DIR").as_deref(),
        json_str(file.and_then(|value| value.get("dataDir"))),
    );
    let user_id = env_get(sources, "LOONGSUITE_PILOT_USER_ID")
        .or_else(|| json_str(file.and_then(|value| value.get("userId"))).map(str::to_string))
        .or_else(|| json_str(file.and_then(|value| value.get("user.id"))).map(str::to_string))
        .unwrap_or_else(|| sources.hostname.to_string());
    let service_name = non_empty(env_get(sources, "LOONGSUITE_PILOT_SERVICE_NAME"))
        .or_else(|| non_empty(json_string(file.and_then(|value| value.get("serviceName")))));
    let service_name_prefix = env_get(sources, "LOONGSUITE_PILOT_SERVICE_NAME_PREFIX")
        .or_else(|| {
            json_str(file.and_then(|value| value.get("serviceNamePrefix"))).map(str::to_string)
        })
        .unwrap_or_else(|| "loongsuite-pilot".into());
    let interceptor =
        build_interceptor_config_with(file.and_then(|value| value.get("interceptor")), |key| {
            env_get(sources, key)
        });
    let mask = ensure_mask_covers_interceptor(&build_mask_config(file, sources), &interceptor);
    let privacy_raw = match file
        .and_then(|value| value.get("privacy"))
        .and_then(|value| value.get("excludeWorkspaces"))
    {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_string).ok_or_else(|| {
                    anyhow::anyhow!(
                        "privacy.excludeWorkspaces must be an array of absolute local directories"
                    )
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(_) => anyhow::bail!(
            "privacy.excludeWorkspaces must be an array of absolute local directories"
        ),
    };
    let exclude = crate::pipeline::workspace_policy::validate_excluded_workspaces(&privacy_raw)
        .map_err(|err| anyhow::anyhow!(err))?;
    let auto_update =
        build_auto_update_config_with(file, sources.platform, |key| sources.env.get(key).cloned());
    Ok(AnalyticsConfig {
        source_config_path: (!sources.config_path.is_empty())
            .then(|| sources.config_path.to_owned()),
        privacy: Some(PrivacyConfig {
            exclude_workspaces: exclude,
        }),
        enabled: env_bool(
            sources,
            "LOONGSUITE_PILOT_ENABLED",
            json_bool(file.and_then(|value| value.get("enabled"))).unwrap_or(true),
        ),
        auto_start: true,
        data_dir: data_dir.clone(),
        user_id,
        collect_log: env_bool(
            sources,
            "LOONGSUITE_PILOT_COLLECT_LOG",
            json_bool(file.and_then(|value| value.get("collectLog"))).unwrap_or(true),
        ),
        collect_trace: env_bool(
            sources,
            "LOONGSUITE_PILOT_COLLECT_TRACE",
            json_bool(file.and_then(|value| value.get("collectTrace"))).unwrap_or(true),
        ),
        service_name: service_name.clone(),
        service_name_prefix: service_name_prefix.clone(),
        cms: build_cms_config(file, sources),
        otlp_trace: build_otlp_trace_raw(file),
        inner_trace: inner.map(|value| InnerTraceConfig {
            otlp: decode_vec(value.get("otlp")),
            cms: decode_vec(value.get("cms")),
            service_name_prefix: json_str(value.get("serviceNamePrefix")).map(str::to_string),
        }),
        listeners: build_listeners(file, sources),
        flushers: build_flushers(
            file,
            inner,
            &data_dir,
            service_name.as_deref(),
            &service_name_prefix,
            sources,
        ),
        retention: build_retention(file, sources),
        agents: build_agents(file, inner),
        mask,
        hook_watchdog: build_hook_watchdog(file, sources),
        file_collection: build_pipeline(file, sources),
        pipeline: build_pipeline(file, sources),
        status_bar: build_status_bar(file, sources),
        dashboard: build_dashboard(file),
        auto_update: Some(auto_update),
        upstream_link: build_upstream(file, sources),
        multimodal: build_multimodal(file, inner),
        global_span_attributes: Some(resolve_global_span_attributes(file, sources)),
        interceptor,
    })
}

pub fn build_otlp_trace_config(config: &AnalyticsConfig) -> Option<OtlpTraceFlusherConfig> {
    let env: HashMap<String, String> = std::env::vars().collect();
    build_otlp_trace_config_with(config, &env, Platform::current())
}

pub fn build_otlp_trace_config_with(
    config: &AnalyticsConfig,
    env: &HashMap<String, String>,
    platform: Platform,
) -> Option<OtlpTraceFlusherConfig> {
    if !config.collect_trace {
        return None;
    }
    let sources = ConfigSources {
        env,
        platform,
        hostname: "",
        config_path: "",
        global_poll_ms: None,
    };
    let mut endpoints = Vec::new();
    let mut arms_resource_attributes = HashMap::new();
    let user_service_name = config
        .service_name
        .clone()
        .or_else(|| {
            config
                .otlp_trace
                .as_ref()
                .and_then(|otlp| otlp.service_name.clone())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if config.service_name_prefix.is_empty() {
                "loongsuite-pilot".into()
            } else {
                config.service_name_prefix.clone()
            }
        });
    let inner_prefix = if config
        .service_name
        .as_ref()
        .is_some_and(|value| !value.is_empty())
    {
        None
    } else {
        config
            .inner_trace
            .as_ref()
            .and_then(|inner| inner.service_name_prefix.clone())
    };
    let inner_service_name = inner_prefix.filter(|prefix| prefix != &user_service_name);
    if let Some(endpoint) = env_get(&sources, "LOONGSUITE_PILOT_OTLP_ENDPOINT").or_else(|| {
        config
            .otlp_trace
            .as_ref()
            .and_then(|otlp| otlp.endpoint.clone())
    }) {
        let headers = if let Some(raw) = env_get(&sources, "LOONGSUITE_PILOT_OTLP_HEADERS") {
            match serde_json::from_str::<HashMap<String, String>>(&raw) {
                Ok(parsed) => Some(parsed),
                Err(_) => {
                    logger("ConfigLoader").warn(
                        "LOONGSUITE_PILOT_OTLP_HEADERS is not valid JSON, ignoring",
                        Some(&fields(serde_json::json!({ "length": raw.len() }))),
                    );
                    None
                }
            }
        } else {
            config
                .otlp_trace
                .as_ref()
                .and_then(|otlp| otlp.headers.clone())
        };
        endpoints.push(OtlpEndpoint {
            name: "user-otlp".into(),
            endpoint,
            headers,
            compression: config.otlp_trace.as_ref().and_then(|otlp| otlp.compression),
            service_name: None,
        });
    }
    if config.cms.enabled && !config.cms.endpoint.is_empty() {
        endpoints.push(cms_entry_to_otlp(
            "user-cms",
            &config.cms.endpoint,
            Some(config.cms.license_key.as_str()),
            Some(config.cms.workspace.as_str()),
            None,
            &mut arms_resource_attributes,
            None,
        ));
    }
    let inner_otlp = config
        .inner_trace
        .as_ref()
        .and_then(|inner| inner.otlp.clone())
        .unwrap_or_default();
    for (index, endpoint) in inner_otlp.into_iter().enumerate() {
        if endpoint.endpoint.is_empty() {
            continue;
        }
        endpoints.push(OtlpEndpoint {
            name: endpoint
                .name
                .unwrap_or_else(|| format!("inner-otlp-{index}")),
            endpoint: endpoint.endpoint,
            headers: endpoint.headers,
            compression: endpoint.compression,
            service_name: inner_service_name.clone(),
        });
    }
    let inner_cms = config
        .inner_trace
        .as_ref()
        .and_then(|inner| inner.cms.clone())
        .unwrap_or_default();
    for (index, endpoint) in inner_cms.into_iter().enumerate() {
        if endpoint.endpoint.is_empty() {
            continue;
        }
        let name = endpoint
            .name
            .clone()
            .unwrap_or_else(|| format!("inner-cms-{index}"));
        endpoints.push(cms_entry_to_otlp(
            &name,
            &endpoint.endpoint,
            endpoint.license_key.as_deref(),
            endpoint.workspace.as_deref(),
            endpoint.project.as_deref(),
            &mut arms_resource_attributes,
            inner_service_name.clone(),
        ));
    }
    let deduped = dedup_otlp_endpoints(endpoints);
    if deduped.is_empty() {
        return None;
    }
    let otlp = config.otlp_trace.clone().unwrap_or_default();
    let mut resource_attributes = otlp.resource_attributes.clone().unwrap_or_default();
    resource_attributes.extend(arms_resource_attributes);
    Some(OtlpTraceFlusherConfig {
        span_enricher_paths: Some(resolve_span_enricher_paths(
            otlp.span_enrichers.clone(),
            &config.data_dir,
            config
                .source_config_path
                .as_deref()
                .unwrap_or(&crate::utils::config_json_path()),
        )),
        enabled: true,
        endpoints: deduped,
        protocol: OtlpProtocol::HttpProtobuf,
        service_name: user_service_name,
        append_agent_type_to_service_name: if config
            .service_name
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        {
            Some(false)
        } else {
            None
        },
        resource_attributes: if resource_attributes.is_empty() {
            None
        } else {
            Some(resource_attributes)
        },
        capture_message_content: None,
        debug: Some(otlp.debug.unwrap_or(config.cms.debug.unwrap_or(false))),
        turn_idle_timeout_ms: Some(otlp.turn_idle_timeout_ms.unwrap_or(0)),
        resource_attribute_keys: Some(unique_trimmed(otlp.resource_attribute_keys.as_deref())),
        span_attribute_passthrough_prefixes: Some(unique_trimmed(
            otlp.span_attribute_passthrough_prefixes.as_deref(),
        )),
        max_export_batch_bytes: otlp.max_export_batch_bytes,
        data_dir: None,
    })
}

fn resolve_span_enricher_paths(
    value: Option<Vec<String>>,
    data_dir: &str,
    config_path: &str,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    let config_dir = std::path::Path::new(config_path)
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let resolved_data_dir = resolve_home(data_dir);
    let pilot_data = std::path::Path::new(&resolved_data_dir);
    for entry in value {
        let trimmed = entry.trim();
        if trimmed.is_empty() || !trimmed.ends_with(".mjs") {
            logger("ConfigLoader").warn(
                "Ignoring invalid span enricher path; expected a local .mjs file",
                None,
            );
            continue;
        }
        let expanded = if let Some(rest) = trimmed.strip_prefix("$PILOT_DATA") {
            if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
                format!("{}{rest}", pilot_data.display())
            } else {
                trimmed.to_string()
            }
        } else {
            trimmed.to_string()
        };
        let resolved = config_dir.join(resolve_home(&expanded));
        let absolute = std::path::absolute(&resolved).unwrap_or(resolved);
        let mut normalized = std::path::PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    // Absolute roots cannot be escaped by additional parents.
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        let text = normalized.to_string_lossy().into_owned();
        if !paths.contains(&text) {
            paths.push(text);
        }
        if paths.len() == 16 {
            logger("ConfigLoader").warn("At most 16 span enrichers are loaded", None);
            break;
        }
    }
    paths
}

fn cms_entry_to_otlp(
    name: &str,
    endpoint: &str,
    license_key: Option<&str>,
    workspace: Option<&str>,
    project: Option<&str>,
    arms: &mut HashMap<String, String>,
    service_name: Option<String>,
) -> OtlpEndpoint {
    let mut headers = HashMap::new();
    let arms_project = project
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| extract_arms_project(endpoint));
    if let Some(license) = license_key.filter(|value| !value.is_empty()) {
        headers.insert("x-arms-license-key".into(), license.to_string());
    }
    if let Some(project) = arms_project.filter(|value| !value.is_empty()) {
        headers.insert("x-arms-project".into(), project);
    }
    if let Some(workspace) = workspace.filter(|value| !value.is_empty()) {
        headers.insert("x-cms-workspace".into(), workspace.to_string());
    }
    arms.insert("acs.arms.service.feature".into(), "genai_app".into());
    OtlpEndpoint {
        name: name.to_string(),
        endpoint: endpoint.to_string(),
        headers: if headers.is_empty() {
            None
        } else {
            Some(headers)
        },
        compression: None,
        service_name,
    }
}

fn stable_header_key(headers: Option<&HashMap<String, String>>) -> String {
    let Some(headers) = headers else {
        return String::new();
    };
    let mut keys: Vec<&String> = headers.keys().collect();
    keys.sort();
    keys.into_iter()
        .map(|key| {
            format!(
                "{key}={}",
                headers.get(key).map(String::as_str).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn dedup_otlp_endpoints(endpoints: Vec<OtlpEndpoint>) -> Vec<OtlpEndpoint> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for endpoint in endpoints {
        let key = format!(
            "{}|{}|{}",
            normalize_endpoint_url(&endpoint.endpoint),
            stable_header_key(endpoint.headers.as_ref()),
            endpoint.service_name.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            result.push(endpoint);
        }
    }
    result
}

fn extract_arms_project(endpoint: &str) -> Option<String> {
    parse_http_url(endpoint).and_then(|url| {
        url.host
            .split('.')
            .next()
            .filter(|part| !part.is_empty())
            .map(str::to_string)
    })
}

fn unique_trimmed(values: Option<&[String]>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values.unwrap_or(&[]) {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing: &String| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn build_flushers(
    file: Option<&Value>,
    inner: Option<&Value>,
    data_dir: &str,
    service_name: Option<&str>,
    service_name_prefix: &str,
    sources: &ConfigSources<'_>,
) -> FlusherConfig {
    FlusherConfig {
        sls: Some(build_sls_config(
            file,
            inner,
            service_name,
            service_name_prefix,
            sources,
        )),
        jsonl: Some(build_jsonl_config(file, data_dir, sources)),
        http: Some(build_http_config(file, sources)),
    }
}

fn build_sls_config(
    file: Option<&Value>,
    inner: Option<&Value>,
    service_name: Option<&str>,
    service_name_prefix: &str,
    sources: &ConfigSources<'_>,
) -> SlsFlusherConfig {
    let raw = file.and_then(|value| value.get("sls"));
    let is_array = raw.map(Value::is_array).unwrap_or(false);
    let single = if is_array { None } else { raw };
    if single
        .and_then(|value| value.get("destinationOverride"))
        .is_some()
    {
        logger("ConfigLoader").warn(
            "config.sls.destinationOverride is deprecated and ignored — remove it from config.json",
            None,
        );
    }
    let mut endpoints = if is_array {
        raw.and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                if json_str(entry.get("endpoint")).is_none()
                    || json_str(entry.get("logstore")).is_none()
                {
                    return None;
                }
                parse_sls_endpoint_entry(&entry, index)
            })
            .collect()
    } else if let Some(single) = single {
        let user_mode = read_user_sls_mode(single, sources);
        let user_ak = env_get(sources, "LOONGSUITE_SLS_ACCESS_KEY_ID")
            .or_else(|| json_string(single.get("accessKeyId")));
        let user_sk = env_get(sources, "LOONGSUITE_SLS_ACCESS_KEY_SECRET")
            .or_else(|| json_string(single.get("accessKeySecret")));
        let user_api_key = json_string(single.get("apiKey"));
        let user_raw_endpoint = env_get(sources, "LOONGSUITE_SLS_ENDPOINT")
            .or_else(|| json_string(single.get("endpoint")));
        let user_project = env_get(sources, "LOONGSUITE_SLS_PROJECT")
            .or_else(|| json_string(single.get("project")));
        let user_logstore = env_get(sources, "LOONGSUITE_SLS_LOGSTORE")
            .or_else(|| json_string(single.get("logstore")));
        if user_project.as_ref().is_some_and(|value| !value.is_empty())
            && user_logstore
                .as_ref()
                .is_some_and(|value| !value.is_empty())
        {
            vec![build_user_sls_endpoint(
                user_mode,
                user_raw_endpoint.as_deref(),
                user_project.as_deref().unwrap_or(""),
                user_logstore.as_deref().unwrap_or(""),
                user_ak.as_deref(),
                user_sk.as_deref(),
                user_api_key.as_deref(),
            )]
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    if let Some(inner_sls) = inner
        .and_then(|value| value.get("sls"))
        .and_then(Value::as_array)
    {
        let inner_prefix = if service_name.is_some_and(|value| !value.is_empty()) {
            None
        } else {
            inner.and_then(|value| json_str(value.get("serviceNamePrefix")))
        };
        let inner_service_name = inner_prefix
            .filter(|prefix| *prefix != service_name_prefix)
            .map(str::to_string);
        for (index, entry) in inner_sls.iter().enumerate() {
            if json_str(entry.get("endpoint")).is_none()
                || json_str(entry.get("logstore")).is_none()
            {
                continue;
            }
            if let Some(mut parsed) = parse_sls_endpoint_entry(entry, index) {
                if let Some(name) = inner_service_name.clone() {
                    parsed.service_name = Some(name);
                }
                endpoints.push(parsed);
            }
        }
    }
    endpoints = dedup_sls_endpoints(endpoints);
    let primary = endpoints.first();
    let enabled = if let Some(flag) = single.and_then(|value| json_bool(value.get("enabled"))) {
        flag
    } else {
        !endpoints.is_empty() && endpoints.iter().all(sls_endpoint_complete)
    };
    SlsFlusherConfig {
        enabled,
        mode: primary
            .map(|endpoint| endpoint.mode)
            .unwrap_or(SlsMode::Webtracking),
        access_key_id: primary
            .and_then(|endpoint| endpoint.access_key_id.clone())
            .unwrap_or_default(),
        access_key_secret: primary
            .and_then(|endpoint| endpoint.access_key_secret.clone())
            .unwrap_or_default(),
        api_key: primary
            .and_then(|endpoint| endpoint.api_key.clone())
            .unwrap_or_default(),
        endpoint: primary
            .map(|endpoint| endpoint.endpoint.clone())
            .unwrap_or_default(),
        endpoints,
        batch_max_size: single
            .and_then(|value| json_usize(value.get("batchMaxSize")))
            .unwrap_or(20),
        flush_interval_ms: single
            .and_then(|value| json_u64(value.get("flushIntervalMs")))
            .unwrap_or(2_000),
        service_name: service_name.map(str::to_string),
        service_name_prefix: service_name_prefix.to_string(),
        timeout: single
            .and_then(|value| value.get("timeout"))
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        retry: single
            .and_then(|value| value.get("retry"))
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        flush_concurrency: single.and_then(|value| json_usize(value.get("flushConcurrency"))),
    }
}

fn sls_endpoint_complete(endpoint: &SlsEndpoint) -> bool {
    if endpoint.endpoint.is_empty()
        || endpoint.logstore.is_empty()
        || has_ambiguous_sls_credentials(endpoint)
    {
        return false;
    }
    match endpoint.mode {
        SlsMode::Ak => {
            !endpoint.project.is_empty()
                && present(endpoint.access_key_id.as_deref())
                && present(endpoint.access_key_secret.as_deref())
        }
        SlsMode::ApiKey => !endpoint.project.is_empty() && present(endpoint.api_key.as_deref()),
        SlsMode::Webtracking => true,
    }
}

fn read_user_sls_mode(single: &Value, sources: &ConfigSources<'_>) -> Option<SlsMode> {
    let raw = env_get(sources, "LOONGSUITE_SLS_MODE").or_else(|| json_string(single.get("mode")));
    raw.as_deref().and_then(|value| value.parse().ok())
}

fn build_user_sls_endpoint(
    mode: Option<SlsMode>,
    raw_endpoint: Option<&str>,
    project: &str,
    logstore: &str,
    access_key_id: Option<&str>,
    access_key_secret: Option<&str>,
    api_key: Option<&str>,
) -> SlsEndpoint {
    let mode = infer_sls_mode(mode, access_key_id, access_key_secret, api_key);
    let mut result = SlsEndpoint {
        name: "user-sls".into(),
        endpoint: scheme_endpoint(raw_endpoint.unwrap_or("")),
        project: project.to_string(),
        logstore: logstore.to_string(),
        kind: SlsEndpointKind::AgentActivity,
        mode,
        access_key_id: None,
        access_key_secret: None,
        api_key: None,
        redact: Some(false),
        service_name: None,
    };
    if mode == SlsMode::Ak || present(access_key_id) || present(access_key_secret) {
        result.access_key_id = Some(access_key_id.unwrap_or("").to_string());
        result.access_key_secret = Some(access_key_secret.unwrap_or("").to_string());
    }
    if mode == SlsMode::ApiKey || present(api_key) {
        result.api_key = Some(api_key.unwrap_or("").to_string());
    }
    warn_ambiguous(&result);
    result
}

fn parse_sls_endpoint_entry(entry: &Value, index: usize) -> Option<SlsEndpoint> {
    if !entry.is_object() {
        return None;
    }
    let mode = infer_sls_mode(
        json_str(entry.get("mode")).and_then(|value| value.parse().ok()),
        json_str(entry.get("accessKeyId")),
        json_str(entry.get("accessKeySecret")),
        json_str(entry.get("apiKey")),
    );
    let mut result = SlsEndpoint {
        name: json_str(entry.get("name"))
            .map(str::to_string)
            .unwrap_or_else(|| format!("sls-{index}")),
        endpoint: scheme_endpoint(json_str(entry.get("endpoint")).unwrap_or("")),
        project: json_str(entry.get("project")).unwrap_or("").to_string(),
        logstore: json_str(entry.get("logstore")).unwrap_or("").to_string(),
        kind: SlsEndpointKind::AgentActivity,
        mode,
        access_key_id: None,
        access_key_secret: None,
        api_key: None,
        redact: Some(false),
        service_name: None,
    };
    if mode == SlsMode::Ak
        || present(json_str(entry.get("accessKeyId")))
        || present(json_str(entry.get("accessKeySecret")))
    {
        result.access_key_id = Some(json_str(entry.get("accessKeyId")).unwrap_or("").to_string());
        result.access_key_secret = Some(
            json_str(entry.get("accessKeySecret"))
                .unwrap_or("")
                .to_string(),
        );
    }
    if mode == SlsMode::ApiKey || present(json_str(entry.get("apiKey"))) {
        result.api_key = Some(json_str(entry.get("apiKey")).unwrap_or("").to_string());
    }
    warn_ambiguous(&result);
    Some(result)
}

fn infer_sls_mode(
    mode: Option<SlsMode>,
    access_key_id: Option<&str>,
    access_key_secret: Option<&str>,
    api_key: Option<&str>,
) -> SlsMode {
    if let Some(mode) = mode {
        return mode;
    }
    if present(access_key_id) && present(access_key_secret) {
        SlsMode::Ak
    } else if present(api_key) {
        SlsMode::ApiKey
    } else {
        SlsMode::Webtracking
    }
}

fn has_ambiguous_sls_credentials(endpoint: &SlsEndpoint) -> bool {
    present(endpoint.api_key.as_deref())
        && (present(endpoint.access_key_id.as_deref())
            || present(endpoint.access_key_secret.as_deref()))
}

fn warn_ambiguous(endpoint: &SlsEndpoint) {
    if !has_ambiguous_sls_credentials(endpoint) {
        return;
    }
    logger("ConfigLoader").warn(
        "SLS endpoint has both API Key and AK/SK credentials; endpoint disabled until credentials are unambiguous",
        Some(&fields(serde_json::json!({
            "endpoint": endpoint.name,
            "mode": endpoint.mode.as_str(),
            "project": endpoint.project,
            "logstore": endpoint.logstore,
        }))),
    );
}

fn scheme_endpoint(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn normalize_endpoint_url(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    let lower = text.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || text.is_empty()) {
        text = format!("https://{text}");
    }
    while text.ends_with('/') {
        text.pop();
    }
    if let Some(scheme_end) = text.find("://") {
        let scheme = text[..scheme_end].to_ascii_lowercase();
        let rest = &text[scheme_end + 3..];
        let (host, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        return format!("{scheme}://{}{path}", host.to_ascii_lowercase());
    }
    text
}

fn dedup_sls_endpoints(endpoints: Vec<SlsEndpoint>) -> Vec<SlsEndpoint> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for endpoint in endpoints {
        let key = format!(
            "{}|{}|{}|{}",
            normalize_endpoint_url(&endpoint.endpoint),
            endpoint.project,
            endpoint.logstore,
            endpoint.service_name.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            result.push(endpoint);
        }
    }
    result
}

fn build_jsonl_config(
    file: Option<&Value>,
    data_dir: &str,
    sources: &ConfigSources<'_>,
) -> JsonlFlusherConfig {
    let jsonl = file.and_then(|value| value.get("jsonl"));
    JsonlFlusherConfig {
        enabled: env_bool(
            sources,
            "JSONL_ENABLED",
            json_bool(jsonl.and_then(|value| value.get("enabled"))).unwrap_or(true),
        ),
        output_dir: resolve_home(
            &env_get(sources, "JSONL_OUTPUT_DIR")
                .or_else(|| json_string(jsonl.and_then(|value| value.get("outputDir"))))
                .unwrap_or_else(|| format!("{data_dir}/logs/output")),
        ),
        rotate_daily: json_bool(jsonl.and_then(|value| value.get("rotateDaily"))).unwrap_or(true),
        max_file_size_mb: jsonl
            .and_then(|value| value.get("maxFileSizeMb"))
            .and_then(Value::as_number)
            .cloned()
            .unwrap_or_else(|| 100.into()),
    }
}

fn build_http_config(file: Option<&Value>, sources: &ConfigSources<'_>) -> HttpFlusherConfig {
    let http = file.and_then(|value| value.get("http"));
    let url_env = env_get(sources, "HTTP_REPORT_URL");
    let url = url_env
        .clone()
        .or_else(|| json_string(http.and_then(|value| value.get("url"))))
        .unwrap_or_default();
    let headers = if let Some(raw) = env_get(sources, "HTTP_REPORT_HEADERS") {
        serde_json::from_str(&raw).ok()
    } else {
        http.and_then(|value| value.get("headers"))
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    };
    let enabled = if sources.env.contains_key("HTTP_REPORT_URL") {
        !url.is_empty()
    } else {
        json_bool(http.and_then(|value| value.get("enabled"))).unwrap_or(!url.is_empty())
    };
    HttpFlusherConfig {
        enabled,
        url,
        headers,
        batch_max_size: json_usize(http.and_then(|value| value.get("batchMaxSize"))).unwrap_or(20),
        flush_interval_ms: json_u64(http.and_then(|value| value.get("flushIntervalMs")))
            .unwrap_or(5_000),
        request_timeout_ms: json_u64(http.and_then(|value| value.get("requestTimeoutMs")))
            .unwrap_or(10_000),
    }
}

fn resolve_listener_log_dir(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = std::path::PathBuf::from(resolve_home(trimmed));
    let absolute = std::path::absolute(&expanded).unwrap_or(expanded);
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized.to_string_lossy().into_owned())
}

fn build_listeners(
    file: Option<&Value>,
    sources: &ConfigSources<'_>,
) -> HashMap<String, ListenerConfig> {
    let mut result = HashMap::new();
    for key in [
        "qoder",
        "qoder-trace",
        "qoder-work",
        "qoder-work-log",
        "qoder-work-sqlite",
        "qoder-work-cn-trace",
        "qoder-work-cn-hook",
        "qoder-work-cn-log",
        "qoder-work-cn-sqlite",
        "qwen-work-cn-trace",
        "qwen-work-cn-hook",
        "qwen-work-cn-sqlite",
        "cursor-hook",
        "claude-code-log",
        "grok-build-log",
        "codex-transcript",
        "copilot-log",
        "opencode-log",
        "pi-coding-agent-log",
        "workbuddy",
        "doubao-work",
        "hermes-agent-log",
    ] {
        result.insert(
            key.to_string(),
            ListenerConfig {
                log_dir: None,
                enabled: true,
                poll_interval: DEFAULT_POLL_INTERVAL_MS,
            },
        );
    }
    if let Some(listeners) = file
        .and_then(|value| value.get("listeners"))
        .and_then(Value::as_object)
    {
        for (key, value) in listeners {
            let previous = result.get(key).cloned();
            result.insert(
                key.clone(),
                ListenerConfig {
                    log_dir: (key == "doubao-work")
                        .then(|| json_str(value.get("logDir")).and_then(resolve_listener_log_dir))
                        .flatten(),
                    enabled: json_bool(value.get("enabled"))
                        .or(previous.as_ref().map(|item| item.enabled))
                        .unwrap_or(true),
                    poll_interval: json_u64(value.get("pollInterval"))
                        .or(previous.map(|item| item.poll_interval))
                        .unwrap_or(DEFAULT_POLL_INTERVAL_MS),
                },
            );
        }
        if !listeners.contains_key("codex-transcript") {
            if let Some(legacy) = listeners
                .get("codex-log")
                .or_else(|| listeners.get("codex-aborted-turn"))
            {
                let defaults = result
                    .get("codex-transcript")
                    .cloned()
                    .unwrap_or(ListenerConfig {
                        log_dir: None,
                        enabled: true,
                        poll_interval: DEFAULT_POLL_INTERVAL_MS,
                    });
                result.insert(
                    "codex-transcript".into(),
                    ListenerConfig {
                        log_dir: None,
                        enabled: json_bool(legacy.get("enabled")).unwrap_or(defaults.enabled),
                        poll_interval: json_u64(legacy.get("pollInterval"))
                            .unwrap_or(defaults.poll_interval),
                    },
                );
            }
        }
    }
    let env_poll = env_int(sources, "QODER_ANALYTICS_POLL_INTERVAL", 0);
    if env_poll > 0 {
        if let Some(entry) = result.get_mut("qoder") {
            entry.poll_interval = env_poll;
        }
        if let Some(entry) = result.get_mut("qoder-trace") {
            entry.poll_interval = env_poll;
        }
    }
    if let Some(global) = sources.global_poll_ms {
        for entry in result.values_mut() {
            entry.poll_interval = global;
        }
    }
    result
}

fn build_retention(file: Option<&Value>, sources: &ConfigSources<'_>) -> LogRetentionConfig {
    let retention = file.and_then(|value| value.get("retention"));
    let unified = env_int(sources, "LOONGSUITE_PILOT_LOG_RETENTION_DAYS", 0);
    let resolve = |file_val: Option<u64>, fallback: u64| -> u32 {
        let value = file_val.unwrap_or(if unified > 0 { unified } else { fallback });
        value.min(u32::MAX as u64) as u32
    };
    LogRetentionConfig {
        enabled: env_bool(
            sources,
            "LOONGSUITE_PILOT_LOG_RETENTION_ENABLED",
            json_bool(retention.and_then(|value| value.get("enabled"))).unwrap_or(true),
        ),
        interval_ms: env_int(
            sources,
            "LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS",
            json_u64(retention.and_then(|value| value.get("intervalMs"))).unwrap_or(21_600_000),
        ),
        hook_history_days: resolve(
            json_u64(retention.and_then(|value| value.get("hookHistoryDays"))),
            7,
        ),
        hook_error_days: resolve(
            json_u64(retention.and_then(|value| value.get("hookErrorDays"))),
            7,
        ),
        hook_debug_days: resolve(
            json_u64(retention.and_then(|value| value.get("hookDebugDays"))),
            7,
        ),
        output_days: resolve(
            json_u64(retention.and_then(|value| value.get("outputDays"))),
            7,
        ),
        sls_failed_days: resolve(
            json_u64(retention.and_then(|value| value.get("slsFailedDays"))),
            7,
        ),
        otlp_failed_days: resolve(
            json_u64(retention.and_then(|value| value.get("otlpFailedDays"))),
            7,
        ),
        metric_alarm_days: resolve(
            json_u64(retention.and_then(|value| value.get("metricAlarmDays"))),
            7,
        ),
    }
}

fn build_hook_watchdog(file: Option<&Value>, sources: &ConfigSources<'_>) -> HookWatchdogConfig {
    let block = file.and_then(|value| value.get("hookWatchdog"));
    HookWatchdogConfig {
        enabled: env_bool(
            sources,
            "LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED",
            json_bool(block.and_then(|value| value.get("enabled"))).unwrap_or(true),
        ),
        interval_ms: env_int(
            sources,
            "LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS",
            json_u64(block.and_then(|value| value.get("intervalMs"))).unwrap_or(5 * 60_000),
        ),
        repair_cooldown_ms: env_int(
            sources,
            "LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS",
            json_u64(block.and_then(|value| value.get("repairCooldownMs"))).unwrap_or(10 * 60_000),
        ),
    }
}

fn build_pipeline(file: Option<&Value>, sources: &ConfigSources<'_>) -> PipelineToggle {
    let legacy = json_bool(
        file.and_then(|value| value.get("fileCollection"))
            .and_then(|value| value.get("enabled")),
    );
    let file_pipeline = json_bool(
        file.and_then(|value| value.get("pipeline"))
            .and_then(|value| value.get("enabled")),
    );
    let enabled = env_bool(
        sources,
        "LOONGSUITE_PILOT_PIPELINE_ENABLED",
        env_bool(
            sources,
            "LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED",
            file_pipeline.or(legacy).unwrap_or(false),
        ),
    );
    PipelineToggle {
        enabled,
        file: PipelineSectionToggle {
            enabled: env_bool(
                sources,
                "LOONGSUITE_PILOT_PIPELINE_FILE_ENABLED",
                json_bool(file.and_then(|value| value.pointer("/pipeline/file/enabled")))
                    .unwrap_or(true),
            ),
        },
        qoder_api: PipelineSectionToggle {
            enabled: env_bool(
                sources,
                "LOONGSUITE_PILOT_PIPELINE_QODER_API_ENABLED",
                json_bool(file.and_then(|value| value.pointer("/pipeline/qoderApi/enabled")))
                    .unwrap_or(true),
            ),
        },
    }
}

fn build_status_bar(file: Option<&Value>, sources: &ConfigSources<'_>) -> StatusBarConfig {
    let raw = file.and_then(|value| value.get("enableStatusBarApp"));
    let fallback = match raw {
        Some(Value::String(text)) => {
            let trimmed = text.trim().to_ascii_lowercase();
            trimmed != "false" && text.trim() != "0"
        }
        Some(Value::Bool(value)) => *value,
        _ => true,
    };
    StatusBarConfig {
        enabled: env_bool(sources, "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP", fallback),
        metrics_summary_interval_ms: 60_000,
        runtime_refresh_interval_ms: 30_000,
    }
}

fn build_dashboard(file: Option<&Value>) -> DashboardConfig {
    DashboardConfig {
        port: crate::dashboard::configured_port(
            file.and_then(|value| value.pointer("/dashboard/port")),
        ),
    }
}

fn build_upstream(file: Option<&Value>, sources: &ConfigSources<'_>) -> UpstreamLinkConfig {
    let block = file.and_then(|value| value.get("upstreamLink"));
    let ttl = env_int(
        sources,
        "LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS",
        json_u64(block.and_then(|value| value.get("ttlMs"))).unwrap_or(DEFAULT_UPSTREAM_TTL_MS),
    );
    UpstreamLinkConfig {
        enabled: env_bool(
            sources,
            "LOONGSUITE_PILOT_UPSTREAM_LINK",
            json_bool(block.and_then(|value| value.get("enabled"))).unwrap_or(false),
        ),
        propagate_to_tools: env_bool(
            sources,
            "LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS",
            json_bool(block.and_then(|value| value.get("propagateToTools"))).unwrap_or(false),
        ),
        propagate_to_llm: env_bool(
            sources,
            "LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_LLM",
            json_bool(block.and_then(|value| value.get("propagateToLlm"))).unwrap_or(false),
        ),
        generate_trace_when_missing: env_bool(
            sources,
            "LOONGSUITE_PILOT_UPSTREAM_LINK_GENERATE_TRACE_WHEN_MISSING",
            json_bool(block.and_then(|value| value.get("generateTraceWhenMissing")))
                .unwrap_or(false),
        ),
        ttl_ms: if ttl > 0 {
            ttl
        } else {
            DEFAULT_UPSTREAM_TTL_MS
        },
    }
}

fn build_cms_config(file: Option<&Value>, sources: &ConfigSources<'_>) -> CmsConfig {
    let cms = file.and_then(|value| value.get("cms"));
    let license_key = env_get(sources, "LOONGSUITE_PILOT_CMS_LICENSE_KEY")
        .or_else(|| json_string(cms.and_then(|value| value.get("licenseKey"))))
        .unwrap_or_default();
    CmsConfig {
        enabled: !license_key.is_empty(),
        license_key,
        endpoint: env_get(sources, "LOONGSUITE_PILOT_CMS_ENDPOINT")
            .or_else(|| json_string(cms.and_then(|value| value.get("endpoint"))))
            .unwrap_or_default(),
        workspace: env_get(sources, "LOONGSUITE_PILOT_CMS_WORKSPACE")
            .or_else(|| json_string(cms.and_then(|value| value.get("workspace"))))
            .unwrap_or_default(),
        debug: Some(json_bool(cms.and_then(|value| value.get("debug"))).unwrap_or(false)),
    }
}

fn build_otlp_trace_raw(file: Option<&Value>) -> Option<OtlpTraceRawConfig> {
    let raw = file.and_then(|value| value.get("otlpTrace"))?;
    if !raw.is_object() {
        return None;
    }
    // A malformed optional extension list must not disable trace destinations.
    // Resolve valid string paths later using the existing config/data roots.
    let mut raw = raw.clone();
    raw.as_object_mut()?.remove("captureMessageContent");
    if let Some(value) = raw.get("spanEnrichers").cloned() {
        let paths: Vec<_> = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if !value.is_null() && !value.is_array() {
            logger("ConfigLoader").warn("otlpTrace.spanEnrichers must be an array; ignoring", None);
        }
        raw["spanEnrichers"] = serde_json::json!(paths);
    }
    serde_json::from_value(raw).ok()
}

fn build_mask_config(file: Option<&Value>, sources: &ConfigSources<'_>) -> MaskConfig {
    let mask = file.and_then(|value| value.get("mask"));
    let raw_replacement = non_empty(env_get(sources, "LOONGSUITE_PILOT_MASK_REPLACEMENT_MODE"))
        .or_else(|| json_string(mask.and_then(|value| value.get("replacementMode"))));
    let replacement_mode = raw_replacement
        .as_deref()
        .and_then(|value| value.parse::<MaskReplacementMode>().ok())
        .unwrap_or(MaskReplacementMode::Placeholder);
    if raw_replacement.as_ref().is_some_and(|value| {
        !value.is_empty() && value.parse::<MaskReplacementMode>().ok() != Some(replacement_mode)
    }) {
        logger("ConfigLoader").warn(
            "invalid mask replacement mode, using placeholder",
            Some(&fields(
                serde_json::json!({ "replacementMode": raw_replacement }),
            )),
        );
    }
    let mode = env_get(sources, "LOONGSUITE_PILOT_MASK_MODE")
        .or_else(|| json_string(mask.and_then(|value| value.get("mode"))));
    let parsed_mode = mode
        .as_deref()
        .and_then(|value| value.parse::<MaskMode>().ok());
    let Some(parsed_mode) = parsed_mode else {
        return MaskConfig {
            mode: MaskMode::None,
            types: Vec::new(),
            replacement_mode: Some(replacement_mode),
        };
    };
    if parsed_mode != MaskMode::Custom {
        return MaskConfig {
            mode: parsed_mode,
            types: Vec::new(),
            replacement_mode: Some(replacement_mode),
        };
    }
    let types = parse_mask_types(
        env_get(sources, "LOONGSUITE_PILOT_MASK_TYPES")
            .map(Value::String)
            .or_else(|| mask.and_then(|value| value.get("types")).cloned()),
    );
    MaskConfig {
        mode: MaskMode::Custom,
        types,
        replacement_mode: Some(replacement_mode),
    }
}

fn parse_mask_types(value: Option<Value>) -> Vec<MaskType> {
    let raw = match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect::<Vec<_>>(),
        Some(Value::String(text)) => text.split(',').map(str::to_string).collect(),
        _ => Vec::new(),
    };
    raw.into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| SUPPORTED_MASK_TYPES.contains(&item.as_str()))
        .filter_map(|item| item.parse().ok())
        .collect()
}

fn build_agents(file: Option<&Value>, inner: Option<&Value>) -> AgentsConfig {
    let mut policies: HashMap<String, Value> = HashMap::new();
    for (source, managed) in [
        (inner.and_then(|value| value.get("agents")), true),
        (file.and_then(|value| value.get("agents")), false),
    ] {
        let Some(source) = source else { continue };
        let source_name = if managed { "inner" } else { "user" };
        let Some(object) = source.as_object() else {
            logger("ConfigLoader").warn(
                "Ignoring invalid agents config; expected an object",
                Some(&fields(
                    serde_json::json!({ "source": source_name, "type": json_type_name(source) }),
                )),
            );
            continue;
        };
        for (agent_type, policy) in object {
            if agent_type.is_empty() || !policy.is_object() {
                logger("ConfigLoader").warn("Ignoring invalid agent policy; expected an object", Some(&fields(serde_json::json!({ "source": source_name, "agentType": agent_type, "type": json_type_name(policy) }))));
                continue;
            }
            let multimodal = policy.get("multimodal");
            if managed {
                let ignored: Vec<&String> = policy
                    .as_object()
                    .map(|map| {
                        map.keys()
                            .filter(|key| key.as_str() != "multimodal")
                            .collect()
                    })
                    .unwrap_or_default();
                if !multimodal.is_some_and(Value::is_object) {
                    logger("ConfigLoader").warn(
                        "Ignoring managed agent policy without valid multimodal settings",
                        Some(&fields(serde_json::json!({ "agentType": agent_type, "type": multimodal.map(json_type_name).unwrap_or("undefined"), "ignoredFields": ignored.iter().map(|key| key.as_str()).collect::<Vec<_>>() }))),
                    );
                    continue;
                }
                if !ignored.is_empty() {
                    logger("ConfigLoader").warn("Ignoring unsupported managed agent fields", Some(&fields(serde_json::json!({ "agentType": agent_type, "ignoredFields": ignored.iter().map(|key| key.as_str()).collect::<Vec<_>>() }))));
                }
            }
            let accepted = if managed {
                serde_json::json!({ "multimodal": multimodal.cloned().unwrap_or(Value::Null) })
            } else {
                policy.clone()
            };
            let previous = policies.get(agent_type).cloned();
            let mut merged = previous
                .clone()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            if let Some(object) = accepted.as_object() {
                for (key, value) in object {
                    if key != "captureMessageContent" {
                        merged.insert(key.clone(), value.clone());
                    }
                }
            }
            if multimodal.is_some_and(Value::is_object) {
                let mut multimodal_merged = previous
                    .as_ref()
                    .and_then(|value| value.get("multimodal"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(object) = multimodal.and_then(Value::as_object) {
                    for (key, value) in object {
                        multimodal_merged.insert(key.clone(), value.clone());
                    }
                }
                merged.insert("multimodal".into(), Value::Object(multimodal_merged));
            }
            policies.insert(agent_type.clone(), Value::Object(merged));
        }
    }
    let mut result = AgentsConfig::new();
    for (agent_type, policy) in policies {
        let multimodal = build_agent_multimodal(&agent_type, policy.get("multimodal"));
        result.insert(
            agent_type,
            AgentConfig {
                enabled: json_bool(policy.get("enabled")),
                capture_message_content: None,
                multimodal,
            },
        );
    }
    result
}

fn build_agent_multimodal(
    agent_type: &str,
    block: Option<&Value>,
) -> Option<AgentMultimodalConfig> {
    let block = block?;
    if !block.is_object() {
        logger("ConfigLoader").warn(
            "Ignoring invalid agent multimodal config; expected an object",
            Some(&fields(
                serde_json::json!({ "agentType": agent_type, "type": json_type_name(block) }),
            )),
        );
        return None;
    }
    let upload_raw = json_str(block.get("uploadMode")).unwrap_or("none");
    let upload_mode = if MULTIMODAL_UPLOAD_MODES.contains(&upload_raw) {
        upload_raw.parse().unwrap_or(MultimodalUploadMode::None)
    } else {
        MultimodalUploadMode::None
    };
    if upload_raw != upload_mode.as_str() {
        logger("ConfigLoader").warn("Invalid agent multimodal uploadMode; using none", Some(&fields(serde_json::json!({ "agentType": agent_type, "type": json_type_name(block.get("uploadMode").unwrap_or(&Value::Null)) }))));
    }
    if upload_mode == MultimodalUploadMode::None {
        return Some(AgentMultimodalConfig {
            upload_mode,
            allowed_root_paths: None,
        });
    }
    let allowed = block
        .get("allowedRootPaths")
        .and_then(Value::as_array)
        .map(|items| {
            let mut paths = Vec::new();
            for item in items.iter().filter_map(Value::as_str) {
                let resolved = resolve_home(item.trim());
                if !resolved.is_empty() && !paths.contains(&resolved) {
                    paths.push(resolved);
                }
            }
            paths
        });
    Some(AgentMultimodalConfig {
        upload_mode,
        allowed_root_paths: allowed.filter(|paths| !paths.is_empty()),
    })
}

fn build_multimodal(
    file: Option<&Value>,
    inner: Option<&Value>,
) -> Option<MultimodalRuntimeConfig> {
    let block = if file.and_then(|value| value.get("multimodal")).is_some() {
        file.and_then(|value| value.get("multimodal"))
    } else {
        inner.and_then(|value| value.get("multimodal"))
    };
    match build_multimodal_block(block, file) {
        Ok(config) => config,
        Err(err) => {
            logger("ConfigLoader").error(
                "multimodal config invalid; disabled for process",
                Some(&fields(serde_json::json!({ "error": err }))),
            );
            None
        }
    }
}

fn build_multimodal_block(
    block: Option<&Value>,
    file: Option<&Value>,
) -> Result<Option<MultimodalRuntimeConfig>, String> {
    let Some(block) = block else { return Ok(None) };
    if !block.is_object() {
        return Err("multimodal must be an object".into());
    }
    let storage = block
        .get("storage")
        .ok_or("multimodal.storage is required")?;
    if !storage.is_object() {
        return Err("multimodal.storage must be an object".into());
    }
    let kind = json_str(storage.get("type"))
        .unwrap_or("")
        .trim()
        .to_string();
    if kind == "oss" {
        let storage = build_oss_storage(storage)?;
        let storage_base_path = match &storage {
            MultimodalStorage::Oss { target, .. } => target.storage_base_path.clone(),
            _ => String::new(),
        };
        return Ok(Some(MultimodalRuntimeConfig {
            storage,
            storage_base_path,
        }));
    }
    if kind == "sls" || kind == "delegatedOss" {
        let storage = build_sls_backed_storage(&kind, storage, file)?;
        let storage_base_path = match &storage {
            MultimodalStorage::Sls { target, .. }
            | MultimodalStorage::DelegatedOss { target, .. } => {
                format!("sls://{}/{}", target.project, target.logstore)
            }
            MultimodalStorage::Oss { .. } => String::new(),
        };
        return Ok(Some(MultimodalRuntimeConfig {
            storage,
            storage_base_path,
        }));
    }
    Err(format!(
        "invalid multimodal.storage.type: {}",
        if kind.is_empty() { "(missing)" } else { &kind }
    ))
}

fn build_oss_storage(raw: &Value) -> Result<MultimodalStorage, String> {
    let endpoint = json_str(raw.pointer("/target/endpoint"))
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let storage_base_path = json_str(raw.pointer("/target/storageBasePath"))
        .unwrap_or("")
        .trim()
        .to_string();
    if endpoint.is_empty() {
        return Err("multimodal.storage.target.endpoint is required when type=oss".into());
    }
    if storage_base_path.is_empty() {
        return Err("multimodal.storage.target.storageBasePath is required when type=oss".into());
    }
    if !storage_base_path.starts_with("oss://") {
        return Err(
            "multimodal.storage.target.storageBasePath must start with oss:// when type=oss".into(),
        );
    }
    let auth = build_storage_auth(raw.get("auth"))?;
    let MultimodalStorageAuth::Ak(auth) = auth else {
        return Err(if matches!(auth, MultimodalStorageAuth::Anonymous) {
            "multimodal.storage.auth.mode=anonymous is only supported when type=sls".into()
        } else {
            "multimodal.storage.type=oss requires auth.mode=ak".into()
        });
    };
    Ok(MultimodalStorage::Oss {
        target: MultimodalOssTarget {
            endpoint,
            storage_base_path: storage_base_path.trim_end_matches('/').to_string(),
        },
        auth,
    })
}

fn build_sls_backed_storage(
    kind: &str,
    raw: &Value,
    file: Option<&Value>,
) -> Result<MultimodalStorage, String> {
    let endpoint_raw = json_str(raw.pointer("/target/endpoint"))
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let logstore = json_str(raw.pointer("/target/logstore"))
        .unwrap_or("")
        .trim()
        .to_string();
    if endpoint_raw.is_empty() || logstore.is_empty() {
        return Err(format!(
            "multimodal.storage.target requires endpoint and logstore when type={kind}"
        ));
    }
    let project = resolve_multimodal_project(raw.get("target").unwrap_or(&Value::Null))?;
    let endpoint = regionalize_sls_endpoint(&endpoint_raw, &project)?;
    let reused = if raw.get("auth").is_none() {
        find_reused_api_key(&endpoint, &project, &logstore, file)
    } else {
        None
    };
    let auth = build_storage_auth(raw.get("auth").or(reused.as_ref()))?;
    let target = MultimodalSlsTarget {
        endpoint,
        project,
        logstore,
    };
    if kind == "delegatedOss" {
        let auth = match auth {
            MultimodalStorageAuth::Anonymous => {
                return Err(
                    "multimodal.storage.auth.mode=anonymous is only supported when type=sls".into(),
                )
            }
            MultimodalStorageAuth::Ak(auth) => MultimodalCredentialAuth::Ak(auth),
            MultimodalStorageAuth::ApiKey(auth) => MultimodalCredentialAuth::ApiKey(auth),
        };
        return Ok(MultimodalStorage::DelegatedOss { target, auth });
    }
    Ok(MultimodalStorage::Sls { target, auth })
}

fn find_reused_api_key(
    endpoint: &str,
    project: &str,
    logstore: &str,
    file: Option<&Value>,
) -> Option<Value> {
    let dest = multimodal_dest_key(endpoint, project, logstore)?;
    let raw = file.and_then(|value| value.get("sls"))?;
    let entries = if let Some(items) = raw.as_array() {
        items.clone()
    } else {
        vec![raw.clone()]
    };
    let mut api_key = None;
    for entry in entries {
        if infer_sls_mode(
            json_str(entry.get("mode")).and_then(|value| value.parse().ok()),
            json_str(entry.get("accessKeyId")),
            json_str(entry.get("accessKeySecret")),
            json_str(entry.get("apiKey")),
        ) != SlsMode::ApiKey
        {
            continue;
        }
        if present(json_str(entry.get("apiKey")))
            && (present(json_str(entry.get("accessKeyId")))
                || present(json_str(entry.get("accessKeySecret"))))
        {
            continue;
        }
        let (Some(candidate), Some(ep), Some(proj), Some(store)) = (
            json_str(entry.get("apiKey"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            json_str(entry.get("endpoint"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            json_str(entry.get("project"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            json_str(entry.get("logstore"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        ) else {
            continue;
        };
        if multimodal_dest_key(&ep, &proj, &store).as_deref() != Some(dest.as_str()) {
            continue;
        }
        if api_key
            .as_deref()
            .is_some_and(|current| current != candidate)
        {
            return None;
        }
        api_key = Some(candidate);
    }
    api_key.map(|api_key| serde_json::json!({ "mode": "apiKey", "apiKey": api_key }))
}

fn multimodal_dest_key(endpoint: &str, project: &str, logstore: &str) -> Option<String> {
    Some(format!(
        "{}|{project}|{logstore}",
        normalize_endpoint_url(&regionalize_sls_endpoint(endpoint, project).ok()?)
    ))
}

fn resolve_multimodal_project(target: &Value) -> Result<String, String> {
    let explicit = if target
        .as_object()
        .is_some_and(|map| map.contains_key("project"))
    {
        let text = json_str(target.get("project")).map(str::trim).unwrap_or("");
        if text.is_empty() {
            return Err("multimodal.storage.target.project is invalid".into());
        }
        Some(text.to_string())
    } else {
        None
    };
    let from_host = project_from_qualified_sls_host(json_str(target.get("endpoint")));
    if explicit.as_ref().is_some()
        && from_host.as_ref().is_some()
        && explicit.as_deref() != from_host.as_deref()
    {
        return Err(
            "multimodal.storage.target.project conflicts with project-qualified endpoint".into(),
        );
    }
    explicit
        .or(from_host)
        .ok_or_else(|| "multimodal.storage.target.project is required".into())
}

fn regionalize_sls_endpoint(endpoint: &str, project: &str) -> Result<String, String> {
    let Some(url) = parse_http_url(&normalize_endpoint_url(endpoint)) else {
        return Ok(endpoint.to_string());
    };
    let host = url.host.trim_end_matches('.').to_string();
    if !host.ends_with(SLS_PUBLIC_HOST_SUFFIX) {
        return Ok(endpoint.to_string());
    }
    let rest = &host[..host.len() - SLS_PUBLIC_HOST_SUFFIX.len()];
    let parts: Vec<&str> = rest.split('.').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Ok(endpoint.to_string());
    }
    if parts[0] != project {
        return Err(
            "multimodal.storage.target.project conflicts with project-qualified endpoint".into(),
        );
    }
    let regional = format!("{}{SLS_PUBLIC_HOST_SUFFIX}", parts[1..].join("."));
    let port = if url.port.is_empty() {
        String::new()
    } else {
        format!(":{}", url.port)
    };
    Ok(format!("{}//{regional}{port}", url.protocol))
}

fn project_from_qualified_sls_host(endpoint: Option<&str>) -> Option<String> {
    let endpoint = endpoint.filter(|value| !value.trim().is_empty())?;
    let url = parse_http_url(&normalize_endpoint_url(endpoint))?;
    let host = url.host.trim_end_matches('.').to_string();
    if !host.ends_with(SLS_PUBLIC_HOST_SUFFIX) {
        return None;
    }
    let rest = &host[..host.len() - SLS_PUBLIC_HOST_SUFFIX.len()];
    let parts: Vec<&str> = rest.split('.').filter(|part| !part.is_empty()).collect();
    if parts.len() >= 2 {
        Some(parts[0].to_string())
    } else {
        None
    }
}

fn build_storage_auth(raw: Option<&Value>) -> Result<MultimodalStorageAuth, String> {
    let access_key_id = json_str(raw.and_then(|value| value.get("accessKeyId")))
        .unwrap_or("")
        .trim()
        .to_string();
    let access_key_secret = json_str(raw.and_then(|value| value.get("accessKeySecret")))
        .unwrap_or("")
        .trim()
        .to_string();
    let security_token = json_str(raw.and_then(|value| value.get("securityToken")))
        .unwrap_or("")
        .trim()
        .to_string();
    let api_key = json_str(raw.and_then(|value| value.get("apiKey")))
        .unwrap_or("")
        .trim()
        .to_string();
    let has_ak = !access_key_id.is_empty() && !access_key_secret.is_empty();
    let has_api_key = !api_key.is_empty();
    if has_api_key
        && (!access_key_id.is_empty()
            || !access_key_secret.is_empty()
            || !security_token.is_empty())
    {
        return Err("multimodal.storage.auth cannot include both apiKey and access keys".into());
    }
    let mode = resolve_storage_auth_mode(
        json_str(raw.and_then(|value| value.get("mode"))),
        has_ak,
        has_api_key,
    )?;
    match mode {
        MultimodalSlsAuthMode::Anonymous => {
            if !access_key_id.is_empty()
                || !access_key_secret.is_empty()
                || !security_token.is_empty()
                || !api_key.is_empty()
            {
                return Err(
                    "multimodal.storage.auth.mode=anonymous cannot include credentials".into(),
                );
            }
            Ok(MultimodalStorageAuth::Anonymous)
        }
        MultimodalSlsAuthMode::ApiKey => {
            if api_key.is_empty() {
                return Err("multimodal.storage.auth requires apiKey when mode=apiKey".into());
            }
            Ok(MultimodalStorageAuth::ApiKey(MultimodalApiKeyAuth {
                api_key,
            }))
        }
        MultimodalSlsAuthMode::Ak => {
            if !has_ak {
                return Err(
                    "multimodal.storage.auth requires accessKeyId and accessKeySecret when mode=ak"
                        .into(),
                );
            }
            Ok(MultimodalStorageAuth::Ak(MultimodalAkAuth {
                access_key_id,
                access_key_secret,
                security_token: if security_token.is_empty() {
                    None
                } else {
                    Some(security_token)
                },
            }))
        }
    }
}

fn resolve_storage_auth_mode(
    raw: Option<&str>,
    has_ak: bool,
    has_api_key: bool,
) -> Result<MultimodalSlsAuthMode, String> {
    let mode = raw.unwrap_or("").trim();
    if !mode.is_empty() {
        if MULTIMODAL_SLS_AUTH_MODES.contains(&mode) {
            return mode.parse().map_err(|err: String| err);
        }
        return Err(format!("unsupported multimodal.storage.auth.mode: {mode}"));
    }
    if has_api_key == has_ak {
        return Err("multimodal.storage.auth requires exactly one complete credential set when mode is omitted".into());
    }
    Ok(if has_api_key {
        MultimodalSlsAuthMode::ApiKey
    } else {
        MultimodalSlsAuthMode::Ak
    })
}

fn resolve_global_span_attributes(
    file: Option<&Value>,
    sources: &ConfigSources<'_>,
) -> HashMap<String, String> {
    let mut merged = Map::new();
    if let Some(object) = file
        .and_then(|value| value.get("globalSpanAttributes"))
        .and_then(Value::as_object)
    {
        for (key, value) in object {
            merged.insert(key.clone(), value.clone());
        }
    }
    let from_env = parse_key_value_attributes(env_get(sources, "OTEL_SPAN_ATTRIBUTES").as_deref());
    for key in from_env.keys() {
        if let Some(value) = from_env.get(&key) {
            merged.insert(key, Value::String(value.to_string()));
        }
    }
    let sanitized = sanitize_attributes(&merged);
    let mut out = HashMap::new();
    for key in sanitized.keys() {
        if let Some(value) = sanitized.get(&key) {
            out.insert(key, value.to_string());
        }
    }
    out
}

fn warn_ignored_capture(file: &Value) {
    let mut locations = Vec::new();
    if file
        .get("otlpTrace")
        .and_then(Value::as_object)
        .is_some_and(|map| map.contains_key("captureMessageContent"))
    {
        locations.push("otlpTrace.captureMessageContent".to_string());
    }
    if let Some(agents) = file.get("agents").and_then(Value::as_object) {
        for (agent, policy) in agents {
            if policy
                .as_object()
                .is_some_and(|map| map.contains_key("captureMessageContent"))
            {
                locations.push(format!("agents.{agent}.captureMessageContent"));
            }
        }
    }
    if !locations.is_empty() {
        logger("ConfigLoader").warn(
            "captureMessageContent is deprecated and ignored; message content capture is always enabled",
            Some(&fields(serde_json::json!({ "locations": locations }))),
        );
    }
}

fn decode_vec<T: for<'de> Deserialize<'de>>(value: Option<&Value>) -> Option<Vec<T>> {
    value.and_then(|value| serde_json::from_value(value.clone()).ok())
}

struct HttpUrl {
    protocol: String,
    host: String,
    port: String,
}

fn parse_http_url(raw: &str) -> Option<HttpUrl> {
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let (scheme, rest) = with_scheme.split_once("://")?;
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (host, port) = if let Some((host, port)) = hostport.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            (host.to_string(), port.to_string())
        } else {
            (hostport.to_string(), String::new())
        }
    } else {
        (hostport.to_string(), String::new())
    };
    Some(HttpUrl {
        protocol: format!("{scheme}:"),
        host,
        port,
    })
}

fn env_get(sources: &ConfigSources<'_>, key: &str) -> Option<String> {
    let value = sources.env.get(key)?.clone();
    if sources.platform == Platform::Win32 {
        Some(value.trim().to_string())
    } else {
        Some(value)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn env_bool(sources: &ConfigSources<'_>, key: &str, fallback: bool) -> bool {
    match env_get(sources, key) {
        None => fallback,
        Some(value) if value.trim().is_empty() => fallback,
        Some(value) => value != "false" && value != "0",
    }
}

fn env_int(sources: &ConfigSources<'_>, key: &str, fallback: u64) -> u64 {
    let Some(value) = env_get(sources, key) else {
        return fallback;
    };
    js_u64(&value).unwrap_or(fallback)
}

fn js_u64(value: &str) -> Option<u64> {
    let number: f64 = value.trim().parse().ok()?;
    if number.is_finite() && number >= 0.0 && number <= u64::MAX as f64 {
        Some(number as u64)
    } else {
        None
    }
}

fn json_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn json_string(value: Option<&Value>) -> Option<String> {
    json_str(value).map(str::to_string)
}

fn json_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value.as_u64().or_else(|| {
            value.as_f64().and_then(|number| {
                if number.is_finite() && number >= 0.0 {
                    Some(number as u64)
                } else {
                    None
                }
            })
        })
    })
}

fn json_usize(value: Option<&Value>) -> Option<usize> {
    json_u64(value).and_then(|value| usize::try_from(value).ok())
}

fn present(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "array",
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Object(_) => "object",
    }
}

fn hostname_string() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".into())
}

#[allow(dead_code)]
fn _auto_update_type(config: AutoUpdateConfig) -> AutoUpdateConfig {
    config
}
#[allow(dead_code)]
fn _cms_endpoint_type(entry: CmsEndpointEntry) -> CmsEndpointEntry {
    entry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SlsMode;

    fn sources<'a>(env: &'a HashMap<String, String>) -> ConfigSources<'a> {
        ConfigSources {
            env,
            platform: Platform::Posix,
            hostname: "host",
            config_path: "/tmp/config.json",
            global_poll_ms: None,
        }
    }

    fn empty() -> HashMap<String, String> {
        HashMap::new()
    }

    fn sls(config: &AnalyticsConfig) -> SlsFlusherConfig {
        config.flushers.sls.clone().unwrap()
    }

    #[tokio::test]
    async fn reads_inner_config_from_canonical_data_dir() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let data = root.join("预检 HOME 🚀").join("data");
        let path = inner_config_path(data.to_str().unwrap());
        assert!(read_checked_config(&path, false).await.unwrap().is_none());
        assert!(!data.exists(), "只读预检不能创建数据目录");
        assert!(read_checked_config(&path, true).await.is_err());
        let expected = data.join("configs").join("inner").join("data_config.json");
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        let valid = br#"{"otlp":[]}"#;
        std::fs::write(&expected, valid).unwrap();
        assert_eq!(
            read_checked_config(&path, false).await.unwrap(),
            Some(serde_json::json!({"otlp":[]}))
        );
        assert_eq!(std::fs::read(&expected).unwrap(), valid);
        for invalid in ["{broken", "[]"] {
            std::fs::write(&expected, invalid).unwrap();
            assert!(read_checked_config(&path, false).await.is_err());
            assert_eq!(std::fs::read_to_string(&expected).unwrap(), invalid);
        }
    }

    #[test]
    fn legacy_enrichers_remain_optional_and_never_disable_trace_or_mutate_config() {
        let valid_path = std::env::current_dir()
            .unwrap()
            .join("synthetic-skill.mjs")
            .to_string_lossy()
            .into_owned();
        for value in [
            serde_json::json!([valid_path, 42, "bad.ts"]),
            serde_json::json!("old.mjs"),
            serde_json::json!(null),
            serde_json::json!([]),
        ] {
            let file = serde_json::json!({
                "collectTrace":true,
                "otlpTrace":{"endpoint":"http://127.0.0.1:4318","spanEnrichers":value}
            });
            let before = file.clone();
            let config = assemble_config(Some(&file), None, &sources(&empty())).unwrap();
            let trace = build_otlp_trace_config(&config).unwrap();
            assert_eq!(trace.endpoints.len(), 1);
            let expected = if value.is_array() && !value.as_array().unwrap().is_empty() {
                vec![valid_path.clone()]
            } else {
                Vec::new()
            };
            assert_eq!(trace.span_enricher_paths.unwrap(), expected);
            assert_eq!(file, before);
        }
    }

    #[test]
    fn missing_sls_destination_disables_the_flusher() {
        let config = assemble_config(None, None, &sources(&empty())).unwrap();
        assert!(config.enabled);
        assert!(sls(&config).endpoints.is_empty());
        assert!(!sls(&config).enabled);
        let partial = assemble_config(
            Some(&serde_json::json!({ "sls": { "project": "only" } })),
            None,
            &sources(&empty()),
        )
        .unwrap();
        assert!(!sls(&partial).enabled);
    }

    #[test]
    fn user_destination_infers_mode_and_env_wins() {
        let file = serde_json::json!({ "sls": { "endpoint": "cn-hangzhou.log.aliyuncs.com", "project": "p", "logstore": "l", "accessKeyId": "id", "accessKeySecret": "secret" } });
        let config = assemble_config(Some(&file), None, &sources(&empty())).unwrap();
        let endpoint = &sls(&config).endpoints[0];
        assert_eq!(endpoint.name, "user-sls");
        assert_eq!(endpoint.mode, SlsMode::Ak);
        assert_eq!(endpoint.endpoint, "https://cn-hangzhou.log.aliyuncs.com");
        assert!(sls(&config).enabled);
        let mut env = empty();
        env.insert("LOONGSUITE_SLS_PROJECT".into(), "env-p".into());
        env.insert("LOONGSUITE_SLS_LOGSTORE".into(), "env-l".into());
        let overridden = assemble_config(Some(&file), None, &sources(&env)).unwrap();
        assert_eq!(sls(&overridden).endpoints[0].project, "env-p");
    }

    #[test]
    fn api_key_ambiguous_credentials_and_explicit_enabled_flags() {
        let api = assemble_config(
            Some(&serde_json::json!({ "sls": { "project": "p", "logstore": "l", "apiKey": "k" } })),
            None,
            &sources(&empty()),
        )
        .unwrap();
        assert_eq!(sls(&api).endpoints[0].mode, SlsMode::ApiKey);
        assert!(!sls(&api).enabled);
        let mixed = assemble_config(Some(&serde_json::json!({ "sls": { "project": "p", "logstore": "l", "endpoint": "https://example.com", "apiKey": "k", "accessKeyId": "id" } })), None, &sources(&empty())).unwrap();
        assert!(!sls(&mixed).enabled);
        let forced = assemble_config(
            Some(&serde_json::json!({ "sls": { "enabled": true } })),
            None,
            &sources(&empty()),
        )
        .unwrap();
        assert!(sls(&forced).enabled);
        let off = assemble_config(Some(&serde_json::json!({ "sls": { "enabled": false, "project": "p", "logstore": "l" } })), None, &sources(&empty())).unwrap();
        assert!(!sls(&off).enabled);
    }

    #[test]
    fn sls_array_dedup_and_inner_merge() {
        let file = serde_json::json!({ "sls": [
            { "endpoint": "HTTPS://Example.com/", "project": "p", "logstore": "l" },
            { "endpoint": "https://example.com", "project": "p", "logstore": "l", "mode": "ak", "accessKeyId": "a", "accessKeySecret": "b" },
            { "project": "other", "logstore": "events", "mode": "webtracking" }
        ] });
        let inner = serde_json::json!({ "sls": [ { "endpoint": "https://example.com", "project": "p", "logstore": "l" }, { "logstore": "missing-endpoint" }, { "name": "inner", "endpoint": "https://inner.example", "project": "ip", "logstore": "il" } ], "serviceNamePrefix": "managed" });
        let config = assemble_config(Some(&file), Some(&inner), &sources(&empty())).unwrap();
        let endpoints = sls(&config).endpoints;
        let described: Vec<String> = endpoints
            .iter()
            .map(|endpoint| {
                format!(
                    "{}|{}|{}|{}|{}",
                    endpoint.name,
                    endpoint.endpoint,
                    endpoint.project,
                    endpoint.logstore,
                    endpoint.service_name.as_deref().unwrap_or("")
                )
            })
            .collect();
        assert_eq!(endpoints.len(), 3, "{described:?}");
        assert_eq!(endpoints[0].name, "sls-0");
        assert_eq!(endpoints[0].mode, SlsMode::Webtracking);
        assert!(endpoints.iter().any(|endpoint| endpoint.name == "inner"
            && endpoint.service_name.as_deref() == Some("managed")));
        assert!(sls(&config).enabled);
    }

    #[test]
    fn webtracking_allows_an_empty_project() {
        let file = serde_json::json!({ "sls": [ { "endpoint": "https://example.com", "project": "", "logstore": "l", "mode": "webtracking" } ] });
        let config = assemble_config(Some(&file), None, &sources(&empty())).unwrap();
        assert!(sls(&config).enabled);
    }

    #[test]
    fn mask_retention_pipeline_and_upstream_follow_env() {
        let mut env = empty();
        env.insert("LOONGSUITE_PILOT_MASK_MODE".into(), "custom".into());
        env.insert(
            "LOONGSUITE_PILOT_MASK_TYPES".into(),
            "email,not-a-type".into(),
        );
        env.insert("LOONGSUITE_PILOT_LOG_RETENTION_DAYS".into(), "3".into());
        env.insert("LOONGSUITE_PILOT_PIPELINE_ENABLED".into(), "true".into());
        env.insert("LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS".into(), "0".into());
        env.insert("LOONGSUITE_PILOT_ENABLED".into(), "false".into());
        let config = assemble_config(None, None, &sources(&env)).unwrap();
        assert!(!config.enabled);
        assert_eq!(config.mask.mode, MaskMode::Custom);
        assert_eq!(config.mask.types, vec![MaskType::Email]);
        assert_eq!(config.retention.output_days, 3);
        assert!(config.pipeline.enabled);
        assert_eq!(config.upstream_link.ttl_ms, DEFAULT_UPSTREAM_TTL_MS);
    }

    #[test]
    fn legacy_codex_listener_and_dashboard_port() {
        let file = serde_json::json!({
            "listeners": { "codex-log": { "enabled": false, "pollInterval": 1500 } },
            "dashboard": { "port": 9000 },
            "enableStatusBarApp": "false"
        });
        let config = assemble_config(Some(&file), None, &sources(&empty())).unwrap();
        assert!(!config.listeners.get("codex-transcript").unwrap().enabled);
        assert_eq!(
            config
                .listeners
                .get("codex-transcript")
                .unwrap()
                .poll_interval,
            1500
        );
        assert_eq!(config.dashboard.port, 9000);
        assert!(!config.status_bar.enabled);
    }

    #[test]
    fn invalid_multimodal_disables_the_feature() {
        let file = serde_json::json!({ "multimodal": { "storage": { "type": "sls" } } });
        let config = assemble_config(Some(&file), None, &sources(&empty())).unwrap();
        assert!(config.multimodal.is_none());
    }

    #[test]
    fn otlp_union_dedups_user_and_cms() {
        let mut config = assemble_config(Some(&serde_json::json!({
            "collectTrace": true,
            "cms": { "licenseKey": "lk", "endpoint": "https://proj.cn-hangzhou.log.aliyuncs.com", "workspace": "ws" },
            "otlpTrace": { "endpoint": "https://otlp.example/v1/traces" }
        })), None, &sources(&empty())).unwrap();
        config.inner_trace = Some(InnerTraceConfig {
            otlp: Some(vec![crate::types::OtlpEndpointEntry {
                name: Some("managed".into()),
                endpoint: "https://otlp.example/v1/traces".into(),
                headers: None,
                compression: None,
            }]),
            cms: None,
            service_name_prefix: Some("managed-prefix".into()),
        });
        let built = build_otlp_trace_config_with(&config, &empty(), Platform::Posix).unwrap();
        assert!(built.enabled);
        assert!(built
            .endpoints
            .iter()
            .any(|endpoint| endpoint.name == "user-otlp"));
        assert!(built
            .endpoints
            .iter()
            .any(|endpoint| endpoint.name == "user-cms"));
        assert!(built
            .endpoints
            .iter()
            .any(|endpoint| endpoint.name == "managed"));
        assert_eq!(
            built
                .resource_attributes
                .unwrap()
                .get("acs.arms.service.feature")
                .map(String::as_str),
            Some("genai_app")
        );
    }
}

#[cfg(test)]
mod privacy_migration_contract_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn malformed_workspace_privacy_config_is_rejected_instead_of_disabling_exclusions() {
        let env = HashMap::new();
        let sources = ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: "not-read.json",
            global_poll_ms: None,
        };
        for invalid in [
            json!(null),
            json!("private"),
            json!([null]),
            json!([12]),
            json!(true),
            json!({"path":"private"}),
            json!(["relative"]),
        ] {
            let file = json!({"privacy":{"excludeWorkspaces":invalid}});
            assert!(
                assemble_config(Some(&file), None, &sources).is_err(),
                "malformed exclusion list silently disabled filtering"
            );
        }
        for file in [
            json!({}),
            json!({"privacy":{}}),
            json!({"privacy":{"excludeWorkspaces":[]}}),
        ] {
            assert!(assemble_config(Some(&file), None, &sources)
                .unwrap()
                .privacy
                .unwrap()
                .exclude_workspaces
                .is_empty());
        }
    }
}

#[cfg(test)]
mod migration_sls_resolution_tests {
    use super::*;
    use serde_json::{json, Value};
    fn assert_subset(actual: &Value, expected: &Value, id: &str, path: &str) {
        match expected {
            Value::Object(fields) => {
                for (key, value) in fields {
                    assert_subset(&actual[key], value, id, &format!("{path}.{key}"));
                }
            }
            Value::Array(items) => {
                let actual = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("{id}: {path} must be an array"));
                assert_eq!(actual.len(), items.len(), "{id}: {path} endpoint count");
                for (index, (actual, expected)) in actual.iter().zip(items).enumerate() {
                    assert_subset(actual, expected, id, &format!("{path}[{index}]"));
                }
            }
            _ => assert_eq!(actual, expected, "{id}: {path}"),
        }
    }
    fn run(group: &str) {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/config-sls-resolution-cases.json"
        ))
        .unwrap();
        let mut executed = 0;
        for case in cases
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["group"] == group)
        {
            executed += 1;
            let id = case["id"].as_str().unwrap();
            let env: HashMap<String, String> = serde_json::from_value(case["env"].clone()).unwrap();
            let sources = ConfigSources {
                env: &env,
                platform: Platform::current(),
                hostname: "synthetic",
                config_path: "not-read.json",
                global_poll_ms: None,
            };
            let file = case["user"].clone();
            let inner = case["inner"].clone();
            let before = json!([file.clone(), inner.clone()]);
            let config = assemble_config(
                (!file.is_null()).then_some(&file),
                (!inner.is_null()).then_some(&inner),
                &sources,
            )
            .unwrap();
            let actual = serde_json::to_value(config.flushers.sls.as_ref().unwrap()).unwrap();
            assert_subset(&actual, &case["expected"], id, "sls");
            if let Some(expected) = case.get("multimodal") {
                assert_subset(
                    &serde_json::to_value(config.multimodal).unwrap(),
                    expected,
                    id,
                    "multimodal",
                );
            }
            assert_eq!(
                json!([file, inner]),
                before,
                "{id}: resolver mutated its input"
            );
        }
        assert!(executed > 0, "unknown SLS case group");
    }
    #[test]
    fn empty_and_incomplete_sls_destinations_stay_disabled() {
        run("empty");
    }
    #[test]
    fn user_sls_destinations_modes_credentials_and_legacy_controls_are_preserved() {
        run("user");
    }
    #[test]
    fn environment_destination_precedence_preserves_missing_endpoint_behavior() {
        run("env");
    }
    #[test]
    fn explicit_enabled_and_auth_completeness_keep_every_mode_boundary() {
        run("enabled");
    }
    #[test]
    fn arrays_keep_order_modes_names_and_every_endpoint() {
        run("array");
    }
    #[test]
    fn managed_union_dedup_prefers_user_and_discards_incomplete_inner_targets() {
        run("managed");
    }
}

#[cfg(test)]
mod migration_config_basics_tests {
    use super::*;
    use serde_json::Value;
    fn assert_subset(actual: &Value, expected: &Value, id: &str, path: &str) {
        match expected {
            Value::Object(fields) => {
                for (key, value) in fields {
                    assert_subset(&actual[key], value, id, &format!("{path}.{key}"));
                }
            }
            Value::Array(values) => {
                assert_eq!(actual, &Value::Array(values.clone()), "{id}: {path}")
            }
            _ => assert_eq!(actual, expected, "{id}: {path}"),
        }
    }
    fn run(group: &str) {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/config-basics-cases.json"
        ))
        .unwrap();
        let mut executed = 0;
        for case in cases
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["group"] == group)
        {
            executed += 1;
            let id = case["id"].as_str().unwrap();
            let env: HashMap<String, String> = serde_json::from_value(case["env"].clone()).unwrap();
            let sources = ConfigSources {
                env: &env,
                platform: Platform::current(),
                hostname: "synthetic",
                config_path: "not-read.json",
                global_poll_ms: case.get("globalPollMs").and_then(Value::as_u64),
            };
            let file = &case["user"];
            let config =
                assemble_config((!file.is_null()).then_some(file), None, &sources).unwrap();
            let actual = serde_json::to_value(&config).unwrap();
            assert_subset(&actual, &case["expected"], id, "config");
            if let Some(expected) = case.get("exactGlobal") {
                assert_eq!(
                    &actual["globalSpanAttributes"], expected,
                    "{id}: exact global attribute keys"
                );
            }
            if let Some(interval) = case.get("allPoll").and_then(Value::as_u64) {
                assert!(
                    config
                        .listeners
                        .values()
                        .all(|listener| listener.poll_interval == interval),
                    "{id}: not every listener uses unified interval"
                );
            }
        }
        assert!(executed > 0);
    }
    #[test]
    fn file_environment_and_default_priority_keep_user_identity() {
        run("priority");
    }
    #[test]
    fn output_destination_and_batch_controls_keep_their_environment_contract() {
        run("outputs");
    }
    #[test]
    fn listener_defaults_legacy_codex_and_poll_interval_validation_are_preserved() {
        run("listeners");
    }
    #[test]
    fn retention_defaults_per_field_precedence_and_environment_controls_are_preserved() {
        run("retention");
    }
    #[test]
    fn watchdog_defaults_and_environment_controls_are_preserved() {
        run("watchdog");
    }
    #[test]
    fn mask_modes_types_and_replacement_policy_keep_exact_legacy_contracts() {
        run("mask");
    }
    #[test]
    fn file_collection_legacy_gate_still_resolves_environment_overrides() {
        run("pipeline");
    }
    #[test]
    fn collection_cms_and_service_names_keep_default_file_environment_priority() {
        run("trace");
    }
    #[test]
    fn global_attributes_keep_reserved_key_filtering_numeric_values_and_env_priority() {
        run("attributes");
    }
    #[test]
    fn upstream_flags_and_ttl_safety_keep_file_and_environment_contracts() {
        run("upstream");
    }
}

#[cfg(test)]
mod migration_managed_multimodal_tests {
    use super::*;
    use serde_json::Value;
    fn subset(actual: &Value, expected: &Value, id: &str) {
        if let Value::Object(fields) = expected {
            for (key, value) in fields {
                subset(&actual[key], value, id);
            }
        } else {
            assert_eq!(actual, expected, "{id}");
        }
    }
    async fn run(group: &str) {
        // File logging is process-global. Run this exact test in its own child.
        if !crate::utils::isolated_env_test() {
            return;
        }
        unsafe {
            std::env::set_var("LOG_LEVEL", "trace");
        }
        let directory = tempfile::tempdir().unwrap();
        let logdir = directory.path().join("logs");
        crate::utils::init_file_logging(logdir.join("config.log").to_str().unwrap())
            .await
            .unwrap();
        let rows: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/config-managed-multimodal-cases.json"
        ))
        .unwrap();
        let mut executed = 0;
        let mut previous_lines = 0;
        for row in rows
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["group"] == group)
        {
            executed += 1;
            let id = row["id"].as_str().unwrap();
            let user = row["user"].clone();
            let inner = row["inner"].clone();
            let user_path = directory.path().join("user.json");
            let inner_path = directory.path().join("inner.json");
            let mut inner_loaded = inner.clone();
            if row["readBom"] == true || row["readFiles"] == true {
                if !user.is_null() {
                    std::fs::write(&user_path, user.to_string()).unwrap();
                }
                let text = if row["readBom"] == true {
                    format!("\u{feff}{inner}")
                } else {
                    inner.to_string()
                };
                std::fs::write(&inner_path, text).unwrap();
                inner_loaded = read_checked_config(inner_path.to_str().unwrap(), true)
                    .await
                    .unwrap()
                    .unwrap();
            }
            let before_user = std::fs::read(&user_path).ok();
            let before_inner = std::fs::read(&inner_path).ok();
            let env = HashMap::new();
            let config = assemble_config(
                (!user.is_null()).then_some(&user),
                (!inner.is_null()).then_some(&inner_loaded),
                &ConfigSources {
                    env: &env,
                    platform: Platform::current(),
                    hostname: "synthetic",
                    config_path: user_path.to_str().unwrap(),
                    global_poll_ms: None,
                },
            )
            .unwrap();
            let expected_raw = &row["expectedMultimodal"];
            if matches!(
                config.multimodal.as_ref().map(|config| &config.storage),
                Some(MultimodalStorage::Oss { .. })
            ) {
                assert_eq!(
                    expected_raw["storage"]["auth"]["mode"], "ak",
                    "{id}: OSS auth must remain AK"
                );
            }
            let expected: Option<MultimodalRuntimeConfig> =
                serde_json::from_value(expected_raw.clone()).unwrap();
            assert_eq!(config.multimodal, expected, "{id}: resolved typed storage");
            if let Some(expected) = row.get("expectedAgents") {
                assert_eq!(
                    serde_json::to_value(&config.agents).unwrap(),
                    *expected,
                    "{id}: agent policies"
                );
            }
            for (name, key) in [("collectionGates", "collection"), ("uploadGates", "upload")] {
                if let Some(expected) = row[name].as_object() {
                    for (agent, allowed) in expected {
                        let actual = if key == "collection" {
                            crate::deployment::is_agent_gated_enabled(&config, agent)
                        } else {
                            config.agents.get(agent).is_some_and(|policy| {
                                crate::multimodal::is_agent_multimodal_enabled(Some(agent), policy)
                            })
                        };
                        assert_eq!(
                            actual,
                            allowed.as_bool().unwrap(),
                            "{id}: {key} gate {agent}"
                        );
                    }
                }
            }
            if let Some(expected) = row["anyUpload"].as_bool() {
                assert_eq!(
                    crate::multimodal::any_agent_multimodal_enabled(&config.agents),
                    expected,
                    "{id}: any upload"
                );
            }
            if let Some(expected) = row.get("slsExpected") {
                subset(
                    &serde_json::to_value(&config.flushers.sls.as_ref().unwrap().endpoints[0])
                        .unwrap(),
                    expected,
                    id,
                );
            }
            if row["otlpCaptureAbsent"] == true {
                let built =
                    build_otlp_trace_config_with(&config, &env, Platform::current()).unwrap();
                assert_eq!(
                    built.capture_message_content, None,
                    "{id}: old content flag leaked"
                );
            }
            assert_eq!(
                std::fs::read(&user_path).ok(),
                before_user,
                "{id}: user file modified"
            );
            assert_eq!(
                std::fs::read(&inner_path).ok(),
                before_inner,
                "{id}: managed file modified"
            );
            crate::utils::flush_logs_sync();
            let events: Vec<Value> = std::fs::read_dir(&logdir)
                .unwrap()
                .flat_map(|entry| {
                    std::fs::read_to_string(entry.unwrap().path())
                        .unwrap()
                        .lines()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_str(&line).unwrap())
                .collect();
            if let Some(warnings) = row["warnings"].as_array() {
                for expected in warnings {
                    assert!(
                        events[previous_lines..].iter().any(|event| {
                            event["level"] == "WARN"
                                && expected
                                    .as_object()
                                    .unwrap()
                                    .iter()
                                    .all(|(key, value)| event[key] == *value)
                        }),
                        "{id}: exact managed warning missing"
                    );
                }
            }
            previous_lines = events.len();
        }
        assert!(executed > 0);
    }
    #[tokio::test]
    async fn managed_storage_parser_supports_bom_missing_user_and_file_immutability() {
        run("storage").await;
    }
    #[tokio::test]
    async fn user_storage_block_is_authoritative_and_never_borrows_managed_credentials() {
        run("isolation").await;
    }
    #[tokio::test]
    async fn managed_upload_policies_merge_per_field_without_changing_collection_gates() {
        run("agents").await;
    }
    #[tokio::test]
    async fn managed_invalid_policy_diagnostics_keep_exact_messages_fields_and_safe_defaults() {
        run("warnings").await;
    }
}

#[cfg(test)]
mod migration_config_advanced_tests {
    use super::*;
    use serde_json::{json, Value};

    fn choose(root: Option<&Value>, path: &[Value], id: &str) -> Option<Value> {
        let mut selected = root.cloned();
        for segment in path {
            let value = selected?;
            selected = match segment {
                Value::String(key) => value.get(key).cloned(),
                Value::Number(index) => value.get(index.as_u64().unwrap() as usize).cloned(),
                Value::Object(query) => {
                    let items = value
                        .as_array()
                        .unwrap_or_else(|| panic!("{id}: expected array before selector"));
                    let member_path = query["path"].as_array().cloned().unwrap_or_default();
                    let matches = |item: &Value| {
                        let actual = choose(Some(item), &member_path, id);
                        if query["unset"] == true {
                            actual.is_none()
                        } else {
                            actual.as_ref() == Some(&query["expected"])
                        }
                    };
                    Some(match query["op"].as_str().unwrap() {
                        "map" => Value::Array(
                            items
                                .iter()
                                .map(|item| {
                                    choose(Some(item), &member_path, id).unwrap_or(Value::Null)
                                })
                                .collect(),
                        ),
                        // Old tests dereference these named results; missing a backend
                        // must fail instead of making an undefined child field pass.
                        "find" => items
                            .iter()
                            .find(|item| matches(item))
                            .unwrap_or_else(|| panic!("{id}: named backend missing"))
                            .clone(),
                        "every" => json!(items.iter().all(matches)),
                        "some" => json!(items.iter().any(matches)),
                        "sort" => {
                            let mut sorted = items.clone();
                            sorted.sort_by_key(Value::to_string);
                            Value::Array(sorted)
                        }
                        _ => panic!("{id}: invalid fixture selector"),
                    })
                }
                _ => panic!("{id}: invalid fixture path"),
            };
        }
        selected
    }
    fn subset(actual: &Value, expected: &Value) -> bool {
        match expected {
            Value::Object(fields) => fields
                .iter()
                .all(|(key, value)| actual.get(key).is_some_and(|actual| subset(actual, value))),
            _ => actual == expected,
        }
    }
    fn project_home(value: &mut Value) {
        match value {
            Value::String(text) if text.contains("$TEST_HOME") => {
                let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
                let home = std::env::var(key).unwrap_or_default();
                *text = if let Some(suffix) = text.strip_prefix("$TEST_HOME/") {
                    suffix
                        .split('/')
                        .fold(std::path::PathBuf::from(&home), |path, part| {
                            path.join(part)
                        })
                        .to_string_lossy()
                        .into_owned()
                } else {
                    text.replace("$TEST_HOME", &home)
                };
            }
            Value::Array(values) => {
                for value in values {
                    project_home(value);
                }
            }
            Value::Object(fields) => {
                for value in fields.values_mut() {
                    project_home(value);
                }
            }
            _ => {}
        }
    }
    fn assert_contract(config: &Value, built: &Value, logs: &[Value], assertion: &Value, id: &str) {
        let base = match assertion["base"].as_str().unwrap() {
            "config" => config,
            "built" => built,
            "logs" => &Value::Null,
            _ => panic!("invalid fixture base"),
        };
        let path = assertion["path"].as_array().unwrap();
        let actual = choose(Some(base), path, id);
        let expected = &assertion["expected"];
        let passed = match assertion["op"].as_str().unwrap() {
            "toEqual" | "toBe" => actual.as_ref() == Some(expected),
            "toMatchObject" => actual
                .as_ref()
                .is_some_and(|actual| subset(actual, expected)),
            "toBeUndefined" => actual.as_ref().is_none_or(Value::is_null),
            "toBeDefined" => actual.as_ref().is_some_and(|actual| !actual.is_null()),
            "toHaveLength" => actual
                .as_ref()
                .and_then(Value::as_array)
                .is_some_and(|items| Some(items.len() as u64) == expected.as_u64()),
            "toContain" | "toContainEqual" => actual.as_ref().is_some_and(|actual| {
                actual
                    .as_array()
                    .is_some_and(|items| items.contains(expected))
                    || actual
                        .as_str()
                        .zip(expected.as_str())
                        .is_some_and(|(text, part)| text.contains(part))
            }),
            "toHaveProperty" => {
                let key = assertion["property"].as_str().unwrap();
                let property = choose(
                    actual.as_ref(),
                    &key.split('.').map(|part| json!(part)).collect::<Vec<_>>(),
                    id,
                );
                property.is_some()
                    && (assertion["hasExpected"] != true || property.as_ref() == Some(expected))
            }
            "toHaveBeenCalled" => logs
                .iter()
                .any(|event| event["level"] == "WARN" && event["tag"] == "ConfigLoader"),
            "toHaveBeenCalledWith" => {
                let expected = expected.as_array().unwrap();
                logs.iter().any(|event| {
                    if event["level"] != "WARN" || event["tag"] != "ConfigLoader" {
                        return false;
                    }
                    let message = expected[0]
                        .as_str()
                        .is_some_and(|text| event["msg"] == text)
                        || expected[0]
                            .get("$stringContaining")
                            .and_then(Value::as_str)
                            .is_some_and(|part| {
                                event["msg"]
                                    .as_str()
                                    .is_some_and(|text| text.contains(part))
                            });
                    message && (expected.len() < 2 || subset(event, &expected[1]))
                })
            }
            _ => panic!("{id}: unsupported fixture assertion"),
        };
        assert_eq!(
            passed,
            assertion["negate"] != true,
            "{id}: {:?} at {:?} expected={expected:?} actual={actual:?}",
            assertion["op"],
            path
        );
    }
    async fn run(group: &str) {
        // Capture actual structured production diagnostics without sharing global
        // logger state with another test thread.
        if !crate::utils::isolated_env_test() {
            return;
        }
        unsafe {
            std::env::set_var("LOG_LEVEL", "trace");
        }
        let directory = tempfile::tempdir().unwrap();
        let logdir = directory.path().join("logs");
        crate::utils::init_file_logging(logdir.join("advanced.log").to_str().unwrap())
            .await
            .unwrap();
        let mut cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/config-advanced-cases.json"
        ))
        .unwrap();
        project_home(&mut cases);
        let mut count = 0;
        let mut previous_lines = 0;
        for case in cases
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["group"] == group)
        {
            count += 1;
            let id = case["id"].as_str().unwrap();
            let env: HashMap<String, String> = serde_json::from_value(case["env"].clone()).unwrap();
            let file = &case["user"];
            let inner = &case["inner"];
            let config = assemble_config(
                (!file.is_null()).then_some(file),
                (!inner.is_null()).then_some(inner),
                &ConfigSources {
                    env: &env,
                    platform: Platform::current(),
                    hostname: "synthetic",
                    config_path: "not-read.json",
                    global_poll_ms: None,
                },
            )
            .unwrap();
            let mut config_json = serde_json::to_value(&config).unwrap();
            if matches!(
                config.multimodal.as_ref().map(|c| &c.storage),
                Some(MultimodalStorage::Oss { .. })
            ) {
                // OSS's typed variant fixes AK auth, whereas the old JS view
                // included a redundant discriminator in its plain object.
                config_json["multimodal"]["storage"]["auth"]["mode"] = json!("ak");
            }
            let assertions = case["assertions"].as_array().unwrap();
            let built = if assertions
                .iter()
                .any(|assertion| assertion["base"] == "built")
            {
                serde_json::to_value(build_otlp_trace_config_with(
                    &config,
                    &env,
                    Platform::current(),
                ))
                .unwrap()
            } else {
                Value::Null
            };
            crate::utils::flush_logs_sync();
            let logs: Vec<Value> = std::fs::read_dir(&logdir)
                .unwrap()
                .flat_map(|entry| {
                    std::fs::read_to_string(entry.unwrap().path())
                        .unwrap()
                        .lines()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_str(&line).unwrap())
                .collect();
            for assertion in assertions {
                assert_contract(&config_json, &built, &logs[previous_lines..], assertion, id);
            }
            previous_lines = logs.len();
        }
        assert!(count > 0);
    }
    #[tokio::test]
    async fn remaining_sls_destination_and_service_override_contracts() {
        run("outputs").await;
    }
    #[tokio::test]
    async fn remaining_agent_policy_content_and_multimodal_field_contracts() {
        run("agents").await;
    }
    #[tokio::test]
    async fn multimodal_storage_validation_auth_inference_and_target_reuse_contracts() {
        run("multimodal").await;
    }
    #[tokio::test]
    async fn otlp_and_managed_cms_union_headers_resources_and_dedup_contracts() {
        run("otlp").await;
    }
    #[tokio::test]
    async fn interceptor_defaults_types_environment_and_mask_union_contracts() {
        run("interceptor").await;
    }
}

#[cfg(test)]
mod migration_config_edge_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn valid_workspace_exclusions_are_preserved_and_relative_rules_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private-project");
        let env = HashMap::new();
        let sources = ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: "not-read.json",
            global_poll_ms: None,
        };
        let valid = json!({"privacy":{"excludeWorkspaces":[private]}});
        let config = assemble_config(Some(&valid), None, &sources).unwrap();
        assert_eq!(
            config.privacy.unwrap().exclude_workspaces,
            vec![private.to_string_lossy().into_owned()]
        );
        let invalid = json!({"privacy":{"excludeWorkspaces":["relative"]}});
        let error = assemble_config(Some(&invalid), None, &sources).unwrap_err();
        assert!(error.to_string().contains("absolute local directories"));
    }
    #[test]
    fn span_enricher_paths_resolve_config_home_and_data_with_lexical_deduplication() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("config");
        let data = root.path().join("data");
        let config_path = config_dir.join("config.json");
        let env = HashMap::new();
        let sources = ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: config_path.to_str().unwrap(),
            global_poll_ms: None,
        };
        let file = json!({
            "dataDir":data,"collectTrace":true,
            "otlpTrace":{"endpoint":"http://127.0.0.1:4318","spanEnrichers":[
                "./skill.mjs",config_dir.join("skill.mjs"),"~/home.mjs",
                "$PILOT_DATA/plugins/skill.mjs",42,"bad.ts",
                "./unused/../skill.mjs"
            ]}
        });
        let before = file.clone();
        let config = assemble_config(Some(&file), None, &sources).unwrap();
        let trace = build_otlp_trace_config(&config).unwrap();
        assert_eq!(
            trace.span_enricher_paths.unwrap(),
            vec![
                config_dir.join("skill.mjs").to_string_lossy().into_owned(),
                std::path::PathBuf::from(
                    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap(),
                )
                .components()
                .collect::<std::path::PathBuf>()
                .join("home.mjs")
                .to_string_lossy()
                .into_owned(),
                data.join("plugins")
                    .join("skill.mjs")
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
        assert_eq!(trace.endpoints.len(), 1);
        assert_eq!(file, before);
    }

    #[test]
    fn span_enricher_count_is_capped_without_disabling_cms_only_trace_export() {
        let root = tempfile::tempdir().unwrap();
        let env = HashMap::new();
        let config_path = root.path().join("config.json");
        let sources = ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: config_path.to_str().unwrap(),
            global_poll_ms: None,
        };
        let paths: Vec<_> = (0..20)
            .map(|i| root.path().join(format!("{i}.mjs")))
            .collect();
        let file = json!({
            "collectTrace":true,
            "cms":{"licenseKey":"synthetic","endpoint":"http://127.0.0.1:4318"},
            "otlpTrace":{"spanEnrichers":paths}
        });
        let before = file.clone();
        let trace = build_otlp_trace_config(&assemble_config(Some(&file), None, &sources).unwrap())
            .unwrap();
        assert_eq!(
            trace.span_enricher_paths.unwrap(),
            paths[..16]
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(trace.endpoints.len(), 1);
        assert_eq!(trace.endpoints[0].name, "user-cms");
        assert_eq!(file, before);
    }

    #[test]
    fn dashboard_port_preserves_every_numeric_boundary_and_invalid_value_fallback() {
        let env = HashMap::new();
        let sources = ConfigSources {
            env: &env,
            platform: Platform::current(),
            hostname: "synthetic",
            config_path: "not-read.json",
            global_poll_ms: None,
        };
        // NaN is not a serde_json Number. Its JSON representation is null,
        // which must take the same invalid-port fallback as the legacy mock.
        let nan = serde_json::to_value(f64::NAN).unwrap();
        assert!(nan.is_null());
        for (port, expected) in [
            (None, 8765),
            (Some(json!(1)), 1),
            (Some(json!(8765)), 8765),
            (Some(json!(65535)), 65535),
            (Some(json!(0)), 8765),
            (Some(json!(65536)), 8765),
            (Some(json!(-1)), 8765),
            (Some(json!(1.5)), 8765),
            (Some(json!("9000")), 8765),
            (Some(nan), 8765),
        ] {
            let file = port
                .map(|port| json!({"dashboard":{"port":port}}))
                .unwrap_or_else(|| json!({}));
            let before = file.clone();
            let config = assemble_config(Some(&file), None, &sources).unwrap();
            assert_eq!(config.dashboard.port, expected);
            assert_eq!(file, before);
        }
    }
}

#[cfg(test)]
mod doubao_listener_wiring_tests {
    use super::*;
    use serde_json::json;

    fn config(file: &Value, global_poll_ms: Option<u64>) -> AnalyticsConfig {
        let env = HashMap::new();
        assemble_config(
            Some(file),
            None,
            &ConfigSources {
                env: &env,
                platform: Platform::current(),
                hostname: "synthetic",
                config_path: "not-read.json",
                global_poll_ms,
            },
        )
        .unwrap()
    }

    #[test]
    fn doubao_listener_defaults_on_and_older_serialized_listeners_remain_compatible() {
        let built = config(&json!({}), None);
        let listener = &built.listeners["doubao-work"];
        assert!(listener.enabled);
        assert_eq!(listener.poll_interval, DEFAULT_POLL_INTERVAL_MS);
        assert_eq!(listener.log_dir, None);
        let encoded = serde_json::to_value(listener).unwrap();
        assert_eq!(
            encoded,
            json!({"enabled":true,"pollInterval":DEFAULT_POLL_INTERVAL_MS})
        );
        let decoded: ListenerConfig = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, listener.clone());
    }

    #[test]
    fn only_doubao_accepts_trimmed_absolute_log_override_without_mutating_source() {
        let root = tempfile::tempdir().unwrap();
        let expected = root.path().join("native-logs");
        let raw = format!("  {}/unused/../native-logs  ", root.path().display());
        let file = json!({"listeners":{
            "doubao-work":{"enabled":false,"pollInterval":1777,"logDir":raw},
            "workbuddy":{"logDir":"/must-not-relocate"},
            "codex-log":{"logDir":"/must-not-propagate"},
            "unknown-agent":{"logDir":"/must-not-enable-arbitrary-overrides"}
        }});
        let before = file.clone();
        let built = config(&file, None);
        assert_eq!(file, before);
        let listener = &built.listeners["doubao-work"];
        assert!(!listener.enabled);
        assert_eq!(listener.poll_interval, 1777);
        assert_eq!(
            listener.log_dir.as_deref(),
            Some(expected.to_str().unwrap())
        );
        for name in [
            "workbuddy",
            "codex-log",
            "codex-transcript",
            "unknown-agent",
        ] {
            assert_eq!(built.listeners[name].log_dir, None, "{name}");
        }
        assert_eq!(
            serde_json::to_value(listener).unwrap()["logDir"],
            expected.to_str().unwrap()
        );
        assert!(
            !expected.exists(),
            "resolving configuration must not create source directories"
        );
    }

    #[test]
    fn blank_and_nonstring_log_overrides_are_ignored_and_global_poll_is_preserved() {
        for raw in [
            json!(null),
            json!(""),
            json!(" \t\r\n "),
            json!(false),
            json!(42),
            json!([]),
            json!({}),
        ] {
            let built = config(
                &json!({"listeners":{"doubao-work":{"logDir":raw}}}),
                Some(2468),
            );
            let listener = &built.listeners["doubao-work"];
            assert_eq!(listener.log_dir, None);
            assert!(listener.enabled);
            assert_eq!(listener.poll_interval, 2468);
        }
        let cwd = std::env::current_dir().unwrap();
        let built = config(
            &json!({"listeners":{"doubao-work":{"logDir":" ./unused/../relative-logs "}}}),
            None,
        );
        assert_eq!(
            built.listeners["doubao-work"].log_dir,
            Some(cwd.join("relative-logs").to_string_lossy().into_owned())
        );
        let built = config(
            &json!({"listeners":{"doubao-work":{"logDir":" ~/pilot-fixture-log "}}}),
            None,
        );
        assert_eq!(
            built.listeners["doubao-work"].log_dir,
            Some(
                std::path::PathBuf::from(
                    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap(),
                )
                .components()
                .collect::<std::path::PathBuf>()
                .join("pilot-fixture-log")
                .to_string_lossy()
                .into_owned()
            )
        );
    }
}

#[cfg(test)]
#[path = "config_loader_main_listener_history.rs"]
mod main_listener_history;
