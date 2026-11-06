#![cfg(unix)]
use super::*;

#[cfg(unix)]
#[tokio::test]
async fn actual_installer_pid_fallback_never_signals_a_live_foreign_process_or_removes_its_pid_file(
) {
    use loongsuite_pilot::utils::candidate_process::CandidateChild;
    let fixture = Fixture::new();
    fs::create_dir_all(&fixture.data).unwrap();
    let cache = fixture.root.path().join("cache");
    fs::create_dir_all(&cache).unwrap();
    let ready = fixture.root.path().join("foreign-ready");
    let mut foreign = Command::new("/bin/sh");
    foreign
        .args(["-c", "echo $$ > \"$READY\"; exec sleep 60"])
        .env("READY", &ready)
        .env("PATH", "/usr/bin:/bin");
    let mut child = CandidateChild::spawn(&mut foreign).unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    while !ready.is_file() {
        assert!(Instant::now() < ready_deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let pid = fs::read(&ready).unwrap();
    let pid_file = fixture.data.join("loongsuite-pilot.pid");
    fs::write(&pid_file, &pid).unwrap();
    let source = include_str!("../../deploy/installer-opensource.sh");
    let body = function(source, "stop_one_pilot_pid_file() {");
    let helper = function(source, "native_installer_helper() {");
    let script = fixture.root.path().join("stop-one.sh");
    fs::write(
        &script,
        format!("set -euo pipefail\n{helper}\n{body}\nstop_one_pilot_pid_file \"$PID_FILE\"\n"),
    )
    .unwrap();
    let mut command = fixture.command(Path::new("/bin/bash"));
    command
        .arg(script)
        .env("INSTALL_SRC", &fixture.candidate)
        .env("DATA_DIR", &fixture.data)
        .env("PID_FILE", &pid_file)
        .env("LOONGSUITE_PILOT_CACHE_DIR", &cache)
        .env("PATH", "/usr/bin:/bin");
    let job = tokio::task::spawn_blocking(move || bounded_for(command, Duration::from_secs(5)));
    let mut exited = false;
    while !job.is_finished() {
        if !exited && child.try_wait().unwrap().is_some() {
            exited = true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let output = job.await.unwrap();
    if !exited && child.try_wait().unwrap().is_some() {
        exited = true;
    }
    assert!(!exited, "installer fallback signaled a real foreign child");
    assert!(
        !output.status.success(),
        "unverified PID ownership must be reported"
    );
    assert_eq!(fs::read(&pid_file).unwrap(), pid);
}

fn native_package(fixture: &Fixture) -> PathBuf {
    use loongsuite_pilot::utils::runtime_paths::{build_edition, build_target, sha256_file};
    let code = fixture.root.path().join("owned-process.rs");
    fs::write(
        &code,
        r#"
fn main() {
    if std::env::var_os("PILOT_STOP_IGNORE_TERM").is_some() {
        unsafe extern "C" { fn signal(sig:i32,handler:usize)->usize; }
        unsafe {signal(15,1);}
    }
    let ready=std::env::var_os("PILOT_STOP_FIXTURE_READY").unwrap();
    std::fs::write(ready,std::process::id().to_string()).unwrap();
    loop {std::thread::sleep(std::time::Duration::from_millis(20));}
}
"#,
    )
    .unwrap();
    let cache = fixture.root.path().join("cache");
    let root = cache.join("versions/active");
    for name in ["bin", "agents.d", "assets", "scripts"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    let binary = root.join("bin/loongsuite-pilot");
    let mut compiler = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));
    compiler
        .args(["--edition=2021", "--target", build_target()])
        .arg(code)
        .arg("-o")
        .arg(&binary);
    let output = bounded_for(compiler, Duration::from_secs(30));
    success(&output);
    for (name, body) in [
        (
            "VERSION",
            format!(
                "version={}\ngit_commit={}\n",
                env!("CARGO_PKG_VERSION"),
                "a".repeat(40)
            ),
        ),
        ("LICENSE", "fixture only\n".into()),
        (
            "agents.d/cursor-cli.json",
            include_str!("../../agents.d/cursor-cli.json").into(),
        ),
        ("assets/fixture", "fixture asset".into()),
        (
            "scripts/loongsuite-pilot.sh",
            "#!/bin/bash\nexit 0\n".into(),
        ),
        (
            "scripts/loongsuite-pilot.ps1",
            "# inert fixture only\n".into(),
        ),
    ] {
        fs::write(root.join(name), body).unwrap();
    }
    let resources=walkdir::WalkDir::new(&root).into_iter().map(Result::unwrap)
        .filter(|entry|entry.file_type().is_file())
        .map(|entry|json!({"path":entry.path().strip_prefix(&root).unwrap().to_string_lossy().replace('\\',"/"),"sha256":sha256_file(entry.path()).unwrap()}))
        .collect::<Vec<_>>();
    fs::write(
        root.join("runtime-manifest.json"),
        json!({
            "schema":1,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),
            "gitCommit":"a".repeat(40),"target":build_target(),"edition":build_edition(),
            "binary":"bin/loongsuite-pilot","resources":resources
        })
        .to_string(),
    )
    .unwrap();
    fs::write(cache.join("current"), "active\n").unwrap();
    fs::create_dir_all(&fixture.data).unwrap();
    root
}
struct Running {
    child: loongsuite_pilot::utils::candidate_process::CandidateChild,
    pid_file: PathBuf,
    bytes: Vec<u8>,
}
async fn running(
    fixture: &Fixture,
    package: &Path,
    role: &str,
    data_mode: &str,
    ignore: bool,
) -> Running {
    use loongsuite_pilot::utils::candidate_process::CandidateChild;
    let ready = fixture.root.path().join("owned-ready");
    let mut command = fixture.command(&package.join("bin/loongsuite-pilot"));
    command.arg(role).env("PILOT_STOP_FIXTURE_READY", &ready);
    if data_mode == "foreign" {
        let foreign = fixture.root.path().join("another-install-data");
        fs::create_dir(&foreign).unwrap();
        command.env("LOONGSUITE_PILOT_DATA_DIR", foreign);
    }
    if data_mode == "missing" {
        command.env_remove("LOONGSUITE_PILOT_DATA_DIR");
    }
    if ignore {
        command.env("PILOT_STOP_IGNORE_TERM", "1");
    }
    let child = CandidateChild::spawn(&mut command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        if let Some(pid) = fs::read_to_string(&ready)
            .ok()
            .and_then(|text| text.parse::<u32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let pid_file = fixture.data.join(if role == "run-updater" {
        "loongsuite-pilot-updater.pid"
    } else {
        "loongsuite-pilot.pid"
    });
    let bytes = format!("{pid}\n").into_bytes();
    fs::write(&pid_file, &bytes).unwrap();
    Running {
        child,
        pid_file,
        bytes,
    }
}
fn stop(fixture: &Fixture, pid_file: &Path) -> Output {
    fixture.helper(
        "stop-deploy-process",
        &json!({
            "dataDir":fixture.data,"cacheDir":fixture.root.path().join("cache"),"pidFile":pid_file
        }),
        true,
    )
}
#[tokio::test]
async fn source_l61_native_fallback_stops_real_owned_collector_and_updater_without_deleting_pid_files(
) {
    for role in ["run", "run-updater"] {
        let fixture = Fixture::new();
        let package = native_package(&fixture);
        let mut running = running(&fixture, &package, role, "matching", false).await;
        success(&stop(&fixture, &running.pid_file));
        assert!(running.child.try_wait().unwrap().is_some());
        assert_eq!(fs::read(&running.pid_file).unwrap(), running.bytes);
    }
}
#[tokio::test]
async fn native_fallback_preserves_foreign_data_wrong_role_and_modified_package_processes() {
    for scenario in [
        "foreign-data",
        "missing-explicit-data",
        "wrong-role",
        "modified-package",
        "unpublished-version",
    ] {
        let mut fixture = Fixture::new();
        if scenario == "missing-explicit-data" {
            fixture.data = fixture.root.path().join(".loongsuite-pilot");
        }
        let package = native_package(&fixture);
        let role = if scenario == "wrong-role" {
            "status"
        } else {
            "run"
        };
        let mut running = running(
            &fixture,
            &package,
            role,
            if scenario == "foreign-data" {
                "foreign"
            } else if scenario == "missing-explicit-data" {
                "missing"
            } else {
                "matching"
            },
            false,
        )
        .await;
        if scenario == "modified-package" {
            fs::write(package.join("assets/fixture"), "changed").unwrap();
        }
        if scenario == "unpublished-version" {
            fs::write(
                fixture.root.path().join("cache/current"),
                "different-version\n",
            )
            .unwrap();
        }
        let output = stop(&fixture, &running.pid_file);
        assert!(!output.status.success(), "{scenario}");
        assert!(running.child.try_wait().unwrap().is_none(), "{scenario}");
        assert_eq!(fs::read(&running.pid_file).unwrap(), running.bytes);
    }
}
#[tokio::test]
async fn native_fallback_force_phase_still_targets_the_original_real_identity_and_retains_the_file()
{
    let fixture = Fixture::new();
    let package = native_package(&fixture);
    let mut running = running(&fixture, &package, "run", "matching", true).await;
    let start = Instant::now();
    success(&stop(&fixture, &running.pid_file));
    assert!(start.elapsed() >= Duration::from_secs(9));
    assert!(running.child.try_wait().unwrap().is_some());
    assert_eq!(fs::read(&running.pid_file).unwrap(), running.bytes);
}
#[test]
fn native_fallback_rejects_unscoped_reserved_and_invalid_pid_files_without_modification() {
    let fixture = Fixture::new();
    fs::create_dir_all(&fixture.data).unwrap();
    fs::create_dir_all(fixture.root.path().join("cache")).unwrap();
    let pid = fixture.data.join("loongsuite-pilot.pid");
    for raw in ["0\n", "1\n", "+42\n", "not a pid\n", "4294967296\n"] {
        fs::write(&pid, raw).unwrap();
        assert!(!stop(&fixture, &pid).status.success(), "{raw}");
        assert_eq!(fs::read_to_string(&pid).unwrap(), raw);
    }
    let unrelated = fixture.data.join("another.pid");
    fs::write(&unrelated, "1\n").unwrap();
    assert!(!stop(&fixture, &unrelated).status.success());
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "1\n");
    let output = stop(&fixture, &fixture.data.join("loongsuite-pilot-updater.pid"));
    success(&output);
}
#[test]
fn source_l45_l55_l73_l84_l97_l112_l132_l190_real_installer_wiring_holds_before_stop_and_preserves_restore(
) {
    let source = include_str!("../../deploy/installer-opensource.sh");
    let start = source.find("# >>> pilot-stop-for-deploy >>>").unwrap();
    let end = source.find("# <<< pilot-stop-for-deploy <<<").unwrap();
    let block = &source[start..end];
    let code = |text: &str| {
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut found = 0;
    for relative in [
        "deploy/installer.sh",
        "deploy/installer-inner.sh",
        "deploy/installer-opensource.sh",
    ] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let Ok(contents) = fs::read_to_string(path) else {
            continue;
        };
        let Some((_, tail)) = contents.split_once("# >>> pilot-stop-for-deploy >>>") else {
            continue;
        };
        let candidate = tail
            .split_once("# <<< pilot-stop-for-deploy <<<")
            .unwrap()
            .0;
        assert_eq!(code(candidate), code(block), "{relative}");
        found += 1;
    }
    assert!(found > 0);
    let stop = function(source, "stop_pilot_for_deploy() {");
    assert!(stop.contains("run_pilot_cli stop"));
    assert!(stop.contains("loongsuite-pilot.pid") && stop.contains("loongsuite-pilot-updater.pid"));
    assert!(
        stop.find("PILOT_HELD_FOR_DEPLOY=1").unwrap() < stop.find("run_pilot_cli stop").unwrap()
    );
    let cli = function(source, "run_pilot_cli() {");
    assert!(cli.contains("LOONGSUITE_PILOT_DATA_DIR=\"$DATA_DIR\""));
    assert!(!cli.contains("LOONGSUITE_PILOT_CACHE_DIR="));
    let restore = function(source, "restore_pilot_after_deploy() {");
    assert!(restore.contains("INSTALL_MODE:-host") && restore.contains("container"));
    assert!(
        restore.contains("run_pilot_cli start") && restore.contains("Could not restore autostart")
    );
    assert!(block.contains("native_installer_helper stop-deploy-process --from-env"));
    let fallback = function(source, "stop_one_pilot_pid_file() {");
    assert!(
        !fallback.contains("kill ") && !fallback.contains("kill -") && !fallback.contains("rm -")
    );
    for name in ["cmd_install() {", "cmd_upgrade() {"] {
        let body = function(source, name);
        assert!(
            body.find("\n    stop_pilot_for_deploy\n").unwrap()
                < body.find("deploy_package").unwrap()
        );
        assert!(
            body.find("trap 'restore_pilot_after_deploy").unwrap()
                < body.find("\n    stop_pilot_for_deploy\n").unwrap()
        );
        assert!(body.contains("run_pilot_cli start"));
        if name == "cmd_upgrade() {" {
            assert!(body.contains("run_pilot_cli rollback"));
            let failure = body.find("New version failed to start").unwrap();
            assert!(body[failure..].contains("run_pilot_cli start"));
        }
    }
    let deploy = function(source, "deploy_package() {");
    assert!(deploy.contains("publish-package deploy-hooks || return 1"));
    assert!(
        deploy.find("publish-package").unwrap()
            < deploy.find("Native package and hooks deployed").unwrap()
    );
    let agents = include_str!("../../AGENTS.md");
    if agents.contains("pilot-stop-for-deploy") {
        assert!(agents.contains("tests/unit/deploy/installer-stop-for-deploy.test.mjs"));
    }
}

#[tokio::test]
async fn native_fallback_never_force_kills_after_the_pid_file_is_replaced() {
    let fixture = Fixture::new();
    let package = native_package(&fixture);
    let mut running = running(&fixture, &package, "run", "matching", true).await;
    let replacement = b"1\n";
    let pid_file = running.pid_file.clone();
    let helper = fixture.binary.clone();
    let mut command = fixture.command(&helper);
    command.args(["installer-helper", "stop-deploy-process", "--input-env"])
        .env("LOONGSUITE_PILOT_INSTALL_INPUT", json!({
            "dataDir":fixture.data,"cacheDir":fixture.root.path().join("cache"),"pidFile":pid_file
        }).to_string());
    let job = tokio::task::spawn_blocking(move || bounded_for(command, Duration::from_secs(30)));
    tokio::time::sleep(Duration::from_secs(2)).await;
    fs::write(&pid_file, replacement).unwrap();
    let output = job.await.unwrap();
    assert!(!output.status.success());
    assert!(running.child.try_wait().unwrap().is_none());
    assert_eq!(fs::read(&pid_file).unwrap(), replacement);
}

#[test]
fn actual_shell_overlay_failure_restores_with_the_original_data_and_cache_only_on_host() {
    use std::os::unix::fs::PermissionsExt;
    let source = include_str!("../../deploy/installer-opensource.sh");
    let functions = [
        "resolve_pilot_cli() {",
        "run_pilot_cli() {",
        "stop_one_pilot_pid_file() {",
        "stop_pilot_for_deploy() {",
        "restore_pilot_after_deploy() {",
    ]
    .map(|name| function(source, name))
    .join("\n");
    for mode in ["host", "container"] {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.data).unwrap();
        let bin = fixture.root.path().join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let cli = bin.join("loongsuite-pilot");
        fs::write(&cli, concat!(
            "#!/bin/bash\n",
            "printf '%s|%s|%s\\n' \"$1\" \"$LOONGSUITE_PILOT_DATA_DIR\" \"@OPEN@LOONGSUITE_PILOT_CACHE_DIR:-unset}\" >> \"$TRACE\"\n",
            "exit 7\n"
        ).replace("@OPEN@", concat!("$","{"))).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        let script = fixture.root.path().join("actual-overlay.sh");
        fs::write(&script,format!(
            "set -euo pipefail\n{functions}\nmsg() {{ printf '%s\\n' \"$2\"; }}\nPILOT_HELD_FOR_DEPLOY=0\ntrap 'restore_pilot_after_deploy' EXIT\nstop_pilot_for_deploy\n[ \"$PILOT_HELD_FOR_DEPLOY\" -eq 1 ]\nexit 23\n"
        )).unwrap();
        let trace = fixture.root.path().join("trace");
        let cache = fixture.root.path().join("separate-cache");
        let mut command = fixture.command(Path::new("/bin/bash"));
        command
            .arg(script)
            .env("PATH", "/usr/bin:/bin")
            .env("DATA_DIR", &fixture.data)
            .env("INSTALL_MODE", mode)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &cache)
            .env("TRACE", &trace);
        let output = bounded_for(command, Duration::from_secs(5));
        assert_eq!(output.status.code(), Some(23));
        let expected = ["stop", "start"]
            .into_iter()
            .take(if mode == "host" { 2 } else { 1 })
            .map(|verb| format!("{verb}|{}|{}\n", fixture.data.display(), cache.display()))
            .collect::<String>();
        assert_eq!(fs::read_to_string(trace).unwrap(), expected);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("Could not stop the service"));
        assert_eq!(
            stdout.contains("Could not restore autostart"),
            mode == "host"
        );
    }
}

#[test]
fn native_fallback_preserves_symlinks_directories_and_oversized_pid_files() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::create_dir_all(&fixture.data).unwrap();
    let pid = fixture.data.join("loongsuite-pilot.pid");
    let foreign = fixture.root.path().join("customer-pid");
    fs::write(&foreign, "1\n").unwrap();
    symlink(&foreign, &pid).unwrap();
    assert!(!stop(&fixture, &pid).status.success());
    assert!(fs::symlink_metadata(&pid).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&foreign).unwrap(), "1\n");
    fs::remove_file(&pid).unwrap();
    fs::create_dir(&pid).unwrap();
    assert!(!stop(&fixture, &pid).status.success());
    assert!(pid.is_dir());
    fs::remove_dir(&pid).unwrap();
    let bytes = vec![b'2'; 129];
    fs::write(&pid, &bytes).unwrap();
    assert!(!stop(&fixture, &pid).status.success());
    assert_eq!(fs::read(&pid).unwrap(), bytes);
}
