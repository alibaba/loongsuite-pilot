//! PI SDK agent id rules used while loading local definitions.
//!
//! The registry itself lives in `src/pi-sdk` and is not part of this port.
//! Validation here matches `pi-sdk-agent-identity.ts` so definition loading
//! rejects the same ids.

use crate::types::ClientType;

fn reserved_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = ClientType::ALL.iter().map(|value| value.as_str()).collect();
    ids.push("hermes-agent");
    ids.push("qoder-jetbrains");
    ids
}

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
    let bytes = id.as_bytes();
    if bytes.len() > 64 {
        return false;
    }
    let last = *bytes.last().unwrap();
    if !last.is_ascii_lowercase() && !last.is_ascii_digit() {
        return false;
    }
    bytes[1..bytes.len() - 1].iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    })
}

pub fn is_reserved_pi_sdk_agent_id(id: &str) -> bool {
    reserved_ids().contains(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_ids_and_rejects_reserved_and_invalid() {
        assert!(is_valid_pi_sdk_agent_id("acme"));
        assert!(is_valid_pi_sdk_agent_id("a"));
        assert!(!is_valid_pi_sdk_agent_id(""));
        assert!(!is_valid_pi_sdk_agent_id("-bad"));
        assert!(!is_valid_pi_sdk_agent_id("Bad"));
        assert!(is_reserved_pi_sdk_agent_id("codex"));
        assert!(is_reserved_pi_sdk_agent_id("hermes-agent"));
        assert!(is_reserved_pi_sdk_agent_id("qoder-jetbrains"));
        assert!(!is_reserved_pi_sdk_agent_id("acme"));
    }
}
