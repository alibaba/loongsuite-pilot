//! Exact summary contracts through real JSONL, cache and refresh/stop paths.
use super::*;
use serde_json::json;
use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;

fn config() -> StatusBarConfig {
    StatusBarConfig {
        enabled: true,
        metrics_summary_interval_ms: 60_000,
        runtime_refresh_interval_ms: 30_000,
    }
}
fn today() -> String {
    get_today_date_string()
}
fn writer(root: &Path) -> MetricsSummaryWriter {
    MetricsSummaryWriter::new(root.to_str().unwrap(), config(), None)
}
fn output(root: &Path) -> PathBuf {
    root.join("logs/output")
}
fn response(tokens: u64, extra: Value) -> Value {
    let mut row = json!({"event.name":"llm.response","gen_ai.session.id":"session-1","gen_ai.agent.type":"claude-code",
        "gen_ai.request.model":"claude-opus-4-6","gen_ai.usage.input_tokens":"1000","gen_ai.usage.output_tokens":"200",
        "gen_ai.usage.cache_read.input_tokens":"500","gen_ai.usage.cache_creation.input_tokens":"100",
        "gen_ai.usage.total_tokens":tokens.to_string()});
    row.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    row
}
fn request(extra: Value) -> Value {
    let mut row = json!({"event.name":"llm.request","gen_ai.session.id":"session-1","gen_ai.agent.type":"claude-code",
        "gen_ai.request.model":"claude-opus-4-6"});
    row.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    row
}
fn tool(extra: Value) -> Value {
    let mut row = request(extra);
    row["event.name"] = json!("tool.call");
    row
}
fn write_rows(path: &Path, rows: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}
fn append(path: &Path, row: &Value) {
    writeln!(
        std::fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{row}"
    )
    .unwrap();
}
fn summary(root: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(root.join("logs/metrics-summary.json")).unwrap()).unwrap()
}
fn fields(actual: &Value, expected: Value) {
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(&actual[key], value, "summary {key}");
    }
}

#[tokio::test]
async fn summary_schema_custom_output_and_daily_trend_are_real_files() {
    let root = tempfile::tempdir().unwrap();
    let path = output(root.path()).join(format!("claude-code-{}.jsonl", today()));
    write_rows(
        &path,
        &[
            request(json!({})),
            response(1200, json!({})),
            tool(json!({})),
            tool(json!({})),
        ],
    );
    writer(root.path()).refresh().await;
    let value = summary(root.path());
    assert_eq!(value["version"], 1);
    assert!(!value["generatedAt"].as_str().unwrap().is_empty());
    fields(
        &value["ranges"]["today"],
        json!({"totalTokens":1200.0,"inputTokens":1000.0,"outputTokens":200.0,
        "cacheReadTokens":500.0,"totalRequests":1,"totalToolCalls":2,"totalEvents":4,"totalSessions":1}),
    );
    let other = tempfile::tempdir().unwrap();
    let custom = other.path().join("custom-jsonl-output");
    write_rows(
        &custom.join(format!("codex-{}.jsonl", today())),
        &[response(1200, json!({}))],
    );
    MetricsSummaryWriter::new(
        other.path().to_str().unwrap(),
        config(),
        Some(custom.to_str().unwrap()),
    )
    .refresh()
    .await;
    let value = summary(other.path());
    assert_eq!(value["ranges"]["today"]["totalTokens"], 1200.0);
    assert_eq!(
        value["ranges"]["today"]["agentShares"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fields(
        &value["ranges"]["today"]["agentShares"][0],
        json!({"agentType":"claude-code","tokens":1200.0}),
    );
    let trend = tempfile::tempdir().unwrap();
    write_rows(
        &output(trend.path()).join(format!("claude-code-{}.jsonl", today())),
        &[response(5000, json!({}))],
    );
    writer(trend.path()).refresh().await;
    let value = summary(trend.path());
    let points = value["dailyTokens"].as_array().unwrap();
    assert_eq!(points.len(), 30);
    assert_eq!(
        points.iter().find(|p| p["day"] == today()).unwrap()["value"],
        5000
    );
}
#[tokio::test]
async fn session_and_agent_grouping_keep_cross_file_sessions_deduplicated() {
    let root = tempfile::tempdir().unwrap();
    write_rows(
        &output(root.path()).join(format!("claude-code-{}.jsonl", today())),
        &[
            request(json!({"gen_ai.session.id":"A"})),
            response(1200, json!({"gen_ai.session.id":"A"})),
            request(json!({"gen_ai.session.id":"B"})),
            response(1200, json!({"gen_ai.session.id":"B"})),
            request(json!({"gen_ai.session.id":"A"})),
            response(1200, json!({"gen_ai.session.id":"A"})),
        ],
    );
    writer(root.path()).refresh().await;
    assert_eq!(summary(root.path())["ranges"]["today"]["totalSessions"], 2);
    let root = tempfile::tempdir().unwrap();
    write_rows(
        &output(root.path()).join(format!("claude-code-{}.jsonl", today())),
        &[request(json!({})), response(1200, json!({}))],
    );
    write_rows(
        &output(root.path()).join(format!("cursor-{}.jsonl", today())),
        &[
            request(json!({"gen_ai.agent.type":"cursor"})),
            response(1200, json!({"gen_ai.agent.type":"cursor"})),
            tool(json!({"gen_ai.agent.type":"cursor"})),
        ],
    );
    writer(root.path()).refresh().await;
    let value = summary(root.path());
    let agents = value["ranges"]["today"]["agentShares"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    assert_eq!(
        agents.iter().find(|a| a["agentType"] == "cursor").unwrap()["events"],
        3
    );
    assert_eq!(
        agents
            .iter()
            .find(|a| a["agentType"] == "claude-code")
            .unwrap()["events"],
        2
    );
    assert_eq!(value["ranges"]["today"]["totalSessions"], 1);
}
#[tokio::test]
async fn model_provider_and_repo_shares_keep_exact_original_grouping_and_sort_order() {
    let root = tempfile::tempdir().unwrap();
    write_rows(
        &output(root.path()).join(format!("claude-code-{}.jsonl", today())),
        &[
            response(
                1000,
                json!({"gen_ai.request.model":"claude-opus-4-6","gen_ai.usage.input_tokens":"800","gen_ai.usage.output_tokens":"100","gen_ai.usage.cache_read.input_tokens":"0","gen_ai.usage.cache_creation.input_tokens":"0"}),
            ),
            response(
                500,
                json!({"gen_ai.request.model":"claude-sonnet-4-6","gen_ai.usage.input_tokens":"400","gen_ai.usage.output_tokens":"100","gen_ai.usage.cache_read.input_tokens":"0","gen_ai.usage.cache_creation.input_tokens":"0"}),
            ),
            response(
                2000,
                json!({"gen_ai.request.model":"claude-opus-4-6","gen_ai.usage.input_tokens":"1800","gen_ai.usage.output_tokens":"200","gen_ai.usage.cache_read.input_tokens":"0","gen_ai.usage.cache_creation.input_tokens":"0"}),
            ),
        ],
    );
    writer(root.path()).refresh().await;
    let value = summary(root.path());
    let models = value["ranges"]["today"]["modelShares"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    fields(
        &models[0],
        json!({"model":"claude-opus-4-6","totalTokens":3000.0}),
    );
    fields(
        &models[1],
        json!({"model":"claude-sonnet-4-6","totalTokens":500.0}),
    );
    let providers = tempfile::tempdir().unwrap();
    write_rows(
        &output(providers.path()).join(format!("claude-code-{}.jsonl", today())),
        &[
            response(3000, json!({"gen_ai.provider.name":"anthropic"})),
            response(2000, json!({"gen_ai.provider.name":"anthropic"})),
            response(1000, json!({"gen_ai.provider.name":"openai"})),
        ],
    );
    writer(providers.path()).refresh().await;
    let value = summary(providers.path());
    let providers = value["ranges"]["today"]["providerShares"]
        .as_array()
        .unwrap();
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0]["provider"], "anthropic");
    assert_eq!(providers[1]["provider"], "openai");
    assert!(
        providers[0]["totalTokens"].as_f64().unwrap()
            > providers[1]["totalTokens"].as_f64().unwrap()
    );
    let repos = tempfile::tempdir().unwrap();
    write_rows(
        &output(repos.path()).join(format!("claude-code-{}.jsonl", today())),
        &[
            request(json!({"git.repo":"sls/loongsuite-pilot","gen_ai.session.id":"s1"})),
            response(
                1200,
                json!({"git.repo":"sls/loongsuite-pilot","gen_ai.session.id":"s1"}),
            ),
            request(json!({"git.repo":"foo/bar","gen_ai.session.id":"s2"})),
            response(1200, json!({"git.repo":"foo/bar","gen_ai.session.id":"s2"})),
            tool(json!({"git.repo":"sls/loongsuite-pilot","gen_ai.session.id":"s1"})),
        ],
    );
    writer(repos.path()).refresh().await;
    let value = summary(repos.path());
    let repos = value["ranges"]["today"]["repoShares"].as_array().unwrap();
    assert_eq!(repos.len(), 2);
    fields(
        repos
            .iter()
            .find(|r| r["repo"] == "sls/loongsuite-pilot")
            .unwrap(),
        json!({"sessions":1,"events":3}),
    );
    fields(
        repos.iter().find(|r| r["repo"] == "foo/bar").unwrap(),
        json!({"sessions":1,"events":2}),
    );
}
#[tokio::test]
async fn incremental_resume_corruption_rebuild_and_empty_directory_preserve_exact_totals() {
    let root = tempfile::tempdir().unwrap();
    let path = output(root.path()).join(format!("codex-{}.jsonl", today()));
    write_rows(&path, &[response(1000, json!({}))]);
    let first = writer(root.path());
    first.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        1000.0
    );
    let next = response(500, json!({}));
    append(&path, &next);
    first.refresh().await;
    first.refresh().await;
    let value = summary(root.path());
    assert_eq!(value["ranges"]["today"]["totalTokens"], 1500.0);
    assert_eq!(value["ranges"]["today"]["totalSessions"], 1);
    let bytes = first.current_day_scan_bytes();
    assert_eq!(bytes.len(), 3);
    assert!(bytes[0] > 0);
    assert_eq!(bytes[1], format!("{next}\n").len() as u64);
    assert_eq!(bytes[2], 0);
    let restarted = writer(root.path());
    restarted.refresh().await;
    assert_eq!(restarted.current_day_scan_bytes(), vec![0]);
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        1500.0
    );
    assert_eq!(summary(root.path())["ranges"]["today"]["totalEvents"], 2);
    let corrupt = tempfile::tempdir().unwrap();
    let path = output(corrupt.path()).join(format!("codex-{}.jsonl", today()));
    write_rows(&path, &[response(1000, json!({}))]);
    let w = writer(corrupt.path());
    w.refresh().await;
    std::fs::write(
        corrupt.path().join("cache/metrics-current-day-state.json"),
        json!({"version":1,"day":today(),"files":[{"broken":true}]}).to_string(),
    )
    .unwrap();
    w.refresh().await;
    let value = summary(corrupt.path());
    assert_eq!(value["ranges"]["today"]["totalTokens"], 1000.0);
    assert_eq!(value["ranges"]["today"]["totalEvents"], 1);
    assert!(*w.current_day_scan_bytes().last().unwrap() > 0);
    let empty = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(output(empty.path())).unwrap();
    writer(empty.path()).refresh().await;
    let value = summary(empty.path());
    assert_eq!(value["ranges"]["today"]["totalTokens"], 0.0);
    assert_eq!(value["ranges"]["today"]["totalSessions"], 0);
    assert!(value["dailyTokens"].is_array());
}
#[tokio::test]
async fn persisted_previous_day_is_finalized_with_the_tail_written_after_last_refresh() {
    let root = tempfile::tempdir().unwrap();
    let day = today();
    let previous = NaiveDate::parse_from_str(&day, "%Y-%m-%d")
        .unwrap()
        .pred_opt()
        .unwrap()
        .to_string();
    let active = output(root.path()).join(format!("codex-{day}.jsonl"));
    write_rows(&active, &[response(1000, json!({}))]);
    writer(root.path()).refresh().await;
    // Reuse the real serialized checkpoint as a previous-day restart fixture.
    // Identity and byte floor remain unchanged; only its day/file label changes.
    let previous_name = format!("codex-{previous}.jsonl");
    let old = output(root.path()).join(&previous_name);
    std::fs::rename(&active, &old).unwrap();
    let state_path = root.path().join("cache/metrics-current-day-state.json");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["day"] = json!(previous);
    state["files"][0]["fileName"] = json!(previous_name);
    std::fs::write(&state_path, state.to_string()).unwrap();
    append(&old, &response(500, json!({})));
    writer(root.path()).refresh().await;
    let value = summary(root.path());
    assert_eq!(value["ranges"]["today"]["totalTokens"], 0.0);
    assert_eq!(value["ranges"]["sevenDays"]["totalTokens"], 1500.0);
    let digest: Value = serde_json::from_slice(
        &std::fs::read(root.path().join("cache/metrics-daily-digest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(digest["days"][&previous]["tokens"], 1500.0);
    let state: Value = serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
    assert_eq!(state["day"], day);
}
struct Release(Option<std::sync::mpsc::Sender<()>>);
impl Release {
    fn now(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.now();
    }
}
async fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let mut future = future;
    std::future::poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}
#[test]
fn stop_waits_for_real_inflight_refresh_and_no_later_refresh_runs() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (ready, entered) = std::sync::mpsc::channel();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut release = Release(Some(tx));
    rt.spawn_blocking(move || {
        ready.send(()).unwrap();
        let _ = rx.recv();
    });
    entered
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let w = writer(root.path());
    rt.block_on(async {
        let mut refresh = Box::pin(w.refresh());
        assert!(poll_once(refresh.as_mut()).await.is_pending());
        let mut stop = Box::pin(w.stop());
        assert!(
            poll_once(stop.as_mut()).await.is_pending(),
            "stop returned while aggregate still owns its refresh lock"
        );
        release.now();
        refresh.await;
        stop.await;
        let before = std::fs::read(root.path().join("logs/metrics-summary.json")).unwrap();
        write_rows(
            &output(root.path()).join(format!("codex-{}.jsonl", today())),
            &[response(500, json!({}))],
        );
        w.refresh().await;
        assert_eq!(
            std::fs::read(root.path().join("logs/metrics-summary.json")).unwrap(),
            before
        );
    });
}
#[tokio::test]
async fn rename_gap_retention_and_retired_inode_resumption_do_not_double_count() {
    let root = tempfile::tempdir().unwrap();
    let out = output(root.path());
    let day = today();
    let active = out.join(format!("copilot-{day}.jsonl"));
    let closed = out.join(format!("copilot.part-{}-{day}.jsonl", "a".repeat(32)));
    write_rows(&active, &[response(1200, json!({}))]);
    let w = writer(root.path());
    w.refresh().await;
    std::fs::rename(&active, &closed).unwrap();
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        1200.0
    );
    write_rows(&active, &[response(1200, json!({}))]);
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        2400.0
    );
    writer(root.path()).refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        2400.0
    );
    let root = tempfile::tempdir().unwrap();
    let out = output(root.path());
    let active = out.join(format!("copilot-{day}.jsonl"));
    let closed = out.join(format!("copilot.part-{}-{day}.jsonl", "a".repeat(32)));
    write_rows(&active, &[response(1200, json!({}))]);
    let w = writer(root.path());
    w.refresh().await;
    for i in 0..2 {
        std::fs::rename(&active, &closed).unwrap();
        write_rows(&active, &[response(1200, json!({}))]);
        std::fs::remove_file(&closed).unwrap();
        w.refresh().await;
        assert_eq!(
            summary(root.path())["ranges"]["today"]["totalTokens"],
            ((i + 2) * 1200) as f64
        );
    }
    writer(root.path()).refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        3600.0
    );
    let root = tempfile::tempdir().unwrap();
    let out = output(root.path());
    let active = out.join(format!("copilot-{day}.jsonl"));
    let closed = out.join(format!("copilot.part-{}-{day}.jsonl", "a".repeat(32)));
    let hidden = root.path().join("hidden-segment.jsonl");
    write_rows(&active, &[response(1200, json!({}))]);
    let w = writer(root.path());
    w.refresh().await;
    std::fs::rename(&active, &hidden).unwrap();
    write_rows(&active, &[response(1200, json!({}))]);
    w.refresh().await;
    std::fs::rename(&hidden, &closed).unwrap();
    append(&closed, &response(1200, json!({})));
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        3600.0
    );
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        3600.0
    );
}
async fn capture_logs(root: &Path) {
    std::env::set_var("LOG_LEVEL", "debug");
    crate::utils::init_file_logging(root.join("capture/summary.log").to_str().unwrap())
        .await
        .unwrap();
}
fn logs(root: &Path) -> Vec<Value> {
    crate::utils::flush_logs_sync();
    std::fs::read_dir(root.join("capture"))
        .unwrap()
        .flatten()
        .flat_map(|entry| {
            std::fs::read_to_string(entry.path())
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}
#[tokio::test]
async fn stat_open_rotation_warns_without_attributing_new_bytes_to_the_old_inode() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    capture_logs(root.path()).await;
    let out = output(root.path());
    let day = today();
    let active = out.join(format!("copilot-{day}.jsonl"));
    let closed = out.join(format!("copilot.part-{}-{day}.jsonl", "a".repeat(32)));
    write_rows(&active, &[response(1200, json!({}))]);
    let w = writer(root.path());
    w.refresh().await;
    append(&active, &response(1200, json!({})));
    let once = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let gate = once.clone();
    let a = active.clone();
    let c = closed.clone();
    *w.before_current_scan.lock().unwrap() = Some(Arc::new(move |path: &str| {
        if Path::new(path) == a.as_path() && gate.swap(false, std::sync::atomic::Ordering::SeqCst) {
            std::fs::rename(&a, &c).unwrap();
            write_rows(&a, &[response(1200, json!({}))]);
        }
    }));
    w.refresh().await;
    assert!(!once.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        1200.0
    );
    assert!(logs(root.path())
        .iter()
        .any(|row| row["msg"] == "metrics summary refresh failed"
            && row["error"] == "Error: JSONL file identity changed before scan"));
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        3600.0
    );
    w.refresh().await;
    assert_eq!(
        summary(root.path())["ranges"]["today"]["totalTokens"],
        3600.0
    );
}
#[cfg(unix)]
#[tokio::test]
async fn oversized_current_and_historical_sources_keep_cached_totals_without_scanning() {
    if !crate::utils::isolated_env_test() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    capture_logs(root.path()).await;
    let day = today();
    let previous = NaiveDate::parse_from_str(&day, "%Y-%m-%d")
        .unwrap()
        .pred_opt()
        .unwrap()
        .to_string();
    let current = output(root.path()).join(format!("copilot-{day}.jsonl"));
    let historical = output(root.path()).join(format!("copilot-{previous}.jsonl"));
    write_rows(&current, &[response(1200, json!({}))]);
    write_rows(&historical, &[response(1200, json!({}))]);
    let w = writer(root.path());
    w.refresh().await;
    let before = summary(root.path());
    for file in [&current, &historical] {
        std::fs::OpenOptions::new()
            .write(true)
            .open(file)
            .unwrap()
            .set_len(LOCAL_LOG_EMERGENCY_FILE_BYTES + 1)
            .unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), w.refresh())
        .await
        .unwrap();
    let after = summary(root.path());
    assert_eq!(
        after["ranges"]["today"]["totalTokens"],
        before["ranges"]["today"]["totalTokens"]
    );
    assert_eq!(
        after["ranges"]["sevenDays"]["totalTokens"],
        before["ranges"]["sevenDays"]["totalTokens"]
    );
    assert_eq!(*w.current_day_scan_bytes().last().unwrap(), 0);
    assert_eq!(
        logs(root.path())
            .iter()
            .filter(|row| row["msg"] == "metrics summary skipped oversized output file")
            .count(),
        2
    );
}
#[tokio::test]
async fn standard_and_historical_names_count_execution_once_and_never_charge_delegation_usage() {
    for (request_name, response_name, call_name, result_name) in [
        ("llm.request", "llm.response", "tool.call", "tool.result"),
        (
            "gen_ai.model.request",
            "gen_ai.model.response",
            "gen_ai.tool.call",
            "gen_ai.tool.result",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut call = tool(json!({"gen_ai.agent.type":"codex"}));
        call["event.name"] = json!(call_name);
        let mut result = call.clone();
        result["event.name"] = json!(result_name);
        write_rows(
            &output(root.path()).join(format!("codex-{}.jsonl", today())),
            &[
                request(json!({"event.name":request_name,"gen_ai.agent.type":"codex"})),
                response(
                    1200,
                    json!({"event.name":response_name,"gen_ai.agent.type":"codex"}),
                ),
                call,
                result,
                response(
                    999999,
                    json!({"event.name":"gen_ai.agent.invoke","gen_ai.agent.type":"codex","gen_ai.agent.invocation.id":"delegation-1","gen_ai.tool.name":"spawn_agent"}),
                ),
                response(
                    999999,
                    json!({"event.name":"gen_ai.agent.result","gen_ai.agent.type":"codex","gen_ai.agent.invocation.id":"delegation-1","gen_ai.tool.name":"spawn_agent"}),
                ),
            ],
        );
        writer(root.path()).refresh().await;
        let value = summary(root.path());
        fields(
            &value["ranges"]["today"],
            json!({"totalRequests":1,"totalToolCalls":1,"totalEvents":6,"totalSessions":1,
            "totalTokens":1200.0,"inputTokens":1000.0,"outputTokens":200.0,"cacheReadTokens":500.0,"cacheCreationTokens":100.0}),
        );
        let models = value["ranges"]["today"]["modelShares"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        fields(
            &models[0],
            json!({"model":"claude-opus-4-6","totalTokens":1200.0}),
        );
        let agents = value["ranges"]["today"]["agentShares"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        fields(
            &agents[0],
            json!({"agentType":"codex","tokens":1200.0,"events":6}),
        );
    }
}
