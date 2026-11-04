use super::*;
use std::sync::atomic::{AtomicI64, Ordering};

fn response_count(f: &Fixture, id: &str) -> usize {
    responses_for(&f.records(), id).len()
}
fn clock(f: &Fixture) -> Arc<AtomicI64> {
    let clock = Arc::new(AtomicI64::new(now_ms().floor() as i64));
    set_recovery_clock(f, clock.clone());
    clock
}
fn bump_source_time(path: &str) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    let m = f.metadata().unwrap();
    f.set_times(
        std::fs::FileTimes::new().set_modified(m.modified().unwrap() + Duration::from_secs(1)),
    )
    .unwrap();
}
async fn measured_process(f: &Fixture, path: &str) -> u64 {
    f.rt().reset_read_accumulator_for_test();
    f.process(path).await;
    f.rt().reset_read_accumulator_for_test().raw_read_bytes
}

#[tokio::test]
async fn source_l220_large_failed_legacy_range_is_deferred_without_bodies_and_survives_restart() {
    source_budget(async {
        let case = pending_fixture(17 * 1024 * 1024).await;
        let mut cp = raw_checkpoint(&case.f, &case.path);
        let active = &mut cp["activeTurn"];
        active["emittedPrompt"] = json!(true);
        active["emittedStepCount"] = json!(7);
        for (key, id) in [
            ("emittedStepRequestIds", "request-before-failure"),
            ("emittedStepResponseIds", "response-before-failure"),
            ("emittedToolCallIds", "tool-before-failure"),
            ("emittedToolResultIds", "tool-before-failure"),
        ] {
            active[key] = json!([id]);
        }
        active["emittedTraceId"] = json!("a".repeat(32));
        let semantic = active.clone();
        put_checkpoint(&case.f, &case.path, cp);
        assert!(measured_process(&case.f, &case.path).await > 17 * 1024 * 1024);
        assert_eq!(response_count(&case.f, "later"), 1);
        let cp = raw_checkpoint(&case.f, &case.path);
        assert!(cp["pendingTerminal"].is_null());
        assert_eq!(cp["deferredTerminals"].as_array().unwrap().len(), 1);
        assert_eq!(
            cp["deferredTerminals"][0]["pendingTerminal"]["retryCount"],
            1
        );
        let revision = case.f.rt().state_store.revision();
        for _ in 0..3 {
            assert_eq!(measured_process(&case.f, &case.path).await, 0);
        }
        assert_eq!(case.f.rt().state_store.revision(), revision);
        case.f.rt().state_store.save().await.unwrap();
        assert!(std::fs::metadata(&case.path).unwrap().len() > case.end as u64);
        assert!(
            std::fs::metadata(case.f.root.path().join("state.json"))
                .unwrap()
                .len()
                < 16 * 1024
        );
        let restarted = case.f.restart().await;
        assert!(measured_process(&restarted, &case.path).await <= 64 * 1024);
        assert_eq!(measured_process(&restarted, &case.path).await, 0);
        assert!(restarted.records().is_empty());
        let cp = raw_checkpoint(&restarted, &case.path);
        assert_eq!(
            cp["deferredTerminals"][0]["pendingTerminal"]["retryCount"],
            1
        );
        let kept = &cp["deferredTerminals"][0]["activeTurn"];
        for key in [
            "emittedPrompt",
            "emittedStepCount",
            "emittedStepRequestIds",
            "emittedStepResponseIds",
            "emittedToolCallIds",
            "emittedToolResultIds",
            "emittedTraceId",
        ] {
            assert_eq!(kept[key], semantic[key], "{key}");
        }
    })
    .await;
}

#[tokio::test]
async fn source_l255_same_size_repaired_deferred_range_waits_for_backoff_and_emits_once() {
    source_budget(async {
        let case = pending_fixture(2 * 1024 * 1024).await;
        let clock = clock(&case.f);
        case.f.process(&case.path).await;
        let repaired = normal_turn("old", false);
        let fill = case.failed.len() - repaired.len();
        assert!(fill > 0);
        let text = case.header.clone()
            + &repaired
            + &" ".repeat(fill - 1)
            + "\n"
            + &normal_turn("later", false);
        let size = std::fs::metadata(&case.path).unwrap().len();
        tokio::fs::write(&case.path, text).await.unwrap();
        assert_eq!(std::fs::metadata(&case.path).unwrap().len(), size);
        bump_source_time(&case.path);
        assert_eq!(measured_process(&case.f, &case.path).await, 0);
        clock.fetch_add(1001, Ordering::SeqCst);
        case.f.process(&case.path).await;
        let cp = raw_checkpoint(&case.f, &case.path);
        assert!(cp.get("deferredTerminals").is_none());
        assert_eq!(response_count(&case.f, "old"), 1);
        assert_eq!(response_count(&case.f, "later"), 1);
        let records = case.f.records();
        let ids: std::collections::HashSet<_> = records
            .iter()
            .map(|e| e["event.id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), records.len());
        assert_eq!(measured_process(&case.f, &case.path).await, 0);
    })
    .await;
}

#[tokio::test]
async fn source_l273_unchanged_failed_version_is_not_retried_even_after_deadline() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let clock = clock(&case.f);
        case.f.process(&case.path).await;
        clock.fetch_add(3_600_000, Ordering::SeqCst);
        let cp = raw_checkpoint(&case.f, &case.path);
        let rev = case.f.rt().state_store.revision();
        assert_eq!(measured_process(&case.f, &case.path).await, 0);
        assert_eq!(raw_checkpoint(&case.f, &case.path), cp);
        assert_eq!(case.f.rt().state_store.revision(), rev);
        assert_eq!(
            cp["deferredTerminals"][0]["pendingTerminal"]["retryCount"],
            1
        );
    })
    .await;
}

#[tokio::test]
async fn source_l280_changing_failed_source_doubles_backoff_to_60_seconds_without_early_attempts() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let clock = clock(&case.f);
        case.f.process(&case.path).await;
        let warnings = capture_failures(&case.f);
        for i in 0..10 {
            let cp = raw_checkpoint(&case.f, &case.path);
            let deadline = cp["deferredTerminals"][0]["pendingTerminal"]["failure"]["retryAtMs"]
                .as_f64()
                .unwrap() as i64;
            case.f
                .append(
                    &case.path,
                    &row("event_msg", json!({"type":"unknown_append","index":i}), 0),
                )
                .await;
            clock.store(deadline, Ordering::SeqCst);
            case.f.process(&case.path).await;
            let cp = raw_checkpoint(&case.f, &case.path);
            let pending = &cp["deferredTerminals"][0]["pendingTerminal"];
            assert_eq!(pending["retryCount"], i + 2);
            assert!(pending["failure"]["delayMs"].as_u64().unwrap() <= 60_000);
        }
        let cp = raw_checkpoint(&case.f, &case.path);
        assert_eq!(
            cp["deferredTerminals"][0]["pendingTerminal"]["failure"]["delayMs"],
            60_000
        );
        let attempts = warnings.lock().unwrap().len();
        let recovery_calls = capture_recovery_ends(&case.f);
        case.f
            .append(
                &case.path,
                &row(
                    "event_msg",
                    json!({"type":"unknown_append","index":"not-due"}),
                    0,
                ),
            )
            .await;
        case.f.process(&case.path).await;
        assert_eq!(warnings.lock().unwrap().len(), attempts);
        assert!(
            recovery_calls.lock().unwrap().is_empty(),
            "no recover_turn_segment method entry before deadline"
        );
    })
    .await;
}

#[tokio::test]
async fn source_l297_full_deferred_capacity_retains_blocking_range_and_healthy_files_continue() {
    source_budget(async {
        let case=pending_fixture(1024).await;let mut cp=raw_checkpoint(&case.f,&case.path);
        let version=source_version_for(&case.path).await;
        let active=cp["activeTurn"].clone();
        cp["deferredTerminals"]=Value::Array((0..4).map(|i|{
            let id=format!("deferred-{i}");let mut a=active.clone();a["turnId"]=json!(id);
            json!({"activeTurn":a,"pendingTerminal":{"turnId":id,"terminalEndOffset":case.end,"failure":{"sourceVersion":if i==0{"previous-version"}else{&version},"retryAtMs":0,"delayMs":1000}}})
        }).collect());
        put_checkpoint(&case.f,&case.path,cp);
        let warnings=capture_failures(&case.f);case.f.process(&case.path).await;
        case.f.rt().state_store.save().await.unwrap();
        assert_eq!(pending_results(&case.f).last(),Some(&(true,1)));
        let cp=raw_checkpoint(&case.f,&case.path);
        assert_eq!(cp["deferredTerminals"].as_array().unwrap().len(),4);
        assert_eq!(cp["pendingTerminal"]["turnId"],"old");
        assert_eq!(cp["scanOffset"],case.end);
        assert_eq!(response_count(&case.f,"later"),0);
        let events=warnings.lock().unwrap().clone();
        for phase in ["pending","deferred"]{
            let e=events.iter().find(|e|e["meta"]["recoveryPhase"]==phase).unwrap();
            assert_eq!(e["message"],"Codex terminal turn could not be parsed; retained until source changes and backoff expires");
            let m=&e["meta"];assert_eq!(m["deferredRanges"],4);assert_eq!(m["deferredLimit"],4);assert_eq!(m["blocked"],true);assert_eq!(m["retryDelayMs"],if phase=="pending"{1000}else{2000});
            assert_eq!(m["range"],json!({"startOffset":case.header.len(),"endOffset":case.end}));
            if phase=="deferred"{assert_eq!(m["turnId"],"deferred-0");assert_eq!(m["blockingTurnId"],"old");assert_eq!(m["deferred"],true);}
            else{assert_eq!(m["turnId"],"old");assert_eq!(m["deferred"],false);}
        }
        let before=warnings.lock().unwrap().len();let revision=case.f.rt().state_store.revision();
        assert_eq!(measured_process(&case.f,&case.path).await,0);
        assert_eq!(pending_results(&case.f).last(),Some(&(true,0)));
        assert_eq!(warnings.lock().unwrap().len(),before);
        assert_eq!(case.f.rt().state_store.revision(),revision);
        let healthy=case.f.write("rollout-healthy.jsonl",&normal_turn("healthy",true)).await;
        case.f.process(&healthy).await;assert_eq!(response_count(&case.f,"healthy"),1);
    }).await;
}

#[tokio::test]
async fn source_l337_each_file_cycle_attempts_only_one_eligible_deferred_range() {
    source_budget(async {
        let case=pending_fixture(1024).await;let mut cp=raw_checkpoint(&case.f,&case.path);
        let active=cp["activeTurn"].clone();
        cp["deferredTerminals"]=Value::Array(["a","b"].into_iter().map(|id|{
            let mut a=active.clone();a["turnId"]=json!(id);
            json!({"activeTurn":a,"pendingTerminal":{"turnId":id,"terminalEndOffset":case.end,"failure":{"sourceVersion":"previous-version","retryAtMs":0,"delayMs":1000}}})
        }).collect());
        cp["pendingTerminal"]=Value::Null;cp["activeTurn"]=Value::Null;
        cp["scanOffset"]=json!(std::fs::metadata(&case.path).unwrap().len());
        put_checkpoint(&case.f,&case.path,cp);let calls=capture_recovery_ends(&case.f);
        case.f.process(&case.path).await;assert_eq!(calls.lock().unwrap().len(),1);
        let cp=raw_checkpoint(&case.f,&case.path);
        assert_eq!(cp["deferredTerminals"][0]["pendingTerminal"]["retryCount"],1);
        assert!(cp["deferredTerminals"][1]["pendingTerminal"].get("retryCount").is_none());
        calls.lock().unwrap().clear();case.f.process(&case.path).await;
        assert_eq!(calls.lock().unwrap().len(),1);
    }).await;
}

#[tokio::test]
async fn source_l376_recovered_ranges_leave_the_rest_then_omit_empty_deferred_field_durably() {
    source_budget(async {
        let f=Fixture::new();let first=normal_turn("first",true);let text=first.clone()+&normal_turn("second",false);
        let path=f.write("rollout-session.jsonl",&text).await;let(inode,size,_)=file_meta_snapshot(&path).await.unwrap();
        put_checkpoint(&f,&path,json!({"inode":inode,"scanOffset":size,"ownerSessionMetaOffset":0,"activeTurn":null,"pendingTerminal":null,"pendingFusion":null,"pendingSubagent":null,
            "deferredTerminals":[
                {"activeTurn":{"turnId":"first","startOffset":0,"startedAtMs":1_767_225_601_000_u64},"pendingTerminal":{"turnId":"first","terminalEndOffset":first.len()}},
                {"activeTurn":{"turnId":"second","startOffset":first.len(),"startedAtMs":1_767_225_601_000_u64},"pendingTerminal":{"turnId":"second","terminalEndOffset":size}}
            ]}));
        f.process(&path).await;let cp=raw_checkpoint(&f,&path);
        assert_eq!(cp["deferredTerminals"].as_array().unwrap().len(),1);assert_eq!(cp["deferredTerminals"][0]["activeTurn"]["turnId"],"second");
        assert_eq!(response_count(&f,"first"),1);assert_eq!(response_count(&f,"second"),0);
        f.process(&path).await;assert_eq!(response_count(&f,"second"),1);assert!(raw_checkpoint(&f,&path).get("deferredTerminals").is_none());
        f.rt().state_store.save().await.unwrap();f.rt().state_store.load().await;
        assert!(raw_checkpoint(&f,&path).get("deferredTerminals").is_none());assert_eq!(measured_process(&f,&path).await,0);
        assert_eq!(response_count(&f,"first"),1);assert_eq!(response_count(&f,"second"),1);
    }).await;
}

#[tokio::test]
async fn source_l441_processed_failed_and_gated_recovery_share_the_original_100_terminal_budget() {
    for mode in ["processed", "unparseable", "gated-pending"] {
        source_budget(async {
            let f=Fixture::new();
            let initial=if mode=="processed"{normal_turn("deferred",true)}else{owner_header()+&row("event_msg",json!({"type":"task_started","turn_id":"deferred"}),0)+&diagnostic()};
            let boundary=initial.len();
            let text=initial+(0..100).map(|i|normal_turn(&format!("turn-{i}"),false)).collect::<String>().as_str();
            let path=f.write("rollout-session.jsonl",&text).await;let(inode,size,_)=file_meta_snapshot(&path).await.unwrap();
            let retained=json!({"activeTurn":{"turnId":"deferred","startOffset":0,"startedAtMs":1_767_225_601_000_u64},"pendingTerminal":{"turnId":"deferred","terminalEndOffset":boundary}});
            let mut cp=json!({"inode":inode,"scanOffset":boundary,"ownerSessionMetaOffset":0,"activeTurn":null,"pendingTerminal":null,"pendingFusion":null,"pendingSubagent":null,"deferredTerminals":[retained.clone()]});
            if mode=="gated-pending"{
                cp["activeTurn"]=retained["activeTurn"].clone();cp["pendingTerminal"]=retained["pendingTerminal"].clone();
                cp["pendingTerminal"]["failure"]=json!({"sourceVersion":source_version_for(&path).await,"retryAtMs":now_ms().floor()+1_000_000.0,"delayMs":1000});
                cp["deferredTerminals"]=json!([]);
            }
            put_checkpoint(&f,&path,cp);f.process(&path).await;
            assert_eq!(response_count(&f,"turn-98"),1);
            assert_eq!(response_count(&f,"turn-99"),usize::from(mode=="gated-pending"));
            let total=f.records().iter().filter(|e|e["event.name"]=="llm.response").count();
            assert_eq!(total,if mode=="unparseable"{99}else{100});
            let cp=raw_checkpoint(&f,&path);
            if mode=="gated-pending"{assert_eq!(cp["scanOffset"],size);}
            else{assert!(cp["scanOffset"].as_i64().unwrap()<size);}
            f.process(&path).await;
            assert_eq!(response_count(&f,"turn-99"),1);assert_eq!(response_count(&f,"turn-98"),1);
        }).await;
    }
}

#[tokio::test]
async fn source_l475_legacy_deferred_range_records_one_real_attempt_and_restart_gating() {
    source_budget(async {
        let case = pending_fixture(1024).await;
        let clock = clock(&case.f);
        let first = clock.load(Ordering::SeqCst);
        let mut cp = raw_checkpoint(&case.f, &case.path);
        cp["deferredTerminals"] =
            json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
        cp["activeTurn"] = Value::Null;
        cp["pendingTerminal"] = Value::Null;
        cp["scanOffset"] = json!(std::fs::metadata(&case.path).unwrap().len());
        put_checkpoint(&case.f, &case.path, cp);
        let calls = capture_recovery_ends(&case.f);
        case.f.process(&case.path).await;
        assert_eq!(calls.lock().unwrap().len(), 1);
        let cp = raw_checkpoint(&case.f, &case.path);
        let pending = &cp["deferredTerminals"][0]["pendingTerminal"];
        assert!(pending.get("failure").is_some());
        assert_eq!(pending["firstPendingAtMs"].as_f64(), Some(first as f64));
        assert_eq!(pending["lastAttemptAtMs"].as_f64(), Some(first as f64));
        clock.fetch_add(3_600_000, Ordering::SeqCst);
        for _ in 0..3 {
            assert_eq!(measured_process(&case.f, &case.path).await, 0);
        }
        assert_eq!(calls.lock().unwrap().len(), 1);
        let restarted = case.f.restart().await;
        set_recovery_clock(&restarted, clock.clone());
        let calls = capture_recovery_ends(&restarted);
        let warnings = capture_failures(&restarted);
        restarted.process(&case.path).await;
        assert!(calls.lock().unwrap().is_empty());
        assert!(warnings.lock().unwrap().is_empty());
        assert_eq!(
            raw_checkpoint(&restarted, &case.path)["deferredTerminals"][0]["pendingTerminal"]
                ["retryCount"],
            1
        );
        restarted.append(&case.path, &diagnostic()).await;
        restarted.process(&case.path).await;
        assert_eq!(calls.lock().unwrap().len(), 1);
        let cp = raw_checkpoint(&restarted, &case.path);
        let pending = &cp["deferredTerminals"][0]["pendingTerminal"];
        assert_eq!(pending["firstPendingAtMs"].as_f64(), Some(first as f64));
        assert_eq!(
            pending["lastAttemptAtMs"].as_f64(),
            Some(clock.load(Ordering::SeqCst) as f64)
        );
        assert_eq!(pending["retryCount"], 2);
        let events = warnings.lock().unwrap().clone();
        let meta = &events.last().unwrap()["meta"];
        assert_eq!(meta["recoveryPhase"], "deferred");
        assert_eq!(meta["deferred"], true);
        assert_eq!(meta["blocked"], false);
        assert_eq!(
            meta["range"],
            json!({"startOffset":case.header.len(),"endOffset":case.end})
        );
        assert_eq!(meta["deferredRanges"], 1);
        assert_eq!(meta["deferredLimit"], 4);
        drop(events);
        restarted.rt().state_store.save().await.unwrap();
        restarted.rt().state_store.load().await;
        assert_eq!(
            raw_checkpoint(&restarted, &case.path)["deferredTerminals"][0]["pendingTerminal"]
                ["firstPendingAtMs"]
                .as_f64(),
            Some(first as f64)
        );
    })
    .await;
}

#[tokio::test]
async fn source_l874_terminal_pending_and_deferred_failure_use_one_clock_snapshot() {
    for phase in ["terminal", "pending", "deferred"] {
        source_budget(async {
            let case=pending_fixture(1024).await;let mut cp=raw_checkpoint(&case.f,&case.path);
            if phase=="deferred"{
                cp["deferredTerminals"]=json!([{"activeTurn":cp["activeTurn"],"pendingTerminal":cp["pendingTerminal"]}]);
                cp["activeTurn"]=Value::Null;cp["pendingTerminal"]=Value::Null;
            }else if phase=="terminal"{
                cp["pendingTerminal"]=Value::Null;
                // The source explicitly injects an unparseable converter result
                // for this one branch; retain that fault at the real entry.
                case.f.input.inner.body.with_shared(|s|s.main543_force_terminal_failure=true);
            }
            put_checkpoint(&case.f,&case.path,cp);
            let clock=Arc::new(AtomicI64::new(now_ms().floor()as i64));
            case.f.input.inner.body.with_shared(|shared|{
                let clock=clock.clone();shared.main543_clock=Some(Arc::new(move||clock.fetch_add(1,Ordering::SeqCst)as f64));
            });
            case.f.process(&case.path).await;
            let cp=raw_checkpoint(&case.f,&case.path);
            let pending=&cp["deferredTerminals"][0]["pendingTerminal"];
            assert_eq!(pending["firstPendingAtMs"],pending["lastAttemptAtMs"]);
            assert_eq!(pending["failure"]["retryAtMs"].as_f64().unwrap(),pending["lastAttemptAtMs"].as_f64().unwrap()+pending["failure"]["delayMs"].as_f64().unwrap());
        }).await;
    }
}

#[tokio::test]
async fn source_l898_valid_legacy_terminal_recovers_directly_without_a_deferred_range() {
    source_budget(async {
        let f=Fixture::new();let text=normal_turn("normal",true);let path=f.write("rollout-session.jsonl",&text).await;
        let(inode,size,_)=file_meta_snapshot(&path).await.unwrap();
        put_checkpoint(&f,&path,json!({"inode":inode,"scanOffset":size,"ownerSessionMetaOffset":0,"activeTurn":{"turnId":"normal","startOffset":0,"startedAtMs":1_767_225_601_000_u64},
            "pendingTerminal":{"turnId":"normal","terminalEndOffset":size},"pendingFusion":null,"pendingSubagent":null}));
        f.process(&path).await;assert_eq!(response_count(&f,"normal"),1);
        let cp=raw_checkpoint(&f,&path);assert!(cp.get("deferredTerminals").is_none());assert!(cp["pendingTerminal"].is_null());
    }).await;
}
