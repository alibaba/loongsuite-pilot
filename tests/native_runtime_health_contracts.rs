//! Native release-health monitoring, with tiny non-executable format fixtures.
use loongsuite_pilot::metrics::{
    DataflowSnapshot, MetricsCollector, MetricsCollectorOptions, RuntimeProbe,
};
use loongsuite_pilot::utils::runtime_paths::{
    build_edition, build_target, sha256_file, RuntimeManifest, RuntimeResource,
};
use std::path::{Path, PathBuf};

// These are header-only synthetic format fixtures, never execution artifacts.
// Copied from native_binary's existing test-data constructor, not its validator.
fn fixture_image(target: &str) -> Vec<u8> {
    let arm = target.starts_with("aarch64-");
    let mut bytes = vec![0; 1024];
    let put16 = |bytes: &mut [u8], offset, value: u16| {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes())
    };
    let put32 = |bytes: &mut [u8], offset, value: u32| {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes())
    };
    let put64 = |bytes: &mut [u8], offset, value: u64| {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes())
    };
    if target.contains("linux") {
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        put16(&mut bytes, 16, 3);
        put16(&mut bytes, 18, if arm { 183 } else { 62 });
        put32(&mut bytes, 20, 1);
        put64(&mut bytes, 24, 512);
        put64(&mut bytes, 32, 64);
        put16(&mut bytes, 52, 64);
        put16(&mut bytes, 54, 56);
        put16(&mut bytes, 56, 1);
        put32(&mut bytes, 64, 1);
        put64(&mut bytes, 96, 1024);
        put64(&mut bytes, 104, 4096);
    } else if target.contains("apple") {
        put32(&mut bytes, 0, 0xfeedfacf);
        put32(&mut bytes, 4, if arm { 0x0100000c } else { 0x01000007 });
        put32(&mut bytes, 12, 2);
        put32(&mut bytes, 16, 2);
        put32(&mut bytes, 20, 96);
        put32(&mut bytes, 32, 0x19);
        put32(&mut bytes, 36, 72);
        put64(&mut bytes, 64, 4096);
        put64(&mut bytes, 80, 1024);
        put32(&mut bytes, 104, 0x80000028);
        put32(&mut bytes, 108, 24);
        put64(&mut bytes, 112, 512);
    } else if target.contains("windows") {
        bytes[..2].copy_from_slice(b"MZ");
        put32(&mut bytes, 60, 64);
        bytes[64..68].copy_from_slice(b"PE\0\0");
        put16(&mut bytes, 68, if arm { 0xaa64 } else { 0x8664 });
        put16(&mut bytes, 70, 1);
        put16(&mut bytes, 84, 112);
        put16(&mut bytes, 86, 2);
        put16(&mut bytes, 88, 0x20b);
        put32(&mut bytes, 104, 4096);
        put16(&mut bytes, 156, 3);
        put32(&mut bytes, 216, 512);
        put32(&mut bytes, 220, 512);
    } else {
        panic!("fixture 不支持的目标");
    }
    bytes
}

fn package(root: &Path, version: &str) -> PathBuf {
    let binary = if cfg!(windows) {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    };
    let mut resources = Vec::new();
    for (relative, body) in [
        (binary, fixture_image(build_target())),
        ("VERSION", format!("version={version}\n").into_bytes()),
        ("LICENSE", b"synthetic license".to_vec()),
        ("agents.d/fixture.json", b"{}".to_vec()),
        ("assets/fixture", b"synthetic resource".to_vec()),
    ] {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        resources.push(RuntimeResource {
            path: relative.into(),
            sha256: sha256_file(&path).unwrap(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.join(binary), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }
    let manifest = RuntimeManifest {
        schema: 1,
        runtime: "rust".into(),
        version: version.into(),
        git_commit: "a".repeat(40),
        target: build_target().into(),
        edition: build_edition().into(),
        binary: binary.into(),
        resources,
    };
    std::fs::write(
        root.join("runtime-manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    root.join(binary)
}
#[test]
fn native_current_previous_and_count_use_valid_releases_not_just_directory_names() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let cache = root.path().join("cache");
    let current = cache.join("versions/1.2.0_current");
    let previous = cache.join("versions/1.1.0_previous");
    let binary = package(&current, "1.2.0");
    package(&previous, "1.1.0");
    std::fs::create_dir(cache.join("versions/.staging")).unwrap();
    std::fs::write(cache.join("versions/.DS_Store"), "ignore").unwrap();
    std::fs::write(cache.join("versions/README"), "not a version").unwrap();
    std::fs::write(cache.join("current"), "1.2.0_current\n").unwrap();
    let mut opts = MetricsCollectorOptions::new("1.2.0", "synthetic-user", data.to_string_lossy());
    opts.auto_update_enabled = false;
    opts.runtime_probe = Some(RuntimeProbe {
        exec_path: binary,
        cache_dir: Some(cache.clone()),
    });
    let mut collector = MetricsCollector::from_options(opts);
    let row = collector.collect_l1(&DataflowSnapshot::default());
    assert_eq!(row.current_version_valid, "true");
    assert_eq!(row.runtime_bin_valid, "true");
    assert_eq!(row.rollback_available, "false");
    assert_eq!(row.version_count, "2");
    assert_eq!(row.node_bin_valid, "not-applicable");
    std::fs::write(cache.join("previous"), "1.1.0_previous\n").unwrap();
    assert_eq!(
        collector
            .collect_l1(&DataflowSnapshot::default())
            .rollback_available,
        "true"
    );
    std::fs::write(cache.join("current"), "missing_release\n").unwrap();
    let missing = collector.collect_l1(&DataflowSnapshot::default());
    assert_eq!(missing.current_version_valid, "false");
    assert_eq!(
        missing.runtime_bin_valid, "true",
        "current pointer cannot replace the running binary's own manifest"
    );
    std::fs::write(cache.join("current"), "1.2.0_current\n").unwrap();
    std::fs::write(previous.join("assets/fixture"), "tampered").unwrap();
    assert_eq!(
        collector
            .collect_l1(&DataflowSnapshot::default())
            .rollback_available,
        "false"
    );
    std::fs::write(current.join("assets/fixture"), "tampered").unwrap();
    let corrupt = collector.collect_l1(&DataflowSnapshot::default());
    assert_eq!(corrupt.current_version_valid, "false");
    assert_eq!(corrupt.runtime_bin_valid, "false");
    assert!(collector
        .last_infra_health()
        .unwrap()
        .runtime_diagnostic
        .as_ref()
        .unwrap()
        .contains("摘要不匹配"));
}
#[test]
fn native_read_only_health_does_not_probe_or_repair_any_node_candidate() {
    let root = tempfile::tempdir().unwrap();
    let binary = package(&root.path().join("versions/1.2.0"), "1.2.0");
    std::fs::write(root.path().join("current"), "1.2.0").unwrap();
    let pin = "/missing/legacy/node\n";
    std::fs::write(root.path().join("node-bin"), pin).unwrap();
    let marker = root.path().join("unexpected-node-execution");
    for suffix in [
        "node-v16.0.0/bin/node",
        "node-v24.1.0/bin/node",
        "node-v99.0.0/node.exe",
        "node-v99.0.0/bin/node.exe",
    ] {
        let candidate = root.path().join("runtime").join(suffix);
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(
            &candidate,
            format!(
                "#!/bin/sh\nprintf invoked > '{}'\necho v24.1.0\n",
                marker.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(candidate, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let mut opts =
        MetricsCollectorOptions::new("1.2.0", "synthetic-user", root.path().to_string_lossy());
    opts.auto_update_enabled = false;
    opts.runtime_probe = Some(RuntimeProbe {
        exec_path: binary,
        cache_dir: Some(root.path().into()),
    });
    let mut collector = MetricsCollector::from_options(opts);
    let executable_pin = format!(
        "{}\n",
        root.path().join("runtime/node-v24.1.0/bin/node").display()
    );
    for pin in [pin.to_string(), executable_pin] {
        std::fs::write(root.path().join("node-bin"), &pin).unwrap();
        for _ in 0..3 {
            let row = collector.collect_l1(&DataflowSnapshot::default());
            assert_eq!(row.node_bin_valid, "not-applicable");
            assert_eq!(row.runtime_bin_valid, "true");
            assert_eq!(
                std::fs::read_to_string(root.path().join("node-bin")).unwrap(),
                pin
            );
            assert!(!marker.exists());
        }
    }
}
#[cfg(unix)]
#[test]
fn native_health_distinguishes_absent_and_nonexecutable_binaries_without_execution() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("native-bin");
    let options = || {
        let mut opts =
            MetricsCollectorOptions::new("1.2.0", "synthetic-user", root.path().to_string_lossy());
        opts.auto_update_enabled = false;
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: path.clone(),
            cache_dir: Some(root.path().into()),
        });
        opts
    };
    let mut absent = MetricsCollector::from_options(options());
    assert_eq!(
        absent
            .collect_l1(&DataflowSnapshot::default())
            .runtime_bin_valid,
        "false"
    );
    let absent_reason = absent
        .last_infra_health()
        .unwrap()
        .runtime_diagnostic
        .clone()
        .unwrap();
    std::fs::write(&path, b"non-executable synthetic bytes").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let mut nonexecutable = MetricsCollector::from_options(options());
    assert_eq!(
        nonexecutable
            .collect_l1(&DataflowSnapshot::default())
            .runtime_bin_valid,
        "false"
    );
    let nonexecutable_reason = nonexecutable
        .last_infra_health()
        .unwrap()
        .runtime_diagnostic
        .clone()
        .unwrap();
    assert_ne!(absent_reason, nonexecutable_reason);
    assert!(nonexecutable_reason.contains("没有执行权限"));
}

#[test]
fn native_health_distinguishes_absent_from_present_invalid_format_without_execution() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let package_root = root.path().join("package");
    let binary = package(&package_root, "1.2.0");
    let options = || {
        let mut opts =
            MetricsCollectorOptions::new("1.2.0", "synthetic-user", data.to_string_lossy());
        opts.auto_update_enabled = false;
        opts.runtime_probe = Some(RuntimeProbe {
            exec_path: binary.clone(),
            cache_dir: Some(data.clone()),
        });
        opts
    };
    std::fs::remove_file(&binary).unwrap();
    let mut absent = MetricsCollector::from_options(options());
    assert_eq!(
        absent
            .collect_l1(&DataflowSnapshot::default())
            .runtime_bin_valid,
        "false"
    );
    let absent_reason = absent
        .last_infra_health()
        .unwrap()
        .runtime_diagnostic
        .clone()
        .unwrap();
    std::fs::write(&binary, b"this is not an executable image\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = package_root.join("runtime-manifest.json");
    let mut manifest: RuntimeManifest =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let binary_path = manifest.binary.clone();
    manifest
        .resources
        .iter_mut()
        .find(|entry| entry.path == binary_path)
        .unwrap()
        .sha256 = sha256_file(&binary).unwrap();
    std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut invalid = MetricsCollector::from_options(options());
    assert_eq!(
        invalid
            .collect_l1(&DataflowSnapshot::default())
            .runtime_bin_valid,
        "false"
    );
    let present_reason = invalid
        .last_infra_health()
        .unwrap()
        .runtime_diagnostic
        .clone()
        .unwrap();
    assert_ne!(absent_reason, present_reason);
    assert!(present_reason.contains("二进制格式或架构不匹配"));
}
