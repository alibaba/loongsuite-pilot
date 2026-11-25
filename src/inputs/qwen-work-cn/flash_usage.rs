use crate::inputs::base::{is_event, query_readonly};
use crate::interceptor::prompt_verdict::{digest, lookup_from_entry};
use crate::types::AgentActivityEntry;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

const PROMPT_SKEW_MS: i64 = 5_000;
const MAX_PROMPT_ROWS: usize = 32;
const MAX_CALL_PARTS: usize = 1_024;
const JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(super) struct FlashSource {
    pub desktop_db: String,
    pub flash_db: String,
}

impl FlashSource {
    pub(super) async fn bindings(
        &self,
        entries: &[AgentActivityEntry],
    ) -> Result<HashMap<String, String>, String> {
        let sessions: HashSet<_> = entries
            .iter()
            .filter(|entry| is_event(entry, "llm.request") && !entry.session_id.is_empty())
            .map(|entry| entry.session_id.as_str())
            .collect();
        if sessions.is_empty()
            || !Path::new(&self.flash_db).is_file()
            || !Path::new(&self.desktop_db).is_file()
        {
            return Ok(HashMap::new());
        }
        let limit = sessions.len() * 2;
        let rows = query_readonly(
            &self.desktop_db,
            "SELECT id, session_id,
                    json_extract(ext, '$.engineSessionBindingV1.hostSessionId') AS host_session,
                    json_extract(ext, '$.engineSessionBindingV1.subChatId') AS sub_chat,
                    json_extract(ext, '$.engineSessionBindingV1.nativeSessionId') AS native_session,
                    json_extract(ext, '$.engineSessionBindingV1.engineId') AS engine,
                    json_extract(ext, '$.engineSessionBindingV1.storageNamespace') AS storage
             FROM sub_chats
             WHERE session_id IN (SELECT value FROM json_each(?)) AND json_valid(ext)
             LIMIT ?",
            &[
                json!(serde_json::to_string(&sessions).unwrap()),
                json!(limit + 1),
            ],
        )
        .await?;
        if rows.len() > limit {
            return Ok(HashMap::new());
        }
        let mut bindings = HashMap::new();
        let mut ambiguous = HashSet::new();
        let expected = normalize_path(Path::new(&self.flash_db));
        for row in rows {
            let (Some(id), Some(session), Some(native), Some(storage)) = (
                row["id"].as_str(),
                row["session_id"].as_str(),
                row["native_session"].as_str().filter(|id| !id.is_empty()),
                row["storage"].as_str().map(Path::new),
            ) else {
                continue;
            };
            if row["engine"] == "opencode"
                && row["host_session"] == session
                && row["sub_chat"] == id
                && storage.is_absolute()
                && normalize_path(storage) == expected
                && bindings
                    .insert(session.to_owned(), native.to_owned())
                    .is_some()
            {
                ambiguous.insert(session.to_owned());
            }
        }
        bindings.retain(|session, _| !ambiguous.contains(session));
        Ok(bindings)
    }

    pub(super) async fn enrich(
        &self,
        entries: &mut [AgentActivityEntry],
        steps: &[(usize, usize)],
        native_session: &str,
    ) -> Result<(), String> {
        let Some((first, _)) = steps.first() else {
            return Ok(());
        };
        let first = &entries[*first];
        let Some(prompt) = lookup_from_entry(first) else {
            return Ok(());
        };
        let Some(observed) = first
            .observed_time_unix_nano
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .map(|nano| nano / 1_000_000)
            .filter(|observed| *observed >= prompt.at)
        else {
            return Ok(());
        };
        let earliest = prompt.at.saturating_sub(PROMPT_SKEW_MS);
        let rows = query_readonly(
            &self.flash_db,
            "SELECT m.id, json_extract(p.data, '$.text') AS text
             FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
             WHERE m.session_id = ? AND m.time_created BETWEEN ? AND ?
               AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
               AND json_extract(p.data, '$.synthetic') IS NOT 1
               AND length(json_extract(p.data, '$.text')) <= 131072
             ORDER BY m.time_created, m.id, p.id LIMIT ?",
            &[
                json!(native_session),
                json!(earliest),
                json!(observed.min(prompt.at.saturating_add(PROMPT_SKEW_MS))),
                json!(MAX_PROMPT_ROWS + 1),
            ],
        )
        .await?;
        if rows.len() > MAX_PROMPT_ROWS {
            return Ok(());
        }
        let mut messages: HashMap<&str, Vec<&str>> = HashMap::new();
        for row in &rows {
            if let (Some(id), Some(text)) = (row["id"].as_str(), row["text"].as_str()) {
                messages.entry(id).or_default().push(text);
            }
        }
        let mut owners = messages
            .into_iter()
            .filter(|(_, parts)| digest(&parts.join("\n")) == prompt.prompt_hash);
        let Some((owner, _)) = owners.next() else {
            return Ok(());
        };
        if owners.next().is_some() {
            return Ok(());
        }
        let rows = query_readonly(
            &self.flash_db,
            "SELECT m.id AS message_id, json_extract(m.data, '$.modelID') AS model,
                    json_extract(p.data, '$.type') AS kind, json_extract(p.data, '$.callID') AS call_id,
                    json_extract(p.data, '$.tokens.input') AS input,
                    json_extract(p.data, '$.tokens.output') AS output,
                    json_extract(p.data, '$.tokens.reasoning') AS reasoning,
                    json_extract(p.data, '$.tokens.cache.read') AS cache_read,
                    json_extract(p.data, '$.tokens.cache.write') AS cache_write
             FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
             WHERE m.session_id = ? AND m.time_created BETWEEN ? AND ?
               AND json_extract(m.data, '$.role') = 'assistant'
               AND json_extract(m.data, '$.parentID') = ?
               AND json_extract(p.data, '$.type') IN ('tool', 'step-finish')
             ORDER BY m.time_created, m.id, p.id LIMIT ?",
            &[json!(native_session), json!(earliest), json!(observed), json!(owner), json!(MAX_CALL_PARTS + 1)],
        )
        .await?;
        if rows.len() > MAX_CALL_PARTS {
            return Ok(());
        }
        let mut calls = Vec::new();
        let mut tools = Vec::new();
        let mut message = None;
        for row in &rows {
            if message != row["message_id"].as_str() && !tools.is_empty() {
                return Ok(());
            }
            message = row["message_id"].as_str();
            match row["kind"].as_str() {
                Some("tool") => {
                    let Some(id) = row["call_id"].as_str().filter(|id| !id.is_empty()) else {
                        return Ok(());
                    };
                    tools.push(id);
                }
                Some("step-finish") => {
                    tools.sort_unstable();
                    calls.push((row, std::mem::take(&mut tools)));
                }
                _ => return Ok(()),
            }
        }
        if !tools.is_empty() || calls.len() != steps.len() {
            return Ok(());
        }
        for ((request, _), (_, tools)) in steps.iter().zip(&calls) {
            let step = &entries[*request].step_id;
            let mut expected: Vec<_> = entries
                .iter()
                .filter(|entry| entry.step_id == *step && is_event(entry, "tool.call"))
                .map(|entry| entry.tool_call_id.as_deref().unwrap_or(""))
                .collect();
            expected.sort_unstable();
            if &expected != tools {
                return Ok(());
            }
        }
        for ((request, response), (call, _)) in steps.iter().copied().zip(calls) {
            apply_call(entries, request, response, call);
        }
        Ok(())
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(part),
        }
    }
    result
}

fn apply_call(entries: &mut [AgentActivityEntry], request: usize, response: usize, call: &Value) {
    if let Some(model) = call["model"]
        .as_str()
        .map(str::trim)
        .filter(|model| !super::qwen_work_cn_trace_input::missing_model(Some(model)))
        .filter(|model| model.encode_utf16().count() <= 512)
    {
        for index in [request, response] {
            if super::qwen_work_cn_trace_input::missing_model(
                entries[index].request_model.as_deref(),
            ) {
                entries[index].request_model = Some(model.to_owned());
            }
        }
        if entries[response]
            .response_model
            .as_deref()
            .is_some_and(|name| {
                matches!(name, "unknown" | "auto") || (name == model && model.starts_with("mode-"))
            })
        {
            entries[response].response_model = None;
        }
    }
    let response = &mut entries[response];
    if response.input_tokens.is_some() || response.output_tokens.is_some() {
        return;
    }
    let tokens = |key| {
        let value = &call[key];
        let count = value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|number| {
                    number.fract() == 0.0 && (0.0..=JS_SAFE_INTEGER as f64).contains(number)
                })
                .map(|number| number as i64)
        })?;
        (0..=JS_SAFE_INTEGER).contains(&count).then_some(count)
    };
    let (Some(uncached), Some(text), Some(reasoning), Some(cache_read), Some(cache_write)) = (
        tokens("input"),
        tokens("output"),
        tokens("reasoning"),
        tokens("cache_read"),
        tokens("cache_write"),
    ) else {
        return;
    };
    let input = uncached + cache_read + cache_write;
    let output = text + reasoning;
    let total = input + output;
    if (1..=JS_SAFE_INTEGER).contains(&total) {
        response.input_tokens = Some(input);
        response.output_tokens = Some(output);
        response.total_tokens = Some(total);
        response.cache_read_input_tokens = (cache_read > 0).then_some(cache_read);
        response.cache_creation_input_tokens = (cache_write > 0).then_some(cache_write);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inputs::base::entry_from;
    use rusqlite::{params, Connection};

    #[tokio::test]
    async fn qwen_flash_usage_matches_one_owner_and_preserves_authoritative_usage() {
        let root = tempfile::tempdir().unwrap();
        let source = FlashSource {
            desktop_db: root.path().join("agents.db").to_str().unwrap().into(),
            flash_db: root.path().join("flash.db").to_str().unwrap().into(),
        };
        let desktop = Connection::open(&source.desktop_db).unwrap();
        desktop
            .execute_batch("CREATE TABLE sub_chats(id TEXT, session_id TEXT, ext TEXT);")
            .unwrap();
        let binding = |sub| {
            json!({"engineSessionBindingV1":{
                "hostSessionId":"desktop","subChatId":sub,"nativeSessionId":"native",
                "engineId":"opencode","storageNamespace":source.flash_db
            }})
        };
        desktop
            .execute(
                "INSERT INTO sub_chats VALUES('sub','desktop',?)",
                [binding("sub").to_string()],
            )
            .unwrap();
        let flash = Connection::open(&source.flash_db).unwrap();
        flash
            .execute_batch(
                "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);",
            )
            .unwrap();
        for (id, at, value) in [
            ("prompt", 10_000, json!({"role":"user"})),
            (
                "reply",
                11_000,
                json!({"role":"assistant","parentID":"prompt","modelID":"mode-flash"}),
            ),
        ] {
            flash
                .execute(
                    "INSERT INTO message VALUES(?,'native',?,?)",
                    params![id, at, value.to_string()],
                )
                .unwrap();
        }
        let call = json!({"type":"step-finish","tokens":{"input":20,"output":5,"reasoning":2,"cache":{"read":3,"write":4}}});
        for (id, message, value) in [
            (
                "part-0",
                "prompt",
                json!({"type":"text","text":"offline sample"}),
            ),
            ("part-1", "reply", json!({"type":"tool","callID":"tool"})),
            ("part-2", "reply", call.clone()),
            ("part-3", "reply", call),
        ] {
            flash
                .execute(
                    "INSERT INTO part VALUES(?,'native',?,?)",
                    params![id, message, value.to_string()],
                )
                .unwrap();
        }

        let mut entries: Vec<_> = [
            json!({"event.name":"llm.request","gen_ai.step.id":"one","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"offline sample"}]}],"time_unix_nano":"10000000000","observed_time_unix_nano":"12000000000"}),
            json!({"event.name":"llm.response","gen_ai.step.id":"one","gen_ai.response.model":"auto"}),
            json!({"event.name":"tool.call","gen_ai.step.id":"one","gen_ai.tool.call.id":"tool"}),
            json!({"event.name":"llm.request","gen_ai.step.id":"two"}),
            json!({"event.name":"llm.response","gen_ai.step.id":"two","gen_ai.usage.input_tokens":42,"gen_ai.usage.output_tokens":41,"gen_ai.response.model":"actual-model"}),
        ].into_iter().map(|mut value| {
            value["gen_ai.agent.type"] = "qwen-work-cn".into();
            value["gen_ai.session.id"] = "desktop".into();
            entry_from(value.as_object().unwrap().clone())
        }).collect();
        assert!(is_event(&entries[0], "llm.request"));
        assert_eq!(
            source.bindings(&entries).await.unwrap()["desktop"],
            "native"
        );
        let steps = [(0, 1), (3, 4)];
        entries[2].tool_call_id = Some("different".into());
        source.enrich(&mut entries, &steps, "native").await.unwrap();
        assert_eq!(entries[1].input_tokens, None);
        entries[2].tool_call_id = Some("tool".into());
        source.enrich(&mut entries, &steps, "native").await.unwrap();
        let response = &entries[1];
        assert_eq!(
            (
                response.input_tokens,
                response.output_tokens,
                response.total_tokens
            ),
            (Some(27), Some(7), Some(34))
        );
        assert_eq!(
            (
                response.cache_read_input_tokens,
                response.cache_creation_input_tokens
            ),
            (Some(3), Some(4))
        );
        assert_eq!(response.request_model.as_deref(), Some("mode-flash"));
        assert_eq!(response.response_model, None);
        assert_eq!(entries[4].input_tokens, Some(42));
        assert_eq!(entries[4].response_model.as_deref(), Some("actual-model"));

        desktop
            .execute(
                "INSERT INTO sub_chats VALUES('other','desktop',?)",
                [binding("other").to_string()],
            )
            .unwrap();
        assert!(source.bindings(&entries).await.unwrap().is_empty());
    }
}
