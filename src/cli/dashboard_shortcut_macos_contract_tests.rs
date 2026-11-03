//! Physical macOS contracts: Foundation/AppKit/defaults/osascript/xattr are real.
//! Each test uses a disposable preferences domain and a private home. Neither the
//! active Dock nor the user's browser or Trash is modified.
use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::time::Instant;

const INITIAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>persistent-apps</key><array><dict><key>bookmark</key><data>AQIDBA==</data><key>GUID</key><integer>123</integer></dict></array>
<key>persistent-others</key><array><dict><key>tile-type</key><string>directory-tile</string><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file:///Users/test/Downloads/</string><key>bookmark</key><data>BQYHCA==</data></dict></dict></dict></array>
<key>autohide</key><true/><key>tilesize</key><integer>44</integer></dict></plist>"#;
const PRIVATE_SYSTEM: &str = r#"
function run(argv) {
  try {
    const input = JSON.parse(argv[0]);
    let faultInjected = false;
    const system = createMacSystem(input.domain, input.corruptAfterWrite ? {
      afterDockWrite: function (command, faultDomain, xmlString) {
        if (faultInjected) return;
        faultInjected = true;
        const unexpected = $({ 'tile-type': 'file-tile', 'tile-data': { 'file-data': {
          _CFURLString: 'file:///unexpected-entry', _CFURLStringType: 15 } } });
        command('/usr/bin/defaults', ['write', faultDomain, 'persistent-others', '-array', xmlString(unexpected)]);
      }
    } : null);
    system.homePath = input.home;
    system.refreshDock = function () { return true; };
    system.trashShortcut = function (path) {
      if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(path, input.home + '/trashed.webloc', null)) throw new Error('fixture trash failed');
    };
    return JSON.stringify({ ok: true, result: manageShortcut(input.request, system) });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message) }); }
}
"#;

async fn command_output(program: &str, args: &[&std::ffi::OsStr]) -> String {
    let mut command = tokio::process::Command::new(program);
    command.args(args);
    let output =
        crate::utils::candidate_process::output(&mut command, Duration::from_secs(5), 1024 * 1024)
            .await
            .unwrap();
    assert!(
        output.status.success(),
        "private macOS fixture command failed"
    );
    String::from_utf8(output.stdout).unwrap()
}

struct Fixture {
    root: tempfile::TempDir,
    domain: String,
    home: PathBuf,
    config: PathBuf,
    icon: PathBuf,
    initial: String,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        let domain = format!(
            "com.loongsuite-pilot.shortcut-test-{}",
            uuid::Uuid::new_v4()
        );
        let fixture = home.join("dock.plist");
        std::fs::write(&fixture, INITIAL).unwrap();
        command_output(
            "/usr/bin/defaults",
            &["import".as_ref(), domain.as_ref(), fixture.as_os_str()],
        )
        .await;
        let initial = command_output(
            "/usr/bin/defaults",
            &["export".as_ref(), domain.as_ref(), "-".as_ref()],
        )
        .await;
        let config = home.join("配置 ' $() ;/config.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "\u{feff}{\"dashboard\":{\"port\":9123}}").unwrap();
        let icon = home.join("package with spaces/assets/dashboard-shortcut/AppIcon.icns");
        std::fs::create_dir_all(icon.parent().unwrap()).unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/dashboard-shortcut/AppIcon.icns"),
            &icon,
        )
        .unwrap();
        Self {
            root,
            domain,
            home,
            config,
            icon,
            initial,
        }
    }

    fn base(&self) -> PathBuf {
        self.home
            .join("Library/Application Support/LoongSuite Pilot/Shortcuts")
    }

    fn shortcut(&self) -> PathBuf {
        self.base().join("LoongSuite Pilot Dashboard.webloc")
    }

    async fn export(&self) -> String {
        command_output(
            "/usr/bin/defaults",
            &["export".as_ref(), self.domain.as_ref(), "-".as_ref()],
        )
        .await
    }

    async fn run(&self, action: &str, corrupt_after_write: bool) -> Result<ShortcutResult, String> {
        let operation = uuid::Uuid::new_v4().to_string();
        let request = build_request(
            action,
            &self.config,
            &operation,
            (action == "install").then_some(self.icon.as_path()),
        )?;
        let input = json!({"domain":self.domain, "home":self.home,
            "request":request, "corruptAfterWrite":corrupt_after_write});
        let script = format!("{ADAPTER}\n{PRIVATE_SYSTEM}");
        let mut command = tokio::process::Command::new("/usr/bin/osascript");
        command
            .args(["-l", "JavaScript", "-e", &script])
            .arg(input.to_string());
        // Same production response parsing, process-tree ownership, timeout and lock cleanup.
        run_adapter(
            &mut command,
            action,
            &self.home,
            &operation,
            Duration::from_secs(20),
        )
        .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Cleanup also runs after assertion failures. This name is created by this
        // fixture, never com.apple.dock. Bound the cleanup child independently.
        let mut child = std::process::Command::new("/usr/bin/defaults")
            .args(["delete", &self.domain])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Keep ownership of the private root until preferences cleanup completes.
        assert!(self.root.path().exists());
    }
}

async fn within_original_budget(seconds: u64, body: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(seconds), body)
        .await
        .expect("original per-case native macOS contract budget");
}

#[tokio::test]
async fn physical_macos_roundtrips_plists_icons_ports_and_private_trash() {
    within_original_budget(30, async {
        let f = Fixture::new().await;
        let first = f.run("install", false).await.unwrap();
        assert!(first.changed);
        assert_eq!(first.dock_matches, 1);
        assert_eq!(
            std::fs::metadata(f.shortcut())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let backup = first.backup_path.unwrap();
        assert_eq!(
            std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(std::fs::read_to_string(backup)
            .unwrap()
            .contains("AQIDBA=="));
        assert!(
            command_output("/usr/bin/xattr", &[f.shortcut().as_os_str()])
                .await
                .contains("com.apple.ResourceFork")
        );
        let snapshot = f.export().await;
        assert!(snapshot.contains("BQYHCA=="));
        assert!(!f.run("install", false).await.unwrap().changed);
        assert_eq!(f.export().await, snapshot);
        assert_eq!(
            f.run("status", false).await.unwrap().url.as_deref(),
            Some("http://127.0.0.1:9123/")
        );
        std::fs::write(&f.config, "{\"dashboard\":{\"port\":9124}}").unwrap();
        assert!(f.run("install", false).await.unwrap().changed);
        assert_eq!(
            f.run("status", false).await.unwrap().url.as_deref(),
            Some("http://127.0.0.1:9124/")
        );
        assert_eq!(f.export().await, snapshot);
        let removed = f.run("uninstall", false).await.unwrap();
        assert!(!removed.exists);
        assert_eq!(removed.dock_matches, 0);
        assert!(!f.shortcut().exists());
        assert!(f.home.join("trashed.webloc").is_file());
        assert_eq!(f.export().await, f.initial);
        assert_eq!(
            std::fs::read_dir(f.base().join("Backups")).unwrap().count(),
            2
        );
        assert!(!f.run("uninstall", false).await.unwrap().changed);
    })
    .await;
}

#[tokio::test]
async fn physical_macos_preserves_foreign_files_and_symlink_parent_directories() {
    within_original_budget(15, async {
        let f = Fixture::new().await;
        std::fs::create_dir_all(f.base()).unwrap();
        std::fs::write(f.shortcut(), "user content").unwrap();
        assert!(f.run("install", false).await.is_err());
        assert_eq!(
            std::fs::read_to_string(f.shortcut()).unwrap(),
            "user content"
        );
        assert_eq!(f.export().await, f.initial);
        std::fs::remove_dir_all(f.base()).unwrap();
        let outside = f.home.join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, f.base()).unwrap();
        assert!(f.run("install", false).await.is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
        assert_eq!(f.export().await, f.initial);
    })
    .await;
}

#[tokio::test]
async fn physical_macos_locked_dock_allows_status_and_refuses_mutation() {
    within_original_budget(15, async {
        let f = Fixture::new().await;
        command_output(
            "/usr/bin/defaults",
            &[
                "write".as_ref(),
                f.domain.as_ref(),
                "contents-immutable".as_ref(),
                "-bool".as_ref(),
                "true".as_ref(),
            ],
        )
        .await;
        let before = f.export().await;
        let result = f.run("status", false).await.unwrap();
        assert!(result.dock_locked);
        assert!(!result.exists);
        assert!(f.run("install", false).await.is_err());
        assert!(!f.shortcut().exists());
        assert_eq!(f.export().await, before);
    })
    .await;
}

#[tokio::test]
async fn physical_macos_failed_post_write_verification_restores_files_area_and_unlocks() {
    within_original_budget(15, async {
        let f = Fixture::new().await;
        let error = f.run("install", true).await.unwrap_err();
        assert!(error.contains("previous files-area layout was restored"));
        assert_eq!(f.export().await, f.initial);
        assert!(!f.base().join("Operation.lock").exists());
    })
    .await;
}

#[tokio::test]
async fn physical_macos_native_requests_work_without_node_build_output_or_dependencies() {
    within_original_budget(30, async {
        let f = Fixture::new().await;
        let package = f.icon.parent().unwrap().parent().unwrap().parent().unwrap();
        assert!(!package.join("node_modules").exists());
        assert!(!package.join("dist").exists());
        assert!(!package.join("src").exists());
        std::fs::write(&f.config, "\u{feff}{\"dashboard\":{\"port\":9130}}").unwrap();
        let first = f.run("install", false).await.unwrap();
        assert_eq!(first.url.as_deref(), Some("http://127.0.0.1:9130/"));
        assert!(display(&first, "install", false)
            .0
            .contains("http://127.0.0.1:9130/"));
        let snapshot = f.export().await;
        std::fs::write(&f.config, "{\"dashboard\":{\"port\":9131}}").unwrap();
        assert_eq!(
            f.run("status", false).await.unwrap().url.as_deref(),
            Some("http://127.0.0.1:9130/")
        );
        assert_eq!(
            f.run("install", false).await.unwrap().url.as_deref(),
            Some("http://127.0.0.1:9131/")
        );
        assert_eq!(f.export().await, snapshot);
        std::fs::remove_file(&f.config).unwrap();
        std::fs::remove_file(&f.icon).unwrap();
        assert_eq!(
            f.run("status", false).await.unwrap().url.as_deref(),
            Some("http://127.0.0.1:9131/")
        );
        let removed = f.run("uninstall", false).await.unwrap();
        assert!(display(&removed, "uninstall", false)
            .0
            .contains("Shortcut: not installed"));
        assert_eq!(f.export().await, f.initial);
    })
    .await;
}

#[tokio::test]
async fn physical_macos_foreign_operation_lock_and_owner_are_preserved() {
    within_original_budget(15, async {
        let f = Fixture::new().await;
        let lock = f.base().join("Operation.lock");
        std::fs::create_dir_all(&lock).unwrap();
        std::fs::write(lock.join("Owner"), "foreign-operation").unwrap();
        let error = f.run("install", false).await.unwrap_err();
        assert!(error.contains("Another shortcut command"));
        assert!(!f.shortcut().exists());
        assert!(lock.is_dir());
        assert_eq!(
            std::fs::read_to_string(lock.join("Owner")).unwrap(),
            "foreign-operation"
        );
        assert_eq!(f.export().await, f.initial);
    })
    .await;
}
