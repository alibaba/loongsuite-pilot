use super::budget::{DoubaoWorkError, Result};
use super::log::build_doubao_task_events;
use super::native::NativeGraph;
use super::types::DoubaoPendingTurn;
use super::util::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::AsyncReadExt;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExecution {
    pub execution_key: String,
    pub conversation_id: String,
    pub query_message_id: String,
    pub agent_id: String,
    pub agent_type: String,
    pub sandbox_id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}
pub fn parse_native_execution(value: &Value) -> Option<NativeExecution> {
    let row = value.get("execution")?.as_object()?;
    let execution_key = text(row.get("executionKey"))
        .filter(|v| uuid(v))?
        .to_owned();
    let conversation_id = text(row.get("conversationId"))
        .filter(|v| numeric_id(v))?
        .to_owned();
    let query_message_id = text(row.get("queryMessageId"))
        .filter(|v| uuid(v))?
        .to_owned();
    let agent_id = text(row.get("agentId"))
        .filter(|v| native_id(v))?
        .to_owned();
    let sandbox_id = text(row.get("sandboxId"))
        .filter(|v| native_id(v))?
        .to_owned();
    let agent_type = text(row.get("agentType"))
        .filter(|v| ["sub_agent", "organizer", "main_agent"].contains(v))?
        .to_owned();
    let started_at_ms = safe_i64(row.get("startedAtMs")?)?;
    let ended_at_ms = safe_i64(row.get("endedAtMs")?)?;
    if started_at_ms < MIN_MS || ended_at_ms >= MAX_MS || ended_at_ms <= started_at_ms {
        return None;
    }
    Some(NativeExecution {
        execution_key,
        conversation_id,
        query_message_id,
        agent_id,
        agent_type,
        sandbox_id,
        started_at_ms,
        ended_at_ms,
    })
}
async fn directories(
    folder: &Path,
    canonical: &Path,
    limit: usize,
) -> Result<Vec<tokio::fs::DirEntry>> {
    let stat = tokio::fs::symlink_metadata(folder).await?;
    let resolved = tokio::fs::canonicalize(folder).await?;
    if !stat.is_dir()
        || stat.file_type().is_symlink()
        || !resolved.starts_with(canonical)
        || resolved == canonical
    {
        return Err(DoubaoWorkError::invalid(
            "Unsafe native execution directory",
        ));
    }
    let mut values = Vec::new();
    let mut entries = tokio::fs::read_dir(folder).await?;
    while let Some(entry) = entries.next_entry().await? {
        let kind = entry.file_type().await?;
        if kind.is_dir() && !kind.is_symlink() {
            values.push(entry);
        }
    }
    if values.len() > limit {
        return Err(DoubaoWorkError::invalid(
            "Native execution directory limit exceeded",
        ));
    }
    Ok(values)
}
pub async fn read_native_executions(
    snapshot_root: &str,
    conversation_id: &str,
) -> Result<Vec<NativeExecution>> {
    if !numeric_id(conversation_id) {
        return Ok(Vec::new());
    }
    let canonical = tokio::fs::canonicalize(snapshot_root).await?;
    let mut entries = tokio::fs::read_dir(snapshot_root).await?;
    let mut accounts = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_dir() && numeric_id(&entry.file_name().to_string_lossy()) {
            accounts.push(entry);
        }
    }
    if accounts.len() > 8 {
        return Err(DoubaoWorkError::invalid(
            "Native execution account limit exceeded",
        ));
    }
    let (mut bytes, mut files, mut execution_count) = (0_u64, 0_usize, 0_usize);
    let mut result = IndexMap::new();
    for account in accounts {
        let folder = account.path().join(conversation_id);
        let names = match directories(&folder, &canonical, 128).await {
            Ok(values) => values,
            Err(error) if error.missing() => continue,
            Err(error) => return Err(error),
        };
        for entry in names {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !uuid(&name) {
                continue;
            }
            execution_count += 1;
            if execution_count > 128 {
                return Err(DoubaoWorkError::invalid(
                    "Native execution count limit exceeded",
                ));
            }
            let dir = entry.path();
            directories(&dir, &canonical, 0).await?;
            let mut names = tokio::fs::read_dir(&dir).await?;
            let mut records = Vec::new();
            while let Some(record) = names.next_entry().await? {
                records.push(record);
            }
            if records.len() > 64 {
                return Err(DoubaoWorkError::invalid(
                    "Native execution record limit exceeded",
                ));
            }
            for record in records {
                let name = record.file_name().to_string_lossy().into_owned();
                let kind = record.file_type().await?;
                if !kind.is_file()
                    || kind.is_symlink()
                    || !name.ends_with(".json")
                    || !native_id(&name[..name.len() - 5])
                {
                    continue;
                }
                files += 1;
                if files > 128 {
                    return Err(DoubaoWorkError::invalid(
                        "Native execution file limit exceeded",
                    ));
                }
                let path = record.path();
                let stat = tokio::fs::symlink_metadata(&path).await?;
                let resolved = tokio::fs::canonicalize(&path).await?;
                bytes = bytes.saturating_add(stat.len());
                if !stat.is_file()
                    || stat.file_type().is_symlink()
                    || stat.len() > 2 * 1024 * 1024
                    || bytes > 8 * 1024 * 1024
                    || !resolved.starts_with(&canonical)
                    || resolved == canonical
                {
                    return Err(DoubaoWorkError::invalid(
                        "Native execution read limit exceeded",
                    ));
                }
                let mut file = tokio::fs::File::open(&path).await?;
                let mut buffer = vec![0; stat.len() as usize];
                file.read_exact(&mut buffer).await?;
                let after = file.metadata().await?;
                if after.len() != stat.len() || after.modified().ok() != stat.modified().ok() {
                    return Err(DoubaoWorkError::invalid(
                        "Native execution changed during read",
                    ));
                }
                let value = parse_json(&String::from_utf8_lossy(&buffer))?;
                let Some(execution) = parse_native_execution(&value) else {
                    continue;
                };
                if execution.conversation_id != conversation_id
                    || execution.execution_key != entry.file_name().to_string_lossy()
                    || format!("{}.json", execution.agent_id) != name
                {
                    return Err(DoubaoWorkError::invalid(
                        "Native execution path identity mismatch",
                    ));
                }
                if result
                    .get(&execution.execution_key)
                    .is_some_and(|prior| prior != &execution)
                {
                    return Err(DoubaoWorkError::invalid(
                        "Conflicting native execution identity",
                    ));
                }
                result.insert(execution.execution_key.clone(), execution);
            }
        }
    }
    Ok(result.into_values().collect())
}
pub fn native_execution_span_id(scope: &str, execution_key: &str) -> String {
    digest(&encode(&json!([
        "doubao-native-execution",
        scope,
        execution_key
    ])))[..16]
        .into()
}
pub fn is_unique_native_tool_owner(
    execution: &NativeExecution,
    siblings: &[NativeExecution],
    start_nano: &str,
    end_nano: &str,
) -> bool {
    let (Some(start), Some(end)) = (nanos(start_nano), nanos(end_nano)) else {
        return false;
    };
    let owners: Vec<_> = siblings
        .iter()
        .filter(|candidate| {
            candidate.agent_id == execution.agent_id
                && candidate.conversation_id == execution.conversation_id
                && candidate.query_message_id == execution.query_message_id
                && candidate.sandbox_id == execution.sandbox_id
                && i128::from(candidate.started_at_ms) * 1_000_000 <= start
                && i128::from(candidate.ended_at_ms) * 1_000_000 >= end
        })
        .collect();
    owners.len() == 1 && owners[0].execution_key == execution.execution_key
}
pub fn build_native_execution_events(
    scope: &str,
    root: &DoubaoPendingTurn,
    graph: &NativeGraph,
    execution: &NativeExecution,
    siblings: &[NativeExecution],
    observed_ms: i64,
) -> Vec<RawEvent> {
    let Some(e) = parse_native_execution(&json!({"execution":execution})) else {
        return Vec::new();
    };
    let Some(terminal) = root.terminal.as_ref() else {
        return Vec::new();
    };
    if root.conversation_id.as_deref() != Some(&e.conversation_id)
        || root.local_message_id.as_deref() != Some(&e.query_message_id)
        || e.started_at_ms < root.query_ms
        || !graph.edges.contains_key(&e.agent_id)
    {
        return Vec::new();
    }
    let mut chain = Vec::new();
    let mut current = e.agent_id.as_str();
    while current != graph.main {
        if chain.contains(&current) || chain.len() >= 8 {
            return Vec::new();
        }
        let Some(edge) = graph.edges.get(current) else {
            return Vec::new();
        };
        chain.push(current);
        current = &edge.parent;
    }
    let root_events = build_doubao_task_events(scope, root, terminal, observed_ms, &[]);
    let Some(root_event) = root_events.first() else {
        return Vec::new();
    };
    let trace_id = root_event["trace_id"].as_str().unwrap();
    let edge = &graph.edges[&e.agent_id];
    let parents: Vec<_> = siblings
        .iter()
        .filter(|p| {
            parse_native_execution(&json!({"execution":p})).is_some()
                && p.started_at_ms >= root.query_ms
                && p.agent_id == edge.parent
                && p.execution_key != e.execution_key
                && p.conversation_id == e.conversation_id
                && p.query_message_id == e.query_message_id
                && p.sandbox_id == e.sandbox_id
        })
        .collect();
    let parent = if parents.len() == 1
        && parents[0].started_at_ms <= e.started_at_ms
        && parents[0].ended_at_ms >= e.ended_at_ms
    {
        Some(parents[0])
    } else {
        None
    };
    let identity = digest(&encode(&json!([scope, trace_id, e.execution_key])));
    let mut pending = root.clone();
    pending.first_output = None;
    pending.turn_id = e.agent_id.clone();
    pending.query_ms = e.started_at_ms;
    pending.selected_skills = None;
    pending.selected_partners = None;
    let mut terminal = terminal.clone();
    terminal.query_ms = Some(e.started_at_ms);
    terminal.time_nano = ms_nanos(e.ended_at_ms);
    terminal.client_outcome = Some("ended".into());
    build_doubao_task_events(scope, &pending, &terminal, observed_ms, &[])
        .into_iter()
        .enumerate()
        .map(|(index, mut event)| {
            remove(
                &mut event,
                &["gen_ai.turn.start", "gen_ai.turn.end", "gen_ai.turn.id"],
            );
            set(&mut event, "trace_id", trace_id);
            set(
                &mut event,
                "event.id",
                digest(&format!("{identity}:event:{index}")),
            );
            set(
                &mut event,
                "loongsuite.doubao_work.local_execution_phase",
                if index == 0 { "start" } else { "end" },
            );
            set(&mut event, "gen_ai.agent.id", e.agent_id.clone());
            set(
                &mut event,
                "gen_ai.agent.name",
                root_event["gen_ai.agent.name"].clone(),
            );
            set(
                &mut event,
                "loongsuite.doubao_work.native_creator_agent_id",
                edge.parent.clone(),
            );
            if let Some(parent) = parent {
                set(
                    &mut event,
                    "parent_span_id",
                    native_execution_span_id(scope, &parent.execution_key),
                );
            }
            set(
                &mut event,
                "loongsuite.doubao_work.local_execution_span_id",
                native_execution_span_id(scope, &e.execution_key),
            );
            set(
                &mut event,
                "loongsuite.doubao_work.root_request_start_unix_nano",
                ms_nanos(root.query_ms),
            );
            set(
                &mut event,
                "loongsuite.doubao_work.root_request_end_unix_nano",
                root.terminal.as_ref().unwrap().time_nano.clone(),
            );
            set(
                &mut event,
                "loongsuite.doubao_work.native_parent_in_request",
                parent.is_some_and(|p| {
                    nanos(&root.terminal.as_ref().unwrap().time_nano)
                        .is_some_and(|end| i128::from(p.ended_at_ms) * 1_000_000 <= end)
                }),
            );
            for (key, value) in [
                (
                    "loongsuite.doubao_work.observation_scope",
                    "native_sandbox_execution",
                ),
                (
                    "loongsuite.doubao_work.local_execution_boundary",
                    "native_sandbox_get_or_create_to_release",
                ),
                (
                    "loongsuite.doubao_work.timing_basis",
                    "native_execution_startedAtMs_endedAtMs",
                ),
                (
                    "loongsuite.doubao_work.relation_basis",
                    "native_create_agent_ancestry",
                ),
                (
                    "loongsuite.doubao_work.parent_resolution",
                    if parent.is_some() {
                        "same_query_native_execution"
                    } else {
                        "root_request_ancestor"
                    },
                ),
            ] {
                set(&mut event, key, value);
            }
            if let Some(parent) = parent {
                set(
                    &mut event,
                    "loongsuite.doubao_work.native_parent_execution_id",
                    parent.execution_key.clone(),
                );
            }
            for (key, value) in [
                (
                    "loongsuite.doubao_work.native_execution_id",
                    e.execution_key.as_str(),
                ),
                (
                    "loongsuite.doubao_work.native_query_message_id",
                    e.query_message_id.as_str(),
                ),
                (
                    "loongsuite.doubao_work.native_sandbox_id",
                    e.sandbox_id.as_str(),
                ),
                (
                    "loongsuite.doubao_work.native_creation_call_id",
                    edge.call_id.as_str(),
                ),
                (
                    "loongsuite.doubao_work.native_thread_id",
                    edge.thread_id.as_str(),
                ),
                ("loongsuite.doubao_work.root_turn_id", root.turn_id.as_str()),
                ("loongsuite.doubao_work.root_agent_id", graph.main.as_str()),
            ] {
                set(&mut event, key, value);
            }
            let ancestors: Vec<_> = chain
                .iter()
                .skip(1)
                .copied()
                .chain(std::iter::once(graph.main.as_str()))
                .collect();
            set(
                &mut event,
                "loongsuite.doubao_work.native_ancestor_ids",
                json!(ancestors),
            );
            if let Some(resource) = event
                .get_mut("resourceAttributes")
                .and_then(Value::as_object_mut)
            {
                set(
                    resource,
                    "loongsuite.doubao_work.observation_scope",
                    "native_sandbox_execution",
                );
            }
            event
        })
        .collect()
}
