//! Historical synthetic Hermes host inputs, never recorded product outputs.
use crate::host::{host_command, repo};
use loongsuite_pilot::{
    checkpoints::StateStore,
    inputs::{hermes_log::HermesLogInput, rest_support::SessionInputOptions},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, SystemTime},
};
const SESSION: &str = "fixture-session-001";
const TURN1: &str = "00000000-0000-4000-8000-000000000001";
struct Probe {
    meta: Value,
    records: Vec<Value>,
    raw: String,
    stderr: String,
    root: tempfile::TempDir,
    log: std::path::PathBuf,
    parameters: Value,
}
fn rows<'a>(p: &'a Probe, name: &str) -> Vec<&'a Value> {
    p.records
        .iter()
        .filter(|r| r["event.name"] == name)
        .collect()
}
fn event<'a>(p: &'a Probe, name: &str) -> &'a Value {
    rows(p, name)[0]
}
fn names(p: &Probe) -> Vec<&str> {
    p.records
        .iter()
        .map(|r| r["event.name"].as_str().unwrap())
        .collect()
}
fn strings<'a>(rows: &[&'a Value], key: &str) -> Vec<&'a str> {
    rows.iter().map(|r| r[key].as_str().unwrap()).collect()
}
fn part_types(messages: &Value) -> Vec<&str> {
    messages
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["parts"].as_array().unwrap())
        .map(|p| p["type"].as_str().unwrap())
        .collect()
}
async fn run(index: usize) -> Vec<Probe> {
    let mut fixtures: Vec<_> =
        std::fs::read_dir(repo().join("tests/host-plugin-contracts/drivers/hermes-plugin"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&format!("{index:02}-"))
            })
            .collect();
    fixtures.sort();
    assert!(!fixtures.is_empty());
    let mut results = vec![];
    for fixture in fixtures {
        let data: Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
        let opts = &data["options"];
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut config = json!({"userId":opts["configUser"],"agents":{"hermes-agent":{"captureMessageContent":opts["captureMessageContent"]}}});
        let mut plugin = repo().join("assets/plugins/hermes-agent/loongsuite-pilot/__init__.py");
        let source = opts["dataDirSource"].as_str().unwrap();
        let mut config_path = root.path().join("config.json");
        if source == "marker" {
            let dir = root.path().join("hermes/plugins/loongsuite-pilot");
            std::fs::create_dir_all(&dir).unwrap();
            let copied = dir.join("__init__.py");
            std::fs::copy(&plugin, &copied).unwrap();
            plugin = copied;
            std::fs::write(
                dir.join(".loongsuite-pilot-managed.json"),
                json!({"dataDir":root.path()}).to_string(),
            )
            .unwrap();
        } else if source == "config" {
            config_path = home.join(".loongsuite-pilot/config.json");
            std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
            config["dataDir"] = json!(root.path());
        }
        std::fs::write(config_path, config.to_string()).unwrap();
        let events_path = root.path().join("events.jsonl");
        std::fs::write(
            &events_path,
            data["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let log = root.path().join("logs/hermes-agent");
        if index == 23 {
            std::fs::create_dir_all(&log).unwrap();
            let file = std::fs::File::create(log.join("hermes-agent-stale.jsonl")).unwrap();
            std::io::Write::write_all(&mut &file, b"{}\n").unwrap();
            file.set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60)),
            )
            .unwrap();
        }
        if index == 25 {
            std::fs::write(root.path().join("logs"), "blocks log directory creation").unwrap();
        }
        let args = vec![
            "-c".into(),
            include_str!("../drivers/hermes-plugin/replay.py").into(),
            plugin.to_string_lossy().into_owned(),
            events_path.to_string_lossy().into_owned(),
        ];
        let mut command = host_command("python3", &args, root.path());
        command
            .current_dir(root.path())
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env_remove("AGENT_DATA_COLLECTION_CONFIG");
        if source != "env" {
            command.env_remove("LOONGSUITE_PILOT_DATA_DIR");
        }
        for (key, env) in [
            ("pilotEnvUser", "LOONGSUITE_PILOT_USER_ID"),
            ("legacyEnvUser", "LOONGSUITE_USER_ID"),
            ("spanAttributes", "LOONGSUITE_PILOT_SPAN_ATTRIBUTES"),
            ("agentTeamsWorkerName", "AGENTTEAMS_WORKER_NAME"),
        ] {
            if let Some(value) = opts[key].as_str() {
                command.env(env, value);
            } else {
                command.env_remove(env);
            }
        }
        let out = loongsuite_pilot::utils::candidate_process::output(
            &mut command,
            Duration::from_secs(30),
            1024 * 1024,
        )
        .await
        .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let meta = serde_json::from_slice(&out.stdout).unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let mut all: Vec<Value> = vec![];
        if opts["expectLogFile"] != false {
            let files: Vec<_> = std::fs::read_dir(&log)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("hermes-agent-")
                        && p.extension().is_some_and(|e| e == "jsonl")
                })
                .collect();
            assert_eq!(files.len(), 1);
            all = std::fs::read_to_string(&files[0])
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
            let native = HermesLogInput::new(SessionInputOptions {
                state_store: Arc::new(StateStore::new(root.path().join("native-state.json"))),
                session_dir: Some(log.to_string_lossy().into_owned()),
                file_pattern: None,
                poll_interval_ms: Some(60_000),
            })
            .collect_entries()
            .await
            .unwrap();
            let by_id: HashMap<_, _> = native
                .iter()
                .map(|r| (r.event_id.as_str(), serde_json::to_value(r).unwrap()))
                .collect();
            assert_eq!(by_id.len(), all.len());
            for raw in &all {
                let normalized = &by_id[raw["event.id"].as_str().unwrap()];
                for (key, value) in raw.as_object().unwrap() {
                    if key.starts_with("gen_ai.")
                        || matches!(
                            key.as_str(),
                            "user.id"
                                | "trace_id"
                                | "span_id"
                                | "parent_span_id"
                                | "resourceAttributes"
                        )
                    {
                        if value.is_number() {
                            assert_eq!(normalized[key].as_f64(), value.as_f64(), "{index} {key}");
                        } else {
                            assert_eq!(&normalized[key], value, "{index} {key}");
                        }
                    }
                }
            }
        }
        let raw = serde_json::to_string(&all).unwrap();
        let mut records: Vec<_> = all
            .iter()
            .filter(|r| r["event.name"] != "other")
            .cloned()
            .collect();
        records.sort_by_key(|r| {
            r["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
        });
        results.push(Probe {
            meta,
            records,
            raw,
            stderr,
            root,
            log,
            parameters: data["parameters"].clone(),
        });
    }
    results
}
async fn one(index: usize) -> Probe {
    let mut probes = run(index).await;
    assert_eq!(probes.len(), 1);
    probes.remove(0)
}

#[tokio::test]
async fn hermes_plugin_overlapping_im_turns_all_four_capture_observer_variants() {
    for p in run(0).await {
        assert_eq!(p.records.len(), 12);
        for label in ["foreground", "background"] {
            let own: Vec<_> = p
                .records
                .iter()
                .filter(|r| r["gen_ai.turn.id"] == label)
                .collect();
            assert_eq!(own.len(), 6);
            assert_eq!(
                strings(&own, "trace_id")
                    .into_iter()
                    .collect::<HashSet<_>>()
                    .len(),
                1
            );
            assert!(own.iter().all(|r| r["user.id"] == "im-user-A"));
            let req: Vec<_> = own
                .iter()
                .copied()
                .filter(|r| r["event.name"] == "llm.request")
                .collect();
            assert_eq!(
                strings(&req, "gen_ai.request.id"),
                [format!("{label}-api-1"), format!("{label}-api-2")]
            );
            assert!(req[0]["gen_ai.input.messages"]
                .to_string()
                .contains(&format!("{label} files")));
            assert_eq!(
                own.iter().find(|r| r["event.name"] == "tool.call").unwrap()["gen_ai.tool.call.id"],
                format!("call_{label}")
            );
        }
        assert_eq!(
            p.records
                .iter()
                .map(|r| r["trace_id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            2
        );
    }
}
#[tokio::test]
async fn hermes_plugin_background_tools_survive_all_six_end_finalize_thread_variants() {
    for p in run(1).await {
        assert_eq!(p.meta["activeTurns"], 0);
        if p.parameters[1] == "on_session_finalize" {
            assert_eq!(p.meta["sessions"], 0);
        }
        assert_eq!(p.records.len(), 12);
        assert_eq!(
            p.records
                .iter()
                .map(|r| r["event.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            12
        );
        let own: Vec<_> = p
            .records
            .iter()
            .filter(|r| r["gen_ai.turn.id"] == "background")
            .collect();
        assert_eq!(own.len(), 6);
        let result = &own
            .iter()
            .find(|r| r["event.name"] == "tool.result")
            .unwrap()["gen_ai.tool.call.result"];
        assert_eq!(result["output"], "17 /etc/hosts\n11 /etc/shells\n28 total");
        assert_eq!(result["exit_code"], 0);
        assert!(own
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .any(|r| r
                .to_string()
                .contains("The files have 17 and 11 lines, for a total of 28.")));
    }
}
#[tokio::test]
async fn hermes_plugin_exact_turn_or_task_identity_closes_only_failed_turn() {
    for p in run(2).await {
        assert_eq!(p.meta["activeTurns"], 1);
        assert_eq!(p.records.len(), 2);
        assert_eq!(rows(&p, "llm.response").len(), 1);
        assert!(!event(&p, "llm.response")["error.type"]
            .as_str()
            .unwrap()
            .is_empty());
    }
}
#[tokio::test]
async fn hermes_plugin_exit_flush_does_not_invent_unfinished_api_result() {
    let p = one(3).await;
    assert_eq!(
        names(&p),
        ["llm.request", "llm.response", "tool.call", "llm.request"]
    );
    assert_eq!(rows(&p, "llm.response").len(), 1);
}
#[tokio::test]
async fn hermes_plugin_registered_callbacks_and_six_event_tool_turn_keep_all_fields() {
    let p = one(4).await;
    assert_eq!(
        p.meta["hooks"],
        json!([
            "api_request_error",
            "on_session_end",
            "on_session_finalize",
            "on_session_start",
            "post_api_request",
            "post_llm_call",
            "post_tool_call",
            "pre_api_request",
            "pre_llm_call",
            "pre_tool_call"
        ])
    );
    assert_eq!(
        names(&p),
        [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response"
        ]
    );
    for pair in p.records.windows(2) {
        assert!(
            pair[1]["time_unix_nano"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
                > pair[0]["time_unix_nano"]
                    .as_str()
                    .unwrap()
                    .parse::<u128>()
                    .unwrap()
        );
    }
    assert_eq!(
        p.records
            .iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        p.records.len()
    );
    assert_eq!(
        p.records
            .iter()
            .map(|r| r["trace_id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    for r in &p.records {
        assert_eq!(r["gen_ai.turn.id"], TURN1);
        assert_eq!(r["gen_ai.session.id"], SESSION);
        assert_eq!(r["user.id"], "pilot-env-user");
        assert_eq!(r["agent.pilot.invocation.user.id"], "pilot-env-user");
        assert_eq!(r["gen_ai.agent.type"], "hermes");
        assert_eq!(r["gen_ai.provider.name"], "qwen");
    }
    let a = &p.records;
    assert_eq!(a[0]["gen_ai.step.id"], a[1]["gen_ai.step.id"]);
    assert_eq!(a[4]["gen_ai.step.id"], a[5]["gen_ai.step.id"]);
    assert_ne!(a[0]["gen_ai.step.id"], a[4]["gen_ai.step.id"]);
    assert_eq!(a[0]["gen_ai.response.id"], a[1]["gen_ai.response.id"]);
    assert_eq!(a[1]["gen_ai.usage.input_tokens"], 1711);
    assert_eq!(a[1]["gen_ai.usage.total_tokens"], 1742);
    assert_eq!(a[2]["gen_ai.tool.call.id"], "call_fixture_001");
    assert_eq!(a[3]["gen_ai.tool.call.id"], a[2]["gen_ai.tool.call.id"]);
    assert_eq!(
        a[2]["gen_ai.tool.call.arguments"],
        json!({"command":"wc -l /etc/hosts /etc/shells"})
    );
    assert_eq!(a[3]["gen_ai.tool.call.result"]["exit_code"], 0);
    assert!(a[3]["gen_ai.tool.call.result"]["error"].is_null());
    assert!(a[3]["gen_ai.tool.call.duration"].as_f64().unwrap() >= 0.0);
    assert!(part_types(&a[0]["gen_ai.input.messages"]).contains(&"text"));
    assert!(part_types(&a[1]["gen_ai.output.messages"]).contains(&"tool_call"));
    for kind in ["tool_call", "tool_call_response"] {
        assert!(part_types(&a[4]["gen_ai.input.messages"]).contains(&kind));
    }
    assert!(part_types(&a[5]["gen_ai.output.messages"]).contains(&"text"));
    assert_eq!(a[5]["gen_ai.response.finish_reasons"], json!(["stop"]));
}
#[tokio::test]
async fn hermes_plugin_agentteams_worker_sets_trimmed_name_and_resource() {
    let p = one(5).await;
    assert!(!p.records.is_empty());
    assert!(p.records.iter().all(|r| r["gen_ai.agent.name"] == "planner"
        && r["resourceAttributes"]["agentteams.worker.name"] == "planner"));
    assert_eq!(
        names(&p).into_iter().collect::<HashSet<_>>(),
        HashSet::from(["llm.request", "llm.response", "tool.call", "tool.result"])
    );
}
#[tokio::test]
async fn hermes_plugin_blank_and_513_character_worker_names_are_ignored() {
    for p in run(6).await {
        assert!(
            p.records
                .iter()
                .all(|r| r.get("gen_ai.agent.name").is_none()
                    && r.get("resourceAttributes").is_none())
        );
    }
}
#[tokio::test]
async fn hermes_plugin_provider_error_response_retains_type_message_status() {
    let p = one(7).await;
    assert_eq!(names(&p), ["llm.request", "llm.response"]);
    assert_eq!(p.records[0]["gen_ai.request.id"], "api-request-error-1");
    let r = &p.records[1];
    assert_eq!(r["gen_ai.response.finish_reasons"], json!(["error"]));
    assert_eq!(r["error.type"], "RateLimitError");
    assert_eq!(r["error.message"], "Too many requests");
    assert_eq!(r["http.status_code"], 429);
}
#[tokio::test]
async fn hermes_plugin_all_six_provider_tool_surfaces_normalize_typed_definitions() {
    let p = one(8).await;
    let req = rows(&p, "llm.request");
    assert_eq!(req.len(), 6);
    let names = [
        "terminal",
        "web_search",
        "read_file",
        "lookup",
        "grep_files",
    ];
    let desc = [
        "Run a command.",
        "Search the web.",
        "Read a file.",
        "Look up a value.",
        "Search files.",
    ];
    let keys = ["command", "query", "path", "key", "query"];
    for i in 0..5 {
        let mut properties = serde_json::Map::new();
        properties.insert(keys[i].into(), json!({"type":"string"}));
        let mut expected = vec![
            json!({"type":"function","name":names[i],"description":desc[i],"parameters":{"type":"object","properties":properties}}),
        ];
        if i == 4 {
            expected.push(json!({"type":"function","name":"list_directory","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}));
        }
        assert_eq!(req[i]["gen_ai.tool.definitions"], json!(expected));
    }
    assert!(req[5].get("gen_ai.tool.definitions").is_none());
}
#[tokio::test]
async fn hermes_plugin_false_capture_keeps_tool_definitions_and_raw_description() {
    let p = one(9).await;
    let d = &event(&p, "llm.request")["gen_ai.tool.definitions"];
    assert_eq!(d.as_array().unwrap().len(), 1);
    assert_eq!(d[0]["name"], "private_tool");
    assert_eq!(d[0]["description"], "private-tool-description-marker");
    assert!(p.raw.contains("private-tool-description-marker"));
}
#[tokio::test]
async fn hermes_plugin_all_six_system_shapes_keep_system_out_of_messages() {
    let p = one(10).await;
    let req = rows(&p, "llm.request");
    assert_eq!(req.len(), 6);
    for (i, text) in [
        "You are a careful assistant.",
        "Follow the house rules.",
        "Bedrock block prompt.",
        "Gemini instruction.",
        "Developer rule.",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            req[i]["gen_ai.system_instructions"],
            json!([{"type":"text","content":text}])
        );
    }
    assert!(req[5].get("gen_ai.system_instructions").is_none());
    for r in &req {
        for key in ["gen_ai.input.messages", "gen_ai.input.messages_delta"] {
            assert!(!r[key]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["role"] == "system")));
        }
    }
    assert_eq!(
        req[0]["gen_ai.input.messages_delta"][0],
        json!({"role":"user","parts":[{"type":"text","content":"Report the available tool surface."}]})
    );
}
#[tokio::test]
async fn hermes_plugin_responses_api_instructions_do_not_change_human_input_hash() {
    let p = run(11).await;
    assert_eq!(p.len(), 2);
    let a = event(&p[0], "llm.request");
    let b = event(&p[1], "llm.request");
    assert_eq!(
        a["gen_ai.system_instructions"],
        json!([{"type":"text","content":"Use the Responses API house rules."}])
    );
    let input = json!([{"role":"user","parts":[{"type":"text","content":"Report the available tool surface."}]}]);
    assert_eq!(a["gen_ai.input.messages"], input);
    assert_eq!(a["gen_ai.input.messages_delta"], input);
    assert_eq!(
        a["gen_ai.input.messages_hash"],
        b["gen_ai.input.messages_hash"]
    );
    assert!(b.get("gen_ai.system_instructions").is_none());
}
#[tokio::test]
async fn hermes_plugin_false_capture_keeps_system_prompt() {
    let p = one(12).await;
    assert_eq!(
        event(&p, "llm.request")["gen_ai.system_instructions"],
        json!([{"type":"text","content":"private-system-prompt-marker"}])
    );
    assert!(p.raw.contains("private-system-prompt-marker"));
}
#[tokio::test]
async fn hermes_plugin_false_capture_keeps_provider_error_message() {
    let p = one(13).await;
    let r = event(&p, "llm.response");
    assert_eq!(r["error.type"], "RateLimitError");
    assert_eq!(r["error.message"], "Too many requests");
    assert!(p.raw.contains("Too many requests"));
}
#[tokio::test]
async fn hermes_plugin_failed_retry_cannot_consume_successful_assistant_output() {
    let p = one(14).await;
    assert_eq!(
        names(&p),
        ["llm.request", "llm.response", "llm.request", "llm.response"]
    );
    let r = rows(&p, "llm.response");
    assert_eq!(r[0]["gen_ai.request.id"], "api-request-error-1");
    assert_eq!(r[0]["gen_ai.response.finish_reasons"], json!(["error"]));
    assert_eq!(r[0]["error.type"], "RateLimitError");
    assert!(!r[0]["gen_ai.output.messages"]
        .to_string()
        .contains("The retried request succeeded."));
    assert_eq!(r[1]["gen_ai.request.id"], "api-request-success-2");
    assert_eq!(r[1]["gen_ai.response.finish_reasons"], json!(["stop"]));
    assert!(r[1].get("error.type").is_none());
    assert!(r[1]["gen_ai.output.messages"]
        .to_string()
        .contains("The retried request succeeded."));
}
#[tokio::test]
async fn hermes_plugin_false_capture_keeps_skill_metadata_and_typed_content() {
    let p = one(15).await;
    let records: Vec<_> = p
        .records
        .iter()
        .filter(|r| r["gen_ai.tool.name"] == "skill_view")
        .collect();
    assert_eq!(records.len(), 2);
    for r in &records {
        assert_eq!(r["gen_ai.skill.name"], "loongsuite-pr-review");
        assert_eq!(r["gen_ai.skill.id"], "loongsuite-pr-review");
    }
    assert_eq!(
        records[1]["gen_ai.skill.description"],
        "Review LoongSuite PR readiness."
    );
    assert_eq!(records[1]["gen_ai.skill.version"], "1.2.3");
    assert!(records[0].get("gen_ai.tool.call.arguments").is_some());
    assert!(records[1].get("gen_ai.tool.call.result").is_some());
}
#[tokio::test]
async fn hermes_plugin_observer_v1_preserves_request_and_tool_lifecycle_identity() {
    let p = one(16).await;
    assert!(p
        .records
        .iter()
        .all(|r| r["gen_ai.turn.id"] == "turn_01JZ_HERMES_OBSERVER_V1"));
    assert_eq!(
        strings(&rows(&p, "llm.request"), "gen_ai.request.id"),
        ["api-request-1", "api-request-2"]
    );
    let r = event(&p, "tool.result");
    assert_eq!(r["gen_ai.tool.call.duration"], 42);
    assert_eq!(r["tool.result.status"], "success");
}
#[tokio::test]
async fn hermes_plugin_legacy_user_env_remains_fallback() {
    let p = one(17).await;
    assert!(p.records.iter().all(|r| r["user.id"] == "legacy-env-user"));
}
#[tokio::test]
async fn hermes_plugin_invocation_identity_precedes_env_and_sender() {
    let p = one(18).await;
    assert!(p.records.iter().all(|r| r["user.id"] == "invocation-user"
        && r["agent.pilot.invocation.user.id"] == "invocation-user"
        && r["agent.hermes.sender.id"] == "sender-user"));
}
#[tokio::test]
async fn hermes_plugin_two_tools_pair_with_three_unique_api_steps() {
    let p = one(19).await;
    assert_eq!(
        names(&p),
        [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "llm.request",
            "llm.response"
        ]
    );
    assert!(p
        .records
        .iter()
        .all(|r| r["user.id"] == "config-fallback-user"));
    let req = rows(&p, "llm.request");
    let resp = rows(&p, "llm.response");
    let call = rows(&p, "tool.call");
    let result = rows(&p, "tool.result");
    assert_eq!(
        strings(&req, "gen_ai.step.id")
            .into_iter()
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(
        strings(&req, "gen_ai.step.id"),
        strings(&resp, "gen_ai.step.id")
    );
    assert_eq!(
        strings(&call, "gen_ai.tool.call.id"),
        [
            "call_9619303d98aa474299c86f52",
            "call_7bffd0cfff4f4966a504ad5e"
        ]
    );
    assert_eq!(
        strings(&result, "gen_ai.tool.call.id"),
        strings(&call, "gen_ai.tool.call.id")
    );
    for r in &req[1..] {
        for ty in ["tool_call", "tool_call_response"] {
            assert!(part_types(&r["gen_ai.input.messages_delta"]).contains(&ty));
        }
    }
}
#[tokio::test]
async fn hermes_plugin_boolean_false_keeps_all_content_and_correlation() {
    let p = one(20).await;
    assert!(p.records.iter().all(|r| r["user.id"] == "sender-user"
        && r["agent.pilot.invocation.user.id"] == "sender-user"
        && r["agent.hermes.sender.id"] == "sender-user"));
    for text in [
        "approved files",
        "wc -l /etc/hosts",
        "17 /etc/hosts",
        "The files have",
    ] {
        assert!(p.raw.contains(text));
    }
    let a = event(&p, "tool.call");
    let b = event(&p, "tool.result");
    assert!(a.get("gen_ai.tool.call.arguments").is_some());
    assert!(b.get("gen_ai.tool.call.result").is_some());
    assert_eq!(a["gen_ai.tool.call.id"], b["gen_ai.tool.call.id"]);
    let mut all: Vec<Value> = vec![];
    for r in p
        .records
        .iter()
        .filter(|r| r["event.name"].as_str().unwrap().starts_with("llm."))
    {
        let key = if r["event.name"] == "llm.request" {
            "gen_ai.input.messages"
        } else {
            "gen_ai.output.messages"
        };
        let messages = r[key].as_array().unwrap();
        assert!(!messages.is_empty());
        assert!(messages
            .iter()
            .all(|m| m["role"].is_string() && m["parts"].is_array()));
    }
    for r in &p.records {
        for key in ["gen_ai.input.messages", "gen_ai.output.messages"] {
            if let Some(messages) = r[key].as_array() {
                for m in messages {
                    all.extend(m["parts"].as_array().unwrap().iter().cloned());
                }
            }
        }
    }
    assert!(all
        .iter()
        .any(|p| p["type"] == "text" && p["content"] != ""));
    assert!(all
        .iter()
        .filter(|p| p["type"] == "tool_call")
        .all(|p| p.get("arguments").is_some()));
    assert!(all
        .iter()
        .filter(|p| p["type"] == "tool_call_response")
        .all(|p| p["response"] != ""));
}
#[tokio::test]
async fn hermes_plugin_string_false_keeps_raw_typed_tool_content() {
    let p = one(21).await;
    for text in ["approved files", "wc -l /etc/hosts", "17 /etc/hosts"] {
        assert!(p.raw.contains(text));
    }
    assert!(event(&p, "tool.call")
        .get("gen_ai.tool.call.arguments")
        .is_some());
    assert!(event(&p, "tool.result")
        .get("gen_ai.tool.call.result")
        .is_some());
}
#[tokio::test]
async fn hermes_plugin_managed_marker_and_home_config_both_resolve_data_directory() {
    for p in run(22).await {
        assert_eq!(p.log, p.root.path().join("logs/hermes-agent"));
        assert!(p.log.exists());
    }
}
#[tokio::test]
async fn hermes_plugin_private_directory_and_eight_day_stale_file_cleanup() {
    let p = one(23).await;
    assert!(!p.log.join("hermes-agent-stale.jsonl").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&p.log).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
#[tokio::test]
async fn hermes_plugin_101_sessions_flush_exactly_100_completed_pairs_before_eviction() {
    let p = one(24).await;
    assert_eq!(p.records.len(), 200);
    assert_eq!(&names(&p)[..2], ["llm.request", "llm.response"]);
    assert!(p.records[..2]
        .iter()
        .all(|r| r["gen_ai.session.id"] == "active-session-0"));
    assert_eq!(
        p.records
            .iter()
            .map(|r| r["event.id"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        200
    );
    assert!(!p
        .records
        .iter()
        .any(|r| r["gen_ai.session.id"] == "active-session-100"));
}
#[tokio::test]
async fn hermes_plugin_callback_failure_stderr_omits_payload_and_internal_path() {
    let p = one(25).await;
    assert!(p
        .stderr
        .contains("[loongsuite-pilot] post_llm_call failed:"));
    assert!(!p.stderr.contains("approved files"));
    assert!(!p.stderr.contains(
        &std::path::Path::new("logs")
            .join("hermes-agent")
            .to_string_lossy()
            .to_string()
    ));
}
