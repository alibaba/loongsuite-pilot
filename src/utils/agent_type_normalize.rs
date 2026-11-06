//! Port of `src/utils/agent-type-normalize.ts`.

/// Collapse an agent id to lowercase kebab-case. Empty input becomes `unknown`.
pub fn normalize_agent_type(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut pending_dash = false;
    let mut wrote = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && wrote {
                out.push('-');
            }
            pending_dash = false;
            wrote = true;
            out.push(ch);
        } else if wrote {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_agent_type;

    #[test]
    fn returns_already_normalized_values_unchanged() {
        assert_eq!(normalize_agent_type("claude-code"), "claude-code");
        assert_eq!(normalize_agent_type("qoder-cli"), "qoder-cli");
        assert_eq!(normalize_agent_type("cursor-hook"), "cursor-hook");
    }

    #[test]
    fn lowercases_input() {
        assert_eq!(normalize_agent_type("Claude-Code"), "claude-code");
        assert_eq!(normalize_agent_type("QODER"), "qoder");
    }

    #[test]
    fn collapses_non_alphanumeric_runs_to_single_dash() {
        assert_eq!(normalize_agent_type("Qoder CLI"), "qoder-cli");
        assert_eq!(normalize_agent_type("qoder__work"), "qoder-work");
        assert_eq!(normalize_agent_type("foo@bar#baz"), "foo-bar-baz");
    }

    #[test]
    fn trims_leading_and_trailing_dashes() {
        assert_eq!(normalize_agent_type("--claude-code--"), "claude-code");
        assert_eq!(normalize_agent_type(" cursor "), "cursor");
    }

    #[test]
    fn returns_unknown_for_empty_or_pure_non_alphanumeric_input() {
        assert_eq!(normalize_agent_type(""), "unknown");
        assert_eq!(normalize_agent_type("---"), "unknown");
        assert_eq!(normalize_agent_type("   "), "unknown");
    }
}
