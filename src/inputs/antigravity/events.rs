use super::sqlite::{Metadata, Snapshot, Usage};
use super::transcript::Step;
use crate::normalization::entry_from_map;
use crate::types::{AgentActivityEntry, ClientType};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Progress {
    pub emitted_usage_keys: BTreeSet<String>,
    pub processed_transcript_steps: BTreeSet<i64>,
    pub emitted_turn_starts: BTreeSet<String>,
    pub ended_turns: BTreeSet<String>,
    pub turn_id_by_start_step: BTreeMap<i64, String>,
    pub tool_call_id_map: BTreeMap<String, String>,
    emitted_tool_calls: BTreeSet<String>,
    tool_result_step_index_map: BTreeMap<String, i64>,
    join_deadlines: BTreeMap<String, i64>,
    usage_identities_by_source: BTreeMap<String, Vec<String>>,
    pending_planners: Vec<PendingPlanner>,
    pending_seed: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPlanner {
    turn_id: String,
    response_id: String,
    step_indices: Vec<i64>,
    provider: String,
    is_retry: bool,
}

impl Progress {
    pub(super) fn seed_pending(&mut self) {
        self.pending_seed = true;
    }
    pub(super) fn baseline(&self) -> bool {
        self.pending_seed
    }
}

pub(super) struct Session<'a> {
    pub client: ClientType,
    pub id: &'a str,
    pub db: &'a Snapshot,
    pub steps: BTreeMap<i64, &'a Step>,
    pub now: i64,
    pub media: (bool, bool),
}

type Entry = Map<String, Value>;

fn hash(parts: &[&str], length: usize) -> String {
    let mut digest = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            digest.update([0]);
        }
        digest.update(part.as_bytes());
    }
    let mut id = hex::encode(digest.finalize())[..length].to_owned();
    if id.bytes().all(|byte| byte == b'0') {
        id.replace_range(length - 1.., "1");
    }
    id
}

struct Round<'a> {
    client: ClientType,
    session: &'a str,
    step: &'a str,
    turn: &'a str,
    workspace: Option<&'a str>,
}

impl Round<'_> {
    fn hash(&self, suffix: &[&str], len: usize) -> String {
        let mut parts = vec![self.client.as_str(), self.session, self.turn];
        parts.extend_from_slice(suffix);
        hash(&parts, len)
    }

    fn base(
        &self,
        name: &str,
        span: String,
        parent: Option<String>,
        time: i64,
        scope: &[&str],
    ) -> Entry {
        let mut id = vec![self.step, name];
        id.extend_from_slice(scope);
        let mut entry = json!({
            "event.id":self.hash(&id, 32), "event.name":name,
            "time_unix_nano":(i128::from(time) * 1_000_000).to_string(),
            "trace_id":self.hash(&["trace"],32), "span_id":span,
            "gen_ai.session.id":self.session, "gen_ai.turn.id": self.turn, "gen_ai.step.id":self.step,
            "gen_ai.agent.type":self.client.as_str(), "gen_ai.agent.id":self.session,
            "gen_ai.provider.name":"gcp.gemini",
        }).as_object().unwrap().clone();
        if let Some(parent) = parent {
            set(&mut entry, "parent_span_id", parent);
        }
        if let Some(workspace) = self.workspace {
            set(&mut entry, "workspace.path", workspace);
        }
        entry
    }

    fn step_span(&self) -> String {
        self.hash(&[self.step, "step"], 16)
    }
}

fn set(entry: &mut Entry, key: &str, value: impl Into<Value>) {
    entry.insert(key.into(), value.into());
}

fn message(role: &str, text: &str) -> Value {
    json!({"role":role,"parts":[{"type":"text","content":text}]})
}

fn finish(step: Option<&Step>) -> &'static str {
    if step
        .and_then(|step| step.status.as_deref())
        .is_some_and(|status| {
            status.eq_ignore_ascii_case("CANCELLED") || status.eq_ignore_ascii_case("CANCELED")
        })
    {
        "cancelled"
    } else if step.is_some_and(|step| !step.tool_calls.is_empty()) {
        "tool_call"
    } else {
        "stop"
    }
}

fn provider(model: &str) -> &'static str {
    let model = model.to_ascii_lowercase();
    if model.contains("claude") || model.contains("anthropic") {
        "anthropic"
    } else if model.contains("openai") || model.contains("gpt") {
        "openai"
    } else {
        "gcp.gemini"
    }
}

fn canonical_model(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw.len() > 120 || raw.chars().any(char::is_control) {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let (base, suffix) = lower
        .split_once('(')
        .map_or((lower.as_str(), ""), |(base, suffix)| {
            (base.trim_end(), suffix.trim_end_matches(')'))
        });
    let base = base.split_ascii_whitespace().collect::<Vec<_>>().join("-");
    if ["gemini-", "claude-", "gpt-"]
        .into_iter()
        .any(|prefix| base.starts_with(prefix))
    {
        let base = if base.starts_with("gemini-3.") && base.ends_with("-flash-thinking") {
            base.trim_end_matches("-thinking").to_owned()
        } else {
            base
        };
        if matches!(
            suffix,
            "high" | "medium" | "low" | "extra-low" | "extra low" | "minimal"
        ) {
            return Some(format!("{base}-{}", suffix.replace(' ', "-")));
        }
        return Some(base);
    }
    Some(raw.to_owned())
}

fn model_name(id: u64) -> String {
    match id {
        246 => "gemini-2.5-pro",
        312 => "gemini-2.5-flash",
        313 | 329 => "gemini-2.5-flash-thinking",
        330 => "gemini-2.5-flash-lite",
        281 | 282 => "claude-4-sonnet",
        290 | 291 => "claude-4-opus",
        333 | 334 => "claude-4.5-sonnet",
        340 | 341 => "claude-4.5-haiku",
        342 => "model_openai_gpt_oss_120b_medium",
        1050 => "gemini-3.1-flash-lite",
        1071 => "gemini-3.6-flash-high",
        1072 => "gemini-3.6-flash-medium",
        1073 => "gemini-3.6-flash-low",
        1298 => "gemini-3.7-flash-high",
        1299 => "gemini-3.7-flash-medium",
        1300 => "gemini-3.7-flash-low",
        1318 => "gemini-3.8-flash-high",
        1319 => "gemini-3.8-flash-medium",
        1320 => "gemini-3.8-flash-low",
        1402 => "claude-opus-5-5",
        1417..=1419 => "gemini-4-argon",
        _ if id >= 1000 => return format!("model_placeholder_m{}", id - 1000),
        _ => return format!("antigravity-model-{id}"),
    }
    .into()
}

fn resolved(model: &str) -> bool {
    !model.starts_with("model_placeholder_m") && !model.starts_with("antigravity-model-")
}

struct Attempt<'a> {
    metadata: &'a Metadata,
    usage: &'a Usage,
    source: String,
    aliases: Vec<String>,
    keys: Vec<String>,
    index: i64,
    step: Option<i64>,
    generated: bool,
    retry: bool,
}

fn aliases(usage: &Usage) -> Vec<String> {
    ["response", "provider", "message"]
        .into_iter()
        .zip(&usage.ids)
        .filter_map(|(prefix, id)| Some(format!("{prefix}:{}", id.as_ref()?)))
        .collect()
}

fn attempts<'a>(view: &'a Session<'_>) -> Vec<Attempt<'a>> {
    let mut merged: Vec<Attempt<'_>> = Vec::new();
    let mut by_identity = BTreeMap::new();
    let mut by_step = BTreeMap::<i64, Vec<usize>>::new();
    for (generated, rows) in [(true, &view.db.generated), (false, &view.db.steps)] {
        for (index, metadata) in rows {
            let step = if generated {
                metadata
                    .steps
                    .iter()
                    .copied()
                    .find(|idx| view.steps.get(idx).is_some_and(|step| step.planner()))
                    .or_else(|| metadata.steps.last().copied())
            } else {
                Some(*index)
            };
            for (retry, usage) in &metadata.usages {
                if usage.input
                    + usage.output
                    + usage.cache_read
                    + usage.cache_creation
                    + usage.reasoning
                    == 0
                {
                    continue;
                }
                let prefix = if generated { "gen" } else { "step" };
                let source = if let Some(retry) = retry {
                    format!("{prefix}-retry:{}:{index}:{retry}", view.id)
                } else {
                    format!("{prefix}:{}:{index}", view.id)
                };
                let names = aliases(usage);
                let identified = names
                    .first()
                    .and_then(|name| by_identity.get(name).copied());
                let compatible = |candidate: &Attempt<'_>| {
                    for (a, b) in candidate.usage.ids.iter().zip(&usage.ids) {
                        if let (Some(a), Some(b)) = (a, b) {
                            return a == b;
                        }
                    }
                    true
                };
                let by_slot = step
                    .and_then(|step| by_step.get(&step))
                    .and_then(|candidates| {
                        let mut matches = candidates.iter().copied().filter(|idx| {
                            let other = &merged[*idx];
                            generated != other.generated
                                && retry.is_some() == other.retry
                                && compatible(other)
                                && usage.input == other.usage.input
                                && usage.output == other.usage.output
                                && usage.cache_read == other.usage.cache_read
                                && usage.cache_creation == other.usage.cache_creation
                        });
                        let found = matches.next()?;
                        matches.next().is_none().then_some(found)
                    });
                if let Some(found) = identified.or(by_slot) {
                    let other = &mut merged[found];
                    other.keys.push(source);
                    if other.aliases.is_empty() {
                        if let Some(id) = names.first() {
                            by_identity.insert(id.clone(), found);
                        }
                        other.aliases = names;
                    }
                    continue;
                }
                let found = merged.len();
                if let Some(id) = names.first() {
                    by_identity.insert(id.clone(), found);
                }
                if let Some(step) = step {
                    by_step.entry(step).or_default().push(found);
                }
                merged.push(Attempt {
                    metadata,
                    usage,
                    source: source.clone(),
                    aliases: names,
                    keys: vec![source],
                    index: *index,
                    step,
                    generated,
                    retry: retry.is_some(),
                });
            }
        }
    }
    merged.sort_by_key(|attempt| {
        (
            attempt.step.unwrap_or(i64::MAX),
            attempt.metadata.completed,
            attempt.retry,
            attempt.index,
        )
    });
    merged
}

impl Session<'_> {
    fn round<'a>(&'a self, turn: &'a str, step: &'a str) -> Round<'a> {
        Round {
            client: self.client,
            session: self.id,
            step,
            turn,
            workspace: self.db.roots.first().map(String::as_str),
        }
    }

    pub(super) fn collect(&self, progress: &mut Progress) -> Vec<AgentActivityEntry> {
        let mut turns = BTreeMap::new();
        let mut current = format!("{}:turn:1", self.id);
        let mut number = 0;
        for (index, step) in &self.steps {
            if step.kind == "USER_INPUT" {
                number += 1;
                current = progress
                    .turn_id_by_start_step
                    .entry(*index)
                    .or_insert_with(|| {
                        self.db
                            .steps
                            .get(index)
                            .and_then(|step| step.turn.clone())
                            .or_else(|| {
                                self.db
                                    .steps
                                    .range(*index..)
                                    .take(8)
                                    .find_map(|(_, row)| row.turn.clone())
                            })
                            .unwrap_or_else(|| format!("{}:turn:{number}", self.id))
                    })
                    .clone();
            }
            turns.insert(*index, current.clone());
        }
        let last_ended = progress.ended_turns.clone();
        let mut events = Vec::new();
        let mut tools_pending = BTreeSet::new();
        let mut tool_results = BTreeSet::new();
        let stamped = |step: &Step| {
            self.db
                .steps
                .get(&step.step_index)
                .and_then(|meta| meta.created)
                .or_else(|| step.timestamp())
                .or(self.db.timestamp)
                .unwrap_or(self.now)
        };
        let previously_processed = progress.processed_transcript_steps.clone();
        for (index, step) in &self.steps {
            let turn = &turns[index];
            let step_id = format!("{}:step:{index}", self.id);
            let round = self.round(turn, &step_id);
            if step.prompt() && !step.running() && !previously_processed.contains(index) {
                if let Some(content) = step
                    .content
                    .as_deref()
                    .or_else(|| (self.media.0 && !step.media.is_empty()).then_some(""))
                {
                    let ts = stamped(step);
                    let mut entry = round.base("other", round.hash(&["agent"], 16), None, ts, &[]);
                    let messages = json!([message(
                        if step.kind == "USER_INPUT" {
                            "user"
                        } else {
                            "system"
                        },
                        content
                    )]);
                    set(&mut entry, "gen_ai.input.messages", messages.clone());
                    set(&mut entry, "gen_ai.input.messages_delta", messages);
                    if self.media.0 {
                        super::media::set_candidates(
                            &mut entry,
                            false,
                            vec![super::media::paths(step)],
                        );
                    }
                    if progress.emitted_turn_starts.insert(turn.clone()) {
                        set(&mut entry, "gen_ai.turn.start", true);
                    }
                    events.push(entry);
                    progress.processed_transcript_steps.insert(*index);
                }
            }
            if !step.planner() || step.running() {
                continue;
            }
            let window: Vec<_> = self
                .steps
                .range((
                    std::ops::Bound::Excluded(*index),
                    std::ops::Bound::Unbounded,
                ))
                .take_while(|(_, row)| !row.prompt() && !row.planner())
                .filter(|(_, row)| row.tool_result())
                .collect();
            for (ordinal, tool) in step.tool_calls.iter().enumerate() {
                let key = format!("{index}:{ordinal}");
                let saved = progress.tool_call_id_map.get(&key).map(String::as_str);
                let matched = window
                    .iter()
                    .find(|(idx, _)| {
                        let id = self
                            .db
                            .steps
                            .get(idx)
                            .and_then(|row| row.tool_id.as_deref());
                        id.is_some_and(|id| Some(id) == saved || Some(id) == tool.id.as_deref())
                    })
                    .or_else(|| {
                        window.get(ordinal).filter(|(idx, _)| {
                            self.db
                                .steps
                                .get(idx)
                                .and_then(|row| row.tool_id.as_deref())
                                .is_none_or(|id| {
                                    tool.id.as_deref().is_none_or(|expected| expected == id)
                                })
                        })
                    });
                let native = matched.and_then(|(idx, _)| self.db.steps.get(idx));
                let id = progress
                    .tool_call_id_map
                    .entry(key.clone())
                    .or_insert_with(|| {
                        tool.id
                            .clone()
                            .or_else(|| native.and_then(|info| info.tool_id.clone()))
                            .unwrap_or_else(|| format!("{step_id}:tool:{ordinal}"))
                    })
                    .clone();
                let name = native
                    .and_then(|meta| meta.tool_name.as_deref())
                    .filter(|_| tool.name.is_empty())
                    .unwrap_or(&tool.name);
                let time = native
                    .and_then(|meta| meta.execution)
                    .or_else(|| self.db.steps.get(index).and_then(|row| row.completed))
                    .unwrap_or_else(|| stamped(step));
                let output = matched.filter(|(_, row)| !row.running());
                let span = round.hash(&[&step_id, &id, "tool"], 16);
                if !previously_processed.contains(index)
                    && progress.emitted_tool_calls.insert(key.clone())
                {
                    let mut event = round.base(
                        "tool.call",
                        span.clone(),
                        Some(round.step_span()),
                        time,
                        &[&id],
                    );
                    set(&mut event, "gen_ai.tool.call.id", id.clone());
                    set(&mut event, "gen_ai.tool.name", name);
                    if let Some(args) = &tool.args {
                        set(&mut event, "gen_ai.tool.call.arguments", args.clone());
                    }
                    set(&mut event, "gen_ai.turn.end", false);
                    events.push(event);
                }
                if let Some((result_index, result)) = output {
                    if !progress.tool_result_step_index_map.contains_key(&key)
                        && (!previously_processed.contains(index)
                            || progress.emitted_tool_calls.contains(&key))
                    {
                        let end = native
                            .and_then(|row| row.completed)
                            .or_else(|| result.timestamp())
                            .unwrap_or(time.saturating_add(1))
                            .max(time);
                        let mut event =
                            round.base("tool.result", span, Some(round.step_span()), end, &[&id]);
                        set(&mut event, "gen_ai.tool.call.id", id.clone());
                        set(&mut event, "gen_ai.tool.name", name);
                        if let Some(content) = &result.content {
                            set(&mut event, "gen_ai.tool.call.result", content.as_str());
                        }
                        if let Some(status) = result.status.as_deref().filter(|status| {
                            ["ERROR", "FAILED", "CANCELLED", "CANCELED"]
                                .iter()
                                .any(|value| status.eq_ignore_ascii_case(value))
                        }) {
                            set(&mut event, "error.type", status.to_ascii_lowercase());
                        }
                        set(&mut event, "gen_ai.turn.end", false);
                        events.push(event);
                        progress
                            .tool_result_step_index_map
                            .insert(key, **result_index);
                        tool_results.insert(turn.clone());
                    }
                } else {
                    tools_pending.insert(turn.clone());
                }
            }
        }

        let merged = attempts(self);
        let mut response_seen = BTreeSet::new();
        let mut prior_planner = BTreeMap::new();
        for attempt in &merged {
            let progress_matches = |source: &String| {
                if let Some(new) = attempt.aliases.first() {
                    if let Some(previous) = progress
                        .usage_identities_by_source
                        .get(source)
                        .and_then(|ids| ids.first())
                    {
                        return new == previous || attempt.aliases.contains(previous);
                    }
                }
                progress.emitted_usage_keys.contains(source)
            };
            if attempt
                .aliases
                .first()
                .is_some_and(|alias| progress.emitted_usage_keys.contains(alias))
                || attempt.keys.iter().any(progress_matches)
            {
                for source in &attempt.keys {
                    progress.emitted_usage_keys.insert(source.clone());
                    if !attempt.aliases.is_empty() {
                        progress
                            .usage_identities_by_source
                            .insert(source.clone(), attempt.aliases.clone());
                    }
                }
                continue;
            }
            let linked = attempt
                .step
                .and_then(|index| self.steps.get(&index).copied())
                .filter(|step| step.planner());
            if linked.is_some_and(Step::running) {
                continue;
            }
            let known_turn = attempt.step.and_then(|index| {
                turns
                    .get(&index)
                    .cloned()
                    .or_else(|| self.db.steps.get(&index).and_then(|meta| meta.turn.clone()))
            });
            let awaits_planner = linked.is_none()
                && !self.steps.is_empty()
                && known_turn.is_some()
                && !attempt.retry
                && !progress.baseline();
            if awaits_planner {
                let next = progress
                    .join_deadlines
                    .entry(attempt.source.clone())
                    .or_insert(self.now + 30_000);
                if self.now < *next {
                    continue;
                }
            }
            progress.join_deadlines.remove(&attempt.source);
            let identity = attempt
                .aliases
                .first()
                .map_or(attempt.source.as_str(), String::as_str);
            let mut turn = known_turn
                .unwrap_or_else(|| format!("{}:usage:{}", self.id, hash(&[identity], 16)));
            if last_ended.contains(&turn) {
                turn = format!("{turn}:usage:{}", hash(&[identity], 16));
            }
            let step_id = attempt.step.map_or_else(
                || format!("{}:gen:{}", self.id, attempt.index),
                |idx| format!("{}:step:{idx}", self.id),
            );
            let round = self.round(&turn, &step_id);
            let mut response = attempt
                .usage
                .ids
                .iter()
                .flatten()
                .next()
                .cloned()
                .unwrap_or_else(|| format!("{step_id}:r:{}", attempt.source));
            if !response_seen.insert(response.clone()) {
                response.push_str(&format!(":{}", hash(&[&attempt.source], 8)));
            }
            let native = attempt.step.and_then(|index| self.db.steps.get(&index));
            let ended = native
                .and_then(|meta| meta.completed)
                .or(attempt.metadata.completed)
                .or(self.db.timestamp)
                .unwrap_or(self.now);
            let duration = i64::try_from(
                attempt
                    .metadata
                    .ttft
                    .unwrap_or_default()
                    .saturating_add(attempt.metadata.stream.unwrap_or_default())
                    / 1_000_000,
            )
            .unwrap_or(0);
            let started = native
                .and_then(|meta| meta.created)
                .or_else(|| linked.and_then(Step::timestamp))
                .unwrap_or(ended - duration.max(1));
            let ended = ended.max(started + 1);
            let model = attempt
                .usage
                .model_id
                .map(model_name)
                .filter(|model| resolved(model))
                .or_else(|| canonical_model(attempt.metadata.model.as_deref()))
                .filter(|model| resolved(model))
                .or_else(|| linked.and_then(|step| canonical_model(step.model.as_deref())))
                .or_else(|| {
                    attempt
                        .metadata
                        .model_id
                        .or(attempt.usage.model_id)
                        .map(model_name)
                })
                .unwrap_or_else(|| "gemini-internal-model".into());
            let series = round.hash(&[&step_id, "llm", &response], 16);
            let mut request = round.base(
                "llm.request",
                series.clone(),
                Some(round.step_span()),
                started,
                &[&response],
            );
            let mut answer = round.base(
                "llm.response",
                series,
                Some(round.step_span()),
                ended,
                &[&response],
            );
            for event in [&mut request, &mut answer] {
                set(event, "gen_ai.response.id", response.clone());
                set(event, "gen_ai.request.model", model.as_str());
                set(event, "gen_ai.provider.name", provider(&model));
            }
            if let Some(index) = attempt.step {
                let previous = prior_planner.insert(turn.clone(), index).unwrap_or(-1);
                let inputs: Vec<_> =
                    self.steps
                        .range(..index)
                        .filter(|(idx, step)| {
                            **idx > previous && step.prompt() && turns.get(idx) == Some(&turn)
                        })
                        .filter_map(|(_, step)| {
                            let content = step.content.as_deref().or_else(|| {
                                (self.media.0 && !step.media.is_empty()).then_some("")
                            })?;
                            let role = if step.kind == "USER_INPUT" {
                                "user"
                            } else {
                                "system"
                            };
                            Some((message(role, content), *step))
                        })
                        .collect();
                let delta: Vec<_> = inputs.iter().map(|(value, _)| value.clone()).collect();
                if !delta.is_empty() {
                    if self.media.0 {
                        super::media::set_candidates(
                            &mut request,
                            false,
                            inputs
                                .iter()
                                .map(|(_, step)| super::media::paths(step))
                                .collect(),
                        );
                    }
                    let encoded = serde_json::to_vec(&delta).expect("serializable");
                    set(
                        &mut request,
                        "gen_ai.input.messages_hash",
                        hex::encode(Sha256::digest(encoded)),
                    );
                    set(
                        &mut request,
                        "gen_ai.input.messages_delta",
                        Value::Array(delta),
                    );
                }
            }
            let finish = finish(linked.filter(|_| !attempt.retry));
            let later_planner = attempt.step.is_some_and(|index| {
                self.steps
                    .range((std::ops::Bound::Excluded(index), std::ops::Bound::Unbounded))
                    .take_while(|(idx, _)| turns.get(idx) == Some(&turn))
                    .any(|(_, step)| step.planner())
            });
            let closed = !awaits_planner
                && (finish == "cancelled"
                    || (finish == "stop"
                        && !later_planner
                        && !tools_pending.contains(&turn)
                        && (!attempt.retry || linked.is_none())));
            if !awaits_planner && (!attempt.retry || linked.is_none()) {
                set(
                    &mut answer,
                    "gen_ai.response.finish_reasons",
                    json!([finish]),
                );
            }
            set(&mut answer, "gen_ai.turn.end", closed);
            if awaits_planner {
                if let Some(step) = attempt.step {
                    set(&mut answer, "agent.antigravity.planner_pending", true);
                    progress.pending_planners.push(PendingPlanner {
                        turn_id: turn.clone(),
                        response_id: response.clone(),
                        step_indices: vec![step],
                        provider: provider(&model).into(),
                        is_retry: attempt.retry,
                    });
                }
            }
            if closed {
                progress.ended_turns.insert(turn.clone());
            }
            if finish == "cancelled" {
                set(&mut answer, "error.type", "antigravity.model_cancelled");
            }
            set(&mut answer, "gen_ai.response.model", model.as_str());
            let input =
                attempt.usage.input + attempt.usage.cache_read + attempt.usage.cache_creation;
            set(&mut answer, "gen_ai.usage.input_tokens", input);
            set(
                &mut answer,
                "gen_ai.usage.output_tokens",
                attempt.usage.output,
            );
            set(
                &mut answer,
                "gen_ai.usage.total_tokens",
                input + attempt.usage.output,
            );
            for (key, count) in [
                (
                    "gen_ai.usage.reasoning_output_tokens",
                    attempt.usage.reasoning,
                ),
                (
                    "gen_ai.usage.cache_read.input_tokens",
                    attempt.usage.cache_read,
                ),
                (
                    "gen_ai.usage.cache_creation.input_tokens",
                    attempt.usage.cache_creation,
                ),
            ] {
                if count > 0 {
                    set(&mut answer, key, count);
                }
            }
            let ttft = attempt.metadata.ttft.or_else(|| {
                native
                    .and_then(|meta| meta.first_token)
                    .and_then(|first| u64::try_from(first - started).ok())
                    .map(|ms| ms * 1_000_000)
            });
            if let Some(ttft) = ttft.filter(|value| *value > 0) {
                set(&mut answer, "gen_ai.response.time_to_first_token", ttft);
            }
            if let Some(step) = linked.filter(|_| !attempt.retry) {
                add_output(&mut answer, step, progress, finish, self.media.1);
            }
            if let Some(alias) = attempt.aliases.first() {
                progress.emitted_usage_keys.insert(alias.clone());
            }
            for source in &attempt.keys {
                progress.emitted_usage_keys.insert(source.clone());
                if !attempt.aliases.is_empty() {
                    progress
                        .usage_identities_by_source
                        .insert(source.clone(), attempt.aliases.clone());
                }
            }
            events.extend([request, answer]);
        }
        for pending in std::mem::take(&mut progress.pending_planners) {
            let Some(step) = pending
                .step_indices
                .iter()
                .filter_map(|index| self.steps.get(index).copied())
                .find(|step| step.planner() && !step.running())
            else {
                progress.pending_planners.push(pending);
                continue;
            };
            let step_id = format!("{}:step:{}", self.id, step.step_index);
            let round = self.round(&pending.turn_id, &step_id);
            let time = self
                .db
                .steps
                .get(&step.step_index)
                .and_then(|row| row.completed)
                .unwrap_or_else(|| stamped(step));
            let mut entry = round.base(
                "other",
                round.hash(&[&step_id, "step"], 16),
                Some(round.step_span()),
                time,
                &[&pending.response_id, "planner"],
            );
            set(
                &mut entry,
                "event.id",
                round.hash(&[&pending.response_id, "planner"], 32),
            );
            set(&mut entry, "gen_ai.response.id", pending.response_id);
            set(&mut entry, "gen_ai.provider.name", pending.provider);
            set(&mut entry, "agent.antigravity.planner_joined", true);
            let reason = finish(Some(step));
            set(
                &mut entry,
                "gen_ai.response.finish_reasons",
                json!([reason]),
            );
            if !pending.is_retry {
                add_output(&mut entry, step, progress, reason, self.media.1);
            }
            if reason == "cancelled" {
                set(&mut entry, "error.type", "antigravity.model_cancelled");
            }
            let done = reason == "cancelled"
                || (reason == "stop" && !tools_pending.contains(&pending.turn_id));
            set(&mut entry, "gen_ai.turn.end", done);
            if done {
                progress.ended_turns.insert(pending.turn_id);
            }
            events.push(entry);
        }
        for turn in tool_results {
            if tools_pending.contains(&turn) || progress.ended_turns.contains(&turn) {
                continue;
            }
            if let Some(end) = events.iter_mut().rev().find(|event| {
                event.get("gen_ai.turn.id").and_then(Value::as_str) == Some(turn.as_str())
                    && event.get("event.name").and_then(Value::as_str) == Some("tool.result")
            }) {
                // A tool result alone closes only a turn whose final non-tool
                // planner already supplied a model response in an earlier cycle.
                if self
                    .steps
                    .iter()
                    .rev()
                    .find(|(idx, step)| turns.get(idx) == Some(&turn) && step.planner())
                    .is_some_and(|(idx, step)| {
                        step.tool_calls.is_empty()
                            && !step.running()
                            && progress
                                .emitted_usage_keys
                                .contains(&format!("step:{}:{idx}", self.id))
                    })
                {
                    set(end, "gen_ai.turn.end", true);
                    progress.ended_turns.insert(turn);
                }
            }
        }
        events.sort_by_key(|event| {
            event
                .get("time_unix_nano")
                .and_then(Value::as_str)
                .and_then(|time| time.parse::<i128>().ok())
                .unwrap_or_default()
        });
        progress.pending_seed = false;
        events.into_iter().map(entry_from_map).collect()
    }
}

fn add_output(entry: &mut Entry, step: &Step, progress: &Progress, finish: &str, media: bool) {
    let mut parts = Vec::new();
    if let Some(text) = &step.thinking {
        parts.push(json!({"type":"reasoning","content":text}));
    }
    if let Some(text) = &step.content {
        parts.push(json!({"type":"text","content":text}));
    }
    for (ordinal, tool) in step.tool_calls.iter().enumerate() {
        let key = format!("{}:{ordinal}", step.step_index);
        if let Some(id) = progress.tool_call_id_map.get(&key) {
            let mut part = json!({"type":"tool_call","id":id,"name":tool.name});
            if let Some(args) = &tool.args {
                part["arguments"] = args.clone();
            }
            parts.push(part);
        }
    }
    if media && !step.media.is_empty() {
        super::media::set_candidates(entry, true, vec![super::media::paths(step)]);
    }
    if !parts.is_empty() || (media && !step.media.is_empty()) {
        set(
            entry,
            "gen_ai.output.messages",
            json!([{"role":"assistant","parts":parts,"finish_reason":finish}]),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_planner_closes_durable_response_without_reemitting_usage() {
        let now = 1_796_000_000_000;
        let mut db = Snapshot::default();
        db.steps.insert(
            0,
            Metadata {
                turn: Some("native-turn".into()),
                ..Default::default()
            },
        );
        db.steps.insert(
            1,
            Metadata {
                turn: Some("native-turn".into()),
                completed: Some(now),
                usages: vec![(
                    None,
                    Usage {
                        input: 3,
                        output: 2,
                        ids: [Some("response-id".into()), None, None],
                        ..Default::default()
                    },
                )],
                ..Default::default()
            },
        );
        let prompt = Step {
            step_index: 0,
            kind: "USER_INPUT".into(),
            content: Some("prompt".into()),
            ..Default::default()
        };
        let planner = Step {
            step_index: 1,
            kind: "PLANNER_RESPONSE".into(),
            content: Some("answer".into()),
            ..Default::default()
        };
        let view = |after, steps| Session {
            client: ClientType::AntigravityCli,
            id: "test",
            db: &db,
            steps,
            now: now + after,
            media: (false, false),
        };
        let mut progress = Progress::default();
        let first = view(0, BTreeMap::from([(0, &prompt)])).collect(&mut progress);
        assert_eq!(first.len(), 1);
        let pending = view(30_001, BTreeMap::from([(0, &prompt)])).collect(&mut progress);
        assert_eq!(pending.len(), 2);
        assert_eq!(pending.last().unwrap().turn_end, Some(false));
        assert_eq!(
            pending
                .last()
                .unwrap()
                .get("agent.antigravity.planner_pending"),
            Some(&json!(true))
        );
        let raw = serde_json::to_vec(&progress).unwrap();
        let mut progress: Progress = serde_json::from_slice(&raw).unwrap();
        let view = view(31_000, BTreeMap::from([(0, &prompt), (1, &planner)]));
        let joined = view.collect(&mut progress);
        assert_eq!(joined.len(), 1);
        assert_eq!(
            joined[0].get("agent.antigravity.planner_joined"),
            Some(&json!(true))
        );
        assert_eq!(joined[0].turn_end, Some(true));
        assert_eq!(pending.last().unwrap().response_id, joined[0].response_id);
        assert!(view.collect(&mut progress).is_empty());
    }
}
