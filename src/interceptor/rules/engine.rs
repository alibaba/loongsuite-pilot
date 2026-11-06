//! Local rule evaluation. A thrown rule fail-opens the rest of the chain.

use super::LocalRule;
use crate::interceptor::types::{EvaluateHookResponse, HookRequest};
use std::collections::HashSet;
use std::sync::Arc;

pub struct RuleEngine {
    rules: Vec<Arc<dyn LocalRule>>,
    enabled_rule_ids: HashSet<String>,
}

impl RuleEngine {
    pub fn new(rules: Vec<Arc<dyn LocalRule>>, enabled_rule_ids: HashSet<String>) -> Self {
        Self {
            rules,
            enabled_rule_ids,
        }
    }

    pub fn evaluate(&self, request: &HookRequest) -> EvaluateHookResponse {
        let mut evaluated_rules = Vec::new();
        for rule in &self.rules {
            if !self.enabled_rule_ids.contains(rule.id()) {
                continue;
            }
            if !rule.supports(request) {
                continue;
            }
            evaluated_rules.push(rule.id().to_string());
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rule.evaluate(request)));
            let result = match result {
                Ok(inner) => inner,
                Err(_) => return EvaluateHookResponse::fail_open(evaluated_rules),
            };
            match result {
                Err(_) => return EvaluateHookResponse::fail_open(evaluated_rules),
                Ok(crate::interceptor::types::RuleResult::Miss) => {}
                Ok(crate::interceptor::types::RuleResult::Match { reason }) => {
                    return EvaluateHookResponse::block(
                        reason,
                        rule.id().to_string(),
                        evaluated_rules,
                    );
                }
            }
        }
        EvaluateHookResponse::allow(evaluated_rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::rules::{builtin_rules, LocalRule};
    use crate::interceptor::types::{
        HookEventName, HookRequest, InterceptorAgent, RuleResult, VerdictAction,
    };
    use serde_json::Map;
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    fn request() -> HookRequest {
        HookRequest {
            agent: InterceptorAgent::Qoder,
            event: HookEventName::UserPromptSubmit,
            session_id: None,
            transcript_path: None,
            cwd: None,
            tool_name: None,
            tool_input: None,
            tool_response: None,
            tool_use_id: None,
            prompt: Some("hello".to_string()),
            raw: Map::new(),
        }
    }

    struct ClosureRule {
        id: &'static str,
        supports_request: bool,
        evaluate_fn: Mutex<Box<dyn FnMut() -> Result<RuleResult, String> + Send>>,
    }

    impl LocalRule for ClosureRule {
        fn id(&self) -> &str {
            self.id
        }
        fn supports(&self, _: &HookRequest) -> bool {
            self.supports_request
        }
        fn evaluate(&self, _: &HookRequest) -> Result<RuleResult, String> {
            (self.evaluate_fn.lock().expect("rule lock"))()
        }
    }

    fn rule(
        id: &'static str,
        supports_request: bool,
        matched: bool,
        reason: &'static str,
        throws: bool,
    ) -> Arc<dyn LocalRule> {
        Arc::new(ClosureRule {
            id,
            supports_request,
            evaluate_fn: Mutex::new(Box::new(move || {
                if throws {
                    Err("rule failed".to_string())
                } else if matched {
                    Ok(RuleResult::Match {
                        reason: reason.to_string(),
                    })
                } else {
                    Ok(RuleResult::Miss)
                }
            })),
        })
    }

    #[test]
    fn allows_builtin_rules_when_they_are_not_enabled() {
        let engine = RuleEngine::new(builtin_rules(), HashSet::from(["anything".to_string()]));
        let mut prompt = request();
        prompt.prompt = Some("testing".to_string());
        let verdict = engine.evaluate(&prompt);
        assert_eq!(verdict.action, VerdictAction::Allow);
        assert!(verdict.evaluated_rules.is_empty());
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"allow","evaluatedRules":[]})
        );
        prompt.prompt = Some("LTAI1234567890ABCD".to_string());
        let verdict = engine.evaluate(&prompt);
        assert_eq!(verdict.action, VerdictAction::Allow);
        assert!(verdict.evaluated_rules.is_empty());
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"allow","evaluatedRules":[]})
        );
    }

    #[test]
    fn bypasses_rules_unless_they_are_in_the_enabled_set() {
        let engine = RuleEngine::new(
            vec![
                rule("alpha", true, true, "a", false),
                rule("beta", true, true, "b", false),
            ],
            HashSet::from(["gamma".to_string()]),
        );
        let verdict = engine.evaluate(&request());
        assert_eq!(verdict.action, VerdictAction::Allow);
        assert!(verdict.evaluated_rules.is_empty());
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"allow","evaluatedRules":[]})
        );
    }

    #[test]
    fn executes_enabled_rules_in_registration_order_and_short_circuits() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let make = |id: &'static str,
                    matched: bool,
                    reason: &'static str,
                    seen: Arc<Mutex<Vec<&'static str>>>| {
            let seen_rule = seen.clone();
            Arc::new(ClosureRule {
                id,
                supports_request: true,
                evaluate_fn: Mutex::new(Box::new(move || {
                    seen_rule.lock().unwrap().push(id);
                    if matched {
                        Ok(RuleResult::Match {
                            reason: reason.to_string(),
                        })
                    } else {
                        Ok(RuleResult::Miss)
                    }
                })),
            }) as Arc<dyn LocalRule>
        };
        let engine = RuleEngine::new(
            vec![
                make("first", false, "", seen.clone()),
                make("blocker", true, "stop here", seen.clone()),
                make("later", true, "should not run", seen.clone()),
            ],
            HashSet::from([
                "first".to_string(),
                "blocker".to_string(),
                "later".to_string(),
            ]),
        );
        let verdict = engine.evaluate(&request());
        assert_eq!(verdict.action, VerdictAction::Block);
        assert_eq!(verdict.reason.as_deref(), Some("stop here"));
        assert_eq!(verdict.rule_id.as_deref(), Some("blocker"));
        assert_eq!(
            verdict.evaluated_rules,
            vec!["first".to_string(), "blocker".to_string()]
        );
        assert_eq!(*seen.lock().unwrap(), vec!["first", "blocker"]);
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"block","reason":"stop here","ruleId":"blocker","evaluatedRules":["first","blocker"]})
        );
    }

    #[test]
    fn fail_opens_when_a_rule_returns_an_error() {
        let engine = RuleEngine::new(
            vec![
                rule("boom", true, false, "", true),
                rule("later", true, true, "later", false),
            ],
            HashSet::from(["boom".to_string(), "later".to_string()]),
        );
        let verdict = engine.evaluate(&request());
        assert_eq!(verdict.action, VerdictAction::Allow);
        assert_eq!(verdict.fail_open, Some(true));
        assert_eq!(verdict.evaluated_rules, vec!["boom".to_string()]);
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"allow","evaluatedRules":["boom"],"failOpen":true})
        );
    }

    #[test]
    fn skips_rules_that_do_not_support_the_request() {
        let engine = RuleEngine::new(
            vec![
                rule("prompt-only", false, true, "no", false),
                rule("tool", true, true, "tool blocked", false),
            ],
            HashSet::from(["prompt-only".to_string(), "tool".to_string()]),
        );
        let mut tool = request();
        tool.event = HookEventName::PreToolUse;
        tool.tool_name = Some("Bash".to_string());
        let verdict = engine.evaluate(&tool);
        assert_eq!(verdict.action, VerdictAction::Block);
        assert_eq!(verdict.reason.as_deref(), Some("tool blocked"));
        assert_eq!(verdict.rule_id.as_deref(), Some("tool"));
        assert_eq!(verdict.evaluated_rules, vec!["tool".to_string()]);
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            serde_json::json!({"action":"block","reason":"tool blocked","ruleId":"tool","evaluatedRules":["tool"]})
        );
    }
}
