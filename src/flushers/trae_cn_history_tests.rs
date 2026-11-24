use super::*;
use crate::flushers::event_log_converter::GenAiEventLogConverter;

fn row(id: &str, event: &str, at: i64, fields: Value) -> AgentActivityEntry {
    let mut row = json!({
        "event.id":id,"event.name":event,"time_unix_nano":at.to_string(),
        "trace_id":"88888888888888888888888888888888",
        "user.id":"fixture-user","gen_ai.session.id":"fixture-session","gen_ai.turn.id":"fixture-turn",
        "gen_ai.step.id":"fixture-step","gen_ai.agent.type":"trae-cn","gen_ai.agent.name":"trae-cn",
        "gen_ai.provider.name":"fixture-provider","gen_ai.request.model":"fixture-model",
        "gen_ai.response.id":"fixture-response",
    });
    row.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    serde_json::from_value(row).unwrap()
}

#[test]
fn verified_trae_streams_reparent_tools_and_keep_terminal_text_on_its_round() {
    let at = 1_795_535_992_000_000_000;
    let tool = json!({"gen_ai.tool.call.id":"tool-fixture","gen_ai.tool.name":"Read"});
    let first = "333333333333333333333333";
    let terminal = "444444444444444444444444";
    let rows = [
        row(
            "request",
            "llm.request",
            at,
            json!({
                "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"fixture prompt"}]}],
            }),
        ),
        row("call", "tool.call", at + 10_000_000, tool.clone()),
        row(
            "result",
            "tool.result",
            at + 20_000_000,
            json!({
                "gen_ai.tool.call.id":"tool-fixture","gen_ai.tool.name":"Read","gen_ai.tool.call.result":"fixture bytes",
            }),
        ),
        row(
            "response",
            "llm.response",
            at + 30_000_000,
            json!({
                "gen_ai.response.finish_reasons":["stop"],
                "gen_ai.output.messages":[
                    {"role":"assistant","parts":[{"type":"tool_call","name":"Read","id":"tool-fixture"}]},
                    {"role":"assistant","parts":[{"type":"text","content":"fixture terminal response"}]}
                ],
                (HISTORY):[
                    {"id":first,"at":(at+5_000_000).to_string(),"request":"request-one","initial":true,
                        "toolIds":["tool-fixture"],"input":12,"output":3},
                    {"id":terminal,"at":(at+30_000_000).to_string(),"request":"request-two","terminal":true,
                        "continuation":"request-one","input":31,"output":16}
                ],
            }),
        ),
    ];
    let result = convert(
        &rows,
        &ConvertOptions {
            strict: false,
            passthrough_keys: Vec::new(),
        },
        &GenAiEventLogConverter,
    )
    .unwrap();
    let llms: Vec<_> = result.spans.iter().filter(|s| kind(s, "LLM")).collect();
    assert_eq!(llms.len(), 2, "{:#?}", result.spans);
    let find = |id| {
        llms.iter()
            .find(|span| span.attributes.get("gen_ai.response.id") == Some(&json!(id)))
            .unwrap()
    };
    let first_span = find(first);
    let tool = result.spans.iter().find(|span| kind(span, "TOOL")).unwrap();
    assert_eq!(tool.parent_span_id, first_span.parent_span_id);
    let continuation = find(terminal);
    let input = decode_messages(continuation.attributes.get("gen_ai.input.messages"));
    assert_eq!(input[0]["parts"][0]["id"], "tool-fixture");
    let answer = decode_messages(continuation.attributes.get("gen_ai.output.messages"));
    assert_eq!(
        answer[0]["parts"][0]["content"],
        "fixture terminal response"
    );
    assert_eq!(continuation.attributes["gen_ai.usage.total_tokens"], 47);
    for span in result
        .spans
        .iter()
        .filter(|span| span.parent_span_id.is_some())
    {
        let parent = result
            .spans
            .iter()
            .find(|p| Some(&p.span_id) == span.parent_span_id.as_ref())
            .unwrap();
        assert!(span.start_time >= parent.start_time && span.end_time <= parent.end_time);
    }
}
