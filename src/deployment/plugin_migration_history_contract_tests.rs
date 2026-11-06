//! Frozen EF/f84/2b legacy plugin migration assertions; only synthetic homes.
use super::*;
use serde_json::json;
use std::path::{Path, PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        Self { _root: root, home }
    }
    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.home.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    fn cache(&self) -> PathBuf {
        self.home
            .join(".cache/opentelemetry.instrumentation.claude")
    }
    fn legacy_claude(&self) {
        std::fs::create_dir_all(self.cache()).unwrap();
    }
    async fn run(&self) -> PluginMigrationReport {
        run_plugin_migration_at(&self.home).await.unwrap()
    }
}
fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[tokio::test]
async fn source_l42_removes_only_legacy_claude_hooks_empty_events_and_legacy_cache() {
    let f = Fixture::new();
    f.legacy_claude();
    f.write(".claude/settings.json",serde_json::to_vec_pretty(&json!({"hooks":{
        "Stop":[
            {"matcher":"*","hooks":[{"type":"command","command":"bash /tmp/.cache/opentelemetry.instrumentation.claude/hook-entry.sh stop"}]},
            {"hooks":[{"command":"/Users/x/my-other-hook.sh","type":"command"}]}
        ],
        "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"bash /Users/x/.cache/opentelemetry.instrumentation.claude/hook-entry.sh pre-tool-use"}]}]
    }})).unwrap());
    let report = f.run().await;
    assert!(report.claude.migrated);
    let settings = read_json(f.home.join(".claude/settings.json"));
    assert!(settings["hooks"].get("PreToolUse").is_none());
    assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
    assert_eq!(
        settings["hooks"]["Stop"][0]["hooks"][0]["command"],
        "/Users/x/my-other-hook.sh"
    );
    assert!(!f.cache().exists());
}

#[tokio::test]
async fn source_l73_removes_marked_legacy_shell_blocks_preserving_user_exports() {
    let f = Fixture::new();
    f.legacy_claude();
    let raw="export PATH=/usr/local/bin:$PATH\n\n# BEGIN otel-claude-hook\nalias claude=\"OTEL_BLAH=1 claude\"\nexport NODE_OPTIONS=\"--require /tmp/intercept.js\"\n# END otel-claude-hook\n\nexport FOO=bar";
    for file in [".bashrc", ".zshrc", ".bash_profile"] {
        f.write(file, raw);
    }
    f.run().await;
    for file in [".bashrc", ".zshrc", ".bash_profile"] {
        let after = std::fs::read_to_string(f.home.join(file)).unwrap();
        assert!(!after.contains("# BEGIN otel-claude-hook"));
        assert!(!after.contains("alias claude="));
        assert!(after.contains("export FOO=bar"));
        assert!(after.contains("export PATH="));
    }
}

#[tokio::test]
async fn source_l97_removes_the_legacy_claude_otel_config() {
    let f = Fixture::new();
    f.legacy_claude();
    f.write(".claude/otel-config.json", br#"{"log_enabled":true}"#);
    f.run().await;
    assert!(!f.home.join(".claude/otel-config.json").exists());
}

#[tokio::test]
async fn source_l107_codex_cache_hook_trust_and_otel_config_are_byte_preserved() {
    let f = Fixture::new();
    let cache = f.home.join(".cache/opentelemetry.instrumentation.codex");
    std::fs::create_dir_all(cache.join("sessions")).unwrap();
    f.write(
        ".cache/opentelemetry.instrumentation.codex/hook-entry.sh",
        "#!/bin/bash",
    );
    f.write(".codex/hooks.json",serde_json::to_vec_pretty(&json!({"hooks":{"Stop":[{"hooks":[{
        "type":"command","command":"bash /Users/x/.cache/opentelemetry.instrumentation.codex/hook-entry.sh stop"
    }]}]}})).unwrap());
    f.write(".codex/config.toml","# BEGIN otel-codex-hook trust\n[hooks.state.\"/abs/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:abc\"\n# END otel-codex-hook trust");
    f.write(".codex/otel-config.json", br#"{"log_enabled":true}"#);
    let files = [
        ".codex/hooks.json",
        ".codex/config.toml",
        ".codex/otel-config.json",
        ".cache/opentelemetry.instrumentation.codex/hook-entry.sh",
    ];
    let before: Vec<_> = files
        .iter()
        .map(|p| std::fs::read(f.home.join(p)).unwrap())
        .collect();
    let report = f.run().await;
    assert!(!report.codex.migrated);
    assert!(cache.exists());
    for (file, bytes) in files.iter().zip(before) {
        assert_eq!(std::fs::read(f.home.join(file)).unwrap(), bytes);
    }
}

#[tokio::test]
async fn source_l143_invalid_claude_settings_is_fail_open_without_corrupting_user_bytes() {
    let f = Fixture::new();
    f.legacy_claude();
    let invalid = b"{ this is not json";
    f.write(".claude/settings.json", invalid);
    let report = f.run().await;
    assert!(report.claude.migrated);
    assert_eq!(
        std::fs::read(f.home.join(".claude/settings.json")).unwrap(),
        invalid
    );
    assert!(!f.cache().exists());
    assert!(report
        .claude
        .steps
        .iter()
        .any(|s| s.stage == "claude_settings" && !s.ok));
}
