//! Native uninstall must preserve a foreign directory sharing OpenClaw's ID,
//! even when the exact same dataDir is spelled with a trailing dot.
use super::*;
#[test]
fn openclaw_foreign_directory_entry_survives_trailing_dot_data_dir_in_real_native_cleanup() {
    let f = Fixture::new();
    f.package_with(&[(
        "agents.d/openclaw.json",
        include_str!("../../agents.d/openclaw.json"),
    )]);
    let settings = f.root.path().join(".openclaw/openclaw.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let foreign = f.root.path().join("other-install/plugins/openclaw");
    fs::create_dir_all(&foreign).unwrap();
    let sentinel = foreign.join("foreign-asset.txt");
    fs::write(&sentinel, "foreign exact bytes").unwrap();
    let spec =
        json!([reqwest::Url::from_file_path(&foreign).unwrap().to_string(),{"userOption":true}]);
    let managed = f.data.join("plugins/openclaw");
    let original = json!({"private":{"keep":true},"plugin":[managed,spec],
        "plugins":{"load":{"paths":[managed]},"entries":{"loongsuite-pilot-openclaw":{"enabled":true}},
            "allow":["loongsuite-pilot-openclaw","other"],"deny":["user-denied"]}});
    let expected = json!({"private":{"keep":true},"plugin":[spec],
        "plugins":{"load":{"paths":[]},"entries":{"loongsuite-pilot-openclaw":{"enabled":true}},
            "allow":["loongsuite-pilot-openclaw","other"],"deny":["user-denied"]}});
    let raw = original.to_string();
    for suffix in ["", "/."] {
        // Keep the binary, package, paths, environment and initial filesystem
        // identical. Only the installer input dataDir spelling changes.
        fs::remove_dir_all(&f.data).unwrap();
        fs::create_dir_all(&f.data).unwrap();
        fs::write(f.data.join("config.json"), "{}").unwrap();
        fs::write(&settings, &raw).unwrap();
        let backup = PathBuf::from(format!("{}.bak", settings.display()));
        if backup.exists() {
            fs::remove_file(&backup).unwrap();
        }
        let mut cmd = f.command(&f.binary);
        cmd.args(["installer-helper", "cleanup-agents", "--input-env"])
            .env(
                "LOONGSUITE_PILOT_INSTALL_INPUT",
                json!({
                    "dataDir":format!("{}{suffix}",f.data.display()),"pilotDir":f.candidate
                })
                .to_string(),
            );
        success(&bounded_for(cmd, Duration::from_secs(15)));
        let actual: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(
            actual, expected,
            "dataDir suffix {suffix:?} must preserve shared foreign entry"
        );
        assert_eq!(fs::read(&sentinel).unwrap(), b"foreign exact bytes");
        assert_eq!(fs::read_to_string(backup).unwrap(), raw);
        assert_eq!(fs::read(f.data.join("config.json")).unwrap(), b"{}");
    }
}
