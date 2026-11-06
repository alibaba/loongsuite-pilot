//! Port of `src/inputs/qoder-trace/token-enricher.ts`.

use super::{InterceptTokenData, SegmentTokenData, SqliteTokenData};
use crate::normalization::normalize_finish_reason;
use crate::types::AgentActivityEntry;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const TIMESTAMP_THRESHOLD_MS: i64 = 5000;
const SEGMENT_JOIN_TOLERANCE_MS: i64 = 50;

pub fn enrich_cli_turn(
    entries: &mut [AgentActivityEntry],
    segments: &[SegmentTokenData],
    system_prompt: Option<&str>,
    intercept_tokens: &[InterceptTokenData],
) {
    enrich_cli_primary(entries, system_prompt, intercept_tokens);
    enrich_cli_from_segments(entries, segments);
}

pub fn enrich_cli_primary(
    entries: &mut [AgentActivityEntry],
    system_prompt: Option<&str>,
    intercept_tokens: &[InterceptTokenData],
) {
    if let Some(prompt) = system_prompt.filter(|prompt| !prompt.is_empty()) {
        if let Some(first) = entries.iter_mut().find(|entry| {
            is_name(entry, "llm.request") && entry.step_id.as_ref().is_some_and(|id| !id.is_empty())
        }) {
            first.system_instructions =
                Some(serde_json::json!([{ "type": "text", "content": prompt }]));
        }
    }
    apply_intercept_usage(entries, intercept_tokens);
}

pub fn needs_cli_segment_fallback(entries: &[AgentActivityEntry]) -> bool {
    for group in response_groups(entries).values() {
        if !has_positive_usage(&entries[group.matches[0]]) {
            return true;
        }
        let Some(step_id) = entries[group.matches[0]]
            .step_id
            .clone()
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let Some(request) = entries.iter().find(|entry| {
            is_name(entry, "llm.request") && entry.step_id.as_deref() == Some(step_id.as_str())
        }) else {
            continue;
        };
        let request_ns = parse_nanos(&request.time_unix_nano);
        let response_ns = parse_nanos(&entries[group.matches[0]].time_unix_nano);
        if request_ns.is_none() || response_ns.is_none() || request_ns >= response_ns {
            return true;
        }
    }
    false
}

pub fn collect_cli_expected_request_ids(entries: &[AgentActivityEntry]) -> Vec<String> {
    response_groups(entries)
        .values()
        .filter_map(|group| group.client_request_id.clone())
        .collect()
}

pub fn enrich_cli_from_segments(entries: &mut [AgentActivityEntry], segments: &[SegmentTokenData]) {
    let paired = pair_segments(entries, segments);
    for (segment, matches) in paired {
        let use_tokens = !has_positive_usage(&entries[matches[0]])
            && (segment.input_tokens > 0 || segment.output_tokens > 0);
        if use_tokens {
            let first = &mut entries[matches[0]];
            first.input_tokens = Some(segment.input_tokens);
            first.output_tokens = Some(segment.output_tokens);
            first.total_tokens = Some(segment.input_tokens + segment.output_tokens);
            first.cache_read_input_tokens = Some(segment.cache_read_tokens);
            first.cache_creation_input_tokens = Some(segment.cache_creation_tokens);
            for index in matches.iter().skip(1) {
                zero_usage(&mut entries[*index]);
            }
        }
        if !segment.stop_reason.is_empty() && entries[matches[0]].finish_reasons.is_none() {
            if let Some(normalized) = normalize_finish_reason(&segment.stop_reason) {
                entries[matches[0]].finish_reasons = Some(vec![normalized.to_owned()]);
            }
        }
        let step_id = entries[matches[0]].step_id.clone();
        let request_index = entries.iter().position(|entry| {
            is_name(entry, "llm.request")
                && entry.step_id == step_id
                && step_id.as_ref().is_some_and(|id| !id.is_empty())
        });
        if !segment.model.is_empty() && segment.model != "unknown" {
            if missing_model(entries[matches[0]].request_model.as_deref()) {
                entries[matches[0]].request_model = Some(segment.model.clone());
            }
            if missing_model(entries[matches[0]].response_model.as_deref()) {
                entries[matches[0]].response_model = Some(segment.model.clone());
            }
            if let Some(index) = request_index {
                if missing_model(entries[index].request_model.as_deref()) {
                    entries[index].request_model = Some(segment.model.clone());
                }
            }
        }
        let request_ns =
            request_index.and_then(|index| parse_nanos(&entries[index].time_unix_nano));
        let response_ns = parse_nanos(&entries[matches[0]].time_unix_nano);
        let hook_ok = request_ns.is_some() && response_ns.is_some() && request_ns < response_ns;
        if let Some(request_index) = request_index.filter(|_| {
            !hook_ok
                && segment.response_end_ts > 0
                && segment.request_start_ts > 0
                && segment.request_start_ts < segment.response_end_ts
        }) {
            entries[request_index].time_unix_nano =
                (segment.request_start_ts as i128 * 1_000_000).to_string();
            entries[matches[0]].time_unix_nano =
                (segment.response_end_ts as i128 * 1_000_000).to_string();
            if step_id.as_ref().is_some_and(|id| !id.is_empty()) && segment.tool_finished_ts > 0 {
                let call_ts = (segment.response_end_ts as i128 * 1_000_000).to_string();
                let result_ts = (segment.tool_finished_ts as i128 * 1_000_000).to_string();
                let duration = segment.tool_finished_ts - segment.response_end_ts;
                for entry in entries.iter_mut() {
                    if entry.step_id != step_id {
                        continue;
                    }
                    if is_name(entry, "tool.call") && parse_nanos(&entry.time_unix_nano).is_none() {
                        entry.time_unix_nano = call_ts.clone();
                    }
                    if is_name(entry, "tool.result") {
                        if parse_nanos(&entry.time_unix_nano).is_none() {
                            entry.time_unix_nano = result_ts.clone();
                        }
                        if entry.tool_call_duration.is_none() && duration > 0 {
                            entry.tool_call_duration = Some(duration as f64);
                        }
                    }
                }
            }
        }
    }
}

pub fn enrich_ide_turn(entries: &mut [AgentActivityEntry], sqlite_rows: &[SqliteTokenData]) {
    if sqlite_rows.is_empty() {
        return;
    }
    let mut response_indexes: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| is_name(entry, "llm.response"))
        .map(|(index, _)| index)
        .collect();
    response_indexes.sort_by_key(|index| extract_ms(&entries[*index]));
    let mut used = HashSet::new();
    let mut token_written = HashSet::new();
    let groups = group_sqlite_rows(sqlite_rows);
    match_by_order(entries, &groups, &mut used, &mut token_written);
    for (request_id, rows) in &groups {
        for row in rows {
            let dedupe = sqlite_dedupe_key(row);
            if token_written.contains(&dedupe) {
                continue;
            }
            let mut best: Option<usize> = None;
            let mut best_diff = i64::MAX;
            for index in &response_indexes {
                if used.contains(index) {
                    continue;
                }
                let diff = (match_ms(&entries[*index]) - row.gmt_create).abs();
                if diff < best_diff {
                    best_diff = diff;
                    best = Some(*index);
                }
            }
            if let Some(index) = best.filter(|_| best_diff <= TIMESTAMP_THRESHOLD_MS) {
                used.insert(index);
                entries[index].extra.insert(
                    "__matched_gmt_create".into(),
                    serde_json::json!(row.gmt_create),
                );
                if entries[index]
                    .response_id
                    .as_ref()
                    .is_none_or(|id| id.is_empty())
                {
                    let id = if row.message_id.is_empty() {
                        request_id.clone()
                    } else {
                        row.message_id.clone()
                    };
                    entries[index].response_id = Some(id);
                }
                entries[index].request_id = Some(request_id.clone());
                entries[index]
                    .extra
                    .insert("agent.request_id".into(), serde_json::json!(request_id));
                if row.model.as_ref().is_some_and(|model| model != "unknown") {
                    let model = row.model.clone().unwrap_or_default();
                    entries[index].request_model = Some(model.clone());
                    entries[index].response_model = Some(model.clone());
                    let step_id = entries[index].step_id.clone();
                    if let Some(req) = entries
                        .iter_mut()
                        .find(|entry| is_name(entry, "llm.request") && entry.step_id == step_id)
                    {
                        req.request_id = Some(request_id.clone());
                        req.extra
                            .insert("agent.request_id".into(), serde_json::json!(request_id));
                        req.request_model = Some(model);
                    }
                }
                if token_written.insert(dedupe) {
                    entries[index].input_tokens = Some(row.input_tokens);
                    entries[index].output_tokens = Some(row.output_tokens);
                    entries[index].total_tokens = Some(row.input_tokens + row.output_tokens);
                    entries[index].cache_read_input_tokens = Some(row.cache_read_tokens);
                }
            }
        }
    }
    let mut matched = Vec::new();
    for index in &response_indexes {
        if !used.contains(index) {
            continue;
        }
        if let Some(gmt) = entries[*index]
            .extra
            .get("__matched_gmt_create")
            .and_then(Value::as_i64)
        {
            matched.push((*index, gmt));
        }
    }
    matched.sort_by_key(|(_, gmt)| *gmt);
    for (ordinal, (index, gmt)) in matched.iter().copied().enumerate() {
        let mut response_time = gmt as i128 * 1_000_000;
        entries[index].time_unix_nano = response_time.to_string();
        let step_id = entries[index].step_id.clone();
        let turn_id = entries[index].turn_id.clone();
        let req_index = step_id
            .as_ref()
            .and_then(|step| {
                entries.iter().position(|entry| {
                    is_name(entry, "llm.request") && entry.step_id.as_deref() == Some(step.as_str())
                })
            })
            .or_else(|| {
                entries[..index]
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, entry)| {
                        is_name(entry, "llm.request")
                            && entry.step_id.is_some()
                            && entry.turn_id == turn_id
                    })
                    .map(|(pos, _)| pos)
            });
        if let Some(req_index) = req_index {
            let mut request_start = None;
            if let Some((_, previous_gmt)) = matched[..ordinal]
                .iter()
                .rev()
                .copied()
                .find(|(previous, _)| entries[*previous].turn_id == turn_id)
            {
                let mut latest = parse_nanos(
                    &entries[matched[..ordinal]
                        .iter()
                        .rev()
                        .find(|(previous, _)| entries[*previous].turn_id == turn_id)
                        .unwrap()
                        .0]
                        .time_unix_nano,
                )
                .unwrap_or(previous_gmt as i128 * 1_000_000);
                let previous_index = matched[..ordinal]
                    .iter()
                    .rev()
                    .find(|(previous, _)| entries[*previous].turn_id == turn_id)
                    .unwrap()
                    .0;
                for entry in entries.iter().take(index).skip(previous_index + 1) {
                    if is_name(entry, "tool.result") && entry.turn_id == turn_id {
                        if let Some(result_time) = parse_nanos(&entry.time_unix_nano) {
                            if result_time > latest {
                                latest = result_time;
                            }
                        }
                    }
                }
                request_start = Some(latest + 1);
            } else if let Some(boundary) = entries.iter().find(|entry| {
                entry.turn_id == turn_id
                    && entry.step_id.as_ref().is_none_or(|id| id.is_empty())
                    && (is_name(entry, "llm.request")
                        || (is_name(entry, "other") && entry.input_messages_delta.is_some()))
            }) {
                if let Some(ns) = parse_nanos(&boundary.time_unix_nano) {
                    request_start = Some(ns + 1);
                }
            }
            if let Some(start) = request_start {
                if start >= response_time {
                    response_time = start + 1;
                }
                if start >= 0 {
                    entries[req_index].time_unix_nano = start.to_string();
                    entries[index].time_unix_nano = response_time.to_string();
                }
            }
        }
        let tool_call_ts = (response_time + 1).to_string();
        let tool_result_ts = (response_time + 2).to_string();
        let right = matched
            .get(ordinal + 1)
            .map(|(next, _)| *next)
            .unwrap_or(entries.len());
        for entry in entries.iter_mut().take(right).skip(index + 1) {
            if is_name(entry, "tool.call") && parse_nanos(&entry.time_unix_nano).is_none() {
                entry.time_unix_nano = tool_call_ts.clone();
            }
            if is_name(entry, "tool.result") && parse_nanos(&entry.time_unix_nano).is_none() {
                entry.time_unix_nano = tool_result_ts.clone();
            }
        }
    }
    for index in &response_indexes {
        entries[*index].extra.remove("__matched_gmt_create");
        if entries[*index].input_tokens.is_none() {
            entries[*index].input_tokens = Some(0);
            entries[*index].output_tokens = Some(0);
            entries[*index].total_tokens = Some(0);
            entries[*index].cache_read_input_tokens = Some(0);
        }
    }
}

pub fn inject_trace_id(entries: &mut [AgentActivityEntry]) {
    if entries.is_empty() {
        return;
    }
    let trace_id = hex::encode(uuid::Uuid::new_v4().as_bytes());
    for entry in entries {
        entry.trace_id = Some(trace_id.clone());
    }
}

struct ResponseGroup {
    matches: Vec<usize>,
    ms: Option<i64>,
    client_request_id: Option<String>,
}

fn response_groups(entries: &[AgentActivityEntry]) -> IndexMap<String, ResponseGroup> {
    // Native response order decides which occurrence consumes a shared client
    // request's next segment, matching the original JavaScript Map contract.
    let mut groups = IndexMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if !is_name(entry, "llm.response") {
            continue;
        }
        let nanos = parse_nanos(&entry.time_unix_nano);
        let key = entry
            .response_id
            .clone()
            .filter(|id| !id.is_empty())
            .map(|id| format!("id:{id}"))
            .unwrap_or_else(|| format!("step:{}", entry.step_id.as_deref().unwrap_or("")));
        let client = entry
            .extra
            .get("agent.client_request_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let group = groups.entry(key).or_insert_with(|| ResponseGroup {
            matches: Vec::new(),
            ms: nanos.map(|ns| (ns / 1_000_000) as i64),
            client_request_id: client.clone(),
        });
        group.matches.push(index);
        if group.client_request_id.is_none() {
            group.client_request_id = client;
        }
        if group.ms.is_none() {
            group.ms = nanos.map(|ns| (ns / 1_000_000) as i64);
        }
    }
    groups
}

fn pair_segments(
    entries: &[AgentActivityEntry],
    segments: &[SegmentTokenData],
) -> Vec<(SegmentTokenData, Vec<usize>)> {
    let groups = response_groups(entries);
    if groups.is_empty() {
        return Vec::new();
    }
    let mut used_segments = HashSet::new();
    let mut used_keys = HashSet::new();
    let mut paired = Vec::new();
    let mut by_request: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        if segment.request_id.is_empty() {
            continue;
        }
        by_request
            .entry(segment.request_id.as_str())
            .or_default()
            .push(index);
    }
    for (key, group) in &groups {
        let Some(client) = &group.client_request_id else {
            continue;
        };
        let Some(index) = by_request.get(client.as_str()).and_then(|list| {
            list.iter()
                .copied()
                .find(|index| !used_segments.contains(index))
        }) else {
            continue;
        };
        used_keys.insert(key.clone());
        used_segments.insert(index);
        paired.push((segments[index].clone(), group.matches.clone()));
    }
    let mut candidates = Vec::new();
    for (key, group) in &groups {
        if used_keys.contains(key) || group.client_request_id.is_some() {
            continue;
        }
        let Some(ms) = group.ms else { continue };
        for (index, segment) in segments.iter().enumerate() {
            if segment.response_end_ts <= 0 || used_segments.contains(&index) {
                continue;
            }
            let delta = (ms - segment.response_end_ts).abs();
            if delta <= SEGMENT_JOIN_TOLERANCE_MS {
                candidates.push((delta, key.clone(), index));
            }
        }
    }
    candidates.sort_by_key(|(delta, _, _)| *delta);
    for (_, key, index) in candidates {
        if used_keys.contains(&key) || used_segments.contains(&index) {
            continue;
        }
        used_keys.insert(key.clone());
        used_segments.insert(index);
        paired.push((segments[index].clone(), groups[&key].matches.clone()));
    }
    paired
}

fn apply_intercept_usage(entries: &mut [AgentActivityEntry], tokens: &[InterceptTokenData]) {
    if tokens.is_empty() {
        return;
    }
    let mut latest: HashMap<String, InterceptTokenData> = HashMap::new();
    for token in tokens {
        if token.id.is_empty()
            || !(token.prompt_tokens > 0 || token.completion_tokens > 0 || token.total_tokens > 0)
        {
            continue;
        }
        match latest.get(&token.id) {
            Some(previous) if token.ts < previous.ts => {}
            _ => {
                latest.insert(token.id.clone(), token.clone());
            }
        }
    }
    for (response_id, usage) in latest {
        let matches: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                is_name(entry, "llm.response")
                    && entry.response_id.as_deref() == Some(response_id.as_str())
            })
            .map(|(index, _)| index)
            .collect();
        if matches.is_empty() {
            continue;
        }
        let total = if usage.total_tokens > 0 {
            usage.total_tokens
        } else {
            usage.prompt_tokens + usage.completion_tokens
        };
        entries[matches[0]].input_tokens = Some(usage.prompt_tokens);
        entries[matches[0]].output_tokens = Some(usage.completion_tokens);
        entries[matches[0]].total_tokens = Some(total);
        entries[matches[0]].cache_read_input_tokens = Some(usage.cached_tokens);
        for index in matches.iter().skip(1) {
            zero_usage(&mut entries[*index]);
        }
    }
}

fn match_by_order(
    entries: &mut [AgentActivityEntry],
    groups: &[(String, Vec<SqliteTokenData>)],
    used: &mut HashSet<usize>,
    written: &mut HashSet<String>,
) {
    if groups.is_empty()
        || !groups.iter().all(|(_, rows)| {
            rows.iter()
                .all(|row| !row.message_id.is_empty() && !row.session_id.is_empty())
        })
    {
        return;
    }
    let session_id = entries
        .iter()
        .find(|entry| !entry.session_id.is_empty())
        .map(|entry| entry.session_id.clone());
    let session_groups: Vec<&(String, Vec<SqliteTokenData>)> = if let Some(session_id) = &session_id
    {
        groups
            .iter()
            .filter(|(_, rows)| rows.first().map(|row| &row.session_id) == Some(session_id))
            .collect()
    } else {
        groups.iter().collect()
    };
    if session_groups.is_empty() {
        return;
    }
    let turns = group_turns(entries);
    if turns.is_empty() {
        return;
    }
    let pair_count = session_groups.len().min(turns.len());
    let start = session_groups.len() - pair_count;
    for offset in 0..pair_count {
        let turn_indexes = &turns[offset].1;
        let (request_id, rows) = session_groups[start + offset];
        let responses: Vec<usize> = turn_indexes
            .iter()
            .copied()
            .filter(|index| is_name(&entries[*index], "llm.response"))
            .collect();
        if responses.is_empty() || rows.is_empty() {
            continue;
        }
        if let Some(anchor) = responses
            .iter()
            .find_map(|index| accurate_match_ms(&entries[*index]))
        {
            if (anchor - rows[0].gmt_create).abs() > TIMESTAMP_THRESHOLD_MS {
                continue;
            }
        }
        let one_to_one = responses.len().min(rows.len());
        for (position, response_index) in responses.iter().copied().take(one_to_one).enumerate() {
            let slice = if position == responses.len() - 1 {
                &rows[position..]
            } else {
                &rows[position..position + 1]
            };
            apply_rows(entries, response_index, slice, request_id, used, written);
        }
    }
}

fn apply_rows(
    entries: &mut [AgentActivityEntry],
    response: usize,
    rows: &[SqliteTokenData],
    request_id: &str,
    used: &mut HashSet<usize>,
    written: &mut HashSet<String>,
) {
    if rows.is_empty() {
        return;
    }
    let representative = rows.last().unwrap();
    used.insert(response);
    entries[response].extra.insert(
        "__matched_gmt_create".into(),
        serde_json::json!(representative.gmt_create),
    );
    entries[response].request_id = Some(request_id.to_owned());
    entries[response]
        .extra
        .insert("agent.request_id".into(), serde_json::json!(request_id));
    entries[response].response_id = Some(if representative.message_id.is_empty() {
        request_id.to_owned()
    } else {
        representative.message_id.clone()
    });
    if representative
        .model
        .as_ref()
        .is_some_and(|model| model != "unknown")
    {
        let model = representative.model.clone().unwrap();
        entries[response].request_model = Some(model.clone());
        entries[response].response_model = Some(model.clone());
        let step = entries[response].step_id.clone();
        if let Some(request) = entries
            .iter_mut()
            .find(|entry| is_name(entry, "llm.request") && entry.step_id == step)
        {
            request.request_id = Some(request_id.to_owned());
            request
                .extra
                .insert("agent.request_id".into(), serde_json::json!(request_id));
            request.request_model = Some(model);
        }
    }
    let unused: Vec<&SqliteTokenData> = rows
        .iter()
        .filter(|row| !written.contains(&sqlite_dedupe_key(row)))
        .collect();
    if unused.is_empty() {
        return;
    }
    let input: i64 = unused.iter().map(|row| row.input_tokens).sum();
    let output: i64 = unused.iter().map(|row| row.output_tokens).sum();
    let cache: i64 = unused.iter().map(|row| row.cache_read_tokens).sum();
    entries[response].input_tokens = Some(input);
    entries[response].output_tokens = Some(output);
    entries[response].total_tokens = Some(input + output);
    entries[response].cache_read_input_tokens = Some(cache);
    if unused.len() > 1 {
        entries[response].extra.insert(
            "agent.qoder.usage_match_mode".into(),
            serde_json::json!("aggregated_tail"),
        );
        entries[response].extra.insert(
            "agent.qoder.sqlite_row_count".into(),
            serde_json::json!(unused.len()),
        );
    }
    for row in unused {
        written.insert(sqlite_dedupe_key(row));
    }
}

fn group_turns(entries: &[AgentActivityEntry]) -> Vec<(String, Vec<usize>)> {
    let mut order = Vec::new();
    let mut map: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(turn) = entry.turn_id.clone().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !map.contains_key(&turn) {
            order.push(turn.clone());
        }
        map.entry(turn).or_default().push(index);
    }
    order
        .into_iter()
        .filter_map(|turn| {
            let indexes = map.remove(&turn)?;
            if indexes
                .iter()
                .any(|index| is_name(&entries[*index], "llm.response"))
            {
                Some((turn, indexes))
            } else {
                None
            }
        })
        .collect()
}

fn group_sqlite_rows(rows: &[SqliteTokenData]) -> Vec<(String, Vec<SqliteTokenData>)> {
    let mut map: HashMap<String, Vec<SqliteTokenData>> = HashMap::new();
    let mut order = Vec::new();
    for row in rows {
        if row.request_id.is_empty() {
            continue;
        }
        if !map.contains_key(&row.request_id) {
            order.push(row.request_id.clone());
        }
        map.entry(row.request_id.clone())
            .or_default()
            .push(row.clone());
    }
    let mut groups: Vec<(String, Vec<SqliteTokenData>)> = order
        .into_iter()
        .map(|id| {
            let mut rows = map.remove(&id).unwrap_or_default();
            rows.sort_by_key(|row| row.gmt_create);
            (id, rows)
        })
        .collect();
    groups.sort_by_key(|(_, rows)| rows.first().map(|row| row.gmt_create).unwrap_or(0));
    groups
}

fn sqlite_dedupe_key(row: &SqliteTokenData) -> String {
    if !row.message_id.is_empty() {
        row.message_id.clone()
    } else {
        format!("{}:{}", row.request_id, row.gmt_create)
    }
}

fn is_name(entry: &AgentActivityEntry, name: &str) -> bool {
    entry
        .event_name
        .map(|event| event.as_str() == name)
        .unwrap_or(false)
}

fn missing_model(value: Option<&str>) -> bool {
    matches!(value, None | Some("") | Some("auto") | Some("unknown"))
}

fn has_positive_usage(entry: &AgentActivityEntry) -> bool {
    entry.input_tokens.is_some_and(|n| n > 0)
        || entry.output_tokens.is_some_and(|n| n > 0)
        || entry.total_tokens.is_some_and(|n| n > 0)
}

fn zero_usage(entry: &mut AgentActivityEntry) {
    entry.input_tokens = Some(0);
    entry.output_tokens = Some(0);
    entry.total_tokens = Some(0);
    entry.cache_read_input_tokens = Some(0);
    entry.cache_creation_input_tokens = Some(0);
}

fn parse_nanos(value: &str) -> Option<i128> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn extract_ms(entry: &AgentActivityEntry) -> i64 {
    if let Ok(raw) = entry.time_unix_nano.parse::<f64>() {
        if raw.is_finite() {
            return if raw > 1e15 {
                (raw / 1e6) as i64
            } else {
                raw as i64
            };
        }
    }
    entry
        .extra
        .get("timestamp")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn accurate_match_ms(entry: &AgentActivityEntry) -> Option<i64> {
    match entry.extra.get("agent.qoder.match_ts") {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|n| n as i64)),
        Some(Value::String(text)) => text.parse().ok(),
        _ => None,
    }
}

fn match_ms(entry: &AgentActivityEntry) -> i64 {
    accurate_match_ms(entry).unwrap_or_else(|| extract_ms(entry))
}
