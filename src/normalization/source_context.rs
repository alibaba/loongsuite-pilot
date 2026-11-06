use regex::Regex;
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::sync::LazyLock;

static HTTPS_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https?://([^/]+)").expect("https host"));
static SSH_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@]+@([^:]+)").expect("ssh host"));
static HTTPS_REPO_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https?://[^/]+/").expect("https repo prefix"));
static SOURCE_SSH_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@]+@[^:]+[:/]").expect("source ssh prefix"));
static GIT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.git$").expect("git suffix"));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("whitespace"));
static PATH_DECORATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^['"]|['",;)]$"#).expect("path decoration"));

#[derive(Debug, Clone, Default)]
pub struct SourceContextInput {
    pub repo: Option<Value>,
    pub branch: Option<Value>,
    pub domain: Option<Value>,
    pub cwd: Option<Value>,
    pub workspace_roots: Option<Value>,
    pub absolute_paths: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedSourceContext {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub current_root: Option<String>,
    pub domain: Option<String>,
}

pub fn normalize_source_context(input: &SourceContextInput) -> NormalizedSourceContext {
    let cwd = normalize_string(input.cwd.as_ref());
    let roots = normalize_string_array(input.workspace_roots.as_ref());
    let absolute_paths = input
        .absolute_paths
        .iter()
        .flat_map(|value| normalize_string_array(Some(value)))
        .filter(|path| is_source_absolute(path))
        .collect::<Vec<_>>();

    NormalizedSourceContext {
        repo: normalize_repo(input.repo.as_ref()),
        branch: normalize_string(input.branch.as_ref()),
        domain: normalize_string(input.domain.as_ref()),
        current_root: select_current_root(cwd.as_deref(), &roots, &absolute_paths),
    }
}

pub fn source_fields_from_context(context: &NormalizedSourceContext) -> Map<String, Value> {
    let mut fields = Map::new();
    push_nonempty(&mut fields, "git.repo", context.repo.as_deref());
    push_nonempty(&mut fields, "git.branch", context.branch.as_deref());
    push_nonempty(&mut fields, "git.domain", context.domain.as_deref());
    push_nonempty(
        &mut fields,
        "workspace.current_root",
        context.current_root.as_deref(),
    );
    fields
}

pub fn pick_first_value<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().flatten().find(|value| match value {
        Value::Null => false,
        Value::String(text) if text.is_empty() => false,
        _ => true,
    })
}

pub fn read_record_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        match current {
            Value::Object(map) => current = map.get(part)?,
            _ => return None,
        }
    }
    Some(current)
}

pub fn collect_absolute_path_values(value: &Value) -> Vec<String> {
    let mut out = BTreeSet::new();
    collect_absolute_path_values_into(value, &mut out, 0);
    out.into_iter().collect()
}

fn collect_absolute_path_values_into(value: &Value, out: &mut BTreeSet<String>, depth: usize) {
    if depth > 6 || value.is_null() {
        return;
    }
    match value {
        Value::String(text) => {
            for candidate in WHITESPACE.split(text) {
                let cleaned = PATH_DECORATION.replace_all(candidate, "");
                if is_source_absolute(&cleaned) {
                    out.insert(cleaned.into_owned());
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_absolute_path_values_into(item, out, depth + 1);
            }
        }
        Value::Object(map) => {
            for nested in map.values() {
                collect_absolute_path_values_into(nested, out, depth + 1);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub fn normalize_domain(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|value| !value.is_empty())?;
    if let Some(caps) = HTTPS_HOST.captures(raw) {
        return caps.get(1).map(|host| host.as_str().to_string());
    }
    if let Some(caps) = SSH_HOST.captures(raw) {
        return caps.get(1).map(|host| host.as_str().to_string());
    }
    None
}

fn normalize_repo(value: Option<&Value>) -> Option<String> {
    let raw = normalize_string(value)?;
    let without_https = HTTPS_REPO_PREFIX.replace(&raw, "");
    let without_ssh = SOURCE_SSH_PREFIX.replace(&without_https, "");
    let without_git = GIT_SUFFIX.replace(&without_ssh, "");
    Some(without_git.trim_matches('/').to_string())
}

fn normalize_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_string_array(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn select_current_root(
    cwd: Option<&str>,
    roots: &[String],
    absolute_paths: &[String],
) -> Option<String> {
    let mut normalized_roots = Vec::new();
    for root in roots {
        let stripped = strip_trailing_slash(root);
        if !stripped.is_empty()
            && !normalized_roots
                .iter()
                .any(|existing| existing == &stripped)
        {
            normalized_roots.push(stripped);
        }
    }
    if normalized_roots.is_empty() {
        return None;
    }

    let mut candidates = Vec::new();
    if let Some(cwd) = cwd {
        if is_source_absolute(cwd) {
            candidates.push(cwd.to_string());
        }
    }
    for path in absolute_paths {
        if is_source_absolute(path) {
            candidates.push(path.clone());
        }
    }
    for candidate in &candidates {
        if let Some(root) = longest_containing_root(candidate, &normalized_roots) {
            return Some(root);
        }
    }
    if normalized_roots.len() == 1 {
        return Some(normalized_roots.remove(0));
    }
    None
}

fn longest_containing_root(value: &str, roots: &[String]) -> Option<String> {
    let normalized_value = strip_trailing_slash(value);
    let mut matches = roots
        .iter()
        .filter(|root| {
            normalized_value == root.as_str() || normalized_value.starts_with(&format!("{root}/"))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|root| std::cmp::Reverse(root.len()));
    matches.first().map(|root| (*root).clone())
}

fn is_source_absolute(value: &str) -> bool {
    value.starts_with('/')
}

fn strip_trailing_slash(value: &str) -> String {
    let stripped = value.trim_end_matches('/');
    if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    }
}

fn push_nonempty(fields: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(text) = value {
        if !text.is_empty() {
            fields.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_repo_branch_and_current_root_from_cwd_plus_multiple_roots() {
        let context = normalize_source_context(&SourceContextInput {
            repo: Some(json!("https://github.com/example-org/loongsuite-pilot.git")),
            branch: Some(json!("feature/batch")),
            cwd: Some(json!("/Users/yutao/workspace/sls/loongsuite-pilot/src")),
            workspace_roots: Some(json!([
                "/Users/yutao/workspace",
                "/Users/yutao/workspace/sls/loongsuite-pilot"
            ])),
            ..SourceContextInput::default()
        });

        assert_eq!(
            context.repo.as_deref(),
            Some("example-org/loongsuite-pilot")
        );
        assert_eq!(context.branch.as_deref(), Some("feature/batch"));
        assert_eq!(
            context.current_root.as_deref(),
            Some("/Users/yutao/workspace/sls/loongsuite-pilot")
        );
        assert_eq!(context.domain, None);
    }

    #[test]
    fn selects_current_root_from_absolute_tool_paths_when_cwd_is_unavailable() {
        let context = normalize_source_context(&SourceContextInput {
            workspace_roots: Some(json!(["/repo-a", "/repo-b"])),
            absolute_paths: vec![json!("/repo-b/src/index.ts")],
            ..SourceContextInput::default()
        });
        assert_eq!(context.current_root.as_deref(), Some("/repo-b"));
    }

    #[test]
    fn does_not_promote_raw_cwd_to_current_root_without_workspace_roots() {
        let context = normalize_source_context(&SourceContextInput {
            cwd: Some(json!("/repo/subdir")),
            ..SourceContextInput::default()
        });
        assert_eq!(context.current_root, None);
    }

    #[test]
    fn projects_normalized_source_fields_without_raw_cwd() {
        let fields = source_fields_from_context(&NormalizedSourceContext {
            repo: Some("sls/loongsuite-pilot".to_string()),
            branch: Some("main".to_string()),
            current_root: Some("/repo".to_string()),
            domain: None,
        });
        assert_eq!(
            fields.get("git.repo").and_then(Value::as_str),
            Some("sls/loongsuite-pilot")
        );
        assert_eq!(
            fields.get("git.branch").and_then(Value::as_str),
            Some("main")
        );
        assert_eq!(
            fields.get("workspace.current_root").and_then(Value::as_str),
            Some("/repo")
        );
        assert_eq!(fields.len(), 3);
    }
}
