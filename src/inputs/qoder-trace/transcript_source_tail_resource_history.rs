use super::*;
async fn poll(f: &mut Fixture) -> TranscriptBatch {
    f.clock.fetch_add(1000, Ordering::SeqCst);
    f.collect().await
}
async fn tail_fixture(agent: &str) -> Fixture {
    let mut f = Fixture::new(agent).await;
    f.write(&[json!({"type":"user","uuid":"tail-user","timestamp":iso(0),"message":{"role":"user","content":"test partial record"}})]);
    f.wake("UserPromptSubmit", json!({}));
    f.collect().await;
    f
}
fn resource_turn(index: i64, text: &str) -> Vec<Value> {
    vec![
        json!({"type":"user","uuid":format!("prompt-{index}"),"timestamp":iso(index*1000),"message":{"role":"user","content":format!("prompt {index}")}}),
        json!({"type":"assistant","timestamp":iso(index*1000+100),"message":{"id":format!("response-{index}"),"model":"synthetic-model","role":"assistant","content":[{"type":"text","text":text}],"stop_reason":"end_turn"}}),
        progress("Stop", index * 1000 + 200),
        json!({"type":"last-prompt"}),
    ]
}
#[tokio::test]
async fn tail_l42_static_three_mib_incomplete_source_stops_body_reads_without_committing() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = tail_fixture(agent).await;
        let before = number(&f.state[&f.key], "offset");
        f.append_bytes(
            &(b"{\"type\":\"assistant\",\"message\":{\"content\":\""
                .iter()
                .copied()
                .chain(std::iter::repeat_n(b'x', 3 * 1024 * 1024))
                .collect::<Vec<_>>()),
        );
        assert!(poll(&mut f).await.records.is_empty());
        assert!(poll(&mut f).await.records.is_empty());
        for _ in 0..4 {
            let warm = poll(&mut f).await;
            assert_eq!(warm.metrics.bytes_read, 0);
            assert!(warm.records.is_empty());
        }
        assert_eq!(number(&f.state[&f.key], "offset"), before);
        assert!(f.source.inner.lock().await.warned.is_empty());
    }
}
#[tokio::test]
async fn tail_l57_appended_utf8_bytes_are_witnessed_then_full_response_decoded_once_after_lf() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = tail_fixture(agent).await;
        let text = "x".repeat(2 * 1024 * 1024) + "中文🙂";
        let response=json!({"type":"assistant","timestamp":iso(100),"message":{"id":"tail-response","model":"synthetic-model","role":"assistant","content":[{"type":"text","text":text}],"stop_reason":"end_turn"}}).to_string();
        let split = response.find('中').unwrap() + 1;
        f.append_bytes(&response.as_bytes()[..split]);
        assert!(poll(&mut f).await.records.is_empty());
        f.append_bytes(&response.as_bytes()[split..split + 1]);
        let growing = poll(&mut f).await;
        assert!(growing.records.is_empty());
        assert!(growing.metrics.bytes_read < 1024);
        f.append_bytes(&response.as_bytes()[split + 1..]);
        f.append_bytes(b"\n");
        f.append(&[progress("Stop", 200), json!({"type":"last-prompt"})]);
        f.wake("Stop", json!({}));
        let complete = poll(&mut f).await;
        let responses = complete
            .records
            .iter()
            .filter(|r| r["event.name"] == "llm.response")
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 1);
        assert!(responses[0]["gen_ai.output.messages"]
            .to_string()
            .contains(&text));
        assert!(complete.metrics.bytes_read < response.len() as u64 + 4096);
        unique(&complete.records);
        assert!(poll(&mut f).await.records.is_empty());
        f.restart().await;
        let restarted = poll(&mut f).await;
        assert!(restarted.records.is_empty());
        assert_eq!(restarted.metrics.bytes_read, 0);
    }
}
#[tokio::test]
async fn tail_l89_budget_and_oversized_record_quarantine_drain_then_repaired_turn_is_independent() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = tail_fixture(agent).await;
        let original_user =
            serde_json::from_str::<Value>(std::fs::read_to_string(&f.file).unwrap().trim())
                .unwrap();
        {
            let mut c = f.source.inner.lock().await;
            c.scan_bytes = 64 * 1024;
            c.max_turn_bytes = 128 * 1024;
        }
        let before = number(&f.state[&f.key], "offset");
        let mut body = b"{\"type\":\"assistant\",\"message\":{\"content\":\"".to_vec();
        body.extend(vec![b'x'; 256 * 1024]);
        body.extend_from_slice(b"\"}}\n");
        f.append_bytes(&body);
        for _ in 0..6 {
            let batch = poll(&mut f).await;
            assert!(batch.metrics.bytes_read <= 64 * 1024 + 256);
            assert!(batch.records.is_empty());
        }
        assert!(f
            .source
            .inner
            .lock()
            .await
            .warned
            .keys()
            .any(|k| k.ends_with(":record-byte-limit")));
        for _ in 0..3 {
            assert_eq!(poll(&mut f).await.metrics.bytes_read, 0);
        }
        assert!(number(&f.state[&f.key], "offset") > before);
        assert_eq!(f.state[&f.key]["quarantines"].as_array().unwrap().len(), 1);
        f.write(&[original_user,json!({"type":"assistant","message":{"id":"repaired","role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"repaired"}],"stop_reason":"end_turn"}}),json!({"type":"last-prompt"})]);
        f.wake("Stop", json!({}));
        assert_eq!(count(&poll(&mut f).await.records, "llm.response"), 1);
        assert!(poll(&mut f).await.records.is_empty());
    }
}
#[tokio::test]
async fn tail_l110_complete_bad_line_is_retained_in_source_and_repair_recovers_without_idle_reads()
{
    for agent in ["qoder", "qoder-cn"] {
        let mut f = tail_fixture(agent).await;
        let original_user =
            serde_json::from_str::<Value>(std::fs::read_to_string(&f.file).unwrap().trim())
                .unwrap();
        f.append_bytes(b"{broken}\n");
        let intact = std::fs::read(&f.file).unwrap();
        assert!(poll(&mut f).await.records.is_empty());
        assert!(f
            .source
            .inner
            .lock()
            .await
            .warned
            .keys()
            .any(|k| k.ends_with(":invalid-json-line")));
        assert_eq!(poll(&mut f).await.metrics.bytes_read, 0);
        assert_eq!(std::fs::read(&f.file).unwrap(), intact);
        f.write(&[original_user,json!({"type":"assistant","message":{"id":"fixed","role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"fixed"}],"stop_reason":"end_turn"}}),json!({"type":"last-prompt"})]);
        f.wake("Stop", json!({}));
        assert_eq!(count(&poll(&mut f).await.records, "llm.response"), 1);
    }
}
#[tokio::test]
async fn tail_l123_in_place_changed_witness_before_append_rehydrates_current_text() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = tail_fixture(agent).await;
        let prefix=b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"model\":\"synthetic-model\",\"id\":\"changed\",\"content\":\"";
        f.append_bytes(prefix);
        f.append_bytes(&vec![b'x'; 160 * 1024]);
        poll(&mut f).await;
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&f.file)
            .unwrap();
        writer.seek(SeekFrom::End(-1)).unwrap();
        writer.write_all(b"y").unwrap();
        drop(writer);
        f.append_bytes(b"\",\"stop_reason\":\"end_turn\"}}\n");
        f.append(&[json!({"type":"last-prompt"})]);
        f.wake("Stop", json!({}));
        let batch = poll(&mut f).await;
        assert_eq!(count(&batch.records, "llm.response"), 1);
        assert!(serde_json::to_string(&batch.records)
            .unwrap()
            .contains(&("x".repeat(128) + "y")));
    }
}
#[tokio::test]
async fn resource_l29_more_than_33_mib_history_reads_less_than_two_mib_for_current_turn() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let history = jsonl(&resource_turn(0, &"x".repeat(16 * 1024)));
        let mut file = std::fs::File::create(&f.file).unwrap();
        let mut written = 0;
        while written <= 33 * 1024 * 1024 {
            file.write_all(&history).unwrap();
            written += history.len();
        }
        file.write_all(&jsonl(&resource_turn(1, "answer"))).unwrap();
        drop(file);
        f.wake("Stop", json!({}));
        let batch = f.collect().await;
        assert_eq!(count(&batch.records, "llm.response"), 1);
        assert_eq!(
            batch
                .records
                .iter()
                .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert!(batch.metrics.bytes_read < 2 * 1024 * 1024);
        let warm = f.collect().await;
        assert!(warm.records.is_empty());
        assert_eq!(warm.metrics.bytes_read, 0);
    }
}
#[tokio::test]
async fn resource_l47_unicode_crosses_64k_chunk_boundaries_without_text_loss() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = Fixture::new(agent).await;
        let text = "x".repeat(65000) + &"中文🙂".repeat(400);
        f.write(&resource_turn(0, &text));
        f.wake("Stop", json!({}));
        let batch = f.collect().await;
        let response = batch
            .records
            .iter()
            .find(|r| r["event.name"] == "llm.response")
            .unwrap();
        assert!(response["gen_ai.output.messages"]
            .to_string()
            .contains(&text));
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn resource_l58_real_metadata_publisher_capacity_still_collects_without_another_hook() {
    let mut f = Fixture::new("qoder-cn").await;
    let rows = resource_turn(0, "answer");
    f.write(&rows[..1]);
    let empty = Map::new();
    let mut payload =
        json!({"session_id":"session","transcript_path":f.file,"hook_event_name":"PreToolUse"});
    for index in 0..128 {
        payload["cwd"] = json!(format!("/seed-{index}"));
        assert!(crate::hook_process::publish_qoder_wakeup(
            &payload, &f.root, "qoder-cn", None, &empty, &empty
        ));
    }
    f.append(&rows[1..]);
    payload["hook_event_name"] = json!("Stop");
    assert!(!crate::hook_process::publish_qoder_wakeup(
        &payload, &f.root, "qoder-cn", None, &empty, &empty
    ));
    let batch = f.collect().await;
    assert_eq!(count(&batch.records, "llm.response"), 1);
    let warm = f.collect().await;
    assert!(warm.records.is_empty());
    assert_eq!(warm.metrics.bytes_read, 0);
}
#[tokio::test]
async fn resource_l75_dense_8192_records_mark_incomplete_then_following_turn_is_whole() {
    let mut f = Fixture::new("qoder-cn").await;
    let mut rows = resource_turn(0, "answer");
    rows.splice(
        1..1,
        std::iter::repeat_n(
            json!({"type":"progress","data":{"hookEvent":"PreToolUse"}}),
            8192,
        ),
    );
    f.write(&rows);
    f.wake("Stop", json!({}));
    let failed = f.collect().await;
    assert_eq!(failed.records.len(), 1);
    assert!(failed
        .records
        .iter()
        .all(|r| r["agent.transcript_incomplete"] == true));
    assert_eq!(f.state[&f.key]["quarantines"].as_array().unwrap().len(), 1);
    assert!(f.collect().await.records.is_empty());
    assert!(f
        .source
        .inner
        .lock()
        .await
        .warned
        .keys()
        .any(|key| key.ends_with(":turn-record-limit")));
    f.append(&resource_turn(1, "next answer"));
    f.wake("Stop", json!({}));
    let repaired = f.collect().await;
    assert_eq!(count(&repaired.records, "llm.response"), 1);
    assert!(f.collect().await.records.is_empty());
}
#[cfg(unix)]
#[tokio::test]
async fn resource_l93_real_fifo_swap_after_source_stat_defers_and_repair_collects_once() {
    use std::os::unix::ffi::OsStrExt;
    let mut f = Fixture::new("qoder-cn").await;
    let rows = resource_turn(0, "answer");
    f.write(&rows);
    f.wake("Stop", json!({}));
    let target = f.file.clone();
    let backup = target.with_extension("original");
    let observed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = observed.clone();
    let guard = scanner::inject_open_fault(move |path| {
        if path == target && counter.fetch_add(1, Ordering::SeqCst) == 1 {
            std::fs::rename(&target, &backup).unwrap();
            let path = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
            // SAFETY: the CString is a valid terminated synthetic temp path.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }
    });
    let failed = tokio::time::timeout(std::time::Duration::from_secs(5), f.collect())
        .await
        .expect("FIFO source must not strand the collector");
    assert!(failed.records.is_empty());
    assert_eq!(failed.state, json!({}));
    assert!(observed.load(Ordering::SeqCst) >= 2);
    assert!(f
        .source
        .inner
        .lock()
        .await
        .warned
        .keys()
        .any(|key| key.ends_with(":not-regular-file")));
    drop(guard);
    std::fs::remove_file(&f.file).unwrap();
    f.write(&rows);
    f.wake("Stop", json!({}));
    let repaired = f.collect().await;
    assert_eq!(count(&repaired.records, "llm.response"), 1);
    assert!(f.collect().await.records.is_empty());
}
