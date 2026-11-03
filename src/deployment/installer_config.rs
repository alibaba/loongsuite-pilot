//! 安装配置合并：显式选项覆盖，未指定字段保留；不启动发现、部署或遥测。

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Map, Value};
use std::path::Path;

// 这里只保存环境变量的名称；实际凭据在安装时从环境读取。
const CMS_AUTH_ENV: &str = "LP_CMS_LICENSE_KEY";

pub(super) const ENV_OPTIONS: &[(&str, &str)] = &[
    ("configPath", "LP_CONFIG_PATH"),
    ("dataDir", "LP_DATA_DIR"),
    ("dashboardPort", "LP_DASHBOARD_PORT"),
    ("slsEndpoint", "LP_SLS_ENDPOINT"),
    ("slsProject", "LP_SLS_PROJECT"),
    ("slsLogstore", "LP_SLS_LOGSTORE"),
    ("slsAkId", "LP_SLS_AK_ID"),
    ("slsAkSecret", "LP_SLS_AK_SECRET"),
    ("slsApiKey", "LP_SLS_API_KEY"),
    ("logLevel", "LP_LOG_LEVEL"),
    ("userId", "LP_USER_ID"),
    ("collectLog", "LP_COLLECT_LOG"),
    ("collectTrace", "LP_COLLECT_TRACE"),
    ("enableStatusBarApp", "LP_ENABLE_STATUS_BAR_APP"),
    ("cmsLicenseKey", CMS_AUTH_ENV),
    ("cmsEndpoint", "LP_CMS_ENDPOINT"),
    ("cmsWorkspace", "LP_CMS_WORKSPACE"),
    ("serviceNamePrefix", "LP_SERVICE_NAME_PREFIX"),
    ("selectedAgents", "LP_SELECTED_AGENTS"),
    ("allAgentsMode", "LP_ALL_AGENTS"),
    ("multimodalMode", "LP_MULTIMODAL_MODE"),
    (
        "multimodalSupportedAgents",
        "LP_MULTIMODAL_SUPPORTED_AGENTS",
    ),
    ("agentSelectionExplicit", "LP_AGENT_SELECTION_EXPLICIT"),
    ("maskMode", "LP_MASK_MODE"),
    ("maskTypes", "LP_MASK_TYPES"),
    ("maskReplacementMode", "LP_MASK_REPLACEMENT_MODE"),
    ("interceptorMode", "LP_INTERCEPTOR_MODE"),
    ("interceptorTypes", "LP_INTERCEPTOR_TYPES"),
];
const INTERCEPTOR_TYPES: &[&str] = &["cloudAccessKey", "apiKey", "privateKey", "databaseUrl"];

pub(super) struct Options(pub Map<String, Value>);
impl Options {
    pub fn new(value: Value) -> Result<Self> {
        let map = value
            .as_object()
            .context("安装选项必须为 JSON 对象")?
            .clone();
        for (key, value) in &map {
            ensure!(
                ENV_OPTIONS.iter().any(|(name, _)| key == name)
                    || ["probeResult", "excludeWorkspaces"].contains(&key.as_str()),
                "存在未知安装选项"
            );
            if [
                "probeResult",
                "excludeWorkspaces",
                "selectedAgents",
                "multimodalSupportedAgents",
                "maskTypes",
                "interceptorTypes",
            ]
            .contains(&key.as_str())
            {
                ensure!(
                    value.is_null() || value.is_string() || value.is_array(),
                    "安装列表选项类型无效"
                );
            } else {
                ensure!(
                    value.is_null() || value.is_string() || value.is_boolean() || value.is_u64(),
                    "安装标量选项类型无效"
                );
            }
        }
        Ok(Self(map))
    }
    pub fn text(&self, key: &str) -> String {
        match self.0.get(key) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Bool(value)) => value.to_string(),
            Some(Value::Number(value)) => value.to_string(),
            _ => String::new(),
        }
    }
    fn boolean(&self, key: &str) -> Result<Option<bool>> {
        match self.text(key).to_ascii_lowercase().as_str() {
            "" => Ok(None),
            "true" | "1" => Ok(Some(true)),
            "false" | "0" => Ok(Some(false)),
            _ => bail!("安装布尔选项 {key} 无效"),
        }
    }
    fn list(&self, key: &str) -> Result<Vec<String>> {
        csv(self.0.get(key))
    }
    pub fn probes(&self) -> Result<Vec<Value>> {
        let value = match self.0.get("probeResult") {
            None | Some(Value::Null) => json!([]),
            Some(Value::String(raw)) => super::installer_helper::parse_json(raw)?,
            Some(value) => value.clone(),
        };
        validate_probes(value)
    }
}

pub(super) fn csv(value: Option<&Value>) -> Result<Vec<String>> {
    let parts: Vec<&str> = match value {
        None | Some(Value::Null) => vec![],
        Some(Value::String(text)) => text.split(',').collect(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().context("列表必须只包含字符串"))
            .collect::<Result<_>>()?,
        _ => bail!("列表格式无效"),
    };
    let mut result = Vec::new();
    for part in parts {
        let part = part.trim();
        if !part.is_empty() && !result.iter().any(|v| v == part) {
            result.push(part.to_owned());
        }
    }
    Ok(result)
}

pub(super) fn validate_probes(value: Value) -> Result<Vec<Value>> {
    let probes = value.as_array().context("探测结果必须为数组")?;
    let mut seen = std::collections::HashSet::new();
    for probe in probes {
        let id = probe
            .get("id")
            .and_then(Value::as_str)
            .context("探测结果缺少 Agent ID")?;
        ensure!(
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
            "探测结果 Agent ID 无效"
        );
        ensure!(seen.insert(id), "探测结果包含重复 Agent");
        ensure!(
            probe.get("detected").is_some_and(Value::is_boolean),
            "探测结果缺少 detected 布尔值"
        );
    }
    Ok(probes.clone())
}

fn object<'a>(root: &'a mut Map<String, Value>, key: &str) -> Result<&'a mut Map<String, Value>> {
    let value = root.entry(key.to_owned()).or_insert_with(|| json!({}));
    value
        .as_object_mut()
        .with_context(|| format!("现有配置 {key} 必须为对象；保留原文件"))
}
fn put_text(root: &mut Map<String, Value>, field: &str, options: &Options, option: &str) {
    let text = options.text(option);
    if !text.is_empty() {
        root.insert(field.into(), Value::String(text));
    }
}
fn mode(options: &Options, key: &str, allowed: &[&str]) -> Result<String> {
    let text = options.text(key);
    ensure!(
        text.is_empty() || allowed.contains(&text.as_str()),
        "安装选项 {key} 无效"
    );
    Ok(text)
}

pub(super) fn merge(existing: &Value, options: &Options) -> Result<Value> {
    let mut config = existing
        .as_object()
        .context("现有配置必须为 JSON 对象；保留原文件")?
        .clone();
    let data_dir = options.text("dataDir");
    ensure!(Path::new(&data_dir).is_absolute(), "dataDir 必须为绝对路径");
    config.insert("enabled".into(), json!(true));
    config.insert("dataDir".into(), json!(data_dir));
    let port = options.text("dashboardPort");
    let dashboard = object(&mut config, "dashboard")?;
    if !port.is_empty() {
        let port: u16 = port
            .parse()
            .ok()
            .filter(|port| *port > 0)
            .context("Dashboard 端口必须为 1..65535")?;
        dashboard.insert("port".into(), json!(port));
    }
    dashboard.entry("port").or_insert(json!(8765));
    if let Some(exclude) = options.0.get("excludeWorkspaces").filter(|v| !v.is_null()) {
        let values = if let Some(raw) = exclude.as_str() {
            super::installer_helper::parse_json(raw)?
        } else {
            exclude.clone()
        };
        let values = values.as_array().context("excludeWorkspaces 必须为数组")?;
        for value in values {
            ensure!(
                value.as_str().is_some_and(|s| Path::new(s).is_absolute()),
                "excludeWorkspaces 必须为绝对路径列表"
            );
        }
        object(&mut config, "privacy")?.insert("excludeWorkspaces".into(), json!(values));
    }
    config.remove("internal");
    if !config.contains_key("userId") {
        if let Some(value) = config.get("user.id").cloned() {
            config.insert("userId".into(), value);
        }
    }
    config.remove("user.id");
    for key in ["logLevel", "userId", "serviceNamePrefix"] {
        put_text(&mut config, key, options, key);
    }
    if !options.text("userId").is_empty() {
        config.remove("identity");
    }
    for key in ["collectLog", "collectTrace", "enableStatusBarApp"] {
        if let Some(value) = options.boolean(key)? {
            config.insert(key.into(), json!(value));
        }
    }
    merge_sls(&mut config, options)?;
    if ["cmsLicenseKey", "cmsEndpoint", "cmsWorkspace"]
        .iter()
        .any(|key| !options.text(key).is_empty())
    {
        let cms = object(&mut config, "cms")?;
        for (field, key) in [
            ("licenseKey", "cmsLicenseKey"),
            ("endpoint", "cmsEndpoint"),
            ("workspace", "cmsWorkspace"),
        ] {
            put_text(cms, field, options, key);
        }
    }
    merge_mask(&mut config, options)?;
    merge_agents(&mut config, options)?;
    Ok(Value::Object(config))
}

fn merge_sls(config: &mut Map<String, Value>, options: &Options) -> Result<()> {
    let endpoint = options.text("slsEndpoint");
    let project = options.text("slsProject");
    let logstore = options.text("slsLogstore");
    let api_key = options.text("slsApiKey");
    let ak_id = options.text("slsAkId");
    let ak_secret = options.text("slsAkSecret");
    ensure!(
        ak_id.is_empty() == ak_secret.is_empty(),
        "SLS AK 必须成对提供"
    );
    ensure!(
        api_key.is_empty() || ak_id.is_empty(),
        "SLS API key 和 AK 不可同时指定"
    );
    if [&endpoint, &project, &logstore, &api_key, &ak_id]
        .iter()
        .all(|v| v.is_empty())
    {
        return Ok(());
    }
    let sls = object(config, "sls")?;
    sls.remove("destinationOverride");
    for (key, field) in [
        ("slsEndpoint", "endpoint"),
        ("slsProject", "project"),
        ("slsLogstore", "logstore"),
    ] {
        put_text(sls, field, options, key);
    }
    if !project.is_empty() && !logstore.is_empty() {
        sls.remove("endpoints");
    }
    for key in ["apiKey", "accessKeyId", "accessKeySecret"] {
        sls.remove(key);
    }
    if !api_key.is_empty() {
        sls.insert("mode".into(), json!("apiKey"));
        sls.insert("apiKey".into(), json!(api_key));
    } else if !ak_id.is_empty() {
        sls.insert("mode".into(), json!("ak"));
        sls.insert("accessKeyId".into(), json!(ak_id));
        sls.insert("accessKeySecret".into(), json!(ak_secret));
    } else {
        sls.insert("mode".into(), json!("webtracking"));
    }
    Ok(())
}

fn merge_mask(config: &mut Map<String, Value>, options: &Options) -> Result<()> {
    for (field, mode_key, types_key) in [
        ("mask", "maskMode", "maskTypes"),
        ("interceptor", "interceptorMode", "interceptorTypes"),
    ] {
        let requested = mode(options, mode_key, &["all", "custom", "none"])?;
        if !requested.is_empty() {
            let target = object(config, field)?;
            target.insert("mode".into(), json!(requested));
            if requested == "custom" {
                target.insert("types".into(), json!(options.list(types_key)?));
            } else {
                target.remove("types");
            }
        }
    }
    let replacement = mode(options, "maskReplacementMode", &["placeholder", "preview"])?;
    if !replacement.is_empty() {
        object(config, "mask")?.insert("replacementMode".into(), json!(replacement));
    }
    let extra = match config
        .get("interceptor")
        .and_then(|v| v.get("mode"))
        .and_then(Value::as_str)
    {
        Some("all") => INTERCEPTOR_TYPES
            .iter()
            .map(|v| (*v).to_owned())
            .collect::<Vec<_>>(),
        Some("custom") => csv(config.get("interceptor").and_then(|v| v.get("types")))?
            .into_iter()
            .filter(|v| INTERCEPTOR_TYPES.contains(&v.as_str()))
            .collect(),
        _ => vec![],
    };
    if !extra.is_empty()
        && config
            .get("mask")
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str)
            != Some("all")
    {
        let mask = object(config, "mask")?;
        let mut types = if mask.get("mode").and_then(Value::as_str) == Some("custom") {
            csv(mask.get("types"))?
        } else {
            vec![]
        };
        for item in extra {
            if !types.contains(&item) {
                types.push(item);
            }
        }
        mask.insert("mode".into(), json!("custom"));
        mask.insert("types".into(), json!(types));
    }
    Ok(())
}

fn merge_agents(config: &mut Map<String, Value>, options: &Options) -> Result<()> {
    let probes = options.probes()?;
    let mut selected = options.list("selectedAgents")?;
    let explicit = options.boolean("agentSelectionExplicit")?.unwrap_or(false);
    let all = options.boolean("allAgentsMode")?.unwrap_or(false);
    let none = selected == ["none"];
    if none {
        selected.clear();
    }
    if !all {
        for id in &selected {
            ensure!(
                probes.iter().any(|v| v["id"].as_str() == Some(id)),
                "选择了探测集合外的 Agent"
            );
        }
    }
    if all && config.contains_key("agents") {
        for slot in object(config, "agents")?.values_mut() {
            slot.as_object_mut()
                .context("现有 Agent 配置必须为对象")?
                .remove("enabled");
        }
    } else if !all && (!selected.is_empty() || explicit || none) {
        ensure!(!probes.is_empty(), "显式选择需要非空的 Agent 定义集合");
        let agents = object(config, "agents")?;
        for probe in &probes {
            let id = probe["id"].as_str().context("缺少 Agent ID")?;
            if id == "openclaw"
                && probe["detected"] == false
                && !explicit
                && !none
                && agents.contains_key(id)
            {
                continue;
            }
            object(agents, id)?.insert("enabled".into(), json!(selected.iter().any(|v| v == id)));
        }
    }
    if let Some(openclaw) = probes
        .iter()
        .find(|v| v["id"] == "openclaw" && v["detected"] == true)
    {
        if let Some(path) = openclaw
            .get("openclawCliPath")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            let disabled = config
                .get("agents")
                .and_then(|v| v.get("openclaw"))
                .and_then(|v| v.get("enabled"))
                == Some(&json!(false));
            if all || !disabled {
                object(object(config, "agents")?, "openclaw")?
                    .insert("cliPath".into(), json!(path));
            }
        }
    }
    let multimodal = mode(
        options,
        "multimodalMode",
        &["all", "input", "output", "none"],
    )?;
    if !multimodal.is_empty() {
        let agents = object(config, "agents")?;
        for id in options.list("multimodalSupportedAgents")? {
            if !(agents.contains_key(&id) || all && multimodal != "none") {
                continue;
            }
            let slot = object(agents, &id)?;
            if multimodal == "none" {
                slot.remove("multimodal");
            } else {
                let upload = if all || selected.contains(&id) {
                    &multimodal
                } else {
                    "none"
                };
                object(slot, "multimodal")?.insert("uploadMode".into(), json!(upload));
            }
        }
    }
    if !multimodal.is_empty()
        && multimodal != "none"
        && ["slsEndpoint", "slsProject", "slsLogstore", "slsApiKey"]
            .iter()
            .all(|k| !options.text(k).is_empty())
    {
        // 不覆盖用户自己的其他多模态配置。
        object(config, "multimodal")?.insert("storage".into(), json!({"type":"sls", "target": {
            "endpoint": options.text("slsEndpoint"), "project": options.text("slsProject"), "logstore": options.text("slsLogstore")
        }}));
    }
    Ok(())
}

// Render fixed public enums and validated Dashboard ports only. Credentials,
// paths and malformed/user-defined values remain redacted.
fn safe_diff_value(field: &str, value: &Value) -> Option<String> {
    let allowed: &[&str] = match field {
        "dashboard.port" => {
            return value
                .as_f64()
                .filter(|port| {
                    port.is_finite() && port.fract() == 0.0 && *port >= 1.0 && *port <= 65535.0
                })
                .map(|port| (port as u16).to_string());
        }
        "mask.mode" | "interceptor.mode" => &["all", "custom", "none"],
        "sls.mode" => &["ak", "apiKey", "webtracking"],
        "mask.replacementMode" => &["placeholder", "preview"],
        "multimodal.storage.type" => &["sls", "oss"],
        "mask.types" | "interceptor.types" => {
            let items = value.as_array()?;
            let known = crate::types::SUPPORTED_MASK_TYPES;
            if items.len() > known.len() {
                return None;
            }
            let values = items
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            return values
                .iter()
                .all(|item| known.contains(item))
                .then(|| values.join(","));
        }
        _ => return None,
    };
    let text = value.as_str()?;
    allowed.contains(&text).then(|| text.to_owned())
}

pub(super) fn changed_fields(old: &Value, next: &Value) -> String {
    // Display only known enum/type values and checked ports; keep other values hidden.
    let fields = [
        "sls.endpoint",
        "sls.project",
        "sls.logstore",
        "sls.mode",
        "sls.apiKey",
        "sls.accessKeyId",
        "sls.accessKeySecret",
        "cms.licenseKey",
        "cms.endpoint",
        "cms.workspace",
        "serviceNamePrefix",
        "dashboard.port",
        "mask.mode",
        "mask.types",
        "mask.replacementMode",
        "interceptor.mode",
        "interceptor.types",
        "multimodal.storage",
        "multimodal.storage.type",
        "agents",
        "userId",
        "collectLog",
        "collectTrace",
        "privacy.excludeWorkspaces",
        "enableStatusBarApp",
    ];
    fields
        .into_iter()
        .filter(|field| {
            let pointer = format!("/{}", field.replace('.', "/"));
            old.pointer(&pointer).is_some() && old.pointer(&pointer) != next.pointer(&pointer)
        })
        .map(|field| {
            let pointer = format!("/{}", field.replace('.', "/"));
            match (
                old.pointer(&pointer)
                    .and_then(|v| safe_diff_value(field, v)),
                next.pointer(&pointer)
                    .and_then(|v| safe_diff_value(field, v)),
            ) {
                (Some(before), Some(after)) => format!("{field}: {before} -> {after}"),
                _ => format!("{field}: 已变更（值不显示）"),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apply(old: Value, opts: Value) -> Result<Value> {
        let mut opts = opts.as_object().unwrap().clone();
        opts.insert("dataDir".into(), json!(std::env::temp_dir()));
        merge(&old, &Options::new(json!(opts))?)
    }
    fn probes() -> Value {
        json!([
            {"id":"cursor", "detected":true}, {"id":"openclaw", "detected":false}, {"id":"codex", "detected":false}
        ])
    }

    #[test]
    fn preserves_fields_and_migrates_identity_without_resetting_preferences() {
        let old = json!({"custom":{"keep":1}, "internal":{}, "user.id":"old", "identity":{"provider":"x"}, "dashboard":{"port":9000}, "agents":{"cursor":{"enabled":false}}});
        let result = apply(old.clone(), json!({})).unwrap();
        assert_eq!(result["custom"], old["custom"]);
        assert_eq!(result["userId"], "old");
        assert_eq!(result["identity"], old["identity"]);
        assert_eq!(result["dashboard"]["port"], 9000);
        assert_eq!(result["agents"], old["agents"]);
        assert!(result.get("internal").is_none());
        assert!(result.get("user.id").is_none());
        let result = apply(result, json!({"userId":"研发 🚀", "enableStatusBarApp":false, "collectLog":"false", "collectTrace":true})).unwrap();
        assert!(result.get("identity").is_none());
        assert_eq!(result["userId"], "研发 🚀");
        assert_eq!(result["enableStatusBarApp"], false);
        assert_eq!(result["collectLog"], false);
        assert_eq!(result["collectTrace"], true);
    }

    #[test]
    fn sls_credentials_switch_atomically_and_reject_incomplete_credentials() {
        let old = json!({"sls":{"mode":"ak","accessKeyId":"old-id","accessKeySecret":"old-secret","endpoints":[{}],"destinationOverride":{},"timeout":42}});
        let result = apply(
            old,
            json!({"slsApiKey":"new-key", "slsProject":"project", "slsLogstore":"log"}),
        )
        .unwrap();
        assert_eq!(result["sls"]["mode"], "apiKey");
        assert_eq!(result["sls"]["apiKey"], "new-key");
        assert_eq!(result["sls"]["timeout"], 42);
        for key in [
            "endpoints",
            "destinationOverride",
            "accessKeyId",
            "accessKeySecret",
        ] {
            assert!(result["sls"].get(key).is_none());
        }
        let ak = apply(
            result.clone(),
            json!({"slsAkId":"id", "slsAkSecret":"secret"}),
        )
        .unwrap();
        assert_eq!(ak["sls"]["mode"], "ak");
        assert!(ak["sls"].get("apiKey").is_none());
        let web = apply(result, json!({"slsEndpoint":"https://example.invalid"})).unwrap();
        assert_eq!(web["sls"]["mode"], "webtracking");
        assert!(web["sls"].get("apiKey").is_none());
        for opts in [
            json!({"slsAkId":"only-id"}),
            json!({"slsApiKey":"k", "slsAkId":"i", "slsAkSecret":"s"}),
        ] {
            assert!(apply(json!({}), opts).is_err());
        }
    }

    #[test]
    fn interceptor_coverage_is_unioned_and_multimodal_preserves_user_settings() {
        let old = json!({"mask":{"mode":"custom","types":["email"]},"multimodal":{"keep":7}});
        let result = apply(old, json!({"interceptorMode":"all", "maskReplacementMode":"preview", "allAgentsMode":"1", "multimodalMode":"input", "multimodalSupportedAgents":["cursor"], "slsApiKey":"k", "slsEndpoint":"e", "slsProject":"p", "slsLogstore":"l"})).unwrap();
        assert_eq!(
            result["mask"]["types"],
            json!([
                "email",
                "cloudAccessKey",
                "apiKey",
                "privateKey",
                "databaseUrl"
            ])
        );
        assert_eq!(
            result["agents"]["cursor"]["multimodal"]["uploadMode"],
            "input"
        );
        assert_eq!(result["multimodal"]["keep"], 7);
        assert_eq!(result["multimodal"]["storage"]["type"], "sls");
        let result = apply(
            result,
            json!({"multimodalMode":"none", "multimodalSupportedAgents":"cursor"}),
        )
        .unwrap();
        assert!(result["agents"]["cursor"].get("multimodal").is_none());
    }

    #[test]
    fn exact_selection_none_all_and_openclaw_detection_failure_are_distinct() {
        let old = json!({"agents":{"openclaw":{"enabled":true,"cliPath":"keep"},"cursor":{"enabled":false,"custom":1}}});
        let implicit = apply(
            old.clone(),
            json!({"selectedAgents":"cursor", "probeResult":probes()}),
        )
        .unwrap();
        assert_eq!(implicit["agents"]["openclaw"], old["agents"]["openclaw"]);
        assert_eq!(implicit["agents"]["codex"]["enabled"], false);
        let none = apply(
            old.clone(),
            json!({"selectedAgents":"none", "probeResult":probes()}),
        )
        .unwrap();
        for id in ["cursor", "codex", "openclaw"] {
            assert_eq!(none["agents"][id]["enabled"], false);
        }
        let explicit = apply(
            old.clone(),
            json!({"selectedAgents":"", "agentSelectionExplicit":"1", "probeResult":probes()}),
        )
        .unwrap();
        assert_eq!(explicit["agents"]["openclaw"]["enabled"], false);
        let all = apply(old, json!({"allAgentsMode":true})).unwrap();
        assert!(all["agents"]["cursor"].get("enabled").is_none());
        assert_eq!(all["agents"]["cursor"]["custom"], 1);
        assert!(apply(
            json!({}),
            json!({"selectedAgents":"unknown", "probeResult":probes()})
        )
        .is_err());
    }

    #[test]
    fn invalid_options_and_structural_corruption_are_not_silently_repaired() {
        for old in [json!([]), json!({"dashboard":false}), json!({"mask":"bad"})] {
            assert!(apply(old, json!({"maskMode":"all"})).is_err());
        }
        for opts in [
            json!({"dashboardPort":0}),
            json!({"dashboardPort":65536}),
            json!({"collectLog":"yes"}),
            json!({"multimodalMode":"image"}),
            json!({"excludeWorkspaces":["relative"]}),
            json!({"typo":"secret"}),
        ] {
            assert!(apply(json!({}), opts).is_err());
        }
    }

    #[test]
    fn diff_never_contains_credentials_or_user_supplied_values() {
        let old = json!({"cms":{"licenseKey":"old-secret"},"serviceNamePrefix":"old-prefix"});
        let next = apply(
            old.clone(),
            json!({"cmsLicenseKey":"new-secret", "serviceNamePrefix":"evil\\nvalue"}),
        )
        .unwrap();
        let diff = changed_fields(&old, &next);
        assert!(diff.contains("cms.licenseKey"));
        assert!(diff.contains("serviceNamePrefix"));
        for secret in ["old-secret", "new-secret", "old-prefix", "evil"] {
            assert!(!diff.contains(secret));
        }
    }
    #[test]
    fn dashboard_port_diff_requires_two_checked_ports_and_never_renders_other_numeric_fields() {
        for value in [
            json!(0),
            json!(-1),
            json!(65536),
            json!(1.5),
            json!(1e100),
            Value::Null,
            json!(true),
            json!("8765\nprivate-string-secret"),
            json!([8765,{"secret":"private-array-secret"}]),
            json!({"port":8765,"secret":"private-object-secret"}),
        ] {
            for (before, after) in [(json!(8765), value.clone()), (value, json!(9000))] {
                let diff = changed_fields(
                    &json!({"dashboard":{"port":before}}),
                    &json!({"dashboard":{"port":after}}),
                );
                assert_eq!(diff, "dashboard.port: 已变更（值不显示）");
            }
        }
        let before = json!({"dashboard":{"port":8765.0},"sls":{"accessKeySecret":12345}});
        let after = json!({"dashboard":{"port":9000},"sls":{"accessKeySecret":23456}});
        let diff = changed_fields(&before, &after);
        assert!(diff.contains("dashboard.port: 8765 -> 9000"));
        assert!(diff.contains("sls.accessKeySecret: 已变更（值不显示）"));
        assert!(!diff.contains("12345") && !diff.contains("23456"));
    }
}

#[cfg(test)]
#[path = "installer_config_history_tests.rs"]
mod installer_config_history_tests;
