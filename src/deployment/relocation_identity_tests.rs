use super::*;
use serde_json::json;

#[test]
fn identity_reader_uses_a_real_serialized_analytics_config_auto_update_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.json");
    let env = std::collections::HashMap::new();
    let file =
        json!({"dataDir":temp.path(),"dashboard":{"enabled":false},"autoUpdate":{"enabled":false}});
    let mut config = crate::core::assemble_config(
        Some(&file),
        None,
        &crate::core::ConfigSources {
            env: &env,
            platform: crate::utils::Platform::current(),
            hostname: "identity-fixture",
            config_path: path.to_str().unwrap(),
            global_poll_ms: None,
        },
    )
    .unwrap();
    config.auto_update = Some(
        serde_json::from_value(
            json!({"enabled":false,"checkIntervalMs":60000,"installId":"typed-current"}),
        )
        .unwrap(),
    );
    let bytes = serde_json::to_vec_pretty(&config).unwrap();
    let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(raw["autoUpdate"]["installId"], "typed-current");
    assert!(raw.get("installId").is_none());
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(
        read_install_id(&path).unwrap().as_deref(),
        Some("typed-current")
    );
    assert_eq!(
        effective_install_id(&config).unwrap().as_deref(),
        Some("typed-current")
    );
}
#[test]
fn legacy_top_level_updater_identity_is_compatible_but_any_conflicting_pair_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.json");
    for value in [
        json!({"installId":"legacy-updater"}),
        json!({"autoUpdate":null,"installId":"legacy-updater"}),
        json!({"autoUpdate":{"installId":"legacy-updater"},"installId":"legacy-updater"}),
    ] {
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            read_install_id(&path).unwrap().as_deref(),
            Some("legacy-updater")
        );
    }
    for value in [
        json!({"autoUpdate":{"installId":"nested"},"installId":"different"}),
        json!({"autoUpdate":{"installId":123},"installId":"legacy-updater"}),
        json!({"autoUpdate":{"installId":"nested"},"installId":""}),
        json!([]),
        json!({"autoUpdate":[]}),
        json!({"autoUpdate":"invalid"}),
        json!({"autoUpdate":{"installId":null}}),
    ] {
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_install_id(&path).is_err());
    }
}
#[test]
fn opened_object_type_is_revalidated_after_the_metadata_path_is_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    std::fs::write(&path, b"owned").unwrap();
    let result = open_owned_checked(&path, false, || {
        std::fs::rename(&path, temp.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
    });
    assert!(result.is_err());
}
#[cfg(unix)]
#[test]
fn metadata_to_fifo_replacement_cannot_block_owned_file_open() {
    use std::os::unix::fs::OpenOptionsExt;
    use std::time::Duration;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    std::fs::write(&path, b"owned").unwrap();
    let child_path = path.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let result = open_owned_checked(&child_path, false, || {
            std::fs::remove_file(&child_path).unwrap();
            let c = std::ffi::CString::new(child_path.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        });
        send.send(result.is_err()).unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(2));
    // If a regression blocks the reader, a nonblocking writer releases it so
    // this negative control reports failure without orphaning a blocked thread.
    if result.is_err() {
        let _release = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path);
    }
    thread.join().unwrap();
    assert!(result.unwrap());
}

#[test]
fn canonical_user_config_null_auto_update_is_legal_unknown_or_preserves_its_root_identity() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("config.json");
    for value in [json!({}), json!({"autoUpdate":null})] {
        std::fs::write(&path, value.to_string()).unwrap();
        assert_eq!(read_install_id(&path).unwrap(), None);
    }
    std::fs::write(
        &path,
        json!({"autoUpdate":null,"installId":"current-root-id"}).to_string(),
    )
    .unwrap();
    assert_eq!(
        read_install_id(&path).unwrap().as_deref(),
        Some("current-root-id")
    );
}
