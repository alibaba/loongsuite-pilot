//! Interceptor mode resolution.
//!
//! A nonblank `LOONGSUITE_PILOT_INTERCEPTOR_MODE` overrides config.json.

use crate::types::{
    InterceptorConfig, MaskConfig, MaskMode, MaskType, SUPPORTED_INTERCEPTOR_TYPES,
};
use crate::utils::{config_json_path, read_json_file, resolve_home};
use serde_json::Value;
use std::collections::HashSet;
use std::str::FromStr;

fn env_value(key: &str) -> Option<String> {
    process_env(key)
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn build_interceptor_config(value: Option<&Value>) -> InterceptorConfig {
    build_interceptor_config_with(value, env_value)
}

pub fn build_interceptor_config_with(
    value: Option<&Value>,
    env: impl Fn(&str) -> Option<String>,
) -> InterceptorConfig {
    let file = value.and_then(Value::as_object);
    let mode = non_blank(env("LOONGSUITE_PILOT_INTERCEPTOR_MODE")).or_else(|| {
        file.and_then(|obj| obj.get("mode"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    InterceptorConfig {
        mode: if mode.as_deref() == Some("all") {
            MaskMode::All
        } else {
            MaskMode::None
        },
        types: Vec::new(),
    }
}

pub fn should_deploy_interceptor_hooks(config: &InterceptorConfig) -> bool {
    config.mode == MaskMode::All
}

/// Keep credential masking enabled whenever managed interception is enabled.
pub fn ensure_mask_covers_interceptor(
    mask: &MaskConfig,
    interceptor: &InterceptorConfig,
) -> MaskConfig {
    if !should_deploy_interceptor_hooks(interceptor) || mask.mode == MaskMode::All {
        return mask.clone();
    }
    let current = if mask.mode == MaskMode::Custom {
        mask.types.clone()
    } else {
        Vec::new()
    };
    let extra = SUPPORTED_INTERCEPTOR_TYPES
        .iter()
        .filter_map(|name| MaskType::from_str(name).ok());
    let mut seen = HashSet::new();
    let types = current
        .into_iter()
        .chain(extra)
        .filter(|kind| seen.insert(*kind))
        .collect();
    MaskConfig {
        mode: MaskMode::Custom,
        types,
        replacement_mode: mask.replacement_mode,
    }
}

pub async fn load_interceptor_config(config_path: Option<&str>) -> InterceptorConfig {
    let path = match config_path {
        Some(path) => resolve_home(path),
        None => config_json_path(),
    };
    let file = read_json_file::<Value>(&path).await;
    let interceptor = file.as_ref().and_then(|value| value.get("interceptor"));
    build_interceptor_config(interceptor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn managed_interception_requires_all_and_ignores_retired_types() {
        for (value, enabled) in [
            (None, false),
            (Some(json!({"types":["apiKey"]})), false),
            (Some(json!({"mode":"none"})), false),
            (Some(json!({"mode":"custom","types":["apiKey"]})), false),
            (Some(json!({"mode":"invalid"})), false),
            (Some(json!({"mode":"all","types":["apiKey"]})), true),
        ] {
            let config = build_interceptor_config_with(value.as_ref(), |_| None);
            assert_eq!(should_deploy_interceptor_hooks(&config), enabled);
            assert!(config.types.is_empty());
        }
        let config = build_interceptor_config_with(Some(&json!({"mode":"all"})), |key| {
            (key == "LOONGSUITE_PILOT_INTERCEPTOR_MODE").then(|| " none ".into())
        });
        assert!(!should_deploy_interceptor_hooks(&config));
    }

    #[test]
    fn credential_masks_are_added_only_when_enabled() {
        let mask = MaskConfig {
            mode: MaskMode::Custom,
            types: vec![
                MaskType::from_str("idCard").unwrap(),
                MaskType::from_str("apiKey").unwrap(),
            ],
            replacement_mode: Some(crate::types::MaskReplacementMode::Preview),
        };
        let enabled = build_interceptor_config_with(Some(&json!({"mode":"all"})), |_| None);
        let got = ensure_mask_covers_interceptor(&mask, &enabled);
        assert_eq!(
            got.types
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
            [
                "idCard",
                "apiKey",
                "cloudAccessKey",
                "privateKey",
                "databaseUrl"
            ],
        );
        assert_eq!(got.replacement_mode, mask.replacement_mode);
        let disabled = build_interceptor_config_with(Some(&json!({"mode":"custom"})), |_| None);
        assert_eq!(
            ensure_mask_covers_interceptor(&mask, &disabled).types,
            mask.types
        );
    }
}
