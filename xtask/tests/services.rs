//! 系统服务薄入口的隔离验收，不访问真实服务管理器或用户安装。

#[test]
fn windows_service_entry_has_no_external_runtime_or_script_daemon() {
    let source = include_str!("../../scripts/loongsuite-pilot.ps1");
    let code: String = source
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in [
        "$nodeBin",
        "$NodeBin",
        "Resolve-Node",
        "$NODE_PIN_FILE",
        "daemon.js",
        "require(\"node:",
    ] {
        assert!(!code.contains(forbidden), "仍有旧运行时入口：{forbidden}");
    }
    assert!(code.contains("$global:LASTEXITCODE = 9009\n        & $Binary @nativeArgs"));
    assert!(code.contains("$script:PilotExitCode = $global:LASTEXITCODE"));
    assert!(!code.contains("$LASTEXITCODE = 9009"));
    assert!(code.contains("service-helper\", \"process-alive"));
    assert!(code.contains("@('run')") || code.contains("@(\"run\")"));
    assert!(code.contains("@(\"run-updater\")"));
    assert!(!code.contains("updater: running (Task Scheduler)"));
    assert!(
        source.starts_with('\u{feff}'),
        "Windows PowerShell 5.1 需要 BOM 识别 UTF-8 源码"
    );
}

#[test]
fn native_identity_checks_real_processes_without_current_pointer_dependency() {
    use loongsuite_pilot::utils::installed_process::{
        is_current_installed_process, is_installed_process,
    };
    use std::fs;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("安装 张三 🚀");
    let cache = root.join("缓存");
    let data = root.join("数据");
    let foreign = root.join("其他数据");
    let version = cache.join("versions/1.2.0");
    fs::create_dir_all(version.join("bin")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&foreign).unwrap();
    fs::write(version.join("runtime-manifest.json"), "{}").unwrap();
    fs::write(cache.join("current"), "不存在的新版本").unwrap();
    let binary = version.join(if cfg!(windows) {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    });
    fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
    let alternative = cache.join("versions/alternative");
    fs::create_dir_all(alternative.join("bin")).unwrap();
    fs::write(alternative.join("runtime-manifest.json"), "{}").unwrap();
    fs::copy(
        &binary,
        alternative.join("bin").join(binary.file_name().unwrap()),
    )
    .unwrap();
    for (index, (args, own_data)) in [
        (vec![], true),
        (vec!["run"], true),
        (vec!["run-updater"], true),
        (vec!["run", "extra"], true),
        (vec!["check"], true),
        (vec!["run"], false),
    ]
    .into_iter()
    .enumerate()
    {
        let log = root.join(format!("ready-{index}.jsonl"));
        let child = Command::new(&binary)
            .args(&args)
            .env_clear()
            .env(
                "LOONGSUITE_PILOT_DATA_DIR",
                if own_data { &data } else { &foreign },
            )
            .env("PILOT_FIXTURE_MODE", "wait")
            .env("PILOT_FIXTURE_LOG", &log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = Process(child);
        let start = Instant::now();
        while !log.is_file() {
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = child.0.id();
        for role in ["collector", "updater"] {
            let expected = own_data
                && if role == "collector" {
                    args.is_empty() || args == ["run"]
                } else {
                    args == ["run-updater"]
                };
            assert_eq!(
                is_installed_process(pid, role, &cache, &data),
                expected,
                "{args:?}/{role}/{own_data}"
            );
            fs::write(cache.join("current"), "missing").unwrap();
            assert!(!is_current_installed_process(pid, role, &cache, &data));
            fs::write(cache.join("current"), "1.2.0\n").unwrap();
            assert_eq!(
                is_current_installed_process(pid, role, &cache, &data),
                expected
            );
            fs::write(cache.join("current"), "alternative\n").unwrap();
            assert!(!is_current_installed_process(pid, role, &cache, &data));
            assert_eq!(is_installed_process(pid, role, &cache, &data), expected);
        }
        assert!(!is_installed_process(pid, "collector", &root, &data));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(!is_installed_process(pid, "collector", &cache, &data));
        assert!(!is_installed_process(pid, "updater", &cache, &data));
        fs::write(cache.join("current"), "1.2.0\n").unwrap();
        assert!(!is_current_installed_process(
            pid,
            "collector",
            &cache,
            &data
        ));
    }
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Output, Stdio};
    use std::time::{Duration, Instant};

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        data: PathBuf,
        cache: PathBuf,
        script: PathBuf,
        binary: PathBuf,
        tools: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("HOME 张三 🚀");
            let data = home.join("数据目录");
            let cache = home.join("独立缓存");
            let root = cache.join("versions/1.2.0+test_abcdef");
            fs::create_dir_all(root.join("bin")).unwrap();
            fs::create_dir_all(&data).unwrap();
            fs::write(cache.join("current"), "1.2.0+test_abcdef\n").unwrap();
            fs::write(root.join("runtime-manifest.json"), "{}").unwrap();
            let binary = root.join("bin/loongsuite-pilot");
            fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
            let tools = home.join("system-tools");
            fs::create_dir(&tools).unwrap();
            for name in [
                "dirname", "id", "cat", "wc", "cp", "mv", "chmod", "mkdir", "readlink", "ps", "tr",
                "sort", "head", "bash",
            ] {
                let source = [
                    Path::new("/usr/bin").join(name),
                    Path::new("/bin").join(name),
                ]
                .into_iter()
                .find(|path| path.is_file())
                .unwrap();
                std::os::unix::fs::symlink(source, tools.join(name)).unwrap();
            }
            let script = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("scripts/loongsuite-pilot.sh");
            Self {
                _temp: temp,
                home,
                data,
                cache,
                script,
                binary,
                tools,
            }
        }

        fn command(&self) -> Command {
            let mut command = Command::new("/bin/bash");
            command
                .env_clear()
                .current_dir(&self.home)
                .stdin(Stdio::null())
                .env("PATH", &self.tools)
                .env("HOME", &self.home)
                .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
                .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
                .env(
                    "AGENT_DATA_COLLECTION_CONFIG",
                    self.home.join("显式配置.json"),
                );
            command
        }

        fn function(&self, name: &str, args: &[&str]) -> Output {
            self.command()
                .args(["-c", "source \"$1\"; shift; \"$@\"", "test"])
                .arg(&self.script)
                .arg(name)
                .args(args)
                .output()
                .unwrap()
        }

        fn spawn(&self, data: &Path, args: &[&str]) -> Process {
            let log = self.home.join(format!("process-{}.jsonl", uuid_tag()));
            let mut command = Command::new(&self.binary);
            command
                .args(args)
                .env_clear()
                .env("HOME", &self.home)
                .env("LOONGSUITE_PILOT_DATA_DIR", data)
                .env("PILOT_FIXTURE_MODE", "wait")
                .env("PILOT_FIXTURE_LOG", &log)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child =
                spawn_with_writer_retry(&mut command, Instant::now() + Duration::from_secs(1))
                    .unwrap();
            let process = Process(child);
            let start = Instant::now();
            while !log.is_file() {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            process
        }
    }

    // Linux may briefly retain a writer after copying a fixture executable.
    // Retry only ETXTBSY; permissions, missing files, and all other errors are
    // returned immediately. The fixture's process readiness budget is unchanged.
    fn spawn_with_writer_retry(command: &mut Command, deadline: Instant) -> std::io::Result<Child> {
        loop {
            match command.spawn() {
                Err(error) if error.raw_os_error() == Some(26) && Instant::now() < deadline => {
                    std::thread::sleep(
                        Duration::from_millis(10)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
                result => return result,
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn copied_fixture_executable_waits_for_a_real_transient_writer_and_keeps_other_errors() {
        let fixture = Fixture::new();
        let before = fs::read(&fixture.binary).unwrap();
        let writer = fs::OpenOptions::new()
            .write(true)
            .open(&fixture.binary)
            .unwrap();
        let mut probe = Command::new(&fixture.binary);
        probe
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let error = match probe.spawn() {
            Err(error) => error,
            Ok(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Linux must refuse an executable with an open writer");
            }
        };
        assert_eq!(error.raw_os_error(), Some(26));
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(writer);
        });
        let process = fixture.spawn(&fixture.data, &["run", "--quiet"]);
        release.join().unwrap();
        assert!(loongsuite_pilot::utils::is_process_alive(process.0.id()));
        assert_eq!(fs::read(&fixture.binary).unwrap(), before);
        let mut missing = Command::new(fixture.home.join("missing-native-fixture"));
        assert_eq!(
            spawn_with_writer_retry(&mut missing, Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    fn uuid_tag() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn pointers_reject_traversal_links_and_legacy_fallback() {
        let fixture = Fixture::new();
        let output = fixture.function("resolve_pilot_bin", &[]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            fixture.binary.to_str().unwrap()
        );
        for bad in [
            "../outside",
            "1.2.0+test_abcdef/..",
            "1.2.0 +test_abcdef",
            ".",
            "..",
            "bad.",
            "",
        ] {
            fs::write(fixture.cache.join("current"), bad).unwrap();
            assert!(
                !fixture.function("resolve_pilot_bin", &[]).status.success(),
                "{bad}"
            );
        }
        fs::remove_file(fixture.cache.join("current")).unwrap();
        let pointer = fixture.home.join("pointer");
        fs::write(&pointer, "1.2.0+test_abcdef").unwrap();
        std::os::unix::fs::symlink(pointer, fixture.cache.join("current")).unwrap();
        assert!(!fixture.function("resolve_pilot_bin", &[]).status.success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_identity_binds_executable_install_role_and_data_directory() {
        let fixture = Fixture::new();
        for args in [
            vec![],
            vec!["run"],
            vec!["run-updater"],
            vec!["run", "extra"],
        ] {
            let process = fixture.spawn(&fixture.data, &args);
            let pid = process.0.id().to_string();
            for role in ["collector", "updater"] {
                let expected = match role {
                    "updater" => args == ["run-updater"],
                    _ => args.is_empty() || args == ["run"],
                };
                let output = fixture.function("process_matches_installed_entry", &[&pid, role]);
                assert_eq!(
                    output.status.success(),
                    expected,
                    "{args:?}/{role}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        let other = Fixture::new();
        let foreign = other.spawn(&other.data, &[]);
        assert!(!fixture
            .function(
                "process_matches_installed_entry",
                &[&foreign.0.id().to_string(), "collector"]
            )
            .status
            .success());
        let shared_cache = fixture.spawn(&other.data, &[]);
        assert!(!fixture
            .function(
                "process_matches_installed_entry",
                &[&shared_cache.0.id().to_string(), "collector"]
            )
            .status
            .success());
        let current = fixture.spawn(&fixture.data, &[]);
        fs::write(fixture.cache.join("current"), "new-missing-version").unwrap();
        assert!(fixture
            .function(
                "process_matches_installed_entry",
                &[&current.0.id().to_string(), "collector"]
            )
            .status
            .success());
    }

    #[test]
    fn foreground_roles_forward_explicit_paths_without_runtime_probes() {
        let fixture = Fixture::new();
        for role in ["run", "run-updater"] {
            let log = fixture.home.join(format!("{role}.jsonl"));
            let output = fixture
                .command()
                .arg(&fixture.script)
                .arg(role)
                .env("PILOT_FIXTURE_MODE", "exit")
                .env("PILOT_FIXTURE_LOG", &log)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let event: serde_json::Value =
                serde_json::from_str(fs::read_to_string(&log).unwrap().trim()).unwrap();
            assert_eq!(event["data"], fixture.data.to_str().unwrap());
            assert_eq!(event["cache"], fixture.cache.to_str().unwrap());
            assert_eq!(
                event["config"],
                fixture.home.join("显式配置.json").to_str().unwrap()
            );
            assert_eq!(
                event["args"],
                if role == "run" {
                    serde_json::json!([])
                } else {
                    serde_json::json!([role])
                }
            );
            assert!(!fixture.cache.join("node-bin").exists());
            assert!(!fixture.cache.join("bin/collector-daemon.js").exists());

            // 从未导出的 shell 变量启动，不能依赖测试父进程恰好导出 cache。
            let output = fixture
                .command()
                .args([
                    "-c",
                    "source \"$1\"; export -n LOONGSUITE_PILOT_CACHE_DIR; \"cmd_${2//-/_}\"",
                    "test",
                ])
                .arg(&fixture.script)
                .arg(role)
                .env("PILOT_FIXTURE_MODE", "exit")
                .env("PILOT_FIXTURE_LOG", &log)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let text = fs::read_to_string(&log).unwrap();
            let last: serde_json::Value =
                serde_json::from_str(text.lines().last().unwrap()).unwrap();
            assert_eq!(last["cache"], fixture.cache.to_str().unwrap());
        }
    }

    #[test]
    fn rollback_sync_forwards_native_installer_paths_and_failures() {
        let fixture = Fixture::new();
        let root = fixture.binary.parent().unwrap().parent().unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        fs::copy(&fixture.script, root.join("scripts/loongsuite-pilot.sh")).unwrap();
        let log = fixture.home.join("sync.jsonl");
        let output = fixture
            .command()
            .args([
                "-c",
                "source \"$1\"; sync_installed_scripts_from_version \"$2\"",
                "test",
            ])
            .arg(&fixture.script)
            .arg(root)
            .env("PILOT_FIXTURE_MODE", "exit")
            .env("PILOT_FIXTURE_LOG", &log)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // 此处验证薄桥接协议；真实 helper 的文件、权限和布局断言在 installer_native 中执行。
        let calls = fs::read_to_string(&log).unwrap();
        let calls: Vec<serde_json::Value> = calls
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0]["args"],
            serde_json::json!(["installer-helper", "sync-service", "--from-env"])
        );
        assert_eq!(
            calls[0]["install"],
            serde_json::json!({
                "sourceDir":root, "cacheDir":fixture.cache, "dataDir":fixture.data,
                "configPath":fixture.home.join("显式配置.json"),
                "binDir":fixture.home.join(".local/bin")
            })
        );
        assert!(!fixture.cache.join("bin/collector-daemon.js").exists());
        let output = fixture
            .command()
            .args([
                "-c",
                "source \"$1\"; sync_installed_scripts_from_version \"$2\"",
                "test",
            ])
            .arg(&fixture.script)
            .arg(root)
            .env("PILOT_FIXTURE_MODE", "fail")
            .output()
            .unwrap();
        assert!(!output.status.success(), "同步失败必须传回调用方");
    }
}
