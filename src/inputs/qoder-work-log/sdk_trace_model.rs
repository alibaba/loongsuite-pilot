//! SDK session/window state; content is reconstructed only for this trace input.
use super::qoder_work_log_input::SdkEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(super) const SESSION_TTL_MS: i64 = 30 * 60 * 1000;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Policy {
    pub chat: String,
    pub compact: String,
    pub scene: String,
}
impl Policy {
    pub fn model(&self, tier: &str) -> String {
        let choices = if tier == "Standard" {
            [&self.scene, &self.compact, &self.chat]
        } else {
            [&self.chat, &self.scene, &self.compact]
        };
        choices
            .into_iter()
            .find(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "unknown".into())
    }
}
#[derive(Clone, Default)]
pub(super) struct Tool {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub start: i64,
    pub end: i64,
}
#[derive(Clone, Default)]
pub(super) struct Turn {
    pub message_id: String,
    pub model: String,
    pub start: i64,
    pub end: i64,
    pub thinking: String,
    pub text: String,
    pub tools: Vec<Tool>,
    pub indices: HashMap<i64, usize>,
    pub stop_reason: String,
    pub input: i64,
    pub output: i64,
}
#[derive(Clone, Default)]
pub(super) struct Session {
    pub tier: String,
    pub cwd: String,
    pub agents: Vec<String>,
    pub tools: Vec<String>,
    pub start: i64,
    pub seen: i64,
    pub turns: Vec<Turn>,
}
pub(super) struct Window {
    pub session_id: String,
    pub session: Session,
    pub result_id: String,
    pub result_time: Option<i64>,
    pub tool_results: HashMap<String, String>,
    pub transcript_path: Option<String>,
}
#[derive(Default)]
pub(super) struct TraceState {
    sessions: HashMap<String, Session>,
    active: HashMap<String, Turn>,
    tool_results: HashMap<String, HashMap<String, String>>,
    transcripts: HashMap<String, String>,
}
impl TraceState {
    fn ensure(&mut self, id: &str, ts: i64) -> &mut Session {
        let session = self
            .sessions
            .entry(id.to_owned())
            .or_insert_with(|| Session {
                start: ts,
                ..Default::default()
            });
        session.seen = ts;
        session
    }
    fn finalize(&mut self, id: &str) {
        let Some(turn) = self.active.remove(id) else {
            return;
        };
        if turn.thinking.is_empty()
            && turn.text.is_empty()
            && turn.tools.is_empty()
            && turn.input == 0
            && turn.output == 0
        {
            return;
        }
        if let Some(session) = self.sessions.get_mut(id) {
            session.turns.push(turn);
        }
    }
    fn complete(
        &mut self,
        id: String,
        result_id: String,
        result_time: Option<i64>,
    ) -> Option<Window> {
        self.finalize(&id);
        let session = self.sessions.remove(&id)?;
        Some(Window {
            tool_results: self.tool_results.remove(&id).unwrap_or_default(),
            transcript_path: self.transcripts.remove(&id),
            session_id: id,
            session,
            result_id,
            result_time,
        })
    }
    pub fn process(&mut self, events: Vec<SdkEvent>, policy: &mut Policy) -> Vec<Window> {
        let mut windows = Vec::new();
        for event in events {
            match event {
                SdkEvent::SystemInit {
                    ts,
                    session_id,
                    subscription_tier,
                    cwd,
                    agents,
                    tools,
                } => {
                    let session = self.ensure(&session_id, ts);
                    session.tier = subscription_tier.clone();
                    session.cwd = cwd;
                    session.agents = agents;
                    session.tools = tools;
                    if policy.chat.is_empty()
                        && policy.scene.is_empty()
                        && policy.compact.is_empty()
                    {
                        let candidate = subscription_tier.to_lowercase();
                        if !candidate.is_empty()
                            && candidate != "premium"
                            && candidate != "standard"
                        {
                            policy.chat = candidate;
                        }
                    }
                }
                SdkEvent::SetModelPolicy {
                    chat_model,
                    compact_model,
                    scene_model,
                    ..
                } => {
                    if !chat_model.is_empty() {
                        policy.chat = chat_model;
                    }
                    if !compact_model.is_empty() {
                        policy.compact = compact_model;
                    }
                    if !scene_model.is_empty() {
                        policy.scene = scene_model;
                    }
                }
                SdkEvent::MessageStart {
                    ts,
                    session_id,
                    message_id,
                } => {
                    self.ensure(&session_id, ts);
                    self.finalize(&session_id);
                    let model = policy.model(
                        self.sessions
                            .get(&session_id)
                            .map(|s| s.tier.as_str())
                            .unwrap_or(""),
                    );
                    self.active.insert(
                        session_id,
                        Turn {
                            message_id,
                            model,
                            start: ts,
                            end: ts,
                            ..Default::default()
                        },
                    );
                }
                SdkEvent::BlockStart {
                    ts,
                    session_id,
                    block_type,
                    index,
                    tool_name,
                    tool_id,
                } => {
                    if let Some(turn) = self.active.get_mut(&session_id) {
                        if block_type == "tool_use" {
                            if let (Some(id), Some(name)) = (
                                tool_id.filter(|v| !v.is_empty()),
                                tool_name.filter(|v| !v.is_empty()),
                            ) {
                                turn.indices.insert(index, turn.tools.len());
                                turn.tools.push(Tool {
                                    id,
                                    name,
                                    start: ts,
                                    end: ts,
                                    ..Default::default()
                                });
                            }
                        }
                        turn.end = ts;
                    }
                }
                SdkEvent::Delta {
                    ts,
                    session_id,
                    delta_type,
                    content,
                    block_index,
                } => {
                    if let Some(turn) = self.active.get_mut(&session_id) {
                        turn.end = ts;
                        match delta_type.as_str() {
                            "thinking_delta" => turn.thinking.push_str(&content),
                            "text_delta" => turn.text.push_str(&content),
                            "input_json_delta" => {
                                if let Some(tool) = block_index
                                    .and_then(|i| turn.indices.get(&i).copied())
                                    .and_then(|i| turn.tools.get_mut(i))
                                {
                                    tool.arguments.push_str(&content);
                                    tool.end = ts;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                SdkEvent::MessageDelta {
                    ts,
                    session_id,
                    stop_reason,
                    input_tokens,
                    output_tokens,
                } => {
                    if let Some(turn) = self.active.get_mut(&session_id) {
                        turn.end = ts;
                        turn.stop_reason = stop_reason;
                        turn.input = input_tokens;
                        turn.output = output_tokens;
                        for tool in &mut turn.tools {
                            tool.end = ts;
                        }
                    }
                }
                SdkEvent::MessageStop { ts, session_id } => {
                    if let Some(turn) = self.active.get_mut(&session_id) {
                        turn.end = ts;
                        for tool in &mut turn.tools {
                            tool.end = ts;
                        }
                    }
                }
                SdkEvent::Result {
                    ts,
                    session_id,
                    result_id,
                    ..
                } => {
                    if let Some(window) = self.complete(session_id, result_id, Some(ts)) {
                        windows.push(window);
                    }
                }
                SdkEvent::PostToolUse {
                    ts,
                    session_id,
                    tool_use_id,
                    tool_response,
                    transcript_path,
                    ..
                } => {
                    if session_id.is_empty() || tool_use_id.is_empty() {
                        continue;
                    }
                    self.ensure(&session_id, ts);
                    self.tool_results
                        .entry(session_id.clone())
                        .or_default()
                        .insert(tool_use_id, tool_response);
                    if !transcript_path.is_empty() {
                        self.transcripts
                            .entry(session_id)
                            .or_insert(transcript_path);
                    }
                }
            }
        }
        windows
    }
    pub fn evict(&mut self, now: i64) -> Vec<Window> {
        let stale = self
            .sessions
            .iter()
            .filter(|(_, s)| now.saturating_sub(s.seen) > SESSION_TTL_MS)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        stale
            .into_iter()
            .filter_map(|id| self.complete(id, String::new(), None))
            .collect()
    }
}
