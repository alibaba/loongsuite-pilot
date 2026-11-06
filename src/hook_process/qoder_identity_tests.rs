//! Account projection regressions ported from upstream #509.
use super::tests::{invoke, read_history, write_transcript};
use super::*;
use serde_json::json;

struct Fixture {
    dir: tempfile::TempDir,
    agent: &'static str,
    rows: Vec<Value>,
    turns: usize,
}

impl Fixture {
    fn new(agent: &'static str) -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            agent,
            rows: Vec::new(),
            turns: 0,
        }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }
    fn transcript(&self) -> PathBuf {
        self.root().join("session.jsonl")
    }
    fn status_path(&self) -> PathBuf {
        self.root()
            .join(format!(".{}", self.agent))
            .join(".qoder-app-status.json")
    }

    fn status(&self, patch: Value) {
        let mut status = json!({
            "schema_version":1,
            "product":if self.agent == "qoder" {"qoder"} else {"qodercn"},
            "writer":"main", "logged_in":true,
            "snapshot_at":chrono::Utc::now().to_rfc3339(),
            "name":"desktop-user", "email":"desktop@example.com"
        });
        status
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        fs::create_dir_all(self.status_path().parent().unwrap()).unwrap();
        fs::write(self.status_path(), serde_json::to_vec(&status).unwrap()).unwrap();
    }

    fn seed_cli_account(&self) {
        let path = self.root().join(".qoder").join(".auth").join("user");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "synthetic-cli-account").unwrap();
        let meta = fs::metadata(&path).unwrap();
        let env = self.env();
        let cache = identity_cache_file(&env);
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(
            cache,
            serde_json::to_vec(&json!({
                "schemaVersion":1, "authPath":path.to_string_lossy(),
                "mtimeMs":mtime_ms(&meta).unwrap(), "size":meta.len(), "loggedIn":true,
                "name":"cli-other-account", "email":"cli@example.com"
            }))
            .unwrap(),
        )
        .unwrap();
        // This fixture must seed a cache accepted by the real reader on every
        // platform before testing that Desktop ignores the separate CLI account.
        let identity = resolve_qoder_cli_user_identity(&env).expect("valid seeded CLI identity");
        assert_eq!(identity.name.as_deref(), Some("cli-other-account"));
        assert_eq!(identity.email.as_deref(), Some("cli@example.com"));
    }

    fn env(&self) -> Env {
        let root = self.root().to_string_lossy().into_owned();
        [
            ("HOME".into(), root.clone()),
            ("USERPROFILE".into(), root.clone()),
            ("LOONGSUITE_PILOT_DATA_DIR".into(), root),
        ]
        .into()
    }

    fn append_turn(&mut self, cli: bool) {
        self.turns += 1;
        let minute = self.turns;
        let mut user = json!({"type":"user","uuid":format!("prompt-{minute}"),"sessionId":"account-session",
            "userId":"transcript-account", "timestamp":format!("2026-10-01T10:{minute:02}:00.000Z"),
            "message":{"role":"user","content":format!("hello {minute}")}});
        if cli {
            user["entrypoint"] = json!("cli");
            user["promptId"] = json!(format!("prompt-{minute}"));
        }
        self.rows.extend([
            user,
            json!({"type":"assistant","uuid":format!("response-{minute}"),"sessionId":"account-session",
                "timestamp":format!("2026-10-01T10:{minute:02}:01.000Z"),
                "message":{"id":format!("response-{minute}"),"role":"assistant","model":"account-test-model",
                    "content":[{"type":"text","text":"hello back"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":10,"output_tokens":3}}}),
            json!({"type":"last-prompt","sessionId":"account-session","lastPrompt":format!("hello {minute}")}),
        ]);
        write_transcript(&self.transcript(), &self.rows);
    }

    fn stop(&mut self, cli: bool, extra: Value, parent: Value) -> Vec<Value> {
        self.append_turn(cli);
        let (code, stdout) = invoke(self.root(), &["--agent-id", self.agent, "--log-prefix", self.agent],
            &json!({"session_id":"account-session","transcript_path":self.transcript(),"cwd":self.root(),
                "extra":extra,"parent_business_info":parent}).to_string(),
            &[("LOONGSUITE_PILOT_USER_ID",""),("HOOK_RETRY_DELAY","0")]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "{}\n");
        read_history(self.root(), self.agent)
    }

    fn assert_identity(
        &self,
        records: &[Value],
        name: Option<&str>,
        email: Option<&str>,
        user_id: &str,
    ) {
        assert!(
            !records.is_empty(),
            "account failures must not prevent collection"
        );
        for record in records {
            assert_eq!(
                record.get("user.name").and_then(Value::as_str),
                name,
                "{record}"
            );
            assert_eq!(
                record.get("user.email").and_then(Value::as_str),
                email,
                "{record}"
            );
            assert_eq!(record["user.id"], user_id, "{record}");
            assert!(record.get("user.uid").is_none());
            let agent_type = if self.agent == "qoder"
                && self.rows.iter().any(|row| row["entrypoint"] == "cli")
            {
                "qoder-cli"
            } else {
                self.agent
            };
            assert_eq!(record["gen_ai.agent.type"], agent_type);
        }
    }
}

#[test]
fn cn_hook_account_fields_prefer_valid_nested_email_without_borrowing_desktop_identity() {
    let cases = [
        (
            json!({"user":{"name":" cn-user ","uid":"account-id"},"email":" cn@example.com "}),
            Some("cn-user"),
            Some("cn@example.com"),
        ),
        (
            json!({"user":{"name":"cn-user","email":"nested@example.com"},"email":"outer@example.com"}),
            Some("cn-user"),
            Some("nested@example.com"),
        ),
        (
            json!({"email":"outer@example.com"}),
            None,
            Some("outer@example.com"),
        ),
    ];
    for (extra, name, email) in cases {
        let mut fixture = Fixture::new("qoder-cn");
        fixture.status(json!({"name":"different-account","email":"different@example.com"}));
        let records = fixture.stop(false, extra, Value::Null);
        fixture.assert_identity(&records, name, email, &hostname());
    }
    for email in [
        Value::Null,
        json!(""),
        json!("  "),
        json!(12345),
        json!("13800138000"),
        json!("cloud-account-id"),
    ] {
        let mut fixture = Fixture::new("qoder-cn");
        fixture.status(json!({"name":"different-account"}));
        let records = fixture.stop(
            false,
            json!({"user":{"name":"phone-user"},"email":email}),
            Value::Null,
        );
        fixture.assert_identity(&records, Some("phone-user"), None, &hostname());
    }
}

#[test]
fn desktop_account_precedence_preserves_partial_hook_snapshots_and_employee_ids() {
    for agent in ["qoder", "qoder-cn"] {
        for (extra, name, email) in [
            (
                Value::Null,
                Some("desktop-user"),
                Some("desktop@example.com"),
            ),
            (
                json!({"user":{"uid":"native-account","name":"hook-user"}}),
                Some("hook-user"),
                None,
            ),
            (
                json!({"user":{"name":"hook-user","email":"hook@example.com"}}),
                Some("hook-user"),
                Some("hook@example.com"),
            ),
        ] {
            let mut fixture = Fixture::new(agent);
            fixture.status(json!({}));
            fixture.seed_cli_account();
            fs::write(
                fixture.root().join("config.json"),
                r#"{"userId":"employee-123"}"#,
            )
            .unwrap();
            let records = fixture.stop(true, extra, json!({"product":"app"}));
            fixture.assert_identity(&records, name, email, "employee-123");
        }
        for email in [Value::Null, json!(""), json!("13800138000")] {
            let mut fixture = Fixture::new(agent);
            fixture.status(json!({"email":email}));
            let records = fixture.stop(true, Value::Null, json!({"product":"app"}));
            fixture.assert_identity(&records, Some("desktop-user"), None, &hostname());
        }
        let mut fixture = Fixture::new(agent);
        fixture.status(json!({"name":"","snapshot_at":"2025-01-01T00:00:00.000Z"}));
        let records = fixture.stop(true, Value::Null, json!({"product":"app"}));
        fixture.assert_identity(&records, None, Some("desktop@example.com"), &hostname());
    }
}

#[test]
fn only_exact_app_invocations_read_desktop_profiles_and_cli_identity_remains_separate() {
    for agent in ["qoder", "qoder-cn"] {
        for parent in [
            Value::Null,
            json!({"product":"cli"}),
            json!({"product":"APP"}),
            json!("app"),
            json!([]),
        ] {
            let mut fixture = Fixture::new(agent);
            fixture.status(json!({}));
            fixture.seed_cli_account();
            let records = fixture.stop(true, Value::Null, parent);
            let (name, email) = if agent == "qoder" {
                (Some("cli-other-account"), Some("cli@example.com"))
            } else {
                (None, None)
            };
            fixture.assert_identity(&records, name, email, &hostname());
        }
        let mut fixture = Fixture::new(agent);
        fixture.status(json!({}));
        fixture.seed_cli_account();
        let records = fixture.stop(false, json!({}), Value::Null);
        fixture.assert_identity(&records, None, None, &hostname());
    }
}

#[test]
fn invalid_missing_or_oversized_desktop_profiles_fail_open_without_using_cli_accounts() {
    for agent in ["qoder", "qoder-cn"] {
        for patch in [
            json!({"logged_in":false}),
            json!({"logged_in":"true"}),
            json!({"schema_version":2}),
            json!({"product":"other"}),
            json!({"writer":"other"}),
            json!({"snapshot_at":"invalid"}),
            json!({"snapshot_at":"2999-01-01T00:00:00.000Z"}),
        ] {
            let mut fixture = Fixture::new(agent);
            fixture.status(patch);
            fixture.seed_cli_account();
            let records = fixture.stop(true, Value::Null, json!({"product":"app"}));
            fixture.assert_identity(&records, None, None, &hostname());
        }
        for variant in ["missing", "truncated", "oversized", "directory"] {
            let mut fixture = Fixture::new(agent);
            fixture.status(json!({}));
            match variant {
                "missing" => fs::remove_file(fixture.status_path()).unwrap(),
                "truncated" => fs::write(fixture.status_path(), "{").unwrap(),
                "oversized" => fs::write(fixture.status_path(), vec![b' '; 16 * 1024 + 1]).unwrap(),
                "directory" => {
                    fs::remove_file(fixture.status_path()).unwrap();
                    fs::create_dir(fixture.status_path()).unwrap();
                }
                _ => unreachable!(),
            }
            fixture.seed_cli_account();
            let records = fixture.stop(true, Value::Null, json!({"product":"app"}));
            fixture.assert_identity(&records, None, None, &hostname());
        }
    }
}

#[test]
fn each_stop_observes_account_changes_without_rewriting_previous_turn_metadata() {
    for agent in ["qoder", "qoder-cn"] {
        let mut fixture = Fixture::new(agent);
        fixture.status(json!({}));
        let before = fixture.stop(true, Value::Null, json!({"product":"app"}));
        fixture.assert_identity(
            &before,
            Some("desktop-user"),
            Some("desktop@example.com"),
            &hostname(),
        );
        fixture.status(json!({"name":"next-user","email":"next@example.com"}));
        let after = fixture.stop(true, Value::Null, json!({"product":"app"}));
        assert_eq!(&after[..before.len()], before);
        assert!(after.len() > before.len());
        fixture.assert_identity(
            &after[before.len()..],
            Some("next-user"),
            Some("next@example.com"),
            &hostname(),
        );
    }
}

#[test]
fn retry_consumes_the_frozen_stop_identity_instead_of_the_current_profile() {
    for (agent, from_hook) in [("qoder", false), ("qoder-cn", false), ("qoder-cn", true)] {
        let mut fixture = Fixture::new(agent);
        fixture.status(json!({"name":"stop-user","email":"stop@example.com"}));
        let identity = if from_hook {
            extract_qoder_cn_user_identity(
                json!({"user":{"name":"stop-user","email":"stop@example.com"}})
                    .as_object()
                    .unwrap(),
            )
        } else {
            read_qoder_app_user_identity(&fixture.env(), agent)
        }
        .unwrap();
        let frozen = identity_json(&identity);
        fixture.status(json!({"name":"later-user","email":"later@example.com"}));
        fixture.append_turn(true);
        let transcript = fixture.transcript();
        let (code, stdout) = invoke(
            fixture.root(),
            &[
                "--agent-id",
                agent,
                "--retry",
                "--transcript",
                transcript.to_str().unwrap(),
                "--session",
                "account-session",
                "--trigger-end-line",
                "3",
            ],
            &frozen,
            &[
                ("LOONGSUITE_PILOT_USER_ID", ""),
                ("HOOK_RETRY_DELAY", "0"),
                ("HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS", "10"),
            ],
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "");
        fixture.assert_identity(
            &read_history(fixture.root(), agent),
            Some("stop-user"),
            Some("stop@example.com"),
            &hostname(),
        );
    }
}
