//! Historical Unix restart contracts through actual shipped Bash functions.
//! Service-manager boundaries are isolated; the ladders, writer, waits and signals run.
#![cfg(unix)]
use loongsuite_pilot::utils::restart_breadcrumb::{
    read_restart_failure, RestartFailureBreadcrumb, RestartTarget, RESTART_STAGES,
};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    script: PathBuf,
}
impl Fixture {
    fn new(init: &str) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("隔离 O'Brien");
        let data = root.join("data");
        fs::create_dir_all(data.join("logs")).unwrap();
        fs::write(data.join("init-type"), init).unwrap();
        let script = root.join("production-service.sh");
        fs::write(&script, include_bytes!("../../scripts/loongsuite-pilot.sh")).unwrap();
        let binary = root.join("synthetic-native");
        fs::write(
            &binary,
            "#!/bin/bash\nprintf 'native:%s\\n' \"$*\" >> \"$PILOT_EVENTS\"\n",
        )
        .unwrap();
        fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            _temp: tmp,
            root,
            data,
            script,
        }
    }
    fn run(&self, body: &str, timeout: Duration) -> Output {
        use loongsuite_pilot::utils::candidate_process::CandidateChild;
        let harness = self.root.join("case.sh");
        fs::write(&harness, format!("source \"$PILOT_SOURCE\"\n{body}\n")).unwrap();
        let mut cmd = Command::new("/bin/bash");
        cmd.arg(harness)
            .env_clear()
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env("TZ", "UTC-14")
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", self.root.join("cache"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.join("never-open-config.json"),
            )
            .env("PILOT_SOURCE", &self.script)
            .env("PILOT_CASE_ROOT", &self.root)
            .env("PILOT_EVENTS", self.root.join("events"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = CandidateChild::spawn(&mut cmd).unwrap();
        let reader = |mut s: Box<dyn std::io::Read + Send>| {
            std::thread::spawn(move || {
                let mut b = Vec::new();
                s.read_to_end(&mut b).unwrap();
                assert!(b.len() < 1024 * 1024);
                b
            })
        };
        let out = reader(Box::new(child.take_stdout().unwrap()));
        let err = reader(Box::new(child.take_stderr().unwrap()));
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().unwrap() {
                break s;
            }
            assert!(
                start.elapsed() < timeout,
                "isolated production shell exceeded bound"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        Output {
            status,
            stdout: out.join().unwrap(),
            stderr: err.join().unwrap(),
        }
    }
    fn events(&self) -> String {
        fs::read_to_string(self.root.join("events")).unwrap_or_default()
    }
    fn breadcrumb(&self, t: RestartTarget) -> RestartFailureBreadcrumb {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(read_restart_failure(self.data.to_str().unwrap(), t))
            .unwrap()
    }
    fn raw(&self, t: &str) -> Value {
        serde_json::from_slice(
            &fs::read(
                self.data
                    .join(format!("logs/last-restart-failure-{t}.json")),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn stale(&self, t: &str) {
        fs::write(
            self.data
                .join(format!("logs/last-restart-failure-{t}.json")),
            b"old-attempt-must-be-cleared",
        )
        .unwrap();
    }
}
fn success(o: &Output) {
    assert!(
        o.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
}

// Only manager calls, stops and process enumeration are controlled here.
// Both actual restart commands, their writer and all branch/exit logic remain intact.
const ENTRY_BOUNDARIES: &str = r#"
SYSTEMD_SYSTEM_UNIT_DIR="$PILOT_CASE_ROOT/units"
mkdir -p "$SYSTEMD_SYSTEM_UNIT_DIR"
whoami() { printf '%s\n' fixture; }
uname() { printf '%s\n' Linux; }
maybe_sudo() { "$@"; }
maybe_sudo_n() { "$@"; }
cleanup_legacy_monitor_processes() { printf '%s\n' cleanup >> "$PILOT_EVENTS"; }
stop_pid_file() { printf '%s\n' stop-pid >> "$PILOT_EVENTS"; }
stop_installed_collector_processes() { :; }
stop_installed_updater_processes() { :; }
is_running() { return 1; }
schedule_updater_restart() { printf '%s\n' handoff >> "$PILOT_EVENTS"; }
find_current_user_processes() {
 printf '%s\n' "scope:$1" >> "$PILOT_EVENTS"
 if [ "$1" = updater ]; then printf '%s\n' 12345; fi
}
systemctl() {
 printf '%s\n' "manager:$*" >> "$PILOT_EVENTS"
 case "$*" in
 *is-enabled*) [ "$UNIT_ENABLED" = yes ] ;;
 *start*) [ "$MANAGER_STARTS" = yes ] ;;
 *) return 0 ;;
 esac
}
detect_init_system() { printf '%s\n' "$NEW_INIT"; }
register_case() {
 printf '%s\n' register >> "$PILOT_EVENTS"
 if [ "$REGISTER_SUCCEEDS" = yes ]; then
  printf '%s\n' "$NEW_INIT" > "$INIT_TYPE_FILE"; return 0
 fi
 return 1
}
autostart_install_collector_only() { register_case; }
autostart_install_updater_only() { register_case; }
resolve_pilot_bin() {
 printf '%s\n' resolve-binary >> "$PILOT_EVENTS"
 [ "$BINARY_EXISTS" = yes ] || return 1
 printf '%s\n' "$PILOT_CASE_ROOT/synthetic-native"
}
collect_restart_diag() { printf '%s\n' 'task_state=synthetic manager' 'definition_owner=fixture'; }
wait_index=0
wait_case() {
 wait_index=$((wait_index + 1))
 printf '%s\n' "wait:$1:$2:${3:-}:$wait_index" >> "$PILOT_EVENTS"
 case "$WAIT_RESULT" in
 yes) return 0 ;;
 no) return 1 ;;
 fail-first) [ "$wait_index" -gt 1 ] ;;
 *) return 90 ;;
 esac
}
wait_for_collector_process() { wait_case collector "$@"; }
wait_for_updater_process() { wait_case updater "$@"; }
"#;
fn entry(target: &str, settings: &str) -> String {
    let action = if target == "collector" {
        "cmd_restart_collector --defer-updater-restart"
    } else {
        "cmd_restart_updater"
    };
    format!("{ENTRY_BOUNDARIES}\n{settings}\n{action}")
}

#[test]
fn source_sh_l43_l59_l161_l180_actual_failure_exits_write_registered_schema_and_gate_fallback() {
    for t in ["collector", "updater"] {
        for (mode, init, setup, stage) in [
            (
                "binary",
                "nohup",
                "NEW_INIT=none; REGISTER_SUCCEEDS=no; BINARY_EXISTS=no",
                "binary-missing",
            ),
            (
                "registration",
                "systemd-user",
                "NEW_INIT=systemd-user; REGISTER_SUCCEEDS=no; BINARY_EXISTS=yes",
                "selfheal-register-failed",
            ),
            (
                "final",
                "nohup",
                "NEW_INIT=none; REGISTER_SUCCEEDS=no; BINARY_EXISTS=yes",
                "not-running-after-start",
            ),
            (
                "managed-wait",
                "nohup",
                "NEW_INIT=systemd-user; REGISTER_SUCCEEDS=yes; BINARY_EXISTS=yes",
                "selfheal-not-running",
            ),
        ] {
            let f = Fixture::new(init);
            let o = f.run(
                &entry(
                    t,
                    &format!("UNIT_ENABLED=no; MANAGER_STARTS=no; WAIT_RESULT=no\n{setup}"),
                ),
                Duration::from_secs(15),
            );
            assert!(!o.status.success(), "{t}/{mode} falsely succeeded");
            let r = f.raw(t);
            assert_eq!(r["schema"], 1);
            assert_eq!(r["target"], t);
            assert_eq!(r["stage"], stage);
            assert!(r["detail"].as_str().unwrap().len() > 10);
            assert!(r["diag"].is_object());
            assert!(RESTART_STAGES.contains(&stage));
            let err = String::from_utf8(o.stderr).unwrap();
            assert!(err.contains(&format!("stage={stage}")), "{t}/{mode}: {err}");
            if mode == "registration" || mode == "managed-wait" {
                assert!(
                    !f.events().contains("resolve-binary"),
                    "managed install must not launch an unmanaged daemon"
                );
            }
            if mode == "registration" {
                assert!(err.contains(&format!("(init_type=systemd-user stage={stage})")));
            }
            if mode == "managed-wait" {
                assert_eq!(r["init_type"], "systemd-user");
                assert!(f.events().contains("register"));
            }
        }
    }
}
#[test]
fn source_sh_l68_l77_restart_entries_clear_stale_breadcrumb_before_starting() {
    for t in ["collector", "updater"] {
        let f = Fixture::new("systemd-user");
        f.stale(t);
        let guard = format!(
            r#"
UNIT_ENABLED=yes; MANAGER_STARTS=yes; NEW_INIT=none
REGISTER_SUCCEEDS=no; BINARY_EXISTS=no; WAIT_RESULT=yes
production_systemctl=$(declare -f systemctl)
eval "${{production_systemctl/systemctl ()/original_systemctl ()}}"
systemctl() {{
 [ ! -e "$LOG_DIR/last-restart-failure-{t}.json" ] || {{
  printf '%s\n' stale-seen >> "$PILOT_EVENTS"; return 88;
 }}
 original_systemctl "$@"
}}
"#
        );
        success(&f.run(&entry(t, &guard), Duration::from_secs(10)));
        assert!(!f.events().contains("stale-seen"));
        assert!(!f
            .data
            .join(format!("logs/last-restart-failure-{t}.json"))
            .exists());
        assert!(f.events().contains("manager:--user start"));
    }
}
#[test]
fn source_sh_l84_l94_manager_success_waits_selfheals_and_excludes_old_updater_pid() {
    for t in ["collector", "updater"] {
        let f = Fixture::new("systemd-user");
        success(&f.run(
            &entry(
                t,
                r#"
UNIT_ENABLED=yes; MANAGER_STARTS=yes; NEW_INIT=systemd-user
REGISTER_SUCCEEDS=yes; BINARY_EXISTS=yes; WAIT_RESULT=fail-first
"#,
            ),
            Duration::from_secs(10),
        ));
        let e = f.events();
        let manager = e.find("manager:--user start").unwrap();
        let first = e.find(&format!("wait:{t}:")).unwrap();
        let reg = e.find("register\n").unwrap();
        assert!(manager < first && first < reg);
        let waits: Vec<_> = e.lines().filter(|l| l.starts_with("wait:")).collect();
        if t == "updater" {
            assert_eq!(
                waits,
                [
                    "wait:updater:15:12345:1",
                    "wait:updater:15:12345:2",
                    "wait:updater:10:12345:3"
                ]
            );
        } else {
            assert_eq!(
                waits,
                [
                    "wait:collector:20::1",
                    "wait:collector:20::2",
                    "wait:collector:10::3"
                ]
            );
        }
        assert!(!e.contains("resolve-binary"));
    }
}
#[test]
fn source_sh_l108_l128_collector_real_default_wait_preserves_pid_and_polls_late_liveness() {
    let f = Fixture::new("systemd-user");
    fs::write(f.data.join("loongsuite-pilot.pid"), b"stale-candidate\n").unwrap();
    let start = Instant::now();
    success(&f.run(
        r#"
is_running() { printf '%s\n' forbidden-is-running >> "$PILOT_EVENTS"; rm -f "$PID_FILE"; return 1; }
process_matches_installed_entry() { return 1; }
find_installed_collector_pid() { printf '%s\n' ''; }
set +e
wait_for_collector_process
result=$?
set -e
[ "$result" -eq 1 ]
[ -f "$PID_FILE" ]
"#,
        Duration::from_secs(25),
    ));
    assert!(start.elapsed() >= Duration::from_secs(15));
    assert_eq!(
        fs::read(f.data.join("loongsuite-pilot.pid")).unwrap(),
        b"stale-candidate\n"
    );
    assert!(!f.events().contains("forbidden-is-running"));
    success(&f.run(
        r#"
is_running() { exit 95; }
process_matches_installed_entry() { [ -f "$PILOT_CASE_ROOT/live" ]; }
find_installed_collector_pid() { printf '%s\n' late-candidate; }
(sleep 2; : > "$PILOT_CASE_ROOT/live") &
producer=$!
wait_for_collector_process
wait "$producer"
[ -f "$PID_FILE" ]
"#,
        Duration::from_secs(10),
    ));
    assert_eq!(
        fs::read(f.data.join("loongsuite-pilot.pid")).unwrap(),
        b"stale-candidate\n"
    );
}
#[test]
fn source_sh_l108_l116_updater_real_default_wait_rejects_old_pid_and_foreign_install() {
    let f = Fixture::new("systemd-user");
    let start = Instant::now();
    success(&f.run(
        r#"
updater_process_exists() { printf '%s\n' forbidden-global-probe >> "$PILOT_EVENTS"; return 0; }
find_current_user_processes() {
 printf '%s\n' "scope:$1" >> "$PILOT_EVENTS"
 if [ "$1" = updater ]; then printf '%s\n' old-pid; fi
}
set +e
wait_for_updater_process 15 old-pid
result=$?
set -e
[ "$result" -eq 1 ]
"#,
        Duration::from_secs(25),
    ));
    assert!(start.elapsed() >= Duration::from_secs(15));
    assert!(!f.events().contains("forbidden-global-probe"));
    assert!(f.events().contains("scope:updater"));
    success(&f.run(
        r#"
updater_process_exists() { exit 96; }
find_current_user_processes() {
 if [ "$1" = updater ]; then
  if [ -f "$PILOT_CASE_ROOT/new-pid" ]; then printf '%s\n' new-pid; else printf '%s\n' old-pid; fi
 fi
}
(sleep 2; : > "$PILOT_CASE_ROOT/new-pid") &
producer=$!
wait_for_updater_process 15 old-pid
wait "$producer"
"#,
        Duration::from_secs(10),
    ));
}
#[test]
fn source_sh_l140_stop_waits_ten_seconds_then_kills_only_real_term_ignoring_owned_process() {
    let f = Fixture::new("systemd-user");
    let start = Instant::now();
    let o = f.run(
        r#"
/bin/bash -c 'trap "" TERM; exec /bin/sleep 600' &
owned=$!
/bin/sleep 600 &
outsider=$!
trap 'kill -9 "$owned" "$outsider" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
sleep 0.2
find_current_user_processes() { [ "$1" != updater ] || printf '%s\n' "$owned"; }
process_matches_installed_entry() { [ "$1" = "$owned" ]; }
stop_installed_updater_processes
set +e
wait "$owned"
code=$?
set -e
[ "$code" -eq 137 ]
kill -0 "$outsider"
printf 'owned-exit=%s\n' "$code"
"#,
        Duration::from_secs(25),
    );
    success(&o);
    assert!(start.elapsed() >= Duration::from_secs(10));
    assert!(String::from_utf8_lossy(&o.stdout).contains("owned-exit=137"));
}
#[test]
fn source_sh_l241_l255_diagnostics_survive_missing_grep_and_units_without_pid_mutation() {
    for os in ["Linux", "Darwin"] {
        let f = Fixture::new("systemd-user");
        fs::write(f.data.join("loongsuite-pilot.pid"), b"999999999\n").unwrap();
        fs::write(
            f.data.join("logs/loongsuite-pilot-service.log"),
            "last-marker 研发\n",
        )
        .unwrap();
        let b = format!(
            r#"
SYSTEMD_SYSTEM_UNIT_DIR="$PILOT_CASE_ROOT/nonexistent-units"
uname() {{ printf '%s\n' {os}; }}
whoami() {{ printf '%s\n' fixture; }}
systemctl() {{ printf '%s\n' unit-not-found; return 3; }}
launchctl() {{ printf '%s\n' 'no Last Exit Status line'; return 1; }}
maybe_sudo_n() {{ "$@"; }}
resolve_pilot_bin() {{ return 1; }}
collect_restart_diag collector
printf '%s\n' after-all-probes
"#
        );
        let o = f.run(&b, Duration::from_secs(10));
        success(&o);
        let text = String::from_utf8(o.stdout).unwrap();
        assert!(text.contains("binary=not found"));
        assert!(text.contains("log_tail=last-marker 研发"));
        assert!(text.contains("after-all-probes"));
        assert_eq!(
            fs::read(f.data.join("loongsuite-pilot.pid")).unwrap(),
            b"999999999\n"
        );
        if os == "Darwin" {
            assert!(text.contains("service_state=com.loongsuite-pilot not loaded"));
        } else {
            assert!(text.contains("unit_file=none found"));
        }
    }
}
#[test]
fn source_sh_l193_l199_l207_l225_l264_l270_l294_writer_atomically_commits_escaped_schema() {
    let f = Fixture::new("systemd-user");
    let file = f.data.join("logs/last-restart-failure-updater.json");
    fs::write(&file, b"{\"previous\":\"must-survive-until-rename\"}\n").unwrap();
    let start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let o = f.run(
        r#"
collect_restart_diag() { printf '%s\n' $'key"\\\t=研发"\\\t\033'; }
mv() {
 cp "$LOG_DIR/last-restart-failure-updater.json" "$PILOT_CASE_ROOT/before-rename.json"
 cp "$LOG_DIR/last-restart-failure-updater.json.tmp" "$PILOT_CASE_ROOT/pending-complete.json"
 command /bin/mv "$@"
}
write_restart_failure updater register-denied $'quoted "\\\n\t\033研发'
"#,
        Duration::from_secs(10),
    );
    success(&o);
    assert_eq!(
        fs::read(f.root.join("before-rename.json")).unwrap(),
        b"{\"previous\":\"must-survive-until-rename\"}\n"
    );
    assert_eq!(
        fs::read(f.root.join("pending-complete.json")).unwrap(),
        fs::read(&file).unwrap()
    );
    assert!(!file
        .with_file_name("last-restart-failure-updater.json.tmp")
        .exists());
    let r = f.raw("updater");
    assert_eq!(r["schema"], 1);
    assert_eq!(r["target"], "updater");
    assert_eq!(r["stage"], "register-denied");
    assert!(r["diag"].is_object());
    assert_eq!(r["detail"], "quoted \"\\  研发");
    assert_eq!(r["diag"]["key\"\\ "], "研发\"\\ ");
    let ts = r["ts"].as_u64().unwrap();
    assert!(
        ts >= start
            && ts
                <= SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
    );
    let native = f.breadcrumb(RestartTarget::Updater);
    assert_eq!(native.stage, "register-denied");
    assert_eq!(native.diag.unwrap()["key\"\\ "], "研发\"\\ ");
    assert!(String::from_utf8_lossy(&o.stderr).contains("stage=register-denied"));
    let f = Fixture::new("systemd-user");
    fs::remove_dir_all(f.data.join("logs")).unwrap();
    fs::write(f.data.join("logs"), b"regular-file blocks directory").unwrap();
    let o = f.run(
        r#"
collect_restart_diag() { printf '%s\n' 'diag=still-visible'; }
write_restart_failure updater start-failed 'must be visible even if file creation fails'
"#,
        Duration::from_secs(10),
    );
    success(&o);
    let err = String::from_utf8_lossy(&o.stderr);
    let print = err
        .find("[restart-failure] target=updater stage=start-failed")
        .unwrap();
    let io = err.find("last-restart-failure-updater.json.tmp").unwrap();
    assert!(print < io, "console copy must precede failed write: {err}");
    assert!(err.contains("must be visible even if file creation fails"));
}
#[test]
fn source_sh_l277_every_script_stage_uses_actual_writer_and_native_registry() {
    let source = include_str!("../../scripts/loongsuite-pilot.sh")
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let pattern =
        regex::Regex::new(r#"(?:write_restart_failure\s+\w+\s+"|_stage=")([a-z-]+)""#).unwrap();
    let stages = pattern
        .captures_iter(&source)
        .map(|c| c[1].to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(stages.len() > 5);
    let f = Fixture::new("systemd-user");
    for stage in stages {
        let b=format!("collect_restart_diag() {{ printf '%s\\n' 'stage_contract=actual-writer'; }}\nwrite_restart_failure updater {stage} 'actual registry round trip'\n");
        success(&f.run(&b, Duration::from_secs(10)));
        let native = f.breadcrumb(RestartTarget::Updater);
        assert_eq!(native.stage, stage);
        assert!(
            RESTART_STAGES.contains(&native.stage.as_str()),
            "unknown writer stage: {}",
            native.stage
        );
    }
}
