use super::*;
use loongsuite_pilot::deployment::{AgentDefLoader, AgentDefLoaderOptions, HookStrategy};
use loongsuite_pilot::hooks::HookManager;
use loongsuite_pilot::types::HookFormat;
use std::collections::{BTreeMap, HashMap};

fn hook_resources() -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("agents.d")).unwrap() {
        let entry = entry.unwrap();
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let source = fs::read_to_string(entry.path()).unwrap();
        let value: Value = serde_json::from_str(&source).unwrap();
        if value["deployMode"] == "hook" {
            result.insert(value["id"].as_str().unwrap().to_owned(), source);
        }
    }
    result
}
#[tokio::test]
async fn cleanup_l173_l176_exact_ef_hook_manifest_settings_are_still_covered_by_native_definitions()
{
    let index: Value = serde_json::from_str(include_str!(
        "../fixtures/history/installer-hook-settings-ef.json"
    ))
    .unwrap();
    let actual = hook_resources();
    let mut paths = Vec::new();
    for source in actual.values() {
        let value: Value = serde_json::from_str(source).unwrap();
        let settings = value["hook"]["settingsPath"].as_str().unwrap();
        if !settings.contains('$') {
            paths.push(PathBuf::from(
                settings.strip_prefix("~/").unwrap_or(settings),
            ));
        }
    }
    for value in index["baseline"]["resources"].as_array().unwrap() {
        let id = value["id"].as_str().unwrap();
        assert!(
            actual.contains_key(id),
            "{id}: historical hook agent disappeared"
        );
    }
    // The Codex declaration resolves its environment override at load time.
    // Check that the default still targets the historical uninstall path.
    let fixture = Fixture::new();
    let codex = definition(&fixture, "codex", &actual).await;
    let codex_settings = &codex.hook.as_ref().unwrap().settings_path;
    paths.push(
        Path::new(codex_settings)
            .strip_prefix(fixture.root.path())
            .unwrap()
            .to_owned(),
    );
    for value in index["baseline"]["legacyGenericSettings"]
        .as_array()
        .unwrap()
    {
        assert!(
            paths.contains(&PathBuf::from(value.as_str().unwrap())),
            "{value}: historical setting target disappeared"
        );
    }
}
async fn definition(
    f: &Fixture,
    id: &str,
    sources: &BTreeMap<String, String>,
) -> loongsuite_pilot::types::AgentDefinition {
    let mut extra = vec![(format!("agents.d/{id}.json"), sources[id].clone())];
    if id == "cursor-cli" {
        extra.push(("agents.d/cursor.json".into(), sources["cursor"].clone()));
    }
    let borrowed = extra
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect::<Vec<_>>();
    let thin = Path::new(env!("CARGO_BIN_EXE_loongsuite-pilot-sdk-hook"));
    fs::copy(
        thin,
        f.candidate.join("bin").join(thin.file_name().unwrap()),
    )
    .unwrap();
    f.package_with(&borrowed);
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: f.candidate.join("agents.d").to_string_lossy().into_owned(),
        local_dir: f.data.join("agents.d.local").to_string_lossy().into_owned(),
        pilot_dir: f.candidate.to_string_lossy().into_owned(),
        data_dir: f.data.to_string_lossy().into_owned(),
    })
    .with_env(HashMap::from([
        ("HOME".into(), f.root.path().to_string_lossy().into_owned()),
        (
            "USERPROFILE".into(),
            f.root.path().to_string_lossy().into_owned(),
        ),
    ]));
    loader
        .load()
        .await
        .into_iter()
        .find(|def| def.id == id)
        .unwrap()
}
#[tokio::test]
async fn cleanup_l173_l176_l183_real_native_uninstall_cleans_every_shipped_hook_and_preserves_user_content(
) {
    let sources = hook_resources();
    for id in sources.keys() {
        for with_user in [false, true] {
            let f = Fixture::new();
            let def = definition(&f, id, &sources).await;
            let hook = def.hook.as_ref().unwrap();
            assert!(
                !hook.events.is_empty(),
                "{id}: actual loader did not resolve hooks"
            );
            let path = PathBuf::from(&hook.settings_path);
            assert!(
                path.is_absolute() && path.starts_with(f.root.path()),
                "{id}: escaped fixture home"
            );
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let user = json!({"command":"keep-third-party-hook","type":"command","timeout":17,"metadata":{"keep":true}});
            let dedicated = hook.kiro_agent.is_some();
            if dedicated && with_user {
                continue;
            }
            if !dedicated {
                let mut original = json!({"private":"keep", "hooks":{}});
                if with_user {
                    let event = &hook.events[0];
                    original["hooks"][event] = if hook.format == HookFormat::Nested {
                        json!([{"matcher":"unrelated-user-scope","hooks":[user.clone()]}])
                    } else {
                        json!([user.clone()])
                    };
                }
                fs::write(&path, original.to_string()).unwrap();
            }
            let script = PathBuf::from(&hook.hook_command);
            assert!(
                script.is_absolute() && script.starts_with(&f.data),
                "{id}: unexpected hook command path"
            );
            fs::create_dir_all(script.parent().unwrap()).unwrap();
            fs::write(&script, "fixture-owned-script-bytes\n").unwrap();
            let (installed, binary) = if hook.native_sdk_data.is_some() || id == "codex" {
                let stage = f.helper("stage-package", &f.runtime_options(&f.candidate), true);
                assert!(
                    stage.status.success(),
                    "{id} staging {}: {}",
                    stage.status,
                    String::from_utf8_lossy(&stage.stderr)
                );
                let name = String::from_utf8(stage.stdout).unwrap();
                let installed = f.root.path().join("cache/versions").join(name.trim());
                let binary = installed.join("bin").join(f.binary.file_name().unwrap());
                let mut command = f.command(&binary);
                command
                    .args(["hook", "install", "--agents", id, "--json"])
                    .env("LOONGSUITE_PILOT_RESOURCE_ROOT", &installed)
                    .env("AGENT_DATA_COLLECTION_CONFIG", f.data.join("config.json"));
                let output = bounded(command);
                assert!(
                    output.status.success(),
                    "{id} install {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                );
                let report: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(report["agents"][0]["status"], "ok", "{id}: {report}");
                let registered = fs::read_to_string(&path).unwrap();
                assert!(registered.contains("loongsuite-pilot-sdk-hook"), "{id}");
                assert!(
                    registered.contains(name.trim()),
                    "{id}: Hook must point to the staged version"
                );
                (installed, binary)
            } else {
                let strategy = HookStrategy::new(HookManager::new(
                    Some(f.data.join("hooks").to_string_lossy().into_owned()),
                    Some(f.data.join("logs").to_string_lossy().into_owned()),
                ));
                let deployed =
                    tokio::time::timeout(Duration::from_secs(5), strategy.deploy_hooks(&def))
                        .await
                        .unwrap();
                assert!(deployed.success, "{id}: {:?}", deployed.error);
                (f.candidate.clone(), f.binary.clone())
            };
            let mut cleanup = f.command(&binary);
            cleanup
                .args(["installer-helper", "cleanup-agents", "--input-env"])
                .env(
                    "LOONGSUITE_PILOT_INSTALL_INPUT",
                    json!({"dataDir":f.data,"pilotDir":installed}).to_string(),
                );
            let output = bounded(cleanup);
            success(&output);
            assert_eq!(
                fs::read_to_string(&script).unwrap(),
                "fixture-owned-script-bytes\n",
                "{id}: shared runtime prematurely removed"
            );
            if dedicated {
                if path.exists() {
                    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    assert!(
                        value.get("hooks").is_none(),
                        "{id}: owned dedicated hooks survived"
                    );
                }
            } else {
                let cleaned = loongsuite_pilot::utils::parse_json_document(
                    &fs::read_to_string(&path).unwrap(),
                    loongsuite_pilot::utils::JsonSyntax::Jsonc,
                )
                .unwrap();
                assert_eq!(cleaned["private"], "keep", "{id}");
                if with_user {
                    let kept = if hook.format == HookFormat::Nested {
                        json!({&hook.events[0]:[{"matcher":"unrelated-user-scope","hooks":[user]}]})
                    } else {
                        json!({&hook.events[0]:[user]})
                    };
                    assert_eq!(cleaned["hooks"], kept, "{id}: user hooks changed");
                } else {
                    assert!(
                        cleaned.get("hooks").is_none(),
                        "{id}: empty hook object remains: {cleaned}"
                    );
                }
            }
        }
    }
}
