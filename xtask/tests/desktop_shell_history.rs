//! Actual public Unix desktop entry routing. Native children only record private
//! arguments; no macOS desktop, Dock, service or installed user data is touched.
#![cfg(unix)]
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
struct Fixture {
    _temporary: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    config: PathBuf,
    script: PathBuf,
    tools: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("用户 O'Brien [桌面]🚀");
        let data = home.join("unused-data");
        let cache = home.join("private cache");
        let config = home.join("配置 ' with spaces/config.json");
        let script = home.join("bin/loongsuite-pilot");
        let tools = home.join("tools");
        let log = home.join("native.jsonl");
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::write(&config, "private-invalid-config").unwrap();
        fs::write(&script, include_bytes!("../../scripts/loongsuite-pilot.sh")).unwrap();
        for name in ["node", "nodejs", "systemctl", "launchctl", "crontab"] {
            let path = tools.join(name);
            fs::write(
                &path,
                "#!/bin/sh\nprintf '%s\\n' forbidden >> \"$PILOT_FORBIDDEN_LOG\"\nexit 99\n",
            )
            .unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let result = Self {
            _temporary: temporary,
            home,
            data,
            cache,
            config,
            script,
            tools,
            log,
        };
        result.platform("Darwin");
        result
    }
    fn platform(&self, platform: &str) {
        let path = self.tools.join("uname");
        fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{platform}'\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn install_at(&self, root: &Path) -> PathBuf {
        fs::create_dir_all(root.join("bin")).unwrap();
        let binary = root.join("bin/loongsuite-pilot");
        fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
        fs::write(root.join("runtime-manifest.json"), "{}").unwrap();
        binary
    }
    fn version(&self, name: &str) -> PathBuf {
        let binary = self.install_at(&self.cache.join("versions").join(name));
        fs::write(self.cache.join("current"), format!("{name}\n")).unwrap();
        binary
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("/bin/bash");
        command
            .arg(&self.script)
            .args(args)
            .env_clear()
            .current_dir(&self.home)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
            .env(
                "PATH",
                std::env::join_paths([
                    self.tools.as_path(),
                    Path::new("/usr/bin"),
                    Path::new("/bin"),
                ])
                .unwrap(),
            )
            .env("PILOT_FORBIDDEN_LOG", self.home.join("forbidden"))
            .env("PILOT_FIXTURE_MODE", "exit")
            .env("PILOT_FIXTURE_LOG", &self.log)
            .stdin(Stdio::null());
        command
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn records(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn no_lifecycle(&self) {
        assert!(
            !self.data.exists(),
            "read-only desktop routing created data/collector state"
        );
        assert!(
            !self.home.join("forbidden").exists(),
            "desktop entry invoked Node or a service manager"
        );
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
fn shortcut_l16_l44_current_native_versions_and_exact_trimmed_unicode_config_ignore_old_node_pins()
{
    let f = Fixture::new();
    let old = f.version("old");
    let new = f.version("new");
    let pin = format!("{}\n", old.display());
    fs::write(f.cache.join("node-bin"), &pin).unwrap();
    fs::write(f.config.parent().unwrap().join("node-bin"), &pin).unwrap();
    let config_before = fs::read(&f.config).unwrap();
    for (selected, enabled, disabled) in [("old", &old, &new), ("new", &new, &old)] {
        fs::set_permissions(enabled, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(disabled, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(f.cache.join("current"), selected).unwrap();
        for action in ["install", "status", "uninstall"] {
            let out = f
                .command(&["dashboard", "shortcut", action])
                .env(
                    "AGENT_DATA_COLLECTION_CONFIG",
                    format!("  {}  ", f.config.display()),
                )
                .output()
                .unwrap();
            success(&out);
            let records = f.records();
            let last = records.last().unwrap();
            assert_eq!(
                last["args"],
                serde_json::json!(["dashboard", "shortcut", action])
            );
            assert_eq!(last["config"], f.config.to_str().unwrap());
            assert_eq!(last["cache"], f.cache.to_str().unwrap());
            assert_eq!(last["data"], f.data.to_str().unwrap());
        }
    }
    assert_eq!(f.records().len(), 6);
    assert_eq!(fs::read(&f.config).unwrap(), config_before);
    assert_eq!(fs::read(f.cache.join("node-bin")).unwrap(), pin.as_bytes());
    assert_eq!(
        fs::read(f.config.parent().unwrap().join("node-bin")).unwrap(),
        pin.as_bytes()
    );
    f.no_lifecycle();
}
#[test]
fn shortcut_l68_missing_native_entry_rejects_legacy_and_corrupt_pointers_without_creating_state() {
    for scenario in ["missing", "legacy-js", "corrupt"] {
        let f = Fixture::new();
        if scenario == "legacy-js" {
            fs::create_dir_all(f.cache.join("package/dist")).unwrap();
            fs::write(
                f.cache.join("package/dist/index.js"),
                "throw new Error('must not execute old runtime')",
            )
            .unwrap();
            fs::write(
                f.cache.join("node-bin"),
                env!("CARGO_BIN_EXE_pilot-fixture"),
            )
            .unwrap();
        } else if scenario == "corrupt" {
            f.version("old");
            fs::write(f.cache.join("current"), "../foreign").unwrap();
        }
        let before = fs::read(&f.config).unwrap();
        let out = f.run(&["dashboard", "shortcut", "status"]);
        assert_eq!(out.status.code(), Some(1), "{scenario}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("binary not found"));
        assert!(f.records().is_empty());
        assert_eq!(fs::read(&f.config).unwrap(), before);
        f.no_lifecycle();
    }
}
#[test]
fn shortcut_l108_old_open_and_url_are_rejected_before_any_installation_runtime_or_config_access() {
    for action in ["open", "url"] {
        let f = Fixture::new();
        assert!(!f.cache.exists());
        let before = fs::read(&f.config).unwrap();
        let out = f.run(&["dashboard", action]);
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr)
            .contains("dashboard shortcut {install|status|uninstall}"));
        assert!(!f.cache.exists());
        assert!(f.records().is_empty());
        assert_eq!(fs::read(&f.config).unwrap(), before);
        f.no_lifecycle();
    }
}
#[test]
fn menubar_l56_current_native_start_and_stop_forward_default_config_and_separated_roots() {
    let f = Fixture::new();
    f.version("v1");
    for action in ["start", "stop"] {
        success(&f.run(&["menubar", action]));
        let records = f.records();
        let last = records.last().unwrap();
        assert_eq!(last["args"], serde_json::json!(["menubar", action]));
        assert_eq!(last["config"], f.data.join("config.json").to_str().unwrap());
        assert_eq!(last["data"], f.data.to_str().unwrap());
        assert_eq!(last["cache"], f.cache.to_str().unwrap());
    }
    f.no_lifecycle();
}
#[test]
fn menubar_l69_native_package_layout_propagates_real_child_exit() {
    let f = Fixture::new();
    f.install_at(&f.cache.join("package"));
    let out = f
        .command(&["menubar", "start"])
        .env("PILOT_FIXTURE_MODE", "restart-stderr")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));
    assert_eq!(
        f.records()[0]["args"],
        serde_json::json!(["menubar", "start"])
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("synthetic schtasks refusal"));
    f.no_lifecycle();
}
#[test]
fn menubar_l74_l85_native_source_build_is_used_only_without_installed_pointer_and_stale_js_never_runs(
) {
    let f = Fixture::new();
    fs::create_dir_all(f.home.join("src")).unwrap();
    fs::write(f.home.join("Cargo.toml"), "[package]\nname='fixture'\n").unwrap();
    fs::write(f.home.join("src/main.rs"), "fn main() {}").unwrap();
    let binary = f.home.join("target/debug/loongsuite-pilot");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
    success(&f.run(&["menubar", "--help"]));
    assert_eq!(
        f.records()[0]["args"],
        serde_json::json!(["menubar", "--help"])
    );
    fs::create_dir_all(&f.cache).unwrap();
    fs::write(f.cache.join("current"), "../foreign").unwrap();
    assert_eq!(f.run(&["menubar", "start"]).status.code(), Some(1));
    assert_eq!(
        f.records().len(),
        1,
        "corrupt installed pointer cannot fall back to workspace"
    );
    fs::remove_file(f.cache.join("current")).unwrap();
    fs::remove_file(&binary).unwrap();
    fs::create_dir_all(f.home.join("dist")).unwrap();
    fs::write(
        f.home.join("dist/index.js"),
        "throw new Error('legacy source must never start collector')",
    )
    .unwrap();
    fs::write(f.home.join("package.json"), "{}").unwrap();
    assert_eq!(f.run(&["menubar", "start"]).status.code(), Some(1));
    assert_eq!(f.records().len(), 1);
    assert!(!f.home.join("collector.lock").exists());
    f.no_lifecycle();
}
#[test]
fn menubar_l100_l107_unsupported_or_missing_runtime_exits_before_native_or_collector_start() {
    let f = Fixture::new();
    f.platform("Linux");
    let out = f.run(&["menubar", "start"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("only supported on macOS"));
    assert!(!f.cache.exists());
    assert!(f.records().is_empty());
    f.no_lifecycle();
    f.platform("Darwin");
    let out = f.run(&["menubar", "start"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("binary not found"));
    assert!(!f.cache.exists());
    assert!(f.records().is_empty());
    f.no_lifecycle();
}

#[test]
fn shortcut_l89_install_upgrade_and_collector_start_have_no_automatic_dock_or_shortcut_calls() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut sources = vec![root.join("deploy/installer-opensource.sh")];
    for module in ["src/core", "src/updater", "src/deployment"] {
        let mut queue = vec![root.join(module)];
        while let Some(path) = queue.pop() {
            if path.is_dir() {
                queue.extend(
                    fs::read_dir(path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push(path);
            }
        }
    }
    for path in sources {
        let source = fs::read_to_string(&path).unwrap();
        for forbidden in [
            "install_dashboard_app",
            "manage-dashboard-app",
            "manage-dashboard-shortcut",
            "shortcut install",
            "com.apple.dock",
        ] {
            assert!(
                !source.contains(forbidden),
                "{}: {forbidden}",
                path.display()
            );
        }
    }
    let shell = include_str!("../../scripts/loongsuite-pilot.sh");
    let start = shell
        .split_once("cmd_start()")
        .unwrap()
        .1
        .split_once("cmd_stop()")
        .unwrap()
        .0;
    assert!(!start.contains("shortcut") && !start.contains("com.apple.dock"));
    let public_cli = fs::read_to_string(root.join("src/cli_main.rs")).unwrap();
    assert_eq!(
        public_cli
            .matches("crate::cli::dashboard_shortcut::run(shortcut).await")
            .count(),
        1
    );
}
