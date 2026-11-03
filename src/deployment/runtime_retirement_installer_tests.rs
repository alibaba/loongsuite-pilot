//! Actual native installer controller entry with isolated retirement backend.
//! Candidate is an explicit subprocess protocol fixture, not a real publication.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;

#[derive(Default)]
struct Fake {
    env: Mutex<BTreeMap<String, String>>,
    calls: Mutex<Vec<Command>>,
    guard: Mutex<Option<(PathBuf, String, PathBuf)>>,
    fail_unset: Mutex<Option<(String, PathBuf)>>,
    warnings: Mutex<Vec<(String, Value)>>,
}
impl Backend for Fake {
    fn run(&self, cmd: Command) -> BoxFut<Result<String, String>> {
        if let Some((current, name, service)) = &*self.guard.lock().unwrap() {
            assert_eq!(fs::read_to_string(current).unwrap().trim(), name);
            assert!(
                service.is_file(),
                "retirement must follow committed native publication"
            );
        }
        assert_eq!(cmd.program, "launchctl");
        self.calls.lock().unwrap().push(cmd.clone());
        let result = match cmd.args[0].as_str() {
            "getenv" => self
                .env
                .lock()
                .unwrap()
                .get(&cmd.args[1])
                .map(|v| format!("{v}\n"))
                .ok_or("absent".into()),
            "unsetenv" => {
                let attempt = self
                    .fail_unset
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|(name, _)| name == &cmd.args[1])
                    .map(|(_, path)| fs::write(path, "registry deletion fixture"))
                    .transpose();
                match attempt {
                    Err(error) => Err(error.to_string()),
                    Ok(_) => {
                        self.env.lock().unwrap().remove(&cmd.args[1]);
                        Ok(String::new())
                    }
                }
            }
            "unload" => Ok(String::new()),
            _ => panic!("cleanup must never inject/load an override: {cmd:?}"),
        };
        Box::pin(async move { result })
    }
    fn warn(&self, message: &str, fields: Value) {
        self.warnings.lock().unwrap().push((message.into(), fields));
    }
}
struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    bin: PathBuf,
    backend: Arc<Fake>,
}
impl Fixture {
    fn new(home: &Path) -> Self {
        let root = tempfile::tempdir_in(home).unwrap();
        let data = root.path().join("custom data");
        let cache = root.path().join("cache");
        let bin = root.path().join("bin");
        fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();
        Self {
            root,
            home: home.into(),
            data,
            cache,
            bin,
            backend: Arc::new(Fake::default()),
        }
    }
    fn context(&self) -> Context {
        Context {
            host: Host::Mac,
            home: self.home.clone(),
            backend: self.backend.clone(),
        }
    }
    fn service(&self) -> PathBuf {
        self.bin.join(if cfg!(windows) {
            "loongsuite-pilot-service.ps1"
        } else {
            "loongsuite-pilot"
        })
    }
    fn wrapper(&self) -> String {
        wrapper(&self.data.to_string_lossy())
    }
    fn seed_env(&self) {
        for def in MAC_DEFS {
            self.backend
                .env
                .lock()
                .unwrap()
                .insert(def.env_name.into(), self.wrapper());
        }
    }
    fn package(&self, commit: char) -> PathBuf {
        use crate::utils::runtime_paths::{build_edition, build_target, sha256_file};
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        let source = self.root.path().join(format!("candidate {commit}"));
        for path in ["bin", "scripts", "agents.d", "assets"] {
            fs::create_dir_all(source.join(path)).unwrap();
        }
        let git = commit.to_string().repeat(40);
        let version = env!("CARGO_PKG_VERSION");
        let report=json!({"schema":1,"ok":true,"runtime":"rust","version":version,"target":build_target(),"edition":build_edition(),"check":{"details":{"gitCommit":git}}}).to_string();
        let binary_relative = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        let binary = source.join(binary_relative);
        fs::copy(
            std::env::var_os("PILOT_RUNTIME_RETIRE_NATIVE_FIXTURE").unwrap(),
            &binary,
        )
        .unwrap();
        #[cfg(unix)]
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(source.join("assets/protocol-report.json"), report).unwrap();
        fs::write(source.join("assets/protocol-version.txt"), version).unwrap();
        for (path, body) in [
            (
                "agents.d/cursor-cli.json",
                include_str!("../../agents.d/cursor-cli.json").to_string(),
            ),
            (
                "scripts/loongsuite-pilot.sh",
                "#!/bin/bash\nexit 0\n".into(),
            ),
            (
                "scripts/loongsuite-pilot.ps1",
                "# inert candidate protocol fixture\n".into(),
            ),
            ("assets/fixture", "fixture asset".into()),
            ("LICENSE", "fixture license".into()),
            ("VERSION", format!("version={version}\ngit_commit={git}\n")),
        ] {
            fs::write(source.join(path), body).unwrap();
        }
        let resources=walkdir::WalkDir::new(&source).into_iter().map(Result::unwrap).filter(|e|e.file_type().is_file())
            .map(|e|json!({"path":e.path().strip_prefix(&source).unwrap().to_str().unwrap().replace('\\', "/"),"sha256":sha256_file(e.path()).unwrap()})).collect::<Vec<_>>();
        fs::write(source.join("runtime-manifest.json"),json!({"schema":1,"runtime":"rust","version":version,"gitCommit":git,"target":build_target(),"edition":build_edition(),"binary":binary_relative,"resources":resources}).to_string()).unwrap();
        source
    }
    fn options(&self, source: &Path) -> Value {
        json!({"sourceDir":source,"cacheDir":self.cache,"dataDir":self.data,"configPath":self.data.join("config.json"),"binDir":self.bin})
    }
    async fn publish(&self, commit: char) -> String {
        let source = self.package(commit);
        fs::create_dir_all(&self.data).unwrap();
        fs::write(self.data.join("config.json"), "{}").unwrap();
        let before = self.backend.calls.lock().unwrap().len();
        let name = super::super::native_install::run_with_retirement(
            "stage-package",
            self.options(&source),
            self.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            self.backend.calls.lock().unwrap().len(),
            before,
            "staging has no retirement side effects"
        );
        let staged = self.cache.join("versions").join(&name);
        *self.backend.guard.lock().unwrap() =
            Some((self.cache.join("current"), name.clone(), self.service()));
        super::super::native_install::run_with_retirement(
            "publish-package",
            self.options(&staged),
            self.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(self.cache.join("current"))
                .unwrap()
                .trim(),
            name
        );
        name
    }
    fn queries(&self) -> usize {
        self.backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.args[0] == "getenv")
            .count()
    }
}
#[tokio::test]
async fn installer_l333_actual_install_upgrade_uninstall_entries_retire_once_at_the_correct_phase()
{
    if std::env::var_os(CHILD).is_some() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let f = Fixture::new(&home);
        f.seed_env();
        let first = f.publish('a').await;
        assert_eq!(
            f.queries(),
            2,
            "the actual native install publication must retire both overrides exactly once"
        );
        assert!(f.backend.env.lock().unwrap().is_empty());
        f.seed_env();
        let second = f.publish('b').await;
        assert_ne!(first, second);
        assert_eq!(
            f.queries(),
            4,
            "the actual native upgrade publication must retire exactly once"
        );
        assert!(f.backend.env.lock().unwrap().is_empty());
        f.seed_env();
        super::super::native_uninstall::run_with_retirement(
            json!({"dataDir":f.data,"pilotDir":env!("CARGO_MANIFEST_DIR"),"checkOnly":true}),
            f.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            f.queries(),
            4,
            "uninstall preflight must not retire anything"
        );
        super::super::native_uninstall::run_with_retirement(
            json!({"dataDir":f.data,"pilotDir":env!("CARGO_MANIFEST_DIR")}),
            f.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            f.queries(),
            6,
            "actual native uninstall must retire before runtime files can be removed"
        );
        assert!(f.backend.env.lock().unwrap().is_empty());
        assert!(f.cache.join("current").is_file());
        return;
    }
    isolated_entry("deployment::runtime_retirement::installer_history_tests::installer_l333_actual_install_upgrade_uninstall_entries_retire_once_at_the_correct_phase").await;
}

const CHILD: &str = "PILOT_NATIVE_RUNTIME_RETIRE_ENTRY_CHILD";
async fn isolated_entry(test: &str) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    let fixture_source = home.path().join("candidate_protocol.rs");
    fs::write(&fixture_source, r#"fn main() {
        let root = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_owned();
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["--version"] => println!("loongsuite-pilot {}", std::fs::read_to_string(root.join("assets/protocol-version.txt")).unwrap()),
            ["check", "--json"] => println!("{}", std::fs::read_to_string(root.join("assets/protocol-report.json")).unwrap()),
            _ => std::process::exit(79),
        }
    }"#).unwrap();
    let native_fixture = home.path().join(if cfg!(windows) {
        "candidate-protocol.exe"
    } else {
        "candidate-protocol"
    });
    let mut compiler =
        std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));
    compiler
        .arg("--edition=2021")
        .arg("--target")
        .arg(crate::utils::runtime_paths::build_target())
        .arg(&fixture_source)
        .arg("-o")
        .arg(&native_fixture);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        compiler.creation_flags(0x0800_0000);
    }
    let compiled = compiler.output().unwrap();
    assert!(
        compiled.status.success(),
        "isolated native protocol fixture compile failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env_clear()
        .env(CHILD, "1")
        .env("PILOT_RUNTIME_RETIRE_NATIVE_FIXTURE", &native_fixture)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("APPDATA", home.path().join("appdata"))
        .env("LOCALAPPDATA", home.path().join("localappdata"))
        .env(
            "PATH",
            if cfg!(windows) {
                PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                    .join("System32")
                    .into_os_string()
            } else {
                "/usr/bin:/bin".into()
            },
        )
        .env("TMPDIR", home.path())
        .env("TMP", home.path())
        .env("TEMP", home.path())
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .env("XDG_DATA_HOME", home.path().join("data"))
        .env("XDG_CACHE_HOME", home.path().join("cache"))
        .current_dir(home.path())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
        for key in [
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "PATHEXT",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "isolated native entry contract failed:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

impl Fixture {
    fn plist(&self, def: &Definition) -> PathBuf {
        self.home
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", def.plist_label.unwrap()))
    }
    fn seed_plists(&self) {
        for def in MAC_DEFS {
            fs::write(self.plist(&def), historical(&def, &self.wrapper())).unwrap();
        }
    }
    fn install_wrapper(&self) {
        fs::create_dir_all(self.data.join("hooks")).unwrap();
        fs::write(self.wrapper(), "// shared runtime wrapper\n").unwrap();
    }
    fn count(&self, op: &str) -> usize {
        self.backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.args[0] == op)
            .count()
    }
    fn assert_retired(&self) {
        assert!(self.backend.env.lock().unwrap().is_empty());
        for def in MAC_DEFS {
            assert!(!self.plist(&def).exists());
        }
        assert!(self
            .backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|c| matches!(c.args[0].as_str(), "getenv" | "unsetenv" | "unload")));
    }
}
fn historical(def: &Definition, wrapper: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{}</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>{}</string><string>{}</string></array>
<key>RunAtLoad</key><true/></dict></plist>
"#,
        def.plist_label.unwrap(),
        def.env_name,
        xml(wrapper)
    )
}
#[tokio::test]
async fn installer_l238_all_six_selection_rows_retire_real_owned_files_without_touching_wrapper() {
    for selection in [
        Some("qoder-work"),
        Some("qoder-work-cn"),
        Some("qwen-work-cn"),
        Some("qoder-work,qoder-work-cn,qwen-work-cn"),
        Some(""),
        None,
    ] {
        let home = tempfile::tempdir().unwrap();
        let f = Fixture::new(home.path());
        f.install_wrapper();
        f.seed_env();
        f.seed_plists();
        fs::write(
            f.data.join("config.json"),
            json!({"selection":selection}).to_string(),
        )
        .unwrap();
        for app in ["QoderWork.app", "QoderWorkCN.app", "QwenWorkCN.app"] {
            fs::create_dir_all(f.home.join("Applications").join(app)).unwrap();
        }
        cleanup_all(&f.data.to_string_lossy(), &f.context())
            .await
            .unwrap();
        f.assert_retired();
        assert_eq!(f.count("unsetenv"), 2);
        assert_eq!(f.count("unload"), 2);
        assert_eq!(
            fs::read_to_string(f.wrapper()).unwrap(),
            "// shared runtime wrapper\n"
        );
    }
}
#[tokio::test]
async fn installer_l248_all_three_legacy_path_rows_use_only_the_known_old_home_directory() {
    for legacy in ["both", "qoder", "qwen"] {
        let home = tempfile::tempdir().unwrap();
        let f = Fixture::new(home.path());
        f.install_wrapper();
        let old = wrapper(&f.home.join(".loongsuite-pilot").to_string_lossy());
        for (index, def) in MAC_DEFS.iter().enumerate() {
            let path = if legacy == "both" || legacy == if index == 0 { "qoder" } else { "qwen" } {
                old.clone()
            } else {
                f.wrapper()
            };
            f.backend
                .env
                .lock()
                .unwrap()
                .insert(def.env_name.into(), path.clone());
            fs::write(f.plist(def), historical(def, &path)).unwrap();
        }
        cleanup_all(&f.data.to_string_lossy(), &f.context())
            .await
            .unwrap();
        f.assert_retired();
        assert!(Path::new(&f.wrapper()).is_file());
    }
}
#[tokio::test]
async fn installer_l256_no_apps_config_data_directory_or_wrapper_is_required() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.seed_env();
    f.seed_plists();
    assert!(!f.data.exists());
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    f.assert_retired();
    assert!(!f.data.exists());
    assert_eq!(f.count("unsetenv"), 2);
}
#[tokio::test]
async fn installer_l262_missing_launchagents_directory_does_not_block_env_cleanup_or_get_created() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.install_wrapper();
    f.seed_env();
    fs::remove_dir_all(f.home.join("Library")).unwrap();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    assert!(f.backend.env.lock().unwrap().is_empty());
    assert_eq!(f.count("unsetenv"), 2);
    assert_eq!(f.count("unload"), 0);
    assert!(!f.home.join("Library").exists());
    assert!(Path::new(&f.wrapper()).is_file());
}
#[tokio::test]
async fn installer_l273_foreign_env_and_plist_survive_while_verified_pilot_plists_retire() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.install_wrapper();
    f.seed_plists();
    let foreign = vec![
        f.home
            .join("other data/hooks/qoderwork-runtime-wrapper.mjs")
            .to_string_lossy()
            .into_owned(),
        format!("{}.third-party", f.wrapper()),
    ];
    for (def, path) in MAC_DEFS.iter().zip(&foreign) {
        f.backend
            .env
            .lock()
            .unwrap()
            .insert(def.env_name.into(), path.clone());
    }
    let other = f
        .home
        .join("Library/LaunchAgents/com.third-party.runtime.plist");
    fs::write(&other, "third-party plist").unwrap();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    for (def, path) in MAC_DEFS.iter().zip(&foreign) {
        assert_eq!(f.backend.env.lock().unwrap().get(def.env_name), Some(path));
        assert!(!f.plist(def).exists());
    }
    assert_eq!(f.count("unsetenv"), 0);
    assert_eq!(f.count("unload"), 2);
    assert_eq!(fs::read_to_string(other).unwrap(), "third-party plist");
    assert!(Path::new(&f.wrapper()).is_file());
}
#[tokio::test]
async fn installer_l288_each_mixed_ownership_row_retires_only_the_exact_owned_env() {
    for owned in [0, 1] {
        let home = tempfile::tempdir().unwrap();
        let f = Fixture::new(home.path());
        f.seed_plists();
        for (index, def) in MAC_DEFS.iter().enumerate() {
            f.backend.env.lock().unwrap().insert(
                def.env_name.into(),
                if index == owned {
                    f.wrapper()
                } else {
                    "/third-party/runtime.mjs".into()
                },
            );
        }
        cleanup_all(&f.data.to_string_lossy(), &f.context())
            .await
            .unwrap();
        assert_eq!(f.count("unsetenv"), 1);
        let env = f.backend.env.lock().unwrap();
        assert_eq!(env.len(), 1);
        assert_eq!(
            env.get(MAC_DEFS[1 - owned].env_name).unwrap(),
            "/third-party/runtime.mjs"
        );
    }
}
#[tokio::test]
async fn installer_l296_repeated_retirement_tolerates_absent_getenv_and_is_idempotent() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.install_wrapper();
    f.seed_env();
    f.seed_plists();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    f.assert_retired();
    assert_eq!(
        (f.count("getenv"), f.count("unsetenv"), f.count("unload")),
        (4, 2, 2)
    );
    f.backend.calls.lock().unwrap().clear();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    assert_eq!(
        (f.count("getenv"), f.count("unsetenv"), f.count("unload")),
        (2, 0, 0)
    );
    assert!(Path::new(&f.wrapper()).is_file());
}
#[tokio::test]
async fn installer_l309_owned_stale_plists_retire_when_both_overrides_are_already_absent() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.install_wrapper();
    f.seed_plists();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    f.assert_retired();
    assert_eq!(f.count("unsetenv"), 0);
    assert_eq!(f.count("unload"), 2);
    assert!(Path::new(&f.wrapper()).is_file());
}
#[tokio::test]
async fn installer_l316_linux_host_is_a_true_env_file_and_command_noop() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.install_wrapper();
    f.seed_env();
    f.seed_plists();
    let env = f.backend.env.lock().unwrap().clone();
    let files = MAC_DEFS.map(|def| fs::read(f.plist(&def)).unwrap());
    let mut context = f.context();
    context.host = Host::Other;
    cleanup_all(&f.data.to_string_lossy(), &context)
        .await
        .unwrap();
    assert_eq!(*f.backend.env.lock().unwrap(), env);
    assert!(f.backend.calls.lock().unwrap().is_empty());
    for (def, before) in MAC_DEFS.iter().zip(files) {
        assert_eq!(fs::read(f.plist(def)).unwrap(), before);
    }
    assert!(Path::new(&f.wrapper()).is_file());
}
#[tokio::test]
async fn installer_l325_no_active_injector_probe_selection_or_wrapper_file_gate_and_no_script_bypass(
) {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    f.seed_env();
    f.seed_plists();
    fs::write(
        f.home.join("config.json"),
        "broken config, not an input to retirement",
    )
    .unwrap();
    assert!(!f.data.exists());
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    f.assert_retired();
    assert!(!f.data.exists());
    assert_eq!(
        fs::read_to_string(f.home.join("config.json")).unwrap(),
        "broken config, not an input to retirement"
    );
    let component = include_str!("runtime_retirement.rs");
    for forbidden in ["SELECTED_AGENTS", "Applications", "config.json"] {
        assert!(!component.contains(forbidden));
    }
    for bootstrap in [
        include_str!("../../deploy/installer-opensource.sh"),
        include_str!("../../deploy/installer-opensource.ps1"),
    ] {
        assert!(!bootstrap.contains("QODER_WORKER_RUNTIME_PATH"));
        assert!(!bootstrap.contains("retire_qoderwork_runtime_overrides"));
        assert!(!bootstrap.contains("Retire-PilotRuntimeOverride"));
        assert!(bootstrap.contains("publish-package"));
        assert!(bootstrap.contains("cleanup-agents"));
    }
}
#[tokio::test]
async fn ownership_pilot_word_or_known_filename_alone_cannot_authorize_installer_deletion() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::new(home.path());
    for def in MAC_DEFS {
        f.backend.env.lock().unwrap().insert(
            def.env_name.into(),
            f.home
                .join("vendor-loongsuite-pilot/runtime.mjs")
                .to_string_lossy()
                .into_owned(),
        );
        fs::write(f.plist(&def), "foreign content under known filename").unwrap();
    }
    let before = f.backend.env.lock().unwrap().clone();
    cleanup_all(&f.data.to_string_lossy(), &f.context())
        .await
        .unwrap();
    assert_eq!(*f.backend.env.lock().unwrap(), before);
    assert_eq!(f.count("unsetenv"), 0);
    assert_eq!(f.count("unload"), 0);
    for def in MAC_DEFS {
        assert_eq!(
            fs::read_to_string(f.plist(&def)).unwrap(),
            "foreign content under known filename"
        );
    }
    assert_eq!(f.backend.warnings.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn failure_post_commit_publication_and_rollback_remain_committed_visible_and_retryable() {
    if std::env::var_os(CHILD).is_some() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let f = Fixture::new(&home);
        f.install_wrapper();
        f.seed_env();
        let denied = f.root.path().join("delete-denied-directory");
        fs::create_dir(&denied).unwrap();
        *f.backend.fail_unset.lock().unwrap() = Some((MAC_DEFS[0].env_name.into(), denied.clone()));
        let first = f.publish('a').await;
        assert_eq!(f.backend.env.lock().unwrap().len(), 1);
        assert_eq!(f.queries(), 2);
        assert!(f.service().is_file());
        *f.backend.fail_unset.lock().unwrap() = None;
        let second = f.publish('b').await;
        assert_ne!(first, second);
        assert!(f.backend.env.lock().unwrap().is_empty());
        f.seed_env();
        *f.backend.fail_unset.lock().unwrap() = Some((MAC_DEFS[0].env_name.into(), denied));
        *f.backend.guard.lock().unwrap() =
            Some((f.cache.join("current"), first.clone(), f.service()));
        super::super::native_install::run_with_retirement(
            "rollback-package",
            f.options(&f.cache.join("versions").join(&first)),
            f.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(f.cache.join("current")).unwrap().trim(),
            first
        );
        assert_eq!(f.backend.env.lock().unwrap().len(), 1);
        *f.backend.fail_unset.lock().unwrap() = None;
        *f.backend.guard.lock().unwrap() =
            Some((f.cache.join("current"), second.clone(), f.service()));
        super::super::native_install::run_with_retirement(
            "rollback-package",
            f.options(&f.cache.join("versions").join(&second)),
            f.context(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(f.cache.join("current")).unwrap().trim(),
            second
        );
        assert!(f.backend.env.lock().unwrap().is_empty());
        assert!(Path::new(&f.wrapper()).is_file());
        return;
    }
    let out=isolated_entry("deployment::runtime_retirement::installer_history_tests::failure_post_commit_publication_and_rollback_remain_committed_visible_and_retryable").await;
    assert_eq!(
        String::from_utf8_lossy(&out.stderr)
            .matches("post-commit cleanup failed; native publication remains committed")
            .count(),
        2
    );
    let logs = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| v["phase"] == "post-commit")
        .collect::<Vec<_>>();
    assert_eq!(logs.len(), 2);
    assert!(logs
        .iter()
        .all(|v| v["publicationCommitted"] == true && v["level"] == "WARN"));
}
#[tokio::test]
async fn failure_uninstall_diagnoses_before_runtime_removal_and_can_retry_remaining_env() {
    if std::env::var_os(CHILD).is_some() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let f = Fixture::new(&home);
        f.install_wrapper();
        f.publish('a').await;
        f.seed_env();
        let denied = f.root.path().join("delete-denied-directory");
        fs::create_dir(&denied).unwrap();
        *f.backend.fail_unset.lock().unwrap() = Some((MAC_DEFS[0].env_name.into(), denied));
        let options = json!({"dataDir":f.data,"pilotDir":env!("CARGO_MANIFEST_DIR")});
        let error =
            super::super::native_uninstall::run_with_retirement(options.clone(), f.context())
                .await
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("installation files were preserved"));
        assert!(f.cache.join("current").is_file());
        assert!(f.service().is_file());
        assert!(Path::new(&f.wrapper()).is_file());
        assert_eq!(f.backend.env.lock().unwrap().len(), 1);
        *f.backend.fail_unset.lock().unwrap() = None;
        super::super::native_uninstall::run_with_retirement(options, f.context())
            .await
            .unwrap();
        assert!(f.backend.env.lock().unwrap().is_empty());
        return;
    }
    let out=isolated_entry("deployment::runtime_retirement::installer_history_tests::failure_uninstall_diagnoses_before_runtime_removal_and_can_retry_remaining_env").await;
    assert!(String::from_utf8_lossy(&out.stderr)
        .contains("uninstall cleanup failed; installation files preserved for retry"));
    let logs = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| v["phase"] == "before-runtime-removal")
        .collect::<Vec<_>>();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0]["level"], "ERROR");
}

#[path = "runtime_uninstall_history_contract_tests.rs"]
mod uninstall_history_contract_tests;

#[path = "runtime_retirement_windows_history_tests.rs"]
mod windows_history_tests;
