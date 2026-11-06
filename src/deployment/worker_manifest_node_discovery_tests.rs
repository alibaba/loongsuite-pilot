use super::*;
use std::ffi::OsString;
use std::path::PathBuf;

struct World {
    _root: tempfile::TempDir,
    bundle: PathBuf,
    cwd: PathBuf,
    host: PathBuf,
}
impl World {
    fn new() -> Self {
        // Keep hardlink controls on the same volume as the actual Pilot test exe.
        let pilot = std::env::current_exe().unwrap();
        let root = tempfile::tempdir_in(pilot.parent().unwrap()).unwrap();
        let bundle = root.path().join("bundle");
        let cwd = root.path().join("worker-cwd");
        let host = root.path().join("host 工具🚀");
        for path in [&bundle, &cwd, &host] {
            std::fs::create_dir(path).unwrap();
        }
        Self {
            _root: root,
            bundle,
            cwd,
            host,
        }
    }
    fn node_in(&self, directory: &Path) -> PathBuf {
        let node = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
        // This file exercises selection policy only, not a fake Node acceptance.
        // Actual Node execution belongs to test:host:node-worker.
        std::fs::write(&node, b"fixture-runtime").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        node
    }
    fn path(&self, paths: &[&Path]) -> OsString {
        std::env::join_paths(paths).unwrap()
    }
    fn resolve(
        &self,
        configured: &str,
        path: Option<&std::ffi::OsStr>,
    ) -> Result<String, (&'static str, String)> {
        resolve_external_node(
            configured,
            path,
            self.bundle.to_str().unwrap(),
            self.cwd.to_str().unwrap(),
        )
    }
}

#[test]
fn external_node_discovery_uses_absolute_host_path_in_order_without_executing_candidates() {
    let world = World::new();
    let node = world.node_in(&world.host);
    let later = world._root.path().join("later");
    std::fs::create_dir(&later).unwrap();
    world.node_in(&later);
    let path = world.path(&[
        Path::new(""),
        Path::new("."),
        Path::new("relative"),
        &world.host,
        &later,
    ]);
    assert_eq!(
        Path::new(&world.resolve("", Some(&path)).unwrap()),
        std::fs::canonicalize(node).unwrap()
    );
}

#[test]
fn explicit_node_override_is_authoritative_even_with_a_usable_host_fallback() {
    let world = World::new();
    world.node_in(&world.host);
    let path = world.path(&[&world.host]);
    let configured = world._root.path().join("configured node");
    std::fs::write(
        &configured,
        "explicit file retains the original isFile contract",
    )
    .unwrap();
    assert_eq!(
        world
            .resolve(configured.to_str().unwrap(), Some(&path))
            .unwrap(),
        configured.to_str().unwrap()
    );
    for invalid in [
        PathBuf::from("relative-node"),
        world._root.path().join("missing"),
        world.bundle.clone(),
        std::env::current_exe().unwrap(),
    ] {
        assert_eq!(
            world
                .resolve(invalid.to_str().unwrap(), Some(&path))
                .unwrap_err()
                .0,
            "WorkerManifestPlaceholderInvalid"
        );
    }
}

#[test]
fn external_node_discovery_never_searches_bundle_cwd_or_relative_path_components() {
    let world = World::new();
    world.node_in(&world.bundle);
    world.node_in(&world.cwd);
    let path = world.path(&[
        Path::new(""),
        Path::new("."),
        Path::new("relative"),
        &world.bundle,
        &world.cwd,
    ]);
    assert!(world.resolve("", Some(&path)).is_err());
    let error = world.resolve("", None).unwrap_err();
    assert_eq!(error.0, "WorkerManifestPlaceholderInvalid");
    assert!(error.1.contains("Node"));
}

#[test]
fn external_node_discovery_rejects_pilot_hardlinks_in_fallback_and_explicit_override() {
    let world = World::new();
    let alias = world
        .host
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    std::fs::hard_link(std::env::current_exe().unwrap(), &alias).unwrap();
    let path = world.path(&[&world.host]);
    assert!(world.resolve("", Some(&path)).is_err());
    assert!(world.resolve(alias.to_str().unwrap(), Some(&path)).is_err());
    let later = world._root.path().join("later");
    std::fs::create_dir(&later).unwrap();
    let node = world.node_in(&later);
    let path = world.path(&[&world.host, &later]);
    assert_eq!(
        Path::new(&world.resolve("", Some(&path)).unwrap()),
        std::fs::canonicalize(node).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn external_node_discovery_rejects_pilot_symlinks_and_non_executable_path_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let world = World::new();
    let alias = world.host.join("node");
    symlink(std::env::current_exe().unwrap(), &alias).unwrap();
    let path = world.path(&[&world.host]);
    assert!(world.resolve("", Some(&path)).is_err());
    assert!(world.resolve(alias.to_str().unwrap(), Some(&path)).is_err());
    std::fs::remove_file(&alias).unwrap();
    let node = world.node_in(&world.host);
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(world.resolve("", Some(&path)).is_err());
}

#[tokio::test]
async fn external_node_resolution_does_not_use_manifest_path_or_change_native_commands() {
    let world = World::new();
    world.node_in(&world.host);
    let supervisor = WorkerManifestSupervisor::with_platform(
        if cfg!(windows) {
            "win32"
        } else {
            std::env::consts::OS
        },
        "",
    );
    let options = WorkerManifestOptions::default();
    let mut manifest: WorkerManifest = serde_json::from_value(json!({
        "name":"host-boundary",
        "command":["${pilot:node}","entry.mjs","保留 空格🚀"],
        "env":{"PATH":world.host.to_str().unwrap()}
    }))
    .unwrap();
    assert!(supervisor
        .resolve_command_with_host_path(
            world.bundle.to_str().unwrap(),
            world.cwd.to_str().unwrap(),
            &manifest,
            &options,
            None
        )
        .await
        .is_err());
    manifest.command[0] = "${pilot:binary}".into();
    let (binary, args) = supervisor
        .resolve_command_with_host_path(
            world.bundle.to_str().unwrap(),
            world.cwd.to_str().unwrap(),
            &manifest,
            &options,
            None,
        )
        .await
        .unwrap();
    assert_eq!(Path::new(&binary), std::env::current_exe().unwrap());
    assert_eq!(args, ["entry.mjs", "保留 空格🚀"]);
    manifest.command[0] = "native-worker".into();
    assert_eq!(
        supervisor
            .resolve_command_with_host_path(
                world.bundle.to_str().unwrap(),
                world.cwd.to_str().unwrap(),
                &manifest,
                &options,
                None
            )
            .await
            .unwrap()
            .0,
        "native-worker"
    );
    let path = world.path(&[&world.host]);
    manifest.command[0] = "${pilot:node}".into();
    let (binary, args) = supervisor
        .resolve_command_with_host_path(
            world.bundle.to_str().unwrap(),
            world.cwd.to_str().unwrap(),
            &manifest,
            &options,
            Some(&path),
        )
        .await
        .unwrap();
    assert_eq!(
        Path::new(&binary),
        std::fs::canonicalize(
            world
                .host
                .join(if cfg!(windows) { "node.exe" } else { "node" })
        )
        .unwrap()
    );
    assert_eq!(args, ["entry.mjs", "保留 空格🚀"]);
}
