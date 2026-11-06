use super::budget::{DoubaoWorkError, Result};
use super::types::DoubaoToolPair;
use super::util::*;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_CALLS: usize = 4096;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCallContent {
    pub actor: String,
    pub name: String,
    pub decision_id: String,
    pub record_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_index: Option<usize>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAssignment {
    pub time_ms: i64,
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NativeLastAnswer {
    pub index: usize,
    pub text: String,
}
type UserRows = IndexMap<String, IndexMap<String, Vec<usize>>>;
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeContent {
    pub calls: IndexMap<String, NativeCallContent>,
    pub assignments: IndexMap<String, Vec<NativeAssignment>>,
    pub last_answers: IndexMap<String, NativeLastAnswer>,
    #[serde(serialize_with = "serialize_transcripts")]
    pub transcripts: IndexMap<String, Vec<Arc<Value>>>,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub transcript_offsets: IndexMap<String, usize>,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub source_versions: IndexMap<String, String>,
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub source_bytes: IndexMap<String, usize>,
    #[serde(skip)]
    pub user_rows: Option<Arc<UserRows>>,
}
fn serialize_transcripts<S: Serializer>(
    rows: &IndexMap<String, Vec<Arc<Value>>>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let rows: IndexMap<_, _> = rows
        .iter()
        .map(|(actor, rows)| (actor, rows.iter().map(Arc::as_ref).collect::<Vec<_>>()))
        .collect();
    rows.serialize(serializer)
}
impl NativeContent {
    pub fn find_user_rows(&self, actor: &str, fingerprint: &str) -> Option<&[usize]> {
        self.user_rows.as_ref().map(|all| {
            all.get(actor)
                .and_then(|rows| rows.get(fingerprint))
                .map(Vec::as_slice)
                .unwrap_or(&[])
        })
    }
}
fn truthy_length(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(values)) => !values.is_empty(),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Object(value)) => value.get("length").is_some_and(|value| match value {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value
                .as_f64()
                .is_some_and(|value| value != 0.0 && !value.is_nan()),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }),
        _ => false,
    }
}
fn bounded_text(value: Option<&Value>) -> Option<String> {
    let value = value.and_then(Value::as_str)?;
    (!value.is_empty() && value.len() <= MAX_CONTENT_BYTES).then(|| value.to_owned())
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000a}'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}
pub fn parse_native_content(
    files: &IndexMap<String, String>,
    assignments: &IndexMap<String, String>,
) -> Result<Option<NativeContent>> {
    let mut result = NativeContent::default();
    let mut count = 0;
    for (actor, body) in files {
        let rows: Vec<_> = body
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(parse_json)
            .collect::<serde_json::Result<Vec<_>>>()?;
        for (index, row) in rows.iter().enumerate() {
            if row.is_null() {
                return Err(DoubaoWorkError::invalid("Native trajectory row is null"));
            }
            if text(row.get("role")) == Some("assistant") {
                count += row
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
            }
            if count > MAX_CALLS
                || !append_native_content_row(&mut result, actor, row, index, false)
            {
                return Ok(None);
            }
        }
        if let Some(last) = rows.last() {
            let no_calls = !truthy_length(last.get("tool_calls"));
            if text(last.get("role")) == Some("assistant") && no_calls {
                if let Some(answer) = bounded_text(last.get("content")) {
                    result.last_answers.insert(
                        actor.clone(),
                        NativeLastAnswer {
                            index: rows.len() - 1,
                            text: answer,
                        },
                    );
                }
            }
        }
        result
            .transcripts
            .insert(actor.clone(), rows.into_iter().map(Arc::new).collect());
        if let Some(source) = assignments.get(actor) {
            static HEADER: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"(?m)^## \[([^\]\r\n]+)\] 需求\r?\n").unwrap());
            let matches: Vec<_> = HEADER.captures_iter(source).collect();
            let mut values = Vec::new();
            for (index, capture) in matches.iter().enumerate() {
                let header = capture.get(0).unwrap();
                let end = matches
                    .get(index + 1)
                    .and_then(|cap| cap.get(0))
                    .map_or(source.len(), |m| m.start());
                let body = js_trim(&source[header.end()..end]);
                if let Some(time_ms) = parse_time_ms(&capture[1]) {
                    if !body.is_empty() && body.len() <= MAX_CONTENT_BYTES {
                        values.push(NativeAssignment {
                            time_ms,
                            text: body.to_owned(),
                        });
                    }
                }
            }
            result.assignments.insert(actor.clone(), values);
        }
    }
    Ok(Some(result))
}
pub fn append_native_content_row(
    result: &mut NativeContent,
    actor: &str,
    row: &Value,
    index: usize,
    pruned_history: bool,
) -> bool {
    result.last_answers.shift_remove(actor);
    if text(row.get("role")) == Some("assistant")
        && row.get("tool_calls").is_some_and(Value::is_array)
    {
        let calls = row["tool_calls"].as_array().unwrap();
        let Some(ids) = calls
            .iter()
            .map(|call| {
                call.get("id")
                    .and_then(Value::as_str)
                    .filter(|id| native_id(id))
                    .map(str::to_owned)
            })
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        let decision_id = digest(&encode(&json!([actor, ids])));
        for call in calls {
            let id = call["id"].as_str().unwrap();
            let Some(name) = identifier(call.get("function").and_then(|f| f.get("name"))) else {
                return false;
            };
            if result.calls.contains_key(id) {
                return false;
            }
            let arguments = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|raw| {
                    let parsed = if let Some(raw) = raw.as_str() {
                        parse_json(raw).ok()?
                    } else {
                        raw.clone()
                    };
                    parsed
                        .is_object()
                        .then(|| js_encode(&parsed))
                        .filter(|text| !text.is_empty() && text.len() <= MAX_CONTENT_BYTES)
                });
            result.calls.insert(
                id.to_owned(),
                NativeCallContent {
                    actor: actor.into(),
                    name,
                    decision_id: decision_id.clone(),
                    record_index: index,
                    arguments,
                    result: None,
                    result_index: None,
                },
            );
        }
    } else if text(row.get("role")) == Some("tool") {
        if let Some(id) = row.get("tool_call_id").and_then(Value::as_str) {
            let Some(call) = result.calls.get_mut(id) else {
                return pruned_history;
            };
            if call.actor != actor || call.result_index.is_some() {
                return false;
            }
            call.result_index = Some(index);
            call.result = bounded_text(row.get("content"));
        }
    }
    let no_calls = !truthy_length(row.get("tool_calls"));
    if text(row.get("role")) == Some("assistant") && no_calls {
        if let Some(answer) = bounded_text(row.get("content")) {
            result.last_answers.insert(
                actor.into(),
                NativeLastAnswer {
                    index,
                    text: answer,
                },
            );
        }
    }
    true
}
pub fn native_task_content(
    content: Option<&NativeContent>,
    actor: &str,
    query_ms: i64,
    end_nano: &str,
    call_ids: &[String],
) -> Value {
    let Some(content) = content else {
        return json!({});
    };
    let Some(end) = nanos(end_nano).map(|n| n / 1_000_000) else {
        return json!({});
    };
    let empty = Vec::new();
    let assignments = content.assignments.get(actor).unwrap_or(&empty);
    if assignments
        .iter()
        .any(|item| i128::from(item.time_ms) > end)
    {
        return json!({});
    }
    let mut bodies = Vec::new();
    for assignment in assignments
        .iter()
        .filter(|item| item.time_ms >= query_ms && i128::from(item.time_ms) <= end)
    {
        if !bodies.contains(&assignment.text) {
            bodies.push(assignment.text.clone());
        }
    }
    if bodies.len() != 1 {
        return json!({});
    }
    let answer = content.last_answers.get(actor);
    let results: Vec<_> = call_ids
        .iter()
        .filter_map(|id| content.calls.get(id))
        .filter(|call| call.actor == actor && call.result_index.is_some())
        .collect();
    let fresh_tail = if results.is_empty() {
        assignments.len() == 1
    } else {
        answer.is_some_and(|answer| {
            results
                .iter()
                .all(|call| call.result_index.unwrap() < answer.index)
        })
    };
    let mut out = object(json!({"input":bodies[0]}));
    if let Some(answer) = answer.filter(|_| fresh_tail) {
        set(&mut out, "output", answer.text.clone());
    }
    Value::Object(out)
}
pub fn enrich_native_tool_events(
    entries: Vec<RawEvent>,
    content: Option<&NativeContent>,
) -> Vec<RawEvent> {
    let Some(content) = content else {
        return entries;
    };
    entries
        .into_iter()
        .map(|mut event| {
            let call = event
                .get("gen_ai.tool.call.id")
                .and_then(Value::as_str)
                .and_then(|id| content.calls.get(id));
            let Some(call) =
                call.filter(|call| text(event.get("gen_ai.agent.id")) == Some(call.actor.as_str()))
            else {
                return event;
            };
            if let Some(original) = event.get("gen_ai.tool.name").cloned() {
                set(
                    &mut event,
                    "loongsuite.doubao_work.local_executor_tool_name",
                    original,
                );
            }
            set(&mut event, "gen_ai.tool.name", call.name.clone());
            set(
                &mut event,
                "loongsuite.doubao_work.native_decision_id",
                call.decision_id.clone(),
            );
            if text(event.get("event.name")) == Some("tool.call") {
                if let Some(arguments) = call.arguments.as_ref().and_then(|s| parse_json(s).ok()) {
                    set(&mut event, "gen_ai.tool.call.arguments", arguments);
                }
            } else if text(event.get("event.name")) == Some("tool.result") {
                if let Some(result) = &call.result {
                    set(&mut event, "gen_ai.tool.call.result", result.clone());
                }
            }
            event
        })
        .collect()
}
pub fn native_tool_observations(
    pairs: &[DoubaoToolPair],
    content: Option<&NativeContent>,
) -> Vec<Value> {
    pairs.iter().filter_map(|pair|{
        let(call,end)=(pair.start.tool.as_ref()?,pair.end.tool.as_ref()?);
        let actor=pair.start.turn_id.as_ref()?;
        if call.id!=end.id||call.sandbox_id!=end.sandbox_id||call.name!=end.name||call.phase!="received"
            ||end.phase!="settled"||end.status.is_none()||nanos(&pair.end.time_nano)?<=nanos(&pair.start.time_nano)?{return None;}
        let matched=content.and_then(|content|content.calls.get(&call.id)).filter(|native|native.actor==*actor);
        let mut observation=object(json!({"callId":call.id,"name":matched.map(|c|c.name.as_str()).unwrap_or(&call.name),"executorName":call.name,
            "actor":actor,"startNano":pair.start.time_nano,"endNano":pair.end.time_nano,"status":end.status.as_ref().unwrap()}));
        if let Some(call)=matched{
            set(&mut observation,"decisionId",call.decision_id.clone());
            if let Some(args)=call.arguments.as_ref().and_then(|s|parse_json(s).ok()){set(&mut observation,"arguments",args);}
            if let Some(result)=&call.result{set(&mut observation,"result",result.clone());}
        }
        Some(Value::Object(observation))
    }).collect()
}
