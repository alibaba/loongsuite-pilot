//! Mask whitelisted fields on an `AgentActivityEntry` without renaming JSON keys.

use super::field_whitelist::should_mask_field;
use super::rule_loader::load_mask_plan;
use super::string_masker::mask_string;
use super::types::{MaskConfig, MaskPlan, PlanOrRules, StringMaskOptions};
use crate::types::AgentActivityEntry;
use serde_json::Value;
use std::borrow::Cow;

const MAX_MASK_JSON_DEPTH: usize = 32;

pub fn mask_agent_activity_entry<'a>(
    entry: &'a AgentActivityEntry,
    config: &MaskConfig,
    plan_or_rules: Option<PlanOrRules<'_>>,
    options: Option<&StringMaskOptions>,
) -> Cow<'a, AgentActivityEntry> {
    let default_options = StringMaskOptions::default();
    let options = options.unwrap_or(&default_options);
    let held: MaskPlan;
    let plan: &MaskPlan = match plan_or_rules {
        Some(PlanOrRules::Plan(plan)) => plan,
        Some(PlanOrRules::Rules(rules)) => {
            held = MaskPlan::from_rules(rules);
            &held
        }
        None => {
            held = load_mask_plan(config);
            &held
        }
    };
    if plan.rules.is_empty() && plan.pii_types.is_empty() {
        return Cow::Borrowed(entry);
    }

    let mut owned: Option<AgentActivityEntry> = None;
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.input.messages",
        entry.input_messages.as_ref(),
        |slot, value| slot.input_messages = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.input.messages_delta",
        entry.input_messages_delta.as_ref(),
        |slot, value| slot.input_messages_delta = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.input.multimodal_metadata",
        entry.input_multimodal_metadata.as_ref(),
        |slot, value| slot.input_multimodal_metadata = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.input.multimodal_metadata_delta",
        entry.input_multimodal_metadata_delta.as_ref(),
        |slot, value| slot.input_multimodal_metadata_delta = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.output.messages",
        entry.output_messages.as_ref(),
        |slot, value| slot.output_messages = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.output.multimodal_metadata",
        entry.output_multimodal_metadata.as_ref(),
        |slot, value| slot.output_multimodal_metadata = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.tool.call.arguments",
        entry.tool_call_arguments.as_ref(),
        |slot, value| slot.tool_call_arguments = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.tool.call.result",
        entry.tool_call_result.as_ref(),
        |slot, value| slot.tool_call_result = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.system_instructions",
        entry.system_instructions.as_ref(),
        |slot, value| slot.system_instructions = Some(value),
        plan,
        options,
    );
    mask_json_field(
        &mut owned,
        entry,
        "gen_ai.tool.definitions",
        entry.tool_definitions.as_ref(),
        |slot, value| slot.tool_definitions = Some(value),
        plan,
        options,
    );

    if should_mask_field("error.message") {
        if let Some(text) = entry.error_message.as_ref() {
            let masked = mask_string(text, PlanOrRules::Plan(plan), options);
            if masked.as_ref() != text {
                owned.get_or_insert_with(|| entry.clone()).error_message =
                    Some(masked.into_owned());
            }
        }
    }

    let extra_keys: Vec<String> = entry
        .extra
        .keys()
        .filter(|key| should_mask_field(key))
        .cloned()
        .collect();
    for key in extra_keys {
        let masked = entry.extra.get(&key).and_then(|value| {
            match mask_json_value(value, plan, options, 0) {
                Cow::Owned(value) => Some(value),
                Cow::Borrowed(_) => None,
            }
        });
        if let Some(masked) = masked {
            owned
                .get_or_insert_with(|| entry.clone())
                .extra
                .insert(key, masked);
        }
    }

    match owned {
        Some(masked) => Cow::Owned(masked),
        None => Cow::Borrowed(entry),
    }
}

fn mask_json_field(
    owned: &mut Option<AgentActivityEntry>,
    entry: &AgentActivityEntry,
    field: &str,
    value: Option<&Value>,
    assign: impl FnOnce(&mut AgentActivityEntry, Value),
    plan: &MaskPlan,
    options: &StringMaskOptions,
) {
    if !should_mask_field(field) {
        return;
    }
    let Some(value) = value else {
        return;
    };
    if let Cow::Owned(masked) = mask_json_value(value, plan, options, 0) {
        assign(owned.get_or_insert_with(|| entry.clone()), masked);
    }
}

fn mask_json_value<'a>(
    value: &'a Value,
    plan: &MaskPlan,
    options: &StringMaskOptions,
    depth: usize,
) -> Cow<'a, Value> {
    if depth >= MAX_MASK_JSON_DEPTH {
        return Cow::Borrowed(value);
    }
    match value {
        Value::String(text) => {
            let masked = mask_string(text, PlanOrRules::Plan(plan), options);
            if masked.as_ref() == text {
                Cow::Borrowed(value)
            } else {
                Cow::Owned(Value::String(masked.into_owned()))
            }
        }
        Value::Array(items) => {
            let mut changed = None;
            for (index, item) in items.iter().enumerate() {
                if let Cow::Owned(masked) = mask_json_value(item, plan, options, depth + 1) {
                    changed.get_or_insert_with(|| items.clone())[index] = masked;
                }
            }
            match changed {
                Some(items) => Cow::Owned(Value::Array(items)),
                None => Cow::Borrowed(value),
            }
        }
        Value::Object(map) => {
            let mut changed = None;
            for (key, child) in map {
                if let Cow::Owned(masked) = mask_json_value(child, plan, options, depth + 1) {
                    changed
                        .get_or_insert_with(|| map.clone())
                        .insert(key.clone(), masked);
                }
            }
            match changed {
                Some(map) => Cow::Owned(Value::Object(map)),
                None => Cow::Borrowed(value),
            }
        }
        _ => Cow::Borrowed(value),
    }
}

#[cfg(test)]
mod tests {
    use super::mask_agent_activity_entry;
    use crate::mask::types::{MaskConfig, MaskMode, MaskType};
    use crate::types::AgentActivityEntry;
    use serde_json::{json, Value};
    use std::borrow::Cow;

    fn all_config() -> MaskConfig {
        MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: None,
        }
    }

    fn entry(value: Value) -> AgentActivityEntry {
        serde_json::from_value(value).expect("activity entry")
    }

    #[test]
    fn masks_only_collector_whitelist_fields() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let original = entry(json!({
            "gen_ai.input.messages": [{"role": "user", "content": format!("use {secret}")}],
            "workspace.current_root": format!("/tmp/{secret}"),
        }));
        let masked = mask_agent_activity_entry(&original, &all_config(), None, None);
        let workspace = format!("/tmp/{secret}");
        assert_eq!(
            masked.input_messages,
            Some(json!([{"role": "user", "content": "use [ACCESSKEY_MASKED]"}]))
        );
        assert_eq!(
            masked.workspace_current_root.as_deref(),
            Some(workspace.as_str())
        );
        assert_eq!(
            original.input_messages,
            Some(json!([{"role": "user", "content": format!("use {secret}")}]))
        );
        let serialized = serde_json::to_value(&*masked).unwrap();
        assert!(serialized.get("gen_ai.input.messages").is_some());
        assert!(serialized.get("workspace.current_root").is_some());
    }

    #[test]
    fn does_not_mask_non_content_metadata_fields() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let original = entry(json!({
            "user.id": secret,
            "service.name": format!("service-{secret}"),
            "resource.attributes": {"cloud": secret},
            "process.command_line": format!("pilot --token {secret}"),
            "gen_ai.request.model": format!("model-{secret}"),
            "gen_ai.session.id": format!("session-{secret}"),
            "event.id": format!("event-{secret}"),
        }));
        let masked = mask_agent_activity_entry(&original, &all_config(), None, None);
        let service = format!("service-{secret}");
        let command = format!("pilot --token {secret}");
        let model = format!("model-{secret}");
        assert_eq!(masked.user_id, secret);
        assert_eq!(masked.service_name.as_deref(), Some(service.as_str()));
        assert_eq!(
            masked.extra.get("resource.attributes").cloned(),
            Some(json!({"cloud": secret}))
        );
        assert_eq!(
            masked
                .extra
                .get("process.command_line")
                .and_then(Value::as_str),
            Some(command.as_str())
        );
        assert_eq!(masked.request_model.as_deref(), Some(model.as_str()));
        assert_eq!(masked.session_id, format!("session-{secret}"));
        assert_eq!(masked.event_id, format!("event-{secret}"));
        let serialized = serde_json::to_string(&*masked).unwrap();
        assert!(!serialized.contains("[ACCESSKEY_MASKED]"));
    }

    #[test]
    fn respects_custom_mask_categories() {
        let access_key = "LTAIEXAMPLE0123456";
        let api_key = "sk-EXAMPLE0123456789abcdef";
        let original = entry(json!({
            "gen_ai.tool.call.arguments": format!("ak={access_key} key={api_key}"),
        }));
        let masked = mask_agent_activity_entry(
            &original,
            &MaskConfig {
                mode: MaskMode::Custom,
                types: vec![MaskType::ApiKey],
                replacement_mode: None,
            },
            None,
            None,
        );
        let args = masked
            .tool_call_arguments
            .as_ref()
            .unwrap()
            .as_str()
            .unwrap();
        assert!(args.contains(access_key));
        assert!(args.contains("[APIKEY_MASKED]"));
        assert!(!args.contains(api_key));
    }

    #[test]
    fn leaves_entries_unchanged_when_mask_mode_is_none() {
        let api_key = "sk-EXAMPLE0123456789abcdef";
        let original = entry(json!({
            "gen_ai.output.messages": [{"role": "assistant", "content": api_key}],
        }));
        let masked = mask_agent_activity_entry(
            &original,
            &MaskConfig {
                mode: MaskMode::None,
                types: Vec::new(),
                replacement_mode: None,
            },
            None,
            None,
        );
        assert!(matches!(masked, Cow::Borrowed(value) if std::ptr::eq(value, &original)));
        assert_eq!(masked.as_ref(), &original);
    }

    #[test]
    fn returns_the_original_entry_when_no_rules_are_enabled() {
        let original = entry(json!({
            "gen_ai.output.messages": [{"role": "assistant", "content": "hello"}],
        }));
        let masked = mask_agent_activity_entry(
            &original,
            &MaskConfig {
                mode: MaskMode::None,
                types: Vec::new(),
                replacement_mode: None,
            },
            None,
            None,
        );
        assert!(matches!(masked, Cow::Borrowed(value) if std::ptr::eq(value, &original)));
    }

    #[test]
    fn returns_the_original_entry_when_enabled_rules_make_no_changes() {
        let original = entry(json!({
            "gen_ai.output.messages": [{"role": "assistant", "content": "plain content"}],
        }));
        let masked = mask_agent_activity_entry(&original, &all_config(), None, None);
        assert!(matches!(masked, Cow::Borrowed(value) if std::ptr::eq(value, &original)));
    }

    #[test]
    fn stops_recursive_traversal_after_the_max_mask_depth() {
        let api_key = "sk-EXAMPLE0123456789abcdef";
        let mut nested = json!({"content": api_key});
        for _ in 0..40 {
            nested = json!({"child": nested});
        }
        let original = entry(json!({"gen_ai.tool.call.arguments": nested}));
        let masked = mask_agent_activity_entry(&original, &all_config(), None, None);
        let serialized = serde_json::to_string(&*masked).unwrap();
        assert!(serialized.contains(api_key));
        assert!(matches!(masked, Cow::Borrowed(value) if std::ptr::eq(value, &original)));
    }

    #[test]
    fn still_masks_normally_nested_values_within_the_max_mask_depth() {
        let api_key = "sk-EXAMPLE0123456789abcdef";
        let original = entry(json!({
            "gen_ai.tool.call.arguments": {
                "request": {"body": {"content": api_key}}
            }
        }));
        let masked = mask_agent_activity_entry(&original, &all_config(), None, None);
        let serialized = serde_json::to_string(&*masked).unwrap();
        assert!(serialized.contains("[APIKEY_MASKED]"));
        assert!(!serialized.contains(api_key));
    }
}
