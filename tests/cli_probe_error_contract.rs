//! Real public CLI propagation of an ordinary generic-detector error.
use serde_json::{json, Value};

#[test]
fn public_probe_reports_generic_detection_errors_but_list_only_remains_read_only_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let data = root.join("data");
    let local = data.join("agents.d.local");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("synthetic-invalid-detector.json"),json!({
        "id":"synthetic-invalid-detector","displayName":"Synthetic invalid detector","deployMode":"detection-only",
        "detection":{"paths":[],"commands":["invalid\0command"]}
    }).to_string()).unwrap();
    let run = |list: bool| {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
        command.arg("probe");
        if list {
            command.arg("--list");
        }
        command
            .env("LOONGSUITE_PILOT_DATA_DIR", &data)
            .env("LOONGSUITE_PILOT_RESOURCE_ROOT", env!("CARGO_MANIFEST_DIR"))
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .env("XDG_CONFIG_HOME", root.join("xdg"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                root.join("synthetic-config.json"),
            )
            .env_remove("OPENCLAW_CLI_PATH")
            .env_remove("OPENCLAW_BUNDLE_ROOT")
            .current_dir(&root)
            .output()
            .unwrap()
    };
    let failed = run(false);
    assert_eq!(
        failed.status.code(),
        Some(1),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&failed.stdout),
        String::from_utf8_lossy(&failed.stderr)
    );
    assert!(String::from_utf8_lossy(&failed.stderr)
        .contains("generic detector failed: detection command contains an embedded NUL"));
    let listed = run(true);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&listed.stdout).unwrap();
    let row = rows
        .iter()
        .find(|v| v["id"] == "synthetic-invalid-detector")
        .unwrap();
    assert_eq!(row["detected"], false);
    assert_eq!(row["reason"], "");
    assert!(!root.join("synthetic-config.json").exists());
}
