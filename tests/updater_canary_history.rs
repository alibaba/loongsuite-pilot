//! Exact missing assertions from ef8953 canary18; all files stay under TempDir.
use loongsuite_pilot::types::{AutoUpdateConfig, CanaryPolicy};
use loongsuite_pilot::updater::{
    deterministic_bucket, LatestManifest, UpdateChannel, Updater, VersionManifest,
};
use serde_json::Value;
use std::collections::BTreeMap;

fn config() -> AutoUpdateConfig {
    AutoUpdateConfig {
        enabled: true,
        check_interval_ms: 60_000,
        manifest_url: Some("https://example.invalid/latest-rust.json".into()),
        package_url: Some("https://example.invalid/pkg.tar.gz".into()),
        install_id: None,
        canary_policy: None,
        canary_hotfix_version: Some(0),
    }
}

fn version(version: &str, commit: &str) -> VersionManifest {
    VersionManifest {
        version: version.into(),
        git_commit: commit.into(),
        assets: BTreeMap::new(),
        released_at: None,
        rollout_percentage: None,
        hotfix_version: None,
    }
}

fn latest(canary: Option<VersionManifest>) -> LatestManifest {
    LatestManifest {
        schema: 1,
        runtime: "rust".into(),
        edition: "opensource".into(),
        stable: version("1.0.35", "abc123"),
        canary,
    }
}

#[test]
fn stable_selection_preserves_manifest_version_without_canary_or_with_policy_off() {
    let root = tempfile::tempdir().unwrap();
    let updater = Updater::new(config(), root.path().to_str());
    let selected = updater.resolve_target_version(&latest(None));
    assert_eq!(selected.channel, UpdateChannel::Stable);
    assert_eq!(selected.manifest.version, "1.0.35");

    let mut settings = config();
    settings.canary_policy = Some(CanaryPolicy::Off);
    let updater = Updater::new(settings, root.path().to_str());
    let mut canary = version("1.0.36", "def456");
    canary.rollout_percentage = Some(10.0);
    let selected = updater.resolve_target_version(&latest(Some(canary)));
    assert_eq!(selected.channel, UpdateChannel::Stable);
    assert_eq!(selected.manifest.version, "1.0.35");
}

#[test]
fn explicit_auto_policy_uses_the_fifty_percent_bucket_contract() {
    let root = tempfile::tempdir().unwrap();
    let id = (0..1000)
        .map(|index| format!("test-{index}"))
        .find(|id| deterministic_bucket(id, "1.0.36") < 50)
        .unwrap();
    let mut settings = config();
    settings.canary_policy = Some(CanaryPolicy::Auto);
    settings.install_id = Some(id);
    let mut canary = version("1.0.36", "def456");
    canary.rollout_percentage = Some(50.0);
    assert_eq!(
        Updater::new(settings, root.path().to_str())
            .resolve_target_version(&latest(Some(canary)))
            .channel,
        UpdateChannel::Canary
    );
}

#[tokio::test]
async fn canary_zero_hotfix_is_written_and_other_fields_survive() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("config.json");
    std::fs::write(
        &path,
        r#"{"userId":"keep","canary":{"policy":"auto","hotfix_version":2}}"#,
    )
    .unwrap();
    let updater = Updater::new(config(), root.path().to_str());
    updater.persist_canary_state(0).await.unwrap();
    let after: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(after["canary"]["hotfix_version"], 0);
    assert_eq!(after["canary"]["policy"], "auto");
    assert_eq!(after["userId"], "keep");
}
