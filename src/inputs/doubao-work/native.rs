use super::budget::{DoubaoWorkError, Result};
use super::content::{parse_native_content, NativeContent};
use super::log::build_doubao_task_events;
use super::types::{DoubaoPendingTurn, DoubaoToolPair};
use super::util::*;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tokio::io::AsyncReadExt;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEdge {
    pub child: String,
    pub parent: String,
    pub call_id: String,
    pub thread_id: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct NativeGraph {
    pub main: String,
    pub edges: IndexMap<String, NativeEdge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<NativeContent>,
}
pub fn append_native_graph_row(
    main: &str,
    actor: &str,
    row: &Value,
    calls: &mut HashSet<String>,
    edges: &mut IndexMap<String, NativeEdge>,
) -> bool {
    if let Some(tool_calls) = row.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            if text(call.get("function").and_then(|f| f.get("name"))) == Some("create_agent") {
                if let Some(id) = text(call.get("id")).filter(|id| native_id(id)) {
                    calls.insert(id.to_owned());
                }
            }
        }
    }
    let Some(id) = text(row.get("tool_call_id")) else {
        return true;
    };
    let Some(content) = text(row.get("content")) else {
        return true;
    };
    if text(row.get("role")) != Some("tool")
        || !calls.contains(id)
        || !content.starts_with("create_agent ok\n")
    {
        return true;
    }
    static FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(agent_id|parent_id|thread_id): ([a-zA-Z0-9_-]+)$").unwrap()
    });
    let mut fields = IndexMap::new();
    for capture in FIELD.captures_iter(content) {
        fields
            .entry(capture[1].to_owned())
            .or_insert_with(|| capture[2].to_owned());
    }
    let (Some(child), Some(parent), Some(thread)) = (
        fields.get("agent_id"),
        fields.get("parent_id"),
        fields.get("thread_id"),
    ) else {
        return false;
    };
    if !native_id(child)
        || child == actor
        || !numeric_id(thread)
        || parent != if actor == main { "main_agent" } else { actor }
    {
        return false;
    }
    let edge = NativeEdge {
        child: child.clone(),
        parent: actor.into(),
        call_id: id.into(),
        thread_id: thread.clone(),
    };
    if edges.get(child).is_some_and(|prior| prior != &edge) {
        return false;
    }
    edges.insert(child.clone(), edge);
    true
}
pub fn parse_native_graph(files: &IndexMap<String, String>) -> Option<NativeGraph> {
    static MAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^m_[a-zA-Z0-9]+$").unwrap());
    let mains: Vec<_> = files.keys().filter(|id| MAIN.is_match(id)).collect();
    if mains.len() != 1 {
        return None;
    }
    let main = mains[0].clone();
    let mut edges = IndexMap::new();
    for (actor, content) in files {
        if !native_id(actor) {
            return None;
        }
        let mut calls = HashSet::new();
        for line in content.split('\n').filter(|line| !line.is_empty()) {
            let row = parse_json(line).ok()?;
            if row.is_null()
                || (!row.is_object() && !row.is_array())
                || !append_native_graph_row(&main, actor, &row, &mut calls, &mut edges)
            {
                return None;
            }
        }
    }
    Some(NativeGraph {
        main,
        edges,
        content: None,
    })
}
async fn bounded_read(path: &Path, allowed: &Path, bytes: &mut u64) -> Result<Option<String>> {
    let stat = match tokio::fs::symlink_metadata(path).await {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 2 * 1024 * 1024 {
        return Ok(None);
    }
    let canonical = tokio::fs::canonicalize(path).await?;
    if !canonical.starts_with(allowed) || canonical == allowed {
        return Ok(None);
    }
    *bytes = bytes.saturating_add(stat.len());
    if *bytes > 8 * 1024 * 1024 {
        return Ok(None);
    }
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![
        0;
        usize::try_from(stat.len())
            .map_err(|_| DoubaoWorkError::invalid("native file size overflow"))?
    ];
    if let Err(error) = file.read_exact(&mut buffer).await {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(error.into());
    }
    if file.metadata().await?.len() != stat.len() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
}
pub async fn read_native_graph(
    sessions_root: &str,
    conversation_id: &str,
    capture_content: bool,
) -> Result<Option<NativeGraph>> {
    if !native_id(conversation_id) {
        return Ok(None);
    }
    let root = Path::new(sessions_root)
        .join(conversation_id)
        .join("agents");
    let canonical = tokio::fs::canonicalize(&root).await?;
    let allowed = tokio::fs::canonicalize(sessions_root).await?;
    if !canonical.starts_with(&allowed) || canonical == allowed {
        return Ok(None);
    }
    let mut entries = tokio::fs::read_dir(&root).await?;
    let mut actors = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await?.is_dir() && native_id(&name) {
            actors.push(name);
        }
    }
    if actors.len() > 64 {
        return Ok(None);
    }
    let mut files = IndexMap::new();
    let mut assignments = IndexMap::new();
    let mut bytes = 0;
    for actor in actors {
        let system = root.join(&actor).join("system");
        let trajectory = system.join("trajectory.jsonl");
        match tokio::fs::symlink_metadata(&trajectory).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let Some(content) = bounded_read(&trajectory, &canonical, &mut bytes).await? else {
            return Ok(None);
        };
        if !content.is_empty() && !content.ends_with('\n') {
            return Ok(None);
        }
        files.insert(actor.clone(), content);
        if capture_content {
            let assignment = system.join("assignment.md");
            match tokio::fs::symlink_metadata(&assignment).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
            let Some(content) = bounded_read(&assignment, &canonical, &mut bytes).await? else {
                return Ok(None);
            };
            assignments.insert(actor, content);
        }
    }
    let Some(mut graph) = parse_native_graph(&files) else {
        return Ok(None);
    };
    if capture_content {
        let Some(content) = parse_native_content(&files, &assignments)? else {
            return Ok(None);
        };
        graph.content = Some(content);
    }
    Ok(Some(graph))
}
pub async fn read_native_profile_graph(
    user_data_root: &str,
    conversation_id: &str,
    capture_content: bool,
) -> Result<Option<NativeGraph>> {
    if !native_id(conversation_id) {
        return Ok(None);
    }
    let canonical = tokio::fs::canonicalize(user_data_root).await?;
    let mut entries = tokio::fs::read_dir(user_data_root).await?;
    let mut profiles = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "Default"
            || name.strip_prefix("Profile ").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
            })
        {
            profiles.push(entry);
        }
    }
    if profiles.len() > 16 {
        return Ok(None);
    }
    let mut matches = Vec::<PathBuf>::new();
    for profile in profiles {
        let kind = profile.file_type().await?;
        if !kind.is_dir() || kind.is_symlink() {
            return Ok(None);
        }
        let sessions = profile
            .path()
            .join(".doubaowork/agent_mode/workspace/.sessions");
        let conversation = sessions.join(conversation_id);
        let stat = match tokio::fs::symlink_metadata(&conversation).await {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let resolved = tokio::fs::canonicalize(&conversation).await?;
        if !stat.is_dir()
            || stat.file_type().is_symlink()
            || !resolved.starts_with(&canonical)
            || resolved == canonical
        {
            return Ok(None);
        }
        matches.push(sessions);
    }
    if matches.len() != 1 {
        return Ok(None);
    }
    read_native_graph(
        matches[0]
            .to_str()
            .ok_or_else(|| DoubaoWorkError::invalid("native profile path is not UTF-8"))?,
        conversation_id,
        capture_content,
    )
    .await
}
pub fn build_native_tool_events(
    scope: &str,
    root: &DoubaoPendingTurn,
    graph: &NativeGraph,
    pair: &DoubaoToolPair,
    observed_ms: i64,
) -> Vec<RawEvent> {
    let (Some(actor), Some(call), Some(end), Some(terminal)) = (
        pair.start.turn_id.as_ref(),
        pair.start.tool.as_ref(),
        pair.end.tool.as_ref(),
        root.terminal.as_ref(),
    ) else {
        return Vec::new();
    };
    let (Some(start_nano), Some(end_nano)) =
        (nanos(&pair.start.time_nano), nanos(&pair.end.time_nano))
    else {
        return Vec::new();
    };
    if !graph.edges.contains_key(actor)
        || call.id != end.id
        || call.name != end.name
        || call.sandbox_id != end.sandbox_id
        || call.phase != "received"
        || end.phase != "settled"
        || end.status.is_none()
        || start_nano < i128::from(root.query_ms) * 1_000_000
        || end_nano <= start_nano
    {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut current = actor.as_str();
    while current != graph.main {
        if seen.contains(current) || seen.len() >= 8 {
            return Vec::new();
        }
        let Some(edge) = graph.edges.get(current) else {
            return Vec::new();
        };
        seen.insert(current);
        current = &edge.parent;
    }
    let Some(mut base) = build_doubao_task_events(scope, root, terminal, observed_ms, &[])
        .into_iter()
        .next()
    else {
        return Vec::new();
    };
    remove(
        &mut base,
        &[
            "gen_ai.turn.start",
            "gen_ai.input.messages_delta",
            "gen_ai.turn.id",
        ],
    );
    let identity = digest(&encode(&serde_json::json!([
        scope,
        base["trace_id"],
        call.sandbox_id,
        actor,
        call.id
    ])));
    for (key, value) in [
        ("gen_ai.agent.id", actor.as_str()),
        ("gen_ai.agent.name", actor.as_str()),
        ("gen_ai.tool.name", call.name.as_str()),
        ("gen_ai.tool.call.id", call.id.as_str()),
        ("gen_ai.tool.type", "function"),
        (
            "loongsuite.doubao_work.observation_scope",
            "native_local_tool",
        ),
        ("loongsuite.doubao_work.trace_role", "log_only"),
        ("loongsuite.doubao_work.root_turn_id", root.turn_id.as_str()),
        (
            "loongsuite.doubao_work.tool_boundary",
            "client_received_to_execution_settled",
        ),
        (
            "loongsuite.doubao_work.native_creator_agent_id",
            graph.edges[actor].parent.as_str(),
        ),
        (
            "loongsuite.doubao_work.native_thread_id",
            graph.edges[actor].thread_id.as_str(),
        ),
    ] {
        set(&mut base, key, value);
    }
    let mut event = base.clone();
    set(&mut event, "event.name", "tool.call");
    set(&mut event, "event.id", digest(&format!("{identity}:call")));
    set(&mut event, "time_unix_nano", pair.start.time_nano.clone());
    set(&mut base, "event.name", "tool.result");
    set(&mut base, "event.id", digest(&format!("{identity}:result")));
    set(&mut base, "time_unix_nano", pair.end.time_nano.clone());
    let status = end.status.as_deref().unwrap();
    set(&mut base, "tool.result.status", status);
    set(
        &mut base,
        "gen_ai.tool.call.duration",
        number((end_nano - start_nano) as f64 / 1_000_000.0),
    );
    if status != "success" {
        set(
            &mut base,
            "error.type",
            if status == "cancelled" {
                "doubao.local_tool_cancelled"
            } else {
                "doubao.local_tool_failed"
            },
        );
    }
    vec![event, base]
}
