use super::*;
use loongsuite_pilot::deployment::{
    AgentDefLoader, AgentDefLoaderOptions, DeploymentManager, DeploymentManagerOptions,
};
use std::collections::HashMap;

const DOC_A: &str = "loongsuite-pilot-ops/references/cursor-diagnostics.md";
const DOC_B: &str = "loongsuite-pilot-ops/references/codex-diagnostics.md";
const DOCS: [&str; 5] = [
    "loongsuite-pilot-ops/SKILL.md",
    "loongsuite-pilot-ops/references/claude-code-diagnostics.md",
    DOC_A,
    DOC_B,
    "loongsuite-pilot-ops/references/diagnostics.md",
];

fn minimal_asset_package(f: &Fixture, reference: &str) {
    if f.candidate.join("runtime-manifest.json").exists() {
        fs::remove_file(f.candidate.join("runtime-manifest.json")).unwrap();
    }
    f.package_with(&[
        (
            "assets/skills/loongsuite-pilot-ops/references/cursor-diagnostics.md",
            reference,
        ),
        (
            "assets/plugins/dsh/plugin.mjs",
            include_str!("../../assets/plugins/dsh/plugin.mjs"),
        ),
        (
            "assets/plugins/shared/resource-context.mjs",
            include_str!("../../assets/plugins/shared/resource-context.mjs"),
        ),
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

fn additional_manifest_asset(f: &Fixture, relative: &str, bytes: &[u8]) {
    let path = f.candidate.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    let file = f.candidate.join("runtime-manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["resources"].as_array_mut().unwrap().push(json!({
        "path":relative, "sha256":loongsuite_pilot::utils::runtime_paths::sha256_file(&path).unwrap(),
    }));
    fs::write(file, manifest.to_string()).unwrap();
}

fn stage_assets(f: &Fixture) -> Value {
    let mut options = f.runtime_options(&f.candidate);
    let output = f.helper("stage-package", &options, true);
    success(&output);
    options["sourceDir"] = json!(f
        .root
        .path()
        .join("cache/versions")
        .join(String::from_utf8(output.stdout).unwrap().trim()));
    options
}

#[tokio::test]
async fn fresh_native_publication_materializes_the_exact_dsh_plugin_path_before_real_dsh_deployment(
) {
    let f = Fixture::new();
    minimal_asset_package(&f, "fixture reference 2\n");
    for (index, relative) in DOCS.iter().enumerate() {
        if *relative != DOC_A {
            additional_manifest_asset(
                &f,
                &format!("assets/skills/{relative}"),
                format!("fixture reference {index}\n").as_bytes(),
            );
        }
    }
    let patch = f
        .root
        .path()
        .join("isolated DSH O'Brien [配置] 🚀/cordis.patch.yml");
    let mut dsh: Value = serde_json::from_str(include_str!("../../agents.d/dsh.json")).unwrap();
    dsh["dshYamlPatch"]["patchPath"] = json!(patch);
    additional_manifest_asset(&f, "agents.d/dsh.json", dsh.to_string().as_bytes());
    fs::create_dir_all(patch.parent().unwrap()).unwrap();
    fs::write(&patch, "# private user YAML\n").unwrap();
    let cursor = f.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    fs::write(
        cursor,
        r#"{"hooks":{"stop":[{"command":"keep-user-hook"}]}}"#,
    )
    .unwrap();
    let mut options = stage_assets(&f);
    let installed = PathBuf::from(options["sourceDir"].as_str().unwrap());
    options["deployHooks"] = json!(true);
    options["configOptions"] = json!({
        "selectedAgents":"cursor,dsh","agentSelectionExplicit":true,
        "probeResult":[{"id":"cursor","detected":true},{"id":"cursor-cli","detected":false},{"id":"dsh","detected":true}]
    });
    success(&f.helper("publish-package", &options, true));
    let definition = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: installed.join("agents.d").to_string_lossy().into_owned(),
        local_dir: f.data.join("agents.d.local").to_string_lossy().into_owned(),
        pilot_dir: installed.to_string_lossy().into_owned(),
        data_dir: f.data.to_string_lossy().into_owned(),
    })
    .with_env(HashMap::from([
        ("HOME".into(), f.root.path().to_string_lossy().into_owned()),
        (
            "USERPROFILE".into(),
            f.root.path().to_string_lossy().into_owned(),
        ),
    ]))
    .load()
    .await
    .into_iter()
    .find(|definition| definition.id == "dsh")
    .unwrap();
    assert_eq!(
        Path::new(&definition.dsh_yaml_patch.as_ref().unwrap().plugin_source),
        f.data.join("plugins/dsh/plugin.mjs")
    );
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: f.data.to_string_lossy().into_owned(),
        pilot_dir: installed.to_string_lossy().into_owned(),
        builtin_agents_dir: None,
        installed_by: None,
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        manager.deploy_prepared(&definition, false),
    )
    .await
    .unwrap();
    assert!(result.success, "{:?}", result.error);
    for relative in [
        "plugins/dsh/plugin.mjs",
        "plugins/shared/resource-context.mjs",
    ] {
        assert_eq!(
            fs::read(f.data.join(relative)).unwrap(),
            fs::read(installed.join(format!("assets/{relative}"))).unwrap()
        );
    }
    for relative in DOCS {
        assert_eq!(
            fs::read(f.data.join(format!("skills/{relative}"))).unwrap(),
            fs::read(installed.join(format!("assets/skills/{relative}"))).unwrap()
        );
    }
    assert_eq!(
        fs::read(f.data.join("plugins/dsh/.collection-enabled")).unwrap(),
        b"enabled\n"
    );
    assert!(fs::read_to_string(patch)
        .unwrap()
        .contains("PILOT-OBSERVABILITY-MANAGED"));
}

#[cfg(unix)]
#[test]
fn native_publication_materializes_qoder_cli_preload_and_executable_wrapper() {
    use std::os::unix::fs::PermissionsExt;

    let f = Fixture::new();
    minimal_asset_package(&f, "fixture reference\n");
    let wrapper = include_bytes!("../../assets/hooks/qodercli-runtime-wrapper.sh");
    let preload = include_bytes!("../../assets/hooks/qodercli-token-intercept.mjs");
    additional_manifest_asset(&f, "assets/hooks/qodercli-runtime-wrapper.sh", wrapper);
    additional_manifest_asset(&f, "assets/hooks/qodercli-token-intercept.mjs", preload);
    let options = stage_assets(&f);
    let installed_wrapper = f.data.join("hooks/qodercli-runtime-wrapper.sh");
    let installed_preload = f.data.join("hooks/qodercli-token-intercept.mjs");

    assert!(!installed_wrapper.exists());
    assert!(!installed_preload.exists());
    success(&f.helper("publish-package", &options, true));
    assert_eq!(fs::read(&installed_wrapper).unwrap(), wrapper);
    assert_eq!(fs::read(&installed_preload).unwrap(), preload);
    assert_ne!(
        fs::metadata(&installed_wrapper)
            .unwrap()
            .permissions()
            .mode()
            & 0o100,
        0
    );

    fs::write(&installed_preload, b"// customized preload\n").unwrap();
    fs::set_permissions(&installed_wrapper, fs::Permissions::from_mode(0o644)).unwrap();
    let result = f.helper("publish-package", &options, true);
    success(&result);
    assert_eq!(
        fs::read(&installed_preload).unwrap(),
        b"// customized preload\n"
    );
    assert_ne!(
        fs::metadata(&installed_wrapper)
            .unwrap()
            .permissions()
            .mode()
            & 0o100,
        0
    );
}

#[test]
fn staging_is_pure_and_unknown_optional_skills_are_preserved_and_reported_without_blocking_runtime()
{
    let f = Fixture::new();
    minimal_asset_package(&f, "candidate reference\n");
    let document = f.data.join(format!("skills/{DOC_A}"));
    fs::create_dir_all(document.parent().unwrap()).unwrap();
    fs::write(&document, "private user modification\n").unwrap();
    let options = stage_assets(&f);
    assert_eq!(fs::read(&document).unwrap(), b"private user modification\n");
    assert!(!f.data.join("plugins").exists());
    let output = f.helper("publish-package", &options, true);
    success(&output);
    assert_eq!(fs::read(document).unwrap(), b"private user modification\n");
    assert!(String::from_utf8_lossy(&output.stderr).contains("preservedOptionalSkills"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private user modification"));
    assert!(f.data.join("plugins/dsh/plugin.mjs").is_file());
    assert!(f.data.join("plugins/shared/resource-context.mjs").is_file());
    assert!(
        !f.data.join("plugins/dsh/.collection-enabled").exists(),
        "unselected DSH must not be enabled"
    );
}

#[test]
fn dirty_mandatory_runtime_file_refuses_all_writes_and_preserves_its_bytes() {
    let f = Fixture::new();
    minimal_asset_package(&f, "candidate reference\n");
    let plugin = f.data.join("plugins/dsh/plugin.mjs");
    fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    fs::write(&plugin, "private runtime modification\n").unwrap();
    let options = stage_assets(&f);
    let output = f.helper("publish-package", &options, true);
    assert!(!output.status.success());
    assert_eq!(fs::read(plugin).unwrap(), b"private runtime modification\n");
    assert!(!f.data.join(format!("skills/{DOC_A}")).exists());
    assert!(!f.data.join("plugins/shared/resource-context.mjs").exists());
    assert!(!f.root.path().join("cache/current").exists());
    assert!(!f.root.path().join("cache/update-recovery.json").exists());
}

#[test]
fn verified_upgrade_pointer_failure_restores_files_modes_and_unknown_siblings_then_retry_succeeds()
{
    let f = Fixture::new();
    minimal_asset_package(&f, "old reference\n");
    let first = stage_assets(&f);
    success(&f.helper("publish-package", &first, true));
    let pointer = f.root.path().join("cache/current");
    let old_pointer = fs::read(&pointer).unwrap();
    let reference = f.data.join(format!("skills/{DOC_A}"));
    let unknown = f.data.join("skills/loongsuite-pilot-ops/private.json");
    fs::write(&unknown, br#"{"private":"keep"}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            f.data.join("skills"),
            f.data.join("skills/loongsuite-pilot-ops"),
            reference.parent().unwrap().to_path_buf(),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::set_permissions(&reference, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let unknown_before = fs::metadata(&unknown).unwrap();
    minimal_asset_package(&f, "new reference\n");
    let second = stage_assets(&f);
    let mut permissions = fs::metadata(&pointer).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&pointer, permissions).unwrap();
    let output = f.helper("publish-package", &second, true);
    assert!(!output.status.success());
    assert_eq!(fs::read(&reference).unwrap(), b"old reference\n");
    assert_eq!(fs::read(&unknown).unwrap(), br#"{"private":"keep"}"#);
    assert_eq!(fs::read(&pointer).unwrap(), old_pointer);
    assert!(!f.root.path().join("cache/update-recovery.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        assert_eq!(
            fs::metadata(&unknown).unwrap().ino(),
            unknown_before.ino(),
            "unknown sibling was replaced"
        );
        assert_eq!(
            fs::metadata(&reference).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
    #[cfg(not(unix))]
    let _ = unknown_before;
    let mut permissions = fs::metadata(&pointer).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    #[cfg(not(unix))]
    permissions.set_readonly(false);
    fs::set_permissions(&pointer, permissions).unwrap();
    success(&f.helper("publish-package", &second, true));
    assert_eq!(fs::read(reference).unwrap(), b"new reference\n");
    assert_eq!(fs::read(unknown).unwrap(), br#"{"private":"keep"}"#);
}

#[test]
fn actual_eager_entry_installs_resources_and_prepared_child_does_not_wait_for_parent_locks() {
    let f = Fixture::new();
    minimal_asset_package(&f, "eager reference\n");
    let settings = f.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        r#"{"hooks":{"stop":[{"command":"keep-user-command"}]}}"#,
    )
    .unwrap();
    let run = || {
        let binary = f.candidate.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        let mut command = f.command(&binary);
        command
            .args(["hook", "install", "--agents", "cursor", "--json"])
            .env("LOONGSUITE_PILOT_RESOURCE_ROOT", &f.candidate)
            .env("AGENT_DATA_COLLECTION_CONFIG", f.data.join("config.json"));
        bounded_for(command, Duration::from_secs(5))
    };
    success(&run());
    assert_eq!(
        fs::read(f.data.join(format!("skills/{DOC_A}"))).unwrap(),
        b"eager reference\n"
    );
    let resource = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.data.join(".plugin-assets.lock"))
        .unwrap();
    let update = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.root.path().join("cache/update.lock"))
        .unwrap();
    fs2::FileExt::lock_exclusive(&resource).unwrap();
    fs2::FileExt::lock_exclusive(&update).unwrap();
    success(&run());
    drop(update);
    drop(resource);
    assert!(fs::read_to_string(settings)
        .unwrap()
        .contains("keep-user-command"));
}

#[test]
fn source_sidecars_are_not_copied_and_unknown_siblings_are_never_replaced() {
    let f = Fixture::new();
    minimal_asset_package(&f, "known reference\n");
    additional_manifest_asset(&f, &format!("assets/skills/{DOC_B}"), b"new reference\n");
    for relative in [
        "assets/skills/.DS_Store",
        "assets/skills/loongsuite-pilot-ops/._SKILL.md",
        "assets/hooks/.DS_Store",
        "assets/hooks/._cursor-loongsuite-pilot-hook.sh",
        "assets/plugins/dsh/._plugin.mjs",
    ] {
        additional_manifest_asset(&f, relative, b"source sidecar");
    }
    let document = f.data.join(format!("skills/{DOC_A}"));
    fs::create_dir_all(document.parent().unwrap()).unwrap();
    fs::write(&document, "known reference\n").unwrap();
    fs::write(f.data.join("skills/.DS_Store"), "unknown user sidecar").unwrap();
    let unknown = f.data.join("skills/loongsuite-pilot-ops/private.json");
    fs::write(&unknown, br#"{"keep":"unknown"}"#).unwrap();
    let settings = f.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(settings, "{}").unwrap();
    let mut options = stage_assets(&f);
    options["deployHooks"] = json!(true);
    options["configOptions"] = json!({"selectedAgents":"cursor","agentSelectionExplicit":true,"probeResult":[{"id":"cursor","detected":true},{"id":"cursor-cli","detected":false}]});
    success(&f.helper("publish-package", &options, true));
    assert_eq!(fs::read(document).unwrap(), b"known reference\n");
    assert_eq!(fs::read(unknown).unwrap(), br#"{"keep":"unknown"}"#);
    assert_eq!(
        fs::read(f.data.join("skills/.DS_Store")).unwrap(),
        b"unknown user sidecar"
    );
    assert_eq!(
        fs::read(f.data.join(format!("skills/{DOC_B}"))).unwrap(),
        b"new reference\n"
    );
    for relative in [
        "skills/loongsuite-pilot-ops/._SKILL.md",
        "hooks/.DS_Store",
        "hooks/._cursor-loongsuite-pilot-hook.sh",
        "plugins/dsh/._plugin.mjs",
    ] {
        assert!(!f.data.join(relative).exists());
    }
    assert!(!f.data.join("plugins/dsh/.collection-enabled").exists());
}

#[test]
fn missing_dsh_assets_or_shared_dependency_are_rejected_before_any_live_file_write() {
    for no_assets in [true, false] {
        let f = Fixture::new();
        if no_assets {
            f.package_with(&[("agents.d/dsh.json", include_str!("../../agents.d/dsh.json"))]);
        } else {
            minimal_asset_package(&f, "candidate\n");
            fs::remove_file(
                f.candidate
                    .join("assets/plugins/shared/resource-context.mjs"),
            )
            .unwrap();
            let path = f.candidate.join("runtime-manifest.json");
            let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            manifest["resources"]
                .as_array_mut()
                .unwrap()
                .retain(|entry| entry["path"] != "assets/plugins/shared/resource-context.mjs");
            fs::write(path, manifest.to_string()).unwrap();
        }
        let options = stage_assets(&f);
        let output = f.helper("publish-package", &options, true);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("DSH"));
        assert!(!f.data.join("skills").exists());
        assert!(!f.data.join("plugins").exists());
        assert!(!f.root.path().join("cache/current").exists());
        assert!(!f.root.path().join("cache/update-recovery.json").exists());
    }
}

#[test]
fn optional_non_file_target_is_preserved_without_entering_the_journal() {
    let f = Fixture::new();
    minimal_asset_package(&f, "candidate\n");
    additional_manifest_asset(
        &f,
        &format!("assets/skills/{DOC_B}"),
        b"package reference\n",
    );
    let directory = f.data.join(format!("skills/{DOC_B}"));
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("private.txt"), "do not read or replace").unwrap();
    let options = stage_assets(&f);
    let output = f.helper("publish-package", &options, true);
    success(&output);
    assert_eq!(
        fs::read(directory.join("private.txt")).unwrap(),
        b"do not read or replace"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("preservedOptionalSkills"));
    assert!(f.data.join("plugins/dsh/plugin.mjs").exists());
}

#[cfg(unix)]
#[test]
fn optional_skill_symlink_is_not_followed_or_snapshotted() {
    let f = Fixture::new();
    minimal_asset_package(&f, "candidate\n");
    additional_manifest_asset(
        &f,
        &format!("assets/skills/{DOC_B}"),
        b"package reference\n",
    );
    let outside = f.root.path().join("private-outside.md");
    fs::write(&outside, "private outside bytes").unwrap();
    let link = f.data.join(format!("skills/{DOC_B}"));
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let options = stage_assets(&f);
    success(&f.helper("publish-package", &options, true));
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(outside).unwrap(), b"private outside bytes");
}

#[test]
fn native_uninstall_preserves_pending_resource_recovery_before_any_configuration_cleanup() {
    let f = Fixture::new();
    minimal_asset_package(&f, "private reference\n");
    let journal = f.data.join(".runtime-data-activation/update-recovery.json");
    fs::create_dir_all(journal.parent().unwrap()).unwrap();
    fs::write(&journal, b"private malformed recovery material").unwrap();
    let settings = f.root.path().join(".cursor/hooks.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(&settings, b"{\"private\":\"keep\"}\n").unwrap();
    for check_only in [true, false] {
        let output = f.helper(
            "cleanup-agents",
            &json!({"dataDir":f.data,"pilotDir":f.candidate,"checkOnly":check_only}),
            true,
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("resource activation is pending"));
        assert_eq!(
            fs::read(&journal).unwrap(),
            b"private malformed recovery material"
        );
        assert_eq!(fs::read(&settings).unwrap(), b"{\"private\":\"keep\"}\n");
    }
}

#[test]
fn actual_dsh_hook_marker_is_restored_after_later_native_pointer_failure() {
    let f = Fixture::new();
    minimal_asset_package(&f, "reference\n");
    let first = stage_assets(&f);
    success(&f.helper("publish-package", &first, true));
    assert!(!f.data.join("plugins/dsh/.collection-enabled").exists());
    let old_pointer = fs::read(f.root.path().join("cache/current")).unwrap();
    minimal_asset_package(&f, "reference\n");
    let patch = f
        .root
        .path()
        .join("DSH O'Brien [private] 🚀/cordis.patch.yml");
    fs::create_dir_all(patch.parent().unwrap()).unwrap();
    fs::write(&patch, "# private YAML\n").unwrap();
    let mut definition: Value =
        serde_json::from_str(include_str!("../../agents.d/dsh.json")).unwrap();
    definition["dshYamlPatch"]["patchPath"] = json!(patch);
    additional_manifest_asset(&f, "agents.d/dsh.json", definition.to_string().as_bytes());
    let mut options = stage_assets(&f);
    options["deployHooks"] = json!(true);
    options["configOptions"] = json!({"selectedAgents":"dsh","agentSelectionExplicit":true,
        "probeResult":[{"id":"dsh","detected":true},{"id":"cursor","detected":false},{"id":"cursor-cli","detected":false}]});
    let pointer = f.root.path().join("cache/current");
    let mut permissions = fs::metadata(&pointer).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&pointer, permissions).unwrap();
    let output = f.helper("publish-package", &options, true);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("只读"),
        "must reach pointer failure after the real Hook child: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        fs::read_to_string(&patch)
            .unwrap()
            .contains("PILOT-OBSERVABILITY-MANAGED"),
        "real DSH producer was not exercised"
    );
    assert!(
        !f.data.join("plugins/dsh/.collection-enabled").exists(),
        "failed publication left DSH enabled"
    );
    assert_eq!(fs::read(&pointer).unwrap(), old_pointer);
    assert_eq!(fs::read(f.data.join("config.json")).unwrap(), b"{}");
    assert!(!f.root.path().join("cache/update-recovery.json").exists());
    let mut permissions = fs::metadata(&pointer).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    #[cfg(not(unix))]
    permissions.set_readonly(false);
    fs::set_permissions(pointer, permissions).unwrap();
}

#[test]
fn actual_config_alias_of_a_resource_file_is_refused_before_any_resource_write() {
    let cases = [
        "exact",
        "dotdot",
        "case",
        #[cfg(unix)]
        "ancestor-link",
    ];
    for case in cases {
        let f = Fixture::new();
        minimal_asset_package(&f, "reference\n");
        let mut options = stage_assets(&f);
        fs::create_dir_all(f.data.join("plugins/dsh")).unwrap();
        fs::create_dir_all(f.data.join("other")).unwrap();
        let config = match case {
            "exact" => f.data.join("plugins/dsh/plugin.mjs"),
            "dotdot" => f.data.join("other/../plugins/dsh/plugin.mjs"),
            "case" => f.data.join("plugins/dsh/PLUGIN.MJS"),
            #[cfg(unix)]
            "ancestor-link" => {
                std::os::unix::fs::symlink(f.data.join("plugins"), f.data.join("alias")).unwrap();
                f.data.join("alias/dsh/plugin.mjs")
            }
            _ => unreachable!(),
        };
        options["configPath"] = json!(config);
        options["configOptions"] = json!({"selectedAgents":"none","agentSelectionExplicit":true});
        let output = f.helper("publish-package", &options, true);
        assert!(!output.status.success(), "unsafe {case} alias accepted");
        assert!(!f.data.join("plugins/dsh/plugin.mjs").exists());
        assert!(!f.data.join("plugins/shared/resource-context.mjs").exists());
        assert!(!f.data.join(format!("skills/{DOC_A}")).exists());
        assert!(!f.root.path().join("cache/current").exists());
        assert!(!f.root.path().join("cache/update-recovery.json").exists());
    }
}
