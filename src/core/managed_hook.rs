//! Full Pilot's local managed rules. SDK workers retain the Agent deadline and
//! the native output protocol. The host owns configuration and script processes.

use crate::interceptor::{HookEventName, HookRequest, InterceptorAgent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const MAX_CONFIG: u64 = 512 * 1024;
const MAX_RULES: usize = 128;
const RELOAD_PERIOD: Duration = Duration::from_secs(3);

pub(crate) struct ManagedHook {
    root: PathBuf,
    owner: Weak<super::InputManager>,
    state: Mutex<Cache>,
}

struct Cache {
    scanned: Option<Instant>,
    bytes: Vec<u8>,
    config_valid: bool,
    pending_scripts: usize,
    diagnostics: [u64; 6],
    rules: Arc<Rules>,
}

#[derive(Default)]
struct Rules {
    rules: Vec<(Common, Rule)>,
}

#[derive(Deserialize)]
struct Document {
    interceptor: RulesDocument,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulesDocument {
    rules: Vec<WireRule>,
    script_cache: Option<String>,
}

#[derive(Deserialize)]
struct WireRule {
    #[serde(flatten)]
    common: Common,
    #[serde(flatten)]
    rule: WireKind,
}

#[derive(Deserialize)]
struct Common {
    id: String,
    version: String,
    agents: Vec<InterceptorAgent>,
    events: Vec<HookEventName>,
    #[serde(default)]
    action: RuleAction,
    #[serde(default, deserialize_with = "present_enforcement")]
    enforcement: bool,
    severity: Option<String>,
    title: Option<String>,
    message: Option<String>,
}

fn present_enforcement<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(deserializer).map(|_| true)
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum RuleAction {
    #[default]
    Block,
    Log,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WireKind {
    Pattern {
        #[serde(rename = "match")]
        matcher: Matcher,
        pattern: String,
    },
    Script {
        shell: Shell,
    },
    Http {
        url: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Matcher {
    Substring,
    Regex,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Shell {
    Sh,
    Powershell,
}

enum Rule {
    Substring(String),
    Regex(regex::Regex),
    Script(Shell, PathBuf),
    Http,
    Skipped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hit<'a> {
    rule_id: &'a str,
    rule_version: &'a str,
    action: RuleAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    reason: String,
}

impl ManagedHook {
    pub(crate) fn new(data: &Path) -> Self {
        Self {
            owner: Weak::new(),
            root: std::fs::canonicalize(data)
                .unwrap_or_else(|_| data.to_owned())
                .join("configs")
                .join("managed"),
            state: Mutex::new(Cache {
                scanned: None,
                bytes: Vec::new(),
                config_valid: true,
                pending_scripts: 0,
                diagnostics: [0; 6],
                rules: Arc::new(Rules::default()),
            }),
        }
    }

    pub(super) fn with_owner(mut self, manager: &Arc<super::InputManager>) -> Self {
        self.owner = Arc::downgrade(manager);
        self
    }

    pub(super) fn monitoring(&self, initial: bool) -> (Value, Value) {
        if initial {
            self.snapshot();
        }
        let state = self.state.lock().unwrap();
        let mut pattern = 0;
        let mut regex = 0;
        let mut script = 0;
        let mut audit = 0;
        let mut enforce = 0;
        let mut http = 0;
        for (common, rule) in &state.rules.rules {
            match rule {
                Rule::Substring(_) => pattern += 1,
                Rule::Regex(_) => {
                    pattern += 1;
                    regex += 1;
                }
                Rule::Script(_, _) => script += 1,
                Rule::Http => {
                    http += 1;
                    continue;
                }
                Rule::Skipped => continue,
            }
            match common.action {
                RuleAction::Log => audit += 1,
                RuleAction::Block => enforce += 1,
            }
        }
        let diagnostics = crate::interceptor::status::DIAGNOSTIC_CODES
            .into_iter()
            .zip(state.diagnostics)
            .collect::<std::collections::BTreeMap<_, _>>();
        (
            json!({
                "configured":state.rules.rules.len(), "config_valid":state.config_valid,
                "effective":pattern+script, "pattern":pattern, "regex":regex,
                "substring":pattern-regex, "script":script, "audit":audit, "enforce":enforce,
                "pending_scripts":state.pending_scripts, "unsupported_http":http,
            }),
            json!(diagnostics),
        )
    }

    fn snapshot(&self) -> Arc<Rules> {
        let mut state = self.state.lock().unwrap();
        if state
            .scanned
            .is_some_and(|time| time.elapsed() < RELOAD_PERIOD)
        {
            return state.rules.clone();
        }
        state.scanned = Some(Instant::now());
        let path = self.root.join("interceptor.json");
        let update = read_config(&path);
        let mut fault = false;
        match update {
            Ok(bytes) if bytes != state.bytes => {
                state.pending_scripts = 0;
                let mut pending_scripts = 0;
                match Rules::parse(&bytes, &self.root, &mut pending_scripts) {
                    Ok(rules) => {
                        state.bytes = bytes;
                        state.rules = Arc::new(rules);
                        state.config_valid = true;
                    }
                    Err(error) => {
                        warn(&error.to_string());
                        fault = true;
                    }
                }
                state.pending_scripts = pending_scripts;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                state.config_valid = true;
                state.pending_scripts = 0;
                if !state.bytes.is_empty() {
                    state.bytes.clear();
                    state.rules = Arc::new(Rules::default());
                }
            }
            Err(error) => {
                warn(&error.to_string());
                fault = true;
            }
            Ok(_) => state.config_valid = true,
        }
        let rules = state.rules.clone();
        if fault {
            state.config_valid = false;
            state.diagnostics[0] += 1;
        }
        drop(state);
        if fault {
            self.report_fault(
                0,
                json!({
                    "code":"config_rejected", "source":"cache", "reason":"invalid_cached_config"
                }),
            );
        }
        rules
    }

    fn report_fault(&self, index: usize, payload: Value) {
        if let Some(owner) = self.owner.upgrade() {
            owner.record_interceptor_fault(index, &payload);
        }
    }

    pub(crate) async fn evaluate(&self, request: &HookRequest, remaining_ms: u32) -> Value {
        let budget = u64::from(remaining_ms).saturating_sub(100).min(2500);
        let deadline = Instant::now() + Duration::from_millis(budget);
        let snapshot = self.snapshot();
        let mut hits = Vec::new();
        let mut text = None;
        let mut failed = false;
        for (common, rule) in &snapshot.rules {
            if !common.agents.contains(&request.agent)
                || !common.events.contains(&request.event)
                || matches!(rule, Rule::Http | Rule::Skipped)
            {
                continue;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                failed = true;
                break;
            }
            let input = text.get_or_insert_with(|| hook_text(request));
            let reason = match rule {
                Rule::Substring(pattern) => input.contains(pattern).then(pattern_reason),
                Rule::Regex(regex) => {
                    let began = Instant::now();
                    let matched = regex.is_match(input);
                    let elapsed = began.elapsed();
                    let limit = remaining.min(Duration::from_millis(200));
                    let diagnostic = if elapsed >= limit {
                        failed = true;
                        Some((4, "regex_timeout", "match_exceeded_budget", limit))
                    } else if elapsed >= Duration::from_millis(50) {
                        Some((
                            3,
                            "regex_slow",
                            "match_above_threshold",
                            Duration::from_millis(50),
                        ))
                    } else {
                        None
                    };
                    if let Some((index, code, reason, limit)) = diagnostic {
                        self.state.lock().unwrap().diagnostics[index] += 1;
                        self.report_fault(
                            index,
                            json!({
                                "code":code, "source":"regex", "reason":reason,
                                "ruleId":common.id, "ruleVersion":common.version,
                                "durationMs":elapsed.as_secs_f64()*1000.0,
                                "limitMs":limit.as_secs_f64()*1000.0,
                            }),
                        );
                    }
                    (matched && elapsed < limit).then(pattern_reason)
                }
                Rule::Script(shell, script) => {
                    match run_script(*shell, script, input, remaining).await {
                        Ok(reason) => reason,
                        Err(error) => {
                            failed = true;
                            warn(&format!("Managed rule {} skipped: {error}", common.id));
                            None
                        }
                    }
                }
                Rule::Http | Rule::Skipped => unreachable!(),
            };
            if let Some(reason) = reason {
                let block = common.action == RuleAction::Block;
                hits.push(common.hit(reason));
                if block {
                    break;
                }
            }
        }
        let enforced = hits.last().filter(|hit| hit.action == RuleAction::Block);
        let representative = enforced.or_else(|| hits.first());
        let mut result = json!({
            "action":if enforced.is_some() { "block" } else { "allow" },
            "matches":hits,
        });
        if let Some(hit) = representative {
            result["matched"] = json!(true);
            result["ruleId"] = json!(hit.rule_id);
            result["ruleVersion"] = json!(hit.rule_version);
            result["reason"] = json!(hit.message.unwrap_or(hit.reason.as_str()));
        } else if !failed {
            result["matched"] = json!(false);
        }
        if failed && enforced.is_none() {
            result["failOpen"] = json!(true);
        }
        result
    }
}

impl Common {
    fn hit(&self, reason: String) -> Hit<'_> {
        Hit {
            rule_id: &self.id,
            rule_version: &self.version,
            action: self.action,
            severity: self.severity.as_deref(),
            title: self.title.as_deref(),
            message: self.message.as_deref(),
            reason,
        }
    }
}

impl Rules {
    fn parse(bytes: &[u8], root: &Path, pending_scripts: &mut usize) -> anyhow::Result<Self> {
        let doc = serde_json::from_slice::<Document>(bytes)?.interceptor;
        anyhow::ensure!(doc.rules.len() <= MAX_RULES, "Too many managed rules");
        let mut scripts = root.join("scripts");
        if let Some(namespace) = doc.script_cache {
            anyhow::ensure!(
                namespace.len() == 64
                    && namespace
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "Invalid managed script cache"
            );
            scripts.push(namespace);
        }
        let mut ids = HashSet::new();
        let mut rules = Vec::new();
        for WireRule { mut common, rule } in doc.rules {
            anyhow::ensure!(
                !common.enforcement,
                "Managed rules require action in place of enforcement"
            );
            anyhow::ensure!(
                safe_key(&common.id) && safe_key(&common.version) && ids.insert(common.id.clone()),
                "Invalid or duplicate managed rule identity"
            );
            anyhow::ensure!(
                !common.agents.is_empty() && !common.events.is_empty(),
                "Managed rules require Agent and event lists"
            );
            common.severity = bounded_label(common.severity, 128)?;
            common.title = bounded_label(common.title, 128)?;
            common.message = bounded_label(common.message, 2000)?;
            let compiled = match rule {
                WireKind::Pattern { matcher, pattern } => {
                    anyhow::ensure!(
                        !pattern.is_empty() && pattern.chars().count() <= 2000,
                        "Invalid managed pattern"
                    );
                    match matcher {
                        Matcher::Substring => Rule::Substring(pattern),
                        Matcher::Regex => Rule::Regex(
                            regex::RegexBuilder::new(&pattern)
                                .size_limit(512 * 1024)
                                .nest_limit(32)
                                .build()?,
                        ),
                    }
                }
                WireKind::Script { shell } => {
                    let extension = match (shell, cfg!(windows)) {
                        (Shell::Sh, false) => "sh",
                        (Shell::Powershell, true) => "ps1",
                        _ => {
                            rules.push((common, Rule::Skipped));
                            continue;
                        }
                    };
                    let script =
                        scripts.join(format!("{}@{}.{extension}", common.id, common.version));
                    match validate_file(&script) {
                        Ok(()) => Rule::Script(shell, script),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            *pending_scripts += 1;
                            Rule::Skipped
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                WireKind::Http { url } => {
                    let url = reqwest::Url::parse(&url)?;
                    anyhow::ensure!(
                        url.scheme() == "https"
                            && url.username().is_empty()
                            && url.password().is_none(),
                        "Invalid managed HTTPS placeholder"
                    );
                    warn("Managed HTTP rule is reserved for compatibility");
                    Rule::Http
                }
            };
            rules.push((common, compiled));
        }
        anyhow::ensure!(*pending_scripts == 0, "Managed scripts are not ready");
        Ok(Self { rules })
    }
}

fn bounded_label(label: Option<String>, max: usize) -> anyhow::Result<Option<String>> {
    let Some(label) = label else { return Ok(None) };
    let text = label.trim();
    anyhow::ensure!(
        !text.is_empty() && text.chars().count() <= max,
        "Invalid managed rule label"
    );
    Ok(Some(text.to_owned()))
}

fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn validate_file(path: &Path) -> io::Result<()> {
    for entry in path
        .ancestors()
        .take_while(|part| !part.as_os_str().is_empty())
    {
        let kind = std::fs::symlink_metadata(entry)?.file_type();
        if kind.is_symlink() || (entry == path && !kind.is_file()) {
            return Err(io::Error::other(
                "Managed rules require plain files with no symbolic links",
            ));
        }
    }
    Ok(())
}

fn read_config(path: &Path) -> io::Result<Vec<u8>> {
    validate_file(path)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err(io::Error::other("Managed config exceeds size limit"));
    }
    Ok(bytes)
}

fn hook_text(request: &HookRequest) -> String {
    fn push(text: &mut String, value: &str) {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(value);
    }
    fn collect(text: &mut String, value: &Value) {
        match value {
            Value::String(value) => push(text, value),
            Value::Array(values) => values.iter().for_each(|value| collect(text, value)),
            Value::Object(values) => values.values().for_each(|value| collect(text, value)),
            Value::Number(_) | Value::Bool(_) => push(text, &value.to_string()),
            Value::Null => {}
        }
    }
    let mut text = String::new();
    for value in [request.prompt.as_deref(), request.tool_name.as_deref()]
        .into_iter()
        .flatten()
    {
        push(&mut text, value);
    }
    for value in [request.tool_input.as_ref(), request.tool_response.as_ref()]
        .into_iter()
        .flatten()
    {
        collect(&mut text, value);
    }
    text
}

fn pattern_reason() -> String {
    "[PATTERN_BLOCKED]".to_owned()
}

async fn run_script(
    shell: Shell,
    path: &Path,
    text: &str,
    remaining: Duration,
) -> io::Result<Option<String>> {
    validate_file(path)?;
    let mut command = match shell {
        Shell::Sh => tokio::process::Command::new("/bin/sh"),
        Shell::Powershell => {
            let system = std::env::var_os("SystemRoot")
                .ok_or_else(|| io::Error::other("Missing SystemRoot"))?;
            let mut command = tokio::process::Command::new(
                PathBuf::from(system)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
            );
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]);
            command
        }
    };
    command.arg(path).env_clear();
    for name in [
        "HOME",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "SystemRoot",
        "WINDIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let input = json!({ "prompt": text }).to_string();
    let input = if cfg!(windows) {
        input
            .chars()
            .flat_map(|character| {
                if character.is_ascii() {
                    character.to_string().into_bytes()
                } else {
                    character
                        .encode_utf16(&mut [0; 2])
                        .iter()
                        .flat_map(|unit| format!("\\u{unit:04x}").into_bytes())
                        .collect()
                }
            })
            .collect()
    } else {
        input.into_bytes()
    };
    let output = crate::utils::candidate_process::output_with_input(
        &mut command,
        remaining,
        16 * 1024,
        Some(&input),
    )
    .await?;
    if !output.status.success() {
        return Err(io::Error::other("Managed script execution failed"));
    }
    let body: Value = serde_json::from_slice(&output.stdout)?;
    match body["matched"].as_bool() {
        Some(false) => Ok(None),
        Some(true) => body["reason"]
            .as_str()
            .map(|value| Some(value.chars().take(512).collect()))
            .ok_or_else(|| io::Error::other("Managed script requires a reason")),
        None => Err(io::Error::other("Managed script requires matched")),
    }
}

fn warn(message: &str) {
    super::logger("ManagedHook").warn(message, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_legacy_audit_instead_of_defaulting_to_block() {
        let root = tempfile::tempdir().unwrap();
        let body = json!({"interceptor":{"rules":[{
            "id":"previous-audit", "kind":"pattern", "version":"1",
            "agents":["qodercli"], "events":["PreToolUse"], "match":"substring",
            "pattern":"keyword", "enforcement":"audit"
        }]}});
        assert!(Rules::parse(body.to_string().as_bytes(), root.path(), &mut 0).is_err());
    }

    #[tokio::test]
    async fn managed_severity_ignores_extensions_and_reports_each_matching_rule() {
        let data = tempfile::tempdir().unwrap();
        let config = data.path().join("configs/managed");
        std::fs::create_dir_all(&config).unwrap();
        let common = json!({
            "kind":"pattern","version":"1", "agents":["qodercli"], "events":["PreToolUse"],
            "match":"substring","pattern":"fixture-match", "extension":{"future":true},
        });
        let mut audit = common.clone();
        audit["id"] = json!("review");
        audit["action"] = json!("log");
        audit["severity"] = json!(" NOTICE ");
        let mut enforce = common;
        enforce["id"] = json!("stop");
        enforce["severity"] = json!("HIGH");
        std::fs::write(
            config.join("interceptor.json"),
            json!({
                "extension":true, "interceptor":{"rules":[audit,enforce],"extension":[]},
            })
            .to_string(),
        )
        .unwrap();
        let engine = ManagedHook::new(data.path());
        let request: HookRequest = serde_json::from_value(json!({
            "agent":"qodercli","event":"PreToolUse", "toolInput":{"a":["fixture-match",true]},
        }))
        .unwrap();
        let result = engine.evaluate(&request, 2500).await;
        assert_eq!(result["action"], "block");
        assert_eq!(result["matches"][0]["action"], "log");
        assert_eq!(result["matches"][0]["severity"], "NOTICE");
        assert_eq!(result["ruleId"], "stop");
        assert_eq!(result["matches"][1]["severity"], "HIGH");
        std::fs::write(config.join("interceptor.json"), b"invalid configuration").unwrap();
        engine.state.lock().unwrap().scanned = None;
        assert_eq!(engine.evaluate(&request, 2500).await, result);
    }
}
