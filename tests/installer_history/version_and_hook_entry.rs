use super::*;

fn helper_at(
    fixture: &Fixture,
    operation: &str,
    options: &Value,
    cwd: &Path,
    deadline: Instant,
) -> Output {
    let mut command = fixture.command(&fixture.binary);
    command
        .args(["installer-helper", operation, "--input-env"])
        .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string())
        .current_dir(cwd);
    bounded_for(command, deadline.saturating_duration_since(Instant::now()))
}
fn cursor_package(fixture: &Fixture) {
    fixture.package_with(&[
        (
            "agents.d/cursor.json",
            include_str!("../../agents.d/cursor.json"),
        ),
        (
            "assets/hooks/cursor-loongsuite-pilot-hook.sh",
            include_str!("../../assets/hooks/cursor-loongsuite-pilot-hook.sh"),
        ),
        (
            "assets/hooks/cursor-loongsuite-pilot-hook.ps1",
            include_str!("../../assets/hooks/cursor-loongsuite-pilot-hook.ps1"),
        ),
        (
            "assets/hooks/shared/native.sh",
            include_str!("../../assets/hooks/shared/native.sh"),
        ),
        (
            "assets/hooks/shared/native.ps1",
            include_str!("../../assets/hooks/shared/native.ps1"),
        ),
    ]);
}
fn stage(fixture: &Fixture, options: &Value, cwd: &Path, deadline: Instant) -> PathBuf {
    let out = helper_at(fixture, "stage-package", options, cwd, deadline);
    success(&out);
    fixture
        .root
        .path()
        .join("cache/versions")
        .join(String::from_utf8(out.stdout).unwrap().trim())
}
fn selected_cursor_options(fixture: &Fixture) -> Value {
    let mut options = fixture.runtime_options(&fixture.candidate);
    options["configOptions"] = json!({
        "selectedAgents":"cursor", "agentSelectionExplicit":true,
        "probeResult":[{"id":"cursor","detected":true},{"id":"cursor-cli","detected":false}]
    });
    options
}
#[test]
fn version_l44_l54_l63_l71_real_native_entry_uses_fresh_siblings_and_preserves_pointer_history() {
    let fixture = Fixture::new();
    fixture.package();
    for source in [
        include_str!("../../deploy/installer-opensource.sh"),
        include_str!("../../deploy/installer-opensource.ps1"),
    ] {
        assert!(source.contains("stage-package"));
        assert!(source.contains("publish-package"));
    }
    let cwd = fixture.root.path().join("unrelated caller");
    fs::create_dir(&cwd).unwrap();
    let cache = fixture.root.path().join("cache");
    fs::create_dir_all(cache.join("versions/live")).unwrap();
    fs::write(cache.join("versions/live/keep"), "live complete directory").unwrap();
    let current = b"\xef\xbb\xbflive\r\n";
    let previous = b"older\r\n";
    fs::write(cache.join("current"), current).unwrap();
    fs::write(cache.join("previous"), previous).unwrap();
    let options = fixture.runtime_options(&fixture.candidate);
    let first = stage(
        &fixture,
        &options,
        &cwd,
        Instant::now() + Duration::from_secs(30),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let first_manifest = fs::read(first.join("runtime-manifest.json")).unwrap();
    let second = stage(&fixture, &options, &cwd, deadline);
    assert_ne!(first, second);
    for path in [&first, &second] {
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".candidate-"));
        assert_eq!(
            fs::read(path.join("runtime-manifest.json")).unwrap(),
            first_manifest
        );
        assert_eq!(
            fs::read(path.join("assets/fixture")).unwrap(),
            b"fixture asset"
        );
        let version = fs::read_to_string(path.join("VERSION")).unwrap();
        assert!(version.contains(concat!("version=", env!("CARGO_PKG_VERSION"))));
        assert!(version.contains("git_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }
    assert_eq!(fs::read(cache.join("current")).unwrap(), current);
    assert_eq!(fs::read(cache.join("previous")).unwrap(), previous);
    assert_eq!(
        fs::read_to_string(cache.join("versions/live/keep")).unwrap(),
        "live complete directory"
    );

    assert!(Instant::now() < deadline);
    // Original L63 is an independent historical declaration with its own budget.
    let deadline = Instant::now() + Duration::from_secs(5);
    let options = fixture.runtime_options(&first);
    success(&helper_at(
        &fixture,
        "publish-package",
        &options,
        &cwd,
        deadline,
    ));
    assert_eq!(
        fs::read_to_string(cache.join("current")).unwrap().trim(),
        first.file_name().unwrap().to_str().unwrap()
    );
    assert_eq!(fs::read(cache.join("previous")).unwrap(), b"live\n");
    assert!(Instant::now() < deadline);
    // L71 independently checks that republishing self cannot clobber previous.
    let deadline = Instant::now() + Duration::from_secs(5);
    success(&helper_at(
        &fixture,
        "publish-package",
        &options,
        &cwd,
        deadline,
    ));
    assert_eq!(fs::read(cache.join("previous")).unwrap(), b"live\n");
    assert_eq!(
        fs::read(first.join("runtime-manifest.json")).unwrap(),
        first_manifest
    );
    assert_eq!(
        fs::read_to_string(cache.join("versions/live/keep")).unwrap(),
        "live complete directory"
    );
    assert!(Instant::now() < deadline);
}
#[test]
fn postinstall_l16_actual_installed_native_hook_entry_ignores_caller_cwd_and_decoy_postinstall() {
    let fixture = Fixture::new();
    cursor_package(&fixture);
    let cwd = fixture.root.path().join("unrelated cwd");
    fs::create_dir_all(cwd.join("scripts")).unwrap();
    fs::write(
        cwd.join("scripts/postinstall.js"),
        "throw new Error('must never execute caller code')",
    )
    .unwrap();
    let cursor = fixture.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    fs::write(
        &cursor,
        r#"{"hooks":{"stop":[{"command":"user-owned-hook"}]}}"#,
    )
    .unwrap();
    let mut options = selected_cursor_options(&fixture);
    let installed = stage(
        &fixture,
        &options,
        &cwd,
        Instant::now() + Duration::from_secs(30),
    );
    assert!(!installed.join("scripts/postinstall.js").exists());
    options["sourceDir"] = json!(installed);
    options["deployHooks"] = json!(true);
    let deadline = Instant::now() + Duration::from_secs(5);
    success(&helper_at(
        &fixture,
        "publish-package",
        &options,
        &cwd,
        deadline,
    ));
    let result: Value = serde_json::from_slice(&fs::read(&cursor).unwrap()).unwrap();
    let hooks = result["hooks"]["stop"].as_array().unwrap();
    assert!(hooks
        .iter()
        .any(|hook| hook["command"] == "user-owned-hook"));
    assert_eq!(
        hooks
            .iter()
            .filter(|hook| hook["command"]
                .as_str()
                .is_some_and(|s| s.contains("cursor-loongsuite-pilot-hook")))
            .count(),
        1
    );
    assert!(!cwd.join("hooks").exists());
    assert!(fixture.data.join("hooks").is_dir());
    assert!(Instant::now() < deadline);
}
#[test]
fn postinstall_l25_missing_required_native_hook_assets_fails_without_success_or_pointer_publication(
) {
    let fixture = Fixture::new();
    fixture.package_with(&[(
        "agents.d/cursor.json",
        include_str!("../../agents.d/cursor.json"),
    )]);
    let cursor = fixture.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    let original = b"{\"hooks\":{\"stop\":[{\"command\":\"user-owned-hook\"}]}}\n";
    fs::write(&cursor, original).unwrap();
    let mut options = selected_cursor_options(&fixture);
    let installed = stage(
        &fixture,
        &options,
        fixture.root.path(),
        Instant::now() + Duration::from_secs(30),
    );
    let cache = fixture.root.path().join("cache");
    fs::write(cache.join("current"), "live\n").unwrap();
    fs::write(cache.join("previous"), "older\n").unwrap();
    options["sourceDir"] = json!(installed);
    options["deployHooks"] = json!(true);
    let deadline = Instant::now() + Duration::from_secs(5);
    let output = helper_at(
        &fixture,
        "publish-package",
        &options,
        fixture.root.path(),
        deadline,
    );
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Hook"));
    assert_eq!(fs::read(&cursor).unwrap(), original);
    assert_eq!(fs::read(cache.join("current")).unwrap(), b"live\n");
    assert_eq!(fs::read(cache.join("previous")).unwrap(), b"older\n");
    let sh = include_str!("../../deploy/installer-opensource.sh");
    let body = function(sh, "deploy_package() {");
    assert!(body.contains("publish-package deploy-hooks || return 1"));
    let invoke = body.find("publish-package").unwrap();
    let success = body.find("Native package and hooks deployed").unwrap();
    assert!(success > invoke);
    assert!(!body.contains("postinstall.js"));
    assert!(Instant::now() < deadline);
}
