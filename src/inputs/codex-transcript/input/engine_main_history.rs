use super::*;

fn work_turn(
    session: &str,
    turn: &str,
    prompt: &str,
    response: &str,
    input: u64,
    output: u64,
    at: &str,
) -> Vec<String> {
    let base = chrono::DateTime::parse_from_rfc3339(at).expect("time");
    simple_turn(turn, input, output, 0)
        .into_iter()
        .map(|line| {
            let mut r: Value = serde_json::from_str(&line).expect("turn fixture");
            let original =
                chrono::DateTime::parse_from_rfc3339(r["timestamp"].as_str().expect("timestamp"))
                    .expect("old time");
            let origin =
                chrono::DateTime::parse_from_rfc3339("2026-06-24T06:00:00Z").expect("origin");
            r["timestamp"] = json!((base + (original - origin)).to_rfc3339());
            let payload = &mut r["payload"];
            if payload["id"] == "session-1" {
                payload["id"] = json!(session);
            }
            if payload["role"] == "user" {
                payload["content"][0]["text"] = json!(prompt);
            }
            if payload["type"] == "agent_message" {
                payload["message"] = json!(response);
            }
            if payload["type"] == "task_complete" {
                payload["last_agent_message"] = json!(response);
            }
            r.to_string()
        })
        .collect()
}
#[tokio::test]
async fn failed_delegation_without_child_emits_exact_failure_result_once_for_native_and_json_errors(
) {
    for failure in [
        "collab spawn failed: agent thread limit reached".to_string(),
        json!({"status":"rejected","reason":"dispatch rejected"}).to_string(),
    ] {
        let f = Fixture::new();
        let mut lines = work_turn(
            "session-failed",
            "failed-turn",
            "delegate work",
            "dispatch failed",
            10,
            2,
            "2026-08-07T02:00:00Z",
        );
        lines.splice(4..4,[
          record("2026-08-07T02:00:04Z","response_item",json!({"type":"function_call","call_id":"failed-spawn","name":"spawn_agent","arguments":json!({"message":"child work"}).to_string()})),
          record("2026-08-07T02:00:04.500Z","response_item",json!({"type":"function_call_output","call_id":"failed-spawn","output":failure}))
        ]);
        let p = f
            .write("rollout-session-failed.jsonl", &(lines.join("\n") + "\n"))
            .await;
        f.process(&p).await;
        let entries = f.records();
        let invoke = events(&entries, "gen_ai.agent.invoke");
        let result = events(&entries, "gen_ai.agent.result");
        assert_eq!(invoke.len(), 1);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0]["gen_ai.agent.invocation.id"],
            invoke[0]["gen_ai.agent.invocation.id"]
        );
        assert_eq!(result[0]["error.type"], "codex.delegation_failed");
        assert!(result[0].get("gen_ai.agent.peer.id").is_none());
        assert!(result[0].get("tool.result.status").is_none());
        assert!(entries
            .iter()
            .all(|e| e.get("gen_ai.agent.parent.invocation.id").is_none()));
        f.process(&p).await;
        assert_eq!(events(&f.records(), "gen_ai.agent.result").len(), 1);
    }
}
#[tokio::test]
async fn pending_dispatch_intent_precedes_ack_and_parent_terminal_with_exact_work_messages_and_no_replay(
) {
    let f = Fixture::new();
    let lines = NATIVE_PARENT
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let acknowledgement = lines
        .iter()
        .position(|line| line.contains("function_call_output"))
        .expect("ack");
    let p = write_native_fixture(
        &f,
        NATIVE_PARENT_NAME,
        &(lines[..acknowledgement].join("\n") + "\n"),
    )
    .await;
    f.process(&p).await;
    let entries = f.records();
    let invokes = events(&entries, "gen_ai.agent.invoke");
    assert_eq!(invokes.len(), 4);
    assert_eq!(
        invokes
            .iter()
            .map(|e| e["gen_ai.agent.invocation.id"]
                .as_str()
                .expect("invocation"))
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        4
    );
    let records = lines
        .iter()
        .map(|line| serde_json::from_str::<Value>(line).expect("native"))
        .collect::<Vec<_>>();
    for invoke in &invokes {
        let call = records
            .iter()
            .find(|r| {
                r["payload"]["type"] == "function_call"
                    && r["payload"]["call_id"] == invoke["gen_ai.tool.call.id"]
            })
            .expect("source call");
        let args: Value =
            serde_json::from_str(call["payload"]["arguments"].as_str().expect("args"))
                .expect("arguments");
        assert_eq!(
            invoke["gen_ai.input.messages"],
            json!([{"role":"user","parts":[{"type":"text","content":args["message"]}]}])
        );
    }
    assert!(events(&entries, "gen_ai.agent.result").is_empty());
    f.append(&p, &(lines[acknowledgement..].join("\n") + "\n"))
        .await;
    f.process(&p).await;
    assert_eq!(
        events(&f.records(), "gen_ai.agent.invoke")
            .iter()
            .map(|e| e["event.id"].clone())
            .collect::<Vec<_>>(),
        invokes
            .iter()
            .map(|e| e["event.id"].clone())
            .collect::<Vec<_>>()
    );
    assert!(events(&f.records(), "gen_ai.agent.result").is_empty());
}
#[tokio::test]
async fn delegation_input_content_five_formats_preserves_whitespace_parts_and_separates_tool_arguments(
) {
    let cases = [
        (
            "spawn_agent",
            json!({"message":"  delegated task\nwith explicit context  "}),
            vec!["  delegated task\nwith explicit context  "],
        ),
        (
            "spawn_agent",
            json!({"prompt":"prompt work"}),
            vec!["prompt work"],
        ),
        (
            "spawn_agent",
            json!({"input":"input work"}),
            vec!["input work"],
        ),
        (
            "followup_task",
            json!({"target":"/root/child","message":"new work for reused child"}),
            vec!["new work for reused child"],
        ),
        (
            "send_input",
            json!({"id":"child","input":[{"type":"text","text":"first part"},{"type":"text","text":"second part"}]}),
            vec!["first part", "second part"],
        ),
    ];
    for (name, args, expected) in cases {
        let f = Fixture::new();
        let mut lines = work_turn(
            "invoke-parent",
            "invoke-turn",
            "parent context is not the task",
            "done",
            10,
            2,
            "2026-08-07T02:00:00Z",
        );
        lines.insert(4,record("2026-08-07T02:00:04Z","response_item",json!({"type":"function_call","call_id":"invoke-call","name":name,"arguments":args.to_string()})));
        let p = f
            .write("rollout-invoke-parent.jsonl", &(lines.join("\n") + "\n"))
            .await;
        f.process(&p).await;
        let entries = f.records();
        let invoke = events(&entries, "gen_ai.agent.invoke");
        assert_eq!(invoke.len(), 1, "{name}");
        assert_eq!(
            invoke[0]["gen_ai.input.messages"],
            json!([{"role":"user","parts":expected.iter().map(|content|json!({"type":"text","content":content})).collect::<Vec<_>>()}])
        );
        assert!(invoke[0].get("gen_ai.input.messages_delta").is_none());
        assert!(invoke[0].get("gen_ai.tool.call.arguments").is_none());
        assert_eq!(
            events(&entries, "tool.call")[0]["gen_ai.tool.call.arguments"],
            args
        );
        f.process(&p).await;
        assert_eq!(events(&f.records(), "gen_ai.agent.invoke"), invoke);
    }
}
#[tokio::test]
async fn both_batch_fields_keep_null_position_as_own_invocation_without_sibling_content_leak() {
    for field in ["agents", "tasks"] {
        let f = Fixture::new();
        let mut args = json!({"message":"batch envelope"});
        args[field] = json!([{"message":"first work"},null,{"prompt":"third work"}]);
        let mut lines = work_turn(
            "batch-parent",
            "batch-turn",
            "unrelated parent input",
            "done",
            10,
            2,
            "2026-08-07T02:00:00Z",
        );
        lines.insert(4,record("2026-08-07T02:00:04Z","response_item",json!({"type":"function_call","call_id":"batch-call","name":"spawn_agent","arguments":args.to_string()})));
        let p = f
            .write("rollout-batch-parent.jsonl", &(lines.join("\n") + "\n"))
            .await;
        f.process(&p).await;
        let entries = f.records();
        let invokes = events(&entries, "gen_ai.agent.invoke");
        assert_eq!(invokes.len(), 3, "{field}");
        assert_eq!(
            invokes
                .iter()
                .map(|e| e.get("gen_ai.input.messages").cloned())
                .collect::<Vec<_>>(),
            vec![
                Some(json!([{"role":"user","parts":[{"type":"text","content":"first work"}]}])),
                None,
                Some(json!([{"role":"user","parts":[{"type":"text","content":"third work"}]}]))
            ]
        );
        assert_eq!(
            invokes
                .iter()
                .map(|e| e["gen_ai.agent.invocation.id"].as_str().expect("id"))
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
        assert!(invokes
            .iter()
            .all(|e| e.get("gen_ai.tool.call.arguments").is_none()));
        assert_eq!(
            events(&entries, "tool.call")[0]["gen_ai.tool.call.arguments"],
            args
        );
    }
}
#[tokio::test]
async fn native_turn_end_identity_span_status_and_clock_are_equal_for_full_segmented_and_terminal_only_recovery(
) {
    for status in ["completed", "interrupted"] {
        let mut lines = completed().lines().map(str::to_string).collect::<Vec<_>>();
        let terminal_at = "2026-06-24T06:30:00.000Z";
        *lines.last_mut().expect("terminal") = record(
            terminal_at,
            "event_msg",
            if status == "completed" {
                json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"fixed"})
            } else {
                json!({"type":"turn_aborted","turn_id":"turn-1","reason":"user interruption"})
            },
        );
        let prefix = lines[..lines.len() - 1].join("\n") + "\n";
        let complete = lines.join("\n") + "\n";
        let mut markers: Vec<Value> = Vec::new();
        for mode in ["full", "segmented", "terminal-only"] {
            let f = Fixture::new();
            let p = f
                .write(
                    "rollout-session-1.jsonl",
                    if mode == "segmented" {
                        &prefix
                    } else {
                        &complete
                    },
                )
                .await;
            if mode == "terminal-only" {
                let (ino, _, _) = file_meta_snapshot(&p).await.expect("native snapshot");
                f.rt().state_store.update(&f.engine().state_key(&p),InputStatePatch{
                  extra:Some(json!({"codexTranscript":{
                    "inode":ino,"scanOffset":complete.len(),"ownerSessionMetaOffset":0,
                    "activeTurn":{"turnId":"turn-1","startOffset":prefix.len(),"startedAtMs":1_782_280_802_000.0,"emittedPrompt":true,"emittedStepCount":3,"emittedTraceId":markers[0]["trace_id"],"model":"gpt-5.5","cwd":"/tmp/project"},
                    "pendingTerminal":{"turnId":"turn-1","terminalEndOffset":complete.len()},"pendingFusion":null,"pendingSubagent":null
                  }})),..Default::default()
                });
            }
            f.process(&p).await;
            if mode == "segmented" {
                assert!(f.records().iter().all(|e| e["gen_ai.turn.end"] != true));
                f.append(&p, &(lines.last().expect("terminal").clone() + "\n"))
                    .await;
                f.process(&p).await;
            }
            let marker = f
                .records()
                .into_iter()
                .filter(|e| e["gen_ai.turn.end"] == true)
                .collect::<Vec<_>>();
            assert_eq!(marker.len(), 1, "{status}/{mode}");
            assert_eq!(timestamp(&marker[0]), 1_782_282_600_000, "{status}/{mode}");
            assert_eq!(marker[0]["agent.codex.turn_status"], status);
            markers.push(marker[0].clone());
        }
        for key in ["event.id", "span_id", "gen_ai.turn.id"] {
            assert_eq!(
                markers
                    .iter()
                    .map(|m| m[key].as_str().expect("marker identity"))
                    .collect::<std::collections::BTreeSet<_>>()
                    .len(),
                1,
                "{status}/{key}"
            );
        }
        let span = markers[0]["span_id"].as_str().expect("span");
        assert_eq!(span.len(), 16);
        assert!(span
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(markers
            .iter()
            .all(|m| m["gen_ai.turn.id"] == "session-1:turn-1"));
    }
}

#[tokio::test]
async fn ordinary_native_turn_does_not_enter_relationship_snapshot_or_parent_delegation_lookup() {
    let f = Fixture::new();
    assert_eq!(
        f.input
            .inner
            .body
            .with_shared(|shared| shared.linker.test_query_counts()),
        (0, 0)
    );
    let p = f
        .write("rollout-ordinary-no-links.jsonl", &completed())
        .await;
    f.process(&p).await;
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 3);
    assert_eq!(
        f.input
            .inner
            .body
            .with_shared(|shared| shared.linker.test_query_counts()),
        (0, 0),
        "counts increment at actual production method entry, before map filtering or empty results"
    );
}

fn timeline(base: &str, seconds: f64) -> String {
    (chrono::DateTime::parse_from_rfc3339(base).expect("base")
        + chrono::Duration::milliseconds((seconds * 1000.0).round() as i64))
    .to_rfc3339()
}
fn child_meta(
    child: &str,
    parent: &str,
    depth: i64,
    path: Option<&str>,
    nickname: Option<&str>,
    at: &str,
) -> String {
    let mut spawn = json!({"parent_thread_id":parent,"depth":depth});
    if let Some(path) = path {
        spawn["agent_path"] = json!(path);
    }
    if let Some(nick) = nickname {
        spawn["agent_nickname"] = json!(nick);
    }
    record(
        at,
        "session_meta",
        json!({"id":child,"session_id":parent,"thread_source":"subagent","model_provider":"openai","source":{"subagent":{"thread_spawn":spawn}}}),
    )
}
#[tokio::test]
async fn known_path_only_followup_fills_peer_and_nickname_without_replaying_unknown_creation_across_restart(
) {
    for restart in [false, true] {
        let f = Fixture::new();
        let dispatch = |turn: &str, name: &str, call: &str, message: &str, start: &str| {
            let mut lines = work_turn(
                "peer-parent",
                turn,
                "delegate work",
                "accepted",
                10,
                2,
                start,
            );
            let args = if name == "spawn_agent" {
                json!({"task_name":"known-child","message":message})
            } else {
                json!({"target":"/root/known-child","message":message})
            };
            lines.splice(4..4,[
             record(&timeline(start,3.1),"response_item",json!({"type":"function_call","call_id":call,"name":name,"arguments":args.to_string()})),
             record(&timeline(start,3.2),"response_item",json!({"type":"function_call_output","call_id":call,"output":json!({"task_name":"/root/known-child","accepted":true}).to_string()}))
            ]);
            lines
        };
        let p = f
            .write(
                "rollout-peer-parent.jsonl",
                &(dispatch(
                    "first-parent",
                    "spawn_agent",
                    "create-child",
                    "first work",
                    "2026-08-07T03:10:00Z",
                )
                .join("\n")
                    + "\n"),
            )
            .await;
        f.process(&p).await;
        let creation = events(&f.records(), "gen_ai.agent.invoke")[0].clone();
        assert!(
            creation.get("gen_ai.agent.peer.id").is_none()
                && creation.get("gen_ai.agent.peer.name").is_none()
        );
        let mut child = work_turn(
            "peer-child",
            "first-child",
            "first work",
            "done",
            20,
            3,
            "2026-08-07T03:10:10Z",
        );
        child[0] = child_meta(
            "peer-child",
            "peer-parent",
            1,
            Some("/root/known-child"),
            Some("Newton"),
            "2026-08-07T03:10:09Z",
        );
        let cp =
            write_native_fixture(&f, "rollout-peer-child.jsonl", &(child.join("\n") + "\n")).await;
        f.process(&cp).await;
        assert_eq!(
            responses_for(&f.records(), "first-child")[0]["gen_ai.agent.parent.invocation.id"],
            creation["gen_ai.agent.invocation.id"]
        );
        f.rt().state_store.save().await.expect("save");
        let recovered;
        let active = if restart {
            recovered = f.restart().await;
            start_until_first_native_cycle(&recovered).await;
            &recovered
        } else {
            &f
        };
        active
            .append(
                &p,
                &(dispatch(
                    "second-parent",
                    "followup_task",
                    "reuse-child",
                    "second work",
                    "2026-08-07T03:11:00Z",
                )
                .into_iter()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
                    + "\n"),
            )
            .await;
        active.process(&p).await;
        let mut entries = f.records();
        if restart {
            entries.extend(active.records());
        }
        let invokes = events(&entries, "gen_ai.agent.invoke");
        assert_eq!(invokes.len(), 2);
        let reused = invokes
            .iter()
            .find(|e| e["gen_ai.tool.call.id"] == "reuse-child")
            .expect("followup");
        assert_eq!(
            reused["gen_ai.agent.peer.id"], "peer-child",
            "restart={restart}"
        );
        assert_eq!(reused["gen_ai.agent.peer.name"], "Newton");
        assert!(invokes
            .iter()
            .find(|e| e["gen_ai.tool.call.id"] == "create-child")
            .expect("creation")
            .get("gen_ai.agent.peer.id")
            .is_none());
        let count = active.records().len();
        active.process(&p).await;
        assert_eq!(active.records().len(), count);
    }
}
#[tokio::test]
async fn null_only_completion_keeps_delivery_unclaimed_until_real_empty_or_nonempty_body_for_both_formats(
) {
    for format in ["status", "results"] {
        for body in ["", "actual result"] {
            let f = Fixture::new();
            let child = "null-result-child";
            let start = "2026-08-07T03:25:00Z";
            let at = |seconds| timeline(start, seconds);
            let status = |value: Value| {
                if format == "status" {
                    json!({"status":{child:{"completed":value}}})
                } else {
                    json!({"results":[{"agent_id":child,"status":"completed","output":value}]})
                }
            };
            let mut lines = work_turn(
                "null-result-parent",
                "parent-turn",
                "delegate",
                "accepted",
                10,
                2,
                start,
            );
            lines.splice(4..4,[
              record(&at(3.1),"response_item",json!({"type":"function_call","call_id":"null-spawn","name":"spawn_agent","arguments":json!({"task_name":"child","message":"work"}).to_string()})),
              record(&at(3.2),"response_item",json!({"type":"function_call_output","call_id":"null-spawn","output":json!({"agent_id":child}).to_string()})),
              record(&at(3.3),"response_item",json!({"type":"function_call","call_id":"empty-wait","name":"wait_agent","arguments":"{}"})),
              record(&at(3.4),"response_item",json!({"type":"function_call_output","call_id":"empty-wait","output":status(Value::Null).to_string()}))
            ]);
            let p = f
                .write(
                    "rollout-null-result-parent.jsonl",
                    &(lines.join("\n") + "\n"),
                )
                .await;
            f.process(&p).await;
            assert!(events(&f.records(), "gen_ai.agent.result").is_empty());
            let invocation = events(&f.records(), "gen_ai.agent.invoke")[0]
                ["gen_ai.agent.invocation.id"]
                .clone();
            let delivered = f
                .rt()
                .state_store
                .get("codex-transcript")
                .extra()
                .and_then(|v| v.get("codexResultInvocations").cloned())
                .unwrap_or(json!([]));
            assert!(!delivered
                .as_array()
                .expect("delivered array")
                .contains(&invocation));
            assert!(f.checkpoint(&p).active_turn.is_none());
            let mut receipt = work_turn(
                "null-result-parent",
                "receipt-turn",
                "collect",
                "received",
                20,
                3,
                &at(10.0),
            )
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>();
            receipt.splice(3..3,[
              record(&at(13.1),"response_item",json!({"type":"function_call","call_id":"actual-wait","name":"wait_agent","arguments":"{}"})),
              record(&at(13.2),"response_item",json!({"type":"function_call_output","call_id":"actual-wait","output":status(json!(body)).to_string()})),
              record(&at(13.3),"response_item",json!({"type":"agent_message","author":child,"recipient":"/root","content":[{"type":"input_text","text":format!("Message Type: FINAL_ANSWER\n{body}")}],"internal_chat_message_metadata_passthrough":{"turn_id":"receipt-turn","tool_call_id":"null-spawn"}}))
            ]);
            f.append(&p, &(receipt.join("\n") + "\n")).await;
            f.process(&p).await;
            let result = events(&f.records(), "gen_ai.agent.result");
            assert_eq!(result.len(), 1, "{format}/{body}");
            assert_eq!(result[0]["gen_ai.agent.invocation.id"], invocation);
            assert_eq!(
                result[0]["gen_ai.output.messages"],
                json!([{"role":"assistant","parts":[{"type":"text","content":body}]}])
            );
            assert!(f.checkpoint(&p).active_turn.is_none());
            f.process(&p).await;
            assert_eq!(events(&f.records(), "gen_ai.agent.result").len(), 1);
        }
    }
}
#[tokio::test]
async fn running_child_restores_delegation_after_finished_parent_and_waits_for_actual_child_terminal(
) {
    let f = Fixture::new();
    let pp = write_native_fixture(&f, NATIVE_PARENT_NAME, NATIVE_PARENT).await;
    f.process(&pp).await;
    let child = NATIVE_CHILDREN[0];
    let mut lines = child.3.lines().map(str::to_string).collect::<Vec<_>>();
    let terminal = lines.pop().expect("child terminal");
    let cp = write_native_fixture(&f, child.0, &(lines.join("\n") + "\n")).await;
    f.process(&cp).await;
    let invoke = events(&f.records(), "gen_ai.agent.invoke")
        .into_iter()
        .find(|e| e["gen_ai.tool.call.id"] == "call-subagent-1")
        .expect("invoke");
    assert!(responses_for(&f.records(), child.2).is_empty());
    let next = f.restart().await;
    next.input.start().await.expect("actual startup restore");
    next.process(&cp).await;
    assert!(responses_for(&next.records(), child.2).is_empty());
    next.append(&cp, &(terminal + "\n")).await;
    next.input.run_cycle().await;
    next.input.stop().await.expect("bounded stop");
    assert!(responses_for(&next.records(), "parent-turn-1").is_empty());
    let responses = responses_for(&next.records(), child.2);
    assert_eq!(responses.len(), 1);
    for (key, expected) in [
        ("gen_ai.session.id", json!(child.1)),
        ("gen_ai.turn.id", json!(format!("{}:{}", child.1, child.2))),
        (
            "gen_ai.agent.parent.invocation.id",
            invoke["gen_ai.agent.invocation.id"].clone(),
        ),
        ("agent.codex.parent_span_id", invoke["span_id"].clone()),
        ("trace_id", invoke["trace_id"].clone()),
    ] {
        assert_eq!(responses[0][key], expected, "{key}");
    }
    let checkpoint = next.checkpoint(&cp);
    assert!(checkpoint.pending_subagent.is_none() && checkpoint.active_turn.is_none());
}

fn active_delegation(f: &Fixture, path: &str) -> Option<String> {
    f.checkpoint(path)
        .active_turn
        .expect("active work")
        .delegation
        .and_then(|link| link.invocation_id)
}
#[tokio::test]
async fn uncommitted_work_reread_sixteen_cases_retains_or_unbinds_only_real_new_input_and_rebinds_followup(
) {
    for restart in [false, true] {
        for format in ["canonical", "legacy"] {
            for incoming in ["none", "user", "agent", "result"] {
                let f = Fixture::new();
                let base = "2026-08-07T03:20:00Z";
                let at = |seconds| timeline(base, seconds);
                let parent = "uncommitted-parent";
                let child = "uncommitted-child";
                let mut parent_lines =
                    work_turn(parent, "parent-turn", "delegate", "accepted", 10, 2, base);
                parent_lines.splice(4..4,[
                 record(&at(3.1),"response_item",json!({"type":"function_call","call_id":"initial-spawn","name":"spawn_agent","arguments":json!({"task_name":"child","message":"initial delegated work"}).to_string()})),
                 record(&at(3.2),"response_item",json!({"type":"function_call_output","call_id":"initial-spawn","output":json!({"agent_id":child}).to_string()})),
                 record(&at(3.3),"response_item",json!({"type":"function_call","call_id":"queued-followup","name":"followup_task","arguments":json!({"id":child,"message":"replacement work"}).to_string()})),
                 record(&at(3.4),"response_item",json!({"type":"function_call_output","call_id":"queued-followup","output":json!({"agent_id":child}).to_string()}))
                ]);
                let pp = f
                    .write(
                        "rollout-uncommitted-parent.jsonl",
                        &(parent_lines.join("\n") + "\n"),
                    )
                    .await;
                f.process(&pp).await;
                let invocation = events(&f.records(), "gen_ai.agent.invoke")[0]
                    ["gen_ai.agent.invocation.id"]
                    .as_str()
                    .expect("invocation")
                    .to_string();
                let mut child_lines = work_turn(
                    child,
                    "child-turn",
                    "initial delegated work",
                    "child done",
                    20,
                    3,
                    &at(10.0),
                );
                child_lines[0] = child_meta(child, parent, 1, Some("/root/child"), None, &at(10.0));
                if format == "legacy" {
                    child_lines[3] = record(
                        &at(13.0),
                        "event_msg",
                        json!({"type":"user_message","message":"initial delegated work"}),
                    );
                }
                let cp = write_native_fixture(
                    &f,
                    "rollout-uncommitted-child.jsonl",
                    &(child_lines[..4].join("\n") + "\n"),
                )
                .await;
                f.process(&cp).await;
                assert_eq!(
                    f.checkpoint(&cp)
                        .active_turn
                        .expect("open")
                        .emitted_step_count,
                    0
                );
                assert_eq!(
                    active_delegation(&f, &cp).as_deref(),
                    Some(invocation.as_str()),
                    "first {restart}/{format}/{incoming}"
                );
                f.append(&cp,&(record(&at(13.1),"response_item",json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"additional runtime context"}]}))+"\n")).await;
                f.process(&cp).await;
                assert_eq!(
                    f.checkpoint(&cp)
                        .active_turn
                        .expect("open")
                        .emitted_step_count,
                    0
                );
                assert_eq!(
                    active_delegation(&f, &cp).as_deref(),
                    Some(invocation.as_str())
                );
                f.rt().state_store.save().await.expect("durable save");
                let recovered;
                let active0 = if restart {
                    recovered = f.restart().await;
                    start_until_first_native_cycle(&recovered).await;
                    &recovered
                } else {
                    &f
                };
                if format == "canonical" {
                    active0
                        .append(
                            &cp,
                            &(record(
                                &at(13.15),
                                "event_msg",
                                json!({"type":"user_message","message":"initial delegated work"}),
                            ) + "\n"),
                        )
                        .await;
                    active0.process(&cp).await;
                    assert_eq!(
                        active_delegation(active0, &cp).as_deref(),
                        Some(invocation.as_str()),
                        "canonical separately emitted legacy mirror"
                    );
                }
                if incoming != "none" {
                    let payload = if incoming == "user" {
                        if format == "canonical" {
                            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"initial delegated work"}]})
                        } else {
                            json!({"type":"user_message","message":"initial delegated work"})
                        }
                    } else {
                        json!({"type":"agent_message","author":if incoming=="result" {"/root/child/leaf"} else {"/root"},"recipient":"/root/child","content":[{"type":"input_text","text":if incoming=="result" {"Message Type: FINAL_ANSWER\nleaf done"} else {"Message Type: NEW_TASK\nnew unobserved work"}}],"internal_chat_message_metadata_passthrough":{"turn_id":"child-turn"}})
                    };
                    active0
                        .append(
                            &cp,
                            &(record(
                                &at(13.2),
                                if incoming == "user" && format == "legacy" {
                                    "event_msg"
                                } else {
                                    "response_item"
                                },
                                payload,
                            ) + "\n"),
                        )
                        .await;
                    active0.process(&cp).await;
                }
                let wave = |tool: &str, start: f64, input: u64, output: u64| {
                    [
                    record(&at(start),"response_item",json!({"type":"function_call","call_id":tool,"name":"exec_command","arguments":"{}"})),
                    record(&at(start+0.1),"response_item",json!({"type":"function_call_output","call_id":tool,"output":"ok"})),
                    record(&at(start+0.2),"event_msg",usage(input,output))
                ].join("\n")+"\n"
                };
                active0.append(&cp, &wave("work-tool", 14.0, 20, 3)).await;
                active0.process(&cp).await;
                assert_eq!(
                    active0
                        .checkpoint(&cp)
                        .active_turn
                        .expect("open")
                        .emitted_step_count,
                    1
                );
                let earlier = responses_for(&active0.records(), "child-turn");
                let recovered2;
                let active = if restart {
                    recovered2 = active0.restart().await;
                    start_until_first_native_cycle(&recovered2).await;
                    &recovered2
                } else {
                    active0
                };
                active.append(&cp, &wave("second-tool", 15.0, 30, 4)).await;
                active.process(&cp).await;
                let mut responses = if restart { earlier } else { Vec::new() };
                responses.extend(responses_for(&active.records(), "child-turn"));
                assert_eq!(responses.len(), 2, "{restart}/{format}/{incoming}");
                for response in responses {
                    let expected = if ["user", "agent"].contains(&incoming) {
                        None
                    } else {
                        Some(json!(invocation))
                    };
                    assert_eq!(
                        response.get("gen_ai.agent.parent.invocation.id").cloned(),
                        expected,
                        "{restart}/{format}/{incoming}"
                    );
                }
                let followup = events(&f.records(), "gen_ai.agent.invoke")
                    .into_iter()
                    .find(|e| e["gen_ai.tool.call.id"] == "queued-followup")
                    .expect("followup")["gen_ai.agent.invocation.id"]
                    .clone();
                active.append(&cp,&([
                    record(&at(16.0),"response_item",json!({"type":"agent_message","author":"/root","recipient":"/root/child","content":[{"type":"input_text","text":"replacement work"}],"internal_chat_message_metadata_passthrough":{"turn_id":"child-turn"}})),
                    record(&at(17.0),"event_msg",json!({"type":"agent_message","message":"replacement done","phase":"final"})),
                    record(&at(17.1),"event_msg",usage(40,5)),
                    record(&at(18.0),"event_msg",json!({"type":"task_complete","turn_id":"child-turn","last_agent_message":"replacement done"}))
                ].join("\n")+"\n")).await;
                active.process(&cp).await;
                assert_eq!(
                    responses_for(&active.records(), "child-turn")
                        .last()
                        .expect("final response")["gen_ai.agent.parent.invocation.id"],
                    followup,
                    "{restart}/{format}/{incoming}"
                );
                assert!(active.checkpoint(&cp).active_turn.is_none());
            }
        }
    }
}
#[tokio::test]
async fn streamed_nested_final_answer_preserves_coordinator_incoming_invocation_and_one_native_start_after_restart(
) {
    for restart in [false, true] {
        let f = Fixture::new();
        let parent = "streamed-parent";
        let child = "streamed-coordinator";
        let base = "2026-08-07T03:30:00Z";
        let at = |s| timeline(base, s);
        let mut parent_lines =
            work_turn(parent, "parent-turn", "delegate", "accepted", 10, 2, base);
        parent_lines.splice(4..4,[
         record(&at(3.1),"response_item",json!({"type":"function_call","call_id":"coordinator-spawn","name":"spawn_agent","arguments":json!({"task_name":"coordinator","message":"opaque-coordinator-work"}).to_string()})),
         record(&at(3.2),"response_item",json!({"type":"function_call_output","call_id":"coordinator-spawn","output":json!({"agent_id":child}).to_string()}))
        ]);
        let pp = f
            .write(
                "rollout-streamed-parent.jsonl",
                &(parent_lines.join("\n") + "\n"),
            )
            .await;
        f.process(&pp).await;
        let invocation = events(&f.records(), "gen_ai.agent.invoke")[0].clone();
        let lines = [
            child_meta(child, parent, 1, Some("/root/coordinator"), None, &at(6.0)),
            record(
                &at(7.0),
                "event_msg",
                json!({"type":"task_started","turn_id":"coordinator-turn"}),
            ),
            record(
                &at(7.1),
                "turn_context",
                json!({"turn_id":"coordinator-turn","model":"gpt-test"}),
            ),
            record(
                &at(7.2),
                "response_item",
                json!({"type":"agent_message","author":"/root","recipient":"/root/coordinator","content":[{"type":"input_text","text":"Message Type: NEW_TASK"},{"type":"encrypted_content","encrypted_content":"opaque-coordinator-work"}],"internal_chat_message_metadata_passthrough":{"turn_id":"coordinator-turn"}}),
            ),
            record(
                &at(8.0),
                "response_item",
                json!({"type":"function_call","call_id":"leaf-spawn","name":"spawn_agent","arguments":json!({"task_name":"leaf","message":"opaque-leaf-work"}).to_string()}),
            ),
            record(
                &at(9.0),
                "response_item",
                json!({"type":"function_call_output","call_id":"leaf-spawn","output":json!({"agent_id":"streamed-leaf"}).to_string()}),
            ),
            record(&at(9.1), "event_msg", usage(20, 3)),
        ];
        let cp = write_native_fixture(
            &f,
            "rollout-streamed-coordinator.jsonl",
            &(lines.join("\n") + "\n"),
        )
        .await;
        f.process(&cp).await;
        assert_eq!(responses_for(&f.records(), "coordinator-turn").len(), 1);
        assert_eq!(
            f.checkpoint(&cp)
                .active_turn
                .expect("active")
                .emitted_step_count,
            1
        );
        let recovered;
        let active = if restart {
            recovered = f.restart().await;
            start_until_first_native_cycle(&recovered).await;
            &recovered
        } else {
            &f
        };
        active.append(&cp,&([
          record(&at(10.0),"response_item",json!({"type":"agent_message","author":"/root/coordinator/leaf","recipient":"/root/coordinator","content":[{"type":"input_text","text":"Message Type: FINAL_ANSWER\nTask name: /root/coordinator/leaf\nPayload:\nleaf done"},{"type":"encrypted_content","encrypted_content":"opaque-leaf-result"}],"internal_chat_message_metadata_passthrough":{"turn_id":"coordinator-turn"}})),
          record(&at(11.0),"event_msg",json!({"type":"agent_message","message":"coordinator done","phase":"final"})),
          record(&at(11.1),"event_msg",usage(30,4)),
          record(&at(12.0),"event_msg",json!({"type":"task_complete","turn_id":"coordinator-turn","last_agent_message":"coordinator done"}))
        ].join("\n")+"\n")).await;
        active.process(&cp).await;
        let mut entries = f.records();
        if restart {
            entries.extend(active.records());
        }
        assert_eq!(responses_for(&entries, "coordinator-turn").len(), 2);
        let child_entries = entries
            .iter()
            .filter(|e| e["gen_ai.session.id"] == child)
            .collect::<Vec<_>>();
        for entry in &child_entries {
            assert_eq!(
                entry["gen_ai.agent.parent.invocation.id"],
                invocation["gen_ai.agent.invocation.id"]
            );
            assert_eq!(entry["agent.codex.parent_span_id"], invocation["span_id"]);
            assert_eq!(entry["trace_id"], invocation["trace_id"]);
        }
        let nested = child_entries
            .iter()
            .find(|e| e["event.name"] == "gen_ai.agent.invoke")
            .expect("nested invoke");
        assert_ne!(
            nested["gen_ai.agent.invocation.id"],
            invocation["gen_ai.agent.invocation.id"]
        );
        assert!(child_entries.iter().any(|e| e["gen_ai.turn.end"] == true));
        let starts = child_entries
            .iter()
            .filter(|e| e["gen_ai.turn.start"] == true)
            .collect::<Vec<_>>();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["event.name"], "other");
        assert_eq!(
            timestamp(starts[0]),
            chrono::DateTime::parse_from_rfc3339(base)
                .expect("base")
                .timestamp_millis() as u64
                + 7_000
        );
        assert!(child_entries
            .iter()
            .filter(|e| e["event.name"] != "other")
            .all(|e| e.get("gen_ai.turn.start").is_none()));
        let before = active.records().len();
        active.process(&cp).await;
        assert_eq!(active.records().len(), before);
    }
}

async fn real_collect_cycle(f: &Fixture) {
    use crate::inputs::base::InputBody;
    f.input
        .inner
        .body
        .collect(f.rt())
        .await
        .expect("actual native collect and pending receipt replay");
}
fn pending_receipts(f: &Fixture) -> Vec<Value> {
    f.rt()
        .state_store
        .get("codex-transcript")
        .extra()
        .and_then(|v| {
            v.get("codexPendingAgentResults")
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default()
}
#[tokio::test]
async fn parent_first_pending_receipt_replays_from_body_free_range_after_interrupted_child_reuse_and_restart(
) {
    for restart in [false, true] {
        let f = Fixture::new();
        let parent = "late-result-parent";
        let child = "late-result-child";
        let base = "2026-08-07T04:00:00Z";
        let at = |s| timeline(base, s);
        let actual = "actual completed second work";
        let lines = [
            record(
                &at(0.0),
                "session_meta",
                json!({"id":parent,"thread_source":"user","model_provider":"openai"}),
            ),
            record(
                &at(1.0),
                "turn_context",
                json!({"turn_id":"parent-work","model":"gpt-test"}),
            ),
            record(
                &at(2.0),
                "event_msg",
                json!({"type":"task_started","turn_id":"parent-work"}),
            ),
            record(
                &at(3.0),
                "response_item",
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"delegate twice"}]}),
            ),
            record(
                &at(4.0),
                "response_item",
                json!({"type":"function_call","call_id":"first-spawn","name":"spawn_agent","arguments":json!({"task_name":"late-child","message":"opaque-first"}).to_string()}),
            ),
            record(
                &at(5.0),
                "response_item",
                json!({"type":"function_call_output","call_id":"first-spawn","output":json!({"agent_id":child}).to_string()}),
            ),
            record(
                &at(10.0),
                "response_item",
                json!({"type":"function_call","call_id":"second-work","name":"followup_task","arguments":json!({"target":"/root/late-child","message":"opaque-second"}).to_string()}),
            ),
            record(
                &at(11.0),
                "response_item",
                json!({"type":"function_call_output","call_id":"second-work","output":json!({"agent_id":child}).to_string()}),
            ),
            record(
                &at(18.0),
                "response_item",
                json!({"type":"agent_message","author":"/root/late-child","recipient":"/root","content":[{"type":"input_text","text":format!("Message Type: FINAL_ANSWER\nTask name: /root/late-child\nSender: /root/late-child\nPayload:\n{actual}")}],"internal_chat_message_metadata_passthrough":{"turn_id":"parent-work"}}),
            ),
            record(&at(19.0), "event_msg", usage(10, 2)),
            record(
                &at(20.0),
                "event_msg",
                json!({"type":"task_complete","turn_id":"parent-work","last_agent_message":"received"}),
            ),
        ];
        let pp = f
            .write(
                "rollout-late-result-parent.jsonl",
                &(lines.join("\n") + "\n"),
            )
            .await;
        f.process(&pp).await;
        assert_eq!(events(&f.records(), "gen_ai.agent.invoke").len(), 2);
        assert!(events(&f.records(), "gen_ai.agent.result").is_empty());
        assert_eq!(pending_receipts(&f).len(), 1);
        assert!(!serde_json::to_string(&pending_receipts(&f))
            .expect("pending")
            .contains(actual));
        f.rt().state_store.save().await.expect("save");
        let recovered;
        let active = if restart {
            recovered = f.restart().await;
            start_until_first_native_cycle(&recovered).await;
            &recovered
        } else {
            &f
        };
        let incoming = |turn: &str, text: &str, sec| {
            record(
                &at(sec),
                "response_item",
                json!({"type":"agent_message","author":"/root","recipient":"/root/late-child","content":[{"type":"input_text","text":"Message Type: NEW_TASK"},{"type":"encrypted_content","encrypted_content":text}],"internal_chat_message_metadata_passthrough":{"turn_id":turn}}),
            )
        };
        let child_records = [
            child_meta(child, parent, 1, Some("/root/late-child"), None, &at(4.5)),
            record(
                &at(5.5),
                "turn_context",
                json!({"turn_id":"child-first","model":"gpt-test"}),
            ),
            record(
                &at(5.6),
                "event_msg",
                json!({"type":"task_started","turn_id":"child-first"}),
            ),
            incoming("child-first", "opaque-first", 5.7),
            record(
                &at(6.0),
                "response_item",
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial first"}]}),
            ),
            record(
                &at(8.0),
                "event_msg",
                json!({"type":"turn_aborted","turn_id":"child-first","reason":"interrupted"}),
            ),
            record(
                &at(11.5),
                "turn_context",
                json!({"turn_id":"child-second","model":"gpt-test"}),
            ),
            record(
                &at(11.6),
                "event_msg",
                json!({"type":"task_started","turn_id":"child-second"}),
            ),
            incoming("child-second", "opaque-second", 11.7),
            record(
                &at(15.0),
                "response_item",
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":actual}]}),
            ),
            record(&at(16.0), "event_msg", usage(20, 3)),
            record(
                &at(17.0),
                "event_msg",
                json!({"type":"task_complete","turn_id":"child-second","last_agent_message":actual}),
            ),
        ];
        let cp = active
            .write(
                "rollout-late-result-child.jsonl",
                &(child_records.join("\n") + "\n"),
            )
            .await;
        active.marker("wakeups",&format!("{child}.json"),json!({"session_id":child,"initial_turn_id":"child-first","turn_id":"child-second","transcript_path":cp,"hook_event":"subagent-stop","received_at":chrono::Utc::now().to_rfc3339()})).await;
        real_collect_cycle(active).await;
        let mut entries = f.records();
        if restart {
            entries.extend(active.records());
        }
        let invokes = events(&entries, "gen_ai.agent.invoke");
        let result = events(&entries, "gen_ai.agent.result");
        assert_eq!(result.len(), 1, "restart={restart}");
        let second = invokes
            .iter()
            .find(|e| e["gen_ai.tool.call.id"] == "second-work")
            .expect("second work");
        assert_eq!(result[0]["gen_ai.session.id"], parent);
        assert_eq!(result[0]["gen_ai.turn.id"], format!("{parent}:parent-work"));
        assert_eq!(
            result[0]["gen_ai.agent.invocation.id"],
            second["gen_ai.agent.invocation.id"]
        );
        assert_eq!(result[0]["gen_ai.agent.peer.id"], child);
        assert_eq!(
            timestamp(&result[0]),
            chrono::DateTime::parse_from_rfc3339(&at(18.0))
                .expect("time")
                .timestamp_millis() as u64
        );
        assert!(result[0].get("span_id").is_none());
        assert!(pending_receipts(active).is_empty());
        assert_eq!(
            responses_for(&entries, "child-first")[0]["gen_ai.agent.parent.invocation.id"],
            invokes
                .iter()
                .find(|e| e["gen_ai.tool.call.id"] == "first-spawn")
                .expect("first")["gen_ai.agent.invocation.id"]
        );
        let before = active.records().len();
        real_collect_cycle(active).await;
        assert_eq!(active.records().len(), before);
    }
}
fn register_source_terminal(
    f: &Fixture,
    work: &CodexSpawnDescriptor,
    turn_id: &str,
    with_body: bool,
) {
    use crate::inputs::codex_transcript::subagent_linker::CodexSubagentLink;
    let mut value = serde_json::to_value(work).expect("work");
    value["confidence"] = json!("explicit_id");
    let link: CodexSubagentLink = serde_json::from_value(value).expect("source binding");
    let child = work.child_thread_id.as_deref().expect("child");
    let mut maps = work_turn(
        child,
        turn_id,
        "work",
        "done",
        10,
        1,
        "2026-08-07T05:00:00Z",
    )
    .iter()
    .map(|line| {
        serde_json::from_str::<Value>(line)
            .expect("source")
            .as_object()
            .expect("record")
            .clone()
    })
    .collect::<Vec<_>>();
    if !with_body {
        maps.last_mut().expect("terminal")["payload"]
            .as_object_mut()
            .expect("payload")
            .remove("last_agent_message");
    }
    let turn = extract_codex_partial_turn(
        &maps,
        Some(&meta(child)),
        child,
        turn_id,
        &ExtractOptions::default(),
    )
    .expect("actual extracted completed turn");
    let source = maps.last().expect("terminal").clone();
    f.input.inner.body.with_shared(|shared| {
        shared.linker.register_completed_work_result(
            &link,
            &turn,
            &[CodexTranscriptSourceRecord {
                start_offset: 0,
                end_offset: 1,
                record: source,
            }],
        )
    });
}
#[tokio::test]
async fn same_text_pending_receipt_survives_restart_and_unknown_or_bodyless_completion_until_explicit_new_invocation(
) {
    let f = Fixture::new();
    let parent = "same-result-parent";
    let child = "same-result-child";
    let base = "2026-08-07T05:00:00Z";
    let base_ms = chrono::DateTime::parse_from_rfc3339(base)
        .expect("base")
        .timestamp_millis() as f64;
    let first = CodexSpawnDescriptor {
        parent_thread_id: parent.into(),
        parent_turn_id: "first-parent".into(),
        parent_trace_id: "a".repeat(32),
        parent_tool_call_id: "first-call".into(),
        child_thread_id: Some(child.into()),
        agent_path: Some("/root/same-child".into()),
        invocation_id: Some("I1".into()),
        spawned_at_ms: base_ms - 1.0,
        ..Default::default()
    };
    let second = CodexSpawnDescriptor {
        parent_turn_id: "second-parent".into(),
        parent_tool_call_id: "second-call".into(),
        invocation_id: Some("I2".into()),
        spawned_at_ms: base_ms + 60_000.0,
        ..first.clone()
    };
    let receipt = |turn: &str, seconds: f64, explicit: Option<&str>| {
        let start = timeline(base, seconds);
        let mut records = work_turn(parent, turn, "receive result", "received", 10, 1, &start);
        let mut metadata = json!({"turn_id":turn});
        if let Some(id) = explicit {
            metadata["invocation_id"] = json!(id);
        }
        records.insert(4,record(&timeline(base,seconds+3.5),"response_item",json!({"type":"agent_message","author":"/root/same-child","recipient":"/root","content":[{"type":"input_text","text":"Message Type: FINAL_ANSWER\nPayload:\ndone"}],"internal_chat_message_metadata_passthrough":metadata})));
        records
    };
    f.input
        .inner
        .body
        .with_shared(|shared| shared.linker.register_spawns(std::slice::from_ref(&first)));
    register_source_terminal(&f, &first, "child-one", true);
    let pp = f
        .write(
            "rollout-same-result-parent.jsonl",
            &(receipt("first-parent", 0.0, None).join("\n") + "\n"),
        )
        .await;
    f.process(&pp).await;
    assert_eq!(
        events(&f.records(), "gen_ai.agent.result")
            .iter()
            .map(|e| e["gen_ai.agent.invocation.id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("I1")]
    );
    f.input
        .inner
        .body
        .with_shared(|shared| shared.linker.register_spawns(std::slice::from_ref(&second)));
    f.append(
        &pp,
        &(receipt("second-parent", 70.0, None)
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"),
    )
    .await;
    f.process(&pp).await;
    assert_eq!(events(&f.records(), "gen_ai.agent.result").len(), 1);
    assert_eq!(pending_receipts(&f).len(), 1);
    f.append(
        &pp,
        &(receipt("explicit-old-duplicate", 80.0, Some("I1"))
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"),
    )
    .await;
    f.process(&pp).await;
    assert_eq!(events(&f.records(), "gen_ai.agent.result").len(), 1);
    let recovered = f.restart().await;
    start_until_first_native_cycle(&recovered).await;
    real_collect_cycle(&recovered).await;
    assert!(events(&recovered.records(), "gen_ai.agent.result").is_empty());
    assert_eq!(pending_receipts(&recovered).len(), 1);
    register_source_terminal(&recovered, &second, "child-two", false);
    real_collect_cycle(&recovered).await;
    assert!(events(&recovered.records(), "gen_ai.agent.result").is_empty());
    assert_eq!(pending_receipts(&recovered).len(), 1);
    register_source_terminal(&recovered, &second, "child-two", true);
    real_collect_cycle(&recovered).await;
    assert!(events(&recovered.records(), "gen_ai.agent.result").is_empty());
    assert_eq!(pending_receipts(&recovered).len(), 1);
    recovered
        .append(
            &pp,
            &(receipt("explicit-new-result", 90.0, Some("I2"))
                .into_iter()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"),
        )
        .await;
    real_collect_cycle(&recovered).await;
    assert_eq!(
        events(&recovered.records(), "gen_ai.agent.result")
            .iter()
            .map(|e| e["gen_ai.agent.invocation.id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("I2")]
    );
    assert!(pending_receipts(&recovered).is_empty());
    let before = recovered.records().len();
    real_collect_cycle(&recovered).await;
    assert_eq!(recovered.records().len(), before);
}
fn native_dispatched_turn(
    session: &str,
    turn: &str,
    prompt: &str,
    start: &str,
    dispatch: (&str, &str, &str, &str),
) -> Vec<String> {
    let (call, name, target, work) = dispatch;
    let mut lines = work_turn(session, turn, prompt, "delegated", 100, 10, start);
    if session != "parent-reuse" {
        lines[3] = record(
            &timeline(start, 3.0),
            "response_item",
            json!({"type":"agent_message","author":"/root","recipient":"/root/reused","content":[{"type":"input_text","text":prompt}],"internal_chat_message_metadata_passthrough":{"turn_id":turn}}),
        );
    }
    lines.splice(4..4,[
      record(&timeline(start,3.1),"response_item",json!({"type":"function_call","call_id":call,"name":name,"arguments":json!({"id":target,"message":work}).to_string()})),
      record(&timeline(start,3.2),"response_item",json!({"type":"function_call_output","call_id":call,"output":json!({"agent_id":target,"nickname":if target=="grandchild-reuse" {"Euler"}else{"Newton"}}).to_string()}))
    ]);
    lines
}
#[tokio::test]
async fn agent_id_reused_child_nested_invocations_bind_immediate_callers_and_real_result_without_direct_user_alias(
) {
    let f = Fixture::new();
    let parent = "parent-reuse";
    let child = "child-reuse";
    let grandchild = "grandchild-reuse";
    let submeta = |id: &str, immediate_parent: &str, depth, at: &str| {
        let line = child_meta(
            id,
            immediate_parent,
            depth,
            None,
            Some(if id == child { "Newton" } else { "Euler" }),
            at,
        );
        let mut r: Value = serde_json::from_str(&line).expect("subagent meta");
        r["payload"]["session_id"] = json!(parent);
        r["payload"]["timestamp"] = json!(at);
        r.to_string()
    };
    let pp = f
        .write(
            "rollout-parent-reuse.jsonl",
            &(native_dispatched_turn(
                parent,
                "parent-first",
                "delegate first",
                "2026-08-07T03:00:00Z",
                ("spawn-first", "spawn_agent", child, "first child work"),
            )
            .join("\n")
                + "\n"),
        )
        .await;
    f.process(&pp).await;
    let mut first_child = work_turn(
        child,
        "child-first",
        "first child work",
        "first done",
        80,
        8,
        "2026-08-07T03:00:10Z",
    );
    first_child[0] = submeta(child, parent, 1, "2026-08-07T03:00:09Z");
    let cp = write_native_fixture(
        &f,
        "rollout-child-reuse.jsonl",
        &(first_child.join("\n") + "\n"),
    )
    .await;
    f.process(&cp).await;
    let first = events(&f.records(), "gen_ai.agent.invoke")
        .into_iter()
        .find(|e| e["gen_ai.tool.call.id"] == "spawn-first")
        .expect("first");
    assert_eq!(first["gen_ai.agent.peer.id"], child);
    let r = responses_for(&f.records(), "child-first")[0].clone();
    assert_eq!(r["gen_ai.session.id"], child);
    assert_eq!(
        r["gen_ai.agent.parent.invocation.id"],
        first["gen_ai.agent.invocation.id"]
    );
    assert_eq!(r["agent.codex.parent_span_id"], first["span_id"]);
    assert!(events(&f.records(), "gen_ai.agent.result").is_empty());
    f.append(
        &pp,
        &(native_dispatched_turn(
            parent,
            "parent-second",
            "delegate second",
            "2026-08-07T03:01:00Z",
            (
                "followup-second",
                "followup_task",
                child,
                "second child work",
            ),
        )
        .into_iter()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
            + "\n"),
    )
    .await;
    f.process(&pp).await;
    f.append(
        &cp,
        &(native_dispatched_turn(
            child,
            "child-second",
            "second child work",
            "2026-08-07T03:01:10Z",
            ("nested-spawn", "spawn_agent", grandchild, "nested work"),
        )
        .into_iter()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
            + "\n"),
    )
    .await;
    f.process(&cp).await;
    let invokes = events(&f.records(), "gen_ai.agent.invoke");
    let second = invokes
        .iter()
        .find(|e| e["gen_ai.tool.call.id"] == "followup-second")
        .expect("second");
    let nested = invokes
        .iter()
        .find(|e| e["gen_ai.tool.call.id"] == "nested-spawn")
        .expect("nested");
    assert_ne!(
        second["gen_ai.agent.invocation.id"],
        first["gen_ai.agent.invocation.id"]
    );
    assert_eq!(first["gen_ai.agent.peer.name"], "Newton");
    assert_eq!(second["gen_ai.agent.peer.name"], "Newton");
    assert_eq!(nested["gen_ai.agent.peer.name"], "Euler");
    assert_eq!(nested["gen_ai.agent.name"], "Newton");
    let r = responses_for(&f.records(), "child-second")[0].clone();
    for (key, expected) in [
        ("gen_ai.session.id", json!(child)),
        ("gen_ai.turn.id", json!(format!("{child}:child-second"))),
        (
            "gen_ai.agent.parent.invocation.id",
            second["gen_ai.agent.invocation.id"].clone(),
        ),
        ("agent.codex.parent_span_id", second["span_id"].clone()),
        ("trace_id", second["trace_id"].clone()),
    ] {
        assert_eq!(r[key], expected, "{key}");
    }
    assert_eq!(nested["gen_ai.session.id"], child);
    assert_eq!(
        nested["gen_ai.agent.parent.invocation.id"],
        second["gen_ai.agent.invocation.id"]
    );
    assert!(nested["gen_ai.agent.invocation.id"].is_string());
    let mut grandchild_lines = work_turn(
        grandchild,
        "grandchild-first",
        "nested work",
        "nested done",
        30,
        3,
        "2026-08-07T03:01:20Z",
    );
    grandchild_lines[0] = submeta(grandchild, child, 2, "2026-08-07T03:01:19Z");
    let gp = write_native_fixture(
        &f,
        "rollout-grandchild-reuse.jsonl",
        &(grandchild_lines.join("\n") + "\n"),
    )
    .await;
    f.process(&gp).await;
    let r = responses_for(&f.records(), "grandchild-first")[0].clone();
    assert_eq!(r["gen_ai.session.id"], grandchild);
    assert_eq!(r["gen_ai.agent.parent.id"], child);
    assert_eq!(
        r["gen_ai.agent.parent.invocation.id"],
        nested["gen_ai.agent.invocation.id"]
    );
    assert_eq!(r["agent.codex.parent_span_id"], nested["span_id"]);
    assert_eq!(r["gen_ai.agent.depth"], 2);
    assert_eq!(invokes.len(), 3);
    assert_eq!(
        invokes
            .iter()
            .map(|e| e["gen_ai.agent.invocation.id"]
                .as_str()
                .expect("invocation"))
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    let mut receiving = work_turn(
        parent,
        "parent-receives-result",
        "collect result",
        "received",
        20,
        2,
        "2026-08-07T03:02:00Z",
    )
    .into_iter()
    .skip(1)
    .collect::<Vec<_>>();
    receiving.insert(3,record("2026-08-07T03:02:03.500Z","event_msg",json!({"type":"sub_agent_activity","kind":"completed","event_id":"followup-second","agent_thread_id":child,"output":"actual second child result"})));
    f.append(&pp, &(receiving.join("\n") + "\n")).await;
    f.process(&pp).await;
    let results = events(&f.records(), "gen_ai.agent.result");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["gen_ai.session.id"], parent);
    assert_eq!(
        results[0]["gen_ai.turn.id"],
        format!("{parent}:parent-receives-result")
    );
    assert_eq!(
        results[0]["gen_ai.agent.invocation.id"],
        second["gen_ai.agent.invocation.id"]
    );
    assert_eq!(results[0]["gen_ai.agent.peer.id"], child);
    assert!(results[0].get("span_id").is_none());
    f.append(
        &cp,
        &(work_turn(
            child,
            "direct-user-turn",
            "first child work",
            "direct response",
            10,
            1,
            "2026-08-07T03:03:00Z",
        )
        .into_iter()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
            + "\n"),
    )
    .await;
    f.process(&cp).await;
    let direct = responses_for(&f.records(), "direct-user-turn")[0].clone();
    assert_eq!(direct["gen_ai.session.id"], child);
    assert!(direct.get("gen_ai.agent.parent.invocation.id").is_none());
    assert!(direct.get("agent.codex.parent_span_id").is_none());
    assert_ne!(direct["trace_id"], first["trace_id"]);
    let before = f.records().len();
    f.process(&cp).await;
    f.process(&pp).await;
    f.process(&gp).await;
    assert_eq!(f.records().len(), before);
}
