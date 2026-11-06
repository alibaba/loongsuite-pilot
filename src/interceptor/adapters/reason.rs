//! Host-facing reason text. The interceptor reason fills the detail slot.

use crate::interceptor::types::HookEventName;

pub fn wrap_host_reason(event: HookEventName, interceptor_reason: Option<&str>) -> String {
    let detail = interceptor_reason.unwrap_or("").trim();
    if detail.is_empty() {
        return match event {
            HookEventName::UserPromptSubmit => "检测到敏感信息，本轮对话终止".to_string(),
            HookEventName::PostToolUse => {
                "检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
                    .to_string()
            }
            HookEventName::PreToolUse => {
                "检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
                    .to_string()
            }
        };
    }
    match event {
        HookEventName::UserPromptSubmit => format!("检测到敏感信息：{detail}，本轮对话终止"),
        HookEventName::PostToolUse => format!(
            "检测到非预期行为：{detail}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
        ),
        HookEventName::PreToolUse => format!(
            "检测到非预期行为：{detail}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::HookEventName;

    #[test]
    fn keeps_the_interceptor_string_as_the_detail_slot() {
        assert_eq!(
            wrap_host_reason(HookEventName::UserPromptSubmit, Some("内容非法")),
            "检测到敏感信息：内容非法，本轮对话终止"
        );
        assert_eq!(
            wrap_host_reason(HookEventName::PreToolUse, Some("内容非法")),
            "检测到非预期行为：内容非法，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
        );
        assert_eq!(
            wrap_host_reason(HookEventName::PostToolUse, Some("内容非法")),
            "检测到非预期行为：内容非法，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
        );
    }

    #[test]
    fn omits_the_detail_slot_when_interceptor_reason_is_missing() {
        assert_eq!(
            wrap_host_reason(HookEventName::UserPromptSubmit, None),
            "检测到敏感信息，本轮对话终止"
        );
        assert_eq!(
            wrap_host_reason(HookEventName::PreToolUse, Some("  ")),
            "检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
        );
        assert_eq!(
            wrap_host_reason(HookEventName::PostToolUse, None),
            "检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
        );
    }
}
