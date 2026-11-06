//! One local rule per interceptor mask type.

use super::hook_text::collect_hook_text;
use super::LocalRule;
use crate::interceptor::types::{HookRequest, RuleResult};
use crate::mask::{
    find_first_sensitive_match, load_sensitive_rules, CompiledMaskRule, StringMaskOptions,
};
use crate::types::{InterceptorType, MaskType, SUPPORTED_INTERCEPTOR_TYPES};
use std::str::FromStr;
use std::sync::OnceLock;

pub const SENSITIVE_INTERCEPT_TYPES: &[&str] = SUPPORTED_INTERCEPTOR_TYPES;

fn block_reason(kind: MaskType) -> &'static str {
    match kind {
        MaskType::CloudAccessKey => "[ACCESSKEY_BLOCKED]",
        MaskType::ApiKey => "[APIKEY_BLOCKED]",
        MaskType::PrivateKey => "[PRIVATEKEY_BLOCKED]",
        MaskType::DatabaseUrl => "[DATABASEURL_BLOCKED]",
        _ => "[SENSITIVE_BLOCKED]",
    }
}

pub struct SensitiveTypeRule {
    kind: MaskType,
    rules: OnceLock<Vec<CompiledMaskRule>>,
}

impl SensitiveTypeRule {
    pub fn new(kind: InterceptorType) -> Self {
        Self {
            kind,
            rules: OnceLock::new(),
        }
    }
}

impl LocalRule for SensitiveTypeRule {
    fn id(&self) -> &str {
        self.kind.as_str()
    }

    fn supports(&self, _request: &HookRequest) -> bool {
        true
    }

    fn evaluate(&self, request: &HookRequest) -> Result<RuleResult, String> {
        let rules = self.rules.get_or_init(|| {
            load_sensitive_rules()
                .into_iter()
                .filter(|rule| rule.mask_type == self.kind)
                .collect()
        });
        if rules.is_empty() {
            return Ok(RuleResult::Miss);
        }
        let hit = find_first_sensitive_match(
            &collect_hook_text(request),
            rules,
            &StringMaskOptions::default(),
        );
        if hit.is_some() {
            Ok(RuleResult::Match {
                reason: block_reason(self.kind).to_string(),
            })
        } else {
            Ok(RuleResult::Miss)
        }
    }
}

pub fn create_sensitive_type_rule(kind: &str) -> SensitiveTypeRule {
    let parsed = MaskType::from_str(kind).unwrap_or(MaskType::ApiKey);
    SensitiveTypeRule::new(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::rules::{builtin_rules, RuleEngine};
    use crate::interceptor::types::{
        HookEventName, HookRequest, InterceptorAgent, RuleResult, VerdictAction,
    };
    use serde_json::{json, Map};
    use std::collections::HashSet;
    use std::sync::Arc;

    fn request(prompt: Option<&str>) -> HookRequest {
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
            prompt: prompt.map(str::to_string),
            raw: Map::new(),
        }
    }

    #[test]
    fn registers_the_four_mask_types_in_json_order() {
        let ids: Vec<_> = builtin_rules()
            .iter()
            .map(|rule| rule.id().to_string())
            .collect();
        assert_eq!(
            ids,
            SENSITIVE_INTERCEPT_TYPES
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn stays_bypassed_until_the_type_is_enabled() {
        let engine = RuleEngine::new(builtin_rules(), HashSet::new());
        let mut sample = request(Some("LTAI1234567890ABCD"));
        let verdict = engine.evaluate(&sample);
        assert_eq!(verdict.action, VerdictAction::Allow);
        assert!(verdict.reason.is_none());
        assert!(verdict.rule_id.is_none());
        assert!(verdict.evaluated_rules.is_empty());
        sample.prompt = Some("LTAI1234567890ABCD".to_string());
        assert_eq!(engine.evaluate(&sample).action, VerdictAction::Allow);
    }

    #[test]
    fn blocks_known_secret_shapes() {
        let cases = [
            ("cloudAccessKey", "please use LTAI1234567890ABCD", "[ACCESSKEY_BLOCKED]"),
            ("cloudAccessKey", "aws=AKIAIOSFODNN7EXAMPLE", "[ACCESSKEY_BLOCKED]"),
            ("cloudAccessKey", "sts=ASIAIOSFODNN7EXAMPLE", "[ACCESSKEY_BLOCKED]"),
            ("cloudAccessKey", concat!("sts=ASIA", "ABCDEFGHIJKLMNOP"), "[ACCESSKEY_BLOCKED]"),
            ("apiKey", "openai=sk-1234567890abcdefghijklmnop", "[APIKEY_BLOCKED]"),
            ("cloudAccessKey", "tencent=AKIDabcdefghijklmnopqrstuvwxyz", "[ACCESSKEY_BLOCKED]"),
            ("apiKey", "openai=sk-EXAMPLE0123456789abcdef", "[APIKEY_BLOCKED]"),
            ("apiKey", "github=ghp_1234567890abcdefghijklmnop", "[APIKEY_BLOCKED]"),
            (
                "privateKey",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----",
                "[PRIVATEKEY_BLOCKED]",
            ),
            ("databaseUrl", "mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot", "[DATABASEURL_BLOCKED]"),
            (
                "databaseUrl",
                "jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12",
                "[DATABASEURL_BLOCKED]",
            ),
        ];
        for (kind, prompt, reason) in cases {
            let engine = RuleEngine::new(builtin_rules(), HashSet::from([kind.to_string()]));
            let verdict = engine.evaluate(&request(Some(prompt)));
            assert_eq!(verdict.action, VerdictAction::Block, "{kind} / {prompt}");
            assert_eq!(verdict.reason.as_deref(), Some(reason), "{kind}");
            assert_eq!(verdict.rule_id.as_deref(), Some(kind));
            assert_eq!(verdict.evaluated_rules, vec![kind.to_string()]);
        }
    }

    #[test]
    fn blocks_secrets_in_tool_input_and_response() {
        let engine = RuleEngine::new(builtin_rules(), HashSet::from(["apiKey".to_string()]));
        let mut pre = request(None);
        pre.event = HookEventName::PreToolUse;
        pre.tool_name = Some("Bash".to_string());
        pre.tool_input = Some(json!({"command": "export KEY=sk-1234567890abcdefghijklmnop"}));
        let verdict = engine.evaluate(&pre);
        assert_eq!(verdict.action, VerdictAction::Block);
        assert_eq!(verdict.reason.as_deref(), Some("[APIKEY_BLOCKED]"));
        assert_eq!(verdict.rule_id.as_deref(), Some("apiKey"));
        assert_eq!(verdict.evaluated_rules, vec!["apiKey"]);

        let mut post = request(None);
        post.event = HookEventName::PostToolUse;
        post.tool_name = Some("Bash".to_string());
        post.tool_response = Some(json!({"stdout": "openai=sk-1234567890abcdefghijklmnop"}));
        let verdict = engine.evaluate(&post);
        assert_eq!(verdict.action, VerdictAction::Block);
        assert_eq!(verdict.reason.as_deref(), Some("[APIKEY_BLOCKED]"));
        assert_eq!(verdict.rule_id.as_deref(), Some("apiKey"));
        assert_eq!(verdict.evaluated_rules, vec!["apiKey"]);
    }

    #[test]
    fn blocks_secrets_in_nested_read_file_content() {
        let engine = RuleEngine::new(builtin_rules(), HashSet::from(["databaseUrl".to_string()]));
        let mut post = request(None);
        post.event = HookEventName::PostToolUse;
        post.tool_name = Some("Read".to_string());
        post.tool_input = Some(json!({"file_path": "/Users/henryzhang/Desktop/tmp"}));
        post.tool_response = Some(json!({
            "type": "text",
            "file": {
                "filePath": "../../../../Desktop/tmp",
                "content": "我的一些mysql常用配置：\nmysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot\npostgres://agent:PostgresPass123@127.0.0.1:5432/pilot\n",
                "numLines": 6,
                "startLine": 1,
                "totalLines": 6
            }
        }));
        let verdict = engine.evaluate(&post);
        assert_eq!(verdict.action, VerdictAction::Block);
        assert_eq!(verdict.reason.as_deref(), Some("[DATABASEURL_BLOCKED]"));
        assert_eq!(verdict.rule_id.as_deref(), Some("databaseUrl"));
        assert_eq!(verdict.evaluated_rules, vec!["databaseUrl"]);
    }

    #[test]
    fn allows_non_matching_text_when_the_switch_is_on() {
        let cloud = create_sensitive_type_rule("cloudAccessKey");
        assert_eq!(
            cloud
                .evaluate(&request(Some("short_aliyun=LTAI123")))
                .unwrap(),
            RuleResult::Miss
        );
        let database = create_sensitive_type_rule("databaseUrl");
        assert_eq!(
            database
                .evaluate(&request(Some("mysql://localhost:3306/pilot")))
                .unwrap(),
            RuleResult::Miss
        );
        let _ = Arc::new(cloud);
    }
}
