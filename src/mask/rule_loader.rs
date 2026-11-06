//! Load and compile `sensitive-rules.json`.
//!
//! Search order matches the TypeScript locations:
//! 1. `src/mask/sensitive-rules.json` walking up from the working directory and the executable
//!    (the source-tree module that `rule-loader.ts` imports).
//! 2. The installed data directory, where the package is deployed:
//!    `{data}/versions/{current}/dist/sensitive-rules.json`,
//!    `{data}/package/dist/sensitive-rules.json`, and `{data}/dist/sensitive-rules.json`.
//!    `dist/sensitive-rules.json` is the copy `build.mjs` writes next to the program.
//! 3. `{exe}/dist/sensitive-rules.json` and `{exe}/../dist/sensitive-rules.json`.
//! 4. The packaged file compiled into the binary (`include_str!`), which is the same fallback
//!    as the TypeScript JSON import.

use super::types::{
    CompiledMaskRule, MaskConfig, MaskMode, MaskPlan, MaskReplacementMode, MaskRuleKind, MaskType,
    MaskTypeSet, PII_MASK_TYPES, SUPPORTED_MASK_TYPES,
};
use fancy_regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::OnceLock;

const PACKAGED_SENSITIVE_RULES: &str = include_str!("sensitive-rules.json");
const MANIFEST_ERROR: &str = "failed to load sensitive rule manifest, manifest rules disabled";

static CACHED_RULES: OnceLock<Vec<CompiledMaskRule>> = OnceLock::new();

pub fn load_sensitive_rules_from_manifest(manifest: &Value) -> Vec<CompiledMaskRule> {
    match compile_sensitive_rules(manifest) {
        Ok(rules) => rules,
        Err(err) => {
            log_manifest_error(&err);
            Vec::new()
        }
    }
}

pub fn load_sensitive_rules() -> Vec<CompiledMaskRule> {
    CACHED_RULES
        .get_or_init(load_sensitive_rules_uncached)
        .clone()
}

pub fn load_enabled_rules(config: &MaskConfig) -> Vec<CompiledMaskRule> {
    let enabled = resolve_enabled_mask_types(config);
    if !enabled.iter().any(is_manifest_type) {
        return Vec::new();
    }
    load_sensitive_rules()
        .into_iter()
        .filter(|rule| enabled.contains(rule.mask_type))
        .collect()
}

pub fn load_mask_plan(config: &MaskConfig) -> MaskPlan {
    let enabled = resolve_enabled_mask_types(config);
    let replacement_mode = config
        .replacement_mode
        .unwrap_or(MaskReplacementMode::Placeholder);
    if enabled.is_empty() {
        return MaskPlan {
            rules: Vec::new(),
            pii_types: MaskTypeSet::default(),
            replacement_mode,
        };
    }
    let rules = if enabled.iter().any(is_manifest_type) {
        load_sensitive_rules()
            .into_iter()
            .filter(|rule| enabled.contains(rule.mask_type))
            .collect()
    } else {
        Vec::new()
    };
    let mut pii_types = MaskTypeSet::default();
    for ty in enabled.iter() {
        if is_pii_type(ty) {
            pii_types.insert(ty);
        }
    }
    MaskPlan {
        rules,
        pii_types,
        replacement_mode,
    }
}

pub fn filter_rules_by_config(
    rules: &[CompiledMaskRule],
    config: &MaskConfig,
) -> Vec<CompiledMaskRule> {
    let enabled = resolve_enabled_mask_types(config);
    if enabled.is_empty() {
        return Vec::new();
    }
    rules
        .iter()
        .filter(|rule| enabled.contains(rule.mask_type))
        .cloned()
        .collect()
}

pub fn resolve_enabled_mask_types(config: &MaskConfig) -> MaskTypeSet {
    match config.mode {
        MaskMode::None => MaskTypeSet::default(),
        MaskMode::All => {
            let mut set = MaskTypeSet::default();
            for name in SUPPORTED_MASK_TYPES {
                if let Ok(ty) = MaskType::from_str(name) {
                    set.insert(ty);
                }
            }
            set
        }
        MaskMode::Custom => {
            let mut set = MaskTypeSet::default();
            for ty in &config.types {
                if SUPPORTED_MASK_TYPES.contains(&ty.as_str()) {
                    set.insert(*ty);
                }
            }
            set
        }
    }
}

pub fn compile_sensitive_rules(manifest: &Value) -> Result<Vec<CompiledMaskRule>, String> {
    let obj = manifest
        .as_object()
        .ok_or_else(|| "invalid sensitive rules manifest".to_string())?;
    let version = obj
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| "invalid sensitive rules manifest".to_string())?;
    if version != 1 {
        return Err("invalid sensitive rules manifest".to_string());
    }
    let rules = obj
        .get("rules")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid sensitive rules manifest".to_string())?;
    rules.iter().map(compile_rule).collect()
}

fn load_sensitive_rules_uncached() -> Vec<CompiledMaskRule> {
    let exe = std::env::current_exe().ok();
    let paths = candidate_paths(
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        exe.as_deref(),
        &default_data_dirs(),
    );
    load_rules_from_candidates(&paths)
}

fn load_rules_from_candidates(paths: &[PathBuf]) -> Vec<CompiledMaskRule> {
    for path in paths {
        if let Ok(text) = std::fs::read_to_string(path) {
            return compile_manifest_text(&text);
        }
    }
    compile_manifest_text(PACKAGED_SENSITIVE_RULES)
}

fn compile_manifest_text(text: &str) -> Vec<CompiledMaskRule> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => load_sensitive_rules_from_manifest(&value),
        Err(err) => {
            log_manifest_error(&err.to_string());
            Vec::new()
        }
    }
}

fn candidate_paths(cwd: &Path, exe: Option<&Path>, data_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    paths.extend(source_tree_paths(cwd));
    if let Some(exe) = exe {
        if let Some(dir) = exe.parent() {
            paths.extend(source_tree_paths(dir));
        }
    }
    for data_dir in data_dirs {
        paths.extend(installed_rules_paths(data_dir));
    }
    if let Some(exe) = exe {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("dist").join("sensitive-rules.json"));
            if let Some(parent) = dir.parent() {
                paths.push(parent.join("dist").join("sensitive-rules.json"));
            }
        }
    }
    dedup_paths(paths)
}

fn source_tree_paths(start: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut dir = Some(start);
    for _ in 0..12 {
        let Some(current) = dir else { break };
        paths.push(
            current
                .join("src")
                .join("mask")
                .join("sensitive-rules.json"),
        );
        dir = current.parent();
    }
    paths
}

fn installed_rules_paths(data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(current) = read_current_name(data_dir) {
        paths.push(
            data_dir
                .join("versions")
                .join(current)
                .join("dist")
                .join("sensitive-rules.json"),
        );
    }
    paths.push(
        data_dir
            .join("package")
            .join("dist")
            .join("sensitive-rules.json"),
    );
    paths.push(data_dir.join("dist").join("sensitive-rules.json"));
    paths
}

fn read_current_name(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(data_dir.join("current")).ok()?;
    let name = text.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    Some(name.to_string())
}

fn default_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = env_data_dir() {
        dirs.push(dir);
    }
    if let Some(home) = home_dir() {
        let dir = home.join(".loongsuite-pilot");
        if !dirs.iter().any(|existing| existing == &dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn env_data_dir() -> Option<PathBuf> {
    let value = std::env::var("LOONGSUITE_PILOT_DATA_DIR").ok()?;
    if value.is_empty() {
        return None;
    }
    Some(expand_tilde(PathBuf::from(value)))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if text == "~" {
        return home_dir().unwrap_or(path);
    }
    if let Some(rest) = text.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    path
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    }
    out
}

fn compile_rule(value: &Value) -> Result<CompiledMaskRule, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "invalid mask rule".to_string())?;
    let id = required_string(obj, "id").map_err(|_| "mask rule missing id".to_string())?;
    let type_name = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("mask rule {id} has unsupported type"))?;
    let mask_type = MaskType::from_str(type_name)
        .map_err(|_| format!("mask rule {id} has unsupported type"))?;
    if !SUPPORTED_MASK_TYPES.contains(&mask_type.as_str()) {
        return Err(format!("mask rule {id} has unsupported type"));
    }
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|kind| MaskRuleKind::from_str(kind).ok())
        .ok_or_else(|| format!("mask rule {id} has unsupported kind"))?;
    let replacement = required_string(obj, "replacement")
        .map_err(|_| format!("mask rule {id} missing replacement"))?;
    let prefilter_values = obj
        .get("prefilter")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("mask rule {id} missing prefilter"))?;
    if prefilter_values.is_empty() {
        return Err(format!("mask rule {id} missing prefilter"));
    }
    let prefilter = string_list(prefilter_values);
    let normalized_prefilter = normalize_prefilter(&prefilter);

    let base = |regex: Option<Regex>,
                block_regex: Option<Regex>,
                scheme_set: Option<HashSet<String>>,
                flags: Option<String>,
                pattern: Option<String>,
                begin_pattern: Option<String>,
                end_pattern: Option<String>,
                schemes: Option<Vec<String>>| CompiledMaskRule {
        id: id.clone(),
        mask_type,
        kind,
        replacement: replacement.clone(),
        prefilter: prefilter.clone(),
        pattern,
        flags,
        begin_pattern,
        end_pattern,
        schemes,
        regex,
        block_regex,
        scheme_set,
        normalized_prefilter: normalized_prefilter.clone(),
    };

    match kind {
        MaskRuleKind::Regex => {
            let pattern = required_string(obj, "pattern")
                .map_err(|_| format!("mask rule {id} missing pattern"))?;
            let flags = ensure_global_flag(obj.get("flags").and_then(Value::as_str).unwrap_or("g"));
            let translated = translate_js_pattern(&pattern, &flags);
            let regex = Regex::new(&translated)
                .map_err(|err| format!("failed to compile mask rule {id}: {err}"))?;
            Ok(base(
                Some(regex),
                None,
                None,
                Some(flags),
                Some(pattern),
                None,
                None,
                None,
            ))
        }
        MaskRuleKind::Block => {
            let begin = required_string(obj, "beginPattern")
                .map_err(|_| format!("mask rule {id} missing block pattern"))?;
            let end = required_string(obj, "endPattern")
                .map_err(|_| format!("mask rule {id} missing block pattern"))?;
            let pattern = format!("{begin}[\\s\\S]*?{end}");
            let block_regex = Regex::new(&translate_js_pattern(&pattern, ""))
                .map_err(|err| format!("failed to compile mask rule {id}: {err}"))?;
            Ok(base(
                None,
                Some(block_regex),
                None,
                None,
                None,
                Some(begin),
                Some(end),
                None,
            ))
        }
        MaskRuleKind::UrlWithPassword => {
            let schemes = obj
                .get("schemes")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("mask rule {id} missing schemes"))?;
            if schemes.is_empty() || schemes.iter().any(|scheme| scheme.as_str().is_none()) {
                return Err(format!("mask rule {id} missing schemes"));
            }
            let schemes: Vec<String> = schemes
                .iter()
                .filter_map(|scheme| scheme.as_str().map(str::to_string))
                .collect();
            let scheme_set = schemes.iter().map(|scheme| scheme.to_lowercase()).collect();
            Ok(base(
                None,
                None,
                Some(scheme_set),
                None,
                None,
                None,
                None,
                Some(schemes),
            ))
        }
    }
}

fn required_string(obj: &Map<String, Value>, key: &str) -> Result<String, ()> {
    match obj.get(key).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => Err(()),
    }
}

fn string_list(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn normalize_prefilter(prefilter: &[String]) -> Vec<String> {
    prefilter
        .iter()
        .filter(|keyword| !keyword.is_empty())
        .map(|keyword| keyword.to_lowercase())
        .collect()
}

fn ensure_global_flag(flags: &str) -> String {
    if flags.contains('g') {
        flags.to_string()
    } else {
        format!("{flags}g")
    }
}

fn translate_js_pattern(pattern: &str, flags: &str) -> String {
    let mut out = String::new();
    if flags.contains('i') {
        out.push_str("(?i)");
    }
    if flags.contains('m') {
        out.push_str("(?m)");
    }
    if flags.contains('s') {
        out.push_str("(?s)");
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\\' && chars.get(index + 1) == Some(&'b') {
            // fancy-regex does not accept the regex-crate `(?-u:\b)` group.
            // ASCII secrets still match Unicode `\b` the same way.
            out.push_str(r"\b");
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn is_manifest_type(ty: MaskType) -> bool {
    !is_pii_type(ty)
}

fn is_pii_type(ty: MaskType) -> bool {
    PII_MASK_TYPES.contains(&ty.as_str())
}

fn log_manifest_error(err: &str) {
    tracing::error!(
        target: "MaskRuleLoader",
        error = err,
        "{MANIFEST_ERROR}"
    );
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_paths, compile_sensitive_rules, load_enabled_rules, load_mask_plan,
        load_rules_from_candidates, load_sensitive_rules, load_sensitive_rules_from_manifest,
        resolve_enabled_mask_types, MaskConfig, MaskMode, MaskReplacementMode, MaskType,
        PII_MASK_TYPES, SUPPORTED_MASK_TYPES,
    };
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    fn capture_errors<T>(action: impl FnOnce() -> T) -> (T, Vec<Value>) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .json()
            .with_writer(file.reopen().unwrap())
            .finish();
        let result = tracing::subscriber::with_default(subscriber, action);
        let events = std::fs::read_to_string(file.path())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        (result, events)
    }

    fn assert_manifest_error(events: &[Value]) {
        assert!(
            events.iter().any(|event| {
                event["level"] == "ERROR"
                    && event["target"] == "MaskRuleLoader"
                    && event["fields"]["message"]
                        == "failed to load sensitive rule manifest, manifest rules disabled"
                    && event["fields"]["error"]
                        .as_str()
                        .is_some_and(|error| !error.is_empty())
            }),
            "缺少真实规则加载错误日志：{events:?}"
        );
    }

    fn all_config() -> MaskConfig {
        MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: None,
        }
    }

    #[test]
    fn loads_collector_mask_rules_from_the_manifest() {
        let rule_ids: Vec<String> = load_sensitive_rules()
            .into_iter()
            .map(|rule| rule.id)
            .collect();
        for id in [
            "cloudAccessKey.alicloud.accessKeyId",
            "cloudAccessKey.aws.accessKeyId",
            "cloudAccessKey.tencent.secretId",
            "apiKey.openaiCompatible",
            "apiKey.github",
            "privateKey.pem",
            "databaseUrl.withPassword",
            "databaseUrl.jdbcWithPassword",
        ] {
            assert!(rule_ids.iter().any(|rule_id| rule_id == id), "{id}");
        }
    }

    #[test]
    fn returns_all_rules_when_mask_mode_is_all() {
        let all_rules = load_sensitive_rules();
        let enabled = load_enabled_rules(&all_config());
        assert_eq!(enabled.len(), all_rules.len());
    }

    #[test]
    fn returns_only_selected_rule_types_when_mask_mode_is_custom() {
        let enabled = load_enabled_rules(&MaskConfig {
            mode: MaskMode::Custom,
            types: vec![MaskType::ApiKey],
            replacement_mode: None,
        });
        assert!(!enabled.is_empty());
        assert!(enabled
            .iter()
            .all(|rule| rule.mask_type == MaskType::ApiKey));
    }

    #[test]
    fn returns_no_rules_when_mask_mode_is_none() {
        let enabled = load_enabled_rules(&MaskConfig {
            mode: MaskMode::None,
            types: Vec::new(),
            replacement_mode: None,
        });
        assert!(enabled.is_empty());
    }

    #[test]
    fn builds_a_mask_plan_with_all_five_pii_detectors_in_all_mode() {
        let plan = load_mask_plan(&all_config());
        let pii: Vec<&str> = plan.pii_types.iter().map(|ty| ty.as_str()).collect();
        assert_eq!(pii.as_slice(), PII_MASK_TYPES);
        assert_eq!(plan.rules.len(), load_sensitive_rules().len());
        assert_eq!(plan.replacement_mode, MaskReplacementMode::Placeholder);
    }

    #[test]
    fn enables_every_type_from_the_canonical_supported_type_list_in_all_mode() {
        let enabled: Vec<&str> = resolve_enabled_mask_types(&all_config())
            .iter()
            .map(|ty| ty.as_str())
            .collect();
        assert_eq!(enabled.as_slice(), SUPPORTED_MASK_TYPES);
    }

    #[test]
    fn builds_a_custom_mask_plan_with_only_selected_pii_types() {
        let plan = load_mask_plan(&MaskConfig {
            mode: MaskMode::Custom,
            types: vec![MaskType::Email, MaskType::BankCard],
            replacement_mode: None,
        });
        let pii: Vec<&str> = plan.pii_types.iter().map(|ty| ty.as_str()).collect();
        assert_eq!(pii, vec!["email", "bankCard"]);
        assert!(plan.rules.is_empty());
    }

    #[test]
    fn keeps_database_url_prefilters_aligned_with_supported_database_schemes() {
        let rule = load_sensitive_rules()
            .into_iter()
            .find(|item| item.id == "databaseUrl.withPassword")
            .expect("database rule");
        assert_eq!(
            rule.normalized_prefilter,
            vec![
                "mysql://",
                "postgres://",
                "postgresql://",
                "mongodb://",
                "redis://",
            ]
        );
        assert!(!rule.normalized_prefilter.iter().any(|kw| kw == "://"));
        assert!(!rule.normalized_prefilter.iter().any(|kw| kw == "@"));
    }

    #[test]
    fn uses_password_specific_jdbc_prefilters() {
        let rule = load_sensitive_rules()
            .into_iter()
            .find(|item| item.id == "databaseUrl.jdbcWithPassword")
            .expect("jdbc rule");
        assert_eq!(rule.normalized_prefilter, vec!["password=", "pwd="]);
        assert!(!rule.normalized_prefilter.iter().any(|kw| kw == "jdbc:"));
    }

    #[test]
    fn rejects_invalid_regex_definitions() {
        let err = compile_sensitive_rules(&json!({
            "version": 1,
            "rules": [{
                "id": "broken.regex",
                "type": "apiKey",
                "kind": "regex",
                "replacement": "[APIKEY_MASKED]",
                "prefilter": ["sk-"],
                "pattern": "[",
                "flags": "g"
            }]
        }))
        .unwrap_err();
        assert!(err.contains("broken.regex"), "{err}");
    }

    #[test]
    fn disables_manifest_rules_but_keeps_builtin_pii_when_manifest_cannot_compile() {
        let (rules, events) = capture_errors(|| {
            load_sensitive_rules_from_manifest(&json!({"version": 2, "rules": []}))
        });
        assert!(rules.is_empty());
        assert_manifest_error(&events);
        let pii: Vec<&str> = load_mask_plan(&all_config())
            .pii_types
            .iter()
            .map(|ty| ty.as_str())
            .collect();
        assert_eq!(pii, ["idCard", "phone", "email", "ipAddress", "bankCard"]);
    }

    #[test]
    fn disables_manifest_rules_when_a_rule_definition_fails_to_compile() {
        let (rules, events) = capture_errors(|| {
            load_sensitive_rules_from_manifest(&json!({
                "version": 1,
                "rules": [{
                    "id": "broken.regex",
                    "type": "apiKey",
                    "kind": "regex",
                    "replacement": "[APIKEY_MASKED]",
                    "prefilter": ["sk-"],
                    "pattern": "[",
                    "flags": "g"
                }]
            }))
        });
        assert!(rules.is_empty());
        assert_manifest_error(&events);
        assert!(events.iter().any(|event| event["fields"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("broken.regex"))));
    }

    #[test]
    fn candidate_paths_cover_source_tree_and_installed_data_dir() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("current"), "1.2.0_abc\n").unwrap();
        let paths = candidate_paths(
            Path::new("/repo/loongsuite-pilot"),
            None,
            &[data.path().to_path_buf()],
        );
        assert!(paths
            .iter()
            .any(|path| path.ends_with("src/mask/sensitive-rules.json")));
        assert!(paths
            .iter()
            .any(|path| { path.ends_with("versions/1.2.0_abc/dist/sensitive-rules.json") }));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("package/dist/sensitive-rules.json")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("dist/sensitive-rules.json")));
        let source_pos = paths
            .iter()
            .position(|path| path.ends_with("src/mask/sensitive-rules.json"))
            .unwrap();
        let installed_pos = paths
            .iter()
            .position(|path| path.ends_with("versions/1.2.0_abc/dist/sensitive-rules.json"))
            .unwrap();
        assert!(source_pos < installed_pos);
    }

    #[test]
    fn loads_rules_from_the_first_existing_candidate_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("src/mask/sensitive-rules.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{
              "version": 1,
              "rules": [{
                "id": "from.file",
                "type": "apiKey",
                "kind": "regex",
                "replacement": "[APIKEY_MASKED]",
                "prefilter": ["sk-"],
                "pattern": "\\bsk-[A-Za-z0-9_-]{20,}\\b",
                "flags": "g"
              }]
            }"#,
        )
        .unwrap();
        let rules = load_rules_from_candidates(&[file, dir.path().join("missing.json")]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "from.file");
    }

    #[test]
    fn falls_back_to_the_packaged_manifest_when_no_file_exists() {
        let rules = load_rules_from_candidates(&[PathBuf::from("/no/such/sensitive-rules.json")]);
        assert!(rules
            .iter()
            .any(|rule| rule.id == "cloudAccessKey.alicloud.accessKeyId"));
    }

    #[test]
    fn invalid_on_disk_manifest_disables_manifest_rules() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sensitive-rules.json");
        std::fs::write(&file, "{\"version\":2,\"rules\":[]}").unwrap();
        let (rules, events) = capture_errors(|| load_rules_from_candidates(&[file]));
        assert!(rules.is_empty());
        assert_manifest_error(&events);
    }
}
