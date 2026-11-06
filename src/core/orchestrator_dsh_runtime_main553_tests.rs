//! Exercise the product DSH caller bridge through actual poll IO and local L2 output.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;

#[tokio::test]
async fn actual_dsh_poll_runtime_delta_reaches_registered_input_and_local_metrics_through_attach_hook(
) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let session_dir = root.path().join("logs").join("dsh");
        tokio::fs::create_dir_all(&session_dir).await.unwrap();
        let source = session_dir.join("dsh-metrics-caller.jsonl");
        let records = [
            json!({"type":"turn/start","sid":"dsh-caller","time":1,"data":{"turn":1}}),
            json!({"type":"step/start","sid":"dsh-caller","time":2,"data":{"turn":1,"step":1}}),
            json!({"type":"user/message","sid":"dsh-caller","time":3,"data":{"content":[{"type":"text","text":"synthetic prompt"}]}}),
            json!({"type":"request/header","sid":"dsh-caller","time":4,"data":{"header":{"config":{"provider":"test-provider","model":"test-model"},"system":"synthetic system"}}}),
            json!({"type":"request/context","sid":"dsh-caller","time":5,"data":{"provider":"test-provider","model":"test-model"}}),
            json!({"type":"assistant/message","sid":"dsh-caller","time":11,"data":{"turn":1,"step":1,
                "message":{"id":"response-1","source":{"provider":"test-provider","model":"test-model"},"content":[{"type":"text","text":"synthetic answer"}]},
                "usage":{"inputTokens":10,"outputTokens":5},"stream":[
                    {"type":"chunk","time":7,"chunk":{"type":"block-start","index":0,"blockType":"text"}},
                    {"type":"text-chunks","time0":8,"index":0,"dt":[1],"texts":["synthetic answer"]},
                    {"type":"chunk","time":10,"chunk":{"type":"finish","reason":{"kind":"stop"}}}
                ]}}),
            json!({"type":"turn/end","sid":"dsh-caller","time":12,"data":{"turn":1}}),
        ];
        let text = records.iter().map(|row| row.to_string()+"\n").collect::<String>();
        tokio::fs::write(&source, text.as_bytes()).await.unwrap();
        let env = HashMap::new();
        let file = json!({"dataDir":root.path(),"dashboard":{"enabled":false},
            "autoUpdate":{"enabled":false},"jsonl":{"enabled":false}});
        let mut config = super::super::config_loader::assemble_config(
            Some(&file), None, &super::super::config_loader::ConfigSources {
                env:&env, platform:crate::utils::Platform::current(),
                hostname:"dsh-caller-fixture", config_path:"dsh-caller-fixture.json", global_poll_ms:None,
            },
        ).unwrap();
        config.flushers = crate::types::FlusherConfig::default();
        config.collect_log = false;
        config.collect_trace = false;
        config.otlp_trace = None;
        config.inner_trace = None;
        let orchestrator = Orchestrator::new(config);
        let attributes = Arc::new(Mutex::new(GlobalAttributesProvider::new(
            &serde_json::Map::new(), orchestrator.data_dir_join("span-attributes.json"),
        )));
        let (flusher, sls, otlp) = orchestrator.build_flusher(attributes).await.unwrap();
        assert!(sls.is_none());
        assert!(otlp.is_none());
        assert_eq!(flusher.name(), "jsonl");
        orchestrator.inputs.set_flusher(flusher.clone());
        *orchestrator.flusher.lock().unwrap() = Some(flusher.clone());
        let store = Arc::new(StateStore::new(root.path().join("input-state.json")));
        orchestrator.inputs.set_state_store(store.clone());
        let mut detection = Vec::new();
        orchestrator.attach_hook(
            &mut detection, "dsh-log", "dsh",
            DshLogInput::new(SessionInputOptions {
                state_store:store.clone(),
                session_dir:Some(session_dir.to_string_lossy().into_owned()),
                file_pattern:None, poll_interval_ms:Some(60_000),
            }),
            vec![session_dir.to_string_lossy().into_owned()], || async {true},
        ).await;
        assert_eq!(detection.len(),1);
        let registered = orchestrator.inputs.get_input("dsh-log").unwrap();
        assert_eq!(registered.runtime_info().unwrap().source_paths,
            vec![session_dir.to_string_lossy().into_owned()]);
        assert_eq!(registered.runtime_info().unwrap().poll_interval_ms,60_000);
        orchestrator.inputs.start_input("dsh-log").await;
        // Observe real file progress and entry acceptance first. Waiting for the
        // metrics themselves would hide a missing bridge behind a timeout.
        let state_key = format!("dsh-log:{}", source.to_string_lossy());
        loop {
            let counters = orchestrator.inputs.get_input_counters();
            if store.get_offset(&state_key)==text.len() as f64
                && counters.get("dsh-log").is_some_and(|counter|counter.in_events>=2) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let counters = orchestrator.inputs.get_input_counters();
        let counter = counters.get("dsh-log").unwrap().clone();
        let active = orchestrator.inputs.get_active_input_ids();
        let writer = orchestrator.metrics_writer(
            "2.0.0",Arc::new(AlarmManager::new("127.0.0.1","2.0.0","dsh-fixture")),
        );
        writer.write_l2().await;
        orchestrator.inputs.stop_input("dsh-log").await;
        flusher.shutdown().await.unwrap();
        let metric_rows = std::fs::read_dir(root.path().join("logs").join("metric_alarm")).unwrap()
            .filter_map(Result::ok)
            .filter(|entry|entry.file_name().to_string_lossy().starts_with("pilot-input-metrics-"))
            .flat_map(|entry|std::fs::read_to_string(entry.path()).unwrap().lines()
                .map(|line|serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let row = metric_rows.iter().find(|row|row["input_name"]=="dsh-log").unwrap();
        assert!(active.contains(&"dsh-log".to_string()));
        assert!(!orchestrator.inputs.get_active_input_ids().contains(&"dsh-log".to_string()));
        assert_eq!(store.get_offset(&state_key),text.len()as f64);
        assert!(counter.raw_read_calls>0,"actual DSH poll did not reach InputManager runtime bridge");
        assert!(counter.raw_read_bytes>=text.len()as u64);
        assert_eq!(counter.raw_in_records,records.len()as u64);
        assert_eq!(counter.raw_in_bytes,text.len()as u64);
        assert_eq!(counter.parse_success_records,records.len()as u64);
        assert_eq!(counter.parse_failed_records,0);
        assert_eq!(counter.source_kind,"primary");
        assert_eq!(row["agent"],"dsh");
        assert_eq!(row["collection_method"],"session-file-polling");
        for (field,expected) in [
            ("raw_read_calls",counter.raw_read_calls),
            ("raw_read_bytes",counter.raw_read_bytes),
            ("raw_in_records",counter.raw_in_records),
            ("raw_in_bytes",counter.raw_in_bytes),
            ("parse_success_records",counter.parse_success_records),
            ("parse_failed_records",0),
        ] {
            assert_eq!(row[field],expected.to_string(),"{field} must flow through the product snapshot and writer");
        }
    }).await.expect("original global15s case budget; no external services");
}
