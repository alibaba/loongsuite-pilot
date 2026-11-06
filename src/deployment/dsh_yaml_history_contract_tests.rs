//! Exact ef8953/f84/2b DshYamlPatchStrategy historical contracts, using real temp files.
use super::dsh_yaml_history_test_hooks::{self as hooks, Mode, Plan};
use super::*;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};

const MARKER: &str = "PILOT-OBSERVABILITY-MANAGED";
const ENTRY: &str = "loongsuite-pilot-observability";

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    patch: PathBuf,
    plugin: PathBuf,
    def: AgentDefinition,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let patch = root.join("cordis.patch.yml");
        let plugin = root.join("plugin.mjs");
        std::fs::write(&plugin, "export default function apply() {}\n").unwrap();
        let def = serde_json::from_value(json!({
            "id":"dsh","displayName":"DeepSeek Harness","deployMode":"dsh-yaml-patch",
            "detection":{"paths":[],"commands":["dsh"]},
            "dshYamlPatch":{"pluginSource":plugin,"patchPath":patch,"entryId":ENTRY,"marker":MARKER}
        }))
        .unwrap();
        Self {
            _root: temp,
            root,
            patch,
            plugin,
            def,
        }
    }
    fn strategy(&self) -> DshYamlPatchStrategy {
        self.strategy_home(None)
    }
    fn strategy_home(&self, home: Option<&Path>) -> DshYamlPatchStrategy {
        // Inject the captured locator environment rather than mutating global HOME/DSH_HOME.
        let mut env = HashMap::new();
        if let Some(home) = home {
            env.insert("DSH_HOME".into(), home.to_string_lossy().into_owned());
        }
        let locator = DshRuntimeLocator {
            proc_root: self.root.join("empty-proc").to_string_lossy().into_owned(),
            platform: "linux".into(),
            env,
            cwd: self.root.to_string_lossy().into_owned(),
            uid: None,
        };
        DshYamlPatchStrategy::with_locator(self.root.to_string_lossy().into_owned(), locator)
    }
    fn text(&self) -> String {
        std::fs::read_to_string(&self.patch).unwrap_or_default()
    }
    fn enabled(&self) -> PathBuf {
        self.root.join(DSH_ENABLED_MARKER)
    }
    async fn install(&self) {
        let result = self.strategy().deploy(&self.def).await;
        assert!(result.success, "{:?}", result.error);
    }
    fn record(&self, path: &Path) -> DeployedAgentRecord {
        serde_json::from_value(json!({
            "deployMode":"dsh-yaml-patch","deployedAt":"2026-11-02T00:00:00.000Z","dshPatchPath":path
        })).unwrap()
    }
    fn old_lock(&self) -> PathBuf {
        let lock = PathBuf::from(format!("{}{}", self.patch.display(), LOCK_SUFFIX));
        std::fs::write(&lock, "abandoned").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)),
            )
            .unwrap();
        lock
    }
}

#[tokio::test]
async fn source_l69_new_patch_has_owned_insert_and_exact_enabled_bytes() {
    let f = Fixture::new();
    f.install().await;
    let text = f.text();
    for piece in [
        "# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: true)",
        "# entryId=loongsuite-pilot-observability",
        "- insert:",
        "id: 'loongsuite-pilot-observability'",
        "# END PILOT-OBSERVABILITY-MANAGED",
    ] {
        assert!(text.contains(piece), "{text}");
    }
    assert_eq!(std::fs::read(f.enabled()).unwrap(), b"enabled\n");
}
#[tokio::test]
async fn source_l82_appends_after_preexisting_user_rows_and_marks_not_created() {
    let f = Fixture::new();
    let user = "- id: user-other-plugin\n  name: file:///tmp/other.mjs\n";
    std::fs::write(&f.patch, user).unwrap();
    f.install().await;
    let text = f.text();
    assert!(text.contains("# BEGIN PILOT-OBSERVABILITY-MANAGED (created-file: false)"));
    assert!(text.find("- id: user-other-plugin").unwrap() < text.find("# BEGIN").unwrap());
}
#[tokio::test]
async fn source_l93_preserves_comments_and_user_prefix_verbatim() {
    let f = Fixture::new();
    let user = "# user comment line\n- id: user-other-plugin\n  name: file:///tmp/other.mjs\n";
    std::fs::write(&f.patch, user).unwrap();
    f.install().await;
    assert!(f.text().starts_with(user));
}
#[tokio::test]
async fn source_l107_repeated_deploy_is_byte_idempotent_and_healthy() {
    let f = Fixture::new();
    f.install().await;
    let first = f.text();
    f.install().await;
    assert_eq!(f.text(), first);
    assert!(!f.strategy().needs_deploy(&f.def, None).await);
}
#[tokio::test]
async fn source_l118_undeploy_removes_pilot_created_empty_patch_and_enabled_marker() {
    let f = Fixture::new();
    f.install().await;
    assert!(!f.text().is_empty());
    assert!(f.strategy().undeploy(&f.def).await);
    assert!(!f.patch.exists());
    assert!(!f.enabled().exists());
}
#[tokio::test]
async fn source_l128_undeploy_restores_exact_user_bytes() {
    let f = Fixture::new();
    let user = "- id: user-other-plugin\n  name: file:///tmp/other.mjs\n";
    std::fs::write(&f.patch, user).unwrap();
    f.install().await;
    assert!(f.strategy().undeploy(&f.def).await);
    assert_eq!(std::fs::read(&f.patch).unwrap(), user.as_bytes());
}
#[tokio::test]
async fn source_l138_undeploy_keeps_a_preexisting_empty_file_present() {
    let f = Fixture::new();
    std::fs::write(&f.patch, []).unwrap();
    f.install().await;
    assert!(!f.text().is_empty());
    assert!(f.text().contains("created-file: false"));
    assert!(f.strategy().undeploy(&f.def).await);
    assert_eq!(std::fs::metadata(&f.patch).unwrap().len(), 0);
}
#[tokio::test]
async fn source_l152_hostile_same_marker_without_entry_identity_is_unchanged() {
    let f = Fixture::new();
    let hostile=format!("# BEGIN {MARKER}\n- id: hostile-takeover\n  name: file:///tmp/hostile.mjs\n# END {MARKER}\n");
    std::fs::write(&f.patch, &hostile).unwrap();
    let result = f.strategy().deploy(&f.def).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("conflict"));
    assert_eq!(f.text(), hostile);
}
#[tokio::test]
async fn source_l169_all_four_malformed_shapes_preserve_exact_bytes_on_deploy_and_undeploy() {
    let shapes=[
        format!("user-before\n# BEGIN {MARKER}\nuser-after\n"),
        format!("user-before\n# END {MARKER}\nuser-after\n"),
        format!("user-before\n# BEGIN {MARKER}\n# BEGIN {MARKER}\n# entryId={ENTRY}\n# pluginSource=file:///pilot/plugin.mjs\n# pluginHash=abc\n# END {MARKER}\nuser-after\n"),
        format!("# BEGIN {MARKER}\n# entryId={ENTRY}\n# pluginSource=file:///pilot/a.mjs\n# pluginHash=abc\n# END {MARKER}\n# BEGIN {MARKER}\n# entryId={ENTRY}\n# pluginSource=file:///pilot/b.mjs\n# pluginHash=def\n# END {MARKER}\n")
    ];
    for malformed in shapes {
        let f = Fixture::new();
        std::fs::write(&f.patch, &malformed).unwrap();
        assert!(!f.strategy().deploy(&f.def).await.success);
        assert_eq!(f.text(), malformed);
        assert!(!f.strategy().undeploy(&f.def).await);
        assert_eq!(f.text(), malformed);
    }
}
#[tokio::test]
async fn source_l213_third_party_rows_survive_the_whole_install_uninstall_cycle() {
    let f = Fixture::new();
    let third="- id: third-party-a\n  name: file:///tmp/a.mjs\n- id: third-party-b\n  name: file:///tmp/b.mjs\n";
    std::fs::write(&f.patch, third).unwrap();
    f.install().await;
    assert!(f.strategy().undeploy(&f.def).await);
    assert_eq!(f.text().trim(), third.trim());
}
#[tokio::test]
async fn source_l229_source_content_hash_change_requires_and_completes_redeploy() {
    let f = Fixture::new();
    f.install().await;
    assert!(!f.strategy().needs_deploy(&f.def, None).await);
    std::fs::write(
        &f.plugin,
        "export default function apply(v2) { return v2; }\n",
    )
    .unwrap();
    assert!(f.strategy().needs_deploy(&f.def, None).await);
    f.install().await;
    assert!(!f.strategy().needs_deploy(&f.def, None).await);
}
#[tokio::test]
async fn source_l239_missing_collection_enabled_marker_requires_and_completes_repair() {
    let f = Fixture::new();
    f.install().await;
    std::fs::remove_file(f.enabled()).unwrap();
    assert!(f.strategy().needs_deploy(&f.def, None).await);
    f.install().await;
    assert!(!f.strategy().needs_deploy(&f.def, None).await);
}
#[tokio::test]
async fn source_l248_concurrent_writers_both_succeed_with_one_block_and_no_lock() {
    let f = Fixture::new();
    let strategy = f.strategy();
    let (a, b) = tokio::join!(strategy.deploy(&f.def), strategy.deploy(&f.def));
    assert!(a.success, "{:?}", a.error);
    assert!(b.success, "{:?}", b.error);
    assert_eq!(f.text().matches(&format!("# BEGIN {MARKER}")).count(), 1);
    assert!(!Path::new(&format!("{}{}", f.patch.display(), LOCK_SUFFIX)).exists());
}
#[tokio::test]
async fn source_l258_post_fsync_external_edit_is_recomposed_and_preserved() {
    let f = Fixture::new();
    f.install().await;
    let edited = [b"# concurrent-user-edit\n".as_slice(), f.text().as_bytes()].concat();
    let (result, reads) = hooks::scope(
        Plan::new(f.patch.clone(), Mode::ExternalEdit(edited)),
        f.strategy().deploy(&f.def),
    )
    .await;
    assert!(result.success, "{:?}", result.error);
    assert!(reads >= 6);
    assert!(f.text().starts_with("# concurrent-user-edit\n"));
}
#[tokio::test]
async fn source_l286_stale_pilot_lock_is_recovered_and_removed() {
    let f = Fixture::new();
    let lock = f.old_lock();
    f.install().await;
    assert!(!lock.exists());
}
#[tokio::test]
async fn source_l295_two_stale_reclaimers_keep_new_owner_serialized_without_orphans() {
    let f = Fixture::new();
    let lock = f.old_lock();
    let a = f.strategy();
    let b = f.strategy();
    let (x, y) = tokio::join!(a.deploy(&f.def), b.deploy(&f.def));
    assert!(x.success, "{:?}", x.error);
    assert!(y.success, "{:?}", y.error);
    assert_eq!(f.text().matches(&format!("# BEGIN {MARKER}")).count(), 1);
    assert!(!lock.exists());
    assert!(!Path::new(&format!("{}{LOCK_GATE_SUFFIX}", lock.display())).exists());
}
#[tokio::test]
async fn source_l314_same_length_changed_bytes_exhaust_exactly_two_hash_guard_attempts() {
    let f = Fixture::new();
    f.install().await;
    let original = std::fs::read(&f.patch).unwrap();
    let hostile = String::from_utf8(original.clone())
        .unwrap()
        .replace(&format!("# BEGIN {MARKER}"), &format!("# XEGIN {MARKER}"))
        .into_bytes();
    assert_eq!(original.len(), hostile.len());
    let (result, reads) = hooks::scope(
        Plan::new(
            f.patch.clone(),
            Mode::Alternating {
                original: original.clone(),
                hostile,
            },
        ),
        f.strategy().deploy(&f.def),
    )
    .await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("concurrent"));
    assert_eq!(reads, 4);
    assert_eq!(std::fs::read(&f.patch).unwrap(), original);
}
#[tokio::test]
async fn source_l354_omitted_patch_path_uses_captured_dsh_home_environment() {
    let mut f = Fixture::new();
    f.def.dsh_yaml_patch.as_mut().unwrap().patch_path = None;
    let result = f.strategy_home(Some(&f.root)).deploy(&f.def).await;
    assert!(result.success, "{:?}", result.error);
    assert!(f.text().contains(&format!("# BEGIN {MARKER}")));
}
#[tokio::test]
async fn source_l368_persisted_patch_path_wins_after_environment_moves_to_another_home() {
    let mut f = Fixture::new();
    f.def.dsh_yaml_patch.as_mut().unwrap().patch_path = None;
    let home_a = f.root.join("home-a");
    let home_b = f.root.join("home-b");
    let path_a = home_a.join("cordis.patch.yml");
    let path_b = home_b.join("cordis.patch.yml");
    let result = f.strategy_home(Some(&home_a)).deploy(&f.def).await;
    assert!(result.success, "{:?}", result.error);
    let record = f.record(&path_a);
    let moved = f.strategy_home(Some(&home_b));
    assert!(!moved.needs_deploy(&f.def, Some(&record)).await);
    assert!(moved.undeploy_recorded(&f.def, Some(&record)).await);
    assert!(!path_a.exists());
    assert!(!path_b.exists());
}
#[tokio::test]
async fn source_l396_undeploy_absent_patch_is_a_successful_noop() {
    let f = Fixture::new();
    assert!(f.strategy().undeploy(&f.def).await);
    assert!(!f.patch.exists());
}
#[tokio::test]
async fn source_l402_undeploy_missing_persisted_home_does_not_create_any_directory() {
    let f = Fixture::new();
    let home = f.root.join("missing-persisted-home");
    let record = f.record(&home.join("cordis.patch.yml"));
    assert!(f.strategy().undeploy_recorded(&f.def, Some(&record)).await);
    assert!(!home.exists());
}
#[tokio::test]
async fn source_l415_missing_dsh_configuration_does_not_require_deploy() {
    let mut f = Fixture::new();
    f.def.dsh_yaml_patch = None;
    assert!(!f.strategy().needs_deploy(&f.def, None).await);
}
#[tokio::test]
async fn source_l420_missing_plugin_fails_with_actionable_reason() {
    let f = Fixture::new();
    std::fs::remove_file(&f.plugin).unwrap();
    let result = f.strategy().deploy(&f.def).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("plugin file not found"));
}
#[tokio::test]
async fn source_l428_block_contains_stable_plugin_source_and_matching_name_url() {
    let f = Fixture::new();
    f.install().await;
    // Unix source used plain absolute ASCII paths. Windows path encoding is the
    // platform adapter: a URL must not contain a raw drive separator or backslash.
    #[cfg(unix)]
    let expected = format!("file://{}", f.plugin.display());
    #[cfg(windows)]
    let expected = super::file_url(&f.plugin.to_string_lossy());
    assert!(f.text().contains(&format!("# pluginSource={expected}")));
    assert!(f.text().contains(&format!("name: {expected}")));
}
