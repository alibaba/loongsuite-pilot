//! Actual Unix shell launchers, Native asset upgrade and the real CN collector.
//! Optional dash follows the historical platform precondition. No Node executable.
#[cfg(unix)]
mod unix {
    use async_trait::async_trait;
    use loongsuite_pilot::checkpoints::StateStore;
    use loongsuite_pilot::inputs::qoder_cn_trace::{
        QoderCnTraceInput, QoderCnTraceOptions, QoderCnTraceReaders,
    };
    use loongsuite_pilot::inputs::qoder_trace::prompt_ownership::NativeQoderPromptOwnershipResolver;
    use loongsuite_pilot::inputs::qoder_trace::{
        InterceptData, SegmentTokenData, SqliteTokenResult,
    };
    use loongsuite_pilot::utils::candidate_process::CandidateChild;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::{Command, Output, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const WRAPPER: &str = include_str!("../assets/hooks/qodercn-loongsuite-pilot-hook.sh");
    const SHARED: &str = include_str!("../assets/hooks/shared/native.sh");
    const INPUT: &[u8] = "{\"prompt\":\"中文 payload with spaces\"}\n\n".as_bytes();
    #[derive(Clone, Copy, Debug)]
    enum Launcher {
        Direct,
        Bash,
        BashPosix,
        Sh,
        Dash,
        InheritedPosix,
    }
    fn launchers() -> Vec<Launcher> {
        let mut all = vec![
            Launcher::Direct,
            Launcher::Bash,
            Launcher::BashPosix,
            Launcher::Sh,
        ];
        if Path::new("/bin/dash").is_file() {
            all.push(Launcher::Dash);
        }
        all.push(Launcher::InheritedPosix);
        all
    }
    impl Launcher {
        fn command(self, script: &Path) -> Command {
            let mut command = Command::new(match self {
                Self::Direct => script.as_os_str(),
                Self::Bash | Self::BashPosix => std::ffi::OsStr::new("/bin/bash"),
                Self::Sh | Self::InheritedPosix => std::ffi::OsStr::new("/bin/sh"),
                Self::Dash => std::ffi::OsStr::new("/bin/dash"),
            });
            if matches!(self, Self::BashPosix) {
                command.arg("--posix");
            }
            if !matches!(self, Self::Direct) {
                command.arg(script);
            }
            command
        }
    }
    fn isolated(command: &mut Command, root: &Path) {
        command
            .env_clear()
            .current_dir(root)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("LOONGSUITE_PILOT_DATA_DIR", root.join("data"))
            .env("LOONGSUITE_PILOT_CACHE_DIR", root.join("cache"))
            .env("PATH", root.join("shell-only"))
            .env("PILOT_SHELL_CAPTURE", root);
    }
    fn execute(mut command: Command, input: &[u8], deadline: Instant) -> Output {
        let mut stdout = tempfile::tempfile().unwrap();
        let mut stderr = tempfile::tempfile().unwrap();
        command
            .stdin(Stdio::piped())
            .stdout(stdout.try_clone().unwrap())
            .stderr(stderr.try_clone().unwrap());
        let mut child = CandidateChild::spawn(&mut command).unwrap();
        child.take_stdin().unwrap().write_all(input).unwrap();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "actual shell/installer exceeded original 10000ms budget"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        let read = |file: &mut fs::File| {
            file.seek(SeekFrom::Start(0)).unwrap();
            let mut bytes = Vec::new();
            file.take(64 * 1024 + 1).read_to_end(&mut bytes).unwrap();
            bytes
        };
        let stdout = read(&mut stdout);
        let stderr = read(&mut stderr);
        assert!(stdout.len() <= 64 * 1024 && stderr.len() <= 64 * 1024);
        Output {
            status,
            stdout,
            stderr,
        }
    }
    fn quiet(output: &Output) {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn root() -> tempfile::TempDir {
        let root = tempfile::Builder::new()
            .prefix("pilot hook's shell-中文 ")
            .tempdir()
            .unwrap();
        fs::create_dir_all(root.path().join("data/hooks/shared")).unwrap();
        fs::create_dir(root.path().join("shell-only")).unwrap();
        std::os::unix::fs::symlink("/bin/bash", root.path().join("shell-only/bash")).unwrap();
        root
    }
    fn shell(launcher: Launcher, root: &Path) -> Command {
        let mut command =
            launcher.command(&root.join("data/hooks/qodercn-loongsuite-pilot-hook.sh"));
        isolated(&mut command, root);
        if matches!(launcher, Launcher::InheritedPosix) {
            command.env("POSIXLY_CORRECT", "1");
        }
        command
    }
    #[test]
    fn all_supported_shell_launchers_preserve_exact_unicode_stdin_and_quoted_agent_argv() {
        for launcher in launchers() {
            let root = root();
            let root = root.path();
            let hooks = root.join("data/hooks");
            fs::write(hooks.join("qodercn-loongsuite-pilot-hook.sh"), WRAPPER).unwrap();
            fs::set_permissions(
                hooks.join("qodercn-loongsuite-pilot-hook.sh"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            fs::write(hooks.join("shared/native.sh"), SHARED).unwrap();
            // A private exec observer replaces the original Node CAPTURE mock.
            // Bash builtins preserve EOF and both trailing newlines verbatim.
            let probe = root.join("argv observer 中文");
            fs::write(&probe,"#!/bin/bash\nprintf '%s\\0' \"$@\" > \"$PILOT_SHELL_CAPTURE/argv.bin\"\nIFS= read -r -d '' bytes || true\nprintf '%s' \"$bytes\" > \"$PILOT_SHELL_CAPTURE/stdin.bin\"\nprintf '{}\\n'\n").unwrap();
            fs::set_permissions(&probe, fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(hooks.join("pilot-bin"), format!("{}\n", probe.display())).unwrap();
            let custom = "agent '中文 with spaces";
            let mut command = shell(launcher, root);
            command.arg(custom);
            let output = execute(command, INPUT, Instant::now() + Duration::from_secs(10));
            quiet(&output);
            assert_eq!(output.stdout, b"{}\n", "{launcher:?}");
            let args = fs::read(root.join("argv.bin")).unwrap();
            let actual = args
                .strip_suffix(&[0])
                .expect("observer must terminate every argument")
                .split(|byte| *byte == 0)
                .map(|arg| std::str::from_utf8(arg).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                actual,
                [
                    "hook-process",
                    "qoder-cn",
                    "--wakeup-only",
                    "--agent-id",
                    custom,
                    "--log-prefix",
                    custom
                ],
                "{launcher:?}"
            );
            assert_eq!(
                fs::read(root.join("stdin.bin")).unwrap(),
                INPUT,
                "{launcher:?}"
            );
        }
    }
    fn native_command(root: &Path, operation: &str, options: &Value) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        isolated(&mut command, root);
        command
            .args(["installer-helper", operation, "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string());
        command
    }
    fn upgrade_real_assets(root: &Path) {
        use loongsuite_pilot::utils::runtime_paths::{build_edition, build_target, sha256_file};
        let package = root.join("candidate");
        for directory in ["bin", "agents.d", "assets/hooks/shared", "scripts"] {
            fs::create_dir_all(package.join(directory)).unwrap();
        }
        fs::copy(
            env!("CARGO_BIN_EXE_loongsuite-pilot"),
            package.join("bin/loongsuite-pilot"),
        )
        .unwrap();
        for (relative, content) in [
            (
                "agents.d/qoder-cn.json",
                include_str!("../agents.d/qoder-cn.json"),
            ),
            ("assets/hooks/qodercn-loongsuite-pilot-hook.sh", WRAPPER),
            ("assets/hooks/shared/native.sh", SHARED),
            ("scripts/loongsuite-pilot.sh", "#!/bin/bash\nexit 0\n"),
            (
                "VERSION",
                concat!(
                    "version=",
                    env!("CARGO_PKG_VERSION"),
                    "\ngit_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                ),
            ),
            ("LICENSE", "synthetic fixture license"),
        ] {
            fs::write(package.join(relative), content).unwrap();
        }
        let resources = walkdir::WalkDir::new(&package)
            .into_iter()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| {
                json!({"path":entry.path().strip_prefix(&package).unwrap().to_str().unwrap(),
                "sha256":sha256_file(entry.path()).unwrap()})
            })
            .collect::<Vec<_>>();
        fs::write(package.join("runtime-manifest.json"),json!({
            "schema":1,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),"gitCommit":"a".repeat(40),
            "target":build_target(),"edition":build_edition(),"binary":"bin/loongsuite-pilot","resources":resources
        }).to_string()).unwrap();
        let data = root.join("data");
        fs::write(data.join("config.json"), "{}").unwrap();
        fs::create_dir_all(root.join(".qoder-cn")).unwrap();
        fs::write(root.join(".qoder-cn/settings.json"), "{}").unwrap();
        fs::write(
            data.join("hooks/qodercn-loongsuite-pilot-hook.sh"),
            "#!/usr/bin/env bash\nset -euo pipefail\n",
        )
        .unwrap();
        let mut options = json!({"sourceDir":package,"cacheDir":root.join("cache"),"dataDir":data,
            "configPath":data.join("config.json"),"binDir":root.join(".local/bin"),
            "configOptions":{"selectedAgents":"qoder-cn","agentSelectionExplicit":true,
                "probeResult":[{"id":"qoder-cn","detected":true}]}});
        let deadline = Instant::now() + Duration::from_secs(10);
        let stage = execute(
            native_command(root, "stage-package", &options),
            b"",
            deadline,
        );
        quiet(&stage);
        let name = std::str::from_utf8(&stage.stdout).unwrap().trim();
        assert!(!name.is_empty() && !name.contains('/'));
        let installed = root.join("cache/versions").join(name);
        options["sourceDir"] = json!(installed);
        options["deployHooks"] = json!(true);
        let publish = execute(
            native_command(root, "publish-package", &options),
            b"",
            deadline,
        );
        quiet(&publish);
        assert_eq!(
            fs::read(data.join("hooks/qodercn-loongsuite-pilot-hook.sh")).unwrap(),
            WRAPPER.as_bytes()
        );
        assert_eq!(
            fs::read(data.join("hooks/shared/native.sh")).unwrap(),
            SHARED.as_bytes()
        );
        assert!(
            !data.join("node-bin").exists(),
            "Native upgrade cannot require a Node runtime"
        );
    }
    struct NoTokens;
    #[async_trait]
    impl QoderCnTraceReaders for NoTokens {
        async fn read_cli_intercept(&self) -> InterceptData {
            InterceptData::default()
        }
        async fn read_cli_segments(&self, _: &str, _: &[String]) -> Vec<SegmentTokenData> {
            vec![]
        }
        async fn read_ide_tokens(&self, _: &str) -> SqliteTokenResult {
            SqliteTokenResult {
                rows: vec![],
                matched_db_path: None,
            }
        }
    }
    fn input(data: &Path, store: Arc<StateStore>, db: &Path) -> QoderCnTraceInput {
        QoderCnTraceInput::new_with_sources(
            QoderCnTraceOptions {
                state_store: store,
                log_dir: Some(
                    data.join("logs/qoder-cn/history")
                        .to_string_lossy()
                        .into_owned(),
                ),
                poll_interval_ms: Some(10),
            },
            data.to_path_buf(),
            Arc::new(NoTokens),
            Arc::new(NativeQoderPromptOwnershipResolver::with_paths(vec![db
                .to_string_lossy()
                .into_owned()])),
        )
    }
    #[tokio::test]
    async fn all_supported_shell_launchers_upgrade_stale_assets_and_collect_once_across_disk_checkpoint_restart(
    ) {
        for launcher in launchers() {
            let root = root();
            let root = root.path();
            upgrade_real_assets(root);
            let data = fs::canonicalize(root.join("data")).unwrap();
            let transcript = data.join("transcript.jsonl");
            let rows = [
                json!({"type":"user","uuid":"u1","timestamp":"2026-10-20T10:00:00.000Z",
                    "sessionId":"qodercn-shell-test","message":{"role":"user","content":"shell compatibility prompt"}}),
                json!({"type":"assistant","uuid":"a1","timestamp":"2026-10-20T10:00:01.000Z","sessionId":"qodercn-shell-test",
                    "message":{"role":"assistant","id":"m1","content":[{"type":"text","text":"shell compatibility answer"}],"stop_reason":"end_turn"}}),
                json!({"type":"last-prompt","sessionId":"qodercn-shell-test","lastPrompt":"shell compatibility prompt"}),
            ];
            fs::write(
                &transcript,
                rows.iter()
                    .map(|row| row.to_string() + "\n")
                    .collect::<String>(),
            )
            .unwrap();
            let payload =
                json!({"session_id":"qodercn-shell-test","transcript_path":transcript,"cwd":data});
            let first = execute(
                shell(launcher, root),
                payload.to_string().as_bytes(),
                Instant::now() + Duration::from_secs(10),
            );
            quiet(&first);
            assert_eq!(first.stdout, b"{}\n", "{launcher:?}");
            let db = data.join("ownership.db");
            let connection = rusqlite::Connection::open(&db).unwrap();
            connection.execute_batch("CREATE TABLE chat_message(session_id TEXT,request_id TEXT,role TEXT,gmt_create INTEGER)").unwrap();
            let at = chrono::DateTime::parse_from_rfc3339("2026-10-20T10:00:00.000Z")
                .unwrap()
                .timestamp_millis();
            connection
                .execute(
                    "INSERT INTO chat_message VALUES ('qodercn-shell-test','request','user',?1)",
                    [at],
                )
                .unwrap();
            drop(connection);
            let store = Arc::new(StateStore::new(data.join("checkpoint.json")));
            let input = input(&data, Arc::clone(&store), &db);
            let records = Arc::new(Mutex::new(Vec::new()));
            let output = Arc::clone(&records);
            input.bind_collector(
                move |batch| output.lock().unwrap().extend_from_slice(batch),
                |_| {},
            );
            input.start().await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if records.lock().unwrap().iter().any(
                        |row: &loongsuite_pilot::types::AgentActivityEntry| {
                            row.event_name
                                .is_some_and(|event| event.as_str() == "llm.response")
                        },
                    ) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("actual CN collector did not emit the original transcript");
            input.stop().await.unwrap();
            let records = records
                .lock()
                .unwrap()
                .iter()
                .map(|row| serde_json::to_value(row).unwrap())
                .collect::<Vec<_>>();
            assert!(!records.is_empty(), "{launcher:?}");
            assert!(
                records
                    .iter()
                    .all(|row| row["gen_ai.session.id"] == "qodercn-shell-test"
                        && row["gen_ai.agent.type"] == "qoder-cn"),
                "{launcher:?}"
            );
            let serialized = serde_json::to_string(&records).unwrap();
            assert!(serialized.contains("shell compatibility prompt"));
            assert!(serialized.contains("shell compatibility answer"));
            assert!(data.join("checkpoint.json").is_file());
            assert!(store.is_persisted("qoder-cn-trace", Some("qoderTranscripts")));
            let saved_source =
                store.get("qoder-cn-trace").extra().unwrap()["qoderTranscripts"].clone();
            assert!(saved_source.is_object());

            let second = execute(
                shell(launcher, root),
                payload.to_string().as_bytes(),
                Instant::now() + Duration::from_secs(10),
            );
            quiet(&second);
            let restarted_store = Arc::new(StateStore::new(data.join("checkpoint.json")));
            restarted_store.load().await;
            assert!(restarted_store.is_persisted("qoder-cn-trace", Some("qoderTranscripts")));
            assert_eq!(
                restarted_store.get("qoder-cn-trace").extra().unwrap()["qoderTranscripts"],
                saved_source
            );

            let restarted = self::input(&data, restarted_store, &db);
            let replay = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&replay);
            let cycles = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let completed = Arc::clone(&cycles);
            restarted.bind_collector(
                move |batch| captured.lock().unwrap().extend_from_slice(batch),
                move |_| {
                    completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                },
            );
            restarted.start().await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while cycles.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("restarted Native collector must finish a real collection/save cycle");
            restarted.stop().await.unwrap();
            assert!(
                replay.lock().unwrap().is_empty(),
                "{launcher:?} must not replay after reading the real durable checkpoint"
            );
        }
    }
}
