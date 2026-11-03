//! Install and remove hook commands in agent settings files.
//!
//! Strict JSON is rewritten as pretty JSON. JSONC edits go through
//! [`crate::utils::edit_jsonc`] so comments outside the edited node stay put.

use crate::types::{HookInsert, SettingsSyntax};
use crate::utils::{
    create_logger, edit_jsonc, ensure_dir, parse_json_document, read_json_document, resolve_home,
    write_json_file, write_text_file_atomic, AtomicTextWriteOptions, ExpectedFileState,
    JsonDocumentRead, JsonEditOptions, JsonPathSeg, JsonSyntax,
};
use serde_json::{Map, Value};
use std::path::Path;

use super::claude_settings::with_claude_settings_lock;

fn logger() -> crate::utils::BoundLogger {
    create_logger("HookManager")
}

fn hook_ext() -> &'static str {
    if cfg!(windows) {
        ".ps1"
    } else {
        ".sh"
    }
}

fn wrap_hook_command(script_path: &str, args: Option<&str>) -> String {
    if !cfg!(windows) {
        return match args {
            Some(args) if !args.is_empty() => format!("{script_path} {args}"),
            _ => script_path.to_string(),
        };
    }
    let cmd = format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{script_path}\"");
    match args {
        Some(args) if !args.is_empty() => format!("{cmd} {args}"),
        _ => cmd,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookDefinition {
    pub agent_id: String,
    pub settings_path: String,
    pub settings_syntax: Option<SettingsSyntax>,
    pub hook_json_path: Vec<String>,
    pub hook_command: String,
    pub matcher: Option<String>,
    pub history_dir: Option<String>,
    pub replace_hook_commands: Option<Vec<String>>,
    pub use_nested_format: Option<bool>,
    pub shell: Option<String>,
    pub timeout: Option<f64>,
    pub insert: Option<HookInsert>,
}

impl HookDefinition {
    fn syntax(&self) -> JsonSyntax {
        match self.settings_syntax {
            Some(SettingsSyntax::Jsonc) => JsonSyntax::Jsonc,
            _ => JsonSyntax::Json,
        }
    }
}

pub struct HookManager {
    hook_script_dir: String,
    log_base_dir: String,
}

impl HookManager {
    pub fn new(hook_script_dir: Option<String>, log_base_dir: Option<String>) -> Self {
        Self {
            hook_script_dir: hook_script_dir
                .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/hooks")),
            log_base_dir: log_base_dir.unwrap_or_else(|| resolve_home("~/.loongsuite-pilot/logs")),
        }
    }

    pub fn hook_script_dir(&self) -> &str {
        &self.hook_script_dir
    }

    pub async fn install_hook(&self, def: &HookDefinition) -> bool {
        let run = async {
            if def.agent_id == "claude-code" {
                with_claude_settings_lock(
                    &def.settings_path,
                    || self.install_hook_unlocked(def),
                    10_000,
                )
                .await
            } else {
                Ok(self.install_hook_unlocked(def).await)
            }
        };
        match run.await {
            Ok(value) => value,
            Err(err) => {
                logger().error(
                    "hook configuration lock failed",
                    Some(&meta(&[("agentId", &def.agent_id), ("error", &err)])),
                );
                false
            }
        }
    }

    async fn install_hook_unlocked(&self, def: &HookDefinition) -> bool {
        let outcome = async {
            ensure_dir(&parent(&def.settings_path)).await;
            if def.settings_syntax == Some(SettingsSyntax::Jsonc) {
                return self.install_jsonc_hook(def).await;
            }
            let document = read_json_document(&def.settings_path, JsonSyntax::Json).await;
            if let JsonDocumentRead::Error { error } = &document {
                return Err(format!(
                    "refusing to overwrite invalid settings: {}",
                    error.message
                ));
            }
            let mut settings = match &document {
                JsonDocumentRead::Missing | JsonDocumentRead::Empty { .. } => {
                    Value::Object(Map::new())
                }
                JsonDocumentRead::Ok { data, .. } => {
                    require_settings_object(data)?;
                    data.clone()
                }
                JsonDocumentRead::Error { .. } => unreachable!(),
            };
            let reassigned = ensure_hook_array(&mut settings, &def.hook_json_path)?;
            if let Some(commands) = def
                .replace_hook_commands
                .as_ref()
                .filter(|commands| !commands.is_empty())
            {
                let current = array_at_mut(&mut settings, &def.hook_json_path)?;
                *current = remove_commands(current, commands);
            }
            let replaced = def
                .replace_hook_commands
                .as_ref()
                .is_some_and(|commands| !commands.is_empty());
            let present = {
                let current = array_at(&settings, &def.hook_json_path)?;
                is_command_present(current, &def.hook_command)
            };
            if present {
                let shell_repaired = {
                    let current = array_at_mut(&mut settings, &def.hook_json_path)?;
                    apply_shell_to_entries(current, &def.hook_command, def.shell.as_deref())
                };
                let timeout_repaired = {
                    let current = array_at_mut(&mut settings, &def.hook_json_path)?;
                    apply_timeout_to_entries(current, &def.hook_command, def.timeout)
                };
                let moved = {
                    let current = array_at_mut(&mut settings, &def.hook_json_path)?;
                    move_command_to_head(current, &def.hook_command, def.insert)
                };
                if reassigned || replaced || shell_repaired || timeout_repaired || moved {
                    write_json_file(&def.settings_path, &settings)
                        .await
                        .map_err(|err| err.to_string())?;
                }
                logger().debug(
                    "hook already installed",
                    Some(&meta(&[("agentId", &def.agent_id)])),
                );
                return Ok(true);
            }
            let entry = build_hook_entry(def);
            {
                let current = array_at_mut(&mut settings, &def.hook_json_path)?;
                if def.insert == Some(HookInsert::Head) {
                    current.insert(0, entry);
                } else {
                    current.push(entry);
                }
            }
            write_json_file(&def.settings_path, &settings)
                .await
                .map_err(|err| err.to_string())?;
            let history = def.history_dir.clone().unwrap_or_else(|| {
                Path::new(&self.log_base_dir)
                    .join(&def.agent_id)
                    .join("history")
                    .to_string_lossy()
                    .into_owned()
            });
            ensure_dir(&history).await;
            logger().info("hook installed", Some(&meta(&[("agentId", &def.agent_id)])));
            Ok(true)
        };
        match outcome.await {
            Ok(value) => value,
            Err(err) => {
                logger().error(
                    "hook installation failed",
                    Some(&meta(&[("agentId", &def.agent_id), ("error", &err)])),
                );
                false
            }
        }
    }

    pub async fn uninstall_hook(&self, def: &HookDefinition) -> bool {
        let run = async {
            if def.agent_id == "claude-code" {
                with_claude_settings_lock(
                    &def.settings_path,
                    || self.uninstall_hook_unlocked(def),
                    10_000,
                )
                .await
            } else {
                Ok(self.uninstall_hook_unlocked(def).await)
            }
        };
        match run.await {
            Ok(value) => value,
            Err(err) => {
                logger().error(
                    "hook configuration lock failed",
                    Some(&meta(&[("agentId", &def.agent_id), ("error", &err)])),
                );
                false
            }
        }
    }

    async fn uninstall_hook_unlocked(&self, def: &HookDefinition) -> bool {
        let outcome = async {
            if def.settings_syntax == Some(SettingsSyntax::Jsonc) {
                return self.uninstall_jsonc_hook(def).await;
            }
            let document = read_json_document(&def.settings_path, JsonSyntax::Json).await;
            match document {
                JsonDocumentRead::Missing | JsonDocumentRead::Empty { .. } => Ok(true),
                JsonDocumentRead::Error { error } => Err(format!(
                    "refusing to overwrite invalid settings: {}",
                    error.message
                )),
                JsonDocumentRead::Ok { data, .. } => {
                    let mut settings = data;
                    require_settings_object(&settings)?;
                    if !path_exists(&settings, &def.hook_json_path) {
                        return Ok(true);
                    }
                    let Some(target_parent) = parent_object_mut(&mut settings, &def.hook_json_path)
                    else {
                        return Ok(true);
                    };
                    let last = def.hook_json_path.last().cloned().unwrap_or_default();
                    if !target_parent
                        .get(&last)
                        .is_some_and(|value| value.is_array())
                    {
                        return Ok(true);
                    }
                    let mut commands = vec![def.hook_command.clone()];
                    if let Some(extra) = &def.replace_hook_commands {
                        commands.extend(extra.clone());
                    }
                    let current = target_parent
                        .get(&last)
                        .and_then(|value| value.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let next = remove_commands(&current, &commands);
                    if next.is_empty() {
                        target_parent.remove(&last);
                    } else {
                        target_parent.insert(last, Value::Array(next));
                    }
                    write_json_file(&def.settings_path, &settings)
                        .await
                        .map_err(|err| err.to_string())?;
                    logger().info(
                        "hook uninstalled",
                        Some(&meta(&[("agentId", &def.agent_id)])),
                    );
                    Ok(true)
                }
            }
        };
        match outcome.await {
            Ok(value) => value,
            Err(err) => {
                logger().error(
                    "hook uninstall failed",
                    Some(&meta(&[("agentId", &def.agent_id), ("error", &err)])),
                );
                false
            }
        }
    }

    /// 在内存中编辑单个事件；批量部署在全部事件和关联配置验证后统一落盘。
    pub(crate) fn edit_hook(
        raw: &str,
        def: &HookDefinition,
        remove: bool,
    ) -> Result<String, String> {
        if def.hook_json_path.is_empty() {
            return Err("Hook 路径不能为空".into());
        }
        let settings = parse_json_document(raw, def.syntax()).map_err(|err| err.message)?;
        require_settings_object(&settings)?;
        let mut cursor = &settings;
        for key in &def.hook_json_path[..def.hook_json_path.len() - 1] {
            let Some(next) = cursor.get(key) else { break };
            if !next.is_object() {
                return Err("Hook 父路径必须为对象".into());
            }
            cursor = next;
        }
        let existing = value_at_path(&settings, &def.hook_json_path);
        if existing.is_some_and(|value| !value.is_array()) {
            return Err("Hook 路径必须为数组".into());
        }
        let mut commands = def.replace_hook_commands.clone().unwrap_or_default();
        if remove {
            commands.push(def.hook_command.clone());
        }
        let mut next = match existing.and_then(Value::as_array) {
            Some(entries) => {
                remove_commands_from_jsonc(raw, &def.hook_json_path, entries, &commands)
            }
            None => raw.into(),
        };
        let parsed = parse_json_document(&next, def.syntax()).map_err(|err| err.message)?;
        let current = value_at_path(&parsed, &def.hook_json_path);
        let entries = current
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if remove {
            // strict JSON 的历史合同会回收空事件；JSONC 保留事件外的原有格式。
            if def.syntax() == JsonSyntax::Json && current.is_some() && entries.is_empty() {
                next = edit_jsonc(
                    &next,
                    &key_path(&def.hook_json_path),
                    None,
                    JsonEditOptions::default(),
                );
            }
        } else if !is_command_present(&entries, &def.hook_command) {
            let entry = build_hook_entry(def);
            if current.is_none() {
                next = edit_jsonc(
                    &next,
                    &key_path(&def.hook_json_path),
                    Some(&Value::Array(vec![entry])),
                    JsonEditOptions::default(),
                );
            } else {
                let mut path = key_path(&def.hook_json_path);
                path.push(JsonPathSeg::Index(
                    if def.insert == Some(HookInsert::Head) {
                        0
                    } else {
                        entries.len()
                    },
                ));
                next = edit_jsonc(
                    &next,
                    &path,
                    Some(&entry),
                    JsonEditOptions {
                        is_array_insertion: true,
                    },
                );
            }
        } else {
            next = repair_jsonc_hook_entry(&next, def, &entries);
            // repair 可能调整位置；用新快照定位 shell，避免覆盖用户 handler 的其他字段。
            let parsed = parse_json_document(&next, def.syntax()).map_err(|err| err.message)?;
            if let (Some(shell), Some(entries)) = (
                def.shell.as_deref(),
                value_at_path(&parsed, &def.hook_json_path).and_then(Value::as_array),
            ) {
                for (index, entry) in entries.iter().enumerate() {
                    if let Some(handlers) = entry.get("hooks").and_then(Value::as_array) {
                        for (handler_index, handler) in handlers.iter().enumerate() {
                            if handler.get("command").and_then(Value::as_str)
                                == Some(&def.hook_command)
                                && handler.get("shell").and_then(Value::as_str) != Some(shell)
                            {
                                let mut path = key_path(&def.hook_json_path);
                                path.extend([
                                    JsonPathSeg::Index(index),
                                    JsonPathSeg::Key("hooks".into()),
                                    JsonPathSeg::Index(handler_index),
                                    JsonPathSeg::Key("shell".into()),
                                ]);
                                next = edit_jsonc(
                                    &next,
                                    &path,
                                    Some(&Value::String(shell.into())),
                                    JsonEditOptions::default(),
                                );
                            }
                        }
                    }
                }
            }
        }
        let parsed = parse_json_document(&next, def.syntax()).map_err(|err| err.message)?;
        require_settings_object(&parsed)?;
        let entries = value_at_path(&parsed, &def.hook_json_path)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if commands
            .iter()
            .any(|command| is_command_present(&entries, command))
            || (!remove
                && (!is_command_present(&entries, &def.hook_command)
                    || !has_required_shell(&entries, &def.hook_command, def.shell.as_deref())
                    || !has_required_timeout(&entries, &def.hook_command, def.timeout)
                    || (def.insert == Some(HookInsert::Head)
                        && !is_command_at_head(&entries, &def.hook_command))))
        {
            return Err("Hook 编辑结果校验失败，原配置未写入".into());
        }
        Ok(next)
    }

    pub async fn is_hook_installed(&self, def: &HookDefinition) -> bool {
        let document = read_json_document(&def.settings_path, def.syntax()).await;
        let JsonDocumentRead::Ok { data, .. } = document else {
            return false;
        };
        if require_settings_object(&data).is_err() {
            return false;
        }
        let Some(hooks) =
            value_at_path(&data, &def.hook_json_path).and_then(|value| value.as_array())
        else {
            return false;
        };
        if def.replace_hook_commands.as_ref().is_some_and(|commands| {
            commands
                .iter()
                .any(|command| is_command_present(hooks, command))
        }) {
            return false;
        }
        if !is_command_present(hooks, &def.hook_command) {
            return false;
        }
        if !has_required_shell(hooks, &def.hook_command, def.shell.as_deref()) {
            return false;
        }
        if !has_required_timeout(hooks, &def.hook_command, def.timeout) {
            return false;
        }
        if def.insert == Some(HookInsert::Head) && !is_command_at_head(hooks, &def.hook_command) {
            return false;
        }
        true
    }

    async fn install_jsonc_hook(&self, def: &HookDefinition) -> Result<bool, String> {
        let document = read_json_document(&def.settings_path, JsonSyntax::Jsonc).await;
        if let JsonDocumentRead::Error { error } = &document {
            return Err(format!(
                "refusing to overwrite invalid settings: {}",
                error.message
            ));
        }
        let expected = match &document {
            JsonDocumentRead::Missing => ExpectedFileState::Missing,
            JsonDocumentRead::Empty { raw } | JsonDocumentRead::Ok { raw, .. } => {
                ExpectedFileState::Present(raw.clone())
            }
            JsonDocumentRead::Error { .. } => unreachable!(),
        };
        let original_raw = match &document {
            JsonDocumentRead::Ok { raw, .. } => Some(raw.clone()),
            _ => None,
        };
        let mut raw = match &document {
            JsonDocumentRead::Missing | JsonDocumentRead::Empty { .. } => "{}\n".to_string(),
            JsonDocumentRead::Ok { raw, .. } => raw.clone(),
            JsonDocumentRead::Error { .. } => unreachable!(),
        };
        let settings = match &document {
            JsonDocumentRead::Missing | JsonDocumentRead::Empty { .. } => Value::Object(Map::new()),
            JsonDocumentRead::Ok { data, .. } => {
                require_settings_object(data)?;
                data.clone()
            }
            JsonDocumentRead::Error { .. } => unreachable!(),
        };
        let existing = value_at_path(&settings, &def.hook_json_path);
        if existing.is_some() && !existing.unwrap().is_array() {
            return Err(format!(
                "hook path is not an array: {}",
                def.hook_json_path.join(".")
            ));
        }
        if let Some(commands) = def
            .replace_hook_commands
            .as_ref()
            .filter(|commands| !commands.is_empty())
        {
            if let Some(Value::Array(entries)) = existing {
                raw = remove_commands_from_jsonc(&raw, &def.hook_json_path, entries, commands);
            }
        }
        let reparsed = parse_json_document(&raw, JsonSyntax::Jsonc).map_err(|err| err.message)?;
        require_settings_object(&reparsed)?;
        let current_value = value_at_path(&reparsed, &def.hook_json_path).cloned();
        if current_value.is_some() && !current_value.as_ref().unwrap().is_array() {
            return Err(format!(
                "hook path is not an array: {}",
                def.hook_json_path.join(".")
            ));
        }
        let hooks = current_value
            .as_ref()
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if !is_command_present(&hooks, &def.hook_command) {
            let entry = build_hook_entry(def);
            raw = if current_value.is_none() {
                let list = Value::Array(vec![entry]);
                edit_jsonc(
                    &raw,
                    &key_path(&def.hook_json_path),
                    Some(&list),
                    JsonEditOptions::default(),
                )
            } else {
                let index = if def.insert == Some(HookInsert::Head) {
                    0
                } else {
                    hooks.len()
                };
                let mut path = key_path(&def.hook_json_path);
                path.push(JsonPathSeg::Index(index));
                edit_jsonc(
                    &raw,
                    &path,
                    Some(&entry),
                    JsonEditOptions {
                        is_array_insertion: true,
                    },
                )
            };
        } else {
            raw = repair_jsonc_hook_entry(&raw, def, &hooks);
        }
        if matches!(document, JsonDocumentRead::Ok { .. })
            && original_raw.as_deref() == Some(raw.as_str())
        {
            logger().debug(
                "hook already installed",
                Some(&meta(&[("agentId", &def.agent_id)])),
            );
            return Ok(true);
        }
        let backup = if matches!(document, JsonDocumentRead::Missing) {
            None
        } else {
            Some(format!("{}.loongsuite-pilot.bak", def.settings_path))
        };
        write_text_file_atomic(
            &def.settings_path,
            &raw,
            &AtomicTextWriteOptions {
                expected: Some(expected),
                backup_path: backup,
                mode: None,
            },
        )
        .await
        .map_err(|err| err.to_string())?;
        let history = def.history_dir.clone().unwrap_or_else(|| {
            Path::new(&self.log_base_dir)
                .join(&def.agent_id)
                .join("history")
                .to_string_lossy()
                .into_owned()
        });
        ensure_dir(&history).await;
        logger().info("hook installed", Some(&meta(&[("agentId", &def.agent_id)])));
        Ok(true)
    }

    async fn uninstall_jsonc_hook(&self, def: &HookDefinition) -> Result<bool, String> {
        let document = read_json_document(&def.settings_path, JsonSyntax::Jsonc).await;
        match document {
            JsonDocumentRead::Missing | JsonDocumentRead::Empty { .. } => Ok(true),
            JsonDocumentRead::Error { error } => Err(format!(
                "refusing to overwrite invalid settings: {}",
                error.message
            )),
            JsonDocumentRead::Ok { data, raw } => {
                require_settings_object(&data)?;
                let existing = value_at_path(&data, &def.hook_json_path);
                if existing.is_none() {
                    return Ok(true);
                }
                let Some(entries) = existing.and_then(|value| value.as_array()) else {
                    return Err(format!(
                        "hook path is not an array: {}",
                        def.hook_json_path.join(".")
                    ));
                };
                let mut commands = vec![def.hook_command.clone()];
                if let Some(extra) = &def.replace_hook_commands {
                    commands.extend(extra.clone());
                }
                let next =
                    remove_commands_from_jsonc(&raw, &def.hook_json_path, entries, &commands);
                if next == raw {
                    return Ok(true);
                }
                write_text_file_atomic(
                    &def.settings_path,
                    &next,
                    &AtomicTextWriteOptions {
                        expected: Some(ExpectedFileState::Present(raw)),
                        backup_path: Some(format!("{}.loongsuite-pilot.bak", def.settings_path)),
                        mode: None,
                    },
                )
                .await
                .map_err(|err| err.to_string())?;
                logger().info(
                    "hook uninstalled",
                    Some(&meta(&[("agentId", &def.agent_id)])),
                );
                Ok(true)
            }
        }
    }

    pub fn build_cursor_hooks(loongsuite_pilot_dir: Option<&str>) -> Vec<HookDefinition> {
        let base = base_dir(loongsuite_pilot_dir);
        let command = wrap_hook_command(
            &format!("{base}/hooks/cursor-loongsuite-pilot-hook{}", hook_ext()),
            None,
        );
        let settings_path = resolve_home("~/.cursor/hooks.json");
        [
            "stop",
            "preToolUse",
            "postToolUse",
            "postToolUseFailure",
            "beforeSubmitPrompt",
            "preCompact",
            "sessionStart",
            "sessionEnd",
            "subagentStart",
            "subagentStop",
            "afterAgentResponse",
            "afterAgentThought",
        ]
        .into_iter()
        .map(|event| HookDefinition {
            agent_id: "cursor".into(),
            settings_path: settings_path.clone(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), event.into()],
            hook_command: command.clone(),
            matcher: None,
            history_dir: Some(
                Path::new(&base)
                    .join("logs")
                    .join("cursor")
                    .join("history")
                    .to_string_lossy()
                    .into_owned(),
            ),
            replace_hook_commands: None,
            use_nested_format: None,
            shell: None,
            timeout: None,
            insert: None,
        })
        .collect()
    }

    pub fn build_qoder_cli_hooks(loongsuite_pilot_dir: Option<&str>) -> Vec<HookDefinition> {
        let base = base_dir(loongsuite_pilot_dir);
        let command = wrap_hook_command(
            &format!("{base}/hooks/qoder-loongsuite-pilot-hook{}", hook_ext()),
            Some("qoder"),
        );
        vec![nested_stop(
            "qoder",
            resolve_home("~/.qoder/settings.json"),
            command,
            None,
            None,
        )]
    }

    /// The TypeScript helper indexes `[1]` of a one-element list.
    pub fn build_qoder_cli_hook(loongsuite_pilot_dir: Option<&str>) -> Option<HookDefinition> {
        Self::build_qoder_cli_hooks(loongsuite_pilot_dir)
            .into_iter()
            .nth(1)
    }

    pub fn build_qoder_work_hooks(loongsuite_pilot_dir: Option<&str>) -> Vec<HookDefinition> {
        let base = base_dir(loongsuite_pilot_dir);
        let command = wrap_hook_command(
            &format!("{base}/hooks/qoderwork-loongsuite-pilot-hook{}", hook_ext()),
            None,
        );
        let legacy = wrap_hook_command(
            &format!("{base}/hooks/qoder-loongsuite-pilot-hook{}", hook_ext()),
            Some("qoder-work"),
        );
        let mut replace = vec![legacy];
        if cfg!(windows) {
            replace.push(format!("{base}/hooks/qoderwork-loongsuite-pilot-hook.sh"));
            replace.push(format!("{base}/hooks/qoderwork-loongsuite-pilot-hook.ps1"));
            replace.push(format!(
                "{base}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work"
            ));
            replace.push(format!(
                "{base}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work"
            ));
        }
        vec![nested_stop(
            "qoder-work",
            resolve_home("~/.qoderwork/settings.json"),
            command,
            Some(replace),
            None,
        )]
    }

    pub fn build_qoder_work_cn_hooks(loongsuite_pilot_dir: Option<&str>) -> Vec<HookDefinition> {
        let base = base_dir(loongsuite_pilot_dir);
        let command = wrap_hook_command(
            &format!(
                "{base}/hooks/qoderworkcn-loongsuite-pilot-hook{}",
                hook_ext()
            ),
            None,
        );
        let legacy = wrap_hook_command(
            &format!("{base}/hooks/qoder-loongsuite-pilot-hook{}", hook_ext()),
            Some("qoder-work-cn"),
        );
        let mut replace = vec![legacy];
        if cfg!(windows) {
            replace.push(format!("{base}/hooks/qoderworkcn-loongsuite-pilot-hook.sh"));
            replace.push(format!(
                "{base}/hooks/qoderworkcn-loongsuite-pilot-hook.ps1"
            ));
            replace.push(format!(
                "{base}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work-cn"
            ));
            replace.push(format!(
                "{base}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work-cn"
            ));
        }
        vec![nested_stop(
            "qoder-work-cn",
            resolve_home("~/.qoderworkcn/settings.json"),
            command,
            Some(replace),
            None,
        )]
    }

    pub fn build_qwen_work_cn_hooks(loongsuite_pilot_dir: Option<&str>) -> Vec<HookDefinition> {
        let base = base_dir(loongsuite_pilot_dir);
        let command = wrap_hook_command(
            &format!(
                "{base}/hooks/qwenworkcn-loongsuite-pilot-hook{}",
                hook_ext()
            ),
            None,
        );
        vec![nested_stop(
            "qwen-work-cn",
            resolve_home("~/.qwenworkcn/settings.json"),
            command,
            None,
            if cfg!(windows) {
                Some("powershell".into())
            } else {
                None
            },
        )]
    }

    pub fn build_generic_hook(
        agent_id: &str,
        settings_dir: &str,
        loongsuite_pilot_dir: Option<&str>,
    ) -> HookDefinition {
        let base = base_dir(loongsuite_pilot_dir);
        HookDefinition {
            agent_id: agent_id.into(),
            settings_path: Path::new(settings_dir)
                .join("settings.json")
                .to_string_lossy()
                .into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "PostToolUse".into()],
            hook_command: wrap_hook_command(
                &format!("{base}/hooks/{agent_id}-hook{}", hook_ext()),
                None,
            ),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: None,
            shell: None,
            timeout: None,
            insert: None,
        }
    }
}

fn base_dir(loongsuite_pilot_dir: Option<&str>) -> String {
    loongsuite_pilot_dir
        .map(|value| value.to_string())
        .unwrap_or_else(|| resolve_home("~/.loongsuite-pilot"))
}

fn nested_stop(
    agent_id: &str,
    settings_path: String,
    command: String,
    replace: Option<Vec<String>>,
    shell: Option<String>,
) -> HookDefinition {
    HookDefinition {
        agent_id: agent_id.into(),
        settings_path,
        settings_syntax: None,
        hook_json_path: vec!["hooks".into(), "Stop".into()],
        hook_command: command,
        matcher: Some("*".into()),
        history_dir: None,
        replace_hook_commands: replace,
        use_nested_format: Some(true),
        shell,
        timeout: None,
        insert: None,
    }
}

fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

fn meta(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), Value::String((*value).to_string())))
        .collect()
}

fn require_settings_object(value: &Value) -> Result<&Map<String, Value>, String> {
    match value.as_object() {
        Some(object) => Ok(object),
        None => Err("settings root must be a JSON object".into()),
    }
}

fn value_at_path<'a>(root: &'a Value, json_path: &[String]) -> Option<&'a Value> {
    let mut current = root;
    for key in json_path {
        current = current.as_object()?.get(key)?;
    }
    Some(current)
}

fn ensure_hook_array(settings: &mut Value, json_path: &[String]) -> Result<bool, String> {
    if json_path.is_empty() {
        return Err("hook path is empty".into());
    }
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "settings root must be a JSON object".to_string())?;
    let mut cursor = object;
    let mut reassigned = false;
    for key in &json_path[..json_path.len() - 1] {
        let replace = !matches!(
            cursor.get(key),
            Some(Value::Object(_)) | Some(Value::Array(_))
        );
        if replace {
            cursor.insert(key.clone(), Value::Object(Map::new()));
            reassigned = true;
        }
        cursor = cursor
            .get_mut(key)
            .and_then(|value| value.as_object_mut())
            .ok_or_else(|| "hook path is not an object".to_string())?;
    }
    let last = json_path.last().unwrap();
    if !cursor.get(last).is_some_and(|value| value.is_array()) {
        cursor.insert(last.clone(), Value::Array(Vec::new()));
        reassigned = true;
    }
    Ok(reassigned)
}

fn array_at<'a>(settings: &'a Value, json_path: &[String]) -> Result<&'a Vec<Value>, String> {
    value_at_path(settings, json_path)
        .and_then(|value| value.as_array())
        .ok_or_else(|| "hook path is not an array".to_string())
}

fn array_at_mut<'a>(
    settings: &'a mut Value,
    json_path: &[String],
) -> Result<&'a mut Vec<Value>, String> {
    let mut cursor = settings;
    for key in &json_path[..json_path.len() - 1] {
        cursor = cursor
            .get_mut(key)
            .ok_or_else(|| "hook path missing".to_string())?;
    }
    let last = json_path
        .last()
        .ok_or_else(|| "hook path is empty".to_string())?;
    cursor
        .get_mut(last)
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| "hook path is not an array".to_string())
}

fn parent_object_mut<'a>(
    settings: &'a mut Value,
    json_path: &[String],
) -> Option<&'a mut Map<String, Value>> {
    if json_path.is_empty() {
        return None;
    }
    let mut cursor = settings.as_object_mut()?;
    for key in &json_path[..json_path.len() - 1] {
        let next = cursor.get_mut(key)?;
        if next.is_null() {
            return None;
        }
        cursor = next.as_object_mut()?;
    }
    Some(cursor)
}

fn path_exists(settings: &Value, json_path: &[String]) -> bool {
    let mut cursor = match settings.as_object() {
        Some(object) => object,
        None => return false,
    };
    for key in &json_path[..json_path.len().saturating_sub(1)] {
        match cursor.get(key) {
            Some(Value::Object(next)) => cursor = next,
            Some(_) => return true,
            None => return false,
        }
    }
    json_path.last().is_some_and(|key| cursor.contains_key(key))
}

fn entry_matches_command(entry: &Value, command: &str) -> bool {
    let Some(object) = entry.as_object() else {
        return false;
    };
    if object.get("command").and_then(Value::as_str) == Some(command) {
        return true;
    }
    object
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks
                .iter()
                .any(|hook| hook.get("command").and_then(Value::as_str) == Some(command))
        })
}

fn is_command_present(entries: &[Value], command: &str) -> bool {
    entries
        .iter()
        .any(|entry| entry_matches_command(entry, command))
}

fn has_required_shell(entries: &[Value], command: &str, shell: Option<&str>) -> bool {
    let Some(shell) = shell else {
        return true;
    };
    entries.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("command").and_then(Value::as_str) == Some(command)
                        && hook.get("shell").and_then(Value::as_str) == Some(shell)
                })
            })
    })
}

fn apply_shell_to_entries(entries: &mut [Value], command: &str, shell: Option<&str>) -> bool {
    let Some(shell) = shell else {
        return false;
    };
    let mut changed = false;
    for entry in entries {
        let Some(hooks) = entry
            .get_mut("hooks")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        for hook in hooks {
            if hook.get("command").and_then(Value::as_str) == Some(command)
                && hook.get("shell").and_then(Value::as_str) != Some(shell)
            {
                if let Some(object) = hook.as_object_mut() {
                    object.insert("shell".into(), Value::String(shell.to_string()));
                    changed = true;
                }
            }
        }
    }
    changed
}

fn has_required_timeout(entries: &[Value], command: &str, timeout: Option<f64>) -> bool {
    let Some(timeout) = timeout else {
        return true;
    };
    entries.iter().any(|entry| {
        if entry.get("command").and_then(Value::as_str) == Some(command) {
            return number_eq(entry.get("timeout"), timeout);
        }
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("command").and_then(Value::as_str) == Some(command)
                        && number_eq(hook.get("timeout"), timeout)
                })
            })
    })
}

fn apply_timeout_to_entries(entries: &mut [Value], command: &str, timeout: Option<f64>) -> bool {
    let Some(timeout) = timeout else {
        return false;
    };
    let mut changed = false;
    for entry in entries.iter_mut() {
        if entry.get("command").and_then(Value::as_str) == Some(command)
            && !number_eq(entry.get("timeout"), timeout)
        {
            if let Some(object) = entry.as_object_mut() {
                object.insert("timeout".into(), json_number(timeout));
                changed = true;
            }
        }
        let Some(hooks) = entry
            .get_mut("hooks")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        for hook in hooks {
            if hook.get("command").and_then(Value::as_str) == Some(command)
                && !number_eq(hook.get("timeout"), timeout)
            {
                if let Some(object) = hook.as_object_mut() {
                    object.insert("timeout".into(), json_number(timeout));
                    changed = true;
                }
            }
        }
    }
    changed
}

fn number_eq(value: Option<&Value>, expected: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|actual| actual == expected)
}

fn json_number(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
    {
        return Value::Number((value as i64).into());
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn is_command_at_head(entries: &[Value], command: &str) -> bool {
    entries
        .first()
        .is_some_and(|entry| entry_matches_command(entry, command))
}

fn move_command_to_head(
    entries: &mut Vec<Value>,
    command: &str,
    insert: Option<HookInsert>,
) -> bool {
    if insert != Some(HookInsert::Head) || is_command_at_head(entries, command) {
        return false;
    }
    let Some(index) = entries
        .iter()
        .position(|entry| entry_matches_command(entry, command))
    else {
        return false;
    };
    let entry = entries.remove(index);
    entries.insert(0, entry);
    true
}

fn build_hook_entry(def: &HookDefinition) -> Value {
    let mut command = Map::new();
    if def.use_nested_format == Some(true) {
        command.insert("command".into(), Value::String(def.hook_command.clone()));
        command.insert("type".into(), Value::String("command".into()));
        if let Some(shell) = &def.shell {
            command.insert("shell".into(), Value::String(shell.clone()));
        }
        if let Some(timeout) = def.timeout {
            command.insert("timeout".into(), json_number(timeout));
        }
        let mut outer = Map::new();
        outer.insert(
            "matcher".into(),
            Value::String(def.matcher.clone().unwrap_or_else(|| "*".into())),
        );
        outer.insert("hooks".into(), Value::Array(vec![Value::Object(command)]));
        Value::Object(outer)
    } else {
        command.insert("type".into(), Value::String("command".into()));
        command.insert("command".into(), Value::String(def.hook_command.clone()));
        if let Some(matcher) = &def.matcher {
            command.insert("matcher".into(), Value::String(matcher.clone()));
        }
        if let Some(timeout) = def.timeout {
            command.insert("timeout".into(), json_number(timeout));
        }
        Value::Object(command)
    }
}

fn remove_commands(entries: &[Value], commands: &[String]) -> Vec<Value> {
    entries
        .iter()
        .filter_map(|entry| remove_commands_from_entry(entry, commands))
        .collect()
}

fn remove_commands_from_entry(entry: &Value, commands: &[String]) -> Option<Value> {
    let object = entry.as_object()?;
    if object
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| commands.iter().any(|item| item == command))
    {
        return None;
    }
    let Some(hooks) = object.get("hooks").and_then(Value::as_array) else {
        return Some(entry.clone());
    };
    let filtered: Vec<Value> = hooks
        .iter()
        .filter(|hook| {
            !hook
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| commands.iter().any(|item| item == command))
        })
        .cloned()
        .collect();
    if filtered.is_empty() {
        return None;
    }
    if filtered.len() == hooks.len() {
        return Some(entry.clone());
    }
    let mut next = object.clone();
    next.insert("hooks".into(), Value::Array(filtered));
    Some(Value::Object(next))
}

fn key_path(path: &[String]) -> Vec<JsonPathSeg> {
    path.iter().cloned().map(JsonPathSeg::Key).collect()
}

fn remove_commands_from_jsonc(
    source: &str,
    hook_path: &[String],
    entries: &[Value],
    commands: &[String],
) -> String {
    let mut raw = source.to_string();
    for entry_index in (0..entries.len()).rev() {
        let entry = &entries[entry_index];
        if entry
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| commands.iter().any(|item| item == command))
        {
            let mut path = key_path(hook_path);
            path.push(JsonPathSeg::Index(entry_index));
            raw = edit_jsonc(&raw, &path, None, JsonEditOptions::default());
            continue;
        }
        let Some(hooks) = entry.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        let matching: Vec<usize> = hooks
            .iter()
            .enumerate()
            .rev()
            .filter_map(|(hook_index, hook)| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .filter(|command| commands.iter().any(|item| item == *command))
                    .map(|_| hook_index)
            })
            .collect();
        if matching.len() == hooks.len() && !matching.is_empty() {
            let mut path = key_path(hook_path);
            path.push(JsonPathSeg::Index(entry_index));
            raw = edit_jsonc(&raw, &path, None, JsonEditOptions::default());
            continue;
        }
        for hook_index in matching {
            let mut path = key_path(hook_path);
            path.push(JsonPathSeg::Index(entry_index));
            path.push(JsonPathSeg::Key("hooks".into()));
            path.push(JsonPathSeg::Index(hook_index));
            raw = edit_jsonc(&raw, &path, None, JsonEditOptions::default());
        }
    }
    raw
}

fn repair_jsonc_hook_entry(raw: &str, def: &HookDefinition, hooks: &[Value]) -> String {
    let Some(index) = hooks
        .iter()
        .position(|entry| entry_matches_command(entry, &def.hook_command))
    else {
        return raw.to_string();
    };
    let mut next = apply_timeout_to_jsonc(raw, def, hooks, index);
    let mut hooks = hooks.to_vec();
    apply_timeout_to_entries(&mut hooks, &def.hook_command, def.timeout);
    if def.insert == Some(HookInsert::Head) && index > 0 {
        let entry = hooks[index].clone();
        let mut path = key_path(&def.hook_json_path);
        path.push(JsonPathSeg::Index(index));
        next = edit_jsonc(&next, &path, None, JsonEditOptions::default());
        let mut insert_path = key_path(&def.hook_json_path);
        insert_path.push(JsonPathSeg::Index(0));
        next = edit_jsonc(
            &next,
            &insert_path,
            Some(&entry),
            JsonEditOptions {
                is_array_insertion: true,
            },
        );
    }
    next
}

fn apply_timeout_to_jsonc(
    raw: &str,
    def: &HookDefinition,
    hooks: &[Value],
    entry_index: usize,
) -> String {
    let Some(timeout) = def.timeout else {
        return raw.to_string();
    };
    let entry = &hooks[entry_index];
    if entry.get("command").and_then(Value::as_str) == Some(def.hook_command.as_str())
        && !number_eq(entry.get("timeout"), timeout)
    {
        let mut path = key_path(&def.hook_json_path);
        path.push(JsonPathSeg::Index(entry_index));
        path.push(JsonPathSeg::Key("timeout".into()));
        return edit_jsonc(
            raw,
            &path,
            Some(&json_number(timeout)),
            JsonEditOptions::default(),
        );
    }
    let Some(inner) = entry.get("hooks").and_then(Value::as_array) else {
        return raw.to_string();
    };
    let Some(hook_index) = inner.iter().position(|hook| {
        hook.get("command").and_then(Value::as_str) == Some(def.hook_command.as_str())
    }) else {
        return raw.to_string();
    };
    if number_eq(inner[hook_index].get("timeout"), timeout) {
        return raw.to_string();
    }
    let mut path = key_path(&def.hook_json_path);
    path.push(JsonPathSeg::Index(entry_index));
    path.push(JsonPathSeg::Key("hooks".into()));
    path.push(JsonPathSeg::Index(hook_index));
    path.push(JsonPathSeg::Key("timeout".into()));
    edit_jsonc(
        raw,
        &path,
        Some(&json_number(timeout)),
        JsonEditOptions::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(dir: &std::path::Path) -> HookManager {
        HookManager::new(
            Some(dir.join("hooks").to_string_lossy().into_owned()),
            Some(dir.join("logs").to_string_lossy().into_owned()),
        )
    }

    #[test]
    fn builds_qoder_work_and_qwen_work_entrypoints() {
        let def = &HookManager::build_qoder_work_hooks(Some("/opt/loongsuite-pilot"))[0];
        if cfg!(windows) {
            assert_eq!(
                def.hook_command,
                r#"powershell -NoProfile -ExecutionPolicy Bypass -File "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.ps1""#
            );
            assert_eq!(
                def.replace_hook_commands.as_deref(),
                Some([
                    r#"powershell -NoProfile -ExecutionPolicy Bypass -File "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.ps1" qoder-work"#.to_string(),
                    "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh".to_string(),
                    "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.ps1".to_string(),
                    "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work".to_string(),
                    "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work".to_string(),
                ].as_slice())
            );
        } else {
            assert_eq!(
                def.hook_command,
                "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh"
            );
            assert_eq!(
                def.replace_hook_commands.as_deref(),
                Some(
                    [
                        "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work"
                            .to_string()
                    ]
                    .as_slice()
                )
            );
        }
        assert_eq!(def.agent_id, "qoder-work");
        assert_eq!(def.use_nested_format, Some(true));

        let qwen = &HookManager::build_qwen_work_cn_hooks(Some("/opt/loongsuite-pilot"))[0];
        assert_eq!(qwen.agent_id, "qwen-work-cn");
        assert!(std::path::Path::new(&qwen.settings_path)
            .ends_with(std::path::Path::new(".qwenworkcn").join("settings.json")));
        assert_eq!(
            qwen.hook_json_path,
            vec!["hooks".to_string(), "Stop".to_string()]
        );
        assert!(qwen
            .hook_command
            .contains("qwenworkcn-loongsuite-pilot-hook"));
        assert!(!qwen.hook_command.contains("qoderwork"));
        assert_eq!(qwen.use_nested_format, Some(true));
        assert!(HookManager::build_qoder_cli_hook(Some("/opt")).is_none());
    }

    #[tokio::test]
    async fn replaces_legacy_qoder_work_command_and_treats_it_as_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join(".qoderwork").join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "command": "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work", "type": "command" }] }
    ]
  }
}
"#,
        )
        .unwrap();
        let mgr = manager(dir.path());
        let def = HookDefinition {
            agent_id: "qoder-work".into(),
            settings_path: settings.to_string_lossy().into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "Stop".into()],
            hook_command: "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh".into(),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: Some(vec![
                "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work".into(),
            ]),
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        };
        assert!(mgr.install_hook(&def).await);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let text = parsed.to_string();
        assert!(!text.contains("qoder-loongsuite-pilot-hook.sh qoder-work"));
        assert_eq!(
            parsed["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh"
        );
        assert_eq!(
            parsed["hooks"]["Stop"],
            serde_json::json!([{"matcher":"*","hooks":[{
                "command":"/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh",
                "type":"command"
            }]}])
        );

        std::fs::write(
            &settings,
            r#"{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "command": "/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh", "type": "command" }] },
      { "matcher": "*", "hooks": [{ "command": "/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work", "type": "command" }] }
    ]
  }
}"#,
        )
        .unwrap();
        assert!(!mgr.is_hook_installed(&def).await);
    }

    #[tokio::test]
    async fn initializes_blank_strict_json_and_refuses_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join(".qoder").join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        for original in ["", "  \n"] {
            std::fs::write(&settings, original).unwrap();
            let def = HookDefinition {
                agent_id: "qoder".into(),
                settings_path: settings.to_string_lossy().into_owned(),
                settings_syntax: None,
                hook_json_path: vec!["hooks".into(), "Stop".into()],
                hook_command: "/opt/qoder-loongsuite-pilot-hook.sh".into(),
                matcher: Some("*".into()),
                history_dir: None,
                replace_hook_commands: None,
                use_nested_format: Some(true),
                shell: None,
                timeout: None,
                insert: None,
            };
            assert!(manager(dir.path()).install_hook(&def).await);
            let parsed: Value =
                serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
            assert_eq!(
                parsed["hooks"]["Stop"][0]["hooks"][0]["command"],
                "/opt/qoder-loongsuite-pilot-hook.sh"
            );
        }
        std::fs::write(&settings, "{not json").unwrap();
        let def = HookDefinition {
            agent_id: "qoder".into(),
            settings_path: settings.to_string_lossy().into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "Stop".into()],
            hook_command: "/opt/qoder-loongsuite-pilot-hook.sh".into(),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        };
        assert!(!manager(dir.path()).install_hook(&def).await);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{not json");
    }

    #[tokio::test]
    async fn uninstall_removes_replacement_commands() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join(".codex").join("hooks.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "command": "otel-codex-hook pre-tool-use", "type": "command" }] },
      { "matcher": "*", "hooks": [{ "command": "/opt/loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.sh pre-tool-use", "type": "command" }] }
    ]
  }
}"#,
        )
        .unwrap();
        let def = HookDefinition {
            agent_id: "codex".into(),
            settings_path: settings.to_string_lossy().into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "PreToolUse".into()],
            hook_command: "/opt/loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.sh pre-tool-use"
                .into(),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: Some(vec!["otel-codex-hook pre-tool-use".into()]),
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        };
        assert!(manager(dir.path()).uninstall_hook(&def).await);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(parsed["hooks"].get("PreToolUse").is_none());
    }

    #[tokio::test]
    async fn jsonc_install_keeps_comments_and_uninstalls_only_the_pilot_hook() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join(".qwen").join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let original = r#"{
  // Keep the user's selected model.
  "model": "qwen-max",
  "mcpServers": { "work": { "command": "node" } },
  "permissions": {
    // This comment must survive hook installation.
    "allow": ["read"]
  },
  "hooks": {
    "Stop": [
      // Keep a third-party hook and its comment.
      { "matcher": "*", "hooks": [{ "command": "/opt/other-hook.sh", "type": "command" }] }
    ]
  }
}
"#;
        std::fs::write(&settings, original).unwrap();
        let def = HookDefinition {
            agent_id: "qwen-code-cli".into(),
            settings_path: settings.to_string_lossy().into_owned(),
            settings_syntax: Some(SettingsSyntax::Jsonc),
            hook_json_path: vec!["hooks".into(), "Stop".into()],
            hook_command: "/opt/qwen-loongsuite-pilot-hook.sh stop".into(),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        };
        assert!(manager(dir.path()).install_hook(&def).await);
        let updated = std::fs::read_to_string(&settings).unwrap();
        assert!(updated.contains("// Keep the user's selected model."));
        assert!(updated.contains("// This comment must survive hook installation."));
        assert!(updated.contains("// Keep a third-party hook and its comment."));
        assert!(updated.contains("/opt/qwen-loongsuite-pilot-hook.sh stop"));
        let parsed = parse_json_document(&updated, JsonSyntax::Jsonc).unwrap();
        assert_eq!(parsed["model"], "qwen-max");
        assert_eq!(parsed["mcpServers"]["work"]["command"], "node");
        assert_eq!(parsed["permissions"]["allow"], serde_json::json!(["read"]));
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            std::fs::read_to_string(format!("{}.loongsuite-pilot.bak", settings.display()))
                .unwrap(),
            original
        );

        assert!(manager(dir.path()).uninstall_hook(&def).await);
        let removed = std::fs::read_to_string(&settings).unwrap();
        assert!(!removed.contains("/opt/qwen-loongsuite-pilot-hook.sh stop"));
        assert!(removed.contains("/opt/other-hook.sh"));
        assert!(removed.contains("// Keep the user's selected model."));
    }

    #[tokio::test]
    async fn repairs_shell_and_moves_interceptor_timeout_to_head() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &settings,
            r#"{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "command": "/opt/other.sh", "type": "command" }] },
      { "matcher": "*", "hooks": [{ "command": "/opt/pilot.sh", "type": "command" }] }
    ]
  }
}"#,
        )
        .unwrap();
        let def = HookDefinition {
            agent_id: "qwen".into(),
            settings_path: settings.to_string_lossy().into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), "PreToolUse".into()],
            hook_command: "/opt/pilot.sh".into(),
            matcher: Some("*".into()),
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: Some("powershell".into()),
            timeout: Some(10.0),
            insert: Some(HookInsert::Head),
        };
        assert!(!manager(dir.path()).is_hook_installed(&def).await);
        assert!(manager(dir.path()).install_hook(&def).await);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            parsed["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "/opt/pilot.sh"
        );
        assert_eq!(
            parsed["hooks"]["PreToolUse"][0]["hooks"][0]["shell"],
            "powershell"
        );
        assert_eq!(parsed["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"], 10);
        assert!(manager(dir.path()).is_hook_installed(&def).await);
    }
}

#[cfg(test)]
#[path = "hook_manager_history_contract_tests.rs"]
mod history_contract_tests;
