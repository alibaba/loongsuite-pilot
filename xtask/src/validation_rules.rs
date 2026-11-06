//! 从 GenAI Markdown 规范生成规则；差异模式只读，失败不覆盖已有规则。

use anyhow::{ensure, Context, Result};
use clap::Args;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const SECTIONS: [(&str, &str); 11] = [
    ("公共部分", "COMMON"),
    ("Chain", "CHAIN"),
    ("Retriever", "RETRIEVER"),
    ("Reranker", "RERANKER"),
    ("LLM", "LLM"),
    ("Embedding", "EMBEDDING"),
    ("Tool", "TOOL"),
    ("Agent", "AGENT"),
    ("Task", "TASK"),
    ("Entry", "ENTRY"),
    ("ReAct Step", "STEP"),
];

#[derive(Args)]
pub struct Options {
    #[arg(long)]
    spec_file: Option<PathBuf>,
    #[arg(long)]
    spec_url: Option<String>,
    #[arg(long, short = 'o')]
    output: Option<PathBuf>,
    #[arg(long)]
    diff: bool,
    /// 要求公共资源及全部十种 Span 的属性表完整；发布规则使用此门禁。
    #[arg(long)]
    strict: bool,
}

#[derive(Debug, Clone)]
struct Attribute {
    key: String,
    kind: &'static str,
    level: &'static str,
    expected: Option<String>,
}
#[derive(Default)]
struct Section {
    attrs: Vec<Attribute>,
    resources: Vec<Attribute>,
}

fn section(name: &str) -> Option<&'static str> {
    SECTIONS
        .iter()
        .find(|(source, _)| *source == name)
        .map(|(_, target)| *target)
}
fn level(text: &str) -> Option<&'static str> {
    match text {
        "必须" => Some("must"),
        "有条件时必须" | "推荐" => Some("should"),
        "可选" => Some("optional"),
        _ => None,
    }
}
fn normalize_type(text: &str) -> &'static str {
    let text = text.to_lowercase();
    if text.contains("int") {
        "integer"
    } else if text.contains("float") || text.contains("double") {
        "number"
    } else if text.contains("string[]") {
        "string_array"
    } else {
        "string"
    }
}
fn columns(line: &str) -> Vec<&str> {
    line.split('|')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}
fn separator(line: &str) -> bool {
    line.strip_prefix('|')
        .is_some_and(|rest| rest.trim_start().starts_with("---"))
}

fn parse_spec(md: &str, strict: bool) -> Result<BTreeMap<&'static str, Section>> {
    let mut sections: BTreeMap<_, Section> = BTreeMap::new();
    let mut current = None;
    let mut table = None;
    for (index, line) in md.lines().enumerate() {
        if let Some(name) = line.strip_prefix("# ") {
            current = section(name.trim());
            if let Some(kind) = current {
                sections.entry(kind).or_default();
            }
            table = None;
            continue;
        }
        match line.trim() {
            "## Resources" => {
                table = Some(true);
                continue;
            }
            "## Attributes" => {
                table = Some(false);
                continue;
            }
            _ if line.starts_with("## ") => {
                table = None;
                continue;
            }
            _ => {}
        }
        let (Some(kind), Some(resources)) = (current, table) else {
            continue;
        };
        if !line.starts_with('|')
            || separator(line)
            || line.contains("AttributeKey")
            || line.contains("ResourceKey")
        {
            continue;
        }
        let cols = columns(line);
        let requirement = cols.iter().skip(3).find_map(|text| level(text));
        if cols.len() < 4 || requirement.is_none() {
            ensure!(!strict, "规范第 {} 行属性表缺少列或要求等级", index + 1);
            continue;
        }
        let key = cols[0].replace('`', "");
        let key = key
            .split_once('[')
            .map(|(prefix, _)| prefix)
            .unwrap_or(&key)
            .trim();
        if key.is_empty() || key == "---" {
            continue;
        }
        let example = cols[3].replace('`', "").trim().to_string();
        let expected = if key == "gen_ai.span.kind" {
            if level(&example).is_none() && section(&example).is_some() {
                Some(example)
            } else {
                (kind != "COMMON").then(|| kind.to_owned())
            }
        } else {
            None
        };
        let attr = Attribute {
            key: key.into(),
            kind: normalize_type(cols[2]),
            level: requirement.unwrap(),
            expected,
        };
        let target = sections.get_mut(kind).unwrap();
        let attrs = if resources {
            &mut target.resources
        } else {
            &mut target.attrs
        };
        ensure!(
            !strict || !attrs.iter().any(|existing| existing.key == attr.key),
            "规范第 {} 行包含重复属性",
            index + 1
        );
        attrs.push(attr);
    }
    ensure!(
        sections.values().any(|s| !s.attrs.is_empty()),
        "未解析到任何有效属性表，拒绝生成空规则"
    );
    if strict {
        for (_, kind) in SECTIONS {
            ensure!(
                sections.get(kind).is_some_and(|s| !s.attrs.is_empty()),
                "规范缺少 {kind} 属性表"
            );
        }
        ensure!(
            !sections["COMMON"].resources.is_empty(),
            "规范缺少公共资源表"
        );
    }
    Ok(sections)
}

fn operation_mapping(md: &str) -> Map<String, Value> {
    let mut mapping = Map::new();
    let mut in_table = false;
    for line in md.lines() {
        if line.contains("`gen_ai.span.kind`")
            && line.contains("`gen_ai.operation.name`")
            && line.contains("Description")
        {
            in_table = true;
            continue;
        }
        if !in_table || separator(line) {
            continue;
        }
        let cols = columns(line);
        if !line.starts_with('|') || cols.len() < 3 {
            in_table = false;
            continue;
        }
        for op in cols[1]
            .replace('`', "")
            .split(';')
            .map(str::trim)
            .filter(|op| !op.is_empty() && *op != "-")
        {
            mapping.insert(op.into(), json!(cols[0]));
        }
    }
    for (op, kind) in [
        ("enter", "ENTRY"),
        ("react", "STEP"),
        ("run_task", "TASK"),
        ("workflow", "CHAIN"),
        ("task", "CHAIN"),
        ("rerank", "RERANKER"),
    ] {
        mapping.entry(op).or_insert(json!(kind));
    }
    mapping
}

fn attr_entry(attr: &Attribute, resource: bool) -> Value {
    let mut entry = json!({"key": attr.key, "type": attr.kind});
    if let Some(value) = &attr.expected {
        entry["expectedValue"] = json!(value);
    }
    if resource {
        return entry;
    }
    if attr.kind == "integer" {
        entry["min"] = json!(0);
    }
    let schema = match attr.key.as_str() {
        "gen_ai.input.messages" => Some("input_messages"),
        "gen_ai.output.messages" => Some("output_messages"),
        "gen_ai.system_instructions" => Some("system_instructions"),
        "gen_ai.tool.definitions" => Some("tool_definitions"),
        "gen_ai.retrieval.documents" => Some("retrieval_documents"),
        _ => None,
    };
    if let Some(schema) = schema {
        entry["schema"] = json!(schema);
    }
    if matches!(
        attr.key.as_str(),
        "gen_ai.input.messages"
            | "gen_ai.output.messages"
            | "gen_ai.system_instructions"
            | "gen_ai.tool.definitions"
            | "gen_ai.tool.call.arguments"
            | "gen_ai.tool.call.result"
            | "gen_ai.input.multimodal_metadata"
            | "gen_ai.input.multimodal_metadata_delta"
            | "gen_ai.output.multimodal_metadata"
    ) {
        entry["requiresMessageContent"] = json!(true);
    }
    entry
}

fn attributes(raw: &[Attribute], kind: &str, resource: bool) -> Value {
    let mut must = Vec::new();
    let mut should = Vec::new();
    for attr in raw {
        if !resource
            && kind == "COMMON"
            && matches!(
                attr.key.as_str(),
                "gen_ai.span.kind" | "gen_ai.operation.name"
            )
        {
            continue;
        }
        let mut requirement = attr.level;
        if !resource {
            if matches!(
                attr.key.as_str(),
                "gen_ai.session.id" | "gen_ai.user.id" | "gen_ai.agent.name"
            ) || (kind == "TOOL" && attr.key == "gen_ai.tool.name")
            {
                requirement = "must";
            }
            if requirement == "optional"
                && matches!(
                    (kind, attr.key.as_str()),
                    (
                        "RERANKER",
                        "reranker.query" | "reranker.model_name" | "reranker.top_k"
                    ) | (
                        "RETRIEVER",
                        "gen_ai.retrieval.documents" | "gen_ai.retrieval.query.text"
                    ) | (
                        "TASK",
                        "input.value" | "input.mime_type" | "output.value" | "output.mime_type"
                    ) | (
                        "EMBEDDING",
                        "gen_ai.usage.input_tokens" | "gen_ai.usage.total_tokens"
                    )
                )
            {
                requirement = "should";
            }
        }
        match requirement {
            "must" => must.push(attr_entry(attr, resource)),
            "should" => should.push(attr_entry(attr, resource)),
            _ => {}
        }
    }
    if resource {
        if !must.iter().any(|a| a["key"] == "service.name") {
            must.push(json!({"key":"service.name", "type":"string"}));
        }
        if !should
            .iter()
            .any(|a| a["key"] == "acs.arms.service.feature")
        {
            should.push(json!({"key":"acs.arms.service.feature", "type":"string", "expectedValue":"genai_app"}));
        }
    }
    json!({"must":must, "should":should})
}

fn build_rules(sections: &BTreeMap<&str, Section>, mapping: Map<String, Value>) -> Value {
    let mut kinds = json!({
        "ENTRY":{"namePattern":"enter_ai_application_system","operationName":"enter","multiplicity":"exactly_one_or_external_delegated_fragment","parentKind":null,"allowedChildren":["AGENT"]},
        "AGENT":{"namePattern":"{gen_ai.operation.name} {gen_ai.agent.name}","operationName":["invoke_agent","create_agent"],"multiplicity":"one_root_per_entry_and_optional_delegated_agents","parentKind":["ENTRY","TOOL"],"allowedChildren":["STEP"],
            "aggregation":{"gen_ai.usage.input_tokens":{"rule":"sum","source":"LLM","scope":"own_agent_execution_excluding_delegated_agents"},"gen_ai.usage.output_tokens":{"rule":"sum","source":"LLM","scope":"own_agent_execution_excluding_delegated_agents"},"gen_ai.usage.total_tokens":{"rule":"sum","source":"LLM","scope":"own_agent_execution_excluding_delegated_agents"}}},
        "STEP":{"namePattern":"react step","operationName":"react","multiplicity":"one_or_more","parentKind":"AGENT","allowedChildren":["LLM","TOOL"],
            "constraints":[{"rule":"exactly_one_child_of_kind","kind":"LLM"},{"rule":"llm_starts_before_all_tools"},{"rule":"no_time_overlap_between_siblings"}]},
        "LLM":{"namePattern":"{gen_ai.operation.name} {gen_ai.request.model}","operationName":["chat","generate_content","text_completion"],"multiplicity":"one_or_more","parentKind":"STEP","allowedChildren":[]},
        "TOOL":{"namePattern":"execute_tool {gen_ai.tool.name}","operationName":"execute_tool","multiplicity":"zero_or_more","parentKind":"STEP","allowedChildren":["AGENT"]},
        "CHAIN":{"namePattern":"chain {chain_name}","operationName":["workflow","task"],"multiplicity":"zero_or_more","parentKind":null,"allowedChildren":[]},
        "RETRIEVER":{"namePattern":"{gen_ai.operation.name} {gen_ai.data_source.id}","operationName":"retrieval","multiplicity":"zero_or_more","parentKind":null,"allowedChildren":[]},
        "RERANKER":{"namePattern":"rerank {reranker.model_name}","operationName":"rerank","multiplicity":"zero_or_more","parentKind":null,"allowedChildren":[]},
        "EMBEDDING":{"namePattern":"{gen_ai.operation.name} {gen_ai.request.model}","operationName":"embeddings","multiplicity":"zero_or_more","parentKind":null,"allowedChildren":[]},
        "TASK":{"namePattern":"run_task {gen_ai.task.name}","operationName":"run_task","multiplicity":"zero_or_more","parentKind":null,"allowedChildren":[]}
    });
    for (kind, value) in kinds.as_object_mut().unwrap() {
        let attrs = sections
            .get(kind.as_str())
            .map(|s| s.attrs.as_slice())
            .unwrap_or(&[]);
        value["attributes"] = attributes(attrs, kind, false);
    }
    kinds["AGENT"]["externalParentContext"] = json!("A missing parent TOOL requires a valid parentSpanId and explicit parent invocation or parent tool call ID; report the local fragment boundary.");
    let common = sections.get("COMMON");
    json!({
        "version":"1.1",
        "generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "specSource":"docs/zh-CN/subagent-data-model.md",
        "specSourceDescription":"Public contract for subagent rules; existing non-subagent rules are retained from the previous baseline.",
        "commonAttributes":attributes(common.map(|s| s.attrs.as_slice()).unwrap_or(&[]), "COMMON", false),
        "spanKinds":kinds,
        "operationKindMapping":mapping,
        "timeRules":[
            {"id":"time.non_zero_duration","applies":"all","severity":"error"},
            {"id":"time.no_step_overlap","applies":"STEP","severity":"error","scope":"direct_steps_of_each_agent"},
            {"id":"time.parent_contains_children","applies":"all","severity":"error","toleranceMs":0,"exception":"TOOL to delegated AGENT requires causal start ordering but permits asynchronous child completion."},
            {"id":"time.reasonable_duration","applies":"LLM","maxMs":600000,"severity":"warn"},
            {"id":"time.chronological_steps","applies":"STEP","severity":"warn","scope":"direct_steps_of_each_agent"}
        ],
        "semanticRules":[
            {"id":"semantic.agent_token_sum","scope":"own_agent_execution_excluding_delegated_agents","severity":"error"},
            {"id":"semantic.tool_matches_llm_output","severity":"error","requiresMessageContent":true},
            {"id":"semantic.entry_input_exists","severity":"warn","requiresMessageContent":true},
            {"id":"semantic.entry_output_matches","severity":"warn","scope":"entry_root_agent_execution_excluding_delegated_agents","requiresMessageContent":true},
            {"id":"semantic.consistent_session_id","scope":"own_agent_execution_excluding_delegated_agents","severity":"error"},
            {"id":"semantic.consistent_turn_id","severity":"error","scope":"own_agent_execution_excluding_delegated_agents"},
            {"id":"semantic.consistent_user_id","severity":"error"},
            {"id":"semantic.consistent_agent_name","scope":"own_agent_execution_excluding_delegated_agents","severity":"warn"},
            {"id":"semantic.llm_has_input_output","severity":"error","requiresMessageContent":true},
            {"id":"semantic.operation_kind_mapping","severity":"error"},
            {"id":"semantic.span_name_pattern","severity":"warn"},
            {"id":"semantic.tool_response_role","severity":"error","requiresMessageContent":true},
            {"id":"semantic.last_step_no_tool_call","scope":"own_agent_execution_excluding_delegated_agents","severity":"error","requiresMessageContent":true}
        ],
        "resourceAttributes":attributes(common.map(|s| s.resources.as_slice()).unwrap_or(&[]), "COMMON", true),
        "messageSchemas":{
            "input_messages":"$ref:tests/schemas/gen-ai-input-messages.json",
            "output_messages":"$ref:tests/schemas/gen-ai-output-messages.json",
            "system_instructions":"$ref:tests/schemas/gen-ai-system_instructions.json",
            "tool_definitions":"$ref:tests/schemas/gen-ai-tool-definitions.json",
            "retrieval_documents":"$ref:tests/schemas/gen-ai-retrieval-documents.json"
        }
    })
}

// 不再把同名字段的类型、资源、时间或语义约束变化误报为“没有差异”。
fn diff_rules(old: &Value, new: &Value) -> Vec<String> {
    fn walk(path: &str, old: &Value, new: &Value, changes: &mut Vec<String>) {
        if old == new {
            return;
        }
        if let (Some(a), Some(b)) = (old.as_object(), new.as_object()) {
            for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
                if path.is_empty() && key == "generatedAt" {
                    continue;
                }
                let path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match (a.get(key), b.get(key)) {
                    (None, Some(_)) => changes.push(format!("+ {path}")),
                    (Some(_), None) => changes.push(format!("- {path}")),
                    (Some(a), Some(b)) => walk(&path, a, b, changes),
                    _ => {}
                }
            }
        } else {
            changes.push(format!("~ {path}"));
        }
    }
    let mut changes = Vec::new();
    // 保留旧工具逐 kind/字段/等级的报告，再补充原先未比较的规则变化。
    let objects = |value: &Value| value.as_object().cloned().unwrap_or_default();
    let old_kinds = objects(&old["spanKinds"]);
    let new_kinds = objects(&new["spanKinds"]);
    let keys = |kind: &Value, level: &str| -> BTreeSet<String> {
        kind["attributes"][level]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|attr| attr["key"].as_str().map(str::to_owned))
            .collect()
    };
    for kind in old_kinds
        .keys()
        .chain(new_kinds.keys())
        .collect::<BTreeSet<_>>()
    {
        match (old_kinds.get(kind), new_kinds.get(kind)) {
            (None, Some(_)) => changes.push(format!("+ added span kind: {kind}")),
            (Some(_), None) => changes.push(format!("- removed span kind: {kind}")),
            (Some(a), Some(b)) => {
                let old_must = keys(a, "must");
                let new_must = keys(b, "must");
                let old_keys = old_must
                    .union(&keys(a, "should"))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                let new_keys = new_must
                    .union(&keys(b, "should"))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                for key in new_keys.difference(&old_keys) {
                    changes.push(format!("+ {kind}: added attribute {key}"));
                }
                for key in old_keys.difference(&new_keys) {
                    changes.push(format!("- {kind}: removed attribute {key}"));
                }
                for key in new_must
                    .difference(&old_must)
                    .filter(|key| old_keys.contains(*key))
                {
                    changes.push(format!("^ {kind}: {key} upgraded to MUST"));
                }
                for key in old_must
                    .difference(&new_must)
                    .filter(|key| new_keys.contains(*key))
                {
                    changes.push(format!("v {kind}: {key} downgraded from MUST"));
                }
            }
            _ => {}
        }
    }
    let old_mapping = objects(&old["operationKindMapping"]);
    let new_mapping = objects(&new["operationKindMapping"]);
    for op in old_mapping
        .keys()
        .chain(new_mapping.keys())
        .collect::<BTreeSet<_>>()
    {
        match (old_mapping.get(op), new_mapping.get(op)) {
            (None, Some(b)) => {
                changes.push(format!("+ mapping: {op} -> {}", b.as_str().unwrap_or("?")))
            }
            (Some(a), None) => {
                changes.push(format!("- mapping: {op} -> {}", a.as_str().unwrap_or("?")))
            }
            (Some(a), Some(b)) if a != b => changes.push(format!(
                "~ mapping: {op}: {} -> {}",
                a.as_str().unwrap_or("?"),
                b.as_str().unwrap_or("?")
            )),
            _ => {}
        }
    }
    walk("", old, new, &mut changes);
    changes
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    ensure!(fs::metadata(path)?.is_file(), "输入必须是普通文件");
    let mut file = fs::File::open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.len() <= MAX_BYTES as u64,
        "输入不是普通文件或超过 16 MiB"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "输入超过 16 MiB");
    Ok(bytes)
}

async fn fetch_spec(raw: &str) -> Result<String> {
    let url = reqwest::Url::parse(raw).map_err(|_| anyhow::anyhow!("规范 URL 无效"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none(),
        "规范 URL 只允许不含用户凭据的 HTTP/HTTPS 地址"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut response = client.get(url).send().await.map_err(|e| e.without_url())?;
    ensure!(
        response.status().is_success(),
        "规范下载 HTTP {}",
        response.status().as_u16()
    );
    ensure!(
        response.content_length().unwrap_or(0) <= MAX_BYTES as u64,
        "规范响应超过 16 MiB"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url())? {
        ensure!(
            chunk.len() <= MAX_BYTES - bytes.len(),
            "规范响应超过 16 MiB"
        );
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).context("规范不是有效 UTF-8")
}

fn generate(root: &Path, options: &Options) -> Result<()> {
    let source = options
        .spec_file
        .clone()
        .unwrap_or_else(|| root.join("../arms/semantic-conventions/arms_docs/trace/gen-ai.md"));
    let output = options
        .output
        .clone()
        .unwrap_or_else(|| root.join("docs/trace-validation-rules.json"));
    let md = if let Some(url) = &options.spec_url {
        // 不输出 URL：查询参数可能包含访问令牌。
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(fetch_spec(url))?
    } else {
        if let Ok(target) = fs::canonicalize(&output) {
            ensure!(fs::canonicalize(&source)? != target, "输出不能覆盖输入规范");
        }
        String::from_utf8(read_bounded(&source)?).context("规范不是有效 UTF-8")?
    };
    let md = md.trim_start_matches('\u{feff}');
    let sections = parse_spec(md, options.strict)?;
    if !options.strict {
        eprintln!("[update-rules] 兼容模式允许部分规范；完整性门禁请使用 --strict");
    }
    let rules = build_rules(&sections, operation_mapping(md));
    let previous = match fs::symlink_metadata(&output) {
        Ok(meta) => {
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "规则输出必须是普通文件"
            );
            Some((read_bounded(&output)?, meta.permissions()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let old = match &previous {
        Some((bytes, _)) => {
            let value: Value =
                serde_json::from_slice(bytes).context("已有规则 JSON 无效，保留原文件")?;
            ensure!(value.is_object(), "已有规则必须是对象，保留原文件");
            value
        }
        None => json!({}),
    };
    let changes = diff_rules(&old, &rules);
    println!("[update-rules] {} 项规则差异", changes.len());
    for change in changes {
        println!("[update-rules] {change}");
    }
    // 即使目标不存在，--diff 也不能创建文件或目录。
    if options.diff {
        return Ok(());
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut staged, &rules)?;
    staged.write_all(b"\n")?;
    if let Some((_, permissions)) = &previous {
        staged.as_file().set_permissions(permissions.clone())?;
    }
    staged.as_file().sync_all()?;
    match &previous {
        Some((bytes, _)) => {
            let meta = fs::symlink_metadata(&output)?;
            ensure!(
                meta.is_file()
                    && !meta.file_type().is_symlink()
                    && read_bounded(&output)? == *bytes,
                "已有规则已发生外部修改，拒绝覆盖"
            );
            staged.persist(&output).map_err(|error| error.error)?;
        }
        None => {
            staged
                .persist_noclobber(&output)
                .map_err(|error| error.error)?;
        }
    }
    println!("[update-rules] 已写入规则：10 种 Span");
    Ok(())
}

pub fn run(root: &Path, options: Options) -> u8 {
    match generate(root, &options) {
        Ok(()) => 0,
        Err(error) => {
            let missing = options.spec_url.is_none()
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                && !options
                    .spec_file
                    .as_deref()
                    .unwrap_or(&root.join("../arms/semantic-conventions/arms_docs/trace/gen-ai.md"))
                    .exists();
            eprintln!("[update-rules] 错误：{error:#}");
            if missing {
                2
            } else {
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SPEC: &str = "# 公共部分\n## Attributes\n| AttributeKey | Description | Type | Example | Level |\n| --- | --- | --- | --- | --- |\n| `gen_ai.session.id` [注] | 会话 | string | id | 可选 |\n| gen_ai.span.kind | 类型 | string | LLM | 必须 |\n## Resources\n| ResourceKey | Description | Type | Example | Level |\n| host.id | 主机 | string | host | 推荐 |\n# Tool\n## Attributes\n| gen_ai.tool.name | 名称 | string | 必须 |\n| gen_ai.tool.call.arguments | 参数 | string | {} | 有条件时必须 |\n# LLM\n## Attributes\n| gen_ai.span.kind | 类型 | string | LLM | 必须 |\n| gen_ai.usage.input_tokens | 用量 | int64 | 0 | 必须 |\n| gen_ai.input.messages | 输入 | string | [] | 推荐 |\n";

    #[test]
    fn parser_keeps_levels_types_missing_examples_and_content_contract() {
        let sections = parse_spec(SPEC, false).unwrap();
        let rules = build_rules(&sections, operation_mapping(SPEC));
        assert_eq!(
            rules["commonAttributes"]["must"],
            json!([{"key":"gen_ai.session.id","type":"string"}])
        );
        assert_eq!(
            rules["spanKinds"]["TOOL"]["attributes"]["must"],
            json!([{"key":"gen_ai.tool.name","type":"string"}])
        );
        assert_eq!(
            rules["spanKinds"]["TOOL"]["attributes"]["should"][0]["requiresMessageContent"],
            true
        );
        assert_eq!(
            rules["spanKinds"]["LLM"]["attributes"]["must"][0]["expectedValue"],
            "LLM"
        );
        assert_eq!(rules["spanKinds"]["LLM"]["attributes"]["must"][1]["min"], 0);
        assert_eq!(
            rules["spanKinds"]["LLM"]["attributes"]["should"][0]["schema"],
            "input_messages"
        );
        assert_eq!(
            rules["resourceAttributes"]["must"],
            json!([{"key":"service.name","type":"string"}])
        );
        assert_eq!(
            rules["resourceAttributes"]["should"][1]["expectedValue"],
            "genai_app"
        );
        assert_eq!(rules["spanKinds"].as_object().unwrap().len(), 10);
        assert_eq!(rules["timeRules"].as_array().unwrap().len(), 5);
        assert_eq!(rules["semanticRules"].as_array().unwrap().len(), 13);
        assert_eq!(rules["messageSchemas"].as_object().unwrap().len(), 5);
        assert_eq!(normalize_type("double"), "number");
        assert_eq!(normalize_type("float"), "number");
        assert_eq!(normalize_type("STRING[]"), "string_array");
    }

    #[test]
    fn optional_elevations_and_mapping_defaults_match_legacy_rules() {
        for (kind, key) in [
            ("RERANKER", "reranker.query"),
            ("RERANKER", "reranker.model_name"),
            ("RERANKER", "reranker.top_k"),
            ("RETRIEVER", "gen_ai.retrieval.documents"),
            ("RETRIEVER", "gen_ai.retrieval.query.text"),
            ("TASK", "input.value"),
            ("TASK", "input.mime_type"),
            ("TASK", "output.value"),
            ("TASK", "output.mime_type"),
            ("EMBEDDING", "gen_ai.usage.input_tokens"),
            ("EMBEDDING", "gen_ai.usage.total_tokens"),
        ] {
            let attr = Attribute {
                key: key.into(),
                kind: "string",
                level: "optional",
                expected: None,
            };
            assert_eq!(
                attributes(&[attr], kind, false)["should"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        let map = operation_mapping("| `gen_ai.span.kind` | `gen_ai.operation.name` | Description |\n| --- | --- | --- |\n| LLM | `chat`; `generate_content`; - | 描述 |\n| TASK | enter | 覆盖默认 |\n\n| TOOL | fake | 不在表中 |");
        assert_eq!(map["chat"], "LLM");
        assert_eq!(map["generate_content"], "LLM");
        assert_eq!(map["enter"], "TASK");
        assert_eq!(map["react"], "STEP");
        assert!(!map.contains_key("fake"));
    }

    #[test]
    fn strict_parser_rejects_partial_unknown_levels_and_duplicate_rows() {
        assert!(parse_spec("<html>登录页面</html>", false).is_err());
        assert!(parse_spec(SPEC, true).is_err());
        let mut complete = String::new();
        for (name, kind) in SECTIONS {
            complete.push_str(&format!(
                "# {name}\n## Attributes\n| gen_ai.span.kind | 类型 | string | {kind} | 必须 |\n"
            ));
            if kind == "COMMON" {
                complete.push_str("## Resources\n| service.name | 服务 | string | name | 必须 |\n");
            }
        }
        assert!(parse_spec(&complete, true).is_ok());
        assert!(parse_spec(&complete.replace("必须", "未知等级"), true).is_err());
        complete.push_str("| gen_ai.span.kind | 类型 | string | STEP | 必须 |\n");
        assert!(parse_spec(&complete, true).is_err());
    }

    #[test]
    fn diff_preserves_named_attribute_and_requirement_change_reports() {
        let old = json!({"spanKinds":{"LLM":{"attributes":{"must":[{"key":"demote"},{"key":"remove"}],"should":[{"key":"promote"}]}},"OLD":{}}, "operationKindMapping":{"chat":"LLM","remove":"LLM"}});
        let new = json!({"spanKinds":{"LLM":{"attributes":{"must":[{"key":"promote"},{"key":"add"}],"should":[{"key":"demote"}]}},"NEW":{}}, "operationKindMapping":{"chat":"TOOL","add":"LLM"}});
        let changes = diff_rules(&old, &new);
        for expected in [
            "+ added span kind: NEW",
            "- removed span kind: OLD",
            "+ LLM: added attribute add",
            "- LLM: removed attribute remove",
            "^ LLM: promote upgraded to MUST",
            "v LLM: demote downgraded from MUST",
            "~ mapping: chat: LLM -> TOOL",
            "+ mapping: add -> LLM",
            "- mapping: remove -> LLM",
        ] {
            assert!(
                changes.iter().any(|change| change == expected),
                "{expected}: {changes:?}"
            );
        }
    }

    #[test]
    fn diff_detects_all_semantic_changes_but_ignores_timestamp() {
        let old = build_rules(&parse_spec(SPEC, false).unwrap(), operation_mapping(SPEC));
        let mut new = old.clone();
        new["generatedAt"] = json!("later");
        assert!(diff_rules(&old, &new).is_empty());
        for key in [
            "commonAttributes",
            "resourceAttributes",
            "spanKinds",
            "timeRules",
            "semanticRules",
            "operationKindMapping",
            "messageSchemas",
        ] {
            let mut new = old.clone();
            new[key] = json!({"changed":true});
            assert!(!diff_rules(&old, &new).is_empty(), "{key}");
        }
    }
}
