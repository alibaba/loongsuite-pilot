use super::*;
use serde_json::json;
struct World {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    orchestrator: Arc<Orchestrator>,
    manager: Arc<DeploymentManager>,
}
impl World {
    async fn new(disabled: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data");
        let defs = root.join("agents.d");
        std::fs::create_dir_all(&defs).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        for id in ["cursor", "claude-code"] {
            let mut def: AgentDefinition = serde_json::from_str(if id == "cursor" {
                include_str!("../../agents.d/cursor.json")
            } else {
                include_str!("../../agents.d/claude-code.json")
            })
            .unwrap();
            let home = root.join(id);
            std::fs::create_dir_all(&home).unwrap();
            def.detection.paths = vec![home.to_string_lossy().into_owned()];
            def.detection.commands.clear();
            def.hook.as_mut().unwrap().settings_path =
                home.join("hooks.json").to_string_lossy().into_owned();
            std::fs::write(
                defs.join(format!("{id}.json")),
                serde_json::to_vec(&def).unwrap(),
            )
            .unwrap();
        }
        let manager = Arc::new(DeploymentManager::new(DeploymentManagerOptions {
            data_dir: data.to_string_lossy().into_owned(),
            pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
            builtin_agents_dir: Some(defs.to_string_lossy().into_owned()),
            installed_by: None,
        }));
        manager.load_definitions().await;
        let file = json!({"dataDir":data,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false},
            "agents":{"cursor":{"enabled":!disabled}}});
        let env = HashMap::new();
        let config = super::super::config_loader::assemble_config(
            Some(&file),
            None,
            &super::super::config_loader::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "history",
                config_path: "history.json",
                global_poll_ms: None,
            },
        )
        .unwrap();
        let orchestrator = Arc::new(Orchestrator::new(config));
        *orchestrator.deployment.lock().unwrap() = Some(manager.clone());
        Self {
            _temp: temp,
            root,
            orchestrator,
            manager,
        }
    }
    fn entries(&self) -> Vec<Arc<dyn AgentDetection>> {
        self.orchestrator.deploy_detection_entries(&self.manager)
    }
    fn cursor(&self) -> Arc<dyn AgentDetection> {
        self.entries()
            .into_iter()
            .find(|e| e.id() == "deploy:cursor")
            .unwrap()
    }
    fn recorded(&self) {
        let mut bits = self.orchestrator.bits.lock().unwrap();
        bits.scope = DeploymentScopeMode::Recorded;
        bits.recorded.insert("cursor".into());
    }
    fn settings(&self) -> std::path::PathBuf {
        self.root.join("cursor/hooks.json")
    }
}
#[tokio::test]
async fn dynamic_l63_l78_real_builder_preserves_ids_type_watch_paths_and_five_minute_poll() {
    let f = World::new(false).await;
    let entries = f.entries();
    assert_eq!(entries.len(), 2);
    let ids: HashSet<_> = entries.iter().map(|e| e.id()).collect();
    assert_eq!(ids, HashSet::from(["deploy:cursor", "deploy:claude-code"]));
    for entry in entries {
        assert_eq!(entry.type_name(), "deploy-detection");
        assert_eq!(entry.poll_interval_ms(), 300_000);
        assert_eq!(entry.watch_paths().len(), 1);
    }
}
#[tokio::test]
async fn dynamic_l84_l92_default_available_delegates_to_real_manager_and_start_installs_the_exact_definition(
) {
    let f = World::new(false).await;
    let cursor = f.cursor();
    let before = f.manager.test_detection_calls();
    assert!(cursor.is_available().await);
    assert_eq!(f.manager.test_detection_calls(), before + 1);
    assert!(!f.settings().exists());
    cursor.start().await.unwrap();
    assert!(f.settings().is_file());
    assert!(f.manager.has_record("cursor"));
    assert!(!f.root.join("claude-code/hooks.json").exists());
    cursor.stop().await.unwrap();
}
#[tokio::test]
async fn dynamic_l102_default_enabled_and_actual_original_config_scope_and_control_gates_are_retained(
) {
    let f = World::new(false).await;
    let cursor = f.cursor();
    assert!(cursor.enabled());
    f.orchestrator
        .bits
        .lock()
        .unwrap()
        .modes
        .insert("cursor".into(), crate::types::AgentControlMode::Off);
    assert!(!cursor.enabled());
    f.orchestrator.bits.lock().unwrap().modes.clear();
    assert!(cursor.enabled());
    f.recorded();
    assert!(cursor.enabled());
    f.orchestrator.bits.lock().unwrap().recorded.clear();
    assert!(!cursor.enabled());
    let disabled = World::new(true).await;
    assert!(!disabled.cursor().enabled());
}
#[tokio::test]
async fn dynamic_recorded_scope_availability_never_invokes_detection_even_for_a_recorded_enabled_agent(
) {
    let f = World::new(false).await;
    let cursor = f.cursor();
    assert!(cursor.is_available().await);
    f.recorded();
    assert!(cursor.enabled());
    let before = f.manager.test_detection_calls();
    assert!(
        !cursor.is_available().await,
        "recorded scope must not run automatic deployment discovery"
    );
    assert_eq!(f.manager.test_detection_calls(), before);
    assert!(!f.settings().exists());
}
#[tokio::test]
async fn dynamic_recorded_scope_start_never_writes_even_when_an_already_built_callback_is_invoked()
{
    let f = World::new(false).await;
    let cursor = f.cursor();
    assert!(!f.settings().exists());
    f.recorded();
    assert!(cursor.enabled());
    cursor.start().await.unwrap();
    assert!(
        !f.settings().exists(),
        "recorded scope callback must not deploy an unrecorded settings target"
    );
    assert!(!f.manager.has_record("cursor"));
    f.orchestrator.bits.lock().unwrap().scope = DeploymentScopeMode::Auto;
    cursor.start().await.unwrap();
    assert!(f.settings().exists());
}

#[tokio::test]
async fn dynamic_l72_l108_l121_loader_and_real_builder_expand_tilde_keep_order_and_skip_empty_watch_paths(
) {
    let f = World::new(false).await;
    let defs = f.root.join("agents.d");
    let mut multi: AgentDefinition =
        serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
    multi.id = "multi-path".into();
    multi.display_name = "Multi".into();
    let absolute = f.root.join("opt-agent").to_string_lossy().into_owned();
    multi.detection.paths = vec!["~/.agent".into(), absolute.clone(), "~/.agent-alt".into()];
    multi.detection.commands.clear();
    multi.hook.as_mut().unwrap().settings_path = f
        .root
        .join("multi/hooks.json")
        .to_string_lossy()
        .into_owned();
    std::fs::write(
        defs.join("multi-path.json"),
        serde_json::to_vec(&multi).unwrap(),
    )
    .unwrap();
    let mut empty = multi;
    empty.id = "no-paths".into();
    empty.detection.paths.clear();
    empty.detection.commands = vec!["some-cmd".into()];
    std::fs::write(
        defs.join("no-paths.json"),
        serde_json::to_vec(&empty).unwrap(),
    )
    .unwrap();
    f.manager.load_definitions().await;
    let entries = f.entries();
    assert_eq!(entries.len(), 3);
    assert!(!entries.iter().any(|e| e.id() == "deploy:no-paths"));
    let multi = entries
        .iter()
        .find(|e| e.id() == "deploy:multi-path")
        .unwrap();
    assert_eq!(
        multi.watch_paths(),
        &[
            resolve_home("~/.agent"),
            absolute,
            resolve_home("~/.agent-alt")
        ]
    );
    assert_eq!(multi.poll_interval_ms(), 300_000);
}
