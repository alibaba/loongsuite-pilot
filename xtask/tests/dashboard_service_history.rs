//! Dashboard lifecycle contracts on real private processes, without services.
#![cfg(unix)]
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
const SHELL: &str = include_str!("../../scripts/loongsuite-pilot.sh");
fn section(start: &str, end: &str) -> &'static str {
    SHELL
        .split_once(start)
        .unwrap()
        .1
        .split_once(end)
        .unwrap()
        .0
}
fn success(out: &Output) {
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
fn bounded(mut command: Command) -> Output {
    let root = tempfile::tempdir().unwrap();
    let out = root.path().join("stdout");
    let err = root.path().join("stderr");
    command
        .stdout(fs::File::create(&out).unwrap())
        .stderr(fs::File::create(&err).unwrap());
    let mut child = command.spawn().unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("private Dashboard shell exceeded 15s command budget");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Output {
        status,
        stdout: fs::read(out).unwrap(),
        stderr: fs::read(err).unwrap(),
    }
}
// Concurrent test processes can briefly inherit a copied executable's writer.
// Retry only ETXTBSY; all other spawn errors remain immediate failures.
fn spawn_with_writer_retry(command: &mut Command, deadline: Instant) -> std::io::Result<Child> {
    loop {
        match command.spawn() {
            Err(error) if error.raw_os_error() == Some(26) && Instant::now() < deadline => {
                std::thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            result => return result,
        }
    }
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    script: PathBuf,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("用户 O'Brien [生命周期]🚀");
        let data = home.join("private-data");
        let cache = home.join("private-cache");
        let root = cache.join("versions/test");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(cache.join("current"), "test\n").unwrap();
        fs::write(root.join("runtime-manifest.json"), "{}").unwrap();
        let binary = root.join("bin/loongsuite-pilot");
        fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
        let script = home.join("service.sh");
        fs::write(&script, SHELL).unwrap();
        Self {
            _temp: temp,
            home,
            data,
            cache,
            script,
            binary,
        }
    }
    fn command(&self) -> Command {
        let mut c = Command::new("/bin/bash");
        c.env_clear()
            .current_dir(&self.home)
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin")
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
            .stdin(Stdio::null());
        c
    }
    fn function(&self, name: &str, args: &[&str]) -> Output {
        let mut command = self.command();
        command
            .args(["-c", "source \"$1\"; shift; \"$@\"", "private"])
            .arg(&self.script)
            .arg(name)
            .args(args);
        bounded(command)
    }
    fn body(&self, body: &str) -> Output {
        let mut command = self.command();
        command
            .args(["-c", "source \"$1\"; eval \"$2\"", "private"])
            .arg(&self.script)
            .arg(body);
        bounded(command)
    }
    fn spawn(&self, binary: &Path, args: &[&str], data: &Path) -> Process {
        let log = self.home.join(format!(
            "child-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut c = Command::new(binary);
        c.args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("LOONGSUITE_PILOT_DATA_DIR", data)
            .env("PILOT_FIXTURE_MODE", "wait")
            .env("PILOT_FIXTURE_LOG", &log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let deadline = Instant::now() + Duration::from_secs(1);
        let child = spawn_with_writer_retry(&mut c, deadline).unwrap();
        let mut process = Process(child);
        let start = Instant::now();
        while !log.exists() {
            assert!(process.0.try_wait().unwrap().is_none());
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        process
    }
}
#[test]
fn dashboard_l21_no_removed_monitor_dispatch_and_l27_cleanup_precedes_start_stop_restart_work() {
    let dispatch = SHELL.split_once("cmd_help()").unwrap().1;
    assert!(!dispatch.contains("monitor start") && !dispatch.contains("monitor stop"));
    assert!(!dispatch
        .lines()
        .any(|line| line.trim_start().starts_with("monitor)")));
    for name in ["cmd_start", "cmd_stop", "cmd_restart_collector"] {
        let start = SHELL.split_once(&format!("{name}()")).unwrap().1;
        assert!(
            start
                .lines()
                .take(4)
                .collect::<Vec<_>>()
                .join("\n")
                .contains("cleanup_legacy_monitor_processes"),
            "{name}"
        );
    }
}
#[test]
fn dashboard_l34_legacy_identity_and_l47_reused_argv_are_checked_before_real_signal() {
    let cleanup = section(
        "cleanup_legacy_monitor_process()",
        "updater_process_exists()",
    );
    for expected in [
        "legacy_monitor_process_matches \"$pid\" \"$script_name\"",
        "[ \"${argv_entry##*/}\" = \"$script_name\" ]",
        "[ \"$argv_count\" -eq 2 ]",
        "ps -p \"$pid\" -o uid=",
        "rm -f \"$pid_file\"",
    ] {
        assert!(cleanup.contains(expected), "{expected}");
    }
    assert!(!cleanup.contains("pkill"));
    let f = Fixture::new();
    let node = f.home.join("node");
    fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &node).unwrap();
    for args in [
        vec!["-e", "setInterval", "serve-loongsuite-pilot-monitor.mjs"],
        vec!["unrelated.mjs", "serve-loongsuite-pilot-monitor.mjs"],
        vec!["serve-loongsuite-pilot-monitor.mjs", "extra"],
    ] {
        let mut reused = f.spawn(&node, &args, &f.data);
        let pid = f.home.join("legacy.pid");
        fs::write(&pid, reused.0.id().to_string()).unwrap();
        success(&f.function(
            "cleanup_legacy_monitor_process",
            &[pid.to_str().unwrap(), "serve-loongsuite-pilot-monitor.mjs"],
        ));
        assert!(reused.0.try_wait().unwrap().is_none());
        assert!(!pid.exists());
    }
    let mut owned = f.spawn(
        &node,
        &["/private/serve-loongsuite-pilot-monitor.mjs"],
        &f.data,
    );
    let pid = f.home.join("legacy.pid");
    fs::write(&pid, owned.0.id().to_string()).unwrap();
    success(&f.function(
        "cleanup_legacy_monitor_process",
        &[pid.to_str().unwrap(), "serve-loongsuite-pilot-monitor.mjs"],
    ));
    assert!(!pid.exists());
    let start = Instant::now();
    while owned.0.try_wait().unwrap().is_none() {
        assert!(start.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn dashboard_l74_native_pid_identity_preserves_exact_install_uid_argv_executable_and_atomic_repair_policy(
) {
    let lookup = section("process_matches_installed_entry()", "is_pid_file_running()");
    for expected in [
        "[ -r \"/proc/$pid/status\" ]",
        "done < \"/proc/$pid/status\"",
        "[ -r \"/proc/$pid/cmdline\" ]",
        "[ \"$argv_entry\" = \"$expected_entry\" ]",
        "ps -U \"$current_user_id\" -o pid= -o ucomm=",
        "find_current_user_processes collector",
        "find_current_user_collector_processes()",
        "process_matches_installed_entry \"$pid\" collector",
        "mv -f \"$pid_tmp\" \"$PID_FILE\"",
        "installed_native_entry \"$argv0\"",
        "[ \"/proc/$pid/exe\" -ef \"$argv0\" ]",
        "done < \"/proc/$pid/environ\"",
    ] {
        assert!(lookup.contains(expected), "{expected}");
    }
    assert!(!lookup.contains("pgrep") && !lookup.contains("pkill"));
}
#[test]
fn dashboard_l96_stop_rechecks_exact_collectors_and_wrappers_for_five_short_attempts() {
    let helper = section(
        "stop_installed_collector_processes()",
        "is_pid_file_running()",
    );
    for expected in [
        "find_current_user_collector_processes",
        "process_matches_installed_entry \"$pid\" \"$kind\"",
        "for attempt in 1 2 3 4 5",
    ] {
        assert!(helper.contains(expected), "{expected}");
    }
    assert!(!helper.contains("find_current_user_processes collector-wrapper"));
    assert!(!helper.contains("find_current_user_processes collector |"));
    let stop = section("cmd_stop()", "cmd_restart_collector()");
    for expected in [
        "stop_installed_collector_processes",
        "stop_pid_file \"$PID_FILE\" collector",
        "stop_pid_file \"$UPDATER_PID_FILE\" updater",
    ] {
        assert!(stop.contains(expected), "{expected}");
    }
    assert!(section("cmd_restart_collector()", "cmd_restart_updater()")
        .contains("stop_pid_file \"$PID_FILE\" collector"));
    assert!(!SHELL.contains("pkill -f \"loongsuite-pilot/bin/collector-daemon\""));
    assert!(!SHELL.contains("pkill -f \"loongsuite-pilot/bin/updater-daemon\""));
    let f = Fixture::new();
    let foreign = Fixture::new();
    let mut owned = f.spawn(&f.binary, &["run"], &f.data);
    let mut other = foreign.spawn(&foreign.binary, &["run"], &foreign.data);
    let wrapper = f.home.join(".local/bin/loongsuite-pilot");
    fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
    fs::write(&wrapper, "#!/bin/bash\nprintf ready > \"$HOME/wrapper-ready\"\nwhile :; do read -r -t 1 unused || :; done\n").unwrap();
    let mut command = Command::new("/bin/bash");
    command
        .arg(&wrapper)
        .arg("run")
        .env_clear()
        .env("HOME", &f.home)
        .env("LOONGSUITE_PILOT_DATA_DIR", &f.data)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut wrapper = Process(command.spawn().unwrap());
    let start = Instant::now();
    while !f.home.join("wrapper-ready").exists() {
        assert!(wrapper.0.try_wait().unwrap().is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    success(&f.function("stop_installed_collector_processes", &[]));
    assert!(owned.0.try_wait().unwrap().is_some());
    assert!(wrapper.0.try_wait().unwrap().is_some());
    assert!(other.0.try_wait().unwrap().is_none());
}
#[cfg(target_os = "linux")]
#[test]
fn dashboard_l123_actual_procfs_identity_never_spawns_per_pid_ps() {
    let matcher = section(
        "process_matches_installed_entry()",
        "find_current_user_processes()",
    );
    let branch = matcher
        .split_once("if [ -r \"/proc/$pid/status\" ]")
        .unwrap()
        .1
        .split_once("    else")
        .unwrap()
        .0;
    assert!(branch.contains("done < \"/proc/$pid/status\""));
    assert!(branch.contains("read -r process_name < \"/proc/$pid/comm\""));
    assert!(!branch.contains("ps -p"));
    let f = Fixture::new();
    let current = f.spawn(&f.binary, &["run"], &f.data);
    let body=format!("function ps {{ printf forbidden > \"$HOME/forbidden-ps\"; return 99; }}\nprocess_matches_installed_entry {} collector",current.0.id());
    success(&f.body(&body));
    assert!(!f.home.join("forbidden-ps").exists());
}
#[test]
fn dashboard_l136_start_only_recovery_never_stops_or_scans_processes() {
    let start = section("cmd_start_collector()", "# Restart only the collector");
    assert!(start.contains("start_collector_after_stop"));
    assert!(
        !start.contains("stop_pid_file") && !start.contains("stop_installed_collector_processes")
    );
    assert!(SHELL
        .split_once("# ---- Dispatch ----")
        .unwrap()
        .1
        .contains("start-collector)"));
    let f = Fixture::new();
    for running in [false, true] {
        let body = format!(
            r#"
function is_running {{ {running}; }}
function start_collector_after_stop {{ printf start >> "$HOME/calls"; }}
function stop_pid_file {{ return 99; }}
function stop_installed_collector_processes {{ return 99; }}
function find_current_user_processes {{ return 99; }}
cmd_start_collector
"#
        );
        if running {
            fs::write(f.data.join("loongsuite-pilot.pid"), "private existing pid").unwrap();
        }
        success(&f.body(&body));
    }
    assert_eq!(fs::read(f.home.join("calls")).unwrap(), b"start");
}
#[cfg(target_os = "linux")]
#[test]
fn dashboard_l149_reused_pid_survives_and_native_current_pid_is_atomically_repaired() {
    let f = Fixture::new();
    let current = f.spawn(&f.binary, &["run"], &f.data);
    let mut reused = f.spawn(&f.binary, &["run", "extra"], &f.data);
    let pid = f.data.join("loongsuite-pilot.pid");
    fs::write(&pid, reused.0.id().to_string()).unwrap();
    success(&f.function("stop_pid_file", &[pid.to_str().unwrap(), "collector"]));
    assert!(reused.0.try_wait().unwrap().is_none());
    fs::write(&pid, reused.0.id().to_string()).unwrap();
    success(&f.function("is_running", &[]));
    assert_eq!(
        fs::read_to_string(&pid).unwrap().trim(),
        current.0.id().to_string()
    );
    assert!(reused.0.try_wait().unwrap().is_none());
    assert!(!fs::read_dir(&f.data).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("loongsuite-pilot.pid.tmp.")));
}
#[cfg(target_os = "linux")]
#[test]
fn dashboard_l196_actual_generated_initd_status_and_stop_preserve_reused_pids_for_both_roles() {
    let user = String::from_utf8(Command::new("id").arg("-un").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string();
    let group = String::from_utf8(Command::new("id").arg("-gn").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string();
    for (start, end, role) in [
        (
            "_write_initd_script()",
            "_write_initd_updater_script()",
            "run",
        ),
        (
            "_write_initd_updater_script()",
            "_register_initd_boot()",
            "run-updater",
        ),
    ] {
        let f = Fixture::new();
        let node = f.home.join("node");
        fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &node).unwrap();
        let log = f.home.join("initd-reused.jsonl");
        let mut c = Command::new(&node);
        c.args(["-e", "setInterval"])
            .env_clear()
            .env("HOME", &f.home)
            .env("PILOT_FIXTURE_MODE", "wait")
            .env("PILOT_FIXTURE_LOG", &log)
            .env("LOONGSUITE_PILOT_INITD_BIN", &f.binary)
            .env("LOONGSUITE_PILOT_INITD_COMMAND", role)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let wait = Instant::now();
        let mut reused =
            Process(spawn_with_writer_retry(&mut c, wait + Duration::from_secs(5)).unwrap());
        while !log.exists() {
            assert!(wait.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid = f.home.join("initd.pid");
        fs::write(&pid, reused.0.id().to_string()).unwrap();
        let template = section(start, end)
            .split_once("<< 'INITEOF'\n")
            .unwrap()
            .1
            .split_once("\nINITEOF")
            .unwrap()
            .0;
        let mut script = template.to_string();
        let logfile = f.home.join("private.log");
        let config = f.home.join("private.json");
        for (key, value) in [
            ("USER_PLACEHOLDER", user.as_str()),
            ("GROUP_PLACEHOLDER", group.as_str()),
            ("HOME_PLACEHOLDER", f.home.to_str().unwrap()),
            ("BIN_PLACEHOLDER", f.binary.to_str().unwrap()),
            ("DAEMON_NAME_PLACEHOLDER", "private-test-daemon"),
            ("PID_PLACEHOLDER", pid.to_str().unwrap()),
            ("LOG_PLACEHOLDER", logfile.to_str().unwrap()),
            ("CONFIG_PLACEHOLDER", config.to_str().unwrap()),
        ] {
            script = script.replace(key, value);
        }
        let entry = f.home.join("generated-initd");
        fs::write(&entry, script).unwrap();
        let mut command = f.command();
        command.arg(&entry).arg("status");
        let status = bounded(command);
        assert_eq!(status.status.code(), Some(1));
        let mut command = f.command();
        command.arg(&entry).arg("stop");
        let stop = bounded(command);
        success(&stop);
        assert!(reused.0.try_wait().unwrap().is_none());
    }
}
#[test]
fn dashboard_l252_both_wrappers_delegate_readonly_probe_and_print_only_validated_url() {
    let unix = section("dashboard_probe()", "cmd_status()");
    for expected in [
        "\"$pilot_bin\" dashboard probe \"$@\"",
        "dashboard_probe --port",
        "dashboard_probe --data-dir",
        "dashboard_probe --available",
    ] {
        assert!(unix.contains(expected), "{expected}");
    }
    let ps = include_str!("../../scripts/loongsuite-pilot.ps1");
    for expected in [
        "function Test-DashboardAvailable",
        "function Get-DashboardPort",
        "dashboardPort/",
    ] {
        assert!(ps.contains(expected), "{expected}");
    }
    assert!(!SHELL.contains("18765") && !ps.contains("18765"));
    assert!(
        section("cmd_status()", "cmd_info()").contains("if dashboard_is_available \"$port\"; then")
    );
    assert!(ps.contains("if (Test-DashboardAvailable) {"));
    let f = Fixture::new();
    fs::write(f.data.join("loongsuite-pilot.pid"), "42").unwrap();
    for available in [false, true] {
        let body = format!(
            r#"
function is_running {{ true; }}
function dashboard_port {{ printf 9000; }}
function dashboard_is_available {{ {available}; }}
function is_pid_file_running {{ false; }}
function interceptor_embedded_status {{ printf stopped; }}
function autostart_status {{ :; }}
cmd_status
"#
        );
        let out = f.body(&body);
        success(&out);
        let output = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            output.contains("dashboard: http://127.0.0.1:9000/"),
            available
        );
        assert_eq!(
            output.contains("dashboard: unavailable (http://127.0.0.1:9000/)"),
            !available
        );
    }
    let native = include_str!("../../src/cli/dashboard_probe.rs");
    for expected in [
        ".head(format!",
        "/metrics-summary.json",
        "Duration::from_millis(300)",
        ".no_proxy()",
        ".redirect(reqwest::redirect::Policy::none())",
        "DASHBOARD_ID_HEADER",
        "DASHBOARD_INSTANCE_HEADER",
    ] {
        assert!(native.contains(expected), "{expected}");
    }
}
