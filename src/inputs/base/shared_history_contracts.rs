use super::*;

fn original_schema(value: &Value) -> bool {
    let text = |name: &str| value.get(name).and_then(Value::as_str);
    text("time_unix_nano").is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
        && value.get("observed_time_unix_nano").is_none_or(|v| {
            v.as_str()
                .is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
        })
        && text("event.id").is_some_and(|v| !v.is_empty())
        && matches!(
            text("event.name"),
            Some(
                "llm.request"
                    | "llm.response"
                    | "tool.call"
                    | "tool.result"
                    | "skill.use"
                    | "tool.approve"
                    | "agent.input"
                    | "other"
            )
        )
        && text("user.id").is_some()
        && text("gen_ai.session.id").is_some()
        && text("gen_ai.agent.type").is_some_and(|v| !v.is_empty())
        && text("gen_ai.provider.name").is_some_and(|v| !v.is_empty())
}
fn assert_schema(entry: &AgentActivityEntry) {
    let value = serde_json::to_value(entry).unwrap();
    assert!(original_schema(&value), "{value}");
    for (key, bad) in [
        ("event.id", json!("")),
        ("event.name", json!("invalid")),
        ("time_unix_nano", json!("not-numeric")),
        ("gen_ai.provider.name", json!("")),
    ] {
        let mut invalid = value.clone();
        invalid[key] = bad;
        assert!(!original_schema(&invalid));
    }
}
#[tokio::test]
async fn edge_special_paths_unchanged_restart_and_empty_session_are_real_file_contracts() {
    let (dir, store) = temp_store();
    let file = dir
        .path()
        .join(format!("test-hook-{}.jsonl", get_today_date_string()));
    let expected = ["/path/with spaces/file.ts", "/项目/源码/文件.ts"];
    let lines = expected
        .iter()
        .map(|p| json!({"file_path":p}).to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&file, lines).unwrap();
    for (round, count) in [(0, 2), (1, 0)] {
        let input = hook_input(dir.path(), store.clone(), false);
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
        input.start().await.unwrap();
        input.stop().await.unwrap();
        let rows = rows.lock().unwrap();
        assert_eq!(rows.len(), count, "restart {round}");
        if count > 0 {
            assert_eq!(entry_paths(&rows), expected);
        }
    }
    let blank = dir.path().join("only-empty-lines.jsonl");
    std::fs::write(&blank, "\n\n\n").unwrap();
    let input = contract_session(
        dir.path(),
        store,
        vec![blank.to_string_lossy().into_owned()],
        false,
    );
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert!(rows.lock().unwrap().is_empty());
    assert!(input.body.inner().records.lock().unwrap().is_empty());
}
#[tokio::test]
async fn missing_hook_source_recovers_on_recreated_input_with_same_store() {
    let (dir, store) = temp_store();
    let logs = dir.path().join("not-yet-created");
    let first = hook_input(&logs, store.clone(), false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    first.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    first.start().await.unwrap();
    first.stop().await.unwrap();
    assert!(rows.lock().unwrap().is_empty());
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join(format!("test-hook-{}.jsonl", get_today_date_string())),
        json!({"file_path":"/recovered.ts"}).to_string() + "\n",
    )
    .unwrap();
    let second = hook_input(&logs, store, false);
    let observed = rows.clone();
    second.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    second.start().await.unwrap();
    second.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/recovered.ts"]);
}
struct SelectiveHook {
    paths: HookPaths,
    calls: AtomicUsize,
}
#[async_trait]
impl HookBody for SelectiveHook {
    fn id(&self) -> &str {
        "selective-hook"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::ClaudeCliHook
    }
    fn paths(&self) -> &HookPaths {
        &self.paths
    }
    async fn transform_record(
        &self,
        _: &InputRuntime,
        record: &mut Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if record.get("event_type").and_then(Value::as_str) != Some("tool_use") {
            return Ok(None);
        }
        Ok(Some(build_test_entry(
            &json!({"agentType":ClientType::ClaudeCliHook.as_str(),"filePath":record["file_path"],"timestamp":record["timestamp"]}),
        )))
    }
}
fn selective(
    dir: &std::path::Path,
    store: Arc<StateStore>,
) -> Arc<HostedInput<HookAdapter<SelectiveHook>>> {
    hosted_hook(
        SelectiveHook {
            paths: HookPaths {
                log_dir: dir.to_string_lossy().into_owned(),
                log_prefix: "selective-hook".into(),
                cold_start_keep_last_turn_only: false,
            },
            calls: AtomicUsize::new(0),
        },
        "SelectiveHook",
        store,
        Some(60000),
    )
}
#[tokio::test]
async fn hook_extension_filters_per_line_and_restarts_at_owned_offset_with_schema_valid_output() {
    use std::io::Write;
    let (dir, store) = temp_store();
    let file = dir
        .path()
        .join(format!("selective-hook-{}.jsonl", get_today_date_string()));
    std::fs::write(
        &file,
        [
            json!({"event_type":"tool_use","file_path":"/first.ts","timestamp":1000}).to_string(),
            json!({"event_type":"other","file_path":"/b.ts"}).to_string(),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let first = selective(dir.path(), store.clone());
    assert_eq!(first.collection_method(), CollectionMethod::HookJsonl);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    first.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    first.start().await.unwrap();
    first.stop().await.unwrap();
    assert_eq!(first.body.inner().calls.load(Ordering::SeqCst), 2);
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/first.ts"]);
    assert_eq!(
        rows.lock().unwrap()[0].agent_type,
        ClientType::ClaudeCliHook.as_str()
    );
    assert_schema(&rows.lock().unwrap()[0]);
    assert!(store.get_offset("selective-hook") > 0.0);
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap(),
        "{}",
        json!({"event_type":"tool_use","file_path":"/second.ts","timestamp":1001})
    )
    .unwrap();
    let second = selective(dir.path(), store);
    let more = Arc::new(Mutex::new(Vec::new()));
    let observed = more.clone();
    second.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    second.start().await.unwrap();
    second.stop().await.unwrap();
    assert_eq!(entry_paths(&more.lock().unwrap()), ["/second.ts"]);
    assert_schema(&more.lock().unwrap()[0]);
}
#[tokio::test]
async fn session_extension_preserves_original_action_fields_and_validates_schema() {
    for (name, path) in [
        ("session.jsonl", "/proj/ext.ts"),
        ("valid.jsonl", "/proj/valid.ts"),
    ] {
        let (dir, store) = temp_store();
        std::fs::write(
            dir.path().join(name),
            json!({"type":"action","session_id":"ext-1","file_path":path,"timestamp":1000})
                .to_string()
                + "\n",
        )
        .unwrap();
        let input = hosted_session(
            ExtSession {
                paths: SessionPaths {
                    session_dir: dir.path().to_string_lossy().into_owned(),
                    file_pattern: "*.jsonl".into(),
                },
                dir: dir.path().to_string_lossy().into_owned(),
            },
            "MockSessionInput",
            store,
            Some(60000),
        );
        assert_eq!(
            input.collection_method(),
            CollectionMethod::SessionFilePolling
        );
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
        input.start().await.unwrap();
        input.stop().await.unwrap();
        let rows = rows.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent_type, ClientType::Qoder.as_str());
        assert_eq!(legacy_file_path(&rows[0]), Some(path));
        assert_schema(&rows[0]);
    }
}
fn history_ide(
    dir: &std::path::Path,
    store: Arc<StateStore>,
    snapshot: &str,
    events: Vec<CodeGenerationEvent>,
) -> Arc<HostedInput<IdeAdapter<IdeProbe>>> {
    hosted_ide(
        IdeProbe {
            events: Mutex::new(events),
            fail_path: Mutex::new(None),
            calls: AtomicUsize::new(0),
            scan_calls: AtomicUsize::new(0),
            since: Mutex::new(None),
            snapshot: SnapshotStore::new(dir.join(snapshot)),
            root: dir.to_string_lossy().into_owned(),
        },
        "SharedIde",
        store,
        Some(60000),
    )
}
#[tokio::test]
async fn ide_extension_scans_builds_validates_schema_and_recreated_snapshot_prevents_duplicate() {
    let (dir, store) = temp_store();
    let input = history_ide(
        dir.path(),
        store.clone(),
        "two.json",
        vec![code_event("/a.ts", 1000), code_event("/b.ts", 1001)],
    );
    assert_eq!(
        input.collection_method(),
        CollectionMethod::IdeSnapshotPolling
    );
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(input.body.inner().scan_calls.load(Ordering::SeqCst), 1);
    assert_eq!(input.body.inner().calls.load(Ordering::SeqCst), 2);
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/a.ts", "/b.ts"]);
    for entry in rows.lock().unwrap().iter() {
        assert_schema(entry)
    }
    for expected in [1, 0] {
        let input = history_ide(
            dir.path(),
            store.clone(),
            "dedup.json",
            vec![code_event("/dedup.ts", 1000)],
        );
        let rows = Arc::new(Mutex::new(Vec::new()));
        let observed = rows.clone();
        input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
        input.start().await.unwrap();
        input.stop().await.unwrap();
        assert_eq!(
            rows.lock().unwrap().len(),
            expected,
            "recreated actual SnapshotStore"
        );
        for entry in rows.lock().unwrap().iter() {
            assert_schema(entry)
        }
    }
}
struct LoggingBody {
    fail: bool,
}
#[async_trait]
impl InputBody for LoggingBody {
    fn id(&self) -> &str {
        "shared-history-log"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::Qoder
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }
    async fn collect(&self, _: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        if self.fail {
            anyhow::bail!("test collection error")
        }
        Ok(vec![
            build_test_entry(&json!({})),
            build_test_entry(&json!({})),
        ])
    }
}
async fn real_log_child() {
    let (dir, store) = temp_store();
    for fail in [false, true] {
        let input = HostedInput::new(
            LoggingBody { fail },
            "SharedLogInput",
            store.clone(),
            Some(60000),
        );
        input.start().await.unwrap();
        input.stop().await.unwrap();
    }
    std::fs::write(
        dir.path()
            .join(format!("test-hook-{}.jsonl", get_today_date_string())),
        "BAD_JSON_LINE\n{\"file_path\":\"/good.ts\"}\n",
    )
    .unwrap();
    let input = hook_input(dir.path(), store, false);
    let rows = Arc::new(Mutex::new(Vec::new()));
    let observed = rows.clone();
    input.on_entries(move |e| observed.lock().unwrap().extend_from_slice(e));
    input.start().await.unwrap();
    input.stop().await.unwrap();
    assert_eq!(entry_paths(&rows.lock().unwrap()), ["/good.ts"]);
}
#[tokio::test]
async fn actual_json_logs_preserve_lifecycle_count_error_and_malformed_line_diagnostics() {
    const FLAG: &str = "PILOT_SHARED_HISTORY_LOG_CHILD";
    if std::env::var_os(FLAG).is_some() {
        real_log_child().await;
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let name = std::thread::current().name().unwrap().to_owned();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &name, "--nocapture"])
        .env_clear()
        .env(FLAG, "1")
        .env("LOG_LEVEL", "debug")
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("CODEX_HOME", home.join("codex"))
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .env("GIT_CONFIG_GLOBAL", home.join("no-git"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("PATH", home.join("no-runtimes"))
        .current_dir(&home)
        .kill_on_drop(true);
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let records = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .collect::<Vec<_>>();
    for message in ["starting", "stopped"] {
        assert!(
            records.iter().any(|e| e["tag"] == "SharedLogInput"
                && e["level"] == "INFO"
                && e["msg"] == message),
            "{records:?}"
        );
    }
    assert!(
        records.iter().any(|e| e["tag"] == "SharedLogInput"
            && e["level"] == "DEBUG"
            && e["msg"] == "cycle produced entries"
            && e["count"] == 2),
        "{records:?}"
    );
    // Native anyhow errors have no JavaScript Error class prefix; retain the reason.
    assert!(
        records.iter().any(|e| e["tag"] == "SharedLogInput"
            && e["level"] == "ERROR"
            && e["msg"] == "collection cycle failed"
            && e["error"] == "test collection error"),
        "{records:?}"
    );
    assert!(
        records.iter().any(|e| e["tag"] == "TestHookInput"
            && e["level"] == "WARN"
            && e["msg"] == "invalid JSONL line"
            && e["line"]
                .as_str()
                .is_some_and(|s| s.contains("BAD_JSON_LINE"))),
        "{records:?}"
    );
}
