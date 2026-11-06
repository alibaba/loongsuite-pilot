//! Official Agent home-directory overrides used as `$NAME` placeholders.

use std::collections::HashMap;

pub const DEFAULT_PI_CODING_AGENT_DIR: &str = "~/.pi/agent";
pub const DEFAULT_GROK_HOME: &str = "~/.grok";
pub const DEFAULT_DSH_HOME: &str = "~/.dsh";

fn env_dir(name: &str, fallback: &str, env: Option<&HashMap<String, String>>) -> String {
    let raw = match env {
        Some(map) => map.get(name).cloned().unwrap_or_default(),
        None => std::env::var(name).unwrap_or_default(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_pi_coding_agent_dir(env: Option<&HashMap<String, String>>) -> String {
    env_dir("PI_CODING_AGENT_DIR", DEFAULT_PI_CODING_AGENT_DIR, env)
}

pub fn resolve_grok_home(env: Option<&HashMap<String, String>>) -> String {
    env_dir("GROK_HOME", DEFAULT_GROK_HOME, env)
}

pub fn resolve_dsh_home(env: Option<&HashMap<String, String>>) -> String {
    env_dir("DSH_HOME", DEFAULT_DSH_HOME, env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_override_falls_back_to_the_documented_default() {
        let mut env = HashMap::new();
        env.insert("PI_CODING_AGENT_DIR".into(), "  ".into());
        env.insert("GROK_HOME".into(), "".into());
        env.insert("DSH_HOME".into(), "\t".into());
        assert_eq!(
            resolve_pi_coding_agent_dir(Some(&env)),
            DEFAULT_PI_CODING_AGENT_DIR
        );
        assert_eq!(resolve_grok_home(Some(&env)), DEFAULT_GROK_HOME);
        assert_eq!(resolve_dsh_home(Some(&env)), DEFAULT_DSH_HOME);
    }

    #[test]
    fn set_override_is_used_verbatim() {
        let mut env = HashMap::new();
        env.insert("PI_CODING_AGENT_DIR".into(), "/custom/pi".into());
        env.insert("GROK_HOME".into(), "/custom/grok".into());
        env.insert("DSH_HOME".into(), "/custom/dsh".into());
        assert_eq!(resolve_pi_coding_agent_dir(Some(&env)), "/custom/pi");
        assert_eq!(resolve_grok_home(Some(&env)), "/custom/grok");
        assert_eq!(resolve_dsh_home(Some(&env)), "/custom/dsh");
    }
}
