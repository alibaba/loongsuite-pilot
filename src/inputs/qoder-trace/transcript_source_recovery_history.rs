use super::super::super::prompt_ownership::{QoderOwnershipRow, QoderPromptOwnership};
use super::*;
use async_trait::async_trait;
struct ReviewResolver {
    rows: Vec<QoderOwnershipRow>,
    available: Arc<AtomicBool>,
    page: usize,
    missing_session: Option<String>,
}
#[async_trait]
impl QoderPromptOwnershipResolver for ReviewResolver {
    async fn resolve(
        &self,
        _agent: &str,
        session: &str,
        _request: &str,
        cursor: Option<&QoderOwnershipCursor>,
        _search: &mut QoderOwnershipSearch,
    ) -> Option<QoderPromptOwnership> {
        if !self.available.load(Ordering::SeqCst)
            || self.missing_session.as_deref() == Some(session)
        {
            return None;
        }
        let after = cursor.map(|c| c.at).unwrap_or(0.0);
        let rest = self
            .rows
            .iter()
            .filter(|r| r.at > after)
            .cloned()
            .collect::<Vec<_>>();
        let complete = rest.len() <= self.page;
        Some(QoderPromptOwnership {
            inventory_id: "synthetic-db".into(),
            rows: rest.into_iter().take(self.page).collect(),
            complete,
            reset: None,
        })
    }
}
fn at(index: i64) -> f64 {
    (1793592000000_i64 + index * 10000) as f64
}
fn review_turn(index: i64, text: Option<&str>) -> Vec<Value> {
    let stamp = chrono::DateTime::from_timestamp_millis(at(index) as i64)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    vec![
        json!({"type":"user","uuid":format!("user-{index}"),"timestamp":stamp,"message":{"role":"user","content":text.map(str::to_owned).unwrap_or_else(||format!("prompt-{index}"))}}),
        json!({"type":"assistant","timestamp":stamp,"message":{"id":format!("response-{index}"),"model":"synthetic-model","role":"assistant","content":[{"type":"text","text":format!("answer-{index}")}],"stop_reason":"end_turn"}}),
        json!({"type":"last-prompt"}),
    ]
}
fn proof(rows: &[(i64, &str)]) -> Arc<dyn QoderPromptOwnershipResolver> {
    Arc::new(ReviewResolver {
        rows: rows
            .iter()
            .map(|(i, id)| QoderOwnershipRow {
                request_id: (*id).into(),
                at: at(*i),
            })
            .collect(),
        available: Arc::new(AtomicBool::new(true)),
        page: usize::MAX,
        missing_session: None,
    })
}
async fn configure(f: &Fixture, resolver: Arc<dyn QoderPromptOwnershipResolver>) {
    let mut c = f.source.inner.lock().await;
    c.stable_ms = 0;
    c.settle_ms = 0;
    c.scan_bytes = 64 * 1024;
    c.max_turn_bytes = 128 * 1024;
    c.resolver = resolver;
}
async fn review_fixture(agent: &str, resolver: Arc<dyn QoderPromptOwnershipResolver>) -> Fixture {
    let f = Fixture::new(agent).await;
    configure(&f, resolver).await;
    f
}
fn empty_proof() -> Arc<dyn QoderPromptOwnershipResolver> {
    Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new()))
}
async fn reset(f: &mut Fixture, resolver: Arc<dyn QoderPromptOwnershipResolver>) {
    f.restart().await;
    configure(f, resolver).await;
}
fn wake(f: &Fixture, event: &str, request: Option<&str>) {
    let empty = Map::new();
    let mut payload =
        json!({"session_id":"session","transcript_path":f.file,"hook_event_name":event});
    if let Some(request) = request {
        payload["request_set_id"] = json!(request);
    }
    assert!(crate::hook_process::publish_qoder_wakeup(
        &payload, &f.root, &f.agent, None, &empty, &empty
    ));
}
async fn drain(f: &mut Fixture, cycles: usize) -> Vec<Value> {
    let mut rows = Vec::new();
    for _ in 0..cycles {
        rows.extend(f.collect().await.records);
    }
    rows
}
fn contains(rows: &[Value], s: &str) -> bool {
    serde_json::to_string(rows).unwrap().contains(s)
}
fn legacy_lines(f: &Fixture, lines: usize) {
    let d = f
        .root
        .join("state/hooks")
        .join(format!("{}-line-records", f.agent));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(
        d.join(format!("{}.json", hex::encode(Sha256::digest(b"session")))),
        json!({"session_id":"session","transcript_path":f.file,"last_line_count":lines})
            .to_string(),
    )
    .unwrap();
}
#[tokio::test]
async fn recovery_l40_bootstrap_over_limit_row_drains_when_lf_and_real_next_turn_arrive() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        std::fs::write(&f.file, "x".repeat(512 * 1024)).unwrap();
        wake(&f, "UserPromptSubmit", None);
        drain(&mut f, 4).await;
        f.append_bytes(b"\n");
        f.append(&review_turn(1, None));
        wake(&f, "Stop", None);
        let events = drain(&mut f, 16).await;
        assert_eq!(count(&events, "llm.response"), 1);
        assert!(contains(&events, "answer-1"));
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l52_damaged_records_preserve_physical_file_drain_two_turns_and_restart_without_replay(
) {
    for agent in ["qoder", "qoder-cn"] {
        for bad in [
            "{broken}".to_owned(),
            json!({"padding":"x".repeat(256*1024)}).to_string(),
        ] {
            let mut f = review_fixture(agent, empty_proof()).await;
            f.write(&review_turn(0, None)[..1]);
            wake(&f, "UserPromptSubmit", None);
            f.collect().await;
            f.append_bytes(format!("{bad}\n").as_bytes());
            f.append(&[review_turn(1, None), review_turn(2, None)].concat());
            wake(&f, "Stop", None);
            let events = drain(&mut f, 24).await;
            assert!(contains(&events, "answer-1"));
            assert!(contains(&events, "answer-2"));
            assert_eq!(count(&events, "llm.response"), 2);
            assert!(!f.state[&f.key]["quarantines"]
                .as_array()
                .unwrap()
                .is_empty());
            reset(&mut f, empty_proof()).await;
            assert!(f.collect().await.records.is_empty());
            assert!(std::fs::read_to_string(&f.file).unwrap().contains(&bad));
        }
    }
}
#[tokio::test]
async fn recovery_l68_pending_over_limit_physical_progress_survives_restart_without_ack_or_full_reread(
) {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        f.write(&review_turn(0, None)[..1]);
        wake(&f, "UserPromptSubmit", None);
        f.collect().await;
        f.append_bytes(
            json!({"padding":"x".repeat(512*1024)})
                .to_string()
                .as_bytes(),
        );
        drain(&mut f, 6).await;
        assert!(number(&f.state[&f.key]["pendingLine"], "position") > 128 * 1024);
        reset(&mut f, empty_proof()).await;
        assert!(f.collect().await.metrics.bytes_read < 128 * 1024);
        f.append_bytes(b"\n");
        f.append(&review_turn(1, None));
        wake(&f, "Stop", None);
        let events = drain(&mut f, 12).await;
        assert_eq!(count(&events, "llm.response"), 1);
        assert!(contains(&events, "answer-1"));
    }
}
#[tokio::test]
async fn recovery_l85_damaged_legacy_rows_count_as_physical_lines() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        let mut bytes = b"{broken}\n".to_vec();
        bytes.extend(jsonl(
            &[vec![json!({"type":"last-prompt"})], review_turn(1, None)].concat(),
        ));
        std::fs::write(&f.file, bytes).unwrap();
        legacy_lines(&f, 2);
        wake(&f, "Stop", None);
        assert!(contains(&f.collect().await.records, "answer-1"));
    }
}
#[tokio::test]
async fn recovery_l95_eperm_existence_still_checks_real_pid_birth_and_reports_reused_lock() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        f.write(&review_turn(0, None));
        wake(&f, "Stop", None);
        let lock = qoder_legacy_retry_lock_path(&f.root, &f.file);
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        let birth = process_birth::birth_ms(std::process::id()).unwrap();
        std::fs::write(
            lock,
            json!({"pid":std::process::id(),"startedAt":birth-120000.0}).to_string(),
        )
        .unwrap();
        let probes = Arc::new(AtomicU64::new(0));
        let p = probes.clone();
        f.source.inner.lock().await.owner_pid_probe = Some(Arc::new(move |_| {
            p.fetch_add(1, Ordering::SeqCst);
            Err(1)
        }));
        assert!(contains(&f.collect().await.records, "answer-0"));
        assert!(probes.load(Ordering::SeqCst) > 0);
        assert!(f
            .source
            .inner
            .lock()
            .await
            .warned
            .keys()
            .any(|k| k.contains("legacy-lock-pid-reused")));
    }
}
#[tokio::test]
async fn recovery_l106_live_eperm_owner_does_not_starve_two_reused_pid_sources() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        let acquired = f.clock.load(Ordering::SeqCst) as f64;
        let birth = process_birth::birth_ms(std::process::id()).unwrap();
        f.clock.fetch_add(120000, Ordering::SeqCst);
        let empty = Map::new();
        for i in 0..3 {
            let file = f.root.join(format!("owner-{i}.jsonl"));
            std::fs::write(&file, jsonl(&review_turn(i, None))).unwrap();
            assert!(crate::hook_process::publish_qoder_wakeup(
                &json!({"session_id":format!("owner-{i}"),"transcript_path":file,"hook_event_name":"Stop"}),
                &f.root,
                agent,
                None,
                &empty,
                &empty
            ));
            let lock = qoder_legacy_retry_lock_path(&f.root, &file);
            std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
            std::fs::write(
                lock,
                json!({"pid":std::process::id(),"startedAt":if i==0{acquired}else{birth-120000.0}})
                    .to_string(),
            )
            .unwrap();
        }
        f.source.inner.lock().await.owner_pid_probe = Some(Arc::new(|_| Err(1)));
        let mut events = Vec::new();
        for _ in 0..6 {
            events.extend(f.collect().await.records);
            f.clock.fetch_add(6000, Ordering::SeqCst);
        }
        assert!(!contains(&events, "answer-0"));
        assert_eq!(count(&events, "llm.response"), 2);
        assert!(contains(&events, "answer-1"));
        assert!(contains(&events, "answer-2"));
    }
}
#[tokio::test]
async fn recovery_l128_late_initial_prompt_uses_metadata_request_identity() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, proof(&[(0, "owned-request-0")])).await;
        f.write(&review_turn(0, None));
        wake(&f, "UserPromptSubmit", Some("owned-request-0"));
        assert!(contains(&f.collect().await.records, "answer-0"));
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l136_proven_initial_range_crosses_damaged_record_and_restart_without_replaying_live_turn(
) {
    for agent in ["qoder", "qoder-cn"] {
        for bad in [
            "{broken}".to_owned(),
            json!({"padding":"x".repeat(256*1024)}).to_string(),
        ] {
            let resolver = proof(&[(0, "owned-0")]);
            let mut f = review_fixture(agent, resolver.clone()).await;
            let mut bytes = jsonl(&review_turn(0, None)[..2]);
            bytes.extend(format!("{bad}\n").as_bytes());
            bytes.extend(jsonl(&review_turn(0, None)[2..]));
            std::fs::write(&f.file, bytes).unwrap();
            wake(&f, "UserPromptSubmit", Some("owned-0"));
            let mut recovered = Vec::new();
            for i in 0..16 {
                let batch = f.collect().await;
                assert!(batch.metrics.bytes_read < 128 * 1024);
                recovered.extend(batch.records);
                if i == 1 {
                    reset(&mut f, resolver.clone()).await;
                }
            }
            assert_eq!(count(&recovered, "llm.response"), 1);
            assert!(contains(&recovered, "answer-0"));
            assert!(recovered
                .iter()
                .all(|r| flag(r, "agent.transcript_incomplete")));
            assert!(f.state[&f.key].get("initialOwnership").is_none());
            assert!(std::fs::read_to_string(&f.file).unwrap().contains(&bad));
            f.append(&review_turn(1, None));
            wake(&f, "Stop", Some("owned-1"));
            let live = drain(&mut f, 8).await;
            assert_eq!(count(&live, "llm.response"), 1);
            assert!(contains(&live, "answer-1"));
            assert!(live.iter().all(|r| !flag(r, "agent.transcript_incomplete")));
            let all = [recovered, live].concat();
            unique(&all);
            reset(&mut f, resolver).await;
            assert!(f.collect().await.records.is_empty());
        }
    }
}
#[tokio::test]
async fn recovery_l163_damaged_line_cannot_steal_a_different_inventory_prompt() {
    for agent in ["qoder", "qoder-cn"] {
        let resolver = Arc::new(ReviewResolver {
            rows: vec![
                QoderOwnershipRow {
                    request_id: "missing-user".into(),
                    at: at(0),
                },
                QoderOwnershipRow {
                    request_id: "real-user".into(),
                    at: at(0) + 1.0,
                },
            ],
            available: Arc::new(AtomicBool::new(true)),
            page: usize::MAX,
            missing_session: None,
        });
        let mut f = review_fixture(agent, resolver).await;
        let mut rows = review_turn(0, None);
        rows[0]["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(at(0) as i64 + 1)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let mut bytes = b"{broken-user}\n".to_vec();
        bytes.extend(jsonl(&rows));
        std::fs::write(&f.file, bytes).unwrap();
        wake(&f, "UserPromptSubmit", Some("missing-user"));
        for _ in 0..8 {
            assert!(f.collect().await.records.is_empty());
        }
        let cp = &f.state[&f.key];
        assert!(cp.get("initialOwnership").is_some());
        assert!(cp.get("backfill").is_none());
        assert_eq!(number(cp, "committedOffset"), 0);
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        assert!(std::fs::read_dir(
            f.root
                .join("state/qoder-transcripts")
                .join(agent)
                .join("sources")
        )
        .unwrap()
        .next()
        .is_some());
    }
}
#[tokio::test]
async fn recovery_l179_migrates_consumed_legacy_no_lf_terminal_or_over_limit_tail_before_live_suffix(
) {
    for agent in ["qoder", "qoder-cn"] {
        for oversized in [false, true] {
            let mut f = review_fixture(agent, empty_proof()).await;
            let mut bytes = jsonl(&review_turn(0, None)[..2]);
            bytes.extend(if oversized {
                "x".repeat(256 * 1024).into_bytes()
            } else {
                serde_json::to_vec(&json!({"type":"last-prompt"})).unwrap()
            });
            std::fs::write(&f.file, &bytes).unwrap();
            legacy_lines(&f, 3);
            wake(&f, "Stop", None);
            for _ in 0..8 {
                let batch = f.collect().await;
                assert!(batch.records.is_empty());
                assert!(batch.metrics.bytes_read < 128 * 1024);
            }
            let cp = &f.state[&f.key];
            assert!(cp.get("migration").is_none());
            assert_eq!(
                number(cp, "committedOffset"),
                std::fs::metadata(&f.file).unwrap().len()
            );
            assert!(cp.get("pendingLine").is_none());
            f.append_bytes(b"\n");
            f.append(&review_turn(1, None));
            wake(&f, "Stop", None);
            let events = drain(&mut f, 8).await;
            assert_eq!(count(&events, "llm.response"), 1);
            assert!(contains(&events, "answer-1"));
            assert!(!contains(&events, "answer-0"));
        }
    }
}
#[tokio::test]
async fn recovery_l201_ordinary_partial_native_row_remains_uncommitted_until_complete() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        f.write(&review_turn(0, None)[..1]);
        wake(&f, "UserPromptSubmit", None);
        f.collect().await;
        let body = serde_json::to_vec(&review_turn(0, None)[1]).unwrap();
        let middle = body.len() / 2;
        f.append_bytes(&body[..middle]);
        wake(&f, "Stop", None);
        for _ in 0..4 {
            assert!(f.collect().await.records.is_empty());
        }
        assert_eq!(number(&f.state[&f.key], "committedOffset"), 0);
        f.append_bytes(&body[middle..]);
        f.append_bytes(b"\n");
        f.append(&review_turn(0, None)[2..]);
        wake(&f, "Stop", None);
        assert_eq!(count(&f.collect().await.records, "llm.response"), 1);
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l215_equal_prompt_text_does_not_claim_history_before_owned_next_user_is_written()
{
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(
            agent,
            proof(&[(0, "owned-request-0"), (1, "owned-request-1")]),
        )
        .await;
        f.write(&review_turn(0, Some("same prompt")));
        wake(&f, "UserPromptSubmit", Some("owned-request-1"));
        assert!(f.collect().await.records.is_empty());
        assert_eq!(number(&f.state[&f.key], "committedOffset"), 0);
        f.append(&review_turn(1, Some("same prompt")));
        wake(&f, "Stop", Some("owned-request-1"));
        let events = f.collect().await.records;
        assert!(contains(&events, "answer-1"));
        assert!(!contains(&events, "answer-0"));
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l226_ambiguous_initial_range_retains_unresolved_prompt_at_zero_committed_offset()
{
    for agent in ["qoder", "qoder-cn"] {
        let mut f = review_fixture(agent, empty_proof()).await;
        f.write(&review_turn(0, None));
        wake(&f, "UserPromptSubmit", None);
        assert!(f.collect().await.records.is_empty());
        let cp = &f.state[&f.key];
        assert_eq!(number(cp, "committedOffset"), 0);
        assert!(cp.get("unresolvedPrompt").is_some());
    }
}
#[tokio::test]
async fn recovery_l233_live_turn_progresses_during_owner_outage_then_only_prefix_backfills_after_restart(
) {
    for agent in ["qoder", "qoder-cn"] {
        let available = Arc::new(AtomicBool::new(false));
        let resolver: Arc<dyn QoderPromptOwnershipResolver> = Arc::new(ReviewResolver {
            rows: vec![
                QoderOwnershipRow {
                    request_id: "owned-0".into(),
                    at: at(0),
                },
                QoderOwnershipRow {
                    request_id: "owned-1".into(),
                    at: at(1),
                },
            ],
            available: available.clone(),
            page: usize::MAX,
            missing_session: None,
        });
        let mut f = review_fixture(agent, resolver.clone()).await;
        f.write(&review_turn(0, None));
        wake(&f, "UserPromptSubmit", Some("owned-0"));
        assert!(f.collect().await.records.is_empty());
        f.append(&review_turn(1, None));
        wake(&f, "Stop", Some("owned-1"));
        let delivered = f.collect().await.records;
        assert!(contains(&delivered, "answer-1"));
        assert!(!contains(&delivered, "answer-0"));
        available.store(true, Ordering::SeqCst);
        reset(&mut f, resolver).await;
        let recovered = f.collect().await.records;
        assert!(contains(&recovered, "answer-0"));
        assert!(!contains(&recovered, "answer-1"));
        unique(&[delivered, recovered].concat());
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l253_owned_request_beyond_1000_prompts_uses_bounded_metadata_pages_and_restart() {
    for agent in ["qoder", "qoder-cn"] {
        let resolver: Arc<dyn QoderPromptOwnershipResolver> = Arc::new(ReviewResolver {
            rows: (0..1025)
                .map(|i| QoderOwnershipRow {
                    request_id: format!("owned-{i}"),
                    at: at(i),
                })
                .collect(),
            available: Arc::new(AtomicBool::new(true)),
            page: 256,
            missing_session: None,
        });
        let mut f = review_fixture(agent, resolver.clone()).await;
        f.write(
            &(0..1025)
                .flat_map(|i| review_turn(i, None))
                .collect::<Vec<_>>(),
        );
        wake(&f, "UserPromptSubmit", Some("owned-1024"));
        let mut events = Vec::new();
        for i in 0..24 {
            events.extend(f.collect().await.records);
            if i == 3 {
                reset(&mut f, resolver.clone()).await;
            }
        }
        assert_eq!(count(&events, "llm.response"), 1);
        assert!(contains(&events, "answer-1024"));
        assert!(!contains(&events, "answer-1023"));
    }
}
#[tokio::test]
async fn recovery_l271_real_later_prompt_seals_recovery_without_waiting_for_unrelated_live_tail() {
    for agent in ["qoder", "qoder-cn"] {
        let available = Arc::new(AtomicBool::new(false));
        let resolver: Arc<dyn QoderPromptOwnershipResolver> = Arc::new(ReviewResolver {
            rows: vec![
                QoderOwnershipRow {
                    request_id: "owned-0".into(),
                    at: at(0),
                },
                QoderOwnershipRow {
                    request_id: "owned-1".into(),
                    at: at(1),
                },
            ],
            available: available.clone(),
            page: usize::MAX,
            missing_session: None,
        });
        let mut f = review_fixture(agent, resolver).await;
        {
            let mut c = f.source.inner.lock().await;
            c.stable_ms = 60000;
            c.settle_ms = 5000;
        }
        let mut rows = review_turn(0, None);
        rows.pop();
        rows.push(json!({"type":"progress","data":{"hookEvent":"Stop"}}));
        f.write(&rows);
        wake(&f, "UserPromptSubmit", Some("owned-0"));
        f.collect().await;
        f.append(&review_turn(1, None)[..1]);
        available.store(true, Ordering::SeqCst);
        let events = f.collect().await.records;
        assert_eq!(count(&events, "llm.response"), 1);
        assert!(contains(&events, "answer-0"));
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn recovery_l286_unavailable_source_cannot_monopolize_shared_ownership_budget() {
    for agent in ["qoder", "qoder-cn"] {
        let resolver: Arc<dyn QoderPromptOwnershipResolver> = Arc::new(ReviewResolver {
            rows: vec![QoderOwnershipRow {
                request_id: "owned-b".into(),
                at: at(1),
            }],
            available: Arc::new(AtomicBool::new(true)),
            page: usize::MAX,
            missing_session: Some("session".into()),
        });
        let mut f = review_fixture(agent, resolver).await;
        f.write(&review_turn(0, None));
        wake(&f, "UserPromptSubmit", Some("owned-a"));
        let b = f.root.join("b.jsonl");
        std::fs::write(&b, jsonl(&review_turn(1, None))).unwrap();
        let empty = Map::new();
        assert!(crate::hook_process::publish_qoder_wakeup(
            &json!({"session_id":"session-b","transcript_path":b,"hook_event_name":"UserPromptSubmit","request_set_id":"owned-b"}),
            &f.root,
            agent,
            None,
            &empty,
            &empty
        ));
        let events = drain(&mut f, 4).await;
        assert_eq!(count(&events, "llm.response"), 1);
        assert!(contains(&events, "answer-1"));
        assert!(!contains(&events, "answer-0"));
    }
}
