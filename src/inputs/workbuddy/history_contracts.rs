use super::*;
use crate::flushers::{hr_time_to_nano, ConvertOptions, EventLogConverter, GenAiEventLogConverter};

#[tokio::test]
async fn actual_native_converter_preserves_exact_workbuddy_span_durations_and_full_tool_context() {
    let records = fixture_records()
        .into_iter()
        .map(|mut record| {
            if let Some(timestamp) = record.get("timestamp").and_then(Value::as_i64) {
                record["timestamp"] = json!(1_800_000_000_000i64 + timestamp);
            }
            record
        })
        .collect::<Vec<_>>();
    let entries = built(&records, "workbuddy-duration-test", Vec::new()).await;
    let conversion = GenAiEventLogConverter
        .convert(&entries, &ConvertOptions::default())
        .expect("production converter");
    assert!(conversion.warnings.is_empty(), "{:?}", conversion.warnings);
    let llm = conversion
        .spans
        .iter()
        .filter(|span| span.attributes["gen_ai.span.kind"] == "LLM")
        .collect::<Vec<_>>();
    let tool = conversion
        .spans
        .iter()
        .filter(|span| span.attributes["gen_ai.span.kind"] == "TOOL")
        .collect::<Vec<_>>();
    assert_eq!(
        llm.iter()
            .map(|span| hr_time_to_nano(span.end_time)
                .parse::<i128>()
                .expect("end nanos")
                - hr_time_to_nano(span.start_time)
                    .parse::<i128>()
                    .expect("start nanos"))
            .collect::<Vec<_>>(),
        vec![100_000_000, 100_000_000]
    );
    assert_eq!(
        tool.iter()
            .map(|span| hr_time_to_nano(span.end_time)
                .parse::<i128>()
                .expect("end nanos")
                - hr_time_to_nano(span.start_time)
                    .parse::<i128>()
                    .expect("start nanos"))
            .collect::<Vec<_>>(),
        vec![100_000_000, 0]
    );
    let input: Value = serde_json::from_str(
        llm[1].attributes["gen_ai.input.messages"]
            .as_str()
            .expect("JSON attribute"),
    )
    .expect("messages");
    let input = input.as_array().expect("messages array");
    assert_eq!(
        input
            .iter()
            .map(|message| message["role"].as_str().expect("role"))
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "tool", "tool"]
    );
    let call_ids = input
        .iter()
        .find(|message| message["role"] == "assistant")
        .expect("assistant")["parts"]
        .as_array()
        .expect("call parts")
        .iter()
        .map(|part| part["id"].clone())
        .collect::<Vec<_>>();
    let responses = input
        .iter()
        .filter(|message| message["role"] == "tool")
        .flat_map(|message| message["parts"].as_array().expect("tool parts"))
        .collect::<Vec<_>>();
    assert_eq!(
        responses
            .iter()
            .map(|part| part["id"].clone())
            .collect::<Vec<_>>(),
        call_ids
    );
    assert_eq!(
        responses
            .iter()
            .map(|part| part["response"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({"ok":true,"value":"SYNTHETIC_RESULT_A"}),
            json!({"ok":true,"value":"SYNTHETIC_RESULT_B"})
        ]
    );
    assert!(responses.iter().all(|part| part.get("result").is_none()));
}

#[tokio::test]
async fn identity_snapshot_and_range_read_remain_the_same_file_during_atomic_replacement() {
    let env = Env::new("workbuddy-read-identity-");
    let (_store, _input) = env.open().await;
    let path = env.projects().join("session-handle.jsonl");
    let old = jsonl(&fixture_records(), false);
    let new = old.replace("synthetic", "rotatedxx");
    assert_eq!(old.len(), new.len());
    std::fs::write(&path, &old).expect("old source");
    let held = std::fs::File::open(&path).expect("original handle");
    let mut opened = super::super::open_transcript_snapshot(&path.to_string_lossy())
        .await
        .expect("production opened snapshot");
    assert_eq!(opened.size, old.len() as u64);
    let expected =
        crate::utils::file_identity::identity_from_open(&held).expect("platform identity");
    assert_eq!(
        opened.identity,
        format!("{}:{}", expected.dev, expected.ino)
    );
    let replacement = path.with_extension("replacement");
    std::fs::write(&replacement, &new).expect("new source");
    std::fs::rename(&replacement, &path).expect("atomic replace");
    let (records, offset) = super::super::read_jsonl_range(&mut opened.file, 0, old.len() as u64)
        .await
        .expect("actual production range reader");
    assert_eq!(offset, old.len() as u64);
    assert_eq!(
        records,
        fixture_records(),
        "snapshot identity must describe the actual read bytes, even if the path was replaced"
    );
    drop(held);
}

#[tokio::test]
async fn same_length_same_mtime_replacement_reads_new_turns_and_append_keeps_identity() {
    let env = Env::new("workbuddy-rotation-contract-");
    let (store, input) = env.open().await;
    let path = env.projects().join("session-rotation.jsonl");
    std::fs::write(&path, "").expect("empty source");
    assert!(input.collect_now().await.expect("baseline").is_empty());
    let old = jsonl(&fixture_records(), false);
    std::fs::write(&path, &old).expect("original turn");
    write_hook_event(
        &env.hooks(),
        json!({"observed_at_ms":2000,"hook_event_name":"Stop","transcript_path":path}),
    );
    assert!(input.collect_now().await.expect("observe stop").is_empty());
    let first = input.collect_now().await.expect("first turn");
    assert_eq!(first.len(), 8);
    let canonical = std::fs::canonicalize(&path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    let first_meta = store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptFiles"]
        [&canonical]
        .clone();
    let old_meta = std::fs::metadata(&path).expect("old metadata");
    let old_modified = old_meta.modified().expect("mtime");
    let replacement = path.with_extension("replacement");
    let new = old.replace("synthetic", "rotatedxx");
    assert_eq!(new.len(), old.len());
    std::fs::write(&replacement, &new).expect("replacement");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .expect("replacement handle")
        .set_times(std::fs::FileTimes::new().set_modified(old_modified))
        .expect("same mtime");
    std::fs::rename(&replacement, &path).expect("same-name atomic replacement");
    let replaced_meta = std::fs::metadata(&path).expect("replacement metadata");
    assert_eq!(replaced_meta.len(), old_meta.len());
    assert_eq!(replaced_meta.modified().expect("mtime"), old_modified);
    write_hook_event(
        &env.hooks(),
        json!({"observed_at_ms":3000,"hook_event_name":"Stop","transcript_path":path}),
    );
    assert!(input
        .collect_now()
        .await
        .expect("observe replacement")
        .is_empty());
    let second = input.collect_now().await.expect("new identity turn");
    assert_eq!(second.len(), 8);
    assert!(second
        .iter()
        .all(|entry| !first.iter().any(|old| old.event_id == entry.event_id)));
    let second_meta = store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptFiles"]
        [&canonical]
        .clone();
    assert_ne!(second_meta["identity"], first_meta["identity"]);
    assert_eq!(
        store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        old.len() as u64
    );
    assert!(input.collect_now().await.expect("dedup").is_empty());
    let identity_before_append = second_meta["identity"].clone();
    let mut records = fixture_records();
    for record in &mut records {
        if let Some(id) = record.get("id").and_then(Value::as_str).map(str::to_string) {
            record["id"] = json!(id.replace("synthetic", "appendedx"));
        }
        if let Some(provider) = record
            .get_mut("providerData")
            .and_then(Value::as_object_mut)
        {
            for key in ["conversationRequestId", "messageId"] {
                if let Some(id) = provider
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    provider.insert(key.into(), json!(id.replace("synthetic", "appendedx")));
                }
            }
        }
    }
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append")
        .write_all(jsonl(&records, false).as_bytes())
        .expect("bytes");
    write_hook_event(
        &env.hooks(),
        json!({"observed_at_ms":4000,"hook_event_name":"Stop","transcript_path":path}),
    );
    assert!(input
        .collect_now()
        .await
        .expect("observe append")
        .is_empty());
    let appended = input.collect_now().await.expect("new append");
    assert_eq!(appended.len(), 8);
    let after_append = store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptFiles"]
        [&canonical]
        .clone();
    assert_eq!(after_append["identity"], identity_before_append);
    assert!(input.collect_now().await.expect("append dedup").is_empty());
}

async fn wall_until(label: &str, predicate: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !predicate() {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "{label}"
        );
        tokio::task::yield_now().await;
    }
}

fn close_real_watches(input: &WorkBuddyInput) {
    let watches = std::mem::take(&mut *input.inner.body.watches.lock().expect("watches"));
    for mut watch in watches {
        watch.close();
    }
}

async fn runtime_fixture(
    env: &Env,
    poll_interval_ms: u64,
) -> (
    Arc<StateStore>,
    WorkBuddyInput,
    Arc<std::sync::Mutex<Vec<AgentActivityEntry>>>,
    Arc<AtomicU64>,
) {
    std::fs::create_dir_all(env.projects()).expect("synthetic projects");
    std::fs::create_dir_all(env.hooks()).expect("synthetic hooks");
    let store = Arc::new(StateStore::new(env.state_path()));
    store.load().await;
    let input = WorkBuddyInput::new(WorkBuddyInputOptions {
        state_store: Arc::clone(&store),
        poll_interval_ms: Some(poll_interval_ms),
        work_buddy_root: Some(env.path().to_string_lossy().into_owned()),
        hook_event_dir: Some(env.hooks().to_string_lossy().into_owned()),
    });
    let entries = Arc::new(std::sync::Mutex::new(Vec::new()));
    let cycles = Arc::new(AtomicU64::new(0));
    let captured = Arc::clone(&entries);
    let completed = Arc::clone(&cycles);
    input.bind_collector(
        move |batch| captured.lock().expect("captured").extend_from_slice(batch),
        move |_| {
            completed.fetch_add(1, Ordering::SeqCst);
        },
    );
    (store, input, entries, cycles)
}

#[tokio::test(start_paused = true)]
async fn actual_thirty_second_fallback_and_five_second_stability_retry_emit_once_and_stop() {
    let env = Env::new("workbuddy-real-poll-");
    let (store, input, entries, cycles) = runtime_fixture(&env, 30_000).await;
    let path = env.projects().join("session-runtime.jsonl");
    std::fs::write(&path, "").expect("baseline source");
    input.start().await.expect("real hosted start");
    assert!(input.running());
    assert!(cycles.load(Ordering::SeqCst) > 0);
    close_real_watches(&input);
    input.inner.run_cycle().await;
    let baseline_cycles = cycles.load(Ordering::SeqCst);
    let data = jsonl(&fixture_records(), false);
    std::fs::write(&path, &data).expect("new transcript");
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms":now_ms(), "hook_event_name":"Stop", "transcript_path":path
        }),
    );
    tokio::time::advance(std::time::Duration::from_millis(29_999)).await;
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        cycles.load(Ordering::SeqCst),
        baseline_cycles,
        "no early fallback"
    );
    assert!(entries.lock().expect("entries").is_empty());
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    wall_until("actual thirty-second poll completed", || {
        cycles.load(Ordering::SeqCst) > baseline_cycles
    })
    .await;
    let observed_cycles = cycles.load(Ordering::SeqCst);
    assert!(
        entries.lock().expect("entries").is_empty(),
        "first Stop snapshot is unstable"
    );
    assert!(input.inner.body.retry_pending.load(Ordering::Acquire));
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(std::time::Duration::from_millis(4_999)).await;
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        cycles.load(Ordering::SeqCst),
        observed_cycles,
        "no early stability retry"
    );
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    wall_until("real five-second retry completed", || {
        cycles.load(Ordering::SeqCst) > observed_cycles
    })
    .await;
    assert_eq!(entries.lock().expect("entries").len(), 8);
    let canonical = std::fs::canonicalize(&path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        data.len() as u64
    );
    let before_dedup = cycles.load(Ordering::SeqCst);
    tokio::time::advance(std::time::Duration::from_millis(25_000)).await;
    wall_until("next periodic poll completed", || {
        cycles.load(Ordering::SeqCst) > before_dedup
    })
    .await;
    assert_eq!(
        entries.lock().expect("entries").len(),
        8,
        "periodic scan must not duplicate turns"
    );
    input.stop().await.expect("real hosted stop");
    assert!(!input.running());
    assert!(!input.inner.body.retry_pending.load(Ordering::Acquire));
    assert!(input
        .inner
        .body
        .retry_task
        .lock()
        .expect("retry task")
        .is_none());
    assert!(input.inner.body.watches.lock().expect("watches").is_empty());
    let stopped_cycles = cycles.load(Ordering::SeqCst);
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        cycles.load(Ordering::SeqCst),
        stopped_cycles,
        "stopped poll must not collect"
    );
    assert_eq!(entries.lock().expect("entries").len(), 8);
}

#[tokio::test(start_paused = true)]
async fn actual_stop_cancels_partial_retry_and_new_store_restart_recovers_whole_turn() {
    let env = Env::new("workbuddy-real-restart-");
    let (store, input, entries, _cycles) = runtime_fixture(&env, 3_600_000).await;
    let path = env.projects().join("session-partial.jsonl");
    std::fs::write(&path, "").expect("baseline");
    input.start().await.expect("start");
    close_real_watches(&input);
    input.inner.run_cycle().await;
    std::fs::write(&path, "{\"type\":\"message\"").expect("incomplete JSON source");
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms":now_ms(), "hook_event_name":"Stop", "transcript_path":path
        }),
    );
    input.inner.run_cycle().await;
    input.inner.run_cycle().await;
    assert!(entries.lock().expect("entries").is_empty());
    assert!(input.inner.body.retry_pending.load(Ordering::Acquire));
    let canonical = std::fs::canonicalize(&path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        0
    );
    input.stop().await.expect("stop pending retry");
    assert!(!input.inner.body.retry_pending.load(Ordering::Acquire));
    assert!(input.inner.body.retry_task.lock().expect("retry").is_none());
    store.save().await.expect("durable prefix checkpoint");
    drop(input);
    drop(store);
    let (reloaded, restarted, recovered, cycles) = runtime_fixture(&env, 3_600_000).await;
    assert_eq!(
        reloaded.get("workbuddy").extra().expect("loaded extra")["workbuddyTranscriptBytes"]
            [&canonical],
        0
    );
    restarted
        .start()
        .await
        .expect("restart with malformed tail");
    close_real_watches(&restarted);
    restarted.inner.run_cycle().await;
    assert!(recovered.lock().expect("recovered").is_empty());
    assert!(restarted.inner.body.retry_pending.load(Ordering::Acquire));
    let data = jsonl(&fixture_records(), false);
    std::fs::write(&path, &data).expect("repair synthetic source");
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    let before = cycles.load(Ordering::SeqCst);
    tokio::time::advance(std::time::Duration::from_secs(5)).await;
    wall_until("retry observes repaired file", || {
        cycles.load(Ordering::SeqCst) > before
    })
    .await;
    assert!(
        recovered.lock().expect("recovered").is_empty(),
        "changed snapshot still needs stability"
    );
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    let before = cycles.load(Ordering::SeqCst);
    tokio::time::advance(std::time::Duration::from_secs(5)).await;
    wall_until("retry reads stable repaired source", || {
        cycles.load(Ordering::SeqCst) > before
    })
    .await;
    assert_eq!(recovered.lock().expect("recovered").len(), 8);
    assert_eq!(
        reloaded.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        data.len() as u64
    );
    restarted.inner.run_cycle().await;
    assert_eq!(recovered.lock().expect("recovered").len(), 8);
    restarted.stop().await.expect("stop recovered input");
    assert!(!restarted.inner.body.retry_pending.load(Ordering::Acquire));
    assert!(restarted
        .inner
        .body
        .retry_task
        .lock()
        .expect("retry")
        .is_none());
    assert!(entries.lock().expect("old process output").is_empty());
}

#[cfg(target_os = "linux")]
async fn filesystem_pulses_until(directory: &Path, label: &str, predicate: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    let mut pulse = 0u64;
    while !predicate() {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "{label}"
        );
        pulse += 1;
        // This is a filesystem readiness signal, not a synthetic Agent event.
        std::fs::write(directory.join(".watch-readiness"), pulse.to_string())
            .expect("filesystem pulse");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn actual_hook_directory_wakes_hosted_collection_without_periodic_poll() {
    let env = Env::new("workbuddy-real-hook-wake-");
    let (store, input, entries, cycles) = runtime_fixture(&env, 3_600_000).await;
    std::fs::remove_dir_all(env.path().join("projects")).expect("projects absent at startup");
    input.start().await.expect("start hook watcher");
    assert_eq!(
        input.inner.body.watches.lock().expect("watches").len(),
        1,
        "only hook directory can wake collection"
    );
    let initial = cycles.load(Ordering::SeqCst);
    filesystem_pulses_until(&env.hooks(), "hook watch becomes active", || {
        cycles.load(Ordering::SeqCst) > initial
    })
    .await;
    std::fs::create_dir_all(env.projects()).expect("later projects directory");
    let path = env.projects().join("session-hook-wake.jsonl");
    let data = jsonl(&fixture_records(), false);
    std::fs::write(&path, &data).expect("new transcript in unwatched directory");
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms":now_ms(), "hook_event_name":"Stop", "transcript_path":path
        }),
    );
    filesystem_pulses_until(
        &env.hooks(),
        "hook wake drives stable Stop collection",
        || entries.lock().expect("entries").len() >= 8,
    )
    .await;
    assert_eq!(entries.lock().expect("entries").len(), 8);
    let canonical = std::fs::canonicalize(&path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        data.len() as u64
    );
    let completed = cycles.load(Ordering::SeqCst);
    filesystem_pulses_until(&env.hooks(), "postcommit hook wake completes", || {
        cycles.load(Ordering::SeqCst) > completed
    })
    .await;
    assert_eq!(
        entries.lock().expect("entries").len(),
        8,
        "wakeups cannot duplicate committed turns"
    );
    input.stop().await.expect("stop hook watcher");
    assert!(input.inner.body.watches.lock().expect("watches").is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn actual_transcript_directory_wakes_hosted_collection_when_hook_watch_is_closed() {
    let env = Env::new("workbuddy-real-file-wake-");
    let (store, input, entries, cycles) = runtime_fixture(&env, 3_600_000).await;
    let path = env.projects().join("session-file-wake.jsonl");
    std::fs::write(&path, "").expect("empty baseline transcript");
    input.start().await.expect("start real directory watches");
    {
        let mut watches = input.inner.body.watches.lock().expect("watches");
        assert_eq!(watches.len(), 2);
        let mut hook_watch = watches.pop().expect("hook watch");
        hook_watch.close();
        assert_eq!(
            watches.len(),
            1,
            "only projects directory can wake collection"
        );
    }
    let initial = cycles.load(Ordering::SeqCst);
    filesystem_pulses_until(&env.projects(), "project watch becomes active", || {
        cycles.load(Ordering::SeqCst) > initial
    })
    .await;
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms":now_ms(), "hook_event_name":"Stop", "transcript_path":path
        }),
    );
    let data = jsonl(&fixture_records(), false);
    std::fs::write(&path, &data).expect("real transcript file notification");
    filesystem_pulses_until(
        &env.projects(),
        "transcript wake drives stable Stop collection",
        || entries.lock().expect("entries").len() >= 8,
    )
    .await;
    assert_eq!(entries.lock().expect("entries").len(), 8);
    let canonical = std::fs::canonicalize(&path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        store.get("workbuddy").extra().expect("extra")["workbuddyTranscriptBytes"][&canonical],
        data.len() as u64
    );
    let completed = cycles.load(Ordering::SeqCst);
    filesystem_pulses_until(&env.projects(), "postcommit project wake completes", || {
        cycles.load(Ordering::SeqCst) > completed
    })
    .await;
    assert_eq!(entries.lock().expect("entries").len(), 8);
    input.stop().await.expect("stop project watcher");
    assert!(input.inner.body.watches.lock().expect("watches").is_empty());
}
