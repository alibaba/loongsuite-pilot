use super::*;
use crate::inputs::qoder_trace::{
    prompt_ownership::NativeQoderPromptOwnershipResolver, transcript_source::QoderTranscriptSource,
};
use std::sync::Arc;
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let file = root.join("native.jsonl");
        fs::write(&file, []).unwrap();
        Self {
            _temp: temp,
            root,
            file,
        }
    }
    fn env(&self, agent: &str) -> Env {
        let mut env = Env::new();
        for key in ["HOME", "USERPROFILE", "LOONGSUITE_PILOT_DATA_DIR"] {
            env.insert(key.into(), self.root.to_string_lossy().into_owned());
        }
        env.insert(
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            self.root.join("config.json").to_string_lossy().into_owned(),
        );
        env.insert("LOONGSUITE_PILOT_USER_ID".into(), "employee-123".into());
        env.insert(
            "MAIN522_REPLY".into(),
            self.reply(agent).to_string_lossy().into_owned(),
        );
        env.insert(
            "MAIN522_COUNTER".into(),
            self.counter(agent).to_string_lossy().into_owned(),
        );
        env
    }
    fn home(&self, agent: &str) -> PathBuf {
        self.root.join(format!(".{agent}"))
    }
    fn reply(&self, agent: &str) -> PathBuf {
        self.root.join(format!("{agent}-reply.json"))
    }
    fn counter(&self, agent: &str) -> PathBuf {
        self.root.join(format!("{agent}-counter"))
    }
    fn status(&self, agent: &str, patch: Value) {
        let path = self.home(agent);
        fs::create_dir_all(&path).unwrap();
        let mut value = json!({"schema_version":1,"product":if agent=="qoder"{"qoder"}else{"qodercn"},"writer":"main","logged_in":true,"snapshot_at":"2026-10-01T00:00:00.000Z","name":"desktop-user","email":"desktop@example.com"});
        for (key, patch_value) in patch.as_object().unwrap() {
            value_clone_insert(&mut value, key, patch_value);
        }
        fs::write(path.join(".qoder-app-status.json"), value.to_string()).unwrap();
    }
    #[cfg(unix)]
    fn cli(&self, agent: &str, script: Option<&str>) {
        use std::os::unix::fs::PermissionsExt;
        let flavor = if agent == "qoder" {
            "qodercli"
        } else {
            "qoderclicn"
        };
        let directory = self.home(agent).join("bin").join(flavor);
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir_all(self.home(agent).join(".auth")).unwrap();
        fs::write(
            self.home(agent).join(".auth/user"),
            "synthetic-auth-no-secret-copy",
        )
        .unwrap();
        let executable = directory.join(format!("{flavor}-1.0.0"));
        let script = script.unwrap_or(
            "#!/bin/sh\nprintf '%s\\n' status >> \"$MAIN522_COUNTER\"\ncat \"$MAIN522_REPLY\"\n",
        );
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(self.reply(agent),json!({"logged_in":true,"username":format!("{agent}-cli-user"),"email":format!("{agent}@example.com"),"access_token":"do-not-copy-status-token"}).to_string()).unwrap();
    }
    fn calls(&self, agent: &str) -> usize {
        fs::read_to_string(self.counter(agent))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }
    fn payload(&self, product: Value, extra: Value) -> Value {
        json!({"session_id":"identity-session","transcript_path":self.file,"hook_event_name":"Stop","cwd":self.root,"parent_business_info":product,"extra":extra})
    }
    fn publish(&self, agent: &str, payload: Value) -> Value {
        let args = vec![
            "--wakeup-only".into(),
            "--agent-id".into(),
            agent.into(),
            "--log-prefix".into(),
            agent.into(),
        ];
        let env = self.env(agent);
        let stdin = serde_json::to_vec(&payload).unwrap();
        let mut output = Vec::new();
        let code = run(&mut HookRequest {
            args: &args,
            stdin: &stdin,
            env: &env,
            stdout: &mut output,
        });
        assert_eq!(code, 0);
        assert_eq!(output, b"{}\n");
        let directory = self
            .root
            .join("state/qoder-transcripts")
            .join(agent)
            .join("sources");
        let source = fs::read_dir(directory)
            .unwrap()
            .map(Result::unwrap)
            .map(|x| x.path().join("source.json"))
            .find(|p| p.is_file())
            .unwrap();
        serde_json::from_str(&fs::read_to_string(source).unwrap()).unwrap()
    }
    fn rows(&self, index: usize, append: bool, cli: bool) {
        use std::io::Write;
        // Match the upstream identity suites: user, assistant, last-prompt.
        let rows = vec![
            json!({"type":"user","uuid":format!("prompt-{index}"),"sessionId":"identity-session","userId":"transcript-account","timestamp":format!("2026-10-01T10:00:{:02}.010Z",index*3),"entrypoint":if cli{"cli"}else{"ide"},"message":{"role":"user","content":format!("hello {index}")}}),
            json!({"type":"assistant","uuid":format!("response-{index}"),"sessionId":"identity-session","timestamp":format!("2026-10-01T10:00:{:02}.500Z",index*3),"message":{"id":format!("response-{index}"),"role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"hello back"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":3}}}),
            json!({"type":"last-prompt","sessionId":"identity-session","lastPrompt":format!("hello {index}")}),
        ];
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&self.file)
            .unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
    }
    fn source(&self, agent: &str) -> QoderTranscriptSource {
        QoderTranscriptSource::new(
            self.root.clone(),
            agent.into(),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(Vec::new())),
        )
    }
    async fn collect(&self, source: &QoderTranscriptSource, state: &mut Value) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let batch = source.read(Some(state), true).await.unwrap();
            *state = batch.state;
            if !batch.records.is_empty() {
                return batch.records;
            }
            assert!(
                Instant::now() < deadline,
                "the real Source did not finish its closed turn"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
fn value_clone_insert(root: &mut Value, key: &str, value: &Value) {
    root[key] = value.clone();
}
fn identity(name: &str, email: &str) -> Value {
    json!({"name":name,"email":email})
}
fn assert_records(records: &[Value], name: &str, email: &str) {
    assert!(!records.is_empty());
    assert!(records.iter().any(|r| r["event.name"] == "other"));
    for record in records {
        assert_eq!(record["user.name"], name);
        assert_eq!(record["user.email"], email);
        assert!(record.get("user.uid").is_none());
        assert!(!record.to_string().contains("do-not-copy-status-token"));
    }
}
#[cfg(unix)]
#[tokio::test]
async fn main522_cli_products_use_advertised_version_separate_caches_and_preserve_source_identity()
{
    let f = Fixture::new();
    for agent in ["qoder", "qoder-cn"] {
        f.cli(agent, None);
        f.status(agent, json!({"name":"desktop-other"}));
        f.rows(1, false, false);
        let payload = f.payload(
            json!({"product":"cli","version":" 1.0.0 "}),
            json!({"user":{"name":"hook-other","email":"hook@example.com"}}),
        );
        let source_meta = f.publish(agent, payload.clone());
        let name = format!("{agent}-cli-user");
        let email = format!("{agent}@example.com");
        assert_eq!(source_meta["userIdentity"], identity(&name, &email));
        assert_eq!(f.calls(agent), 1);
        let source = f.source(agent);
        let mut state = json!({});
        let records = f.collect(&source, &mut state).await;
        assert_records(&records, &name, &email);
        f.publish(agent, payload);
        assert_eq!(f.calls(agent), 1);
        let cache = if agent == "qoder" {
            "qoder-cli-user-identity.json"
        } else {
            "qoder-cn-cli-user-identity.json"
        };
        let cache = fs::read_to_string(f.root.join("state/hooks").join(cache)).unwrap();
        assert!(!cache.contains("do-not-copy-status-token"));
        assert!(!cache.contains("synthetic-auth-no-secret-copy"));
        source.stop();
    }
}
#[cfg(unix)]
#[test]
fn main522_app_uses_only_its_public_snapshot_and_ide_uses_only_nested_user() {
    for agent in ["qoder", "qoder-cn"] {
        let f = Fixture::new();
        f.cli(agent, None);
        f.status(agent, json!({}));
        let metadata = f.publish(
            agent,
            f.payload(
                json!({"product":"app"}),
                json!({"user":{"name":"hook-other","email":"hook@example.com"}}),
            ),
        );
        assert_eq!(
            metadata["userIdentity"],
            identity("desktop-user", "desktop@example.com")
        );
        assert_eq!(f.calls(agent), 0);
        for product in [
            Value::Null,
            json!([]),
            json!("app"),
            json!({"product":"APP"}),
            json!({}),
        ] {
            let got = resolve_qoder_hook_user_identity(
                &f.env(agent),
                agent,
                &f.payload(
                    product,
                    json!({"user":{"name":" ide-name "},"email":"git@example.com"}),
                ),
            )
            .unwrap();
            assert_eq!(identity_json(&got), identity("ide-name", "").to_string());
        }
        assert_eq!(f.calls(agent), 0);
        assert!(resolve_qoder_hook_user_identity(
            &f.env(agent),
            agent,
            &f.payload(Value::Null, json!({"email":"git@example.com"}))
        )
        .is_none());
    }
}
#[cfg(unix)]
#[test]
fn main522_missing_or_invalid_version_never_guesses_version_txt_or_another_product_cli() {
    for agent in ["qoder", "qoder-cn"] {
        let f = Fixture::new();
        f.cli(agent, None);
        f.status(agent, json!({}));
        let flavor = if agent == "qoder" {
            "qodercli"
        } else {
            "qoderclicn"
        };
        fs::write(
            f.home(agent).join("bin").join(flavor).join("version.txt"),
            "1.0.0",
        )
        .unwrap();
        for version in [
            Value::Null,
            json!(""),
            json!("../1.0.0"),
            json!("1..0"),
            json!("1.0.0-dev"),
            json!("1.0.0/../../other"),
        ] {
            let got = resolve_qoder_hook_user_identity(
                &f.env(agent),
                agent,
                &f.payload(json!({"product":"cli","version":version}), json!({})),
            )
            .unwrap();
            assert_eq!(got.name.as_deref(), Some("desktop-user"));
        }
        assert_eq!(f.calls(agent), 0);
    }
}
#[cfg(unix)]
#[test]
fn main522_cli_failure_and_auth_fingerprint_cache_keep_original_ttl_and_refresh_contract() {
    for agent in ["qoder", "qoder-cn"] {
        let f = Fixture::new();
        f.cli(agent, None);
        let payload = f.payload(json!({"product":"cli","version":"1.0.0"}), json!({}));
        let env = f.env(agent);
        let first = resolve_qoder_hook_user_identity(&env, agent, &payload).unwrap();
        assert!(first.name.unwrap().contains("cli-user"));
        fs::write(
            f.reply(agent),
            json!({"logged_in":true,"username":"switched-user","email":"switched@example.com"})
                .to_string(),
        )
        .unwrap();
        assert_ne!(
            resolve_qoder_hook_user_identity(&env, agent, &payload)
                .unwrap()
                .name
                .as_deref(),
            Some("switched-user")
        );
        assert_eq!(f.calls(agent), 1);
        fs::write(f.home(agent).join(".auth/user"), "different-auth-and-size").unwrap();
        assert_eq!(
            resolve_qoder_hook_user_identity(&env, agent, &payload)
                .unwrap()
                .name
                .as_deref(),
            Some("switched-user")
        );
        assert_eq!(f.calls(agent), 2);
        fs::write(f.reply(agent), "bad-json").unwrap();
        fs::write(
            f.home(agent).join(".auth/user"),
            "different-auth-for-failure",
        )
        .unwrap();
        assert!(resolve_qoder_hook_user_identity(&env, agent, &payload).is_none());
        assert_eq!(f.calls(agent), 3);
        assert!(resolve_qoder_hook_user_identity(&env, agent, &payload).is_none());
        assert_eq!(f.calls(agent), 3);
        let cache = if agent == "qoder" {
            "qoder-cli-user-identity.json"
        } else {
            "qoder-cn-cli-user-identity.json"
        };
        let path = f.root.join("state/hooks").join(cache);
        let mut cached: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let until = cached["failedUntil"].as_i64().unwrap();
        assert!(until >= now_ms() + 59_000 && until <= now_ms() + 60_000);
        cached["failedUntil"] = json!(now_ms() - 1);
        fs::write(&path, cached.to_string()).unwrap();
        assert!(resolve_qoder_hook_user_identity(&env, agent, &payload).is_none());
        assert_eq!(f.calls(agent), 4);
    }
}
#[cfg(unix)]
#[tokio::test]
async fn main522_partial_accounts_phone_email_and_logged_out_snapshots_fail_open_without_user_id_leaks(
) {
    for agent in ["qoder", "qoder-cn"] {
        let f = Fixture::new();
        f.cli(agent, None);
        f.rows(1, false, true);
        fs::write(f.reply(agent),json!({"logged_in":true,"username":"phone-account","email":"13800138000","uid":"private-account-id"}).to_string()).unwrap();
        let got = f.publish(
            agent,
            f.payload(json!({"product":"cli","version":"1.0.0"}), json!({})),
        );
        assert_eq!(got["userIdentity"], identity("phone-account", ""));
        let source = f.source(agent);
        let records = f.collect(&source, &mut json!({})).await;
        assert_records(&records, "phone-account", "");
        assert!(!serde_json::to_string(&records)
            .unwrap()
            .contains("private-account-id"));
        source.stop();
        let f = Fixture::new();
        f.status(agent, json!({"logged_in":false}));
        f.rows(1, false, true);
        let metadata = f.publish(
            agent,
            f.payload(
                json!({"product":"cli","version":"1.0.0"}),
                json!({"user":{"name":"not-for-cli","email":"hook@example.com"}}),
            ),
        );
        assert!(metadata.get("userIdentity").is_none());
        let source = f.source(agent);
        assert_records(&f.collect(&source, &mut json!({})).await, "", "");
        source.stop();
    }
}
#[test]
fn main522_email_validation_and_utf16_identity_budget_match_hook_contract() {
    let name = "中".repeat(512);
    let extra = json!({"user":{"name":name,"email":" phone-number "},"email":"git@example.com"});
    let got = extract_user_identity(extra.as_object().unwrap()).unwrap();
    assert_eq!(got.name.as_deref(), Some(name.as_str()));
    assert!(got.email.is_none());
    assert!(extract_user_identity(
        json!({"user":{"name":"中".repeat(513)}})
            .as_object()
            .unwrap()
    )
    .is_none());
    assert!(extract_user_identity(
        json!({"user":{"name":"😀".repeat(257)}})
            .as_object()
            .unwrap()
    )
    .is_none());
    let got = extract_user_identity(
        json!({"user":{"email":" only@example.com "}})
            .as_object()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        identity_json(&got),
        identity("", "only@example.com").to_string()
    );
    for bad in [
        "phone",
        "x@@example.com",
        "a b@example.com",
        "@example.com",
        "name@",
    ] {
        assert!(
            extract_user_identity(json!({"user":{"email":bad}}).as_object().unwrap()).is_none()
        );
    }
}
#[test]
fn main522_collected_root_prompt_and_every_event_keep_account_strings_and_configured_employee_id() {
    let rows = vec![
        json!({"type":"user","timestamp":"2026-10-01T10:00:01.000Z","userId":"transcript-account","message":{"content":"hello"}}),
        json!({"type":"assistant","timestamp":"2026-10-01T10:00:02.000Z","message":{"id":"response","role":"assistant","model":"synthetic-model","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}}),
        json!({"type":"last-prompt","lastPrompt":"hello"}),
    ];
    for (name, email) in [
        (Some("account"), Some("a@example.com")),
        (Some("account"), None),
        (None, Some("a@example.com")),
        (None, None),
    ] {
        let empty = Obj::new();
        let records = build_collected_transcript_turn(
            &rows,
            CollectedTranscriptTurnContext {
                agent_id: "qoder-cn",
                session_id: "identity-session",
                turn_id: "identity-turn",
                runtime_user: "employee-123",
                cwd: None,
                user_name: name,
                user_email: email,
                agent_name: None,
                span_attributes: &empty,
                resource_attributes: &empty,
            },
        );
        assert_records(&records, name.unwrap_or(""), email.unwrap_or(""));
        assert!(records.iter().all(|r| r["user.id"] == "employee-123"));
    }
}
#[cfg(unix)]
#[tokio::test]
async fn main522_stop_account_is_frozen_before_collector_retry_and_source_descriptor_fills_missing_context(
) {
    let f = Fixture::new();
    let agent = "qoder-cn";
    f.cli(agent, None);
    f.rows(1, false, false);
    f.publish(
        agent,
        f.payload(json!({"product":"cli","version":"1.0.0"}), json!({})),
    );
    fs::write(
        f.reply(agent),
        json!({"logged_in":true,"username":"later-account","email":"later@example.com"})
            .to_string(),
    )
    .unwrap();
    fs::write(f.home(agent).join(".auth/user"), "auth-changed-after-stop").unwrap();
    let source = f.source(agent);
    let mut state = json!({});
    let first = f.collect(&source, &mut state).await;
    assert_records(&first, "qoder-cn-cli-user", "qoder-cn@example.com");
    // The caller really persists the returned checkpoint before ACK.
    let checkpoint = f.root.join("test-checkpoint.json");
    fs::write(&checkpoint, state.to_string()).unwrap();
    state = serde_json::from_str(&fs::read_to_string(&checkpoint).unwrap()).unwrap();
    let ack = source.read(Some(&state), true).await.unwrap();
    state = ack.state;
    f.rows(2, true, false);
    f.publish(agent, f.payload(Value::Null, json!({})));
    let second = f.collect(&source, &mut state).await;
    assert_records(&second, "qoder-cn-cli-user", "qoder-cn@example.com");
    assert_eq!(f.calls(agent), 1);
    assert!(second
        .iter()
        .all(|r| !first.iter().any(|old| old["event.id"] == r["event.id"])));
    source.stop();
}
#[cfg(unix)]
#[test]
fn main522_status_ignoring_term_or_closing_stdout_early_still_obeys_original_three_second_deadline()
{
    for script in [
        "#!/bin/sh\nprintf '%s\\n' status >> \"$MAIN522_COUNTER\"\ntrap '' TERM\nsleep 8\n",
        "#!/bin/sh\nprintf '%s\\n' status >> \"$MAIN522_COUNTER\"\nexec 1>&-\ntrap '' TERM\nsleep 8\n",
    ] {
        let f=Fixture::new();f.cli("qoder",Some(script));
        let payload=f.payload(json!({"product":"cli","version":"1.0.0"}),json!({}));
        let start=Instant::now();assert!(resolve_qoder_hook_user_identity(&f.env("qoder"),"qoder",&payload).is_none());
        assert!(start.elapsed()>=Duration::from_millis(2900));assert!(start.elapsed()<Duration::from_secs(6));
        let start=Instant::now();assert!(resolve_qoder_hook_user_identity(&f.env("qoder"),"qoder",&payload).is_none());
        assert!(start.elapsed()<Duration::from_secs(1));assert_eq!(f.calls("qoder"),1);
    }
}
#[test]
fn main522_public_snapshot_validation_partials_and_missing_files_never_fabricate_account_fields() {
    for agent in ["qoder", "qoder-cn"] {
        let wrong_product = if agent == "qoder" { "qodercn" } else { "qoder" };
        for patch in [
            json!({"logged_in":false}),
            json!({"logged_in":"true"}),
            json!({"schema_version":2}),
            json!({"product":wrong_product}),
            json!({"writer":"other"}),
            json!({"snapshot_at":"invalid"}),
            json!({"snapshot_at":"2999-01-01T00:00:00.000Z"}),
        ] {
            let f = Fixture::new();
            f.status(agent, patch);
            let metadata = f.publish(agent, f.payload(json!({"product":"app"}), json!({})));
            assert!(metadata.get("userIdentity").is_none());
        }
        for variant in ["missing", "truncated", "oversized"] {
            let f = Fixture::new();
            f.status(agent, json!({}));
            let path = f.home(agent).join(".qoder-app-status.json");
            match variant {
                "missing" => fs::remove_file(&path).unwrap(),
                "truncated" => fs::write(&path, "{").unwrap(),
                _ => fs::write(&path, vec![b' '; 16 * 1024 + 1]).unwrap(),
            }
            assert!(f
                .publish(agent, f.payload(json!({"product":"app"}), json!({})))
                .get("userIdentity")
                .is_none());
        }
        for (patch, expected) in [
            (json!({"email":null}), identity("desktop-user", "")),
            (json!({"email":""}), identity("desktop-user", "")),
            (json!({"email":"13800138000"}), identity("desktop-user", "")),
            (
                json!({"name":"","email":"desktop@example.com"}),
                identity("", "desktop@example.com"),
            ),
        ] {
            let f = Fixture::new();
            f.status(agent, patch);
            assert_eq!(
                f.publish(agent, f.payload(json!({"product":"app"}), json!({})))["userIdentity"],
                expected
            );
        }
    }
}
#[tokio::test]
async fn main522_real_source_uses_configured_employee_or_hostname_never_the_transcript_account_id()
{
    for configured in [None, Some("employee-from-source-config")] {
        let f = Fixture::new();
        if let Some(user) = configured {
            fs::write(
                f.root.join("config.json"),
                json!({"userId":user}).to_string(),
            )
            .unwrap();
        }
        f.rows(1, false, false);
        f.publish("qoder-cn",f.payload(Value::Null,json!({"user":{"uid":"hook-account-uid","name":"account-name","email":"account@example.com"}})));
        let source = f.source("qoder-cn");
        let records = f.collect(&source, &mut json!({})).await;
        assert_records(&records, "account-name", "account@example.com");
        let expected = configured.map(str::to_owned).unwrap_or_else(hostname);
        assert!(
            records.iter().all(|r| r["user.id"] == expected),
            "transcript account ID must not become the collection user"
        );
        assert!(records
            .iter()
            .all(|r| r["user.id"] != "transcript-account" && r["user.id"] != "hook-account-uid"));
        source.stop();
    }
}
#[cfg(unix)]
#[test]
fn main522_cli_missing_logged_out_or_invalid_status_uses_desktop_without_combining_partial_accounts(
) {
    for agent in ["qoder", "qoder-cn"] {
        for mode in ["missing", "logged-out", "invalid", "partial-name"] {
            let f = Fixture::new();
            f.status(agent, json!({}));
            if mode != "missing" {
                f.cli(agent, None);
                let reply = match mode {
                    "logged-out" => {
                        json!({"logged_in":false,"username":"stale","email":"stale@example.com"})
                            .to_string()
                    }
                    "partial-name" => {
                        json!({"logged_in":true,"username":"partial-cli","email":"13800138000"})
                            .to_string()
                    }
                    _ => "invalid-json".into(),
                };
                fs::write(f.reply(agent), reply).unwrap();
            }
            let got = f.publish(
                agent,
                f.payload(
                    json!({"product":"cli","version":"1.0.0"}),
                    json!({"user":{"name":"not-for-cli"}}),
                ),
            );
            let expected = if mode == "partial-name" {
                identity("partial-cli", "")
            } else {
                identity("desktop-user", "desktop@example.com")
            };
            assert_eq!(got["userIdentity"], expected);
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn main522_next_stop_observes_account_changes_without_rewriting_prior_events() {
    for agent in ["qoder", "qoder-cn"] {
        for product in ["app", "cli"] {
            let f = Fixture::new();
            f.cli(agent, None);
            f.status(agent, json!({}));
            fs::write(
                f.root.join("config.json"),
                json!({"userId":"employee-stable"}).to_string(),
            )
            .unwrap();
            f.rows(1, false, product == "app");
            let payload = f.payload(
                json!({"product":product,"version":"1.0.0"}),
                json!({"user":{"uid":"hook-private-id","name":"ignored-account"}}),
            );
            f.publish(agent, payload.clone());
            let source = f.source(agent);
            let mut state = json!({});
            let first = f.collect(&source, &mut state).await;
            let before = first.clone();
            assert!(first.iter().all(|r| r["user.id"] == "employee-stable"));
            f.status(
                agent,
                json!({"name":"switched-desktop","email":"switched-desktop@example.com"}),
            );
            fs::write(f.reply(agent),json!({"logged_in":true,"username":"switched-cli","email":"switched-cli@example.com"}).to_string()).unwrap();
            fs::write(
                f.home(agent).join(".auth/user"),
                "switched-auth-size-distinct",
            )
            .unwrap();
            f.rows(2, true, product == "app");
            f.publish(agent, payload);
            let next = f.collect(&source, &mut state).await;
            if product == "app" {
                assert_records(&next, "switched-desktop", "switched-desktop@example.com");
            } else {
                assert_records(&next, "switched-cli", "switched-cli@example.com");
            }
            assert!(next.iter().all(|r| r["user.id"] == "employee-stable"));
            assert_eq!(first, before);
            assert!(next
                .iter()
                .all(|r| !first.iter().any(|old| old["event.id"] == r["event.id"])));
            source.stop();
        }
    }
}
