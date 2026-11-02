//! Exact Work Hook source contracts through actual public input and real JSONL.
use super::*;
use crate::checkpoints::StateStore;
async fn drain(records: Value, cn: bool) -> (Vec<Value>, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let kind = if cn {
        ClientType::QoderWorkCN
    } else {
        ClientType::QoderWork
    };
    let prefix = kind.as_str();
    let text = records
        .as_array()
        .unwrap()
        .iter()
        .map(|v| format!("{v}\n"))
        .collect::<String>();
    std::fs::write(
        root.join(format!(
            "{prefix}-{}.jsonl",
            crate::utils::get_today_date_string()
        )),
        text,
    )
    .unwrap();
    let input = QoderWorkInput::new(QoderWorkOptions {
        state_store: Arc::new(StateStore::new(root.join("state.json"))),
        log_dir: Some(root.to_string_lossy().into_owned()),
        log_prefix: Some(prefix.to_owned()),
        poll_interval_ms: Some(60000),
        agent_type: Some(kind),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let copy = events.clone();
    input.bind_collector(
        move |batch| {
            copy.lock()
                .unwrap()
                .extend(batch.iter().map(|e| serde_json::to_value(e).unwrap()))
        },
        |_| {},
    );
    input.start().await.unwrap();
    input.stop().await.unwrap();
    let version = input.agent_version();
    let entries = events.lock().unwrap().clone();
    (entries, version)
}

#[tokio::test]
async fn source_l37_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"write_to_file","tool_input":{"file_path":"/src/app.ts","content":"hello"},"session_id":"sess-1","user_id":"u1","timestamp":1777000000000}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(
        r#"{"gen_ai.agent.type":"qoder-work","agent.file_path":"/src/app.ts"}"#,
    )
    .unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l60_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"hookEvent":"PostToolUse","data":{"hook_event_name":"PostToolUse","tool_name":"create_file","tool_input":{"file_path":"/new.ts","content":"export const x = 1;"},"loongsuite_pilot_pre_file_exists":false,"session_id":"sess-2","timestamp":1777000000000}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.action_type":"create"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l85_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PreToolUse","tool_name":"read_file","tool_input":{"file_path":"/a.ts"}},{"event_type":"failure","error":"timeout"},{"event_type":null}]"#).unwrap(),false).await;
    assert!(entries.is_empty());
    let _ = version;
}

#[tokio::test]
async fn source_l105_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"create_file","tool_input":{"file_path":"/new-file.ts","content":"new"},"session_id":"sess-1","user_id":"u1","timestamp":1777000000000,"loongsuite_pilot_pre_file_exists":false}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.action_type":"create"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l127_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"write_to_file","tool_input":{"file_path":"/existing.ts","content":"updated"},"session_id":"sess-1","user_id":"u1","timestamp":1777000000000,"loongsuite_pilot_pre_file_exists":true}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.action_type":"edit"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l151_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"bash","tool_input":{"command":"ls"},"session_id":"sess-1","timestamp":1777000000000}]"#).unwrap(),false).await;
    assert!(entries.is_empty());
    let _ = version;
}

#[tokio::test]
async fn source_l185_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event.id":"canonical-work-1","event.name":"llm.response","time_unix_nano":"1777628163513000000","observed_time_unix_nano":"1777628163513000000","user.id":"u-work","gen_ai.agent.type":"qoder-work","gen_ai.session.id":"sess-work","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"hello work"}]}],"agent.source":"qoder-transcript-hook","agent.qoderwork.cwd":"/workspace/qoder-work"}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.id":"canonical-work-1","event.name":"llm.response","user.id":"u-work","gen_ai.agent.type":"qoder-work","gen_ai.session.id":"sess-work","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"hello work"}]}],"workspace.path":"/workspace/qoder-work"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l219_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"user","session_id":"sess-user","timestamp":1777000000000,"message":{"role":"user","content":"hello qoder work"},"cwd":"/tmp/ws","parentUuid":"p-1","userType":"external","user_id":"u1"}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"gen_ai.agent.type":"qoder-work","agent._ctype":"text","agent._ctext":"hello qoder work","agent.cwd":"/tmp/ws","agent.parent_uuid":"p-1","agent.user_type":"external","agent.row_type":"user"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    assert!(entries[0].get("agent.type").is_none(), "agent.type");
    assert!(entries[0].get("agent.role").is_none(), "agent.role");
    assert!(entries[0].get("agent.content").is_none(), "agent.content");
    assert!(entries[0].get("agent.model").is_none(), "agent.model");
    assert!(
        entries[0].get("agent.stop_reason").is_none(),
        "agent.stop_reason"
    );
    assert!(
        entries[0].get("agent.file_path").is_none(),
        "agent.file_path"
    );
    assert!(
        entries[0].get("agent.action_type").is_none(),
        "agent.action_type"
    );
    let _ = version;
}

#[tokio::test]
async fn source_l255_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"user","session_id":"sess-user","timestamp":1777000000000,"message":{"role":"user","content":"你好"}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.name":"llm.request","gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"你好"}]}]}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    assert!(
        entries[0].get("gen_ai.output.messages").is_none(),
        "gen_ai.output.messages"
    );
    let _ = version;
}

#[tokio::test]
async fn source_l270_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"assistant","session_id":"sess-assistant","timestamp":1777000000000,"message":{"role":"assistant","content":[{"type":"text","text":"我是 QoderWork"}],"id":"msg-42","stop_reason":"end_turn"}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.name":"llm.response","gen_ai.response.id":"msg-42","gen_ai.response.finish_reasons":["end_turn"],"gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"我是 QoderWork"}],"finish_reason":"end_turn"}]}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l295_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"assistant","session_id":"sess-assistant","timestamp":1777000000000,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"用户在问名字…"}]}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.name":"llm.response","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"reasoning","content":"用户在问名字…"}]}]}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l312_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"assistant","session_id":"sess-assistant","timestamp":1777000000000,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"ls"}}]}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.name":"tool.call","gen_ai.tool.name":"Bash","gen_ai.tool.call.id":"toolu_01","gen_ai.tool.call.arguments":{"command":"ls"}}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l334_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"type":"user","session_id":"sess-user","timestamp":1777000000000,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file1\nfile2"}]}}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected:Value=serde_json::from_str(r#"{"event.name":"tool.result","gen_ai.tool.call.id":"toolu_01","gen_ai.tool.call.result":"file1\nfile2"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l356_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"create_file","tool_input":{"file_path":"/f.ts","content":"const x = 42;"},"session_id":"sess-1","user_id":"u1","timestamp":1777000000000,"loongsuite_pilot_pre_file_exists":false}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.content":"const x = 42;"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l377_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"str_replace_editor","tool_input":{"file_path":"/f.ts","new_string":"replaced text"},"session_id":"sess-1","timestamp":1777000000000}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.content":"replaced text"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l423_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"create_file","tool_input":{"file_path":"/src/cn.ts","content":"cn content"},"session_id":"sess-cn-1","user_id":"cn-user","timestamp":1777000000000}]"#).unwrap(),true).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"gen_ai.agent.type":"qoder-work-cn"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    let _ = version;
}

#[tokio::test]
async fn source_l447_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event.id":"ver-test-1","event.name":"llm.response","gen_ai.agent.type":"qoder-work","gen_ai.session.id":"sess-ver","version":"1.2.3","agent.qoderwork.version":"1.2.3","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"hi"}]}]}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{"agent.qoderwork.version":"1.2.3"}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    assert!(entries[0].get("version").is_none(), "version");
    assert_eq!(version, "1.2.3");
}

#[tokio::test]
async fn source_l473_literal_work_hook_contract() {
    let (entries,version)=drain(serde_json::from_str(r#"[{"event_type":"PostToolUse","tool_name":"write_to_file","tool_input":{"file_path":"/src/app.ts","content":"hello"},"session_id":"sess-1","user_id":"u1","timestamp":1777000000000,"version":"2.0.0"}]"#).unwrap(),false).await;
    assert_eq!(entries.len(), 1);
    let expected: Value = serde_json::from_str(r#"{}"#).unwrap();
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(entries[0].get(key), Some(value), "{key}");
    }
    assert!(entries[0].get("agent.version").is_none(), "agent.version");
    assert!(entries[0].get("version").is_none(), "version");
    let _ = version;
}

#[tokio::test]
async fn source_l418_cn_constructor_identity_is_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let input = QoderWorkInput::new(QoderWorkOptions {
        state_store: Arc::new(StateStore::new(temp.path().join("state.json"))),
        log_dir: Some(temp.path().to_string_lossy().into_owned()),
        log_prefix: Some("qoder-work-cn".into()),
        poll_interval_ms: Some(60000),
        agent_type: Some(ClientType::QoderWorkCN),
    });
    assert_eq!(input.id(), "qoder-work-cn-hook");
    assert_eq!(input.agent_type(), ClientType::QoderWorkCN);
}
