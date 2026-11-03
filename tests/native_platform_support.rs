//! Current six-target release contract and real Unix install rejection boundary.
//! All child commands use synthetic HOME, PATH and configuration only.

use loongsuite_pilot::updater::{ArchiveFormat, ReleaseAsset, VersionManifest};
use loongsuite_pilot::utils::runtime_paths::SUPPORTED_TARGETS;
use std::collections::BTreeMap;

#[test]
fn update_assets_accept_exactly_six_platforms_and_never_select_removed_musl() {
    let assets = SUPPORTED_TARGETS
        .into_iter()
        .map(|target| {
            (
                target.to_owned(),
                ReleaseAsset {
                    url: format!("https://releases.example.invalid/{target}.tar.gz"),
                    format: ArchiveFormat::for_target(target),
                    sha256: "a".repeat(64),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let manifest = VersionManifest {
        version: "2.0.0".into(),
        git_commit: "b".repeat(40),
        assets,
        released_at: None,
        rollout_percentage: None,
        hotfix_version: None,
    };
    manifest.validate().unwrap();
    for target in SUPPORTED_TARGETS {
        assert!(manifest.asset(target).is_ok(), "{target}");
    }
    for (gnu, musl) in [
        ("x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"),
        ("aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl"),
    ] {
        assert!(manifest.asset(musl).is_err());
        let mut replaced = manifest.clone();
        let asset = replaced.assets.remove(gnu).unwrap();
        replaced.assets.insert(musl.into(), asset);
        assert_eq!(replaced.assets.len(), 6);
        assert!(replaced.validate().is_err(), "same-count musl substitution");
    }
    let mut old_eight = manifest.clone();
    for (gnu, musl) in [
        ("x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"),
        ("aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl"),
    ] {
        old_eight
            .assets
            .insert(musl.into(), manifest.assets[gnu].clone());
    }
    assert_eq!(old_eight.assets.len(), 8);
    assert!(
        old_eight.validate().is_err(),
        "obsolete eight-target manifest"
    );
}

#[test]
fn release_workflow_and_injection_matrix_cover_the_same_exact_six_targets() {
    let workflow = include_str!("../.github/workflows/release.yml");
    let actual = workflow
        .lines()
        .filter_map(|line| {
            line.split_once(", target: ")
                .map(|(_, target)| target.split([',', '}']).next().unwrap().trim())
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, SUPPORTED_TARGETS);
    assert!(
        !workflow.contains("musl"),
        "no musl matrix or compiler steps"
    );
    let injection: serde_json::Value =
        serde_json::from_str(include_str!("e2e-injection/targets.json")).unwrap();
    let targets = injection["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["target"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(targets, SUPPORTED_TARGETS);
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    struct Fixture {
        root: tempfile::TempDir,
        bin: PathBuf,
        home: PathBuf,
        calls: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("bin");
            let home = root.path().join("synthetic home");
            let calls = root.path().join("external-calls");
            fs::create_dir_all(&bin).unwrap();
            fs::create_dir_all(home.join(".loongsuite-pilot")).unwrap();
            fs::write(home.join(".loongsuite-pilot/config.json"), b"keep-config\n").unwrap();
            fs::write(home.join(".loongsuite-pilot/current"), b"keep-current\n").unwrap();
            let fixture = Self {
                root,
                bin,
                home,
                calls,
            };
            fixture.script("uname", "#!/bin/sh\ncase \"$1\" in -m) printf '%s\\n' \"$FAKE_ARCH\";; *) printf '%s\\n' \"$FAKE_OS\";; esac\n");
            fixture.script("ldd", "#!/bin/sh\nprintf '%s\\n' \"$FAKE_LDD\"\nexit 1\n");
            fixture.script(
                "getconf",
                "#!/bin/sh\nprintf '%s\\n' \"$FAKE_GLIBC\"\n[ -n \"$FAKE_GLIBC\" ]\n",
            );
            for name in [
                "curl",
                "wget",
                "loongsuite-pilot",
                "node",
                "npm",
                "python",
                "python3",
            ] {
                fixture.script(
                    name,
                    "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$CALL_LOG\"\nexit 77\n",
                );
            }
            fixture
        }

        fn script(&self, name: &str, body: &str) {
            let file = self.bin.join(name);
            fs::write(&file, body).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        }

        fn command(&self, os: &str, arch: &str, ldd: &str, glibc: &str) -> Command {
            let mut cmd = Command::new("bash");
            cmd.env_clear()
                .env("HOME", &self.home)
                .env("USERPROFILE", &self.home)
                .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
                .env("LOONGSUITE_PILOT_LANG", "en")
                .env("LOONGSUITE_PILOT_INSTALL_MODE", "container")
                .env("FAKE_OS", os)
                .env("FAKE_ARCH", arch)
                .env("FAKE_LDD", ldd)
                .env("FAKE_GLIBC", glibc)
                .env("CALL_LOG", &self.calls)
                .current_dir(self.root.path())
                .stdin(Stdio::null());
            cmd
        }

        fn run(&self, mut cmd: Command) -> (std::process::ExitStatus, String, String) {
            use loongsuite_pilot::utils::candidate_process::CandidateChild;
            use std::io::Read;
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = CandidateChild::spawn(&mut cmd).unwrap();
            let stdout = child.take_stdout().unwrap();
            let stderr = child.take_stderr().unwrap();
            let read = |stream: Box<dyn Read + Send>| {
                std::thread::spawn(move || {
                    let mut bytes = Vec::new();
                    stream
                        .take(1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .unwrap();
                    assert!(bytes.len() <= 1024 * 1024);
                    bytes
                })
            };
            let stdout = read(Box::new(stdout));
            let stderr = read(Box::new(stderr));
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                assert!(std::time::Instant::now() < deadline, "bounded installer");
                std::thread::sleep(Duration::from_millis(10));
            };
            let out = String::from_utf8(stdout.join().unwrap()).unwrap();
            let err = String::from_utf8(stderr.join().unwrap()).unwrap();
            (status, out, err)
        }

        fn assert_preserved(&self) {
            assert!(
                !self.calls.exists(),
                "download/service/runtime command must not run"
            );
            assert_eq!(
                fs::read(self.home.join(".loongsuite-pilot/config.json")).unwrap(),
                b"keep-config\n"
            );
            assert_eq!(
                fs::read(self.home.join(".loongsuite-pilot/current")).unwrap(),
                b"keep-current\n"
            );
            let names: Vec<_> = fs::read_dir(self.home.join(".loongsuite-pilot"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(names.len(), 2, "no staging/config mutation");
        }
    }

    #[test]
    fn real_install_and_upgrade_reject_musl_or_unknown_libc_before_any_side_effect() {
        let installer =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/installer-opensource.sh");
        for command in ["install", "upgrade"] {
            for arch in ["x86_64", "aarch64"] {
                for (ldd, glibc, expected) in [
                    ("musl libc (x86_64)", "", "Linux musl"),
                    // Even a misleading getconf must not override known musl.
                    ("musl libc (aarch64)", "glibc 2.34", "Linux musl"),
                    ("ldd (GNU libc) 2.34", "", "could not be verified"),
                    ("unrecognized libc", "", "could not be verified"),
                ] {
                    for local in [false, true] {
                        let f = Fixture::new();
                        let package = f.root.path().join("local package.tar.gz");
                        fs::write(&package, b"not a package").unwrap();
                        let mut cmd = f.command("Linux", arch, ldd, glibc);
                        cmd.arg(&installer)
                            .arg(command)
                            .arg("--package-url")
                            .arg(if local {
                                package.as_os_str()
                            } else {
                                std::ffi::OsStr::new("https://example.invalid/package.tar.gz")
                            });
                        let (status, out, err) = f.run(cmd);
                        assert!(!status.success(), "{command}/{arch}/{local}: {out} {err}");
                        assert!(err.contains(expected), "{command}/{arch}/{local}: {err}");
                        f.assert_preserved();
                    }
                }
            }
        }
    }

    #[test]
    fn actual_platform_function_accepts_both_gnu_architectures_and_both_mac_architectures() {
        let script = include_str!("../deploy/installer-opensource.sh");
        let start = script.find("# >>> native-platform-support >>>").unwrap();
        let end = script.find("# <<< native-platform-support <<<").unwrap();
        let body = format!("{}\nnative_installer_target\n", &script[start..end]);
        for (os, arch, ldd, glibc, expected) in [
            (
                "Linux",
                "x86_64",
                "ldd (GNU libc) 2.34",
                "glibc 2.34",
                "x86_64-unknown-linux-gnu",
            ),
            (
                "Linux",
                "aarch64",
                "ldd (GNU libc) 2.34",
                "glibc 2.34",
                "aarch64-unknown-linux-gnu",
            ),
            ("Darwin", "x86_64", "", "", "x86_64-apple-darwin"),
            ("Darwin", "arm64", "", "", "aarch64-apple-darwin"),
        ] {
            let f = Fixture::new();
            let mut cmd = f.command(os, arch, ldd, glibc);
            cmd.arg("-c").arg(&body);
            let (status, out, err) = f.run(cmd);
            assert!(status.success(), "{expected}: {out} {err}");
            assert_eq!(out.trim(), expected);
            f.assert_preserved();
        }
    }
}
