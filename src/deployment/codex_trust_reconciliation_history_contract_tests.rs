use super::super::codex_trust_writer::{
    compute_installed_hook_trust_hash, installed_hook_state_key, TrustPlatform,
};
use super::*;
use serde_json::json;
struct World {
    _temp: tempfile::TempDir,
    def: AgentDefinition,
    strategy: HookStrategy,
    hooks: PathBuf,
    trust: PathBuf,
    current_key: String,
    retired_key: String,
    current_hash: String,
    third_party: String,
}
impl World {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let hooks = root.join(".codex/hooks.json");
        let trust = root.join(".codex/config.toml");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        let def:AgentDefinition=serde_json::from_value(json!({"id":"codex","displayName":"Codex","deployMode":"hook",
            "detection":{"paths":[hooks.parent().unwrap()],"commands":[]},
            "hook":{"settingsPath":hooks,"events":["Stop"],"retiredEvents":["PreToolUse"],"hookCommand":"/opt/hook.sh",
                "format":"nested","matcher":"*","eventSubcommand":"kebab-case","trustToml":{"configPath":trust,"trustAlgo":"v1","marker":"otel-codex-hook"}}})).unwrap();
        std::fs::write(&hooks,json!({"hooks":{
            "Stop":[{"matcher":"*","hooks":[{"type":"command","command":"/opt/hook.sh stop"}]}],
            "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/opt/hook.sh pre-tool-use"}]}]}}).to_string()).unwrap();
        let strategy = HookStrategy::new(HookManager::new(
            Some(root.join("pilot-hooks").to_string_lossy().into_owned()),
            Some(root.join("logs").to_string_lossy().into_owned()),
        ));
        let locations = strategy
            .resolve_installed_codex_hooks(&def, &["Stop".into(), "PreToolUse".into()], false)
            .await
            .unwrap();
        let current = &locations["Stop"];
        let retired = &locations["PreToolUse"];
        let current_key = installed_hook_state_key(hooks.to_str().unwrap(), current);
        let retired_key = installed_hook_state_key(hooks.to_str().unwrap(), retired);
        let current_hash =
            compute_installed_hook_trust_hash(current, TrustPlatform::current()).unwrap();
        let retired_hash =
            compute_installed_hook_trust_hash(retired, TrustPlatform::current()).unwrap();
        let q = |s: &str| toml::Value::String(s.into()).to_string();
        let third_party="[\"hooks\".\"state\".\"third-party:stop:0:0\"]\nenabled = true\ntrusted_hash = \"sha256:OTHER\"\n".to_owned();
        let contents=format!("[hooks.state.{}]\ntrusted_hash = {}\n\n[\"hooks\".\"state\".{}]\ntrusted_hash = {}\n\n[hooks.state.{}]\ntrusted_hash = {}\n\n[\"hooks\".\"state\".{}]\nenabled = false\ntrusted_hash = {}\n\n{}",q(&retired_key),q(&retired_hash),q(&retired_key),q(&retired_hash),q(&current_key),q(&current_hash),q(&current_key),q(&current_hash),third_party);
        std::fs::write(&trust, contents).unwrap();
        Self {
            _temp: temp,
            def,
            strategy,
            hooks,
            trust,
            current_key,
            retired_key,
            current_hash,
            third_party,
        }
    }
    fn assert_reconciled(&self) {
        let raw = std::fs::read_to_string(&self.trust).unwrap();
        let parsed: toml::Value = toml::from_str(&raw).unwrap();
        let state = parsed["hooks"]["state"].as_table().unwrap();
        assert!(state.get(&self.retired_key).is_none());
        let current = state[&self.current_key].as_table().unwrap();
        assert_eq!(current.len(), 2);
        assert_eq!(current["enabled"].as_bool(), Some(false));
        assert_eq!(
            current["trusted_hash"].as_str(),
            Some(self.current_hash.as_str())
        );
        assert!(raw.contains(&self.third_party));
        let hooks: Value = serde_json::from_slice(&std::fs::read(&self.hooks).unwrap()).unwrap();
        assert!(hooks["hooks"].get("PreToolUse").is_none());
    }
}
#[tokio::test]
async fn trust_l95_duplicate_current_and_retired_sections_reconcile_before_retirement_and_retries_do_not_rewrite(
) {
    let f = World::new().await;
    let deployed = f.strategy.deploy(&f.def).await;
    assert!(deployed.success, "{deployed:?}");
    f.assert_reconciled();
    let bytes = std::fs::read(&f.trust).unwrap();
    let modified = std::fs::metadata(&f.trust).unwrap().modified().unwrap();
    assert!(f.strategy.deploy(&f.def).await.success);
    assert_eq!(std::fs::read(&f.trust).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&f.trust).unwrap().modified().unwrap(),
        modified
    );
}
#[tokio::test]
async fn trust_l119_native_atomic_failure_preserves_all_original_bytes_then_repaired_retry_is_idempotent(
) {
    let f = World::new().await;
    let hooks = std::fs::read(&f.hooks).unwrap();
    let trust = std::fs::read(&f.trust).unwrap();
    let mode = std::fs::metadata(&f.hooks).unwrap().permissions();
    let mut readonly = mode.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&f.hooks, readonly).unwrap();
    let failed = f.strategy.deploy(&f.def).await;
    assert!(!failed.success);
    assert!(failed.error.as_deref().is_some_and(|s| !s.is_empty()));
    assert_eq!(std::fs::read(&f.hooks).unwrap(), hooks);
    assert_eq!(std::fs::read(&f.trust).unwrap(), trust);
    std::fs::set_permissions(&f.hooks, mode).unwrap();
    assert!(f.strategy.deploy(&f.def).await.success);
    f.assert_reconciled();
    let bytes = std::fs::read(&f.trust).unwrap();
    let before = std::fs::metadata(&f.trust).unwrap().modified().unwrap();
    assert!(f.strategy.deploy(&f.def).await.success);
    assert_eq!(std::fs::read(&f.trust).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&f.trust).unwrap().modified().unwrap(),
        before
    );
}

#[tokio::test]
async fn duplicate_repair_preflight_never_accepts_invalid_foreign_or_unbound_trust_sections() {
    for suffix in [
        "[foreign]\nvalue=1\n[foreign]\nvalue=2\n",
        "[hooks.state.\"another-install:stop:0:0\"]\ntrusted_hash=\"sha256:x\"\n[\"hooks\".\"state\".\"another-install:stop:0:0\"]\ntrusted_hash=\"sha256:x\"\n",
        "[broken\ninvalid = true\n",
    ] {
        let f=World::new().await;let mut raw=std::fs::read_to_string(&f.trust).unwrap();raw.push_str(suffix);
        std::fs::write(&f.trust,&raw).unwrap();let hooks=std::fs::read(&f.hooks).unwrap();
        let result=f.strategy.deploy(&f.def).await;assert!(!result.success);
        assert_eq!(std::fs::read_to_string(&f.trust).unwrap(),raw);assert_eq!(std::fs::read(&f.hooks).unwrap(),hooks);
    }
    let f = World::new().await;
    let raw = std::fs::read_to_string(&f.trust).unwrap().replacen(
        "trusted_hash =",
        "trusted_hash = [broken\nx =",
        1,
    );
    std::fs::write(&f.trust, &raw).unwrap();
    let hooks = std::fs::read(&f.hooks).unwrap();
    assert!(!f.strategy.deploy(&f.def).await.success);
    assert_eq!(std::fs::read_to_string(&f.trust).unwrap(), raw);
    assert_eq!(std::fs::read(&f.hooks).unwrap(), hooks);
}
