//! Exact frozen shared resource/span contracts against native production helpers.
use super::*;
use serde_json::json;
fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
#[test]
fn resource_fixed_fields_never_copy_secrets_or_unlisted_markers() {
    let attrs = collect_resource_attributes(
        &env(&[
            ("AGENTTEAMS_WORKER_NAME", " worker-01 "),
            ("AGENTTEAMS_INSTANCE_ID", " example-instance "),
            ("AGENTTEAMS_TOKEN", "should-not-leak"),
            ("AGENTTEAMS_TEAM_NAME", "not-in-fixed-map"),
        ]),
        "fixture",
    );
    assert_eq!(
        Value::Object(attrs),
        json!({"agentteams.worker.name":"worker-01","agentteams.instance.id":"example-instance"})
    );
}
#[test]
fn resource_worker_name_becomes_agent_name() {
    assert_eq!(
        agent_name_patch(
            json!({"agentteams.worker.name":"worker-01"})
                .as_object()
                .unwrap()
        )
        .as_deref(),
        Some("worker-01")
    );
}
fn constant(source: &str, name: &str) -> Vec<String> {
    let regex = regex::Regex::new(&format!(
        r"(?s)\b{}\b[^=]*=\s*&?\[([^\]]+)\]",
        regex::escape(name)
    ))
    .unwrap();
    let body = regex.captures(source).unwrap().get(1).unwrap().as_str();
    let strings = regex::Regex::new(r#"['"]([^'"]+)['"]"#).unwrap();
    let mut result = strings
        .captures_iter(body)
        .map(|m| m[1].to_owned())
        .collect::<Vec<_>>();
    result.sort();
    result
}
#[test]
fn resource_hook_and_plugin_fixed_maps_and_projection_agree() {
    let resources = collect_resource_attributes(
        &env(&[
            ("AGENTTEAMS_WORKER_NAME", " planner "),
            ("AGENTTEAMS_INSTANCE_ID", " instance-01 "),
            ("AGENTTEAMS_TOKEN", "must-not-leak"),
            ("AGENTTEAMS_TEAM_NAME", "not-allowlisted"),
        ]),
        "fixture",
    );
    assert_eq!(
        Value::Object(resources.clone()),
        json!({"agentteams.worker.name":"planner","agentteams.instance.id":"instance-01"})
    );
    assert_eq!(agent_name_patch(&resources).as_deref(), Some("planner"));
    let plugin = include_str!("../../assets/plugins/shared/resource-context.mjs");
    let hook = include_str!("../../assets/hooks/shared/resource-context.mjs");
    for field in [
        "AGENTTEAMS_WORKER_NAME",
        "AGENTTEAMS_INSTANCE_ID",
        "agentteams.worker.name",
        "agentteams.instance.id",
    ] {
        assert!(plugin.contains(field));
        assert!(hook.contains(field));
    }
}
#[test]
fn resource_empty_and_513_character_values_are_rejected() {
    let long = "x".repeat(513);
    assert!(collect_resource_attributes(
        &env(&[
            ("AGENTTEAMS_WORKER_NAME", " "),
            ("AGENTTEAMS_INSTANCE_ID", &long)
        ]),
        "fixture"
    )
    .is_empty());
}
#[test]
fn span_pairs_are_trimmed() {
    assert_eq!(
        Value::Object(parse_span_attributes(
            &env(&[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "multica.issue.id=AGE-992, multica.user.id = staff "
            )]),
            "fixture",
            false
        )),
        json!({"multica.issue.id":"AGE-992","multica.user.id":"staff"})
    );
}
#[test]
fn span_missing_and_empty_values_are_empty() {
    for values in [env(&[]), env(&[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", "")])] {
        assert!(parse_span_attributes(&values, "fixture", false).is_empty());
    }
}
#[test]
fn span_reserved_prefixes_are_dropped() {
    assert_eq!(
        Value::Object(parse_span_attributes(
            &env(&[(
                "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
                "gen_ai.foo=x,git.repo=y,user.id=z,agent.thing=w,multica.ok=keep"
            )]),
            "fixture",
            false
        )),
        json!({"multica.ok":"keep"})
    );
}
#[test]
fn span_only_explicitly_enabled_invocation_identity_keys_cross_reserved_prefix() {
    let attrs=parse_span_attributes(&env(&[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES","gen_ai.session.id=customer-session,gen_ai.user.id=customer-user,gen_ai.agent.name=must-stay-reserved,user.id=must-stay-reserved,multica.issue.id=AGE-287")]),"fixture",true);
    assert_eq!(attrs.len(), 3);
    assert_eq!(
        attrs.get("agent.pilot.invocation.session.id"),
        Some(&json!("customer-session"))
    );
    assert_eq!(
        attrs.get("agent.pilot.invocation.user.id"),
        Some(&json!("customer-user"))
    );
    assert_eq!(attrs.get("multica.issue.id"), Some(&json!("AGE-287")));
    assert!(!serde_json::to_string(&attrs)
        .unwrap()
        .contains("must-stay-reserved"));
    assert!(attrs.values().any(|v| v == "customer-session"));
    assert!(attrs.values().any(|v| v == "customer-user"));
}
#[test]
fn span_invocation_keys_remain_reserved_without_opt_in() {
    assert!(parse_span_attributes(
        &env(&[(
            "LOONGSUITE_PILOT_SPAN_ATTRIBUTES",
            "gen_ai.session.id=customer-session,gen_ai.user.id=customer-user"
        )]),
        "fixture",
        false
    )
    .is_empty());
}
#[test]
fn span_sensitive_long_and_malformed_pairs_are_dropped() {
    let text = format!(
        "multica.token=secret,multica.big={},noequalssign,=novalue,multica.ok=keep",
        "v".repeat(513)
    );
    assert_eq!(
        Value::Object(parse_span_attributes(
            &env(&[("LOONGSUITE_PILOT_SPAN_ATTRIBUTES", &text)]),
            "fixture",
            false
        )),
        json!({"multica.ok":"keep"})
    );
}
#[test]
fn span_custom_environment_name_uses_the_real_parser() {
    assert_eq!(
        Value::Object(parse_span_attributes_from_env(
            &env(&[("CUSTOM_ENV", "multica.issue.id=AGE-1")]),
            "fixture",
            false,
            "CUSTOM_ENV"
        )),
        json!({"multica.issue.id":"AGE-1"})
    );
}
#[test]
fn every_shipped_reserved_prefix_list_agrees_with_native_normalization() {
    let native = constant(
        include_str!("../normalization/global_attributes.rs"),
        "RESERVED_PREFIXES",
    );
    assert!(!native.is_empty());
    for text in [
        include_str!("../../assets/hooks/shared/resource-context.mjs"),
        include_str!("../../assets/plugins/opencode/plugin.mjs"),
        include_str!("../../assets/plugins/openclaw/plugin.mjs"),
    ] {
        assert_eq!(constant(text, "SPAN_ATTR_RESERVED_PREFIXES"), native);
    }
    for prefix in &native {
        assert!(reserved_span_key(prefix));
        assert!(reserved_span_key(&format!("{prefix}fixture")));
    }
}
#[test]
fn native_marker_character_budget_keeps_original_utf16_boundary() {
    let accepted = "中".repeat(512);
    let rejected = "中".repeat(513);
    assert_eq!(
        collect_resource_attributes(&env(&[("AGENTTEAMS_WORKER_NAME", &accepted)]), "fixture")
            ["agentteams.worker.name"],
        accepted
    );
    assert!(
        collect_resource_attributes(&env(&[("AGENTTEAMS_WORKER_NAME", &rejected)]), "fixture")
            .is_empty()
    );
}

#[test]
fn native_marker_supplementary_characters_keep_original_utf16_boundary() {
    let accepted = "🚀".repeat(256);
    let rejected = "🚀".repeat(257);
    assert_eq!(
        collect_resource_attributes(&env(&[("AGENTTEAMS_WORKER_NAME", &accepted)]), "fixture")
            ["agentteams.worker.name"],
        accepted
    );
    assert!(
        collect_resource_attributes(&env(&[("AGENTTEAMS_WORKER_NAME", &rejected)]), "fixture")
            .is_empty()
    );
}
