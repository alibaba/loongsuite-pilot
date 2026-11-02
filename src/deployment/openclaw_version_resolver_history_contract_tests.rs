use super::*;
use serde_json::json;
use std::path::PathBuf;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        Self { _temp: temp, root }
    }
    fn pkg(&self, relative: &str, version: &str, name: &str) -> PathBuf {
        let dir = self.root.join(relative);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            json!({"name":name,"version":version}).to_string(),
        )
        .unwrap();
        let entry = dir.join("openclaw.mjs");
        std::fs::write(&entry, "/* metadata test, never executed */").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        entry
    }
    fn link(&self, source: &Path, destination: &Path) {
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(source, destination).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(source, destination).unwrap();
    }
    fn env(&self, pairs: &[(&str, String)]) -> HashMap<String, String> {
        let mut result = HashMap::from([
            ("HOME".into(), self.root.to_string_lossy().into_owned()),
            (
                "USERPROFILE".into(),
                self.root.to_string_lossy().into_owned(),
            ),
        ]);
        for (key, value) in pairs {
            result.insert((*key).into(), value.clone());
        }
        if let Some(home) = result.get("HOME").cloned() {
            result.insert("USERPROFILE".into(), home);
        }
        result
    }
    async fn host(&self, pairs: &[(&str, String)], cwd: &Path) -> Option<OpenClawHost> {
        resolve_openclaw_host(
            &self.env(pairs),
            cwd.to_str().unwrap(),
            None::<fn(String)>,
            OpenClawResolveMode::Runtime,
        )
        .await
    }
    fn path(&self, paths: &[PathBuf]) -> String {
        std::env::join_paths(paths)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
    fn shell(&self, dir: &str) -> PathBuf {
        self.root.join(dir).join("openclaw")
    }
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn assert_source(host: &OpenClawHost, entry: &Path) {
    assert_eq!(
        std::fs::canonicalize(&host.source).unwrap(),
        std::fs::canonicalize(entry.parent().unwrap().join("package.json")).unwrap()
    );
}
#[tokio::test]
async fn source_l27_real_npm_and_pnpm_executable_links_resolve_metadata_without_execution() {
    for layout in [
        "npm/lib/node_modules/openclaw",
        "pnpm/.pnpm/openclaw@2026.3.8/node_modules/openclaw",
    ] {
        let f = Fixture::new();
        let entry = f.pkg(layout, "2026.3.8", "openclaw");
        let link = f.shell("bin");
        f.link(&entry, &link);
        let host = f
            .host(&[("PATH", text(link.parent().unwrap()))], &f.root)
            .await
            .unwrap();
        assert_eq!(host.version, "2026.3.8");
        assert_eq!(host.adapter, "legacy");
        assert!(!host.conversation_access);
        assert_source(&host, &entry);
    }
}
#[tokio::test]
async fn source_l38_enterprise_wrapper_version_is_not_the_nested_openclaw_version() {
    let f = Fixture::new();
    let entry = f.pkg(".openclaw-bundle/wrapper", "1.0.0", "wrapper");
    f.pkg(".openclaw-bundle/openclaw", "1.0.0", "openclaw-bundle-cli");
    f.pkg(
        ".openclaw-bundle/openclaw/node_modules/openclaw",
        "2026.3.8",
        "openclaw",
    );
    assert_eq!(
        f.host(&[("OPENCLAW_CLI_PATH", text(&entry))], &f.root)
            .await
            .unwrap()
            .version,
        "2026.3.8"
    );
}
#[tokio::test]
async fn source_l44_pnpm_shell_wrapper_finds_fixed_package_without_reading_or_running_script() {
    let f = Fixture::new();
    let entry = f.pkg(
        "pnpm/global/5/node_modules/openclaw",
        "2026.3.8",
        "openclaw",
    );
    let wrapper = f.shell("pnpm");
    std::fs::write(&wrapper, "#!/bin/sh\nexit 99\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let host = f
        .host(&[("PATH", text(wrapper.parent().unwrap()))], &f.root)
        .await
        .unwrap();
    assert_source(&host, &entry);
}
#[tokio::test]
async fn source_l50_first_opaque_path_entry_is_not_bypassed_by_later_installation() {
    let f = Fixture::new();
    std::fs::create_dir(f.root.join("first")).unwrap();
    let opaque = f.shell("first");
    std::fs::write(&opaque, "opaque binary").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&opaque, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let entry = f.pkg("second", "2026.3.8", "openclaw");
    f.link(&entry, &f.shell("second"));
    assert!(f
        .host(
            &[(
                "PATH",
                f.path(&[f.root.join("first"), f.root.join("second")])
            )],
            &f.root
        )
        .await
        .is_none());
}
#[tokio::test]
async fn source_l57_source_container_cwd_needs_no_path_command() {
    let f = Fixture::new();
    f.pkg("app", "2026.3.8", "openclaw");
    assert_eq!(
        f.host(&[], &f.root.join("app")).await.unwrap().version,
        "2026.3.8"
    );
}
#[tokio::test]
async fn source_l61_both_versions_are_found_only_in_the_fixed_child_of_container_cwd() {
    for version in ["2026.3.8", "2026.6.10"] {
        let f = Fixture::new();
        let entry = f.pkg("app/openclaw", version, "openclaw");
        f.pkg("app", "1.0.0", "customer-container");
        let host = f.host(&[], &f.root.join("app")).await.unwrap();
        assert_eq!(host.executable, Some(text(&entry)));
        assert_eq!(host.version, version);
        assert_eq!(host.binding.as_deref(), Some("auto-entry"));
    }
}
#[tokio::test]
async fn source_l68_arbitrary_nested_vendor_directory_is_not_recursively_searched() {
    let f = Fixture::new();
    f.pkg("app/vendor/openclaw", "2026.3.8", "openclaw");
    assert!(f.host(&[], &f.root.join("app")).await.is_none());
}
#[tokio::test]
async fn source_l83_unidentified_parent_with_present_or_looped_launch_entry_blocks_fixed_child() {
    for kind in ["present", "loop"] {
        let f = Fixture::new();
        f.pkg("app/openclaw", "2026.3.8", "openclaw");
        std::fs::write(f.root.join("app/package.json"), "{").unwrap();
        let entry = f.root.join("app/openclaw.mjs");
        if kind == "present" {
            std::fs::write(&entry, "/* unknown installation */").unwrap();
        } else {
            f.link(&entry, &entry);
        }
        assert!(f.host(&[], &f.root.join("app")).await.is_none());
    }
}
#[tokio::test]
async fn source_l108_unidentified_parent_does_not_escape_to_path_when_child_missing_or_unrelated() {
    for kind in ["missing", "unrelated"] {
        let f = Fixture::new();
        let entry = f.pkg("cli", "2026.3.8", "openclaw");
        f.link(&entry, &f.shell("cli"));
        std::fs::create_dir(f.root.join("app")).unwrap();
        std::fs::write(f.root.join("app/package.json"), "{").unwrap();
        if kind == "unrelated" {
            f.pkg("app/openclaw", "1.0.0", "unrelated");
        }
        assert!(f
            .host(&[("PATH", text(&f.root.join("cli")))], &f.root.join("app"))
            .await
            .is_none());
    }
}
#[tokio::test]
async fn source_l116_recovering_child_keeps_the_distinct_path_installation_conflict_guard() {
    let f = Fixture::new();
    f.pkg("app/openclaw", "2026.3.8", "openclaw");
    std::fs::write(f.root.join("app/package.json"), "{").unwrap();
    let entry = f.pkg("cli", "2026.6.10", "openclaw");
    f.link(&entry, &f.shell("cli"));
    assert!(f
        .host(&[("PATH", text(&f.root.join("cli")))], &f.root.join("app"))
        .await
        .is_none());
}
#[tokio::test]
async fn source_l123_confirmed_unsupported_parent_is_not_bypassed_by_fixed_child() {
    let f = Fixture::new();
    f.pkg("app", "2026.3.2", "openclaw");
    f.pkg("app/openclaw", "2026.3.8", "openclaw");
    assert!(f.host(&[], &f.root.join("app")).await.is_none());
}
#[tokio::test]
async fn source_l141_distinct_cwd_and_child_installations_are_rejected_for_both_versions() {
    for version in ["2026.3.8", "2026.6.10"] {
        let f = Fixture::new();
        f.pkg("app", "2026.3.8", "openclaw");
        f.pkg("app/openclaw", version, "openclaw");
        assert!(f.host(&[], &f.root.join("app")).await.is_none());
    }
}
#[tokio::test]
async fn source_l146_child_and_path_links_to_same_installation_are_deduplicated() {
    let f = Fixture::new();
    let entry = f.pkg("app/openclaw", "2026.3.8", "openclaw");
    f.link(&entry, &f.shell("bin"));
    let host = f
        .host(&[("PATH", text(&f.root.join("bin")))], &f.root.join("app"))
        .await
        .unwrap();
    assert_eq!(host.executable, Some(text(&entry)));
    assert_eq!(host.binding.as_deref(), Some("auto-entry"));
}
#[tokio::test]
async fn source_l153_all_invalid_fixed_children_block_other_valid_path_installations() {
    for problem in ["missing-entry", "unsupported", "broken-metadata"] {
        let f = Fixture::new();
        let entry = f.pkg(
            "app/openclaw",
            if problem == "unsupported" {
                "2026.3.2"
            } else {
                "2026.3.8"
            },
            "openclaw",
        );
        if problem == "missing-entry" {
            std::fs::remove_file(&entry).unwrap();
        }
        if problem == "broken-metadata" {
            std::fs::write(entry.parent().unwrap().join("package.json"), "{").unwrap();
        }
        let other = f.pkg("cli", "2026.3.8", "openclaw");
        f.link(&other, &f.shell("cli"));
        assert!(f
            .host(&[("PATH", text(&f.root.join("cli")))], &f.root.join("app"))
            .await
            .is_none());
    }
}
#[tokio::test]
async fn source_l161_explicit_binding_wins_while_unbound_distinct_cwd_path_conflict_is_rejected() {
    let f = Fixture::new();
    let old = f.pkg("gateway", "2026.3.8", "openclaw");
    let new = f.pkg("cli", "2026.6.10", "openclaw");
    f.link(&new, &f.shell("bin"));
    assert!(f
        .host(
            &[("PATH", text(&f.root.join("bin")))],
            &f.root.join("gateway")
        )
        .await
        .is_none());
    let bound = f
        .host(
            &[
                ("PATH", text(&f.root.join("bin"))),
                ("OPENCLAW_CLI_PATH", text(&old)),
            ],
            &f.root.join("gateway"),
        )
        .await
        .unwrap();
    assert_eq!(bound.version, "2026.3.8");
    assert!(!bound.conversation_access);
}
#[tokio::test]
async fn source_l170_unsupported_selected_package_is_not_replaced_by_other_or_stale_env_version() {
    let f = Fixture::new();
    let entry = f.pkg("old", "2026.3.2", "openclaw");
    f.pkg("new", "2026.5.12", "openclaw");
    assert!(f
        .host(
            &[
                ("OPENCLAW_CLI_PATH", text(&entry)),
                ("OPENCLAW_SERVICE_VERSION", "2026.5.12".into())
            ],
            &f.root
        )
        .await
        .is_none());
}
#[tokio::test]
async fn source_l175_nonabsolute_explicit_bindings_never_fall_back_to_cwd_or_path() {
    for entry in ["", "openclaw.mjs", "./app/openclaw.mjs"] {
        let f = Fixture::new();
        f.pkg("app", "2026.3.8", "openclaw");
        assert!(f
            .host(&[("OPENCLAW_CLI_PATH", entry.into())], &f.root.join("app"))
            .await
            .is_none());
    }
}
#[tokio::test]
async fn source_l301_package_metadata_alone_or_directory_entry_is_not_an_actual_source() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8", "openclaw");
    std::fs::remove_file(&entry).unwrap();
    assert!(f.host(&[], &f.root.join("app")).await.is_none());
    std::fs::create_dir(&entry).unwrap();
    assert!(f.host(&[], &f.root.join("app")).await.is_none());
}
#[tokio::test]
async fn source_l342_installed_metadata_beats_stale_environment_version() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8", "openclaw");
    assert_eq!(
        f.host(
            &[
                ("OPENCLAW_CLI_PATH", text(&entry)),
                ("OPENCLAW_SERVICE_VERSION", "2026.5.12".into())
            ],
            &f.root
        )
        .await
        .unwrap()
        .version,
        "2026.3.8"
    );
}
#[tokio::test]
async fn source_l347_broken_oversized_metadata_and_symlink_loops_fail_closed() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8", "openclaw");
    for bytes in ["{broken".to_owned(), " ".repeat(256 * 1024 + 1)] {
        std::fs::write(entry.parent().unwrap().join("package.json"), bytes).unwrap();
        assert!(f
            .host(&[("OPENCLAW_CLI_PATH", text(&entry))], &f.root)
            .await
            .is_none());
    }
    let looped = f.root.join("loop");
    f.link(&looped, &looped);
    assert!(f
        .host(&[("OPENCLAW_CLI_PATH", text(&looped))], &f.root)
        .await
        .is_none());
}
#[tokio::test]
async fn source_l356_environment_versions_alone_never_authorize_schema_or_installation() {
    let f = Fixture::new();
    for key in ["OPENCLAW_SERVICE_VERSION", "OPENCLAW_BUNDLED_VERSION"] {
        for version in ["2026.3.8", "2026.6.10"] {
            assert!(f.host(&[(key, version.into())], &f.root).await.is_none());
        }
    }
    assert!(f
        .host(
            &[
                ("OPENCLAW_VERSION", "2026.5.12".into()),
                ("npm_package_version", "2026.5.12".into())
            ],
            &f.root
        )
        .await
        .is_none());
}
#[tokio::test]
async fn source_l364_invalid_wrapper_metadata_still_checks_fixed_sibling_packages() {
    for content in ["{broken".to_owned(), " ".repeat(256 * 1024 + 1)] {
        let f = Fixture::new();
        let entry = f.pkg("wrapper", "1.0.0", "wrapper");
        std::fs::write(entry.parent().unwrap().join("package.json"), content).unwrap();
        f.pkg("wrapper/node_modules/openclaw", "2026.3.8", "openclaw");
        assert_eq!(
            f.host(&[("OPENCLAW_CLI_PATH", text(&entry))], &f.root)
                .await
                .unwrap()
                .version,
            "2026.3.8"
        );
    }
}
#[tokio::test]
async fn source_l370_confirmed_unsupported_wrapper_is_not_bypassed_by_nested_openclaw() {
    let f = Fixture::new();
    let entry = f.pkg("wrapper", "2026.3.2", "openclaw");
    f.pkg("wrapper/node_modules/openclaw", "2026.6.10", "openclaw");
    assert!(f
        .host(&[("OPENCLAW_CLI_PATH", text(&entry))], &f.root)
        .await
        .is_none());
}
#[test]
fn source_l375_all_ten_original_capability_boundaries_are_preserved() {
    let mut mismatches = Vec::new();
    for (version, adapter, access) in [
        ("2026.3.7", None, None),
        ("2026.3.8-beta.1", None, None),
        ("2026.3.8", Some("legacy"), Some(false)),
        ("2026.3.8-1", Some("legacy"), Some(false)),
        ("2026.4.24-beta.1", Some("legacy"), Some(false)),
        ("2026.4.24", Some("legacy"), Some(true)),
        ("2026.5.11", Some("legacy"), Some(true)),
        ("2026.5.12-beta.1", Some("legacy"), Some(true)),
        ("v2026.5.12", Some("modern"), Some(true)),
        ("2027.1.1", Some("modern"), Some(true)),
    ] {
        let caps = open_claw_capabilities(version);
        let actual = (
            caps.as_ref().map(|c| c.adapter.as_str()),
            caps.as_ref().map(|c| c.conversation_access),
        );
        if actual != (adapter, access) {
            mismatches.push(format!(
                "version={version} actual={actual:?} expected={:?}",
                (adapter, access)
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

use super::resolver_io_test_hooks::{count as io_count, scope as io_scope, Rule};

impl Fixture {
    async fn host_mode(
        &self,
        pairs: &[(&str, String)],
        cwd: &Path,
        mode: OpenClawResolveMode,
    ) -> Option<OpenClawHost> {
        resolve_openclaw_host(
            &self.env(pairs),
            cwd.to_str().unwrap(),
            None::<fn(String)>,
            mode,
        )
        .await
    }
}
#[tokio::test]
async fn source_l72_all_unidentified_parent_metadata_kinds_still_allow_only_the_fixed_child() {
    for kind in ["broken", "unreadable", "directory"] {
        let f = Fixture::new();
        let entry = f.pkg("app/openclaw", "2026.3.8", "openclaw");
        let metadata = f.root.join("app/package.json");
        if kind == "directory" {
            std::fs::create_dir(&metadata).unwrap();
        } else {
            std::fs::write(
                &metadata,
                if kind == "unreadable" {
                    json!({"name":"customer-container"}).to_string()
                } else {
                    "{".into()
                },
            )
            .unwrap();
        }
        let rules = if kind == "unreadable" {
            vec![Rule::read_error(metadata)]
        } else {
            vec![]
        };
        let host = io_scope(rules, f.host(&[("PATH", "".into())], &f.root.join("app")))
            .await
            .unwrap();
        assert_eq!(host.executable, Some(text(&entry)));
        assert_eq!(host.version, "2026.3.8");
        assert_eq!(host.binding.as_deref(), Some("auto-entry"));
    }
}
#[tokio::test]
async fn source_l91_real_parent_appearance_on_second_stat_revokes_recovered_child() {
    let f = Fixture::new();
    f.pkg("app/openclaw", "2026.3.8", "openclaw");
    std::fs::write(f.root.join("app/package.json"), "{").unwrap();
    let parent = f.root.join("app/openclaw.mjs");
    let (host, checks, problems) =
        io_scope(vec![Rule::appear_on_second_stat(parent.clone())], async {
            let mut problems = Vec::new();
            let host = resolve_openclaw_host(
                &f.env(&[]),
                f.root.join("app").to_str().unwrap(),
                Some(|message| problems.push(message)),
                OpenClawResolveMode::Runtime,
            )
            .await;
            (host, io_count("stat", &parent), problems)
        })
        .await;
    assert!(host.is_none());
    assert_eq!(checks, 2);
    assert!(problems
        .iter()
        .any(|m| m.contains("appeared or became inaccessible")));
    assert!(parent.is_file());
}
#[tokio::test]
async fn source_l127_all_three_child_stat_error_codes_are_reported_without_path_escape() {
    let mut mismatches = Vec::new();
    for code in ["EACCES", "EPERM", "ELOOP"] {
        let f = Fixture::new();
        f.pkg("app/openclaw", "2026.3.8", "openclaw");
        let other = f.pkg("cli", "2026.3.8", "openclaw");
        f.link(&other, &f.shell("cli"));
        let child = f.root.join("app/openclaw");
        let (host, calls, problems) =
            io_scope(vec![Rule::stat_error(child.clone(), code)], async {
                let mut problems = Vec::new();
                let host = resolve_openclaw_host(
                    &f.env(&[("PATH", text(&f.root.join("cli")))]),
                    f.root.join("app").to_str().unwrap(),
                    Some(|message| problems.push(message)),
                    OpenClawResolveMode::Runtime,
                )
                .await;
                (host, io_count("stat", &child), problems)
            })
            .await;
        assert!(host.is_none());
        assert_eq!(calls, 1);
        assert!(problems
            .iter()
            .any(|m| m.contains(&serde_json::to_string(&child).unwrap())));
        if !problems.iter().any(|m| m.contains(code)) {
            mismatches.push(format!("{code}: {problems:?}"));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
#[tokio::test]
async fn source_l230_standard_home_bundle_is_bound_with_empty_service_path() {
    let f = Fixture::new();
    let entry = f.pkg(
        "home/.openclaw-bundle/openclaw/node_modules/openclaw",
        "2026.3.8",
        "openclaw",
    );
    let host = f
        .host(
            &[("HOME", text(&f.root.join("home"))), ("PATH", "".into())],
            &f.root,
        )
        .await
        .unwrap();
    assert_eq!(host.executable, Some(text(&entry)));
    assert_eq!(host.binding.as_deref(), Some("auto-entry"));
    assert_eq!(host.version, "2026.3.8");
}
#[tokio::test]
async fn source_l235_only_installer_recovers_confirmed_missing_saved_entry_without_rewriting_config(
) {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8", "openclaw");
    let old = f.root.join("missing/openclaw.mjs");
    let config = f.root.join("config.json");
    let bytes = json!({"agents":{"openclaw":{"cliPath":old}}}).to_string();
    std::fs::write(&config, &bytes).unwrap();
    let pairs = [("AGENT_DATA_COLLECTION_CONFIG", text(&config))];
    let mut problems = Vec::new();
    let strict = resolve_openclaw_host(
        &f.env(&pairs),
        entry.parent().unwrap().to_str().unwrap(),
        Some(|message| problems.push(message)),
        OpenClawResolveMode::Runtime,
    )
    .await;
    assert!(strict.is_none());
    assert!(problems
        .iter()
        .any(|m| m.contains(&serde_json::to_string(&old).unwrap())));
    let recovered = f
        .host_mode(
            &pairs,
            entry.parent().unwrap(),
            OpenClawResolveMode::Installer,
        )
        .await
        .unwrap();
    assert_eq!(recovered.executable, Some(text(&entry)));
    assert_eq!(recovered.binding.as_deref(), Some("auto-entry"));
    assert_eq!(recovered.recovered_from, Some(text(&old)));
    assert_eq!(std::fs::read_to_string(&config).unwrap(), bytes);
    assert!(f
        .host_mode(
            &[
                ("AGENT_DATA_COLLECTION_CONFIG", text(&config)),
                ("OPENCLAW_CLI_PATH", text(&old))
            ],
            entry.parent().unwrap(),
            OpenClawResolveMode::Installer
        )
        .await
        .is_none());
}
#[tokio::test]
async fn source_l249_all_existing_old_entry_failures_block_installer_rebinding() {
    for kind in ["unsupported", "broken", "directory", "unreadable"] {
        let f = Fixture::new();
        let old = f.pkg(
            "old",
            if kind == "unsupported" {
                "2026.3.2"
            } else {
                "2026.3.8"
            },
            "openclaw",
        );
        let entry = f.pkg("app", "2026.3.8", "openclaw");
        let metadata = old.parent().unwrap().join("package.json");
        if kind == "broken" {
            std::fs::write(&metadata, "{").unwrap();
        }
        if kind == "directory" {
            std::fs::remove_file(&old).unwrap();
            std::fs::create_dir(&old).unwrap();
        }
        let config = f.root.join("config.json");
        std::fs::write(
            &config,
            json!({"agents":{"openclaw":{"cliPath":old}}}).to_string(),
        )
        .unwrap();
        let rules = if kind == "unreadable" {
            vec![Rule::read_error(metadata)]
        } else {
            vec![]
        };
        assert!(
            io_scope(
                rules,
                f.host_mode(
                    &[("AGENT_DATA_COLLECTION_CONFIG", text(&config))],
                    entry.parent().unwrap(),
                    OpenClawResolveMode::Installer
                )
            )
            .await
            .is_none(),
            "{kind}"
        );
    }
}
#[tokio::test]
async fn source_l261_missing_saved_entry_cannot_be_recovered_when_new_candidates_conflict() {
    let f = Fixture::new();
    f.pkg("app", "2026.3.8", "openclaw");
    f.pkg("app/openclaw", "2026.3.8", "openclaw");
    let config = f.root.join("config.json");
    std::fs::write(
        &config,
        json!({"agents":{"openclaw":{"cliPath":f.root.join("missing.mjs")}}}).to_string(),
    )
    .unwrap();
    assert!(f
        .host_mode(
            &[("AGENT_DATA_COLLECTION_CONFIG", text(&config))],
            &f.root.join("app"),
            OpenClawResolveMode::Installer
        )
        .await
        .is_none());
}
#[tokio::test]
async fn source_l267_only_confirmed_missing_implicit_bundle_entry_may_yield_to_valid_path() {
    for version in ["2026.3.2", "2026.3.8"] {
        let f = Fixture::new();
        let leftover = f.pkg(
            "home/.openclaw-bundle/openclaw/node_modules/openclaw",
            version,
            "openclaw",
        );
        std::fs::remove_file(leftover).unwrap();
        let entry = f.pkg("cli", "2026.6.10", "openclaw");
        let link = f.shell("cli");
        f.link(&entry, &link);
        let base = [
            ("HOME", text(&f.root.join("home"))),
            ("PATH", text(&f.root.join("cli"))),
        ];
        let host = f.host(&base, &f.root).await.unwrap();
        assert_eq!(host.executable, Some(text(&link)));
        assert_eq!(host.binding.as_deref(), Some("auto-entry"));
        let mut explicit = base.to_vec();
        explicit.push((
            "OPENCLAW_BUNDLE_ROOT",
            text(&f.root.join("home/.openclaw-bundle")),
        ));
        assert!(f.host(&explicit, &f.root).await.is_none());
        explicit.last_mut().unwrap().1 = "./bundle".into();
        assert!(f.host(&explicit, &f.root).await.is_none());
    }
}
#[tokio::test]
async fn source_l277_all_existing_implicit_bundle_metadata_failures_block_path_fallback() {
    for kind in ["unsupported", "broken", "unreadable", "missing-metadata"] {
        let f = Fixture::new();
        let bundle = f.pkg(
            "home/.openclaw-bundle/openclaw/node_modules/openclaw",
            if kind == "unsupported" {
                "2026.3.2"
            } else {
                "2026.3.8"
            },
            "openclaw",
        );
        let metadata = bundle.parent().unwrap().join("package.json");
        if kind == "broken" {
            std::fs::write(&metadata, "{").unwrap();
        }
        if kind == "missing-metadata" {
            std::fs::remove_file(&metadata).unwrap();
        }
        let entry = f.pkg("cli", "2026.6.10", "openclaw");
        f.link(&entry, &f.shell("cli"));
        let rules = if kind == "unreadable" {
            vec![Rule::read_error(metadata)]
        } else {
            vec![]
        };
        assert!(
            io_scope(
                rules,
                f.host(
                    &[
                        ("HOME", text(&f.root.join("home"))),
                        ("PATH", text(&f.root.join("cli")))
                    ],
                    &f.root
                )
            )
            .await
            .is_none(),
            "{kind}"
        );
    }
}
#[tokio::test]
async fn source_l289_bundle_and_path_symlinks_to_same_package_are_deduplicated() {
    let f = Fixture::new();
    let entry = f.pkg(
        "home/.openclaw-bundle/openclaw/node_modules/openclaw",
        "2026.3.8",
        "openclaw",
    );
    f.link(&entry, &f.shell("bin"));
    let host = f
        .host(
            &[
                ("HOME", text(&f.root.join("home"))),
                ("PATH", text(&f.root.join("bin"))),
            ],
            &f.root,
        )
        .await;
    assert!(is_openclaw_host_bound(host.as_ref()));
}
#[tokio::test]
async fn source_l295_distinct_bundle_and_path_packages_are_rejected_even_at_same_version() {
    for version in ["2026.3.8", "2026.6.10"] {
        let f = Fixture::new();
        f.pkg(
            "home/.openclaw-bundle/openclaw/node_modules/openclaw",
            version,
            "openclaw",
        );
        let entry = f.pkg("cli", version, "openclaw");
        f.link(&entry, &f.shell("cli"));
        assert!(f
            .host(
                &[
                    ("HOME", text(&f.root.join("home"))),
                    ("PATH", text(&f.root.join("cli")))
                ],
                &f.root
            )
            .await
            .is_none());
    }
}
#[tokio::test]
async fn source_l328_saved_bom_custom_config_rechecks_upgrades_downgrades_and_explicit_binding() {
    let f = Fixture::new();
    let entry = f.pkg("app", "2026.3.8", "openclaw");
    let config = f.root.join("custom config.json");
    std::fs::write(
        &config,
        format!(
            "\u{feff}{}",
            json!({"agents":{"openclaw":{"cliPath":entry}}})
        ),
    )
    .unwrap();
    let pairs = [("AGENT_DATA_COLLECTION_CONFIG", text(&config))];
    let host = f.host(&pairs, &f.root).await.unwrap();
    assert_eq!(host.binding.as_deref(), Some("persisted-entry"));
    assert!(!host.conversation_access);
    f.pkg("app", "2026.6.10", "openclaw");
    assert!(f.host(&pairs, &f.root).await.unwrap().conversation_access);
    f.pkg("app", "2026.3.8", "openclaw");
    assert!(!f.host(&pairs, &f.root).await.unwrap().conversation_access);
    std::fs::write(&config, "{broken").unwrap();
    assert!(f.host(&pairs, entry.parent().unwrap()).await.is_none());
    let explicit = f
        .host(
            &[
                ("AGENT_DATA_COLLECTION_CONFIG", text(&config)),
                ("OPENCLAW_CLI_PATH", text(&entry)),
            ],
            &f.root,
        )
        .await
        .unwrap();
    assert_eq!(explicit.binding.as_deref(), Some("explicit-entry"));
}
