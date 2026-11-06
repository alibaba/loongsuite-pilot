//! Trace 语义合同；诊断只带规则与字段位置，不回显会话或消息正文。
use super::{integer, messages, present, truthy, Check, Rules, Span, Trace, TOKENS};
use serde_json::Value;
use std::collections::BTreeSet;

fn runtime_skill(tool: &Span) -> bool {
    tool.attributes["gen_ai.tool.type"] == "extension"
        && (truthy(&tool.attributes["gen_ai.skill.id"])
            || truthy(&tool.attributes["gen_ai.skill.name"]))
}
fn matches(tool: &Span, call: &Value) -> bool {
    !runtime_skill(tool)
        && [("gen_ai.tool.call.id", "id"), ("gen_ai.tool.name", "name")]
            .iter()
            .any(|(attribute, field)| {
                truthy(&call[*field]) && tool.attributes[*attribute] == call[*field]
            })
}
fn tool_calls(raw: &Value) -> Vec<Value> {
    messages::parsed(raw)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .flat_map(|msg| msg["parts"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "tool_call")
        .cloned()
        .collect()
}
fn checked(
    checks: &mut Vec<Check>,
    id: &str,
    status: &'static str,
    detail: &str,
    span: Option<&Span>,
) {
    checks.push(Check::new(id, status, detail.into(), span));
}

pub(super) fn validate(trace: &Trace<'_>, rules: &Rules) -> Vec<Check> {
    let mut checks = Vec::new();
    let executions: Vec<_> = trace
        .kind("AGENT")
        .into_iter()
        .map(|agent| (agent, trace.execution(agent)))
        .collect();
    for (agent, spans) in &executions {
        let mut identity = spans.clone();
        if let Some(entry) = trace.parent(agent).filter(|span| span.kind() == "ENTRY") {
            identity.push(entry);
        }
        for (key, id, status) in [
            (
                "gen_ai.session.id",
                "semantic.consistent_session_id",
                "error",
            ),
            ("gen_ai.turn.id", "semantic.consistent_turn_id", "error"),
            (
                "gen_ai.agent.name",
                "semantic.consistent_agent_name",
                "warn",
            ),
        ] {
            let values: BTreeSet<_> = identity
                .iter()
                .map(|span| &span.attributes[key])
                .filter(|v| truthy(v))
                .map(Value::to_string)
                .collect();
            if values.len() <= 1 {
                checks.push(Check::pass(id));
            } else {
                checked(
                    &mut checks,
                    id,
                    status,
                    "同一 AGENT 执行存在不一致的身份属性",
                    Some(agent),
                );
            }
        }
    }
    let users: BTreeSet<_> = trace
        .spans
        .iter()
        .map(|s| &s.attributes["gen_ai.user.id"])
        .filter(|v| truthy(v))
        .map(Value::to_string)
        .collect();
    if users.len() <= 1 {
        checks.push(Check::pass("semantic.consistent_user_id"));
    } else {
        checked(
            &mut checks,
            "semantic.consistent_user_id",
            "error",
            "同一 Trace 存在不一致的用户身份",
            None,
        );
    }
    let mut mapping_ok = true;
    let mut names_ok = true;
    for span in &trace.spans {
        if let Some(expected) = span.attributes["gen_ai.operation.name"]
            .as_str()
            .and_then(|op| rules.operation_kind_mapping.get(op))
        {
            if expected != span.kind() {
                mapping_ok = false;
                checked(
                    &mut checks,
                    "semantic.operation_kind_mapping",
                    "error",
                    "operation 与 span.kind 映射不一致",
                    Some(span),
                );
            }
        }
        if let Some(pattern) = rules
            .span_kinds
            .get(span.kind())
            .and_then(|k| k.name_pattern.as_deref())
            .filter(|p| !p.contains('{'))
        {
            if !span.name.starts_with(pattern) {
                names_ok = false;
                checked(
                    &mut checks,
                    "semantic.span_name_pattern",
                    "warn",
                    "Span 名称不符合规则前缀",
                    Some(span),
                );
            }
        }
    }
    if mapping_ok {
        checks.push(Check::pass("semantic.operation_kind_mapping"));
    }
    if names_ok {
        checks.push(Check::pass("semantic.span_name_pattern"));
    }
    let llms = trace.kind("LLM");
    for (agent, execution) in &executions {
        let llms: Vec<_> = execution.iter().filter(|s| s.kind() == "LLM").collect();
        let mut ok = true;
        for key in TOKENS {
            let value = &agent.attributes[*key];
            if value.is_null() {
                continue;
            }
            let sum = llms.iter().try_fold(0i128, |sum, llm| {
                let token = &llm.attributes[*key];
                let n = if token.is_null() {
                    Some(0)
                } else {
                    integer(token)
                }?;
                sum.checked_add(n)
            });
            if integer(value).is_none() || integer(value) != sum {
                ok = false;
                checked(
                    &mut checks,
                    "semantic.agent_token_sum",
                    "error",
                    "AGENT token 不等于 LLM token 总和",
                    Some(agent),
                );
            }
        }
        if ok
            && TOKENS
                .iter()
                .any(|key| agent.attributes.get(*key).is_some())
        {
            checks.push(Check::pass("semantic.agent_token_sum"));
        }
    }
    let tools = trace.kind("TOOL");
    let mut args_ok = true;
    for tool in &tools {
        if !present(&tool.attributes["gen_ai.tool.call.arguments"]) {
            args_ok = false;
            checked(
                &mut checks,
                "semantic.tool_has_arguments",
                "error",
                "TOOL 缺少 gen_ai.tool.call.arguments",
                Some(tool),
            );
        }
    }
    if args_ok {
        checks.push(Check::pass("semantic.tool_has_arguments"));
    }
    if !trace.has_content {
        checks.extend(
            [
                "semantic.tool_matches_llm_output",
                "semantic.entry_input_exists",
                "semantic.entry_output_matches",
                "semantic.llm_has_input_output",
                "semantic.tool_response_role",
                "semantic.last_step_no_tool_call",
            ]
            .into_iter()
            .map(Check::skipped),
        );
        return checks;
    }

    let mut tools_ok = true;
    let steps = trace.kind("STEP");
    for step in &steps {
        let children = trace.children(step);
        let Some(llm) = children.iter().find(|s| s.kind() == "LLM") else {
            continue;
        };
        let tools: Vec<_> = children
            .iter()
            .copied()
            .filter(|s| s.kind() == "TOOL")
            .collect();
        let raw = &llm.attributes["gen_ai.output.messages"];
        if !truthy(raw) || messages::parsed(raw).is_none() {
            continue;
        }
        let calls = tool_calls(raw);
        for tool in &tools {
            if !runtime_skill(tool) && !calls.iter().any(|call| matches(tool, call)) {
                tools_ok = false;
                checked(
                    &mut checks,
                    "semantic.tool_matches_llm_output",
                    "error",
                    "TOOL 未出现在 LLM output tool_calls 中",
                    Some(tool),
                );
            }
        }
        // 即使全部 TOOL 都丢失，仍检查模型声明，不能由空集合绕过验收。
        for call in calls {
            if !tools.iter().any(|tool| matches(tool, &call)) {
                if call["name"] == "Agent" {
                    checked(
                        &mut checks,
                        "semantic.tool_matches_llm_output",
                        "warn",
                        "子 Agent tool_call 缺少对应 TOOL Span",
                        Some(llm),
                    );
                } else {
                    tools_ok = false;
                    checked(
                        &mut checks,
                        "semantic.tool_matches_llm_output",
                        "error",
                        "模型声明的 tool_call 缺少对应 TOOL Span",
                        Some(llm),
                    );
                }
            }
        }
    }
    if tools_ok {
        checks.push(Check::pass("semantic.tool_matches_llm_output"));
    }
    if let Some(entry) = trace.kind("ENTRY").first() {
        let nonempty = messages::parsed(&entry.attributes["gen_ai.input.messages"])
            .is_some_and(|v| v.as_array().is_some_and(|a| !a.is_empty()));
        if nonempty {
            checks.push(Check::pass("semantic.entry_input_exists"));
        } else {
            checked(
                &mut checks,
                "semantic.entry_input_exists",
                "warn",
                "ENTRY input.messages 缺失、无效或为空",
                None,
            );
        }
        let root_llms: Vec<_> = executions
            .iter()
            .filter(|(agent, _)| agent.parent_span_id.as_deref() == Some(entry.span_id.as_str()))
            .flat_map(|(_, spans)| spans.iter().copied())
            .filter(|s| s.kind() == "LLM")
            .collect();
        if let Some(last) = root_llms
            .iter()
            .filter(|s| s.end().is_some())
            .max_by_key(|s| s.end())
        {
            let entry_output = &entry.attributes["gen_ai.output.messages"];
            let llm_output = &last.attributes["gen_ai.output.messages"];
            if truthy(entry_output) && truthy(llm_output) {
                if entry_output == llm_output {
                    checks.push(Check::pass("semantic.entry_output_matches"));
                } else {
                    checked(
                        &mut checks,
                        "semantic.entry_output_matches",
                        "warn",
                        "ENTRY output.messages 与最后 LLM 输出不同",
                        None,
                    );
                }
            }
        }
    }
    let mut io_ok = true;
    let mut roles_ok = true;
    for llm in llms {
        if ["gen_ai.input.messages", "gen_ai.output.messages"]
            .iter()
            .any(|key| llm.attributes.get(*key).is_none())
        {
            io_ok = false;
            checked(
                &mut checks,
                "semantic.llm_has_input_output",
                "error",
                "LLM 缺少 input/output.messages",
                Some(llm),
            );
        }
        if let Some(messages) = messages::parsed(&llm.attributes["gen_ai.input.messages"])
            .and_then(|v| v.as_array().cloned())
        {
            for message in messages {
                if message["parts"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|p| p["type"] == "tool_call_response"))
                    && message["role"] != "tool"
                {
                    roles_ok = false;
                    checked(
                        &mut checks,
                        "semantic.tool_response_role",
                        "error",
                        "tool_call_response 所在消息的 role 必须为 tool",
                        Some(llm),
                    );
                }
            }
        }
    }
    if io_ok {
        checks.push(Check::pass("semantic.llm_has_input_output"));
    }
    if roles_ok {
        checks.push(Check::pass("semantic.tool_response_role"));
    }
    for (_, execution) in &executions {
        if let Some(last_step) = execution
            .iter()
            .filter(|s| s.kind() == "STEP" && s.start().is_some())
            .max_by_key(|s| s.start())
        {
            if let Some(llm) = trace.children(last_step).iter().find(|s| s.kind() == "LLM") {
                if tool_calls(&llm.attributes["gen_ai.output.messages"]).is_empty() {
                    checks.push(Check::pass("semantic.last_step_no_tool_call"));
                } else {
                    checked(
                        &mut checks,
                        "semantic.last_step_no_tool_call",
                        "error",
                        "最后 STEP 的 LLM 输出仍包含 tool_call",
                        Some(llm),
                    );
                }
            }
        }
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(kind: &str, skill: bool) -> Span {
        let mut attributes = json!({"gen_ai.tool.type":kind,"gen_ai.tool.call.id":"call-1","gen_ai.tool.name":"Skill"});
        if skill {
            attributes["gen_ai.skill.name"] = json!("synthetic-skill");
        }
        serde_json::from_value(json!({"attributes":attributes})).unwrap()
    }
    #[test]
    fn runtime_skill_is_exempt_but_cannot_satisfy_model_tool_call() {
        let runtime = tool("extension", true);
        assert!(runtime_skill(&runtime));
        assert!(!matches(&runtime, &json!({"id":"call-1","name":"Skill"})));
    }
    #[test]
    fn ordinary_and_model_skills_require_id_or_name_match() {
        for tool in [
            tool("function", false),
            tool("function", true),
            tool("extension", false),
        ] {
            assert!(!runtime_skill(&tool));
            assert!(matches(&tool, &json!({"id":"call-1"})));
            assert!(matches(&tool, &json!({"name":"Skill"})));
            assert!(!matches(&tool, &json!({"id":"other","name":"other"})));
            assert!(!matches(&tool, &json!({})));
        }
    }
}
