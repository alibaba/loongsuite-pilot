#[cfg(test)]
use super::content::NativeContent;
use super::native::NativeGraph;
use super::util::*;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, LazyLock};
const MAX_ROUNDS: usize = 64;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_TOTAL_BYTES: usize = 512 * 1024;
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ObservedMessage {
    pub role: String,
    pub parts: Vec<RawEvent>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRoundTool {
    pub call_id: String,
    pub name: String,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<RawEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAssistantRound {
    pub id: String,
    pub source_index: usize,
    pub ordinal: usize,
    pub input_messages: Vec<ObservedMessage>,
    pub output_messages: Vec<ObservedMessage>,
    pub call_ids: Vec<String>,
    pub tools: Vec<NativeRoundTool>,
    pub input_truncated: bool,
    pub scope: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRoundReconstruction {
    pub rounds: Vec<NativeAssistantRound>,
    pub omitted_rounds: usize,
    pub duplicate_assistant_rows: usize,
}
fn message_json(message: &ObservedMessage) -> String {
    js_encode(&serde_json::to_value(message).unwrap())
}
pub fn native_demand_key(value: &str) -> String {
    static LINK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))\)").unwrap()
    });
    static URI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^skill://([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\?[^\s<>]*)?$").unwrap()
    });
    static LOCAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[a-zA-Z]:/|/)[^\r\n<>]*/\.doubaowork/agent_mode/workspace/\.skills/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})/SKILL\.md$").unwrap()
    });
    let mut parts = Vec::new();
    let mut cursor = 0;
    for capture in LINK.captures_iter(value) {
        let target = capture.get(2).or_else(|| capture.get(3)).unwrap().as_str();
        let normalized = target.replace('\\', "/");
        let skill = URI
            .captures(target)
            .or_else(|| LOCAL.captures(&normalized))
            .and_then(|c| c.get(1).map(|v| v.as_str().to_owned()));
        let Some(skill) = skill else {
            continue;
        };
        let whole = capture.get(0).unwrap();
        parts.push(json!(&value[cursor..whole.start()]));
        parts.push(json!({"skill":skill,"label":&capture[1]}));
        cursor = whole.end();
    }
    parts.push(json!(&value[cursor..]));
    js_encode(&json!(parts))
}
pub fn native_demand_fingerprint(value: &str) -> String {
    digest(&native_demand_key(value))
}
fn visible_message(row: &Value) -> Option<ObservedMessage> {
    let role = text(row.get("role"))?;
    if !["user", "assistant", "tool"].contains(&role) {
        return None;
    }
    let mut parts = Vec::new();
    if role == "tool" {
        let id = identifier(row.get("tool_call_id"))?;
        let response = text(row.get("content"))?;
        parts.push(object(
            json!({"type":"tool_call_response","id":id,"response":response}),
        ));
    } else {
        if let Some(content) = text(row.get("content")).filter(|v| !v.is_empty()) {
            parts.push(object(json!({"type":"text","content":content})));
        }
        if role == "assistant" {
            if let Some(calls) = row.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let id = identifier(call.get("id"))?;
                    let function = call.get("function")?;
                    let name = text(function.get("name"))?;
                    let mut part = object(json!({"type":"tool_call","id":id,"name":name}));
                    if let Some(raw) = function.get("arguments") {
                        let arguments = if let Some(raw) = raw.as_str() {
                            parse_json(raw).ok()?
                        } else {
                            raw.clone()
                        };
                        if arguments.is_object() {
                            set(&mut part, "arguments", arguments);
                        }
                    }
                    parts.push(part);
                }
            }
        }
    }
    (!parts.is_empty()).then(|| ObservedMessage {
        role: role.into(),
        parts,
    })
}
fn has_calls(row: &Value) -> bool {
    row.get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
}
struct MessageWindow {
    rows: VecDeque<(ObservedMessage, usize)>,
    bytes: usize,
    truncated: bool,
}
impl MessageWindow {
    fn new() -> Self {
        Self {
            rows: VecDeque::new(),
            bytes: 2,
            truncated: false,
        }
    }
    fn push(&mut self, message: ObservedMessage, encoded: &str) {
        let bytes = encoded.len();
        self.bytes += bytes + usize::from(!self.rows.is_empty());
        self.rows.push_back((message, bytes));
        while self.bytes > MAX_INPUT_BYTES && self.rows.len() > 1 {
            let (_, bytes) = self.rows.pop_front().unwrap();
            self.bytes -= bytes + 1;
            self.truncated = true;
        }
    }
    fn messages(&self) -> Vec<ObservedMessage> {
        self.rows
            .iter()
            .map(|(message, _)| message.clone())
            .collect()
    }
}
pub struct NativeRoundSteps {
    graph: Arc<NativeGraph>,
    actor: String,
    query_ms: i64,
    rows: Vec<Arc<Value>>,
    offset: usize,
    first: usize,
    last: usize,
    index: usize,
    yielded: bool,
    scope: String,
    history: MessageWindow,
    previous_assistant: Option<String>,
    rounds: Vec<NativeAssistantRound>,
    total: usize,
    omitted_rounds: usize,
    duplicate_assistant_rows: usize,
    capacity_reached: bool,
    done: bool,
}
impl NativeRoundSteps {
    pub fn from_graph(
        graph: Arc<NativeGraph>,
        actor: &str,
        query_ms: i64,
        end_nano: &str,
        call_ids: &[String],
        scope: &str,
    ) -> Option<Self> {
        let content = graph.content.as_ref()?;
        let rows = content.transcripts.get(actor)?.clone();
        if end_nano.len() != 19 || !end_nano.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let end = nanos(end_nano)? / 1_000_000;
        let offset = content.transcript_offsets.get(actor).copied().unwrap_or(0);
        let assignments = content
            .assignments
            .get(actor)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let current: Vec<_> = assignments
            .iter()
            .filter(|item| item.time_ms >= query_ms && i128::from(item.time_ms) <= end)
            .collect();
        if current.len() != 1 {
            return None;
        }
        let body = &current[0].text;
        let demand_key = native_demand_key(body);
        let matches = |value: Option<&Value>| {
            value.and_then(Value::as_str).is_some_and(|value| {
                value.encode_utf16().count() <= MAX_INPUT_BYTES
                    && native_demand_key(value) == demand_key
            })
        };
        let delimiters: Vec<_> = if let Some(indexed) =
            content.find_user_rows(actor, &native_demand_fingerprint(body))
        {
            indexed
                .iter()
                .filter(|index| **index >= offset && **index < offset + rows.len())
                .map(|index| *index - offset)
                .collect()
        } else {
            rows.iter()
                .enumerate()
                .filter(|(_, row)| {
                    text(row.get("role")) == Some("user") && matches(row.get("content"))
                })
                .map(|(index, _)| index)
                .collect()
        };
        if delimiters.len() > 1
            || (delimiters.is_empty()
                && (offset > 0
                    || assignments.first().map(|a| a.text.as_str()) != Some(body.as_str())
                    || rows
                        .first()
                        .is_some_and(|row| text(row.get("role")) == Some("user"))))
        {
            return None;
        }
        let mut first = delimiters.first().map_or(0, |index| index + 1);
        let mut last = rows
            .iter()
            .enumerate()
            .find(|(index, row)| *index >= first && text(row.get("role")) == Some("user"))
            .map_or(rows.len(), |(index, _)| index);
        let known: Vec<_> = call_ids
            .iter()
            .map(|id| content.calls.get(id))
            .collect::<Option<Vec<_>>>()?;
        if known.iter().any(|call| {
            call.actor != actor
                || call.result_index.is_none()
                || call.record_index < first + offset
                || call.record_index >= last + offset
        }) {
            return None;
        }
        if scope == "local_execution_fragment" {
            if known.is_empty() {
                return None;
            }
            first = known.iter().map(|call| call.record_index).min()? - offset;
            last = known.iter().filter_map(|call| call.result_index).max()? - offset + 1;
            if rows
                .get(last)
                .is_some_and(|row| text(row.get("role")) == Some("assistant") && !has_calls(row))
            {
                last += 1;
            }
        }
        if first > rows.len() || last > rows.len() {
            return None;
        }
        let mut history = MessageWindow::new();
        history.truncated = offset > 0;
        let (mut prefix_bytes, mut prefix_complete) = (2, true);
        let mut prefix = Vec::new();
        let mut previous_encoded = None;
        let mut previous_assistant = None;
        let mut have_previous = false;
        for index in (0..first).rev() {
            let row = &rows[index];
            let Some(message) = visible_message(row) else {
                continue;
            };
            let encoded = message_json(&message);
            if !have_previous {
                previous_assistant = (message.role == "assistant").then(|| encoded.clone());
                have_previous = true;
            }
            let duplicate = message.role == "assistant"
                && previous_encoded.as_ref() == Some(&encoded)
                && !has_calls(row);
            previous_encoded = (message.role == "assistant").then(|| encoded.clone());
            if duplicate {
                continue;
            }
            let bytes = encoded.len() + usize::from(!prefix.is_empty());
            if !prefix.is_empty() && prefix_bytes + bytes > MAX_INPUT_BYTES {
                prefix_complete = false;
                history.truncated = true;
                break;
            }
            prefix.push((message, encoded));
            prefix_bytes += bytes;
        }
        if offset == 0 && prefix_complete {
            if let Some(initial) = assignments.first() {
                if !(rows.first().is_some_and(|row| {
                    text(row.get("role")) == Some("user")
                        && text(row.get("content")).is_some_and(|value| {
                            native_demand_key(value) == native_demand_key(&initial.text)
                        })
                })) {
                    let message = ObservedMessage {
                        role: "user".into(),
                        parts: vec![object(json!({"type":"text","content":initial.text}))],
                    };
                    let encoded = message_json(&message);
                    history.push(message, &encoded);
                }
            }
        }
        for (message, encoded) in prefix.into_iter().rev() {
            history.push(message, &encoded);
        }
        Some(Self {
            graph,
            actor: actor.into(),
            query_ms,
            rows,
            offset,
            first,
            last,
            index: first,
            yielded: false,
            scope: scope.into(),
            history,
            previous_assistant,
            rounds: Vec::new(),
            total: 0,
            omitted_rounds: 0,
            duplicate_assistant_rows: 0,
            capacity_reached: false,
            done: false,
        })
    }
    pub fn next_step(&mut self) -> Option<u64> {
        if self.done {
            return None;
        }
        while self.index < self.last {
            if self.index > self.first
                && (self.index - self.first).is_multiple_of(256)
                && !self.yielded
            {
                self.yielded = true;
                return Some(256);
            }
            self.yielded = false;
            let index = self.index;
            self.index += 1;
            let row = self.rows[index].clone();
            let Some(message) = visible_message(&row) else {
                continue;
            };
            let encoded = message_json(&message);
            if message.role == "assistant"
                && self.previous_assistant.as_ref() == Some(&encoded)
                && !has_calls(&row)
            {
                self.duplicate_assistant_rows += 1;
                continue;
            }
            if message.role == "assistant" {
                if self.capacity_reached || self.rounds.len() >= MAX_ROUNDS {
                    self.omitted_rounds += 1;
                    self.previous_assistant = Some(encoded);
                    continue;
                }
                let content = self.graph.content.as_ref().unwrap();
                let raw_calls = row
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let mut tools = Vec::new();
                let mut ids = Vec::new();
                for raw in raw_calls {
                    let id = raw.get("id").and_then(Value::as_str)?;
                    let call = content.calls.get(id)?;
                    let arguments = if let Some(args) = &call.arguments {
                        parse_json(args).ok()?.as_object().cloned()
                    } else {
                        None
                    };
                    ids.push(id.to_owned());
                    tools.push(NativeRoundTool {
                        call_id: id.into(),
                        name: call.name.clone(),
                        completed: call.result_index.is_some(),
                        arguments,
                        result: call.result.clone(),
                    });
                }
                let round = NativeAssistantRound {
                    id: digest(&encode(&json!([
                        self.actor,
                        self.query_ms,
                        index + self.offset,
                        encoded
                    ]))),
                    source_index: index + self.offset,
                    ordinal: self.rounds.len() + 1,
                    input_messages: self.history.messages(),
                    output_messages: vec![message.clone()],
                    call_ids: ids,
                    tools,
                    input_truncated: self.history.truncated,
                    scope: self.scope.clone(),
                };
                let bytes = js_encode(&serde_json::to_value(&round).unwrap()).len();
                if self.history.bytes > MAX_INPUT_BYTES || self.total + bytes > MAX_TOTAL_BYTES {
                    self.omitted_rounds += 1;
                    self.capacity_reached = true;
                } else {
                    self.rounds.push(round);
                    self.total += bytes;
                }
            }
            self.history.push(message.clone(), &encoded);
            self.previous_assistant = (message.role == "assistant").then_some(encoded);
        }
        self.done = true;
        None
    }
    pub fn finish(self) -> Option<NativeRoundReconstruction> {
        self.done.then_some(NativeRoundReconstruction {
            rounds: self.rounds,
            omitted_rounds: self.omitted_rounds,
            duplicate_assistant_rows: self.duplicate_assistant_rows,
        })
    }
}
#[cfg(test)]
pub fn reconstruct_native_rounds(
    content: Option<&NativeContent>,
    actor: &str,
    query_ms: i64,
    end_nano: &str,
    call_ids: &[String],
    scope: &str,
) -> Option<NativeRoundReconstruction> {
    let graph = Arc::new(NativeGraph {
        main: actor.into(),
        edges: Default::default(),
        content: Some(content?.clone()),
    });
    let mut steps =
        NativeRoundSteps::from_graph(graph, actor, query_ms, end_nano, call_ids, scope)?;
    while steps.next_step().is_some() {}
    steps.finish()
}

#[cfg(test)]
mod migration_contract_tests {
    use super::super::content::parse_native_content;
    use super::*;
    use indexmap::IndexMap;
    #[test]
    fn local_fragment_excludes_later_coordination_from_the_same_history() {
        let actor = "m_synthetic";
        let epoch = 1792897200000_i64;
        let rows = [
            json!({"role":"assistant","content":"visible plan","tool_calls":[{"id":"a","function":{"name":"Read","arguments":{"file_path":"a"}}}]}),
            json!({"role":"tool","tool_call_id":"a","content":"result a"}),
            json!({"role":"assistant","content":"visible final"}),
            json!({"role":"user","content":"LATER"}),
            json!({"role":"assistant","content":"later coordination","tool_calls":[{"id":"later","function":{"name":"Read","arguments":{"file_path":"later"}}}]}),
            json!({"role":"tool","tool_call_id":"later","content":"LATER result"}),
            json!({"role":"assistant","content":"LATER final"}),
        ];
        let files = IndexMap::from([(
            actor.to_owned(),
            rows.iter().map(js_encode).collect::<Vec<_>>().join("\n") + "\n",
        )]);
        let assignments=IndexMap::from([(actor.to_owned(),"## [2026-10-25T03:00:00.010Z] 需求\nCURRENT\n## [2026-10-25T03:01:00.000Z] 需求\nLATER\n".into())]);
        let content = parse_native_content(&files, &assignments).unwrap().unwrap();
        assert!(js_encode(&serde_json::to_value(&content).unwrap()).contains("LATER"));
        let end = ms_nanos(epoch + 30_000);
        let rebuilt = reconstruct_native_rounds(
            Some(&content),
            actor,
            epoch,
            &end,
            &["a".into()],
            "local_execution_fragment",
        )
        .unwrap();
        assert_eq!(
            rebuilt
                .rounds
                .iter()
                .map(|r| r.call_ids.clone())
                .collect::<Vec<_>>(),
            vec![vec!["a".to_owned()], vec![]]
        );
        let serialized = js_encode(&serde_json::to_value(&rebuilt).unwrap());
        assert!(!serialized.contains("LATER"));
        assert!(!serialized.contains("later coordination"));
        assert!(reconstruct_native_rounds(
            Some(&content),
            actor,
            epoch,
            &end,
            &[],
            "local_execution_fragment"
        )
        .is_none());
    }
}
