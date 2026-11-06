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
#[test]
fn cleanup_l173_l176_exact_ef_hook_manifest_settings_are_still_covered_by_native_definitions() {
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
            paths.push(settings.strip_prefix("~/").unwrap_or(settings).to_owned());
        }
    }
    for value in index["baseline"]["resources"].as_array().unwrap() {
        let id = value["id"].as_str().unwrap();
        assert!(
            actual.contains_key(id),
            "{id}: historical hook agent disappeared"
        );
    }
    for value in index["baseline"]["legacyGenericSettings"]
        .as_array()
        .unwrap()
    {
        assert!(
            paths.iter().any(|path| path == value.as_str().unwrap()),
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
            let strategy = HookStrategy::new(HookManager::new(
                Some(f.data.join("hooks").to_string_lossy().into_owned()),
                Some(f.data.join("logs").to_string_lossy().into_owned()),
            ));
            let deployed =
                tokio::time::timeout(Duration::from_secs(5), strategy.deploy_hooks(&def))
                    .await
                    .unwrap();
            assert!(deployed.success, "{id}: {:?}", deployed.error);
            let output = f.helper(
                "cleanup-agents",
                &json!({"dataDir":f.data,"pilotDir":f.candidate}),
                true,
            );
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
