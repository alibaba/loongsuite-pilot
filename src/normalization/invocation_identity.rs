use crate::types::AgentActivityEntry;

/// Internal transport fields written by invocation-scoped hooks and plugins.
///
/// They live under `agent.pilot.*` so raw producer records can carry them
/// without colliding with canonical event fields. Input consumers remove both
/// fields before any output sink sees the entry.
pub const INVOCATION_SESSION_ID_FIELD: &str = "agent.pilot.invocation.session.id";
pub const INVOCATION_USER_ID_FIELD: &str = "agent.pilot.invocation.user.id";

const MAX_INVOCATION_ID_LENGTH: usize = 512;

fn consume_identity_value(entry: &mut AgentActivityEntry, key: &str) -> Option<String> {
    let raw = entry.extra.remove(key)?;
    let text = raw.as_str()?.trim();
    let value = text.to_string();
    if value.is_empty() || value.encode_utf16().count() > MAX_INVOCATION_ID_LENGTH {
        None
    } else {
        Some(value)
    }
}

/// Apply invocation-scoped identity.
///
/// Precedence for the user id: invocation env, then configured user id, then
/// the agent-native id, then the fallback user id. An injected session id
/// replaces the native session id. Native turn and step ids stay intact.
pub fn apply_invocation_identity(
    entry: &mut AgentActivityEntry,
    configured_user_id: &str,
    fallback_user_id: &str,
) {
    let session_id = consume_identity_value(entry, INVOCATION_SESSION_ID_FIELD);
    let user_id = consume_identity_value(entry, INVOCATION_USER_ID_FIELD);

    if let Some(session_id) = session_id {
        entry.session_id = session_id;
    }

    if let Some(user_id) = user_id {
        entry.user_id = user_id;
    } else if !configured_user_id.is_empty() {
        entry.user_id = configured_user_id.to_string();
    } else if entry.user_id.is_empty() && !fallback_user_id.is_empty() {
        entry.user_id = fallback_user_id.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalization::build_test_entry;
    use serde_json::json;

    #[test]
    fn gives_invocation_identity_precedence_and_removes_transport_fields() {
        let mut entry = build_test_entry(&json!({
            "userId": "native-user",
            "sessionId": "native-session"
        }));
        entry.extra.insert(
            INVOCATION_SESSION_ID_FIELD.to_string(),
            json!(" invocation-session "),
        );
        entry.extra.insert(
            INVOCATION_USER_ID_FIELD.to_string(),
            json!(" invocation-user "),
        );

        apply_invocation_identity(&mut entry, "configured-user", "fallback-user");

        assert_eq!(entry.session_id, "invocation-session");
        assert_eq!(entry.user_id, "invocation-user");
        assert!(!entry.extra.contains_key(INVOCATION_SESSION_ID_FIELD));
        assert!(!entry.extra.contains_key(INVOCATION_USER_ID_FIELD));
    }

    #[test]
    fn preserves_configured_native_fallback_user_precedence_without_an_override() {
        let mut configured = build_test_entry(&json!({ "userId": "native-user" }));
        apply_invocation_identity(&mut configured, "configured-user", "fallback-user");
        assert_eq!(configured.user_id, "configured-user");

        let mut native = build_test_entry(&json!({ "userId": "native-user" }));
        apply_invocation_identity(&mut native, "", "fallback-user");
        assert_eq!(native.user_id, "native-user");

        let mut fallback = build_test_entry(&json!({ "userId": "" }));
        apply_invocation_identity(&mut fallback, "", "fallback-user");
        assert_eq!(fallback.user_id, "fallback-user");
    }

    #[test]
    fn ignores_invalid_transport_values_but_always_removes_them() {
        let mut entry = build_test_entry(&json!({
            "userId": "native-user",
            "sessionId": "native-session"
        }));
        entry
            .extra
            .insert(INVOCATION_SESSION_ID_FIELD.to_string(), json!(" "));
        entry
            .extra
            .insert(INVOCATION_USER_ID_FIELD.to_string(), json!("x".repeat(513)));

        apply_invocation_identity(&mut entry, "configured-user", "fallback-user");

        assert_eq!(entry.session_id, "native-session");
        assert_eq!(entry.user_id, "configured-user");
        assert!(!entry.extra.contains_key(INVOCATION_SESSION_ID_FIELD));
        assert!(!entry.extra.contains_key(INVOCATION_USER_ID_FIELD));
    }
}
