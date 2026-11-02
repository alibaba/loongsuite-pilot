//! Restores hooks and shell intercepts that another tool overwrote.
//! Port of `hook-watchdog.ts`.

use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;

use crate::deployment::runtime_retirement as retirement;

use crate::types::HookWatchdogConfig;
use crate::utils::{file_exists, read_json_document, JsonDocumentRead, JsonSyntax};

use super::{fields, logger};

const STARTUP_DELAY_MS: u64 = 30_000;
const MAX_INTERCEPT_REPAIRS_PER_DAY: u32 = 3;
const MARKER_BEGIN_PREFIX: &str = "loongsuite-pilot BEGIN ";

pub type BoxFut<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;
/// False is an observed unsuccessful/healthy decision; Err is a failed operation.
/// Callers can retry a failed inspection without accepting its file signature.
pub type PluginAction = Arc<dyn Fn() -> BoxFut<Result<bool, String>> + Send + Sync>;
pub type InterceptAction = Arc<dyn Fn() -> BoxFut<Result<(), String>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerBlock {
    pub text: String,
    pub terminated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetStatus {
    Healthy,
    Repaired,
    Cooldown,
    Unavailable,
    InvalidConfig,
    RepairFailed,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetResult {
    pub agent_id: String,
    pub status: TargetStatus,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CheckResult {
    pub checked: u64,
    pub repaired: u64,
    pub skipped: u64,
}

pub struct PluginCheckTarget {
    pub agent_id: String,
    pub settings_path: String,
    pub settings_syntax: JsonSyntax,
    pub expected_hooks: Vec<String>,
    pub markers: Vec<String>,
    pub bin_path: Option<String>,
    pub install_args: Vec<String>,
    pub repair_fn: Option<PluginAction>,
    pub change_watch_path: Option<String>,
    pub needs_repair_on_change: Option<PluginAction>,
    pub enabled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

pub struct InterceptCheckTarget {
    pub id: String,
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub precondition: Arc<dyn Fn() -> BoxFut<bool> + Send + Sync>,
    pub check: Arc<dyn Fn() -> BoxFut<bool> + Send + Sync>,
    pub repair: InterceptAction,
    pub cleanup: Option<InterceptAction>,
}

pub struct HookWatchdog {
    config: HookWatchdogConfig,
    targets: Vec<PluginCheckTarget>,
    intercept_targets: Vec<InterceptCheckTarget>,
    last_repair_at: Mutex<HashMap<String, i64>>,
    last_change_signature: Mutex<HashMap<String, String>>,
    last_invalid: Mutex<HashMap<String, String>>,
    daily_repair_count: Mutex<HashMap<String, u32>>,
    daily_repair_reset_date: Mutex<String>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    lifecycle_generation: AtomicU64,
    startup: Mutex<Option<JoinHandle<()>>>,
    interval: Mutex<Option<JoinHandle<()>>>,
}

impl HookWatchdog {
    pub fn new(
        config: HookWatchdogConfig,
        targets: Vec<PluginCheckTarget>,
        intercept_targets: Vec<InterceptCheckTarget>,
    ) -> Self {
        let watchdog = Self {
            config,
            targets,
            intercept_targets,
            last_repair_at: Mutex::new(HashMap::new()),
            last_change_signature: Mutex::new(HashMap::new()),
            last_invalid: Mutex::new(HashMap::new()),
            daily_repair_count: Mutex::new(HashMap::new()),
            daily_repair_reset_date: Mutex::new(String::new()),
            now_ms: Arc::new(now_ms),
            lifecycle_generation: AtomicU64::new(0),
            startup: Mutex::new(None),
            interval: Mutex::new(None),
        };
        watchdog.capture_initial_signatures();
        watchdog
    }

    pub fn set_now_ms(&mut self, now_ms: impl Fn() -> i64 + Send + Sync + 'static) {
        self.now_ms = Arc::new(now_ms);
    }

    pub fn start(self: &Arc<Self>) {
        if !self.config.enabled {
            logger("HookWatchdog").info("hook-watchdog disabled", None);
            return;
        }
        let generation = self
            .lifecycle_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let this = Arc::clone(self);
        *self.startup.lock().expect("startup") = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STARTUP_DELAY_MS)).await;
            if this.lifecycle_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            this.run_check().await;
            // A running poll can finish after abort() was requested. Publish
            // under the same lock stop() uses and recheck cancellation here.
            let mut interval = this.interval.lock().expect("interval");
            if this.lifecycle_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let service = Arc::clone(&this);
            *interval = Some(tokio::spawn(async move {
                let mut ticker =
                    tokio::time::interval(Duration::from_millis(service.config.interval_ms.max(1)));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    if service.lifecycle_generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    service.run_check().await;
                }
            }));
        }));
    }

    pub fn stop(&self) {
        self.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(task) = self.startup.lock().expect("startup").take() {
            task.abort();
        }
        if let Some(task) = self.interval.lock().expect("interval").take() {
            task.abort();
        }
    }

    pub async fn run_check(&self) -> CheckResult {
        let mut summary = CheckResult::default();
        for target in &self.targets {
            match self.check_target(target).await {
                Ok(result) => match result.status {
                    TargetStatus::Unavailable
                    | TargetStatus::InvalidConfig
                    | TargetStatus::Disabled => summary.skipped += 1,
                    TargetStatus::Repaired => summary.repaired += 1,
                    _ => summary.checked += 1,
                },
                Err(err) => logger("HookWatchdog").error(
                    "hook-watchdog target failed",
                    Some(&fields(
                        serde_json::json!({ "agent": target.agent_id, "error": err }),
                    )),
                ),
            }
        }
        self.check_intercepts(&mut summary).await;
        summary
    }

    async fn check_target(&self, target: &PluginCheckTarget) -> Result<TargetResult, String> {
        if let Some(enabled) = &target.enabled {
            if !enabled() {
                return Ok(TargetResult {
                    agent_id: target.agent_id.clone(),
                    status: TargetStatus::Disabled,
                    missing: Vec::new(),
                });
            }
        }
        if !Path::new(&target.settings_path)
            .parent()
            .map(|path| path.exists())
            .unwrap_or(false)
        {
            return Ok(TargetResult {
                agent_id: target.agent_id.clone(),
                status: TargetStatus::Unavailable,
                missing: Vec::new(),
            });
        }
        if target.repair_fn.is_none() {
            if let Some(bin) = &target.bin_path {
                if !file_exists(bin).await {
                    return Ok(TargetResult {
                        agent_id: target.agent_id.clone(),
                        status: TargetStatus::Unavailable,
                        missing: Vec::new(),
                    });
                }
            }
        }
        let document = read_json_document(&target.settings_path, target.settings_syntax).await;
        let settings = match document {
            JsonDocumentRead::Error { error } => {
                return Ok(self.report_invalid(target, &error.message))
            }
            JsonDocumentRead::Ok { data, .. } => {
                if !data.is_object() {
                    return Ok(self.report_invalid(target, "settings root must be a JSON object"));
                }
                self.last_invalid
                    .lock()
                    .expect("invalid")
                    .remove(&invalid_key(target));
                Some(data)
            }
            JsonDocumentRead::Empty { .. } | JsonDocumentRead::Missing => {
                self.last_invalid
                    .lock()
                    .expect("invalid")
                    .remove(&invalid_key(target));
                None
            }
        };
        let mut missing = find_missing_hooks(settings.as_ref(), target);
        let mut pending = None;
        if missing.is_empty() {
            if let (Some(path), Some(needs)) =
                (&target.change_watch_path, &target.needs_repair_on_change)
            {
                let signature = change_signature(path);
                let key = format!("{}\0{path}", target.agent_id);
                let known = self
                    .last_change_signature
                    .lock()
                    .expect("sig")
                    .get(&key)
                    .cloned();
                if known.is_none() {
                    self.last_change_signature
                        .lock()
                        .expect("sig")
                        .insert(key, signature);
                } else if known.as_deref() != Some(signature.as_str()) {
                    if needs().await? {
                        missing.push("codex-trust".into());
                        pending = Some((key, signature));
                    } else {
                        self.last_change_signature
                            .lock()
                            .expect("sig")
                            .insert(key, signature);
                    }
                }
            }
        }
        if missing.is_empty() {
            return Ok(TargetResult {
                agent_id: target.agent_id.clone(),
                status: TargetStatus::Healthy,
                missing,
            });
        }
        if let Some(last) = self
            .last_repair_at
            .lock()
            .expect("repair")
            .get(&target.agent_id)
            .copied()
        {
            if (self.now_ms)() - last < self.config.repair_cooldown_ms as i64 {
                return Ok(TargetResult {
                    agent_id: target.agent_id.clone(),
                    status: TargetStatus::Cooldown,
                    missing,
                });
            }
        }
        let ok = self.repair_target(target).await;
        self.last_repair_at
            .lock()
            .expect("repair")
            .insert(target.agent_id.clone(), (self.now_ms)());
        if !ok {
            return Ok(TargetResult {
                agent_id: target.agent_id.clone(),
                status: TargetStatus::RepairFailed,
                missing,
            });
        }
        if let Some((key, signature)) = pending {
            self.last_change_signature
                .lock()
                .expect("sig")
                .insert(key, signature);
        }
        Ok(TargetResult {
            agent_id: target.agent_id.clone(),
            status: TargetStatus::Repaired,
            missing,
        })
    }

    fn report_invalid(&self, target: &PluginCheckTarget, error: &str) -> TargetResult {
        let key = invalid_key(target);
        let previous = self
            .last_invalid
            .lock()
            .expect("invalid")
            .get(&key)
            .cloned();
        if previous.as_deref() != Some(error) {
            logger("HookWatchdog").error("hook-watchdog.invalid-config", Some(&fields(serde_json::json!({ "agent": target.agent_id, "settingsPath": target.settings_path, "error": error }))));
            self.last_invalid
                .lock()
                .expect("invalid")
                .insert(key, error.to_string());
        } else {
            logger("HookWatchdog").debug(
                "hook-watchdog.invalid-config-suppressed",
                Some(&fields(serde_json::json!({
                    "agent": target.agent_id, "settingsPath": target.settings_path
                }))),
            );
        }
        TargetResult {
            agent_id: target.agent_id.clone(),
            status: TargetStatus::InvalidConfig,
            missing: Vec::new(),
        }
    }

    async fn repair_target(&self, target: &PluginCheckTarget) -> bool {
        if let Some(repair) = &target.repair_fn {
            return match repair().await {
                Ok(repaired) => repaired,
                Err(error) => {
                    logger("HookWatchdog").error(
                        "hook-watchdog.repair-failed",
                        Some(&fields(serde_json::json!({
                            "agent": target.agent_id, "error": error
                        }))),
                    );
                    false
                }
            };
        }
        let Some(bin) = &target.bin_path else {
            return false;
        };
        let mut command = tokio::process::Command::new(bin);
        command.args(&target.install_args).kill_on_drop(true);
        match tokio::time::timeout(Duration::from_secs(30), command.status()).await {
            Ok(Ok(status)) => status.success(),
            _ => false,
        }
    }

    async fn check_intercepts(&self, summary: &mut CheckResult) {
        self.reset_daily();
        for target in &self.intercept_targets {
            if !(target.enabled)() {
                if let Some(cleanup) = &target.cleanup {
                    if let Err(err) = cleanup().await {
                        logger("HookWatchdog").warn(
                            "intercept-watchdog.cleanup-failed",
                            Some(&fields(
                                serde_json::json!({ "id": target.id, "error": err }),
                            )),
                        );
                    }
                }
                summary.skipped += 1;
                continue;
            }
            if !(target.precondition)().await {
                summary.skipped += 1;
                continue;
            }
            if (target.check)().await {
                summary.checked += 1;
                continue;
            }
            if let Some(last) = self
                .last_repair_at
                .lock()
                .expect("repair")
                .get(&target.id)
                .copied()
            {
                if (self.now_ms)() - last < self.config.repair_cooldown_ms as i64 {
                    continue;
                }
            }
            let count = self
                .daily_repair_count
                .lock()
                .expect("daily")
                .get(&target.id)
                .copied()
                .unwrap_or(0);
            if count >= MAX_INTERCEPT_REPAIRS_PER_DAY {
                logger("HookWatchdog").warn(
                    "intercept-watchdog.daily-limit",
                    Some(&fields(
                        serde_json::json!({ "id": target.id, "count": count }),
                    )),
                );
                continue;
            }
            match (target.repair)().await {
                Ok(()) => {
                    self.last_repair_at
                        .lock()
                        .expect("repair")
                        .insert(target.id.clone(), (self.now_ms)());
                    self.daily_repair_count
                        .lock()
                        .expect("daily")
                        .insert(target.id.clone(), count + 1);
                    summary.repaired += 1;
                }
                Err(err) => logger("HookWatchdog").warn(
                    "intercept-watchdog.repair-failed",
                    Some(&fields(
                        serde_json::json!({ "id": target.id, "error": err }),
                    )),
                ),
            }
        }
    }

    fn reset_daily(&self) {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut current = self.daily_repair_reset_date.lock().expect("day");
        if *current != today {
            self.daily_repair_count.lock().expect("daily").clear();
            *current = today;
        }
    }

    fn capture_initial_signatures(&self) {
        for target in &self.targets {
            let (Some(path), Some(_)) = (&target.change_watch_path, &target.needs_repair_on_change)
            else {
                continue;
            };
            self.last_change_signature.lock().expect("sig").insert(
                format!("{}\0{path}", target.agent_id),
                change_signature(path),
            );
        }
    }

    pub fn default_intercept_targets(
        data_dir: &str,
        is_agent_enabled: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) -> Vec<InterceptCheckTarget> {
        Self::default_intercept_targets_in(
            data_dir,
            is_agent_enabled,
            retirement::Context::native(),
        )
    }

    fn default_intercept_targets_in(
        data_dir: &str,
        is_agent_enabled: impl Fn(&str) -> bool + Send + Sync + 'static,
        context: retirement::Context,
    ) -> Vec<InterceptCheckTarget> {
        let enabled = Arc::new(is_agent_enabled);
        let home = &context.home;
        let rc_paths = vec![
            Path::new(&home).join(".zshrc"),
            Path::new(&home).join(".bashrc"),
        ];
        let mut targets = retired_runtime_targets(data_dir, &context);
        for block in intercept_rc_blocks() {
            let script = Path::new(data_dir).join("hooks").join(block.script_name);
            let script_text = script.to_string_lossy().to_string();
            let paths = rc_paths.clone();
            let marker = block.marker.to_string();
            let end = block.end_marker.to_string();
            let signature = block.signature.to_string();
            let rendered = (block.render)(&script_text);
            let agent_enabled = Arc::clone(&enabled);
            let agent_id = block.agent_id.to_string();
            let check_paths = paths.clone();
            let repair_paths = paths.clone();
            let cleanup_paths = paths;
            let marker_check = marker.clone();
            let end_check = end.clone();
            let signature_check = signature.clone();
            let marker_repair = marker.clone();
            let end_repair = end.clone();
            let signature_repair = signature.clone();
            let rendered_repair = rendered.clone();
            let marker_cleanup = marker;
            let end_cleanup = end;
            targets.push(InterceptCheckTarget {
                id: block.id.to_string(),
                enabled: Arc::new(move || agent_enabled(&agent_id)),
                precondition: Arc::new(move || {
                    let script = script_text.clone();
                    Box::pin(async move { file_exists(&script).await })
                }),
                check: Arc::new(move || {
                    let paths = check_paths.clone();
                    let marker = marker_check.clone();
                    let end = end_check.clone();
                    let signature = signature_check.clone();
                    Box::pin(
                        async move { rc_block_healthy(&paths, &marker, &end, &signature).await },
                    )
                }),
                repair: Arc::new(move || {
                    let paths = repair_paths.clone();
                    let marker = marker_repair.clone();
                    let end = end_repair.clone();
                    let signature = signature_repair.clone();
                    let rendered = rendered_repair.clone();
                    Box::pin(async move {
                        repair_rc_blocks(&paths, &marker, &end, &signature, &rendered).await
                    })
                }),
                cleanup: Some(Arc::new(move || {
                    let paths = cleanup_paths.clone();
                    let marker = marker_cleanup.clone();
                    let end = end_cleanup.clone();
                    Box::pin(async move { cleanup_rc_blocks(&paths, &marker, &end).await })
                })),
            });
        }
        targets
    }
}

fn retired_runtime_targets(
    data_dir: &str,
    context: &retirement::Context,
) -> Vec<InterceptCheckTarget> {
    retirement::definitions(context.host)
        .iter()
        .map(|def| {
            let def = *def;
            let context = context.clone();
            let data = data_dir.to_owned();
            InterceptCheckTarget {
                id: def.id.into(),
                enabled: Arc::new(|| false),
                precondition: Arc::new(|| Box::pin(async { false })),
                check: Arc::new(|| Box::pin(async { true })),
                repair: Arc::new(|| Box::pin(async { Ok(()) })),
                cleanup: Some(Arc::new(move || {
                    let context = context.clone();
                    let data = data.clone();
                    Box::pin(
                        async move { retirement::cleanup_definition(&data, &context, def).await },
                    )
                })),
            }
        })
        .collect()
}

struct RcBlock {
    id: &'static str,
    agent_id: &'static str,
    marker: &'static str,
    end_marker: &'static str,
    signature: &'static str,
    script_name: &'static str,
    render: fn(&str) -> String,
}

fn intercept_rc_blocks() -> Vec<RcBlock> {
    vec![
        RcBlock {
            id: "claude-code-rc",
            agent_id: "claude-code",
            marker: "loongsuite-pilot BEGIN claude-code-intercept",
            end_marker: "loongsuite-pilot END claude-code-intercept",
            signature: "if ! alias claude >/dev/null 2>&1",
            script_name: "claude-code-fetch-intercept.mjs",
            render: |path| {
                format!("\n# loongsuite-pilot BEGIN claude-code-intercept\nif ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then\n  eval 'claude() {{ BUN_OPTIONS=\"--preload={path} ${{BUN_OPTIONS}}\" command claude \"$@\"; }}'\nfi\n# loongsuite-pilot END claude-code-intercept")
            },
        },
        RcBlock {
            id: "qodercli-rc",
            agent_id: "qoder",
            marker: "loongsuite-pilot BEGIN qodercli-intercept",
            end_marker: "loongsuite-pilot END qodercli-intercept",
            signature: "eval 'qodercli() {",
            script_name: "qodercli-runtime-wrapper.sh",
            render: |path| {
                format!("\n# loongsuite-pilot BEGIN qodercli-intercept\nif ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then\n  eval 'qodercli() {{ \"{path}\" \"$@\"; }}'\nfi\n# loongsuite-pilot END qodercli-intercept")
            },
        },
        RcBlock {
            id: "qoderclicn-rc",
            agent_id: "qoder-cn",
            marker: "loongsuite-pilot BEGIN qoderclicn-intercept",
            end_marker: "loongsuite-pilot END qoderclicn-intercept",
            signature: "LOONGSUITE_QODERCLI_FLAVOR=qoderclicn",
            script_name: "qodercli-runtime-wrapper.sh",
            render: |path| {
                format!("\n# loongsuite-pilot BEGIN qoderclicn-intercept\nif ! alias qoderclicn >/dev/null 2>&1 && ! typeset -f qoderclicn >/dev/null 2>&1; then\n  eval 'qoderclicn() {{ LOONGSUITE_QODERCLI_FLAVOR=qoderclicn \"{path}\" \"$@\"; }}'\nfi\n# loongsuite-pilot END qoderclicn-intercept")
            },
        },
    ]
}

async fn rc_block_healthy(
    paths: &[std::path::PathBuf],
    marker: &str,
    end: &str,
    signature: &str,
) -> bool {
    let mut any_current = false;
    let mut any_exists = false;
    for path in paths {
        if !path.is_file() {
            continue;
        }
        any_exists = true;
        let Ok(content) = std::fs::read_to_string(path) else {
            return false;
        };
        if let Some(block) = extract_marker_block(&content, marker, end) {
            if !block.terminated || !block.text.contains(signature) {
                return false;
            }
            any_current = true;
        }
    }
    any_current || !any_exists
}

async fn repair_rc_blocks(
    paths: &[std::path::PathBuf],
    marker: &str,
    end: &str,
    signature: &str,
    rendered: &str,
) -> Result<(), String> {
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let content = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
        if let Some(block) = extract_marker_block(&content, marker, end) {
            if block.terminated && block.text.contains(signature) {
                continue;
            }
            let stripped = strip_marker_block(&content, marker, end)
                .trim_end_matches('\n')
                .to_string()
                + "\n";
            std::fs::write(path, format!("{stripped}{rendered}\n"))
                .map_err(|err| err.to_string())?;
        } else {
            std::fs::OpenOptions::new()
                .append(true)
                .open(path)
                .and_then(|mut file| {
                    use std::io::Write;
                    writeln!(file, "{rendered}")
                })
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

async fn cleanup_rc_blocks(
    paths: &[std::path::PathBuf],
    marker: &str,
    end: &str,
) -> Result<(), String> {
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let content = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
        if !content.contains(marker) {
            continue;
        }
        let stripped = strip_marker_block(&content, marker, end);
        std::fs::write(path, stripped).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn strip_marker_block(content: &str, begin: &str, end: &str) -> String {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in content.split('\n') {
        if !in_block {
            if line.contains(begin) {
                in_block = true;
            } else {
                out.push(line);
            }
            continue;
        }
        if line.contains(end) {
            in_block = false;
            continue;
        }
        if line.contains(MARKER_BEGIN_PREFIX) && !line.contains(begin) {
            in_block = false;
            out.push(line);
        }
    }
    out.join("\n")
}

pub fn extract_marker_block(content: &str, begin: &str, end: &str) -> Option<MarkerBlock> {
    let lines: Vec<&str> = content.split('\n').collect();
    let start = lines.iter().position(|line| line.contains(begin))?;
    for index in (start + 1)..lines.len() {
        if lines[index].contains(end) {
            return Some(MarkerBlock {
                text: lines[start..=index].join("\n"),
                terminated: true,
            });
        }
        if lines[index].contains(MARKER_BEGIN_PREFIX) && !lines[index].contains(begin) {
            return Some(MarkerBlock {
                text: lines[start..index].join("\n"),
                terminated: false,
            });
        }
    }
    Some(MarkerBlock {
        text: lines[start..].join("\n"),
        terminated: false,
    })
}

pub fn parse_windows_user_env(output: &str, env_name: &str) -> String {
    retirement::parse_windows_user_env(output, env_name)
}

fn invalid_key(target: &PluginCheckTarget) -> String {
    format!("{}\0{}", target.agent_id, target.settings_path)
}

fn find_missing_hooks(
    settings: Option<&serde_json::Value>,
    target: &PluginCheckTarget,
) -> Vec<String> {
    let hooks = settings.and_then(|value| value.get("hooks"));
    let mut missing = Vec::new();
    for event in &target.expected_hooks {
        let Some(entries) = hooks
            .and_then(|value| value.get(event))
            .and_then(serde_json::Value::as_array)
        else {
            missing.push(event.clone());
            continue;
        };
        let present = entries
            .iter()
            .any(|entry| entry_contains_marker(entry, &target.markers));
        if !present {
            missing.push(event.clone());
        }
    }
    missing
}

fn entry_contains_marker(entry: &serde_json::Value, markers: &[String]) -> bool {
    let command = entry
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if !command.is_empty() && markers.iter().any(|marker| command.contains(marker)) {
        return true;
    }
    entry
        .get("hooks")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                let command = hook
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                !command.is_empty() && markers.iter().any(|marker| command.contains(marker))
            })
        })
}

fn change_signature(path: &str) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!("{}:{}:{mtime}", meta.len(), path)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => "missing".into(),
        Err(_) => "unreadable".into(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_and_extract_stop_at_the_next_block() {
        let content = "# loongsuite-pilot BEGIN a\nstale\n# loongsuite-pilot BEGIN b\nkeep\n# loongsuite-pilot END b\n";
        let stripped = strip_marker_block(
            content,
            "loongsuite-pilot BEGIN a",
            "loongsuite-pilot END a",
        );
        assert!(stripped.contains("BEGIN b"));
        assert!(!stripped.contains("stale"));
        let block = extract_marker_block(
            content,
            "loongsuite-pilot BEGIN a",
            "loongsuite-pilot END a",
        )
        .unwrap();
        assert!(!block.terminated);
        assert!(block.text.contains("stale"));
        assert!(!block.text.contains("keep"));
    }

    #[test]
    fn windows_env_parser_matches_the_named_value() {
        let output = "HKEY_CURRENT_USER\\Environment\n    QODER_WORKER_RUNTIME_PATH    REG_SZ    C:\\wrapper.mjs\n";
        assert_eq!(
            parse_windows_user_env(output, "qoder_worker_runtime_path"),
            "C:\\wrapper.mjs"
        );
    }

    #[tokio::test]
    async fn repairs_a_missing_hook_and_honors_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, r#"{"hooks":{"Stop":[{"command":"other"}]}}"#).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let seen = Arc::clone(&calls);
        let mut watchdog = HookWatchdog::new(
            HookWatchdogConfig {
                enabled: true,
                interval_ms: 60_000,
                repair_cooldown_ms: 10_000,
            },
            vec![PluginCheckTarget {
                agent_id: "cursor".into(),
                settings_path: settings.to_string_lossy().into_owned(),
                settings_syntax: JsonSyntax::Json,
                expected_hooks: vec!["Stop".into()],
                markers: vec!["pilot".into()],
                bin_path: None,
                install_args: Vec::new(),
                repair_fn: Some(Arc::new(move || {
                    seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Box::pin(async { Ok(true) })
                })),
                change_watch_path: None,
                needs_repair_on_change: None,
                enabled: None,
            }],
            Vec::new(),
        );
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000));
        let clock_for_now = Arc::clone(&clock);
        watchdog.set_now_ms(move || clock_for_now.load(std::sync::atomic::Ordering::SeqCst));
        let summary = watchdog.run_check().await;
        assert_eq!(summary.repaired, 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let summary = watchdog.run_check().await;
        assert_eq!(summary.checked, 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
#[path = "hook_watchdog_retirement_tests.rs"]
mod retirement_history_tests;

#[cfg(test)]
#[path = "hook_watchdog_normal_history_tests.rs"]
mod normal_history_tests;

#[cfg(test)]
#[path = "hook_watchdog_failure_history_tests.rs"]
mod failure_history_tests;

#[cfg(test)]
#[path = "hook_watchdog_intercept_history_tests.rs"]
mod intercept_history_tests;

#[cfg(test)]
#[path = "hook_watchdog_shell_history_tests.rs"]
mod shell_history_tests;
