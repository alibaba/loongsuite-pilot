//! Fixed EF/f84/2b HookManager assertions not yet fully covered by the existing Native tests.
use super::*;
use serde_json::json;
use std::path::PathBuf;
const COLLECT: &str = "/opt/pilot/hooks/qoder-loongsuite-pilot-hook.sh";
const INTERCEPT: &str = "/opt/pilot/hooks/interceptor-hook.sh";
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
    fn manager(&self) -> HookManager {
        HookManager::new(
            Some(self.root.join("hooks").to_string_lossy().into_owned()),
            Some(self.root.join("logs").to_string_lossy().into_owned()),
        )
    }
    fn definition(
        &self,
        agent: &str,
        dir: &str,
        file: &str,
        event: &str,
        command: &str,
    ) -> HookDefinition {
        let path = self.root.join(dir).join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        HookDefinition {
            agent_id: agent.into(),
            settings_path: path.to_string_lossy().into_owned(),
            settings_syntax: None,
            hook_json_path: vec!["hooks".into(), event.into()],
            hook_command: command.into(),
            matcher: Some("*".into()),
            exec_args: None,
            history_dir: None,
            replace_hook_commands: None,
            use_nested_format: Some(true),
            shell: None,
            timeout: None,
            insert: None,
        }
    }
}
fn read(def: &HookDefinition) -> String {
    std::fs::read_to_string(&def.settings_path).unwrap()
}
fn parsed(def: &HookDefinition) -> Value {
    parse_json_document(
        &read(def),
        if def.settings_syntax == Some(SettingsSyntax::Jsonc) {
            JsonSyntax::Jsonc
        } else {
            JsonSyntax::Json
        },
    )
    .unwrap()
}
#[tokio::test]
async fn source_l278_blank_jsonc_both_original_parameters_keep_exact_backup_and_guarded_write() {
    for original in ["", "  \n"] {
        let f = Fixture::new();
        let mut def = f.definition(
            "qwen-code-cli",
            ".qwen",
            "settings.json",
            "Stop",
            "/opt/qwen-loongsuite-pilot-hook.sh stop",
        );
        def.settings_syntax = Some(SettingsSyntax::Jsonc);
        std::fs::write(&def.settings_path, original).unwrap();
        assert!(f.manager().install_hook(&def).await);
        assert_eq!(
            parsed(&def)["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/opt/qwen-loongsuite-pilot-hook.sh stop"
        );
        assert_eq!(
            std::fs::read_to_string(format!("{}.loongsuite-pilot.bak", def.settings_path)).unwrap(),
            original
        );
    }
}
#[tokio::test]
async fn source_l313_jsonc_uninstall_preserves_both_original_user_comments_and_other_command() {
    let f = Fixture::new();
    let mut def = f.definition(
        "qwen-code-cli",
        ".qwen",
        "settings.json",
        "Stop",
        "/opt/qwen-loongsuite-pilot-hook.sh stop",
    );
    def.settings_syntax = Some(SettingsSyntax::Jsonc);
    let original = r#"{
  // Keep the model comment.
  "model": "qwen-max",
  "hooks": {
    "Stop": [
      // Keep this third-party hook comment.
      {
        "matcher": "*",
        "hooks": [{ "command": "/opt/other-hook.sh", "type": "command" }]
      },
      {
        "matcher": "*",
        "hooks": [{ "command": "/opt/qwen-loongsuite-pilot-hook.sh stop", "type": "command" }]
      }
    ]
  }
}
"#;
    std::fs::write(&def.settings_path, original).unwrap();
    assert!(f.manager().uninstall_hook(&def).await);
    let updated = read(&def);
    for keep in [
        "// Keep the model comment.",
        "// Keep this third-party hook comment.",
        "/opt/other-hook.sh",
    ] {
        assert!(updated.contains(keep));
    }
    assert!(!updated.contains(&def.hook_command));
}
#[tokio::test]
async fn source_l358_l387_actual_invalid_jsonc_and_strict_cursor_documents_are_unchanged_and_unbacked(
) {
    for (agent, dir, file, syntax, event, command, invalid) in [
        (
            "qwen-code-cli",
            ".qwen",
            "settings.json",
            Some(SettingsSyntax::Jsonc),
            "Stop",
            "/opt/qwen-loongsuite-pilot-hook.sh stop",
            "{\n  // The file exists but is incomplete.\n  \"model\": \"qwen-max\",\n",
        ),
        (
            "cursor",
            ".cursor",
            "hooks.json",
            None,
            "stop",
            "/opt/cursor-loongsuite-pilot-hook.sh",
            "{ \"version\": 1, \"hooks\": ",
        ),
    ] {
        let f = Fixture::new();
        let mut def = f.definition(agent, dir, file, event, command);
        def.settings_syntax = syntax;
        def.matcher = None;
        if agent == "cursor" {
            def.matcher = None;
            def.use_nested_format = None;
        }
        std::fs::write(&def.settings_path, invalid).unwrap();
        assert!(!f.manager().install_hook(&def).await);
        assert_eq!(read(&def), invalid);
        if syntax.is_some() {
            assert!(
                !std::path::Path::new(&format!("{}.loongsuite-pilot.bak", def.settings_path))
                    .exists()
            );
        }
    }
}
#[tokio::test]
async fn source_l426_l442_l477_shell_dimension_is_checked_and_repaired_once_only_when_declared() {
    const CMD: &str = r#"powershell -NoProfile -ExecutionPolicy Bypass -File "C:\qoder-loongsuite-pilot-hook.ps1" qoder"#;
    let f = Fixture::new();
    let mut def = f.definition("qoder", ".qoder", "settings.json", "Stop", CMD);
    let stale =
        json!({"hooks":{"Stop":[{"matcher":"*","hooks":[{"command":CMD,"type":"command"}]}]}});
    std::fs::write(&def.settings_path, stale.to_string()).unwrap();
    def.shell = Some("powershell".into());
    assert!(!f.manager().is_hook_installed(&def).await);
    assert!(f.manager().install_hook(&def).await);
    assert_eq!(
        parsed(&def)["hooks"]["Stop"],
        json!([{"matcher":"*","hooks":[{"command":CMD,"type":"command","shell":"powershell"}]}])
    );
    assert!(f.manager().is_hook_installed(&def).await);
    std::fs::write(&def.settings_path, stale.to_string()).unwrap();
    def.shell = None;
    assert!(f.manager().is_hook_installed(&def).await);
}
#[tokio::test]
async fn source_l497_l532_l574_l622_interceptor_insert_repair_jsonc_and_selective_uninstall_keep_exact_fields(
) {
    for (scenario, event, timeout, syntax) in [
        ("fresh", "UserPromptSubmit", 15_u64, None),
        ("repair", "PreToolUse", 10, None),
        ("jsonc", "PreToolUse", 10, Some(SettingsSyntax::Jsonc)),
    ] {
        let f = Fixture::new();
        let mut def = f.definition("qoder", ".qoder", "settings.json", event, INTERCEPT);
        def.settings_syntax = syntax;
        def.timeout = Some(timeout as f64);
        def.insert = Some(HookInsert::Head);
        let mut groups =
            vec![json!({"matcher":"*","hooks":[{"command":COLLECT,"type":"command"}]})];
        if scenario != "fresh" {
            groups.push(
                json!({"matcher":"*","hooks":[{"command":INTERCEPT,"type":"command","timeout":3}]}),
            );
        }
        let initial = json!({"hooks":{(event):groups}});
        let original = if syntax.is_some() {
            format!(
                "{{\n  // Keep this comment.\n  \"hooks\": {}\n}}\n",
                initial["hooks"]
            )
        } else {
            initial.to_string()
        };
        std::fs::write(&def.settings_path, &original).unwrap();
        if scenario == "repair" {
            assert!(!f.manager().is_hook_installed(&def).await);
        }
        assert!(f.manager().install_hook(&def).await);
        let updated = read(&def);
        if syntax.is_some() {
            assert!(updated.contains("// Keep this comment."));
        }
        let value = parsed(&def);
        assert_eq!(
            value["hooks"][event][0]["hooks"][0],
            json!({"command":INTERCEPT,"type":"command","timeout":timeout})
        );
        assert_eq!(value["hooks"][event][1]["hooks"][0]["command"], COLLECT);
        if scenario == "repair" {
            assert!(f.manager().is_hook_installed(&def).await);
        }
        if scenario == "fresh" {
            def.timeout = None;
            def.insert = None;
            assert!(f.manager().uninstall_hook(&def).await);
            assert_eq!(
                parsed(&def)["hooks"]["UserPromptSubmit"],
                json!([{"matcher":"*","hooks":[{"command":COLLECT,"type":"command"}]}])
            );
        }
    }
}
