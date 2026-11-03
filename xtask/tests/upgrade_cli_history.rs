//! Historical public upgrade gate, private native/download recorders only.
#![cfg(unix)]
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    tools: PathBuf,
    script: PathBuf,
    curl: PathBuf,
    installer: PathBuf,
    temporary: PathBuf,
}
impl Fixture {
    fn new(custom_cache: bool, custom_data: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("用户 O'Brien [升级]🚀");
        let cache = if custom_cache {
            home.join("自定义缓存")
        } else {
            home.join(".loongsuite-pilot")
        };
        let data = if custom_data {
            home.join("自定义数据")
        } else {
            cache.clone()
        };
        let version = cache.join("versions/test-version");
        let tools = home.join("tools");
        let temporary = home.join("private-tmp");
        fs::create_dir_all(version.join("bin")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::create_dir_all(&temporary).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_pilot-fixture"),
            version.join("bin/loongsuite-pilot"),
        )
        .unwrap();
        fs::write(version.join("runtime-manifest.json"), "{}").unwrap();
        fs::write(cache.join("current"), "test-version\n").unwrap();
        fs::write(data.join("config.json"), "invalid private mutable config").unwrap();
        fs::write(
            cache.join("updater-config.json"),
            "{\"edition\":\"proprietary\",\"packageUrl\":\"https://invalid.private\"}",
        )
        .unwrap();
        let script = home.join("loongsuite-pilot");
        fs::write(&script, include_bytes!("../../scripts/loongsuite-pilot.sh")).unwrap();
        for name in ["node", "nodejs", "systemctl", "launchctl", "crontab"] {
            let p = tools.join(name);
            fs::write(
                &p,
                "#!/bin/sh\nprintf forbidden >> \"$PILOT_FORBIDDEN\"\nexit 99\n",
            )
            .unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let curl = home.join("curl-args");
        let installer = home.join("installer-args");
        let p = tools.join("curl");
        fs::write(&p,r#"#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "$PILOT_TEST_CURL_ARGS"
if [ "$PILOT_TEST_DOWNLOAD_FAIL" = 1 ]; then exit 7; fi
output=""
while [ "$#" -gt 0 ]; do case "$1" in -o) output="$2"; shift 2;; *) shift;; esac; done
[ -n "$output" ]
cat > "$output" <<'INSTALLER'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "$PILOT_TEST_INSTALLER_ARGS"
printf '%s\n%s\n' "$LOONGSUITE_PILOT_DATA_DIR" "$LOONGSUITE_PILOT_CACHE_DIR" > "$PILOT_TEST_INSTALLER_ENV"
exit "$PILOT_TEST_INSTALLER_EXIT"
INSTALLER
"#).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _temp: temp,
            home,
            data,
            cache,
            tools,
            script,
            curl,
            installer,
            temporary,
        }
    }
    fn run(&self, edition: &str, args: &[&str], installer_exit: u8, download_fail: bool) -> Output {
        let mut command = Command::new("/bin/bash");
        let out = self.home.join("stdout");
        let err = self.home.join("stderr");
        command
            .arg(&self.script)
            .args(args)
            .env_clear()
            .current_dir(&self.home)
            .env("HOME", &self.home)
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.data.join("config.json"),
            )
            .env(
                "PATH",
                std::env::join_paths([
                    self.tools.as_path(),
                    Path::new("/usr/bin"),
                    Path::new("/bin"),
                ])
                .unwrap(),
            )
            .env("TMPDIR", &self.temporary)
            .env("PILOT_FIXTURE_MODE", "build-edition")
            .env("PILOT_FIXTURE_EDITION", edition)
            .env("PILOT_FIXTURE_LOG", self.home.join("native.jsonl"))
            .env("PILOT_FORBIDDEN", self.home.join("forbidden"))
            .env("PILOT_TEST_CURL_ARGS", &self.curl)
            .env("PILOT_TEST_INSTALLER_ARGS", &self.installer)
            .env("PILOT_TEST_INSTALLER_ENV", self.home.join("installer-env"))
            .env("PILOT_TEST_INSTALLER_EXIT", installer_exit.to_string())
            .env(
                "PILOT_TEST_DOWNLOAD_FAIL",
                if download_fail { "1" } else { "0" },
            )
            .stdin(Stdio::null())
            .stdout(fs::File::create(&out).unwrap())
            .stderr(fs::File::create(&err).unwrap());
        let mut child = command.spawn().unwrap();
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if start.elapsed() > Duration::from_secs(15) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("upgrade shell exceeded original 15s budget");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(!self.home.join("forbidden").exists());
        Output {
            status,
            stdout: fs::read(out).unwrap(),
            stderr: fs::read(err).unwrap(),
        }
    }
    fn assert_private_unchanged(&self) {
        assert_eq!(
            fs::read(self.data.join("config.json")).unwrap(),
            b"invalid private mutable config"
        );
        assert_eq!(
            fs::read(self.cache.join("updater-config.json")).unwrap(),
            b"{\"edition\":\"proprietary\",\"packageUrl\":\"https://invalid.private\"}"
        );
        assert!(
            fs::read_dir(&self.temporary).unwrap().next().is_none(),
            "temporary installer leaked"
        );
        for path in [
            "loongsuite-pilot.pid",
            "loongsuite-pilot-updater.pid",
            "logs",
            "bin",
        ] {
            assert!(!self.data.join(path).exists(), "{path}");
        }
        let calls = fs::read_to_string(self.home.join("native.jsonl")).unwrap();
        assert!(!calls.is_empty());
        for line in calls.lines() {
            let call: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(
                call["args"],
                serde_json::json!(["probe", "--build-edition"])
            );
        }
    }
}
fn success(out: &Output) {
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn upgrade_l174_help_and_l238_rejection_use_only_native_build_edition() {
    for edition in ["opensource", "proprietary", ""] {
        let f = Fixture::new(false, false);
        let out = f.run(edition, &["help"], 0, false);
        success(&out);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).contains("upgrade [opts]"),
            edition == "opensource"
        );
        assert!(!f.curl.exists());
        f.assert_private_unchanged();
        if edition != "opensource" {
            let out = f.run(edition, &["upgrade"], 0, false);
            assert_eq!(out.status.code(), Some(1));
            assert!(String::from_utf8_lossy(&out.stdout).contains("Unknown command: upgrade"));
            assert!(!f.curl.exists());
            assert!(!f.installer.exists());
            f.assert_private_unchanged();
        }
    }
}
#[test]
fn upgrade_l187_l200_l228_fixed_public_installer_and_exact_latest_version_custom_data() {
    for (args, version, custom_data) in [
        (vec!["upgrade"], None, false),
        (vec!["upgrade", "--version", "1.6.0"], Some("1.6.0"), false),
        (
            vec!["upgrade", "--version=2.0.0-rc.1"],
            Some("2.0.0-rc.1"),
            false,
        ),
        (vec!["upgrade"], None, true),
    ] {
        let f = Fixture::new(false, custom_data);
        success(&f.run("opensource", &args, 0, false));
        let download = fs::read_to_string(&f.curl)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(&download[..2],["-fsSL","https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh"]);
        assert_eq!(download[2], "-o");
        assert_eq!(download.len(), 4);
        assert!(Path::new(&download[3]).starts_with(&f.temporary));
        assert!(!Path::new(&download[3]).exists());
        let mut expected = vec![
            "upgrade".to_string(),
            "--data-dir".into(),
            f.data.to_str().unwrap().into(),
        ];
        if let Some(version) = version {
            expected.extend(["--version".into(), version.into()]);
        }
        assert_eq!(
            fs::read_to_string(&f.installer)
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            fs::read_to_string(f.home.join("installer-env")).unwrap(),
            format!("{}\n{}\n", f.data.display(), f.cache.display())
        );
        f.assert_private_unchanged();
    }
}
#[test]
fn upgrade_l210_invalid_versions_and_l219_custom_cache_fail_before_download() {
    for args in [
        vec!["upgrade", "--version", "../../commercial"],
        vec!["upgrade", "--version=../../commercial"],
        vec!["upgrade", "--version"],
        vec!["upgrade", "--version="],
    ] {
        let f = Fixture::new(false, false);
        let out = f.run("opensource", &args, 0, false);
        assert_eq!(out.status.code(), Some(1));
        assert!(!f.curl.exists());
        assert!(!f.installer.exists());
        f.assert_private_unchanged();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("Invalid version") || stderr.contains("requires a value"));
    }
    let f = Fixture::new(true, false);
    let out = f.run("opensource", &["upgrade"], 0, false);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr)
        .contains("does not yet support a custom cache directory"));
    assert!(!f.curl.exists());
    assert!(!f.installer.exists());
    f.assert_private_unchanged();
}
#[test]
fn upgrade_download_failure_and_real_installer_exit_seven_preserve_cleanup_and_status() {
    for (download_fail, expected) in [(true, 1), (false, 7)] {
        let f = Fixture::new(false, false);
        let out = f.run("opensource", &["upgrade"], 7, download_fail);
        assert_eq!(out.status.code(), Some(expected));
        assert!(f.curl.exists());
        assert_eq!(f.installer.exists(), !download_fail);
        f.assert_private_unchanged();
        if download_fail {
            assert!(String::from_utf8_lossy(&out.stderr)
                .contains("Failed to download the open-source installer"));
        }
    }
}
#[test]
fn upgrade_l153_edition_gates_ignore_mutable_config_and_updater_sources() {
    for (source, start, end) in [
        (
            include_str!("../../scripts/loongsuite-pilot.sh"),
            "build_edition()",
            "resolve_previous_version()",
        ),
        (
            include_str!("../../scripts/loongsuite-pilot.ps1"),
            "function Get-BuildEdition",
            "function Resolve-PreviousVersion",
        ),
    ] {
        let gate = source
            .split_once(start)
            .unwrap()
            .1
            .split_once(end)
            .unwrap()
            .0;
        assert!(gate.contains("--build-edition"));
        for forbidden in ["config.json", "packageUrl", "updater-daemon.js"] {
            assert!(!gate.contains(forbidden), "{forbidden}");
        }
    }
}
#[test]
fn upgrade_l251_powershell_keeps_build_gate_fixed_url_version_and_paths() {
    let source = include_str!("../../scripts/loongsuite-pilot.ps1");
    for expected in [
        "function Test-OpenSourceBuild",
        "if (Test-OpenSourceBuild)",
        "loongsuite-pilot/installer.ps1",
        "\"-DataDir\", $DATA_DIR",
        "$env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR",
        "$installerArgs += @(\"-Version\", $version)",
        "\"upgrade\" {",
    ] {
        assert!(source.contains(expected), "{expected}");
    }
}
#[test]
fn upgrade_l263_powershell_download_tls_and_finally_preserve_installer_result() {
    let source = include_str!("../../scripts/loongsuite-pilot.ps1");
    let upgrade = source
        .split_once("function Cmd-Upgrade")
        .unwrap()
        .1
        .split_once("# CMD: rollback")
        .unwrap()
        .0;
    for expected in [
        "$installerExit = 1",
        "[Net.SecurityProtocolType]::Tls12",
        "Failed to download the open-source installer",
        "Remove-Item -LiteralPath $installerFile -Force -ErrorAction Stop",
        "Write-Warning \"Failed to remove temporary installer: $_\"",
        "$installerExit = $LASTEXITCODE",
        "exit $installerExit",
    ] {
        assert!(upgrade.contains(expected), "{expected}");
    }
    assert!(!upgrade
        .contains("Remove-Item -LiteralPath $installerFile -Force -ErrorAction SilentlyContinue"));
    assert!(
        upgrade.find("$installerExit = $LASTEXITCODE").unwrap()
            < upgrade.find("} finally {").unwrap()
    );
}
