//! Actual compiled Native edition signal ignores mutable configuration.
use std::fs;
use std::process::{Command, Stdio};
#[test]
fn upgrade_build_edition_uses_actual_compiled_feature_without_mutable_state() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config.json");
    let updater = root.path().join("updater-config.json");
    fs::write(&config, b"invalid JSON must never be parsed").unwrap();
    fs::write(
        &updater,
        b"{\"edition\":\"wrong\",\"packageUrl\":\"https://invalid.private\"}",
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"))
        .args(["probe", "--build-edition"])
        .env_clear()
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("AGENT_DATA_COLLECTION_CONFIG", &config)
        .env("LOONGSUITE_PILOT_DATA_DIR", root.path())
        .env("LOONGSUITE_PILOT_CACHE_DIR", root.path())
        .env("PILOT_TEST_EDITION", "opposite")
        .env("__PROPRIETARY_BUILD__", "opposite")
        .env("PATH", "")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    let expected = if cfg!(feature = "proprietary") {
        "proprietary\n"
    } else {
        "opensource\n"
    };
    assert_eq!(out.stdout, expected.as_bytes());
    assert_eq!(
        fs::read(config).unwrap(),
        b"invalid JSON must never be parsed"
    );
    assert_eq!(
        fs::read(updater).unwrap(),
        b"{\"edition\":\"wrong\",\"packageUrl\":\"https://invalid.private\"}"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}
