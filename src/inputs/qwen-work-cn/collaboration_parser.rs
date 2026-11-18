use crate::types::{AgentActivityEntry, AgentEventName, ClientType};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(super) struct Turn {
    pub key: String,
    pub completed_at_ms: i64,
    pub entries: [AgentActivityEntry; 2],
}

pub(super) use crate::types::QWEN_COLLABORATION_SOURCE as SOURCE;

pub(super) fn turns<'a>(
    state: &'a Value,
    included: Option<&'a HashSet<String>>,
    observed_ns: &'a str,
) -> anyhow::Result<impl Iterator<Item = Turn> + 'a> {
    anyhow::ensure!(
        state["version"].as_u64() == Some(1),
        "invalid collaboration state version"
    );
    let accounts = state["accounts"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid collaboration accounts"))?;
    Ok(accounts
        .iter()
        .filter_map(|(key, account)| {
            Some((
                key,
                account,
                text(&account["userId"])?,
                account["messages"].as_object()?,
                account["cards"].as_object()?,
            ))
        })
        .flat_map(move |(account_key, account, user, messages, cards)| {
            messages.iter().filter_map(move |(reply_key, reply)| {
                parse_turn(
                    account_key,
                    account,
                    user,
                    messages,
                    cards,
                    reply_key,
                    reply,
                    included,
                    observed_ns,
                )
            })
        }))
}

#[allow(clippy::too_many_arguments)]
fn parse_turn(
    account_key: &str,
    account: &Value,
    user: &str,
    messages: &Map<String, Value>,
    cards: &Map<String, Value>,
    reply_key: &str,
    reply: &Value,
    included: Option<&HashSet<String>>,
    observed_ns: &str,
) -> Option<Turn> {
    let reply_id = text(&reply["messageId"])?;
    let conversation = text(&reply["conversationId"])?;
    let prompt_id = text(&reply["replyToMessageId"])?;
    let card_id = text(&reply["cardRef"]["cardId"])?;
    let agent = sender(
        &reply["sender"],
        &["DE", "AGENT", "PRINCIPAL_TYPE_DE", "PRINCIPAL_TYPE_AGENT"],
    )?;
    if reply_id != reply_key
        || included.is_some_and(|ids| !ids.contains(conversation))
        || revoked(account, conversation)
        || [reply_id, prompt_id]
            .into_iter()
            .any(|id| account["removedMessages"].get(id).is_some())
    {
        return None;
    }
    let prompt = messages.get(prompt_id)?;
    if text(&prompt["messageId"]) != Some(prompt_id)
        || text(&prompt["conversationId"]) != Some(conversation)
        || sender(&prompt["sender"], &["HUMAN", "PRINCIPAL_TYPE_HUMAN"]) != Some(user)
    {
        return None;
    }
    let input = text(&prompt["text"])?;
    let card = cards.get(card_id)?;
    let message_link = &card["messageLink"];
    if text(&card["cardId"]) != Some(card_id)
        || card["resourceState"] != "AVAILABLE"
        || !matches!(
            card["contentStatus"].as_str(),
            Some("FINAL" | "CARD_CONTENT_STATUS_FINAL")
        )
        || card["partial"] == true
        || card["contentUnsupported"] == true
        || text(&message_link["cid"]).is_some_and(|id| id != conversation)
        || text(&message_link["messageId"]).is_some_and(|id| id != reply_id)
    {
        return None;
    }
    let start = time_nanos(&prompt["createdAt"])?;
    let terminal = time_nanos(&card["terminalAt"]);
    let end = terminal.or_else(|| time_nanos(&card["updatedAt"]))?;
    if end <= start {
        return None;
    }
    let output = card_text(card)?;
    let org = text(&account["orgId"]).unwrap_or_default();
    let session = digest(&["session", account_key, user, org, conversation]);
    let key = digest(&["turn", account_key, user, org, conversation, reply_id]);
    let mut first = AgentActivityEntry {
        time_unix_nano: start.to_string(),
        observed_time_unix_nano: Some(observed_ns.to_owned()),
        event_id: digest(&["start", &key]),
        user_id: user.to_owned(),
        event_name: Some(AgentEventName::Other),
        session_id: session,
        turn_id: Some(key.clone()),
        agent_type: ClientType::QwenWorkCN.as_str().to_owned(),
        agent_id: Some(agent.to_owned()),
        turn_start: Some(true),
        ..AgentActivityEntry::default()
    };
    first
        .extra
        .insert("loongsuite.observation.scope".into(), "agent_turn".into());
    first.extra.insert("agent.source".into(), SOURCE.into());
    let mut last = first.clone();
    first.input_messages_delta = Some(message("user", input));
    last.event_id = digest(&["end", &key]);
    last.time_unix_nano = end.to_string();
    last.turn_start = None;
    last.turn_end = Some(true);
    last.output_messages = Some(message("assistant", &output));
    last.extra.insert(
        "loongsuite.qwenworkcn.completion_time_source".into(),
        if terminal.is_some() {
            "card.terminalAt"
        } else {
            "card.updatedAt"
        }
        .into(),
    );
    Some(Turn {
        key,
        completed_at_ms: i64::try_from(end / 1_000_000).ok()?,
        entries: [first, last],
    })
}

fn message(role: &str, content: &str) -> Value {
    json!([{"role":role, "parts":[{"type":"text", "content":content}]}])
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

fn sender<'a>(value: &'a Value, types: &[&str]) -> Option<&'a str> {
    types
        .contains(&value["type"].as_str()?)
        .then(|| text(&value["id"]))
        .flatten()
}

fn revoked(account: &Value, conversation: &str) -> bool {
    let key = json!([conversation, ""]).to_string();
    let attention = &account["attention"];
    truthy(&attention["denied"][&key])
        || (truthy(&account["removedConversations"][conversation])
            && !truthy(&attention["grants"][&key]))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

fn time_nanos(value: &Value) -> Option<u128> {
    let seconds = &value["seconds"];
    let parsed = if let Some(seconds) = seconds.as_str() {
        if seconds.len() > 11 || !seconds.bytes().all(|digit| digit.is_ascii_digit()) {
            return None;
        }
        seconds.parse::<u64>().ok()?
    } else {
        seconds.as_u64()?
    };
    let nanos = match value.get("nanos") {
        Some(nanos) if !nanos.is_null() => nanos.as_u64()?,
        _ => 0,
    };
    (parsed < 100_000_000_000 && nanos < 1_000_000_000)
        .then(|| u128::from(parsed) * 1_000_000_000 + u128::from(nanos))
}

fn digest(parts: &[&str]) -> String {
    let bytes = serde_json::to_vec(parts).expect("strings serialize");
    hex::encode(Sha256::digest(bytes))
}

fn card_text(card: &Value) -> Option<String> {
    let content = card["content"]
        .as_str()
        .or_else(|| card["markdown"].as_str())?;
    if content.is_empty() || content.len() > 512 * 1024 {
        return None;
    }
    match text(&card["contentFormat"]) {
        None | Some("CARD_CONTENT_FORMAT_UNSPECIFIED") => return Some(content.to_owned()),
        Some("CARD_CONTENT_FORMAT_ACP_NDJSON_V1") => {}
        _ => return None,
    }
    let mut output = String::new();
    let mut session = None::<String>;
    let mut prompts = 0;
    let mut terminal = false;
    for line in content.strip_suffix('\n')?.split('\n') {
        let event: Value = serde_json::from_str(line).ok()?;
        let method = event["method"].as_str();
        let params = &event["params"];
        let update = &params["update"];
        if event["jsonrpc"] != "2.0"
            || update["_meta"]["content_blocked"] == true
            || update["_meta"]["compressed"] == true
            || matches!(method, Some("_qwenwork/compression" | "session/cancel"))
            || method == Some("_qwenwork/notice") && params["code"] == "CONTENT_TOO_LARGE"
            || truthy(&event["error"])
        {
            return None;
        }
        if let Some(id) = text(&params["sessionId"]) {
            if session.as_deref().is_some_and(|session| session != id) {
                return None;
            }
            session.get_or_insert_with(|| id.to_owned());
        }
        if method == Some("session/prompt") {
            prompts += 1;
            if prompts > 1 {
                return None;
            }
            terminal = false;
        }
        if event.get("method").is_none() {
            if let Some(reason) = event["result"]["stopReason"].as_str() {
                if reason == "cancelled" {
                    return None;
                }
                terminal = true;
            }
        }
        if method == Some("session/update")
            && update["sessionUpdate"] == "agent_message_chunk"
            && !terminal
        {
            let content = &update["content"];
            if let Some(parts) = content.as_array() {
                for part in parts {
                    append_acp_text(part, 0, &mut output);
                }
            } else {
                append_acp_text(content, 0, &mut output);
            }
        }
    }
    (!output.is_empty()).then_some(output)
}

fn append_acp_text(part: &Value, depth: usize, output: &mut String) {
    if depth > 4 {
        return;
    }
    match part["type"].as_str() {
        Some("text") => output.push_str(part["text"].as_str().unwrap_or_default()),
        Some("content") => {
            let content = &part["content"];
            if let Some(children) = content.as_array() {
                for (index, child) in children.iter().enumerate() {
                    if index > 0 {
                        output.push('\n');
                    }
                    append_acp_text(child, depth + 1, output);
                }
            } else {
                append_acp_text(content, depth + 1, output);
            }
        }
        _ => {}
    }
}
