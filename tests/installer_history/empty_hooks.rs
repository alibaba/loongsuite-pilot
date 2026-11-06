use super::*;
use loongsuite_pilot::deployment::{AgentDefLoader, AgentDefLoaderOptions, HookStrategy};
use loongsuite_pilot::hooks::HookManager;
use loongsuite_pilot::types::AgentDefinition;
use std::collections::HashMap;

async fn produced(
    id: &str,
    source: &str,
    user: bool,
) -> (Fixture, AgentDefinition, PathBuf, PathBuf) {
    let f = Fixture::new();
    let file = format!("agents.d/{id}.json");
    f.package_with(&[(&file, source)]);
    let def = AgentDefLoader::new(AgentDefLoaderOptions {
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
    ]))
    .load()
    .await
    .into_iter()
    .find(|def| def.id == id)
    .unwrap();
    let hook = def.hook.as_ref().unwrap();
    let path = PathBuf::from(&hook.settings_path);
    let script = PathBuf::from(&hook.hook_command);
    assert!(path.is_absolute() && path.starts_with(f.root.path()));
    assert!(script.is_absolute() && script.starts_with(&f.data));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(&script, "immutable-owned-hook\n").unwrap();
    let mut initial = json!({"private":"keep", "number":1.0,"hooks":{}});
    if user {
        initial["hooks"][&hook.events[0]] = json!([{
            "matcher":"third-party-scope","unknownGroup":"keep",
            "hooks":[{"type":"command","command":"keep-user-hook","timeout":17,"metadata":{"keep":true}}]
        }]);
    }
    let content = if id == "qwen-code-cli" {
        format!("// preserve the user's JSONC header\n{}\n", initial)
    } else {
        initial.to_string()
    };
    fs::write(&path, &content).unwrap();
    let strategy = HookStrategy::new(HookManager::new(
        Some(f.data.join("hooks").to_string_lossy().into_owned()),
        Some(f.data.join("logs").to_string_lossy().into_owned()),
    ));
    let result = tokio::time::timeout(Duration::from_secs(5), strategy.deploy_hooks(&def))
        .await
        .unwrap();
    assert!(result.success, "{id}: {:?}", result.error);
    (f, def, path, script)
}
fn cleanup(f: &Fixture) -> Output {
    let mut command = f.command(&f.binary);
    command
        .args(["installer-helper", "cleanup-agents", "--input-env"])
        .env(
            "LOONGSUITE_PILOT_INSTALL_INPUT",
            json!({"dataDir":f.data,"pilotDir":f.candidate}).to_string(),
        );
    bounded_for(command, Duration::from_secs(5))
}
fn sources() -> [(&'static str, &'static str); 2] {
    [
        (
            "claude-code",
            include_str!("../../agents.d/claude-code.json"),
        ),
        (
            "qwen-code-cli",
            include_str!("../../agents.d/qwen-code-cli.json"),
        ),
    ]
}
#[tokio::test]
async fn cleanup_l183_actual_native_uninstall_removes_only_empty_owned_hook_containers_in_json_and_jsonc(
) {
    for (id, source) in sources() {
        let (f, _, path, script) = produced(id, source, false).await;
        success(&cleanup(&f));
        let raw = fs::read_to_string(&path).unwrap();
        let value = loongsuite_pilot::utils::parse_json_document(
            &raw,
            loongsuite_pilot::utils::JsonSyntax::Jsonc,
        )
        .unwrap();
        assert!(value.get("hooks").is_none(), "{id}: {raw}");
        assert_eq!(value["private"], "keep");
        assert_eq!(value["number"], json!(1.0));
        if id == "qwen-code-cli" {
            assert!(raw.contains("// preserve the user's JSONC header"));
        }
        assert_eq!(
            fs::read_to_string(&script).unwrap(),
            "immutable-owned-hook\n"
        );
        success(&cleanup(&f));
        assert_eq!(fs::read_to_string(path).unwrap(), raw);
    }
}
#[tokio::test]
async fn native_uninstall_keeps_third_party_groups_fields_and_jsonc_trivia_after_own_handlers_leave(
) {
    for (id, source) in sources() {
        let (f, def, path, _) = produced(id, source, true).await;
        success(&cleanup(&f));
        let raw = fs::read_to_string(&path).unwrap();
        let value = loongsuite_pilot::utils::parse_json_document(
            &raw,
            loongsuite_pilot::utils::JsonSyntax::Jsonc,
        )
        .unwrap();
        let event = &def.hook.as_ref().unwrap().events[0];
        assert_eq!(
            value["hooks"][event],
            json!([{
                "matcher":"third-party-scope","unknownGroup":"keep",
                "hooks":[{"type":"command","command":"keep-user-hook","timeout":17,"metadata":{"keep":true}}]
            }]),
            "{id}"
        );
        assert_eq!(value["hooks"].as_object().unwrap().len(), 1);
        if id == "qwen-code-cli" {
            assert!(raw.contains("// preserve the user's JSONC header"));
        }
    }
}
#[tokio::test]
async fn ordinary_hook_undeploy_and_unowned_empty_native_inputs_keep_their_previous_container_contracts(
) {
    for (id, source) in sources() {
        let (f, def, path, _) = produced(id, source, false).await;
        let strategy = HookStrategy::new(HookManager::new(
            Some(f.data.join("hooks").to_string_lossy().into_owned()),
            Some(f.data.join("logs").to_string_lossy().into_owned()),
        ));
        assert!(strategy.undeploy_hooks(&def).await);
        let raw = fs::read_to_string(&path).unwrap();
        let value = loongsuite_pilot::utils::parse_json_document(
            &raw,
            loongsuite_pilot::utils::JsonSyntax::Jsonc,
        )
        .unwrap();
        assert!(
            value.get("hooks").is_some(),
            "{id}: ordinary lifecycle contract changed"
        );
        let empty = if id == "qwen-code-cli" {
            "// user deliberately retained an empty section\n{\"private\":\"keep\",\"hooks\":{}}\n"
        } else {
            "{\"private\":\"keep\",\"hooks\":{}}\n"
        };
        fs::write(&path, empty).unwrap();
        success(&cleanup(&f));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            empty,
            "{id}: no-op modified user bytes"
        );
    }
}
