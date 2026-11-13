/// Collector agent type → product system. Unmapped types resolve to `unknown`.
pub const AGENT_SYSTEM_MAP: &[(&str, &str)] = &[
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("codex-session", "codex"),
    ("copilot", "copilot"),
    ("qoder", "qoder"),
    ("qoder-cn", "qoder"),
    ("qoder-idea", "qoder"),
    ("qoder-work", "qoder"),
    ("qoder-work-cn", "qoder"),
    ("qwen-work-cn", "qwen"),
    ("qoder-cli", "qoder"),
    ("qoder-app", "qoder-app"),
    ("qoder-cli-hook", "qoder"),
    ("cursor", "cursor"),
    ("cursor-cli", "cursor"),
    ("cursor-hook", "cursor"),
    ("kiro-cli", "kiro"),
    ("qwen-code-cli", "qwen-code"),
    ("opencode", "opencode"),
    ("openclaw", "openclaw"),
    ("mimo-code", "mimo-code"),
    ("pi-coding-agent", "pi"),
    ("grok-build", "grok"),
    ("hermes", "hermes"),
    ("wukong", "wukong"),
    ("workbuddy", "workbuddy"),
    ("doubao-work", "doubao"),
    ("dsh", "dsh"),
];

pub fn resolve_agent_system(agent_type: &str) -> &'static str {
    AGENT_SYSTEM_MAP
        .iter()
        .find(|(key, _)| *key == agent_type)
        .map(|(_, system)| *system)
        .unwrap_or("unknown")
}

#[cfg(test)]
fn agent_system_defined(agent_type: &str) -> bool {
    AGENT_SYSTEM_MAP.iter().any(|(key, _)| *key == agent_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_code_to_claude() {
        assert_eq!(resolve_agent_system("claude-code"), "claude");
    }

    #[test]
    fn maps_codex_variants_to_codex() {
        assert_eq!(resolve_agent_system("codex"), "codex");
        assert_eq!(resolve_agent_system("codex-session"), "codex");
    }

    #[test]
    fn maps_qoder_variants_to_qoder() {
        assert_eq!(resolve_agent_system("qoder"), "qoder");
        assert_eq!(resolve_agent_system("qoder-idea"), "qoder");
        assert_eq!(resolve_agent_system("qoder-work"), "qoder");
        assert_eq!(resolve_agent_system("qoder-work-cn"), "qoder");
        assert_eq!(resolve_agent_system("qoder-cli"), "qoder");
        assert_eq!(resolve_agent_system("qoder-app"), "qoder-app");
        assert_eq!(resolve_agent_system("qoder-cli-hook"), "qoder");
    }

    #[test]
    fn maps_cursor_variants_to_cursor() {
        assert_eq!(resolve_agent_system("cursor"), "cursor");
        assert_eq!(resolve_agent_system("cursor-hook"), "cursor");
    }

    #[test]
    fn maps_grok_build_to_grok() {
        assert_eq!(resolve_agent_system("grok-build"), "grok");
    }

    #[test]
    fn maps_qwen_variants() {
        assert_eq!(resolve_agent_system("qwen-code-cli"), "qwen-code");
        assert_eq!(resolve_agent_system("qwen-work-cn"), "qwen");
    }

    #[test]
    fn maps_mimo_code_to_mimo_code() {
        assert_eq!(resolve_agent_system("mimo-code"), "mimo-code");
    }

    #[test]
    fn maps_pi_coding_agent_to_pi() {
        assert_eq!(resolve_agent_system("pi-coding-agent"), "pi");
    }

    #[test]
    fn maps_workbuddy_to_workbuddy() {
        assert_eq!(resolve_agent_system("workbuddy"), "workbuddy");
    }

    #[test]
    fn maps_doubao_work_to_doubao() {
        assert_eq!(resolve_agent_system("doubao-work"), "doubao");
        let client: crate::types::ClientType = "doubao-work".parse().unwrap();
        assert_eq!(client, crate::types::ClientType::DoubaoWork);
        assert_eq!(client.as_str(), "doubao-work");
        assert_eq!(serde_json::to_value(client).unwrap(), "doubao-work");
        assert_eq!(
            serde_json::from_str::<crate::types::ClientType>("\"doubao-work\"").unwrap(),
            client
        );
        assert!(crate::types::ClientType::ALL.contains(&client));
    }

    #[test]
    fn maps_dsh_to_dsh() {
        assert_eq!(resolve_agent_system("dsh"), "dsh");
    }

    #[test]
    fn maps_hermes_to_hermes() {
        assert_eq!(resolve_agent_system("hermes"), "hermes");
    }

    #[test]
    fn returns_unknown_for_unmapped_types() {
        assert_eq!(resolve_agent_system("some-future-agent"), "unknown");
        assert_eq!(resolve_agent_system(""), "unknown");
    }

    #[test]
    fn has_entries_for_all_expected_agent_types() {
        let expected_keys = [
            "claude-code",
            "codex",
            "codex-session",
            "qoder",
            "qoder-idea",
            "qoder-work",
            "qoder-work-cn",
            "qoder-cli",
            "qoder-cli-hook",
            "cursor",
            "cursor-hook",
            "grok-build",
            "qwen-code-cli",
            "qwen-work-cn",
            "mimo-code",
            "pi-coding-agent",
            "workbuddy",
            "doubao-work",
            "hermes",
            "dsh",
        ];
        for key in expected_keys {
            assert!(
                agent_system_defined(key),
                "{key} missing from AGENT_SYSTEM_MAP"
            );
        }
    }

    #[test]
    fn main549_supported_types_use_the_original_system_aliases() {
        for (agent_type, system) in [
            ("openclaw", "openclaw"),
            ("copilot", "copilot"),
            ("cursor-cli", "cursor"),
            ("kiro-cli", "kiro"),
            ("qoder-cn", "qoder"),
        ] {
            assert_eq!(resolve_agent_system(agent_type), system, "{agent_type}");
        }
    }

    #[test]
    fn main549_every_bundled_agent_and_runtime_only_wukong_has_a_system() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("agents.d");
        let mut emitted_types = std::fs::read_dir(directory)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .map(|entry| {
                let definition: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
                match definition["id"].as_str().unwrap() {
                    "hermes-agent" => "hermes".to_owned(),
                    "qoder-jetbrains" => "qoder-idea".to_owned(),
                    agent_type => agent_type.to_owned(),
                }
            })
            .collect::<Vec<_>>();
        assert!(
            !emitted_types.is_empty(),
            "bundled Agent definitions must be present"
        );
        emitted_types.push("wukong".to_owned());
        for agent_type in emitted_types {
            assert_ne!(
                resolve_agent_system(&agent_type),
                "unknown",
                "Missing system mapping for {agent_type}"
            );
        }
    }
}
