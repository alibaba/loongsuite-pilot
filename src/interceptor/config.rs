//! Interceptor mode resolution.
//!
//! `LOONGSUITE_PILOT_INTERCEPTOR_MODE` and `LOONGSUITE_PILOT_INTERCEPTOR_TYPES`
//! override the `interceptor` object in config.json. Blank env values are unset.

use crate::types::{
    InterceptorConfig, InterceptorType, MaskConfig, MaskMode, MaskType, SUPPORTED_INTERCEPTOR_TYPES,
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

fn parse_interceptor_types(value: TypesInput<'_>) -> Vec<InterceptorType> {
    let mut out = Vec::new();
    match value {
        TypesInput::List(items) => {
            for item in items {
                push_type(&mut out, item);
            }
        }
        TypesInput::Csv(text) => {
            for item in text.split(',') {
                push_type(&mut out, item);
            }
        }
    }
    out
}

fn push_type(out: &mut Vec<InterceptorType>, raw: &str) {
    let trimmed = raw.trim();
    if let Ok(kind) = MaskType::from_str(trimmed) {
        if SUPPORTED_INTERCEPTOR_TYPES.contains(&kind.as_str()) {
            out.push(kind);
        }
    }
}

enum TypesInput<'a> {
    List(Vec<&'a str>),
    Csv(&'a str),
}

fn as_types_input(value: Option<&Value>) -> Option<TypesInput<'_>> {
    match value {
        Some(Value::Array(items)) => Some(TypesInput::List(
            items.iter().filter_map(Value::as_str).collect(),
        )),
        Some(Value::String(text)) => Some(TypesInput::Csv(text)),
        _ => None,
    }
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
    let mode = match mode.as_deref() {
        Some("all") => MaskMode::All,
        Some("custom") => MaskMode::Custom,
        Some("none") => MaskMode::None,
        _ => {
            return InterceptorConfig {
                mode: MaskMode::None,
                types: Vec::new(),
            };
        }
    };
    if mode != MaskMode::Custom {
        return InterceptorConfig {
            mode,
            types: Vec::new(),
        };
    }
    let types = if let Some(raw) = non_blank(env("LOONGSUITE_PILOT_INTERCEPTOR_TYPES")) {
        parse_interceptor_types(TypesInput::Csv(&raw))
    } else if let Some(input) = as_types_input(file.and_then(|obj| obj.get("types"))) {
        parse_interceptor_types(input)
    } else {
        Vec::new()
    };
    InterceptorConfig {
        mode: MaskMode::Custom,
        types,
    }
}

/// Credential types enabled for interception are also mask types.
pub fn ensure_mask_covers_interceptor(
    mask: &MaskConfig,
    interceptor: &InterceptorConfig,
) -> MaskConfig {
    let extra: Vec<MaskType> = match interceptor.mode {
        MaskMode::All => SUPPORTED_INTERCEPTOR_TYPES
            .iter()
            .filter_map(|name| MaskType::from_str(name).ok())
            .collect(),
        MaskMode::Custom => interceptor
            .types
            .iter()
            .copied()
            .filter(|kind| SUPPORTED_INTERCEPTOR_TYPES.contains(&kind.as_str()))
            .collect(),
        MaskMode::None => Vec::new(),
    };
    if extra.is_empty() || mask.mode == MaskMode::All {
        return mask.clone();
    }
    let current = if mask.mode == MaskMode::Custom {
        mask.types.clone()
    } else {
        Vec::new()
    };
    let mut types = Vec::new();
    let mut seen = HashSet::new();
    for kind in current.into_iter().chain(extra) {
        if seen.insert(kind) {
            types.push(kind);
        }
    }
    MaskConfig {
        mode: MaskMode::Custom,
        types,
        replacement_mode: mask.replacement_mode,
    }
}

pub fn resolve_enabled_interceptor_types(config: &InterceptorConfig) -> HashSet<InterceptorType> {
    match config.mode {
        MaskMode::None => HashSet::new(),
        MaskMode::All => SUPPORTED_INTERCEPTOR_TYPES
            .iter()
            .filter_map(|name| MaskType::from_str(name).ok())
            .collect(),
        MaskMode::Custom => config
            .types
            .iter()
            .copied()
            .filter(|kind| SUPPORTED_INTERCEPTOR_TYPES.contains(&kind.as_str()))
            .collect(),
    }
}

pub fn resolve_enabled_rule_ids(config: &InterceptorConfig) -> HashSet<String> {
    resolve_enabled_interceptor_types(config)
        .into_iter()
        .map(|kind| kind.as_str().to_string())
        .collect()
}

pub fn is_rule_enabled(config: &InterceptorConfig, rule_id: &str) -> bool {
    MaskType::from_str(rule_id)
        .map(|kind| resolve_enabled_interceptor_types(config).contains(&kind))
        .unwrap_or(false)
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
    use crate::types::{
        InterceptorConfig, MaskMode, MaskReplacementMode, MaskType, SUPPORTED_INTERCEPTOR_TYPES,
    };
    use serde_json::{json, Value};

    fn none_env(_: &str) -> Option<String> {
        None
    }

    fn cfg(value: Value) -> InterceptorConfig {
        build_interceptor_config_with(Some(&value), none_env)
    }

    #[test]
    fn defaults_to_none_when_interceptor_config_is_missing() {
        let expected = InterceptorConfig {
            mode: MaskMode::None,
            types: vec![],
        };
        assert_eq!(build_interceptor_config_with(None, none_env), expected);
        assert_eq!(
            build_interceptor_config_with(Some(&Value::Null), none_env),
            expected
        );
        assert_eq!(
            build_interceptor_config_with(Some(&json!([])), none_env),
            expected
        );
    }

    #[test]
    fn defaults_to_none_when_mode_is_missing() {
        assert_eq!(
            cfg(json!({"types": ["apiKey"]})),
            InterceptorConfig {
                mode: MaskMode::None,
                types: vec![],
            }
        );
    }

    #[test]
    fn loads_all_mode_and_ignores_types() {
        assert_eq!(
            cfg(json!({"mode": "all", "types": ["apiKey"]})),
            InterceptorConfig {
                mode: MaskMode::All,
                types: vec![],
            }
        );
    }

    #[test]
    fn loads_custom_mode_with_interceptor_types_only() {
        let built = cfg(json!({
            "mode": "custom",
            "types": ["apiKey", "cloudAccessKey", "idCard", "phone", "email", "ipAddress", "bankCard", "databaseUrl", "privateKey"]
        }));
        assert_eq!(built.mode, MaskMode::Custom);
        assert_eq!(
            built
                .types
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
            vec!["apiKey", "cloudAccessKey", "databaseUrl", "privateKey"]
        );
    }

    #[test]
    fn treats_invalid_mode_as_none() {
        assert_eq!(
            cfg(json!({"mode": "audit", "types": ["apiKey"]})),
            InterceptorConfig {
                mode: MaskMode::None,
                types: vec![]
            }
        );
    }

    #[test]
    fn custom_mode_with_empty_types_enables_nothing() {
        for value in [
            json!({"mode":"custom"}),
            json!({"mode":"custom","types":[]}),
        ] {
            assert_eq!(
                cfg(value),
                InterceptorConfig {
                    mode: MaskMode::Custom,
                    types: vec![]
                }
            );
        }
    }

    #[test]
    fn uses_interceptor_mode_env_over_config_value() {
        let built = build_interceptor_config_with(
            Some(&json!({"mode": "none", "types": ["apiKey"]})),
            |key| (key == "LOONGSUITE_PILOT_INTERCEPTOR_MODE").then(|| "all".to_string()),
        );
        assert_eq!(built.mode, MaskMode::All);
        assert!(built.types.is_empty());
    }

    #[test]
    fn uses_interceptor_types_env_for_custom_mode() {
        let built = build_interceptor_config_with(
            Some(&json!({"mode": "custom", "types": ["apiKey"]})),
            |key| match key {
                "LOONGSUITE_PILOT_INTERCEPTOR_MODE" => Some("custom".to_string()),
                "LOONGSUITE_PILOT_INTERCEPTOR_TYPES" => {
                    Some("cloudAccessKey,idCard,databaseUrl,phone,privateKey".to_string())
                }
                _ => None,
            },
        );
        assert_eq!(built.mode, MaskMode::Custom);
        assert_eq!(
            built
                .types
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
            vec!["cloudAccessKey", "databaseUrl", "privateKey"]
        );
    }

    #[test]
    fn resolves_enabled_types_from_mode() {
        assert!(resolve_enabled_interceptor_types(&InterceptorConfig {
            mode: MaskMode::None,
            types: vec![MaskType::ApiKey],
        })
        .is_empty());
        assert_eq!(
            resolve_enabled_interceptor_types(&InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey]
            }),
            HashSet::from([MaskType::ApiKey])
        );
        let all = resolve_enabled_rule_ids(&InterceptorConfig {
            mode: MaskMode::All,
            types: vec![],
        });
        let mut names: Vec<_> = all.iter().cloned().collect();
        names.sort();
        let mut expected: Vec<_> = SUPPORTED_INTERCEPTOR_TYPES
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        expected.sort();
        assert_eq!(names, expected);
        assert!(is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey],
            },
            "apiKey"
        ));
    }

    #[test]
    fn treats_empty_interceptor_env_values_as_unset() {
        let built =
            build_interceptor_config_with(Some(&json!({"mode": "all", "types": []})), |key| {
                (key == "LOONGSUITE_PILOT_INTERCEPTOR_MODE").then(|| "  ".to_string())
            });
        assert_eq!(
            built,
            InterceptorConfig {
                mode: MaskMode::All,
                types: vec![]
            }
        );

        let built = build_interceptor_config_with(
            Some(&json!({"mode": "custom", "types": ["apiKey"]})),
            |key| match key {
                "LOONGSUITE_PILOT_INTERCEPTOR_MODE" => Some("custom".to_string()),
                "LOONGSUITE_PILOT_INTERCEPTOR_TYPES" => Some(String::new()),
                _ => None,
            },
        );
        assert_eq!(
            built,
            InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey]
            }
        );
    }

    #[test]
    fn unions_enabled_interceptor_types_into_a_mask_plan() {
        let covered = ensure_mask_covers_interceptor(
            &MaskConfig {
                mode: MaskMode::None,
                types: vec![],
                replacement_mode: Some(MaskReplacementMode::Placeholder),
            },
            &InterceptorConfig {
                mode: MaskMode::All,
                types: vec![],
            },
        );
        assert_eq!(covered.mode, MaskMode::Custom);
        assert_eq!(
            covered
                .types
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
            SUPPORTED_INTERCEPTOR_TYPES.to_vec()
        );
        assert_eq!(
            covered.replacement_mode,
            Some(MaskReplacementMode::Placeholder)
        );

        let merged = ensure_mask_covers_interceptor(
            &MaskConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::Email],
                replacement_mode: Some(MaskReplacementMode::Placeholder),
            },
            &InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey],
            },
        );
        assert_eq!(
            merged,
            MaskConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::Email, MaskType::ApiKey],
                replacement_mode: Some(MaskReplacementMode::Placeholder),
            }
        );

        let all_mask = MaskConfig {
            mode: MaskMode::All,
            types: vec![],
            replacement_mode: None,
        };
        assert_eq!(
            ensure_mask_covers_interceptor(
                &all_mask,
                &InterceptorConfig {
                    mode: MaskMode::All,
                    types: vec![],
                }
            ),
            all_mask
        );
        let none_mask = MaskConfig {
            mode: MaskMode::None,
            types: vec![],
            replacement_mode: None,
        };
        assert_eq!(
            ensure_mask_covers_interceptor(
                &none_mask,
                &InterceptorConfig {
                    mode: MaskMode::None,
                    types: vec![],
                }
            ),
            none_mask
        );
    }

    #[test]
    fn treats_missing_and_disabled_types_as_bypass() {
        assert!(!is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::None,
                types: vec![],
            },
            "apiKey"
        ));
        assert!(!is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![],
            },
            "apiKey"
        ));
        assert!(!is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::PrivateKey],
            },
            "apiKey"
        ));
        assert!(is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey],
            },
            "apiKey"
        ));
        assert!(is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::All,
                types: vec![],
            },
            "apiKey"
        ));
        assert!(!is_rule_enabled(
            &InterceptorConfig {
                mode: MaskMode::All,
                types: vec![],
            },
            "idCard"
        ));
    }
}
