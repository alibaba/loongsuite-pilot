//! Recoverable Qoder CLI delegation metadata. Conversation bodies stay in the transcript.
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) const KEY: &str = "__qoderDelegations";
const CAPACITY: usize = 4096;
const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub(super) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 512)
}

pub(super) fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("JSON value"),
    ))
}

pub(super) fn blocks(row: &Value) -> impl Iterator<Item = &Value> {
    row.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

pub(super) fn calls(row: &Value) -> impl Iterator<Item = &Value> {
    blocks(row).filter(move |block| {
        row["entrypoint"] == "cli"
            && row["type"] == "assistant"
            && matches!(block["name"].as_str(), Some("Agent" | "Task"))
            && text(block, "id").is_some()
            && block["input"].is_object()
    })
}

pub(super) fn parent_call<'a>(source: &Value, prompt: &'a Value) -> Option<&'a str> {
    let child = text(source, "subagentId")?;
    let row_agent = text(prompt, "agentId");
    (prompt["entrypoint"] == "cli"
        && ((prompt["isDelegatedTask"] == true && row_agent.is_none_or(|id| id == child))
            || (prompt.get("isDelegatedTask").is_none()
                && prompt["isSidechain"] == true
                && row_agent == Some(child)
                && prompt.get("parentUuid").is_some_and(Value::is_null))))
    .then(|| text(prompt, "parent_tool_use_id"))
    .flatten()
}

pub(super) fn notification(row: &Value) -> Option<(&str, &str, Option<&str>)> {
    fn tag<'a>(input: &'a str, open: &str, close: &str) -> Option<&'a str> {
        input
            .split_once(open)?
            .1
            .rsplit_once(close)
            .map(|pair| pair.0)
    }
    if row["entrypoint"] != "cli"
        || row["type"] != "user"
        || row["isMeta"] != true
        || row["origin"]["kind"] != "task-notification"
    {
        return None;
    }
    let content = row.pointer("/message/content")?;
    let candidate = content.as_str().or_else(|| {
        content
            .as_array()?
            .iter()
            .find_map(|b| (b["type"] == "text").then(|| b["text"].as_str()).flatten())
    })?;
    let body = tag(candidate, "<task-notification>", "</task-notification>")?;
    let metadata = body.split_once("<result>").map_or(body, |(head, _)| head);
    let call = tag(metadata, "<tool-use-id>", "</tool-use-id>")?;
    let status = tag(metadata, "<status>", "</status>")?;
    if call.is_empty()
        || call.len() > 512
        || !call
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        || !matches!(status, "completed" | "failed" | "cancelled" | "stopped")
    {
        return None;
    }
    Some((call, status, tag(body, "<result>", "</result>")))
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Link {
    pub id: String,
    #[serde(alias = "sessionId")]
    pub session: String,
    #[serde(alias = "agentId")]
    pub agent: String,
    #[serde(alias = "turnId")]
    pub turn: String,
    #[serde(alias = "callId")]
    pub call: String,
    #[serde(alias = "toolName")]
    pub tool: String,
    #[serde(alias = "traceId")]
    pub trace: String,
    #[serde(alias = "spanId")]
    pub span: String,
    #[serde(alias = "peerId")]
    pub peer: Option<String>,
    #[serde(alias = "peerName")]
    pub peer_name: Option<String>,
    #[serde(default, alias = "resultEmitted")]
    pub result_emitted: bool,
    #[serde(default, alias = "childComplete")]
    pub child_complete: bool,
    at: i64,
}

#[derive(Default)]
pub(super) struct Links {
    entries: IndexMap<String, Link>,
    undo: IndexMap<String, Option<Link>>,
    now: i64,
    dirty: bool,
}

fn valid_id(id: &str, length: usize) -> bool {
    id.len() == length
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && id.bytes().any(|c| c != b'0')
}

impl Links {
    pub fn load(state: Option<&Value>, now: i64) -> Self {
        let mut links = Self {
            now,
            ..Self::default()
        };
        if let Some(state) = state.and_then(Value::as_object) {
            for (id, item) in state.iter().take(CAPACITY) {
                if let Ok(link) = Link::deserialize(item) {
                    if id == &link.id
                        && valid_id(id, 32)
                        && valid_id(&link.trace, 32)
                        && valid_id(&link.span, 16)
                        && [&link.session, &link.agent, &link.turn, &link.call]
                            .iter()
                            .all(|id| !id.is_empty() && id.len() <= 512)
                        && item.get("invokeEmitted") != Some(&Value::Bool(false))
                        && link.at >= now.saturating_sub(MAX_AGE_MS)
                    {
                        links.entries.insert(id.clone(), link);
                    }
                }
            }
            links.dirty = links.entries.len() != state.len();
        }
        links
    }

    pub fn store(&self, state: &mut Value) -> anyhow::Result<()> {
        if self.dirty {
            if self.entries.is_empty() {
                state
                    .as_object_mut()
                    .expect("checkpoint object")
                    .remove(KEY);
            } else {
                state[KEY] = serde_json::to_value(&self.entries)?;
            }
        }
        Ok(())
    }

    pub fn finish_source(&mut self, committed: bool) {
        if committed {
            self.dirty |= !self.undo.is_empty();
            self.undo.clear();
        } else {
            for (id, prior) in self.undo.drain(..) {
                if let Some(prior) = prior {
                    self.entries.insert(id, prior);
                } else {
                    self.entries.shift_remove(&id);
                }
            }
        }
    }

    pub fn find(
        &self,
        session: &str,
        call: &str,
        agent: Option<&str>,
        turn: Option<&str>,
    ) -> Option<&Link> {
        let mut matches = self.entries.values().filter(|link| {
            link.session == session
                && link.call == call
                && agent.is_none_or(|agent| agent == link.agent)
                && turn.is_none_or(|turn| turn == link.turn)
        });
        let only = matches.next()?;
        matches.next().is_none().then_some(only)
    }

    pub fn insert(
        &mut self,
        session: &str,
        agent: &str,
        turn: &str,
        trace: &str,
        block: &Value,
    ) -> Option<Link> {
        let call = text(block, "id")?;
        let id = digest(&json!(["qoder-delegation", session, agent, turn, call]))[..32].to_owned();
        if self.entries.contains_key(&id) {
            return None;
        }
        if self.entries.len() >= CAPACITY {
            let reclaimed = self
                .entries
                .values()
                .find(|link| link.result_emitted && link.child_complete)?
                .id
                .clone();
            let prior = self.entries.shift_remove(&reclaimed);
            self.undo.entry(reclaimed).or_insert(prior);
        }
        let link = Link {
            id: id.clone(),
            session: session.into(),
            agent: agent.into(),
            turn: turn.into(),
            call: call.into(),
            tool: text(block, "name")?.into(),
            trace: trace.into(),
            span: digest(&json!(["qoder-tool", session, turn, call]))[..16].into(),
            peer: None,
            peer_name: text(&block["input"], "subagent_type").map(str::to_owned),
            result_emitted: false,
            child_complete: false,
            at: self.now,
        };
        self.undo.entry(id.clone()).or_insert(None);
        self.entries.insert(id, link.clone());
        Some(link)
    }

    pub fn update(&mut self, id: &str, apply: impl FnOnce(&mut Link)) {
        if let Some(link) = self.entries.get_mut(id) {
            self.undo
                .entry(id.to_owned())
                .or_insert_with(|| Some(link.clone()));
            apply(link);
        }
    }
}
