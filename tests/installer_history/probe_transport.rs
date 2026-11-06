use super::*;
#[test]
fn installer_probe_preserves_unicode_json_across_legacy_codepages_without_public_flags_or_writes() {
    let f = Fixture::new();
    let mut definition: Value =
        serde_json::from_str(include_str!("../../agents.d/openclaw.json")).unwrap();
    let display = "探测 \"quoted\" O'Brien \u{feff}🚀";
    definition["displayName"] = json!(display);
    let definition = definition.to_string();
    f.package_with(&[("agents.d/openclaw.json", &definition)]);
    let app = f.root.path().join("应用 O'Brien [只读]🚀");
    fs::create_dir_all(&app).unwrap();
    let entry = app.join("openclaw.mjs");
    fs::write(&entry, "/* private metadata fixture: never executed */").unwrap();
    fs::write(
        app.join("package.json"),
        r#"{"name":"openclaw","version":"2026.6.10"}"#,
    )
    .unwrap();
    fs::write(f.data.join("config.json"),"\u{feff}{\"agents\":{\"openclaw\":{\"captureMessageContent\":false}},\"keep\":\"保留\u{feff}\"}\n").unwrap();
    let snapshot = || {
        // WalkDir caches Windows enumeration metadata. Close all enumeration
        // handles before taking fresh, non-following metadata for every path.
        let mut paths = walkdir::WalkDir::new(f.root.path())
            .into_iter()
            .map(|entry| entry.unwrap().into_path())
            .collect::<Vec<_>>();
        paths.sort();
        paths
            .into_iter()
            .map(|path| {
                let meta = fs::symlink_metadata(&path).unwrap();
                (
                    path.strip_prefix(f.root.path()).unwrap().to_path_buf(),
                    meta.len(),
                    meta.modified().unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    let before = snapshot();
    let config = fs::read(f.data.join("config.json")).unwrap();
    let invoke = |installer: bool| {
        let mut command = f.command(&f.binary);
        command
            .arg("probe")
            .current_dir(&app)
            .env("AGENT_DATA_COLLECTION_CONFIG", f.data.join("config.json"));
        if installer {
            command.arg("--installer");
        }
        bounded(command)
    };
    let ordinary = invoke(false);
    success(&ordinary);
    assert!(
        !ordinary.stdout.is_ascii(),
        "ordinary probe retains existing human-readable UTF8 JSON"
    );
    let (legacy_regular, _, _) = encoding_rs::GBK.decode(&ordinary.stdout);
    let corrupted: Value = serde_json::from_str(&legacy_regular).unwrap();
    let ordinary: Value = serde_json::from_slice(&ordinary.stdout).unwrap();
    assert_ne!(
        corrupted, ordinary,
        "actual legacy-codepage decoding demonstrates the raw UTF8 transport hazard"
    );
    let installer = invoke(true);
    success(&installer);
    assert!(
        installer.stdout.is_ascii(),
        "internal installer JSON must survive legacy stdout codepages"
    );
    let decoded: Value = serde_json::from_slice(&installer.stdout).unwrap();
    assert_eq!(decoded, ordinary);
    let openclaw = decoded
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "openclaw")
        .unwrap();
    assert_eq!(openclaw["displayName"], display);
    assert_eq!(openclaw["detected"], true);
    assert_eq!(
        fs::canonicalize(openclaw["openclawCliPath"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&entry).unwrap()
    );
    for encoding in [encoding_rs::GBK, encoding_rs::WINDOWS_1252] {
        let (text, _, errors) = encoding.decode(&installer.stdout);
        assert!(!errors);
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), ordinary);
    }
    assert_eq!(fs::read(f.data.join("config.json")).unwrap(), config);
    assert_eq!(
        snapshot(),
        before,
        "probe cannot create/update user config, cache or files"
    );
}
