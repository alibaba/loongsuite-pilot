use crate::hook_process::common::{env_get, home_dir, Env};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub(super) struct Model {
    pub model: String,
    pub provider: String,
    pub display_model: String,
    pub agent_type: String,
}

impl Model {
    pub fn update(&mut self, event: &Value, env: &Env) {
        if let Some(role) = text(&event["agent_type"]) {
            self.agent_type = role.to_owned();
        }
        let info = &event["model_info"];
        let model = [
            &info["model_name"],
            &info["model"],
            &event["model"],
            &event["request"]["model"],
            &event["display_model_name"],
        ]
        .into_iter()
        .find_map(text);
        let chosen = (model.is_none() && unknown(&self.model))
            .then(|| selected_model(env, event, &self.agent_type))
            .flatten();
        if let Some(name) = model.or_else(|| chosen.as_ref().and_then(|model| text(&model["name"])))
        {
            self.model = name.to_owned();
        }
        if let Some(display) = text(&event["display_model_name"])
            .or_else(|| text(&info["display_name"]))
            .or_else(|| {
                chosen
                    .as_ref()
                    .and_then(|model| text(&model["display_name"]))
            })
            .or(model)
        {
            self.display_model = display.to_owned();
        }
        if let Some(provider) = text(&info["provider"])
            .or_else(|| text(&event["provider"]))
            .or_else(|| text(&event["provider_name"]))
            .or_else(|| chosen.as_ref().and_then(|model| text(&model["provider"])))
            .or_else(|| {
                (model.is_some() || unknown(&self.provider))
                    .then(|| infer_provider(&self.model))
                    .flatten()
            })
        {
            self.provider = provider.to_owned();
        }
    }

    pub fn name(&self) -> &str {
        if unknown(&self.model) {
            "unknown"
        } else {
            &self.model
        }
    }

    pub fn display(&self) -> &str {
        if unknown(&self.display_model) {
            self.name()
        } else {
            &self.display_model
        }
    }

    pub fn provider(&self) -> &str {
        if unknown(&self.provider) {
            "unknown"
        } else {
            &self.provider
        }
    }
}

fn unknown(value: &str) -> bool {
    value.is_empty() || value == "unknown"
}

pub(super) fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

fn infer_provider(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    [
        ("qwen", "qwen"),
        ("tongyi", "qwen"),
        ("doubao", "doubao"),
        ("deepseek", "deepseek"),
        ("gpt", "openai"),
        ("openai", "openai"),
        ("codex", "openai"),
    ]
    .into_iter()
    .find(|(name, _)| model.contains(name))
    .map(|(_, provider)| provider)
}

fn normalized(role: &str) -> Option<&'static str> {
    match role.split('(').next()?.trim() {
        "Builder" | "BuilderWithMcp" | "Chat" | "builder" | "chat" => Some("builder"),
        "SoloCoder" | "SoloAgent" | "Custom" | "solo_agent" | "solo_coder" => Some("solo_coder"),
        "UiBuilder" | "ui_builder" | "solo_builder" => Some("solo_builder"),
        _ => None,
    }
}

fn selected_model(env: &Env, event: &Value, role: &str) -> Option<Value> {
    let home = home_dir(env);
    let root = env_get(env, "TRAES_USER_DATA_DIR").map(PathBuf::from);
    let explicit = text(&event["user_data_dir"]).map(PathBuf::from);
    let platform = (cfg!(target_os = "macos") && root.is_none() && explicit.is_none())
        .then(|| home.join("Library/Application Support/Trae CN"));
    let database = root
        .into_iter()
        .chain(explicit)
        .chain([home.join(".trae-cn")])
        .chain(platform)
        .flat_map(|root| {
            [
                root.join("User/globalStorage/state.vscdb"),
                root.join("state.vscdb"),
            ]
        })
        .find(|path| path.symlink_metadata().is_ok_and(|stat| stat.is_file()))?;
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(std::time::Duration::from_millis(40)).ok()?;
    let get =
        |key: &str| {
            db.query_row(
        "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = ?1 AND length(value) <= 2097152",
        [key], |row| row.get::<_, String>(0),
    ).ok()
        };
    let selection = get("session_selected_model");
    if let Some(model) = selection.as_deref().and_then(|data| {
        let options: Value = serde_json::from_str(data).ok()?;
        let choices = options.get(text(&event["session_id"])?)?.as_object()?;
        let candidate = choices.get(role).or_else(|| {
            let role = normalized(role)?;
            choices
                .iter()
                .find(|(key, _)| normalized(key) == Some(role))
                .map(|(_, model)| model)
        })?;
        text(&candidate["modelId"]).map(|id| {
            let name = match id.split_once("__") {
                Some((prefix, model))
                    if prefix.rsplit_once('_').is_some_and(|(kind, rank)| {
                        !kind.is_empty()
                            && kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                            && !rank.is_empty()
                            && rank.bytes().all(|b| b.is_ascii_digit())
                    }) =>
                {
                    model
                }
                _ => id,
            };
            serde_json::json!({"name":name,"display_name":name})
        })
    }) {
        return Some(model);
    }
    if let Some(catalog_model) = get("AI.agent.model.model_list_map").and_then(|data| {
        let key = normalized(role)?;
        let catalog: Value = serde_json::from_str(&data).ok()?;
        let choices = catalog.as_object()?;
        let list = choices
            .get(key)
            .and_then(Value::as_array)
            .filter(|list| !list.is_empty())
            .or_else(|| {
                choices
                    .iter()
                    .filter(|(name, _)| normalized(name) == Some(key))
                    .filter_map(|(_, value)| value.as_array())
                    .find(|list| !list.is_empty())
            })?;
        let selected = list
            .iter()
            .find(|model| model["is_default"] == true)
            .or_else(|| list.first())?;
        text(&selected["name"])?;
        Some(selected.clone())
    }) {
        return Some(catalog_model);
    }
    selection
        .filter(|data| !data.trim_start().starts_with(['{', '[']) && !data.trim().is_empty())
        .or_else(|| get("ai_assistant.request.model").filter(|data| !data.trim().is_empty()))
        .map(|model| serde_json::json!({"name":model,"display_name":model}))
}
