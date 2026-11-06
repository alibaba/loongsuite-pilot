//! Port of `src/pi-sdk/pi-sdk-agent-identity.ts`.

use crate::types::ClientType;

const RESERVED_EXTRA: &[&str] = &["hermes-agent", "qoder-jetbrains"];

pub fn is_valid_pi_sdk_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    let rest: String = chars.collect();
    if rest.is_empty() {
        return true;
    }
    let last = id.chars().last().unwrap();
    if !last.is_ascii_lowercase() && !last.is_ascii_digit() {
        return false;
    }
    let middle_len = id.chars().count();
    if middle_len > 64 {
        return false;
    }
    id.chars()
        .skip(1)
        .take(id.chars().count().saturating_sub(2))
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

pub fn is_reserved_pi_sdk_agent_id(id: &str) -> bool {
    ClientType::ALL.iter().any(|client| client.as_str() == id) || RESERVED_EXTRA.contains(&id)
}

pub fn validate_pi_sdk_agent_id(raw: &str) -> Result<String, String> {
    let id = raw.trim().to_lowercase();
    if !is_valid_pi_sdk_agent_id(&id) {
        return Err(
            "agent id must be 1-64 lowercase letters, digits, dots, underscores, or hyphens".into(),
        );
    }
    if is_reserved_pi_sdk_agent_id(&id) {
        return Err(format!(
            "agent id is reserved by the built-in integration: {id}"
        ));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shape_and_reserved_ids() {
        assert_eq!(
            validate_pi_sdk_agent_id(" Acme-Code ").unwrap(),
            "acme-code"
        );
        assert!(validate_pi_sdk_agent_id("").is_err());
        assert!(validate_pi_sdk_agent_id("-bad").is_err());
        assert!(validate_pi_sdk_agent_id("bad-").is_err());
        assert!(validate_pi_sdk_agent_id("claude-code")
            .unwrap_err()
            .contains("reserved"));
        assert!(is_reserved_pi_sdk_agent_id("hermes-agent"));
        assert!(is_reserved_pi_sdk_agent_id("qoder-jetbrains"));
    }
}
