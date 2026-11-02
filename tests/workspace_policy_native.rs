//! Durable exclusions must interoperate across the hook/manager and hosted input.
use loongsuite_pilot::inputs::base::WorkspacePolicy as SourcePolicy;
use loongsuite_pilot::pipeline::workspace_policy::WorkspacePolicy as ManagerPolicy;
use serde_json::{json, Map, Value};

fn row(agent: &str, session: &str, cwd: Option<&str>) -> Map<String, Value> {
    let mut record = json!({
        "gen_ai.agent.type":agent, "gen_ai.session.id":session,
        "gen_ai.root.session.id":"shared-parent",
        "gen_ai.parent.session.id":"shared-parent"
    })
    .as_object()
    .unwrap()
    .clone();
    if let Some(cwd) = cwd {
        record.insert("workspace.path".into(), json!(cwd));
    }
    record
}

fn cross_policy_markers(duplicate_rule: bool, canonical_rule: bool) {
    let root = tempfile::tempdir().unwrap();
    let private = root.path().join("private");
    std::fs::create_dir(&private).unwrap();
    let private = if canonical_rule {
        private.canonicalize().unwrap()
    } else {
        private
    };
    let rule = private.to_string_lossy().into_owned();
    let rules = if duplicate_rule {
        vec![rule.clone(), rule.clone()]
    } else {
        vec![rule.clone()]
    };
    let state = root.path().join("exclusions");
    let mut manager =
        ManagerPolicy::new(&rules, Some(state.to_string_lossy().into_owned())).unwrap();
    assert!(!manager.allows(&row("codex", "manager-child", Some(&rule)), "codex"));
    // A new source process must consume the manager/hook's marker even without cwd.
    let mut source = SourcePolicy::new(rules.clone(), Some(state.clone()));
    assert!(!source.allows(&row("codex", "manager-child", None), "codex"));
    assert!(!source.allows(&row("codex", "source-child", Some(&rule)), "codex"));
    drop(source);
    drop(manager);
    let mut manager =
        ManagerPolicy::new(&rules, Some(state.to_string_lossy().into_owned())).unwrap();
    assert!(!manager.allows(&row("codex", "source-child", None), "codex"));
    // Own session and agent scope, never root/parent aliases or text mentions.
    assert!(manager.allows(&row("codex", "allowed-parent", None), "codex"));
    assert!(manager.allows(&row("cursor", "source-child", None), "cursor"));
    let mut text_only = row("codex", "unknown-fresh", None);
    text_only.insert(
        "gen_ai.input.messages".into(),
        json!([
            {"role":"system","content":rule},{"role":"user","content":rule},
            {"role":"tool","content":rule},{"role":"plugin","content":rule}
        ]),
    );
    assert!(manager.allows(&text_only, "codex"));
    let other_rule = root.path().join("other").to_string_lossy().into_owned();
    let mut changed = SourcePolicy::new(vec![other_rule], Some(state.clone()));
    assert!(changed.allows(&row("codex", "manager-child", None), "codex"));
    let mut restored = SourcePolicy::new(rules, Some(state));
    assert!(!restored.allows(&row("codex", "manager-child", None), "codex"));
}

#[test]
fn source_and_manager_share_markers_with_native_rule_paths() {
    cross_policy_markers(false, false);
}
#[test]
fn source_and_manager_share_markers_with_duplicate_valid_rules() {
    cross_policy_markers(true, false);
}
#[test]
fn source_and_manager_share_markers_with_canonical_rule_paths() {
    cross_policy_markers(false, true);
}
