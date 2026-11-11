#[cfg(test)]
mod resource_history_tests {
    use super::*;
    use crate::updater::activation_file_targets as binding;

    fn paths(data: &Path, cache: &Path, marker: bool) -> BTreeMap<String, PathBuf> {
        let mut paths = BTreeMap::from([
            ("current".into(), cache.join("current")),
            ("runtime-resource:plugins/dsh/plugin.mjs".into(), data.join("plugins/dsh/plugin.mjs")),
        ]);
        if marker { paths.insert(binding::DSH_MARKER.into(), data.join("plugins/dsh/.collection-enabled")); }
        paths
    }

    fn required(cache: &Path) -> BTreeMap<String, PathBuf> {
        [("current".into(), cache.join("current"))].into()
    }

    #[test]
    fn exact_external_marker_intent_never_enables_an_unselected_agent_and_rolls_back_real_bytes() {
        for selected in [false, true] {
            let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
            fs::create_dir_all(&data).unwrap();
            let marker=data.join("plugins/dsh/.collection-enabled");
            let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,true)).unwrap();
            tx.expect_dsh_marker().unwrap();
            assert!(!marker.exists(),"recording an external intent must not enable collection");
            tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();
            if selected { atomic_write(&marker,b"enabled\n",0o600).unwrap(); }
            tx.write("current",b"candidate\n",0o600).unwrap();
            if selected {
                tx.rollback().unwrap();assert!(!marker.exists());assert!(!data.join("plugins/dsh/plugin.mjs").exists());
            } else {tx.commit().unwrap();assert!(!marker.exists());}
        }
    }

    #[test]
    fn marker_user_changes_block_all_rollback_and_survive_with_the_journal() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,true)).unwrap();
        tx.expect_dsh_marker().unwrap();
        tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();
        tx.write("current",b"candidate\n",0o600).unwrap();
        fs::write(data.join("plugins/dsh/.collection-enabled"),"private user change").unwrap();
        assert!(tx.rollback().is_err());assert_eq!(fs::read(cache.join("current")).unwrap(),b"candidate\n");
        assert_eq!(fs::read(data.join("plugins/dsh/.collection-enabled")).unwrap(),b"private user change");
        tx.finished=true;
        assert!(cache.join("update-recovery.json").exists());
    }

    #[test]
    fn registered_subset_recovery_uses_recorded_authority_and_keeps_the_schema2_file_format() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,true)).unwrap();
        tx.expect_dsh_marker().unwrap();tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();
        atomic_write(&data.join("plugins/dsh/.collection-enabled"),b"enabled\n",0o600).unwrap();
        let raw:serde_json::Value=serde_json::from_slice(&fs::read(cache.join("update-recovery.json")).unwrap()).unwrap();
        assert_eq!(raw["schema"],2);assert!(raw.get("directories").is_none());assert!(raw.get("rolled_back").is_none());
        tx.finished=true;drop(tx);
        ActivationTransaction::recover_registered(&cache,&[required(&cache)],
            &crate::deployment::runtime_data_assets::registry(&data,true)).unwrap();
        assert!(!data.join("plugins/dsh/plugin.mjs").exists());assert!(!data.join("plugins/dsh/.collection-enabled").exists());
        assert!(!cache.join("update-recovery.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_never_reauthorizes_an_ancestor_replaced_with_another_installation_link() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("A");let other=root.path().join("B");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,false)).unwrap();
        tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();
        tx.write("current",b"candidate\n",0o600).unwrap();tx.finished=true;drop(tx);
        fs::rename(&data,&other).unwrap();std::os::unix::fs::symlink(&other,&data).unwrap();
        let recovered=ActivationTransaction::recover_registered(&cache,&[required(&cache)],
            &crate::deployment::runtime_data_assets::registry(&data,true));
        assert!(recovered.is_err());
        assert_eq!(fs::read(other.join("plugins/dsh/plugin.mjs")).unwrap(),b"candidate");
        assert_eq!(fs::read(cache.join("current")).unwrap(),b"candidate\n");
        assert!(cache.join("update-recovery.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn skipped_optional_registry_links_are_never_bound_or_snapshotted_during_recovery() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,false)).unwrap();
        tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();tx.finished=true;drop(tx);
        std::os::unix::fs::symlink(data.join("skills"),data.join("skills")).unwrap();
        ActivationTransaction::recover_registered(&cache,&[required(&cache)],
            &crate::deployment::runtime_data_assets::registry(&data,true)).unwrap();
        assert!(fs::symlink_metadata(data.join("skills")).unwrap().file_type().is_symlink());
        assert!(!data.join("plugins/dsh/plugin.mjs").exists());
    }

    #[test]
    fn fresh_case_aliases_and_case_alias_of_journal_are_refused_before_any_write_on_all_filesystems() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let names=BTreeMap::from([
            ("config".into(),data.join("plugins/dsh/PLUGIN.MJS")),
            ("runtime-resource:plugins/dsh/plugin.mjs".into(),data.join("plugins/dsh/plugin.mjs")),
        ]);
        assert!(ActivationTransaction::begin(&cache,names).is_err());
        assert!(ActivationTransaction::begin(&cache,
            [("config".into(),cache.join("UPDATE-RECOVERY.JSON"))].into()).is_err());
        assert!(!cache.exists());assert!(!data.join("plugins").exists());
    }

    #[cfg(target_os="linux")]
    #[test]
    fn case_sensitive_distinct_installation_never_gains_authority_from_overlap_case_folding() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("A");let other=root.path().join("a");let cache=root.path().join("cache");
        fs::create_dir_all(&data).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,false)).unwrap();
        tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).unwrap();tx.finished=true;drop(tx);
        fs::create_dir_all(other.join("plugins/dsh")).unwrap();fs::write(other.join("plugins/dsh/plugin.mjs"),"candidate").unwrap();
        let recovered=ActivationTransaction::recover_registered(&cache,&[required(&cache)],
            &crate::deployment::runtime_data_assets::registry(&other,true));
        assert!(recovered.is_err());
        assert_eq!(fs::read(data.join("plugins/dsh/plugin.mjs")).unwrap(),b"candidate");
        assert_eq!(fs::read(other.join("plugins/dsh/plugin.mjs")).unwrap(),b"candidate");
    }

    #[test]
    fn alias_duplicate_targets_and_budget_overflow_fail_before_any_journal_or_file_write() {
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(data.join("plugins/dsh")).unwrap();fs::create_dir_all(data.join("other")).unwrap();
        let duplicate=BTreeMap::from([
            ("config".into(),data.join("other/../plugins/dsh/plugin.mjs")),
            ("runtime-resource:plugins/dsh/plugin.mjs".into(),data.join("plugins/dsh/plugin.mjs")),
        ]);
        assert!(ActivationTransaction::begin(&cache,duplicate).is_err());
        let oversized=(0..33).map(|index|(format!("target-{index}"),data.join(format!("file-{index}")))).collect();
        assert!(ActivationTransaction::begin(&cache,oversized).is_err());
        assert!(!cache.join("update-recovery.json").exists());assert!(!data.join("plugins/dsh/plugin.mjs").exists());
    }

    #[test]
    fn source_role_registry_and_six_platform_budget_are_explicit_and_bounded() {
        let root=tempfile::tempdir().unwrap();
        let registry=crate::deployment::runtime_data_assets::registry(root.path(),true);
        let qoder_cli_paths = [
            "hooks/qodercli-runtime-wrapper.sh",
            "hooks/qodercli-token-intercept.mjs",
        ];
        let qoder_cli_roles = if cfg!(unix) { qoder_cli_paths.len() } else { 0 };
        assert_eq!(registry.len(), 22 + qoder_cli_roles);
        for relative in qoder_cli_paths {
            let role = format!("runtime-resource:{relative}");
            let target = root.path().join(relative);
            assert_eq!(registry.get(&role), cfg!(unix).then_some(&target));
        }
        let actual:std::collections::BTreeSet<_>=walkdir::WalkDir::new(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/skills"))
            .into_iter().map(Result::unwrap).filter(|entry|entry.file_type().is_file())
            .map(|entry|entry.path().strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/skills"))
                .unwrap().to_str().unwrap().replace('\\',"/")).collect();
        let registered:std::collections::BTreeSet<_>=crate::deployment::runtime_data_assets::SKILLS.iter().map(|path|path.to_string()).collect();
        assert!(actual.is_subset(&registered),"new resources require an explicit append-only recovery role");
        // Budget for the two plugin files, their marker, the Unix Qoder pair,
        // and the six other activation targets on every supported platform.
        assert!(actual.len() + 2 + 1 + qoder_cli_paths.len() + 6 <= MAX_TARGETS);
    }

    #[cfg(unix)]
    #[test]
    fn readonly_parent_is_refused_even_under_uid_zero_without_creating_a_resource_file() {
        use std::os::unix::fs::PermissionsExt;
        let root=tempfile::tempdir().unwrap();let data=root.path().join("data");let cache=root.path().join("cache");
        fs::create_dir_all(data.join("plugins/dsh")).unwrap();
        let mut tx=ActivationTransaction::begin(&cache,paths(&data,&cache,false)).unwrap();
        fs::set_permissions(data.join("plugins/dsh"),fs::Permissions::from_mode(0o555)).unwrap();
        assert!(tx.write("runtime-resource:plugins/dsh/plugin.mjs",b"candidate",0o644).is_err());
        assert!(!data.join("plugins/dsh/plugin.mjs").exists());
        fs::set_permissions(data.join("plugins/dsh"),fs::Permissions::from_mode(0o755)).unwrap();
        tx.rollback().unwrap();
    }
}
