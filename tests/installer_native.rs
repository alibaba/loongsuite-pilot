//! 正式 Rust 安装辅助入口及两端参数桥接；只操作隔离目录，不调用安装器主流程。

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Fixture {
    root: tempfile::TempDir,
    data: PathBuf,
    candidate: PathBuf,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("数据 O'Brien [隔离] 🚀");
        let candidate = root.path().join("候选 目录🚀");
        fs::create_dir_all(candidate.join("bin")).unwrap();
        let binary = candidate.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        fs::copy(env!("CARGO_BIN_EXE_loongsuite-pilot"), &binary).unwrap();
        // 证明 helper 不经过全局 load_config 或 collector 初始化。
        fs::write(
            root.path().join("unrelated.json"),
            "broken unrelated config",
        )
        .unwrap();
        Self {
            root,
            data,
            candidate,
            binary,
        }
    }
    fn command(&self, binary: &Path) -> Command {
        let mut cmd = Command::new(binary);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // PowerShell must not start a console/terminal broker in unattended
            // tests. This matches the existing bounded Windows process probes.
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        cmd.env_clear()
            .current_dir(self.root.path())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("APPDATA", self.root.path().join("appdata"))
            .env("LOCALAPPDATA", self.root.path().join("localappdata"))
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", self.root.path().join("cache"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.path().join("unrelated.json"),
            )
            .env("PATH", self.root.path().join("no-runtimes"))
            .stdin(Stdio::null());
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
                cmd.env(key, value);
            }
        }
        cmd
    }
    fn options(&self) -> Value {
        json!({"configPath": self.data.join("config.json"), "dataDir":self.data, "userId":"研发 O'Brien 🚀", "cmsLicenseKey":"synthetic-test-secret"})
    }
    fn runtime_options(&self, source: &Path) -> Value {
        json!({"sourceDir": source, "cacheDir": self.root.path().join("cache"),
            "dataDir": self.data, "configPath": self.data.join("config.json"),
            "binDir": self.root.path().join(".local/bin")})
    }
    fn package(&self) {
        self.package_with(&[]);
    }
    fn package_with(&self, extra: &[(&str, &str)]) {
        use loongsuite_pilot::utils::runtime_paths::{build_edition, build_target, sha256_file};
        for directory in ["agents.d", "assets", "scripts"] {
            fs::create_dir_all(self.candidate.join(directory)).unwrap();
        }
        for (path, bytes) in [
            ("agents.d/cursor-cli.json", include_str!("../agents.d/cursor-cli.json")),
            ("assets/fixture", "fixture asset"),
            ("VERSION", concat!("version=", env!("CARGO_PKG_VERSION"), "\ngit_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")),
            ("LICENSE", "fixture license"),
            ("scripts/loongsuite-pilot.sh", "#!/bin/bash\nprintf '%s\\n' \"$LOONGSUITE_PILOT_DATA_DIR\" \"$LOONGSUITE_PILOT_CACHE_DIR\" \"$AGENT_DATA_COLLECTION_CONFIG\"\n"),
            ("scripts/loongsuite-pilot.ps1", "# 只供配置同步断言的测试服务入口\n"),
        ] { fs::write(self.candidate.join(path), bytes).unwrap(); }
        for (relative, content) in extra {
            let path = self.candidate.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let resources: Vec<_> = walkdir::WalkDir::new(&self.candidate).into_iter()
            .map(Result::unwrap).filter(|entry| entry.file_type().is_file())
            .map(|entry| json!({"path": entry.path().strip_prefix(&self.candidate).unwrap().to_str().unwrap().replace('\\', "/"),
                "sha256":sha256_file(entry.path()).unwrap()})).collect();
        fs::write(self.candidate.join("runtime-manifest.json"), json!({
            "schema":1,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),
            "gitCommit":"a".repeat(40),"target":build_target(),"edition":build_edition(),
            "binary":if cfg!(windows) {"bin/loongsuite-pilot.exe"} else {"bin/loongsuite-pilot"},"resources":resources
        }).to_string()).unwrap();
        fs::create_dir_all(&self.data).unwrap();
        fs::write(self.data.join("config.json"), "{}").unwrap();
    }
    fn helper(&self, operation: &str, value: &Value, use_env: bool) -> Output {
        let mut cmd = self.command(&self.binary);
        cmd.args(["installer-helper", operation]);
        if use_env {
            cmd.arg("--input-env")
                .env("LOONGSUITE_PILOT_INSTALL_INPUT", value.to_string());
        } else {
            let stdin = self.root.path().join("input.json");
            fs::write(&stdin, format!("\u{feff}{value}")).unwrap();
            cmd.stdin(fs::File::open(stdin).unwrap());
        }
        bounded(cmd)
    }
    fn config(&self) -> Value {
        let bytes = fs::read(self.data.join("config.json")).unwrap();
        serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).unwrap()
    }
    fn assert_only_config_and_released_empty_lock(&self) {
        let mut names: Vec<_> = fs::read_dir(&self.data)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["config.json", "config.json.lock"]);
        let path = self.data.join("config.json.lock");
        assert!(fs::read(&path).unwrap().is_empty());
        // The persistent inode is intentional. Removing it on release would
        // allow separate writers to hold locks on different filesystem objects.
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lock)
            .expect("installer helper left the config lock held");
    }
}

fn bounded(command: Command) -> Output {
    bounded_for(command, Duration::from_secs(30))
}

fn bounded_for(mut command: Command, timeout: Duration) -> Output {
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    command
        .stdout(stdout.try_clone().unwrap())
        .stderr(stderr.try_clone().unwrap());
    let start = Instant::now();
    let mut child =
        spawn_with_writer_retry(&mut command, start + timeout.min(Duration::from_secs(1))).unwrap();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > timeout {
            #[cfg(windows)]
            let environment_stage = child_bridge_phase(child.id());
            child.kill().unwrap();
            child.wait().unwrap();
            stdout.seek(SeekFrom::Start(0)).unwrap();
            let mut diagnostic = String::new();
            (&mut stdout)
                .take(1024 * 1024)
                .read_to_string(&mut diagnostic)
                .unwrap();
            let stage = diagnostic
                .lines()
                .filter_map(|line| line.trim().strip_prefix("PILOT_BRIDGE_STAGE:"))
                .rfind(|name| {
                    name.len() <= 64 && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                })
                .unwrap_or("shell-startup");
            #[cfg(windows)]
            let stage = environment_stage.as_deref().unwrap_or(stage);
            panic!(
                "安装辅助入口超时 (stage={stage}, shell={})",
                command.get_program().to_string_lossy()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let read = |file: &mut fs::File| {
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut result = Vec::new();
        file.take(1024 * 1024).read_to_end(&mut result).unwrap();
        result
    };
    Output {
        status,
        stdout: read(&mut stdout),
        stderr: read(&mut stderr),
    }
}
// Linux can briefly retain a copied executable's writer in another spawning
// process. Retry ETXTBSY only, within the same bounded command deadline.
fn spawn_with_writer_retry(
    command: &mut Command,
    deadline: Instant,
) -> std::io::Result<std::process::Child> {
    loop {
        match command.spawn() {
            Err(error)
                if cfg!(target_os = "linux")
                    && error.raw_os_error() == Some(26)
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10))
            }
            result => return result,
        }
    }
}

#[cfg(windows)]
fn child_bridge_phase(pid: u32) -> Option<String> {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing().with_environ(sysinfo::UpdateKind::Always),
    );
    system.process(pid)?.environ().iter().find_map(|entry| {
        let text = entry.to_str()?;
        let phase = text.strip_prefix("PILOT_TEST_STAGE=")?;
        (phase.len() <= 64
            && phase
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
        .then(|| phase.to_owned())
    })
}

#[cfg(target_os = "linux")]
#[test]
fn copied_executable_waits_for_a_transient_writer_without_changing_its_bytes() {
    use std::fs::OpenOptions;
    let fixture = Fixture::new();
    let before = loongsuite_pilot::utils::runtime_paths::sha256_file(&fixture.binary).unwrap();
    let writer = OpenOptions::new()
        .write(true)
        .open(&fixture.binary)
        .unwrap();
    let error = fixture
        .command(&fixture.binary)
        .arg("--version")
        .spawn()
        .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(26));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        drop(writer);
    });
    let mut command = fixture.command(&fixture.binary);
    command.arg("--version");
    success(&bounded(command));
    release.join().unwrap();
    assert_eq!(
        loongsuite_pilot::utils::runtime_paths::sha256_file(&fixture.binary).unwrap(),
        before
    );
}

#[cfg(unix)]
#[test]
fn timeout_reports_only_a_controlled_bridge_stage() {
    let failure = std::panic::catch_unwind(|| {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf 'synthetic-private-input\\nPILOT_BRIDGE_STAGE:probe-agents\\n'; exec sleep 60",
        ]);
        bounded_for(command, Duration::from_secs(1))
    })
    .unwrap_err();
    let message = failure.downcast_ref::<String>().unwrap();
    assert!(message.contains("stage=probe-agents"));
    assert!(!message.contains("synthetic-private-input"));
}

fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn function(source: &str, start: &str) -> String {
    let rest = source.split_once(start).expect("函数必须存在").1;
    format!(
        "{start}{}\n}}\n",
        rest.split_once("\n}\n").expect("函数结束必须存在").0
    )
}

#[test]
fn official_helper_handles_bom_stdin_environment_secrets_and_invalid_config() {
    for use_env in [false, true] {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.data).unwrap();
        fs::write(
            fixture.data.join("config.json"),
            "\u{feff}{\"privacy\":{\"excludeWorkspaces\":[\"保留\u{feff}🚀\"]}}",
        )
        .unwrap();
        let opts = fixture.options();
        let result = fixture.helper("write-config", &opts, use_env);
        success(&result);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
        fixture.assert_only_config_and_released_empty_lock();
        assert!(fs::read(fixture.data.join("config.json"))
            .unwrap()
            .starts_with(b"\xef\xbb\xbf"));
        assert_eq!(
            fixture.config()["privacy"]["excludeWorkspaces"],
            json!(["保留\u{feff}🚀"])
        );
        assert_eq!(fixture.config()["userId"], "研发 O'Brien 🚀");
        assert_eq!(
            fixture.config()["cms"]["licenseKey"],
            "synthetic-test-secret"
        );
        assert!(!fixture.data.join("logs").exists());
        assert!(!fixture.root.path().join("cache").exists());
        for ascii_json in [false, true] {
            let mut command = fixture.command(&fixture.binary);
            command
                .args(["installer-helper", "read-user-id", "--config"])
                .arg(fixture.data.join("config.json"));
            if ascii_json {
                command.arg("--ascii-json");
            }
            let read = bounded(command);
            success(&read);
            let actual = if ascii_json {
                assert!(read.stdout.is_ascii());
                serde_json::from_slice::<String>(&read.stdout).unwrap()
            } else {
                String::from_utf8(read.stdout)
                    .unwrap()
                    .trim_end_matches(['\r', '\n'])
                    .to_string()
            };
            assert_eq!(actual, "研发 O'Brien 🚀");
        }
        fixture.assert_only_config_and_released_empty_lock();
        let original = fs::read(fixture.data.join("config.json")).unwrap();
        success(&fixture.helper("write-config", &opts, use_env));
        assert_eq!(
            original,
            fs::read(fixture.data.join("config.json")).unwrap()
        );
        let mut next = opts.clone();
        next["cmsLicenseKey"] = json!("replacement-test-secret");
        let diff = fixture.helper("config-diffs", &next, use_env);
        success(&diff);
        assert!(String::from_utf8_lossy(&diff.stdout).contains("cms.licenseKey"));
        assert!(!String::from_utf8_lossy(&diff.stdout).contains("test-secret"));
        assert_eq!(
            original,
            fs::read(fixture.data.join("config.json")).unwrap()
        );
        fs::write(
            fixture.data.join("config.json"),
            "{\"credential\":\"never-print\",bad}",
        )
        .unwrap();
        let result = fixture.helper("write-config", &opts, use_env);
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("never-print"));
        assert_eq!(
            fs::read_to_string(fixture.data.join("config.json")).unwrap(),
            "{\"credential\":\"never-print\",bad}"
        );
    }
}

#[test]
fn readonly_config_guards_reject_arrays_corruption_and_invalid_options() {
    let fixture = Fixture::new();
    let options = fixture.options();
    for mode in [false, true] {
        success(&fixture.helper("check-config", &options, mode));
        success(&fixture.helper("validate-config", &options, mode));
    }
    assert!(!fixture.data.exists());
    fs::create_dir_all(&fixture.data).unwrap();
    let path = fixture.data.join("config.json");
    for raw in [
        "{\"sls\":[]}",
        "{\"sls\":[{\"apiKey\":\"never-print\"}]}",
        "{\"secret\":\"never-print\",bad}",
        "[]",
        "null",
    ] {
        fs::write(&path, format!("\u{feff}{raw}")).unwrap();
        let before = fs::read(&path).unwrap();
        for mode in [false, true] {
            let result = fixture.helper("check-config", &options, mode);
            assert_eq!(result.status.code(), Some(1));
            assert!(result.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&result.stderr).contains("never-print"));
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }
    fs::write(&path, "{}").unwrap();
    let mut invalid = options.clone();
    invalid["dashboardPort"] = json!(0);
    assert!(!fixture
        .helper("validate-config", &invalid, true)
        .status
        .success());
    assert_eq!(fs::read(&path).unwrap(), b"{}");
    assert_eq!(fs::read_dir(&fixture.data).unwrap().count(), 1);
    assert!(!fixture.root.path().join("cache").exists());
}

#[cfg(unix)]
#[test]
fn unix_package_root_selection_rejects_legacy_ambiguous_and_linked_roots() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let source = include_str!("../deploy/installer-opensource.sh");
    let script = fixture.root.path().join("select-root.sh");
    fs::write(&script, format!("set -euo pipefail\n{}\nselect_native_package_root \"$TEST_ROOT\"\nprintf '%s' \"$INSTALL_SRC\"\n",
        function(source, "select_native_package_root() {"))).unwrap();
    let select = |root: &Path| {
        let mut command = fixture.command(Path::new("/bin/bash"));
        command.arg(&script).env("TEST_ROOT", root);
        bounded(command)
    };
    let package = |root: &Path| {
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("runtime-manifest.json"), "{}").unwrap();
        fs::write(root.join("bin/loongsuite-pilot"), "structural fixture").unwrap();
        fs::set_permissions(
            root.join("bin/loongsuite-pilot"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    };
    let legacy = fixture.root.path().join("legacy");
    fs::create_dir_all(legacy.join("assets/plugins/host")).unwrap();
    fs::write(legacy.join("package.json"), "{}").unwrap();
    fs::write(legacy.join("assets/plugins/host/package.json"), "{}").unwrap();
    assert!(!select(&legacy).status.success());
    let unpacked = fixture.root.path().join("解压 O'Brien 🚀");
    let first = unpacked.join("native-package");
    package(&first);
    for root in [&unpacked, &first] {
        let result = select(root);
        success(&result);
        assert_eq!(result.stdout, first.to_str().unwrap().as_bytes());
    }
    package(&unpacked.join("another-package"));
    assert!(!select(&unpacked).status.success());
    let linked = fixture.root.path().join("linked");
    fs::create_dir(&linked).unwrap();
    symlink(&first, linked.join("package")).unwrap();
    assert!(!select(&linked).status.success());
    let bin_link = fixture.root.path().join("bin-link");
    fs::create_dir(&bin_link).unwrap();
    fs::write(bin_link.join("runtime-manifest.json"), "{}").unwrap();
    symlink(first.join("bin"), bin_link.join("bin")).unwrap();
    assert!(!select(&bin_link).status.success());
}

#[cfg(unix)]
#[test]
fn unix_dependency_probe_needs_only_system_archive_tools_and_writes_nothing() {
    let fixture = Fixture::new();
    let tools = fixture.root.path().join("tools");
    fs::create_dir(&tools).unwrap();
    let tar = ["/usr/bin/tar", "/bin/tar"]
        .into_iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .expect("需要系统 tar");
    std::os::unix::fs::symlink(tar, tools.join("tar")).unwrap();
    let archive = fixture.root.path().join("local.tar.gz");
    fs::write(&archive, "local fixture").unwrap();
    let source = include_str!("../deploy/installer-opensource.sh");
    let script = fixture.root.path().join("deps.sh");
    fs::write(
        &script,
        format!(
            "set -euo pipefail\nmsg() {{ :; }}\n{}\ncheck_deps\n",
            function(source, "check_deps() {")
        ),
    )
    .unwrap();
    let mut command = fixture.command(Path::new("/bin/bash"));
    command
        .arg(&script)
        .env("PATH", &tools)
        .env("PACKAGE_URL", &archive);
    success(&bounded(command));
    assert!(!fixture.data.exists());
    let mut command = fixture.command(Path::new("/bin/bash"));
    command.arg(script).env("PACKAGE_URL", &archive);
    assert!(!bounded(command).status.success());
    assert!(!fixture.data.exists());
}

#[test]
fn probe_protocol_and_help_errors_have_no_config_side_effects() {
    let fixture = Fixture::new();
    let probes = json!([{"id":"cursor","detected":true}, {"id":"codex","detected":false}]);
    let result = fixture.helper("probe-detected", &probes, true);
    success(&result);
    assert_eq!(result.stdout, b"cursor\n");
    let result = fixture.helper("probe-count", &probes, false);
    success(&result);
    assert_eq!(result.stdout, b"2\n");
    let result = fixture.helper("probe-count", &json!({}), true);
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stdout.is_empty());
    for args in [
        vec!["installer-helper", "--help"],
        vec!["installer-helper", "write-config", "--help"],
    ] {
        let mut cmd = fixture.command(&fixture.binary);
        cmd.args(args);
        success(&bounded(cmd));
    }
    let mut cmd = fixture.command(&fixture.binary);
    cmd.args(["installer-helper", "write-config", "--unknown"]);
    assert_eq!(bounded(cmd).status.code(), Some(2));
    assert!(!fixture.data.exists());
}

#[cfg(unix)]
#[test]
fn unix_installer_config_bridge_runs_without_node_python_or_shell_interpolation() {
    let fixture = Fixture::new();
    let source = include_str!("../deploy/installer-opensource.sh");
    let mut script = String::from("set -euo pipefail\n");
    for name in [
        "native_installer_helper",
        "installer_config_operation",
        "reject_multi_sls_config",
        "write_config",
    ] {
        script.push_str(&function(source, &format!("{name}() {{")));
    }
    script.push_str(r#"
msg() { :; }
for name in SLS_ENDPOINT SLS_PROJECT SLS_LOGSTORE SLS_AK_ID SLS_AK_SECRET SLS_API_KEY LOG_LEVEL USER_ID COLLECT_LOG COLLECT_TRACE CMS_LICENSE_KEY CMS_ENDPOINT CMS_WORKSPACE SERVICE_NAME_PREFIX SELECTED_AGENTS ALL_AGENTS AGENT_SELECTION_EXPLICIT MULTIMODAL_MODE MULTIMODAL_SUPPORTED_AGENTS DASHBOARD_PORT ENABLE_STATUS_BAR_APP MASK_MODE MASK_TYPES MASK_REPLACEMENT_MODE INTERCEPTOR_MODE INTERCEPTOR_TYPES; do
    printf -v "$name" '%s' ''
done
PROBE_RESULT='[{"id":"cursor","detected":true}]'
SELECTED_AGENTS=cursor
USER_ID=$TEST_VALUE
CMS_LICENSE_KEY=$TEST_VALUE
EXCLUDE_WORKSPACES=("$DATA_DIR/排除目录 O'Brien")
reject_multi_sls_config
installer_config_operation validate-config
write_config
"#);
    let path = fixture.root.path().join("bridge.sh");
    fs::write(&path, script).unwrap();
    let value = "研发 O'Brien 🚀 \"quoted\" $(touch must-not-exist)\nsecond line";
    let mut command = fixture.command(Path::new("/bin/bash"));
    command
        .arg(&path)
        .env("INSTALL_SRC", &fixture.candidate)
        .env("DATA_DIR", &fixture.data)
        .env("TEST_VALUE", value);
    success(&bounded(command));
    let config = fixture.config();
    assert_eq!(config["userId"], value);
    assert_eq!(config["cms"]["licenseKey"], value);
    assert_eq!(config["agents"]["cursor"]["enabled"], true);
    assert_eq!(
        config["privacy"]["excludeWorkspaces"][0],
        fixture.data.join("排除目录 O'Brien").to_str().unwrap()
    );
    assert!(!fixture.root.path().join("must-not-exist").exists());
    fs::write(fixture.data.join("config.json"), "broken").unwrap();
    let mut command = fixture.command(Path::new("/bin/bash"));
    command
        .arg(path)
        .env("INSTALL_SRC", &fixture.candidate)
        .env("DATA_DIR", &fixture.data)
        .env("TEST_VALUE", value);
    assert!(!bounded(command).status.success());
    assert_eq!(
        fs::read_to_string(fixture.data.join("config.json")).unwrap(),
        "broken"
    );
}

#[test]
fn native_staging_and_publication_preserve_versions_and_bind_service_paths() {
    let fixture = Fixture::new();
    fixture.package();
    let cache = fixture.root.path().join("cache");
    fs::create_dir_all(cache.join("versions/old-native")).unwrap();
    fs::write(cache.join("versions/old-native/keep"), "old bytes").unwrap();
    fs::write(cache.join("current"), b"\xef\xbb\xbfold-native\r\n").unwrap();
    fs::write(cache.join("previous"), "older-native\n").unwrap();
    let options = fixture.runtime_options(&fixture.candidate);
    let first = fixture.helper("stage-package", &options, true);
    success(&first);
    assert!(first.stdout.is_ascii());
    let first = String::from_utf8(first.stdout).unwrap().trim().to_owned();
    let second = fixture.helper("stage-package", &options, false);
    success(&second);
    let second = String::from_utf8(second.stdout).unwrap().trim().to_owned();
    assert_ne!(first, second);
    let installed = cache.join("versions").join(&first);
    assert!(installed.join("runtime-manifest.json").is_file());
    assert_eq!(
        fs::read(cache.join("current")).unwrap(),
        b"\xef\xbb\xbfold-native\r\n"
    );
    assert_eq!(
        fs::read(cache.join("versions/old-native/keep")).unwrap(),
        b"old bytes"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let options = fixture.runtime_options(&installed);
    success(&fixture.helper("publish-package", &options, true));
    assert_eq!(
        fs::read_to_string(cache.join("current")).unwrap(),
        format!("{first}\n")
    );
    assert_eq!(
        fs::read_to_string(cache.join("previous")).unwrap(),
        "old-native\n"
    );
    success(&fixture.helper("publish-package", &options, false));
    assert_eq!(
        fs::read_to_string(cache.join("previous")).unwrap(),
        "old-native\n"
    );
    assert!(!cache.join("update-recovery.json").exists());
    let layout: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .root
                .path()
                .join(".local/bin/loongsuite-pilot-layout.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(layout["dataDir"], json!(fixture.data));
    assert_eq!(layout["cacheDir"], json!(cache));
    assert_eq!(
        layout["configPath"],
        json!(fixture.data.join("config.json"))
    );
    #[cfg(unix)]
    {
        let service = fixture.root.path().join(".local/bin/loongsuite-pilot");
        let mut command = fixture.command(Path::new("/bin/bash"));
        command
            .arg(&service)
            .env_remove("LOONGSUITE_PILOT_DATA_DIR")
            .env_remove("LOONGSUITE_PILOT_CACHE_DIR")
            .env_remove("AGENT_DATA_COLLECTION_CONFIG");
        let output = bounded(command);
        success(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{}\n{}\n{}\n",
                fixture.data.display(),
                cache.display(),
                fixture.data.join("config.json").display()
            )
        );
        let mut command = fixture.command(Path::new("/bin/bash"));
        command
            .arg(service)
            .env("LOONGSUITE_PILOT_DATA_DIR", "override");
        let output = bounded(command);
        success(&output);
        assert!(output.stdout.starts_with(b"override\n"));
    }
    #[cfg(windows)]
    {
        let service = fs::read(
            fixture
                .root
                .path()
                .join(".local/bin/loongsuite-pilot-service.ps1"),
        )
        .unwrap();
        assert!(service.starts_with(b"\xef\xbb\xbf"));
        let launcher =
            fs::read_to_string(fixture.root.path().join(".local/bin/loongsuite-pilot.cmd"))
                .unwrap();
        assert!(
            launcher.contains("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        );
    }
    fs::write(installed.join("assets/fixture"), "tampered").unwrap();
    assert!(!fixture
        .helper("publish-package", &options, true)
        .status
        .success());
    assert_eq!(
        fs::read_to_string(cache.join("current")).unwrap(),
        format!("{first}\n")
    );
    assert!(!fixture.data.join("logs").exists());
    assert!(!cache.join("bin/collector-daemon.js").exists());
}

#[test]
fn first_install_previews_config_without_publishing_then_commits_it_with_runtime() {
    let fixture = Fixture::new();
    fixture.package();
    let data = fixture.root.path().join("首次安装 🚀");
    let config = data.join("配置.json");
    let mut options = fixture.runtime_options(&fixture.candidate);
    options["dataDir"] = json!(data);
    options["configPath"] = json!(config);
    options["configOptions"] = json!({"userId":"研发 O'Brien 🚀", "dashboardPort":9876,
        "collectLog":false, "collectTrace":false, "selectedAgents":"none", "agentSelectionExplicit":true,
        "probeResult":[{"id":"cursor-cli", "detected":false}]});
    let staged = fixture.helper("stage-package", &options, true);
    success(&staged);
    assert!(!data.exists(), "预检不能写入目标配置或锁");
    assert!(!fixture.root.path().join("cache/current").exists());
    let name = String::from_utf8(staged.stdout).unwrap().trim().to_owned();
    let installed = fixture.root.path().join("cache/versions").join(&name);
    options["sourceDir"] = json!(installed);
    // 与 PowerShell 5.1 相同的内层 JSON 字符串协议。
    options["configOptions"] = json!(options["configOptions"].to_string());
    options["deployHooks"] = json!(true);
    let published = fixture.helper("publish-package", &options, false);
    success(&published);
    assert!(published.stdout.is_empty());
    let bytes = fs::read(&config).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["userId"], "研发 O'Brien 🚀");
    assert_eq!(value["dashboard"]["port"], 9876);
    assert_eq!(value["dataDir"], json!(data));
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("cache/current")).unwrap(),
        format!("{name}\n")
    );
    assert!(!fixture
        .root
        .path()
        .join("cache/update-recovery.json")
        .exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    success(&fixture.helper("publish-package", &options, true));
    assert_eq!(fs::read(&config).unwrap(), bytes, "重装保留配置原始字节");
}

#[test]
fn installation_applies_agent_selection_before_real_hook_injection() {
    let fixture = Fixture::new();
    fixture.package_with(&[
        (
            "agents.d/cursor.json",
            include_str!("../agents.d/cursor.json"),
        ),
        (
            "agents.d/codex.json",
            include_str!("../agents.d/codex.json"),
        ),
        (
            "assets/hooks/cursor-loongsuite-pilot-hook.sh",
            include_str!("../assets/hooks/cursor-loongsuite-pilot-hook.sh"),
        ),
        (
            "assets/hooks/cursor-loongsuite-pilot-hook.ps1",
            include_str!("../assets/hooks/cursor-loongsuite-pilot-hook.ps1"),
        ),
        (
            "assets/hooks/shared/native.sh",
            include_str!("../assets/hooks/shared/native.sh"),
        ),
        (
            "assets/hooks/shared/native.ps1",
            include_str!("../assets/hooks/shared/native.ps1"),
        ),
    ]);
    let cursor = fixture.root.path().join(".cursor/hooks.json");
    let codex = fixture.root.path().join(".codex/config.toml");
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    fs::create_dir_all(codex.parent().unwrap()).unwrap();
    fs::write(
        &cursor,
        r#"{"version":1,"hooks":{"stop":[{"command":"user-owned-hook"}]}}"#,
    )
    .unwrap();
    let codex_original = b"# user comment\nmodel = \"user-model\"\n";
    fs::write(&codex, codex_original).unwrap();
    let mut options = fixture.runtime_options(&fixture.candidate);
    options["configOptions"] = json!({"selectedAgents":"cursor", "agentSelectionExplicit":true,
        "probeResult":[{"id":"cursor", "detected":true}, {"id":"codex", "detected":true}, {"id":"cursor-cli", "detected":false}]});
    let staged = fixture.helper("stage-package", &options, true);
    success(&staged);
    let name = String::from_utf8(staged.stdout).unwrap().trim().to_owned();
    options["sourceDir"] = json!(fixture.root.path().join("cache/versions").join(name));
    options["deployHooks"] = json!(true);
    let published = fixture.helper("publish-package", &options, true);
    assert!(
        published.status.success(),
        "isolated first Hook publication failed: {} | report={}",
        String::from_utf8_lossy(&published.stderr),
        fs::read_to_string(fixture.data.join("last-hook-install.json"))
            .unwrap_or_else(|_| "missing controlled fixture report".into())
    );
    let first = fs::read(&cursor).unwrap();
    let value: Value = serde_json::from_slice(&first).unwrap();
    let hooks = value["hooks"]["stop"].as_array().unwrap();
    assert!(hooks
        .iter()
        .any(|hook| hook["command"] == "user-owned-hook"));
    assert_eq!(
        hooks
            .iter()
            .filter(|hook| hook["command"]
                .as_str()
                .is_some_and(|value| value.contains("cursor-loongsuite-pilot-hook")))
            .count(),
        1
    );
    assert_eq!(fs::read(&codex).unwrap(), codex_original);
    assert_eq!(fixture.config()["agents"]["codex"]["enabled"], false);
    assert!(fixture
        .data
        .join(if cfg!(windows) {
            "hooks/shared/native.ps1"
        } else {
            "hooks/shared/native.sh"
        })
        .is_file());
    let published = fixture.helper("publish-package", &options, false);
    assert!(
        published.status.success(),
        "isolated Hook publication failed: {} | report={}",
        String::from_utf8_lossy(&published.stderr),
        fs::read_to_string(fixture.data.join("last-hook-install.json"))
            .unwrap_or_else(|_| "missing controlled fixture report".into())
    );
    assert_eq!(fs::read(cursor).unwrap(), first);
    assert_eq!(fs::read(codex).unwrap(), codex_original);
}

#[test]
fn config_preview_rejects_invalid_privacy_without_install_state() {
    let fixture = Fixture::new();
    fixture.package();
    let path = fixture.data.join("config.json");
    let original =
        b"\xef\xbb\xbf{\"userId\":\"never-print\",\"privacy\":{\"excludeWorkspaces\":[\"relative\"]}}\r\n";
    fs::write(&path, original).unwrap();
    let mut options = fixture.runtime_options(&fixture.candidate);
    options["configOptions"] = json!({"userId":"replacement-test-secret"});
    let output = fixture.helper("stage-package", &options, true);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("never-print"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("replacement-test-secret"));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!fixture.root.path().join("cache").exists());
    assert!(!fixture.root.path().join(".local").exists());
    assert_eq!(fs::read_dir(&fixture.data).unwrap().count(), 1);
}

#[test]
fn hook_failure_restores_config_bytes_mode_and_version_pointers() {
    for first_install in [false, true] {
        let fixture = Fixture::new();
        fixture.package();
        let config = fixture.data.join(if first_install {
            "new.json"
        } else {
            "config.json"
        });
        let original = b"\xef\xbb\xbf{\"custom\":\"keep\"}\r\n";
        if !first_install {
            fs::write(&config, original).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&config, fs::Permissions::from_mode(0o640)).unwrap();
            }
        }
        let mut options = fixture.runtime_options(&fixture.candidate);
        options["configPath"] = json!(config);
        options["configOptions"] = json!({"userId":"new-value"});
        let staged = fixture.helper("stage-package", &options, true);
        success(&staged);
        let name = String::from_utf8(staged.stdout).unwrap().trim().to_owned();
        options["sourceDir"] = json!(fixture.root.path().join("cache/versions").join(name));
        options["deployHooks"] = json!(true);
        let cache = fixture.root.path().join("cache");
        fs::write(cache.join("current"), "old-version\n").unwrap();
        fs::write(cache.join("previous"), "older-version\n").unwrap();
        let mut command = fixture.command(&fixture.binary);
        command
            .args(["installer-helper", "publish-package", "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string())
            .env("LOONGSUITE_PILOT_AGENTS", "unknown-fixture-agent");
        let output = bounded(command);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Hook 部署失败"));
        if first_install {
            assert!(!config.exists());
        } else {
            assert_eq!(fs::read(&config).unwrap(), original);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&config).unwrap().permissions().mode() & 0o777,
                    0o640
                );
            }
        }
        assert_eq!(fs::read(cache.join("current")).unwrap(), b"old-version\n");
        assert_eq!(
            fs::read(cache.join("previous")).unwrap(),
            b"older-version\n"
        );
        assert!(!cache.join("update-recovery.json").exists());
        assert!(!fixture
            .root
            .path()
            .join(".local/bin/loongsuite-pilot-layout.json")
            .exists());
    }
}

#[test]
fn native_package_preflight_failure_never_creates_install_state() {
    let fixture = Fixture::new();
    fixture.package();
    let options = fixture.runtime_options(&fixture.candidate);
    let mut missing = options.clone();
    missing["configPath"] = json!(fixture.data.join("missing.json"));
    assert!(!fixture
        .helper("stage-package", &missing, true)
        .status
        .success());
    assert!(!fixture.root.path().join("cache").exists());
    assert!(!fixture.data.join("missing.json").exists());
    fs::write(fixture.data.join("config.json"), "broken configuration").unwrap();
    assert!(!fixture
        .helper("stage-package", &options, true)
        .status
        .success());
    assert!(!fixture.root.path().join("cache").exists());
    fs::write(fixture.data.join("config.json"), "{}").unwrap();
    fs::write(fixture.candidate.join("assets/fixture"), "bad digest").unwrap();
    assert!(!fixture
        .helper("stage-package", &options, false)
        .status
        .success());
    assert!(!fixture.root.path().join("cache").exists());
    assert!(!fixture.root.path().join(".local").exists());
}

#[cfg(unix)]
#[test]
fn unix_runtime_bridge_stages_and_syncs_without_external_runtimes() {
    let fixture = Fixture::new();
    fixture.package();
    fs::write(fixture.data.join("custom-config.json"), "{}").unwrap();
    let source = include_str!("../deploy/installer-opensource.sh");
    let mut script = String::from("set -euo pipefail\n");
    for name in [
        "native_installer_helper",
        "installer_runtime_operation",
        "deploy_bootstrap_scripts",
    ] {
        script.push_str(&function(source, &format!("{name}() {{")));
    }
    let service_source = include_str!("../scripts/loongsuite-pilot.sh");
    for name in ["native_version_root", "sync_installed_scripts_from_version"] {
        script.push_str(&function(service_source, &format!("{name}() {{")));
    }
    script.push_str("name=$(installer_runtime_operation \"$INSTALL_SRC\" stage-package)\nPERMANENT_DIR=\"$LOONGSUITE_PILOT_CACHE_DIR/versions/$name\"\ndeploy_bootstrap_scripts\ninstaller_runtime_operation \"$PERMANENT_DIR\" publish-package\nCACHE_DIR=$LOONGSUITE_PILOT_CACHE_DIR\nCONFIG_FILE=\"$DATA_DIR/custom-config.json\"\nLOONGSUITE_PILOT_BIN=\"$HOME/.local/bin/loongsuite-pilot\"\nsync_installed_scripts_from_version \"$PERMANENT_DIR\"\n");
    let path = fixture.root.path().join("runtime-bridge.sh");
    fs::write(&path, script).unwrap();
    let mut cmd = fixture.command(Path::new("/bin/bash"));
    cmd.arg(path)
        .env("INSTALL_SRC", &fixture.candidate)
        .env("DATA_DIR", &fixture.data);
    success(&bounded(cmd));
    let layout: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .root
                .path()
                .join(".local/bin/loongsuite-pilot-layout.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        layout["configPath"],
        json!(fixture.data.join("custom-config.json"))
    );
    assert!(fixture.root.path().join("cache/current").is_file());
    assert!(fixture
        .root
        .path()
        .join(".local/bin/loongsuite-pilot")
        .is_file());
}

#[cfg(unix)]
#[test]
fn install_preflight_and_confirmation_finish_before_any_service_stop() {
    for scenario in [
        "new",
        "cancel",
        "invalid-privacy",
        "supported-enricher",
        "bad-resource",
    ] {
        let fixture = Fixture::new();
        fixture.package();
        let data = fixture.root.path().join("首次安装主流程 🚀");
        if matches!(scenario, "invalid-privacy" | "supported-enricher") {
            fs::create_dir_all(&data).unwrap();
            fs::write(
                data.join("config.json"),
                if scenario == "invalid-privacy" {
                    r#"{"privacy":{"excludeWorkspaces":["relative"]}}"#
                } else {
                    r#"{"otlpTrace":{"spanEnrichers":["optional.mjs"]}}"#
                },
            )
            .unwrap();
        }
        if scenario == "bad-resource" {
            fs::write(fixture.candidate.join("assets/fixture"), "bad digest").unwrap();
        }
        let source = include_str!("../deploy/installer-opensource.sh");
        let mut script = String::from("set -euo pipefail\n");
        for name in [
            "native_installer_helper",
            "installer_config_operation",
            "installer_runtime_operation",
            "reject_multi_sls_config",
            "prepare_package",
            "cmd_install",
        ] {
            script.push_str(&function(source, &format!("{name}() {{")));
        }
        script.push_str(r#"
msg() { :; }
validate_install_user() { :; }
check_deps() { :; }
get_installed_version() { :; }
download_and_extract() { :; }
probe_agents() { PROBE_RESULT='[{"id":"cursor-cli","detected":false}]'; }
select_agents() { SELECTED_AGENTS=none; AGENT_SELECTION_EXPLICIT=1; }
prompt_user_id() { :; }
confirm_config_overwrite() { if [ "$SCENARIO" = cancel ]; then exit 0; fi; }
stop_pilot_for_deploy() { printf 'stopped' > "$STOP_MARKER"; return 17; }
restore_pilot_after_deploy() { :; }
rm() { :; }
for name in SLS_ENDPOINT SLS_PROJECT SLS_LOGSTORE SLS_AK_ID SLS_AK_SECRET SLS_API_KEY LOG_LEVEL USER_ID COLLECT_LOG COLLECT_TRACE CMS_LICENSE_KEY CMS_ENDPOINT CMS_WORKSPACE SERVICE_NAME_PREFIX SELECTED_AGENTS ALL_AGENTS AGENT_SELECTION_EXPLICIT MULTIMODAL_MODE MULTIMODAL_SUPPORTED_AGENTS DASHBOARD_PORT ENABLE_STATUS_BAR_APP MASK_MODE MASK_TYPES MASK_REPLACEMENT_MODE INTERCEPTOR_MODE INTERCEPTOR_TYPES; do
    printf -v "$name" '%s' ''
done
PACKAGE_NAME=fixture
EXCLUDE_WORKSPACES=()
PROBE_RESULT='[]'
cmd_install
"#);
        let path = fixture.root.path().join("install-preflight.sh");
        fs::write(&path, script).unwrap();
        let stop = fixture.root.path().join("stop-marker");
        let mut command = fixture.command(Path::new("/bin/bash"));
        command
            .arg(path)
            .env("DATA_DIR", &data)
            .env("INSTALL_SRC", &fixture.candidate)
            .env("SCENARIO", scenario)
            .env("STOP_MARKER", &stop);
        let output = bounded(command);
        assert_eq!(
            output.status.code(),
            Some(match scenario {
                "new" | "supported-enricher" => 17,
                "cancel" => 0,
                _ => 1,
            }),
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            stop.exists(),
            matches!(scenario, "new" | "supported-enricher")
        );
        assert!(!fixture.root.path().join("cache/current").exists());
        assert!(!fixture.root.path().join(".local").exists());
        if !matches!(scenario, "invalid-privacy" | "supported-enricher") {
            assert!(!data.exists());
        }
        if !matches!(scenario, "new" | "supported-enricher") {
            assert!(!fixture.root.path().join("cache").exists());
        }
    }
}

#[test]
fn service_sync_refuses_cross_installation_overwrite() {
    let fixture = Fixture::new();
    fixture.package();
    let options = fixture.runtime_options(&fixture.candidate);
    success(&fixture.helper("sync-service", &options, true));
    let directory = fixture.root.path().join(".local/bin");
    let snapshot = || {
        let mut files: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), fs::read(entry.path()).unwrap())
            })
            .collect();
        files.sort();
        files
    };
    let before = snapshot();
    for key in ["cacheDir", "dataDir"] {
        let mut other = options.clone();
        other[key] = json!(fixture.root.path().join("another-install"));
        let result = fixture.helper("sync-service", &other, true);
        assert_eq!(result.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&result.stderr).contains("属于其他安装"));
        assert_eq!(snapshot(), before);
    }
}

#[cfg(windows)]
fn windows_shells() -> [PathBuf; 2] {
    let system = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"));
    let legacy = system.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let pwsh = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("pwsh.exe"))
        .find(|p| p.is_file())
        .expect("Windows 验收需要 pwsh，不能跳过");
    assert!(legacy.is_file(), "Windows 验收需要 PowerShell 5.1");
    [legacy, pwsh]
}

#[cfg(windows)]
fn windows_prelude(constrained: bool) -> String {
    // App Control runs trusted system modules in FullLanguage. Load only OS
    // modules before constraining all Pilot definitions and invocation code.
    // This fixture models that boundary; it does not install a WDAC policy.
    let mut script = String::from(
        "\u{feff}$env:PILOT_TEST_STAGE = 'shell-entry'\n$env:PSModulePath = $PSHOME + '\\Modules'\n$ErrorActionPreference = 'Stop'\n",
    );
    script.push_str("Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\nImport-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop\nImport-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1') -ErrorAction Stop\n");
    if constrained {
        script.push_str(r#"
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
function Assert-PilotConstrainedLanguage {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { throw 'Pilot code must remain constrained' }
    $blocked = $false
    try { $null = [System.IO.File]::Exists('PILOT_CLM_CANARY') }
    catch {
        if ($_.FullyQualifiedErrorId -notmatch 'ConstrainedLanguage') { throw }
        $blocked = $true
    }
    if (-not $blocked) { throw 'Pilot CLM canary unexpectedly allowed a forbidden API' }
}
Assert-PilotConstrainedLanguage
"#);
    }
    script
}

#[cfg(windows)]
fn windows_script(constrained: bool, names: &[&str]) -> String {
    let mut script = windows_prelude(constrained);
    let source = include_str!("../deploy/installer-opensource.ps1");
    for name in names {
        script.push_str(&function(source, &format!("function {name} {{")));
    }
    script
}

#[cfg(windows)]
fn windows_command(fixture: &Fixture, shell: &Path, script: &str) -> Command {
    let path = fixture.root.path().join("windows-case.ps1");
    fs::write(&path, script).unwrap();
    let mut command = fixture.command(shell);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(path)
        .env("TEST_CANDIDATE", &fixture.candidate)
        .env("TEST_DATA", &fixture.data);
    command
}

#[cfg(windows)]
#[test]
fn windows_package_root_selection_rejects_legacy_and_ambiguous_roots() {
    for shell in windows_shells() {
        for constrained in [false, true] {
            for scenario in ["direct", "nested", "legacy", "ambiguous"] {
                let fixture = Fixture::new();
                let root = fixture.root.path().join("解压 O'Brien [根] 🚀");
                fs::create_dir_all(&root).unwrap();
                let selected = if scenario == "direct" {
                    root.clone()
                } else {
                    root.join("原生包 🚀")
                };
                fs::create_dir_all(selected.join("bin")).unwrap();
                if scenario == "legacy" {
                    fs::write(selected.join("package.json"), "{}").unwrap();
                } else {
                    fs::write(selected.join("runtime-manifest.json"), "{}").unwrap();
                    fs::write(selected.join("bin/loongsuite-pilot.exe"), "fixture").unwrap();
                }
                if scenario == "ambiguous" {
                    fs::create_dir_all(root.join("second/bin")).unwrap();
                    fs::write(root.join("second/runtime-manifest.json"), "{}").unwrap();
                    fs::write(root.join("second/bin/loongsuite-pilot.exe"), "fixture").unwrap();
                }
                let mut script = windows_script(constrained, &["Select-NativePackageRoot"]);
                script.push_str("Select-NativePackageRoot -Directory $env:TEST_ROOT\n$script:INSTALL_SRC | Set-Content -LiteralPath $env:TEST_RESULT -Encoding UTF8\n");
                let result = fixture.root.path().join("selected.txt");
                let mut command = windows_command(&fixture, &shell, &script);
                command.env("TEST_ROOT", &root).env("TEST_RESULT", &result);
                let output = bounded(command);
                if ["direct", "nested"].contains(&scenario) {
                    success(&output);
                    let actual = fs::read_to_string(&result).unwrap();
                    assert_eq!(
                        fs::canonicalize(actual.trim_start_matches('\u{feff}').trim()).unwrap(),
                        fs::canonicalize(&selected).unwrap()
                    );
                } else {
                    assert!(!output.status.success(), "{scenario}");
                    assert!(!result.exists());
                }
                assert!(!fixture.root.path().join("cache").exists());
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_first_install_prepares_and_publishes_config_in_both_language_modes() {
    for shell in windows_shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            fixture.package();
            let data = fixture.root.path().join("首次 Windows 安装 🚀");
            let mut script = windows_script(
                constrained,
                &[
                    "Invoke-InstallerHelper",
                    "Get-InstallConfigJson",
                    "Invoke-InstallerRuntime",
                    "Prepare-Package",
                    "Deploy-Package",
                    "Prompt-UserId",
                ],
            );
            script.push_str(r#"
function Msg { param($Chinese, $English) }
function Test-CanPrompt { throw 'existing user id must not prompt' }
$script:INSTALL_SRC = $env:TEST_CANDIDATE
$DataDir = $env:TEST_DATA
$CACHE_DIR = $env:LOONGSUITE_PILOT_CACHE_DIR
$script:INSTALL_CONFIG = $true
$script:UserId = $env:TEST_VALUE
$script:SELECTED_AGENTS = 'none'
$script:AGENT_SELECTION_EXPLICIT = '1'
$script:PROBE_RESULT = '[{"id":"cursor-cli","detected":false}]'
$CollectLog = 'false'
$CollectTrace = 'false'
$env:LOONGSUITE_PILOT_INSTALL_INPUT = 'prior-input'
Prepare-Package $script:INSTALL_SRC
if (Test-Path -LiteralPath $DataDir) { throw 'prepare wrote target config' }
if (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'current')) { throw 'prepare published runtime' }
Deploy-Package $script:STAGED_DIR
if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne 'prior-input') { throw 'input environment not restored' }
$script:UserId = ''
Prompt-UserId
$script:UserId | Set-Content -LiteralPath $env:TEST_RESULT -Encoding UTF8
try {
    Invoke-InstallerHelper -Operation 'validate-config' -Json '{"unknown":"test-secret"}' | Out-Null
    throw 'unexpected validation success'
} catch {
    if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne 'prior-input') { throw 'failed input environment not restored' }
    if ($ErrorActionPreference -ne 'Stop') { throw 'error preference not restored' }
    if ("$_" -notmatch 'exit=1') { throw }
}
"#);
            let value = "研发 O'Brien 🚀 \"quoted\" $literal";
            let result = fixture.root.path().join("user-id.txt");
            let mut command = windows_command(&fixture, &shell, &script);
            command
                .env("TEST_DATA", &data)
                .env("TEST_VALUE", value)
                .env("TEST_RESULT", &result);
            success(&bounded_for(command, Duration::from_secs(60)));
            let config: Value =
                serde_json::from_slice(&fs::read(data.join("config.json")).unwrap()).unwrap();
            assert_eq!(config["userId"], value);
            assert_eq!(config["agents"]["cursor-cli"]["enabled"], false);
            assert_eq!(
                fs::read_to_string(result)
                    .unwrap()
                    .trim_start_matches('\u{feff}')
                    .trim(),
                value
            );
            assert!(fixture.root.path().join("cache/current").is_file());
            assert!(!fixture
                .root
                .path()
                .join("cache/update-recovery.json")
                .exists());
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_install_preflight_and_cancel_precede_task_and_service_operations() {
    for shell in windows_shells() {
        for constrained in [false, true] {
            for scenario in [
                "new",
                "cancel",
                "invalid-privacy",
                "supported-enricher",
                "bad-resource",
            ] {
                let fixture = Fixture::new();
                fixture.package();
                let data = fixture.root.path().join("Windows 安装主流程 🚀");
                let original = match scenario {
                    "cancel" => Some("{\"userId\":\"prior-user\"}"),
                    "invalid-privacy" => Some(r#"{"privacy":{"excludeWorkspaces":["relative"]}}"#),
                    "supported-enricher" => {
                        Some(r#"{"otlpTrace":{"spanEnrichers":["optional.mjs"]}}"#)
                    }
                    _ => None,
                };
                if let Some(original) = original {
                    fs::create_dir_all(&data).unwrap();
                    fs::write(data.join("config.json"), original).unwrap();
                }
                if scenario == "bad-resource" {
                    fs::write(fixture.candidate.join("assets/fixture"), "bad digest").unwrap();
                }
                let mut script = windows_script(
                    constrained,
                    &[
                        "Invoke-InstallerHelper",
                        "Get-InstallConfigJson",
                        "Invoke-InstallerRuntime",
                        "Prepare-Package",
                        "Assert-SingleSlsConfig",
                        "Confirm-ConfigOverwrite",
                        "Cmd-Install",
                    ],
                );
                script.push_str(
                    r#"
function Msg { param($Chinese, $English) }
function Warn-ElevatedInstall { }
function Check-Deps { }
function Get-InstalledVersion { }
function Download-AndExtract { }
function Probe-Agents { $script:PROBE_RESULT = '[{"id":"cursor-cli","detected":false}]' }
function Select-Agents { $script:SELECTED_AGENTS = 'none'; $script:AGENT_SELECTION_EXPLICIT = '1' }
function Prompt-UserId { $script:UserId = 'updated' }
function Test-CanPrompt { return $env:TEST_SCENARIO -eq 'cancel' }
function Read-Host { param($Prompt); if ($env:TEST_SCENARIO -ne 'cancel') { throw 'unexpected prompt' }; return 'n' }
function Disable-PilotScheduledTasksDuringDeploy {
    'disabled' | Set-Content -LiteralPath $env:TEST_STOP -Encoding UTF8
    throw 'fixture-stop-before-system-actions'
}
function Stop-PilotService { throw 'must not reach real service action' }
function Enable-PilotScheduledTasksAfterDeploy { }
function Remove-PilotPathQuietly { param($Path) }
$script:INSTALL_SRC = $env:TEST_CANDIDATE
$DataDir = $env:TEST_DATA
$CACHE_DIR = $env:LOONGSUITE_PILOT_CACHE_DIR
Cmd-Install
"#,
                );
                let stop = fixture.root.path().join("stop-marker");
                let mut command = windows_command(&fixture, &shell, &script);
                command
                    .env("TEST_DATA", &data)
                    .env("TEST_STOP", &stop)
                    .env("TEST_SCENARIO", scenario);
                let output = bounded(command);
                assert_eq!(
                    output.status.success(),
                    scenario == "cancel",
                    "{scenario}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(
                    stop.exists(),
                    matches!(scenario, "new" | "supported-enricher"),
                    "{scenario}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(!fixture.root.path().join("cache/current").exists());
                assert!(!fixture.root.path().join(".local").exists());
                if let Some(original) = original {
                    assert_eq!(
                        fs::read(data.join("config.json")).unwrap(),
                        original.as_bytes()
                    );
                } else {
                    assert!(!data.exists());
                }
                if !matches!(scenario, "new" | "supported-enricher") {
                    assert!(!fixture.root.path().join("cache").exists());
                }
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_runtime_bridges_preserve_paths_layout_and_input_environment() {
    for shell in windows_shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            fixture.package();
            fs::write(fixture.data.join("custom-config.json"), "{}").unwrap();
            let mut script = windows_prelude(constrained);
            let source = include_str!("../deploy/installer-opensource.ps1");
            for name in [
                "Invoke-InstallerHelper",
                "Invoke-InstallerRuntime",
                "Deploy-BootstrapScripts",
            ] {
                script.push_str(&function(source, &format!("function {name} {{")));
            }
            let source = include_str!("../scripts/loongsuite-pilot.ps1");
            for name in [
                "Test-NativePath",
                "Test-NativeVersion",
                "Invoke-Pilot",
                "Sync-InstalledScriptsFromVersion",
            ] {
                script.push_str(&function(source, &format!("function {name} {{")));
            }
            script.push_str(r#"
$script:INSTALL_SRC = $env:TEST_CANDIDATE
$DataDir = $env:TEST_DATA
$CACHE_DIR = $env:LOONGSUITE_PILOT_CACHE_DIR
$env:LOONGSUITE_PILOT_INSTALL_INPUT = 'prior-input'
$name = Invoke-InstallerRuntime -SourceDir $script:INSTALL_SRC -Operation 'stage-package'
$script:PERMANENT_DIR = Join-Path (Join-Path $CACHE_DIR 'versions') $name
Deploy-BootstrapScripts
Invoke-InstallerRuntime -SourceDir $script:PERMANENT_DIR -Operation 'publish-package'
$DATA_DIR = $DataDir
$CONFIG_FILE = Join-Path $DATA_DIR 'custom-config.json'
$LOONGSUITE_PILOT_BIN = Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot.cmd'
if (-not (Sync-InstalledScriptsFromVersion $script:PERMANENT_DIR)) { throw 'service sync failed' }
if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne 'prior-input') { throw 'input environment not restored' }
"#);
            let path = fixture.root.path().join("runtime-bridge.ps1");
            fs::write(&path, script).unwrap();
            let mut command = fixture.command(&shell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&path)
                .env("TEST_CANDIDATE", &fixture.candidate)
                .env("TEST_DATA", &fixture.data);
            success(&bounded(command));
            let layout: Value = serde_json::from_slice(
                &fs::read(
                    fixture
                        .root
                        .path()
                        .join(".local/bin/loongsuite-pilot-layout.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                layout["configPath"],
                json!(fixture.data.join("custom-config.json"))
            );
            assert!(fixture.root.path().join("cache/current").is_file());
            assert!(!fixture.data.join("logs").exists());
            // 只执行实际服务脚本的路径解析段，不触发任何服务操作。
            let source = include_str!("../scripts/loongsuite-pilot.ps1");
            let path_logic = source
                .split_once("$DEFAULT_PILOT_DIR =")
                .unwrap()
                .1
                .split_once("$SPAN_ATTR_FILE =")
                .unwrap()
                .0;
            let path = fixture.root.path().join(".local/bin/layout-test.ps1");
            fs::write(&path, format!("{}$env:PILOT_TEST_STAGE = 'layout-parse'\n$DEFAULT_PILOT_DIR ={path_logic}\nWrite-Output $CONFIG_FILE\n",windows_prelude(constrained))).unwrap();
            // 用文件写回 UTF-8，避开 Windows 5.1 原生 stdout 编码差异。
            let path_text = fs::read_to_string(&path).unwrap().replace(
                "Write-Output $CONFIG_FILE",
                "$CONFIG_FILE | Set-Content -LiteralPath $env:TEST_RESULT -Encoding UTF8",
            );
            fs::write(&path, path_text).unwrap();
            let result = fixture.root.path().join("layout-result.txt");
            let mut command = fixture.command(&shell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(path)
                .env_remove("AGENT_DATA_COLLECTION_CONFIG")
                .env("TEST_RESULT", &result);
            success(&bounded(command));
            assert_eq!(
                fs::read_to_string(result)
                    .unwrap()
                    .trim_start_matches('\u{feff}')
                    .trim(),
                fixture.data.join("custom-config.json").to_str().unwrap()
            );
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_installer_config_bridge_preserves_unicode_and_environment_in_both_shells() {
    for shell in windows_shells() {
        assert!(shell.is_file(), "缺少 Windows 测试 Shell");
        for constrained in [false, true] {
            let fixture = Fixture::new();
            fixture.package();
            fs::write(
                fixture.data.join("config.json"),
                "\u{feff}{\"privacy\":{\"excludeWorkspaces\":[\"保留\u{feff}🚀\"]}}",
            )
            .unwrap();
            let source = include_str!("../deploy/installer-opensource.ps1");
            let mut script = windows_prelude(constrained);
            for name in [
                "Invoke-InstallerHelper",
                "Get-InstallConfigJson",
                "Assert-SingleSlsConfig",
                "Check-Deps",
                "Write-Config",
                "Probe-Agents",
            ] {
                let extracted = function(source, &format!("function {name} {{"));
                script.push_str(&if name == "Check-Deps" {
                    extracted.replace(
                        "if (-not (Get-Command $name -ErrorAction SilentlyContinue))",
                        "$env:PILOT_TEST_STAGE = 'check-deps-' + $name\n        if (-not (Get-Command $name -ErrorAction SilentlyContinue))",
                    )
                } else {
                    extracted
                });
            }
            script.push_str(&function(
                include_str!("../scripts/loongsuite-pilot.ps1"),
                "function Invoke-Pilot {",
            ));
            script.push_str(
                r#"
function Msg { param($Chinese, $English) }
$script:LASTEXITCODE = 4321
$script:INSTALL_SRC = $env:TEST_CANDIDATE
$DataDir = $env:TEST_DATA
$script:UserId = $env:TEST_VALUE
$CmsLicenseKey = $env:TEST_VALUE
$script:PROBE_RESULT = '[]'
$env:PILOT_TEST_STAGE = 'check-deps'
Check-Deps
# Initialize system archive/download modules before isolating native TEMP.
# Every native Pilot invocation below still uses the Unicode test directory.
$env:TEMP = $env:TEST_NATIVE_TEMP
$env:TMP = $env:TEST_NATIVE_TEMP
$env:PILOT_TEST_STAGE = 'probe-agents'
Probe-Agents
if (@($script:PROBE_RESULT | ConvertFrom-Json).Count -lt 1) { throw 'empty native probe result' }
$env:PILOT_TEST_STAGE = 'check-config'
Assert-SingleSlsConfig
$DATA_DIR = $DataDir
$CACHE_DIR = $env:LOONGSUITE_PILOT_CACHE_DIR
$CONFIG_FILE = Join-Path $DataDir 'config.json'
$binary = Join-Path $script:INSTALL_SRC 'bin\loongsuite-pilot.exe'
$env:PILOT_TEST_STAGE = 'service-version'
Invoke-Pilot -Binary $binary -Arguments @('--version') | Out-Null
if ($script:PilotExitCode -ne 0) { throw 'native success exit code lost' }
Invoke-Pilot -Binary $binary -Arguments @('--invalid-fixture-option') | Out-Null
if ($script:PilotExitCode -ne 2) { throw 'native failure exit code lost' }
foreach ($previous in @($null, 'previous 研发 🚀')) {
    $env:LOONGSUITE_PILOT_INSTALL_INPUT = $previous
    $env:PILOT_TEST_STAGE = 'validate-config'
    Write-Output 'PILOT_BRIDGE_STAGE:validate-config'
    Invoke-InstallerHelper -Operation 'validate-config' -Json (Get-InstallConfigJson) | Out-Null
    $env:PILOT_TEST_STAGE = 'write-config'
    Write-Output 'PILOT_BRIDGE_STAGE:write-config'
    Write-Config
    if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne $previous) { throw 'input environment not restored' }
    try {
        Invoke-InstallerHelper -Operation 'validate-config' -Json '{"unknown":"bridge-payload-secret"}' | Out-Null
        throw 'unexpected validation success'
    } catch {
        if ("$_" -notmatch 'exit=1') { throw }
    }
    if ($env:LOONGSUITE_PILOT_INSTALL_INPUT -ne $previous) { throw 'failed input environment not restored' }
    if ($ErrorActionPreference -ne 'Stop') { throw 'error preference not restored' }
}
"#,
            );
            let path = fixture.root.path().join("bridge.ps1");
            fs::write(&path, script).unwrap();
            let value = "bridge-payload-secret 研发 O'Brien 🚀 \"quoted\" $literal";
            let temp = fixture.root.path().join("隔离 TEMP🚀");
            fs::create_dir(&temp).unwrap();
            let mut command = fixture.command(&shell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&path)
                .env("TEST_CANDIDATE", &fixture.candidate)
                .env("TEST_DATA", &fixture.data)
                .env("TEST_VALUE", value)
                // Set Unicode TEMP inside the started shell before every native
                // helper call; keep shell bootstrap separate from that contract.
                .env("TEST_NATIVE_TEMP", &temp);
            let output = bounded(command);
            assert!(
                output.status.success(),
                "安装桥接失败：shell={} constrained={constrained}\n{}",
                shell.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            for stream in [&output.stdout, &output.stderr] {
                assert!(!String::from_utf8_lossy(stream).contains("bridge-payload-secret"));
            }
            assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
            fixture.assert_only_config_and_released_empty_lock();
            assert!(!fixture.data.join("logs").exists());
            assert!(!fixture.root.path().join("cache").exists());
            assert_eq!(fixture.config()["userId"], value);
            assert_eq!(fixture.config()["cms"]["licenseKey"], value);
            assert_eq!(
                fixture.config()["privacy"]["excludeWorkspaces"],
                json!(["保留\u{feff}🚀"])
            );
        }
    }
}

#[test]
fn native_uninstall_preflight_and_repeat_cleanup_preserve_user_hooks_and_configuration() {
    let fixture = Fixture::new();
    fixture.package_with(&[(
        "agents.d/cursor.json",
        include_str!("../agents.d/cursor.json"),
    )]);
    let path = fixture.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let hook = fixture.data.join(if cfg!(windows) {
        "hooks/cursor-loongsuite-pilot-hook.ps1"
    } else {
        "hooks/cursor-loongsuite-pilot-hook.sh"
    });
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "owned hook asset").unwrap();
    fs::write(
        fixture.data.join("pilot-bin"),
        "owned shared runtime binding",
    )
    .unwrap();
    let user = json!({"command":"keep-user-hook", "timeout":17, "metadata":{"keep":true}});
    let command = if cfg!(windows) {
        format!(
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
            hook.display()
        )
    } else {
        loongsuite_pilot::hooks::quote_claude_hook_path(&hook.to_string_lossy())
    };
    let original = json!({"private":"synthetic-private-config", "hooks":{
        "afterAgentResponse":[user.clone(),{"command":command}]
    }})
    .to_string();
    fs::write(&path, &original).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let config = fs::read(fixture.data.join("config.json")).unwrap();
    let mut options = json!({"dataDir":fixture.data,"pilotDir":fixture.candidate,"checkOnly":true});
    success(&fixture.helper("cleanup-agents", &options, true));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(!fixture.data.join(".hook-install").exists());
    options["checkOnly"] = json!(false);
    for _ in 0..2 {
        let output = fixture.helper("cleanup-agents", &options, true);
        success(&output);
        for stream in [&output.stdout, &output.stderr] {
            assert!(!String::from_utf8_lossy(stream).contains("synthetic-private-config"));
        }
        let result: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(result["hooks"]["afterAgentResponse"], json!([user.clone()]));
        assert_eq!(result["private"], "synthetic-private-config");
        assert_eq!(fs::read_to_string(&hook).unwrap(), "owned hook asset");
        assert_eq!(
            fs::read_to_string(fixture.data.join("pilot-bin")).unwrap(),
            "owned shared runtime binding"
        );
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
    }
}

#[test]
fn native_uninstall_rejects_invalid_or_unknown_deployment_state_before_config_changes() {
    for state in [
        "private-invalid-state",
        r#"{"removed-agent":{"deployMode":"hook","deployedAt":"old"}}"#,
    ] {
        let fixture = Fixture::new();
        fixture.package_with(&[(
            "agents.d/cursor.json",
            include_str!("../agents.d/cursor.json"),
        )]);
        let path = fixture.root.path().join(".cursor/hooks.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"hooks":{"afterAgentResponse":[{"command":"keep-user-hook"}]}}"#,
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let state_path = fixture.data.join("deployed-agents.json");
        fs::write(&state_path, state).unwrap();
        let result = fixture.helper(
            "cleanup-agents",
            &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}),
            true,
        );
        assert!(!result.status.success());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_to_string(&state_path).unwrap(), state);
        assert!(!fixture.data.join(".hook-install").exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("private-invalid-state"));
    }
}

#[test]
fn native_uninstall_uses_persisted_dsh_path_and_preserves_assets_on_conflict() {
    let fixture = Fixture::new();
    fixture.package_with(&[("agents.d/dsh.json", include_str!("../agents.d/dsh.json"))]);
    let plugin = fixture.data.join("plugins/dsh/plugin.mjs");
    fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    fs::write(&plugin, "fixture host plugin").unwrap();
    fs::write(
        plugin.parent().unwrap().join(".collection-enabled"),
        "enabled",
    )
    .unwrap();
    let patch = fixture
        .root
        .path()
        .join("persisted DSH 研发/cordis.patch.yml");
    fs::create_dir_all(patch.parent().unwrap()).unwrap();
    fs::write(
        &patch,
        "# BEGIN PILOT-OBSERVABILITY-MANAGED\n# entryId=loongsuite-pilot-observability\n",
    )
    .unwrap();
    fs::write(
        fixture.data.join("deployed-agents.json"),
        json!({"dsh":{
            "deployMode":"dsh-yaml-patch","deployedAt":"old","dshPatchPath":patch
        }})
        .to_string(),
    )
    .unwrap();
    let options = json!({"dataDir":fixture.data,"pilotDir":fixture.candidate});
    let before = fs::read(&patch).unwrap();
    let result = fixture.helper("cleanup-agents", &options, true);
    assert!(!result.status.success());
    assert_eq!(fs::read(&patch).unwrap(), before);
    assert!(plugin.is_file());
    let source = reqwest::Url::from_file_path(&plugin).unwrap();
    let hash = loongsuite_pilot::utils::runtime_paths::sha256_file(&plugin).unwrap();
    fs::write(&patch, format!("user: keep\r\n# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: false)\r\n# entryId=loongsuite-pilot-observability\r\n# pluginSource={source}\r\n# pluginHash={hash}\r\ninjected: true\r\n# END PILOT-OBSERVABILITY-MANAGED\r\nother: keep\r\n")).unwrap();
    success(&fixture.helper("cleanup-agents", &options, true));
    assert_eq!(
        fs::read_to_string(&patch).unwrap(),
        "user: keep\r\nother: keep\r\n"
    );
    assert!(plugin.is_file());
    success(&fixture.helper("cleanup-agents", &options, true));
}

#[test]
fn native_uninstall_refuses_unrecognized_owned_commands_without_dropping_state_or_assets() {
    let fixture = Fixture::new();
    fixture.package_with(&[(
        "agents.d/cursor.json",
        include_str!("../agents.d/cursor.json"),
    )]);
    let config = fixture.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let hook = fixture.data.join(if cfg!(windows) {
        "hooks/cursor-loongsuite-pilot-hook.ps1"
    } else {
        "hooks/cursor-loongsuite-pilot-hook.sh"
    });
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "owned-hook-asset").unwrap();
    fs::write(fixture.data.join("pilot-bin"), "shared-runtime").unwrap();
    let before = json!({"hooks":{"afterAgentResponse":[{
        "command":format!("\\\"{}\\\" unexpected-custom-argument",hook.display())
    }]}})
    .to_string();
    fs::write(&config, &before).unwrap();
    let state_path = fixture.data.join("deployed-agents.json");
    let state =
        json!({"cursor":{"deployMode":"hook","deployedAt":"old","hookSettingsPath":config}})
            .to_string();
    fs::write(&state_path, &state).unwrap();
    let output = fixture.helper(
        "cleanup-agents",
        &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}),
        true,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unrecognized Pilot Hook reference"));
    assert_eq!(fs::read_to_string(&config).unwrap(), before);
    assert_eq!(fs::read_to_string(&state_path).unwrap(), state);
    assert_eq!(fs::read_to_string(&hook).unwrap(), "owned-hook-asset");
    assert_eq!(
        fs::read_to_string(fixture.data.join("pilot-bin")).unwrap(),
        "shared-runtime"
    );
}

#[test]
fn native_uninstall_keeps_foreign_plugin_specs_and_jsonc_bytes_for_all_flat_hosts() {
    for (id, source, relative, key) in [
        (
            "opencode",
            include_str!("../agents.d/opencode.json"),
            "plugins/opencode/plugin.mjs",
            "plugin",
        ),
        (
            "mimo-code",
            include_str!("../agents.d/mimo-code.json"),
            "plugins/mimo-code/plugin.mjs",
            "plugin",
        ),
        (
            "pi-coding-agent",
            include_str!("../agents.d/pi-coding-agent.json"),
            "plugins/pi-coding-agent/index.mjs",
            "extensions",
        ),
    ] {
        let fixture = Fixture::new();
        let config = fixture.root.path().join("配置 host/settings.jsonc");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        let mut definition: Value = serde_json::from_str(source).unwrap();
        definition["pluginInject"]["configPaths"] = json!([config]);
        let file = format!("agents.d/{id}.json");
        let contents = definition.to_string();
        fixture.package_with(&[(&file, &contents)]);
        let own = fixture.data.join(relative);
        let foreign = fixture.root.path().join("another install").join(relative);
        let spec = |path: &Path| {
            if id == "pi-coding-agent" {
                path.to_string_lossy().into_owned()
            } else {
                reqwest::Url::from_file_path(path).unwrap().to_string()
            }
        };
        let foreign = spec(&foreign);
        fs::write(
            &config,
            format!(
                "// keep-heading\n{{\n  \"setting\": 1.0,\n  \"{key}\": {}\n}}\n",
                json!(["user-package@1", spec(&own), foreign.clone()])
            ),
        )
        .unwrap();
        for _ in 0..2 {
            success(&fixture.helper(
                "cleanup-agents",
                &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}),
                true,
            ));
            let text = fs::read_to_string(&config).unwrap();
            assert!(text.contains("// keep-heading") && text.contains("\"setting\": 1.0"));
            let data = loongsuite_pilot::utils::parse_json_document(
                &text,
                loongsuite_pilot::utils::JsonSyntax::Jsonc,
            )
            .unwrap();
            assert_eq!(
                data[key],
                json!(["user-package@1", foreign.clone()]),
                "{id}"
            );
        }
    }
}

#[tokio::test]
async fn native_uninstall_removes_only_directory_plugins_owned_by_the_current_install() {
    use loongsuite_pilot::types::{AgentDefinition, DeployStrategy};
    for other_owner in [false, true] {
        let fixture = Fixture::new();
        let source = fixture.root.path().join("插件来源");
        let target = fixture
            .root
            .path()
            .join("Hermes home/plugins/loongsuite-pilot");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("__init__.py"), "fixture = True\n").unwrap();
        let mut definition: Value =
            serde_json::from_str(include_str!("../agents.d/hermes-agent.json")).unwrap();
        definition["directoryPlugin"]["sourceDir"] = json!(source);
        definition["directoryPlugin"]["targetDir"] = json!(target);
        definition["directoryPlugin"]["activation"] = Value::Null;
        let text = definition.to_string();
        fixture.package_with(&[("agents.d/hermes-agent.json", &text)]);
        let owner = if other_owner {
            fixture.root.path().join("other-data")
        } else {
            fixture.data.clone()
        };
        let definition: AgentDefinition = serde_json::from_value(definition).unwrap();
        let strategy = loongsuite_pilot::deployment::DirectoryPluginStrategy::new(Some(
            owner.to_string_lossy().into_owned(),
        ));
        let deployed = strategy.deploy(&definition).await;
        assert!(deployed.success, "{:?}", deployed.error);
        let marker = target.join(".loongsuite-pilot-managed.json");
        let before = fs::read(&marker).unwrap();
        let options = json!({"dataDir":fixture.data,"pilotDir":fixture.candidate});
        let output = fixture.helper("cleanup-agents", &options, true);
        assert_eq!(output.status.success(), !other_owner);
        assert_eq!(target.exists(), other_owner);
        if other_owner {
            assert_eq!(fs::read(&marker).unwrap(), before);
            assert_eq!(
                fs::read_to_string(target.join("__init__.py")).unwrap(),
                "fixture = True\n"
            );
        } else {
            success(&fixture.helper("cleanup-agents", &options, true));
        }
        assert_eq!(
            fs::read_to_string(source.join("__init__.py")).unwrap(),
            "fixture = True\n"
        );
    }
}

#[test]
fn native_uninstall_openclaw_preserves_other_install_paths_and_shared_entries() {
    let fixture = Fixture::new();
    let config = fixture.root.path().join("OpenClaw home/openclaw.jsonc");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let mut definition: Value =
        serde_json::from_str(include_str!("../agents.d/openclaw.json")).unwrap();
    definition["pluginInject"]["configPaths"] = json!([config]);
    let text = definition.to_string();
    fixture.package_with(&[("agents.d/openclaw.json", &text)]);
    let own = reqwest::Url::from_file_path(fixture.data.join("plugins/openclaw"))
        .unwrap()
        .to_string();
    let foreign =
        reqwest::Url::from_file_path(fixture.root.path().join("other-data/plugins/openclaw"))
            .unwrap()
            .to_string();
    let entry = json!({"enabled":true,"config":{"keep":"user-option"}});
    fs::write(
        &config,
        json!({"user":"keep","plugins":{
            "load":{"paths":[own,foreign.clone()]},
            "entries":{"loongsuite-pilot-openclaw":entry.clone(),"user-plugin":{"enabled":true}}
        }})
        .to_string(),
    )
    .unwrap();
    for _ in 0..2 {
        success(&fixture.helper(
            "cleanup-agents",
            &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}),
            true,
        ));
        let result: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(result["plugins"]["load"]["paths"], json!([foreign.clone()]));
        assert_eq!(
            result["plugins"]["entries"]["loongsuite-pilot-openclaw"],
            entry
        );
        assert_eq!(result["plugins"]["entries"]["user-plugin"]["enabled"], true);
        assert_eq!(result["user"], "keep");
    }
}

#[cfg(unix)]
#[test]
fn native_uninstall_shell_preserves_conflicts_and_cleans_custom_cache_without_external_runtimes() {
    for scenario in [
        "keep-data",
        "purge",
        "invalid-state",
        "missing-current",
        "unknown-hook",
    ] {
        let fixture = Fixture::new();
        fixture.package_with(&[(
            "agents.d/cursor.json",
            include_str!("../agents.d/cursor.json"),
        )]);
        let cache = fixture.root.path().join("cache");
        let installed = cache.join("versions/1.2.0_test");
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::rename(&fixture.candidate, &installed).unwrap();
        if scenario != "missing-current" {
            fs::write(cache.join("current"), "1.2.0_test\n").unwrap();
        }
        let default_cache = fixture.root.path().join(".loongsuite-pilot/versions");
        fs::create_dir_all(&default_cache).unwrap();
        fs::write(default_cache.join("foreign-install"), "keep").unwrap();
        let hook = fixture.data.join("hooks/cursor-loongsuite-pilot-hook.sh");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "keep until cleanup succeeds").unwrap();
        let hook_config = fixture.root.path().join(".cursor/hooks.json");
        fs::create_dir_all(hook_config.parent().unwrap()).unwrap();
        let own_command = loongsuite_pilot::hooks::quote_claude_hook_path(&hook.to_string_lossy());
        let command = if scenario == "unknown-hook" {
            format!("{own_command} --unrecognized-argument")
        } else {
            own_command
        };
        let original = json!({"private":"keep-private-config","hooks":{"afterAgentResponse":[
            {"command":"keep-user-hook"},{"command":command}
        ]}})
        .to_string();
        fs::write(&hook_config, &original).unwrap();
        if scenario == "invalid-state" {
            fs::write(
                fixture.data.join("deployed-agents.json"),
                "private-corrupt-state",
            )
            .unwrap();
        }
        let config = fs::read(fixture.data.join("config.json")).unwrap();
        let source = include_str!("../deploy/installer-opensource.sh");
        let mut script = String::from("set -euo pipefail\n");
        for name in [
            "native_installer_helper",
            "prepare_native_uninstall",
            "cleanup_native_agents",
            "cmd_uninstall",
        ] {
            script.push_str(&function(source, &format!("{name}() {{")));
        }
        script.push_str(
            r#"
msg() { :; }
loongsuite-pilot() { printf 'stopped' > "$HOME/stop-marker"; }
remove_qodercli_token_intercept() { :; }
remove_qoderclicn_token_intercept() { :; }
retire_qoderwork_runtime_overrides() { :; }
remove_claude_code_fetch_intercept() { :; }
rm() {
    for item in "$@"; do
        case "$item" in
            -*) ;;
            "$HOME"/*) ;;
            /usr/local/bin/loongsuite-pilot) return 0 ;;
            *) return 88 ;;
        esac
    done
    /bin/rm "$@"
}
PACKAGE_NAME=fixture
INSTALL_SRC=""
PACKAGE_URL=""
cmd_uninstall
"#,
        );
        let path = fixture.root.path().join("uninstall.sh");
        fs::write(&path, script).unwrap();
        let mut command = fixture.command(Path::new("/bin/bash"));
        command
            .arg(path)
            .env("DATA_DIR", &fixture.data)
            .env("PURGE", if scenario == "purge" { "1" } else { "0" });
        let output = bounded(command);
        let clean = matches!(scenario, "keep-data" | "purge");
        assert_eq!(
            output.status.success(),
            clean,
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fixture.root.path().join("stop-marker").exists(),
            !matches!(scenario, "invalid-state" | "missing-current")
        );
        assert_eq!(installed.exists(), !clean);
        assert_eq!(
            cache.join("current").exists(),
            !clean && scenario != "missing-current"
        );
        assert_eq!(
            fs::read_to_string(default_cache.join("foreign-install")).unwrap(),
            "keep"
        );
        if clean {
            let data: Value = serde_json::from_slice(&fs::read(&hook_config).unwrap()).unwrap();
            assert_eq!(
                data["hooks"]["afterAgentResponse"],
                json!([{"command":"keep-user-hook"}])
            );
            assert_eq!(data["private"], "keep-private-config");
            if scenario == "purge" {
                assert!(!fixture.data.exists());
            } else {
                assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
            }
        } else {
            assert_eq!(fs::read_to_string(&hook_config).unwrap(), original);
            assert_eq!(
                fs::read_to_string(&hook).unwrap(),
                "keep until cleanup succeeds"
            );
        }
        for stream in [&output.stdout, &output.stderr] {
            assert!(!String::from_utf8_lossy(stream).contains("private-corrupt-state"));
        }
    }
}

#[test]
fn native_uninstall_path_arguments_and_json_protocol_have_the_same_readonly_boundary() {
    let fixture = Fixture::new();
    fixture.package();
    let before = fs::read(fixture.data.join("config.json")).unwrap();
    let mut command = fixture.command(&fixture.binary);
    command
        .args([
            "installer-helper",
            "cleanup-agents",
            "--check-only",
            "--data-dir",
        ])
        .arg(&fixture.data)
        .arg("--pilot-dir")
        .arg(&fixture.candidate);
    success(&bounded(command));
    assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), before);
    assert_eq!(fs::read_dir(&fixture.data).unwrap().count(), 1);
    for unsafe_data in [
        fixture.root.path(),
        fixture.root.path().ancestors().last().unwrap(),
    ] {
        let mut command = fixture.command(&fixture.binary);
        command
            .args(["installer-helper", "cleanup-agents", "--data-dir"])
            .arg(unsafe_data)
            .arg("--pilot-dir")
            .arg(&fixture.candidate);
        assert_eq!(bounded(command).status.code(), Some(1));
        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), before);
    }
    let mut conflict = fixture.command(&fixture.binary);
    conflict
        .args([
            "installer-helper",
            "cleanup-agents",
            "--input-env",
            "--data-dir",
        ])
        .arg(&fixture.data)
        .env("LOONGSUITE_PILOT_INSTALL_INPUT", "{}");
    assert_eq!(bounded(conflict).status.code(), Some(2));
    assert_eq!(fs::read_dir(&fixture.data).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn native_uninstall_windows_bridge_preserves_preflight_failures_and_cleans_without_node_python() {
    for shell in windows_shells() {
        for constrained in [false, true] {
            for scenario in ["keep-data", "purge", "invalid-state"] {
                let fixture = Fixture::new();
                fixture.package_with(&[(
                    "agents.d/cursor.json",
                    include_str!("../agents.d/cursor.json"),
                )]);
                let cache = fixture.root.path().join("cache");
                let installed = cache.join("versions/1.2.0_test");
                fs::create_dir_all(installed.parent().unwrap()).unwrap();
                fs::rename(&fixture.candidate, &installed).unwrap();
                fs::write(cache.join("current"), "1.2.0_test\n").unwrap();
                let hook = fixture.data.join("hooks/cursor-loongsuite-pilot-hook.ps1");
                fs::create_dir_all(hook.parent().unwrap()).unwrap();
                fs::write(&hook, "keep until cleanup succeeds").unwrap();
                let hook_config = fixture.root.path().join(".cursor/hooks.json");
                fs::create_dir_all(hook_config.parent().unwrap()).unwrap();
                let original=json!({"private":"keep-private-config","hooks":{"afterAgentResponse":[
                    {"command":"keep-user-hook"},
                    {"command":format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",hook.display())}
                ]}}).to_string();
                fs::write(&hook_config, &original).unwrap();
                if scenario == "invalid-state" {
                    fs::write(
                        fixture.data.join("deployed-agents.json"),
                        "private-corrupt-state",
                    )
                    .unwrap();
                }
                let config = fs::read(fixture.data.join("config.json")).unwrap();
                let mut script = windows_script(
                    constrained,
                    &[
                        "Invoke-InstallerHelper",
                        "Resolve-NativeUninstallSource",
                        "Invoke-NativeUninstall",
                        "ConvertTo-ExtendedLengthPath",
                        "Assert-SafePilotDirectory",
                        "Remove-PilotPath",
                        "Remove-PilotInstallationFiles",
                        "Cmd-Uninstall",
                    ],
                );
                script.push_str(r#"
function Msg { param($Chinese,$English) }
function Stop-PilotService { 'stopped' | Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'stop-marker') }
function Remove-PilotScheduledTasks { }
function Get-PilotRuntimeOverride { param($Name); return '' }
function Remove-PilotRuntimeOverride { throw 'must not remove an unrelated override' }
$PACKAGE_NAME='fixture'
$DataDir=$env:TEST_DATA
$CACHE_DIR=$env:LOONGSUITE_PILOT_CACHE_DIR
$script:INSTALL_SRC=''
$PackageUrl=''
$Purge=$env:TEST_SCENARIO -eq 'purge'
Cmd-Uninstall
"#);
                let mut command = windows_command(&fixture, &shell, &script);
                command.env("TEST_SCENARIO", scenario);
                let output = bounded(command);
                let clean = scenario != "invalid-state";
                assert_eq!(
                    output.status.success(),
                    clean,
                    "{scenario} constrained={constrained} {}: {}",
                    shell.display(),
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(fixture.root.path().join("stop-marker").exists(), clean);
                assert_eq!(installed.exists(), !clean);
                if clean {
                    let data: Value =
                        serde_json::from_slice(&fs::read(&hook_config).unwrap()).unwrap();
                    assert_eq!(
                        data["hooks"]["afterAgentResponse"],
                        json!([{"command":"keep-user-hook"}])
                    );
                    assert_eq!(data["private"], "keep-private-config");
                    if scenario == "purge" {
                        assert!(!fixture.data.exists());
                    } else {
                        assert_eq!(fs::read(fixture.data.join("config.json")).unwrap(), config);
                    }
                } else {
                    assert_eq!(fs::read_to_string(&hook_config).unwrap(), original);
                    assert_eq!(
                        fs::read_to_string(&hook).unwrap(),
                        "keep until cleanup succeeds"
                    );
                }
                for stream in [&output.stdout, &output.stderr] {
                    assert!(!String::from_utf8_lossy(stream).contains("private-corrupt-state"));
                }
            }
        }
    }
}

#[test]
fn native_uninstall_cleans_recorded_and_all_existing_alternative_configuration_paths() {
    for mode in ["hook", "plugin"] {
        let fixture = Fixture::new();
        let paths: Vec<_> = (0..3)
            .map(|index| {
                fixture
                    .root
                    .path()
                    .join(format!("agent-home-{index}/hooks.json"))
            })
            .collect();
        for path in &paths {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        let (id, file, source) = if mode == "hook" {
            (
                "cursor",
                "agents.d/cursor.json",
                include_str!("../agents.d/cursor.json"),
            )
        } else {
            (
                "opencode",
                "agents.d/opencode.json",
                include_str!("../agents.d/opencode.json"),
            )
        };
        let mut definition: Value = serde_json::from_str(source).unwrap();
        if mode == "hook" {
            definition["hook"]["settingsPath"] = json!(paths[0]);
        } else {
            definition["pluginInject"]["configPaths"] = json!([paths[0], paths[1]]);
        }
        let definition = definition.to_string();
        fixture.package_with(&[(file, &definition)]);
        let record = if mode == "hook" {
            json!({"deployMode":"hook","deployedAt":"old","hookSettingsPath":paths[2]})
        } else {
            json!({"deployMode":"plugin-inject","deployedAt":"old","pluginInjectConfigPath":paths[2]})
        };
        let selected: Vec<_> = if mode == "hook" {
            vec![&paths[0], &paths[2]]
        } else {
            paths.iter().collect()
        };
        for path in &selected {
            let value = if mode == "hook" {
                let hook = fixture.data.join(if cfg!(windows) {
                    "hooks/cursor-loongsuite-pilot-hook.ps1"
                } else {
                    "hooks/cursor-loongsuite-pilot-hook.sh"
                });
                let own = if cfg!(windows) {
                    format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",hook.display())
                } else {
                    loongsuite_pilot::hooks::quote_claude_hook_path(&hook.to_string_lossy())
                };
                json!({"private":"keep","hooks":{"afterAgentResponse":[{"command":own},{"command":"keep-user-hook"}]}})
            } else {
                let own =
                    reqwest::Url::from_file_path(fixture.data.join("plugins/opencode/plugin.mjs"))
                        .unwrap()
                        .to_string();
                json!({"private":"keep","plugin":[own,"user-plugin@1"]})
            };
            fs::write(path, value.to_string()).unwrap();
        }
        fs::write(
            fixture.data.join("deployed-agents.json"),
            json!({id:record}).to_string(),
        )
        .unwrap();
        let output = fixture.helper(
            "cleanup-agents",
            &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate}),
            true,
        );
        success(&output);
        for path in selected {
            let data: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(data["private"], "keep");
            if mode == "hook" {
                assert_eq!(
                    data["hooks"]["afterAgentResponse"],
                    json!([{"command":"keep-user-hook"}])
                );
            } else {
                assert_eq!(data["plugin"], json!(["user-plugin@1"]));
            }
        }
    }
}

#[test]
fn native_uninstall_rejects_invalid_local_overrides_while_discovery_keeps_builtin_fallbacks() {
    for invalid in [
        "private-invalid-override",
        r#"{"id":"cursor","displayName":"private-invalid-override","deployMode":"unknown","detection":{}}"#,
        r#"{"id":"cursor","displayName":"private-invalid-override","deployMode":"hook","detection":{"paths":3}}"#,
    ] {
        let fixture = Fixture::new();
        fixture.package_with(&[(
            "agents.d/cursor.json",
            include_str!("../agents.d/cursor.json"),
        )]);
        let local = fixture.data.join("agents.d.local/cursor.json");
        fs::create_dir_all(local.parent().unwrap()).unwrap();
        fs::write(&local, invalid).unwrap();
        let hook = fixture.data.join(if cfg!(windows) {
            "hooks/cursor-loongsuite-pilot-hook.ps1"
        } else {
            "hooks/cursor-loongsuite-pilot-hook.sh"
        });
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "preserve helper asset").unwrap();
        let own = if cfg!(windows) {
            format!(
                "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
                hook.display()
            )
        } else {
            loongsuite_pilot::hooks::quote_claude_hook_path(&hook.to_string_lossy())
        };
        let config = fixture.root.path().join(".cursor/hooks.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        let original = json!({"hooks":{"afterAgentResponse":[{"command":own}]}}).to_string();
        fs::write(&config, &original).unwrap();
        let mut probe = fixture.command(&fixture.binary);
        probe.args(["probe", "--installer", "--list"]);
        let output = bounded(probe);
        success(&output);
        let detected: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(detected
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["id"] == "cursor"));
        for check_only in [true, false] {
            let output=fixture.helper("cleanup-agents",
                &json!({"dataDir":fixture.data,"pilotDir":fixture.candidate,"checkOnly":check_only}),true);
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(fs::read_to_string(&config).unwrap(), original);
            assert_eq!(fs::read_to_string(&hook).unwrap(), "preserve helper asset");
            assert_eq!(fs::read_to_string(&local).unwrap(), invalid);
            assert!(!fixture.data.join("deployed-agents.json").exists());
            for stream in [&output.stdout, &output.stderr] {
                assert!(!String::from_utf8_lossy(stream).contains("private-invalid-override"));
            }
        }
    }
}

#[test]
fn first_native_install_publishes_command_before_owned_legacy_cleanup_and_preserves_foreign_shadow()
{
    for mode in ["owned", "foreign", "preflight-failure"] {
        let fixture = Fixture::new();
        fixture.package();
        let bin = fixture.root.path().join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let legacy = bin.join("loongsuite-pilot.ps1");
        let mut official = Vec::new();
        flate2::read::GzDecoder::new(
            &include_bytes!("fixtures/updater/official-v1-windows-cli.ps1.gz")[..],
        )
        .read_to_end(&mut official)
        .unwrap();
        let bytes = if mode == "foreign" {
            b"Write-Output 'user-owned command'\n".to_vec()
        } else {
            official
        };
        fs::write(&legacy, &bytes).unwrap();
        if mode == "preflight-failure" {
            fs::write(
                fixture.candidate.join("scripts/loongsuite-pilot.ps1"),
                b"changed after manifest",
            )
            .unwrap();
        }
        let output = fixture.helper(
            "sync-service",
            &fixture.runtime_options(&fixture.candidate),
            true,
        );
        if mode == "preflight-failure" {
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(fs::read(&legacy).unwrap(), bytes);
            assert!(!bin.join("loongsuite-pilot-layout.json").exists());
            continue;
        }
        success(&output);
        let layout: Value =
            serde_json::from_slice(&fs::read(bin.join("loongsuite-pilot-layout.json")).unwrap())
                .unwrap();
        assert_eq!(layout["cacheDir"], json!(fixture.root.path().join("cache")));
        assert_eq!(layout["dataDir"], json!(fixture.data));
        #[cfg(windows)]
        {
            let service = fs::read(bin.join("loongsuite-pilot-service.ps1")).unwrap();
            assert!(service.starts_with(b"\xef\xbb\xbf"));
            assert!(fs::read_to_string(bin.join("loongsuite-pilot.cmd"))
                .unwrap()
                .contains("-File \"%~dp0loongsuite-pilot-service.ps1\" %*"));
            if mode == "owned" {
                assert!(!legacy.exists());
            } else {
                assert_eq!(fs::read(&legacy).unwrap(), bytes);
            }
            let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut command = fixture.command(&shell);
            let quoted = bin.to_str().unwrap().replace('\'', "''");
            command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                &format!("$env:PATH='{quoted}'; $PSModuleAutoLoadingPreference='None'; $c=$ExecutionContext.SessionState.InvokeCommand.GetCommand('loongsuite-pilot',[System.Management.Automation.CommandTypes]::All); if ($null -eq $c -or $c -is [array] -or [string]::IsNullOrEmpty([string]$c.Path)) {{ throw 'Expected one external command resolution' }}; [Console]::Write([string]$c.Path)")]);
            let resolution = bounded(command);
            success(&resolution);
            let resolved = PathBuf::from(String::from_utf8(resolution.stdout).unwrap().trim());
            assert_eq!(
                resolved,
                if mode == "owned" {
                    bin.join("loongsuite-pilot.cmd")
                } else {
                    legacy
                }
            );
        }
        #[cfg(not(windows))]
        {
            // Unix never had PowerShell command-name precedence. The actual
            // installer must publish its native entrypoint and retain this file.
            assert!(bin.join("loongsuite-pilot").is_file());
            assert_eq!(fs::read(&legacy).unwrap(), bytes);
        }
    }
}

#[path = "native_contracts/cross_version_upgrade.rs"]
mod cross_version_upgrade;
