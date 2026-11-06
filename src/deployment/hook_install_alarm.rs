//! Dedup key for one HOOK_INSTALL_ALARM per identity and timestamp.

use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookInstallAlarmAgent {
    pub id: Option<String>,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookInstallAlarmReport {
    pub identity: String,
    pub ts: String,
    pub alarm_sent: Option<bool>,
    pub agents: Vec<HookInstallAlarmAgent>,
}

pub fn hook_install_alarm_key(identity: &str, ts: &str) -> String {
    format!("{identity}\0{ts}")
}

/// True when this result still needs one HOOK_INSTALL_ALARM for its identity+ts.
pub fn should_relay_hook_install_alarm(
    report: Option<&HookInstallAlarmReport>,
    sent_keys: &HashSet<String>,
) -> bool {
    let Some(report) = report else {
        return false;
    };
    if report.alarm_sent == Some(true) {
        return false;
    }
    if !report.agents.iter().any(|agent| agent.status == "failed") {
        return false;
    }
    !sent_keys.contains(&hook_install_alarm_key(&report.identity, &report.ts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed_report(sent: Option<bool>) -> HookInstallAlarmReport {
        HookInstallAlarmReport {
            identity: "id".into(),
            ts: "ts".into(),
            alarm_sent: sent,
            agents: vec![HookInstallAlarmAgent {
                id: Some("codex".into()),
                status: "failed".into(),
                reason: Some("deploy-failed".into()),
            }],
        }
    }

    #[test]
    fn relays_once_per_identity_and_timestamp() {
        let mut sent = HashSet::new();
        assert!(!should_relay_hook_install_alarm(None, &sent));
        assert!(!should_relay_hook_install_alarm(
            Some(&failed_report(Some(true))),
            &sent
        ));
        assert!(should_relay_hook_install_alarm(
            Some(&failed_report(None)),
            &sent
        ));
        sent.insert(hook_install_alarm_key("id", "ts"));
        assert!(!should_relay_hook_install_alarm(
            Some(&failed_report(None)),
            &sent
        ));
        let mut successful = failed_report(Some(false));
        successful.agents[0].status = "ok".into();
        assert!(!should_relay_hook_install_alarm(
            Some(&successful),
            &HashSet::new()
        ));
        let mut later = failed_report(Some(false));
        later.ts = "later-timestamp".into();
        assert!(should_relay_hook_install_alarm(Some(&later), &sent));
    }
}
