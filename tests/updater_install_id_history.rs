//! Real filesystem regressions for the canary existing-installId source contract.
use loongsuite_pilot::types::AutoUpdateConfig;
use loongsuite_pilot::updater::{
    build_auto_update_config_with, deterministic_bucket, LatestManifest, UpdateChannel, Updater,
    VersionManifest,
};
use loongsuite_pilot::utils::Platform;
use serde_json::Value;
use std::collections::BTreeMap;

fn config(id: Option<&str>) -> AutoUpdateConfig {
    let mut config = build_auto_update_config_with(None, Platform::current(), |_| None);
    config.install_id = id.map(str::to_owned);
    config
}

fn selected_bucket(updater: &Updater, expected_id: &str) {
    // All integer thresholds distinguish every possible bucket, without relying
    // on two arbitrarily chosen IDs landing in different buckets.
    let expected = deterministic_bucket(expected_id, "1.0.36");
    for rollout in 0..=100 {
        let canary = VersionManifest {
            version: "1.0.36".into(),
            git_commit: "def456".into(),
            assets: BTreeMap::new(),
            released_at: None,
            rollout_percentage: Some(f64::from(rollout)),
            hotfix_version: None,
        };
        let latest = LatestManifest {
            schema: 1,
            runtime: "rust".into(),
            edition: "opensource".into(),
            stable: VersionManifest {
                version: "1.0.35".into(),
                ..canary.clone()
            },
            canary: Some(canary),
        };
        assert_eq!(
            updater.resolve_target_version(&latest).channel,
            if expected < rollout {
                UpdateChannel::Canary
            } else {
                UpdateChannel::Stable
            },
            "rollout={rollout}, expected bucket={expected}"
        );
    }
}

#[tokio::test]
async fn existing_memory_identity_does_not_create_a_config_or_change_its_bucket() {
    let root = tempfile::tempdir().unwrap();
    let updater = Updater::new(config(Some("existing-id")), root.path().to_str());
    updater.ensure_install_id().await.unwrap();
    assert!(!root.path().join("config.json").exists());
    selected_bucket(&updater, "existing-id");
}

#[tokio::test]
async fn valid_disk_identity_wins_without_rewriting_even_non_uuid_or_whitespace_ids() {
    for disk_id in ["disk-valid-not-a-uuid", " "] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let original = format!("\u{feff}{{\"installId\":{disk_id:?},\"keep\":17}}\r\n");
        std::fs::write(&path, original.as_bytes()).unwrap();
        let updater = Updater::new(config(Some("memory-id")), root.path().to_str());
        updater.ensure_install_id().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original.as_bytes());
        selected_bucket(&updater, disk_id);
    }
}

#[tokio::test]
async fn missing_disk_identity_preserves_config_bytes_and_the_configured_memory_identity() {
    for original in [
        b"{\"keep\":17}".as_slice(),
        b"{\"installId\":\"\",\"keep\":17}",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        std::fs::write(&path, original).unwrap();
        let updater = Updater::new(config(Some("existing-id")), root.path().to_str());
        updater.ensure_install_id().await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), original);
        selected_bucket(&updater, "existing-id");
    }
}

#[tokio::test]
async fn concurrent_first_startups_share_the_one_persisted_id_and_keep_foreign_fields() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("config.json");
    std::fs::write(
        &path,
        b"{\"userId\":\"keep\",\"canary\":{\"policy\":\"auto\"}}",
    )
    .unwrap();
    let first = Updater::new(config(None), root.path().to_str());
    let second = Updater::new(config(Some("")), root.path().to_str());
    tokio::try_join!(first.ensure_install_id(), second.ensure_install_id()).unwrap();
    let original = std::fs::read(&path).unwrap();
    let persisted: Value = serde_json::from_slice(&original).unwrap();
    let id = persisted["installId"].as_str().unwrap();
    assert!(!id.is_empty());
    assert_eq!(persisted["userId"], "keep");
    assert_eq!(persisted["canary"]["policy"], "auto");
    selected_bucket(&first, id);
    selected_bucket(&second, id);
    first.ensure_install_id().await.unwrap();
    second.ensure_install_id().await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn configured_memory_identity_does_not_bypass_a_corrupt_or_non_object_config() {
    for original in [b"{broken".as_slice(), b"[]", b"null"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        std::fs::write(&path, original).unwrap();
        let updater = Updater::new(config(Some("existing-id")), root.path().to_str());
        assert!(updater.ensure_install_id().await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        selected_bucket(&updater, "existing-id");
    }
}
