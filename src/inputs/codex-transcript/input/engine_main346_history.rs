use super::*;
fn main_completed() -> Vec<String> {
    let mut rows = completed()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    rows[0]["payload"]["dynamic_tools"] =
        json!([{"name":"exec_command","description":"Run a command"}]);
    rows[1]["payload"]["developer_instructions"] = json!("Follow the project conventions.");
    rows.last_mut().unwrap()["payload"]["completed_at"] = json!(1_719_208_011u64);
    rows.into_iter().map(|v| v.to_string()).collect()
}
fn large_tool_turn(text: &str) -> Vec<String> {
    vec![
        record(
            "2026-06-24T06:00:00.000Z",
            "session_meta",
            json!({"id":"session-1","model_provider":"openai"}),
        ),
        record(
            "2026-06-24T06:00:01.000Z",
            "turn_context",
            json!({"turn_id":"turn-1","model":"gpt-5.5"}),
        ),
        record(
            "2026-06-24T06:00:02.000Z",
            "event_msg",
            json!({"type":"task_started","turn_id":"turn-1"}),
        ),
        record(
            "2026-06-24T06:00:03.000Z",
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"inspect it"}]}),
        ),
        record(
            "2026-06-24T06:00:04.000Z",
            "response_item",
            json!({"type":"function_call","id":"fc-1","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"cat large.txt\"}"}),
        ),
        record(
            "2026-06-24T06:00:05.000Z",
            "response_item",
            json!({"type":"function_call_output","call_id":"call-1","output":serde_json::to_string(text).unwrap()}),
        ),
        record("2026-06-24T06:00:06.000Z", "event_msg", usage(100, 10)),
        record(
            "2026-06-24T06:00:07.000Z",
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}),
        ),
        record(
            "2026-06-24T06:00:08.000Z",
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1","last_agent_message":"done"}),
        ),
    ]
}
async fn oversized_terminal(f: &Fixture, path: &str, terminal: &str) {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .await
        .unwrap();
    file.write_all(format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{terminal}\",\"turn_id\":\"turn-1\",\"padding\":\"").as_bytes()).await.unwrap();
    let chunk = vec![b'x'; 1024 * 1024];
    for _ in 0..129 {
        file.write_all(&chunk).await.unwrap();
    }
    file.write_all(b"\"}}\n").await.unwrap();
    file.flush().await.unwrap();
    drop(file);
    assert!(std::path::Path::new(path).starts_with(f.root.path()));
}
fn next_turn(skip: usize) -> String {
    main_completed()
        .iter()
        .skip(skip)
        .map(|line| line.replace("turn-1", "turn-2").replace("06:00:", "06:01:") + "\n")
        .collect()
}
fn turn_end(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|v| v["gen_ai.turn.end"] == true)
        .cloned()
        .collect()
}
fn unique_ids(rows: &[Value]) {
    let ids = rows
        .iter()
        .map(|v| v["event.id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), rows.len());
}
#[tokio::test]
async fn l430_next_turn_closes_already_emitted_previous_responses_without_duplicates() {
    let f = Fixture::new();
    let lines = main_completed();
    let path = f
        .write(
            "rollout-missing-terminal.jsonl",
            &(lines[..lines.len() - 3].join("\n") + "\n"),
        )
        .await;
    f.process(&path).await;
    assert_eq!(responses_for(&f.records(), "turn-1").len(), 2);
    assert!(turn_end(&f.records()).is_empty());
    f.append(&path, &next_turn(1)).await;
    for _ in 0..3 {
        f.process(&path).await;
    }
    let rows = f.records();
    assert_eq!(responses_for(&rows, "turn-1").len(), 2);
    let ends = turn_end(&rows);
    assert_eq!(ends.len(), 2);
    assert_eq!(ends[0]["agent.codex.transcript_turn_id"], "turn-1");
    assert_eq!(ends[0]["agent.codex.turn_status"], "interrupted");
    assert_eq!(ends[0]["time_unix_nano"], "1782280861000000000");
    let checkpoint = f.checkpoint(&path);
    assert_eq!(
        checkpoint.scan_offset,
        std::fs::metadata(&path).unwrap().len() as i64
    );
    assert!(checkpoint.active_turn.is_none());
    unique_ids(&rows);
}
#[tokio::test]
async fn l453_quarantined_complete_and_aborted_terminals_preserve_unfinished_tool_step_across_restart(
) {
    for terminal in ["task_complete", "turn_aborted"] {
        let f = Fixture::new();
        let lines = large_tool_turn("ordinary result");
        let path = f
            .write(
                "rollout-quarantined-terminal.jsonl",
                &(lines[..6].join("\n") + "\n"),
            )
            .await;
        oversized_terminal(&f, &path, terminal).await;
        let boundary = std::fs::metadata(&path).unwrap().len() as i64;
        let next = if terminal == "turn_aborted" {
            for _ in 0..3 {
                f.process(&path).await;
            }
            assert_eq!(f.checkpoint(&path).scan_offset, boundary);
            Some(f.restart().await)
        } else {
            None
        };
        let current = next.as_ref().unwrap_or(&f);
        current
            .append(
                &path,
                &next_turn(if terminal == "turn_aborted" { 2 } else { 1 }),
            )
            .await;
        for _ in 0..5 {
            current.process(&path).await;
        }
        let mut rows = f.records();
        if let Some(next) = &next {
            rows.extend(next.records());
        }
        assert_eq!(responses_for(&rows, "turn-1").len(), 1, "{terminal}");
        let old = rows
            .iter()
            .filter(|v| v["agent.codex.transcript_turn_id"] == "turn-1")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(events(&old, "tool.result").len(), 1);
        let ends = turn_end(&old);
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["agent.codex.turn_status"], "interrupted");
        assert_eq!(responses_for(&rows, "turn-2").len(), 3);
        unique_ids(&rows);
        let checkpoint = current.checkpoint(&path);
        assert_eq!(
            checkpoint.scan_offset,
            std::fs::metadata(&path).unwrap().len() as i64
        );
        assert!(checkpoint.active_turn.is_none());
        assert!(checkpoint.pending_terminal.is_none());
    }
}
#[tokio::test]
async fn l488_startup_and_fork_baselines_cross_quarantine_without_retaining_an_old_turn() {
    for mode in ["baseline", "fork-tail"] {
        let f = Fixture::new();
        let lines = main_completed();
        let path = f
            .write(
                "rollout-baseline-quarantine.jsonl",
                &(lines[..lines.len() - 1].join("\n") + "\n"),
            )
            .await;
        oversized_terminal(&f, &path, "task_complete").await;
        f.append(&path, &next_turn(1)).await;
        let size = std::fs::metadata(&path).unwrap().len() as i64;
        if mode == "baseline" {
            f.engine()
                .baseline_file(f.rt(), &path, &f.engine().state_key(&path))
                .await
                .unwrap();
            let checkpoint = f.checkpoint(&path);
            assert_eq!(checkpoint.scan_offset, size);
            assert!(checkpoint.active_turn.is_none());
        } else {
            let (inode, _, _) = file_meta_snapshot(&path).await.unwrap();
            let mut checkpoint = CodexTranscriptCheckpoint {
                inode,
                scan_offset: size,
                active_turn: None,
                pending_terminal: None,
                pending_fusion: None,
                pending_subagent: None,
                owner_session_meta_offset: Some(0),
                fork_bootstrap: Some(CodexForkBootstrap {
                    state: ForkBootstrapState::BaselineTail,
                    search_offset: 0,
                    initial_turn_id: None,
                    recovery_turn_id: None,
                    tail_candidate: None,
                }),
                first_owned_turn_id: None,
            };
            assert!(!f
                .engine()
                .rebuild_fork_baseline_tail(f.rt(), &path, &mut checkpoint)
                .await
                .unwrap());
            assert!(checkpoint.fork_bootstrap.as_ref().unwrap().search_offset < size);
            let mut restored: CodexTranscriptCheckpoint =
                serde_json::from_value(serde_json::to_value(checkpoint).unwrap()).unwrap();
            for _ in 0..3 {
                if restored.fork_bootstrap.is_some() {
                    f.engine()
                        .rebuild_fork_baseline_tail(f.rt(), &path, &mut restored)
                        .await
                        .unwrap();
                }
            }
            assert!(restored.fork_bootstrap.is_none());
            assert!(restored.active_turn.is_none());
        }
        assert!(f.records().is_empty());
    }
}

async fn append_bytes(path: &str, bytes: &[u8]) {
    use tokio::io::AsyncWriteExt;
    let mut f = tokio::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .await
        .unwrap();
    f.write_all(bytes).await.unwrap();
    f.flush().await.unwrap();
}
type Deltas = Arc<Mutex<Vec<crate::inputs::base::InputRuntimeDelta>>>;
async fn live() -> (Fixture, Deltas) {
    let f = Fixture::new();
    let d = runtime_deltas(&f);
    f.input.start().await.unwrap();
    f.input.run_cycle().await;
    f.input.run_cycle().await;
    (f, d)
}
async fn reads(f: &Fixture, d: &Deltas) -> u64 {
    let before = d.lock().unwrap().len();
    f.input.run_cycle().await;
    let locked = d.lock().unwrap();
    assert!(
        locked.len() > before,
        "real cycle must publish runtime facts"
    );
    locked[before..].iter().map(|d| d.raw_read_bytes).sum()
}
async fn read_budget(f: &Fixture, d: &Deltas, max: u64) {
    let n = reads(f, d).await;
    if n > max {
        f.input.stop().await.unwrap();
        assert!(
            n <= max,
            "physical content read {n} exceeds exact source budget {max}"
        );
    }
}
#[tokio::test]
async fn tail_main346_l521_static_append_budget_split_utf8_and_restart_preserve_one_full_result() {
    let (f, d) = live().await;
    let output = "x".repeat(32 * 1024 * 1024) + "界";
    let lines = large_tool_turn(&output);
    let prefix = lines[..5].join("\n") + "\n";
    let body = lines[5].as_bytes();
    let split = lines[5].find('界').unwrap() + 1;
    let path = f
        .write("2026/06/24/rollout-main346-tail.jsonl", &prefix)
        .await;
    append_bytes(&path, &body[..split]).await;
    reads(&f, &d).await;
    reads(&f, &d).await;
    assert_eq!(f.checkpoint(&path).scan_offset, prefix.len() as i64);
    for _ in 0..5 {
        read_budget(&f, &d, 0).await;
    }
    append_bytes(&path, &body[split..]).await;
    read_budget(&f, &d, (64 + body.len() - split) as u64).await;
    read_budget(&f, &d, 0).await;
    append_bytes(&path, b"\t").await;
    read_budget(&f, &d, 65).await;
    read_budget(&f, &d, 0).await;
    append_bytes(&path, &vec![b' '; 17 * 1024 * 1024]).await;
    read_budget(&f, &d, 16 * 1024 * 1024 + 64).await;
    read_budget(&f, &d, 1024 * 1024 + 64).await;
    read_budget(&f, &d, 0).await;
    assert_eq!(f.checkpoint(&path).scan_offset, prefix.len() as i64);
    f.input.stop().await.unwrap();
    let next = f.restart().await;
    next.process(&path).await;
    assert_eq!(next.checkpoint(&path).scan_offset, prefix.len() as i64);
    assert!(next.records().is_empty());
    next.append(&path, &("\n".to_owned() + &lines[6..].join("\n") + "\n"))
        .await;
    for _ in 0..3 {
        next.process(&path).await;
    }
    let cp = next.checkpoint(&path);
    assert_eq!(
        cp.scan_offset,
        std::fs::metadata(&path).unwrap().len() as i64
    );
    assert!(cp.active_turn.is_none());
    assert!(cp.pending_terminal.is_none());
    let mut all = f.records();
    all.extend(next.records());
    let results = events(&all, "tool.result");
    assert_eq!(results.len(), 1);
    assert!(results[0].to_string().contains(&output));
    unique_ids(&all);
}
#[tokio::test]
async fn tail_main346_l573_four_replacement_modes_invalidate_the_incomplete_hint() {
    for mode in ["same-size", "shorter", "regrown", "new-inode"] {
        let f = Fixture::new();
        let prefix = main_completed().join("\n") + "\n";
        let partial = "{\"padding\":\"".to_owned() + &"x".repeat(1024);
        let path = f
            .write("rollout-tail-replace.jsonl", &(prefix.clone() + &partial))
            .await;
        f.process(&path).await;
        f.process(&path).await;
        assert_eq!(f.checkpoint(&path).scan_offset, prefix.len() as i64);
        let old = std::fs::metadata(&path).unwrap();
        let size = match mode {
            "same-size" => partial.len(),
            "shorter" => 128,
            _ => partial.len() + 256,
        };
        let replacement = json!({"padding":"y".repeat(size-15)}).to_string() + "\n";
        assert_eq!(replacement.len(), size);
        if mode == "new-inode" {
            tokio::fs::write(format!("{path}.replacement"), prefix.clone() + &replacement)
                .await
                .unwrap();
            tokio::fs::rename(format!("{path}.replacement"), &path)
                .await
                .unwrap();
        } else {
            tokio::fs::write(&path, prefix + &replacement)
                .await
                .unwrap();
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(old.modified().unwrap() + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        f.process(&path).await;
        assert_eq!(
            f.checkpoint(&path).scan_offset,
            std::fs::metadata(&path).unwrap().len() as i64,
            "{mode}"
        );
    }
}
#[tokio::test]
async fn tail_main346_l599_quarantine_has_exact_unique_metrics_control_events_and_idle_restart() {
    let (f, d) = live().await;
    let lines = main_completed();
    let prefix = lines[..6].join("\n") + "\n";
    let path = f
        .write("2026/06/24/rollout-main346-quarantine.jsonl", &prefix)
        .await;
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .unwrap();
    use tokio::io::AsyncWriteExt;
    file.write_all(
        b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"padding\":\"",
    )
    .await
    .unwrap();
    let block = vec![b'x'; 1024 * 1024];
    for _ in 0..129 {
        file.write_all(&block).await.unwrap();
    }
    file.write_all(b"\"}}").await.unwrap();
    file.flush().await.unwrap();
    drop(file);
    reads(&f, &d).await;
    reads(&f, &d).await;
    assert_eq!(f.checkpoint(&path).scan_offset, prefix.len() as i64);
    f.append(&path, &("\n".to_owned() + &lines[6..].join("\n") + "\n"))
        .await;
    let size = std::fs::metadata(&path).unwrap().len() as i64;
    for _ in 0..4 {
        if f.checkpoint(&path).scan_offset != size {
            reads(&f, &d).await;
        }
    }
    f.input.stop().await.unwrap();
    let cp = f.checkpoint(&path);
    assert_eq!(cp.scan_offset, size);
    assert!(cp.active_turn.is_none());
    assert!(cp.pending_terminal.is_none());
    assert_eq!(
        d.lock()
            .unwrap()
            .iter()
            .map(|d| d.parse_failed_records)
            .sum::<u64>(),
        1
    );
    let control = Fixture::new();
    let control_path = control
        .write("rollout-main346-control.jsonl", &(lines.join("\n") + "\n"))
        .await;
    control.process(&control_path).await;
    let tuples = |rows: Vec<Value>| {
        rows.into_iter()
            .filter(|v| v.get("agent.codex.transcript_turn_id").is_some())
            .map(|v| {
                json!([
                    v["event.name"],
                    v["gen_ai.usage.input_tokens"],
                    v["gen_ai.usage.output_tokens"]
                ])
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(tuples(f.records()), tuples(control.records()));
    assert!(!events(&f.records(), "tool.result").is_empty());
    let next = f.restart().await;
    let idle = runtime_deltas(&next);
    next.input.start().await.unwrap();
    read_budget(&next, &idle, 0).await;
    next.input.stop().await.unwrap();
    assert!(next.records().is_empty());
    assert_eq!(std::fs::metadata(&path).unwrap().len(), size as u64);
}
#[tokio::test]
async fn tail_main346_l654_full_input_large_utf8_record_assembles_less_than_five_file_sizes() {
    let f = Fixture::new();
    let output = "界".repeat(6 * 1024 * 1024);
    let lines = large_tool_turn(&output);
    let path = f
        .write("rollout-main346-linear.jsonl", &(lines.join("\n") + "\n"))
        .await;
    scan::reset_assembly_work();
    for _ in 0..4 {
        f.process(&path).await;
    }
    let cp = f.checkpoint(&path);
    let size = std::fs::metadata(&path).unwrap().len() as i64;
    assert_eq!(cp.scan_offset, size);
    assert!(cp.active_turn.is_none());
    assert!(cp.pending_terminal.is_none());
    let results = events(&f.records(), "tool.result");
    assert!(results.iter().any(|v| v.to_string().contains(&output)));
    let copied = scan::assembly_work();
    assert!(copied > 0);
    assert!(
        copied < 5 * size as u64,
        "assembled {copied} >=5x physical source {size}"
    );
}
#[tokio::test]
async fn tail_main346_deferred_start_is_committed_once_in_real_runtime_metrics() {
    let (f, d) = live().await;
    let lines = main_completed();
    let prefix = lines[..lines.len() - 3].join("\n") + "\n";
    let path = f
        .write("2026/06/24/rollout-main346-metrics.jsonl", &prefix)
        .await;
    reads(&f, &d).await;
    let following = next_turn(1);
    f.append(&path, &following).await;
    for _ in 0..3 {
        reads(&f, &d).await;
    }
    f.input.stop().await.unwrap();
    let deltas = d.lock().unwrap();
    let records = (prefix.lines().count() + following.lines().count()) as u64;
    assert_eq!(
        deltas.iter().map(|v| v.raw_in_records).sum::<u64>(),
        records
    );
    assert_eq!(
        deltas.iter().map(|v| v.parse_success_records).sum::<u64>(),
        records
    );
    assert_eq!(
        deltas.iter().map(|v| v.raw_in_bytes).sum::<u64>(),
        std::fs::metadata(&path).unwrap().len()
    );
    assert_eq!(turn_end(&f.records()).len(), 2);
}
