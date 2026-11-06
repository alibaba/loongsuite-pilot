//! In-process alarm aggregation. `serialize` drains the map.

use crate::utils::create_logger;
use indexmap::IndexMap;
use std::sync::Mutex;

pub struct AlarmContext {
    pub input_name: Option<String>,
    pub endpoint_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AlarmEntry {
    pub alarm_type: String,
    pub alarm_level: String,
    pub alarm_message: String,
    pub alarm_count: String,
    pub user_id: String,
    pub ip: String,
    pub ver: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_name: Option<String>,
    #[serde(rename = "__time__")]
    pub time: i64,
}

struct AlarmItem {
    alarm_type: String,
    level: String,
    message: String,
    count: u64,
    context: Option<AlarmContext>,
}

pub struct AlarmManager {
    alarms: Mutex<IndexMap<String, AlarmItem>>,
    ip: String,
    version: String,
    user_id: String,
    now_ms: Mutex<Option<i64>>,
}

impl AlarmManager {
    pub fn new(
        ip: impl Into<String>,
        version: impl Into<String>,
        user_id: impl Into<String>,
    ) -> Self {
        let _ = create_logger("AlarmManager");
        Self {
            alarms: Mutex::new(IndexMap::new()),
            ip: ip.into(),
            version: version.into(),
            user_id: user_id.into(),
            now_ms: Mutex::new(None),
        }
    }

    pub fn set_now_ms_for_test(&self, now_ms: i64) {
        *self.now_ms.lock().expect("alarm clock") = Some(now_ms);
    }

    pub fn record(
        &self,
        alarm_type: &str,
        level: &str,
        message: &str,
        context: Option<AlarmContext>,
    ) {
        let key = format!(
            "{}_{}_{}",
            alarm_type,
            context
                .as_ref()
                .and_then(|ctx| ctx.input_name.as_deref())
                .unwrap_or(""),
            context
                .as_ref()
                .and_then(|ctx| ctx.endpoint_name.as_deref())
                .unwrap_or("")
        );
        let mut alarms = self.alarms.lock().expect("alarms");
        if let Some(existing) = alarms.get_mut(&key) {
            existing.count += 1;
            existing.message = message.to_string();
            return;
        }
        alarms.insert(
            key,
            AlarmItem {
                alarm_type: alarm_type.to_string(),
                level: level.to_string(),
                message: message.to_string(),
                count: 1,
                context,
            },
        );
    }

    pub fn serialize(&self) -> Vec<AlarmEntry> {
        let mut alarms = self.alarms.lock().expect("alarms");
        if alarms.is_empty() {
            return Vec::new();
        }
        let now = self
            .now_ms
            .lock()
            .expect("alarm clock")
            .unwrap_or_else(now_secs);
        let mut entries = Vec::new();
        for item in alarms.values() {
            if item.count == 0 {
                continue;
            }
            entries.push(AlarmEntry {
                alarm_type: item.alarm_type.clone(),
                alarm_level: item.level.clone(),
                alarm_message: item.message.clone(),
                alarm_count: item.count.to_string(),
                user_id: self.user_id.clone(),
                ip: self.ip.clone(),
                ver: self.version.clone(),
                input_name: item
                    .context
                    .as_ref()
                    .and_then(|ctx| ctx.input_name.clone())
                    .filter(|value| !value.is_empty()),
                endpoint_name: item
                    .context
                    .as_ref()
                    .and_then(|ctx| ctx.endpoint_name.clone())
                    .filter(|value| !value.is_empty()),
                time: now,
            });
        }
        alarms.clear();
        entries
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> AlarmManager {
        AlarmManager::new("10.0.0.1", "1.0.0", "test-user")
    }

    #[test]
    fn serialize_returns_empty_when_no_alarms_recorded() {
        assert!(manager().serialize().is_empty());
    }

    #[test]
    fn records_and_serializes_a_single_alarm() {
        let manager = manager();
        manager.record("FLUSH_SEND_ALARM", "2", "send failed", None);
        let entries = manager.serialize();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alarm_type, "FLUSH_SEND_ALARM");
        assert_eq!(entries[0].alarm_level, "2");
        assert_eq!(entries[0].alarm_message, "send failed");
        assert_eq!(entries[0].alarm_count, "1");
        assert_eq!(entries[0].user_id, "test-user");
        assert_eq!(entries[0].ip, "10.0.0.1");
        assert_eq!(entries[0].ver, "1.0.0");
        assert!(entries[0].time > 0);
    }

    #[test]
    fn aggregates_count_for_the_same_alarm_type_and_context() {
        let manager = manager();
        let ctx = || {
            Some(AlarmContext {
                input_name: Some("cursor-hook".into()),
                endpoint_name: None,
            })
        };
        manager.record("INPUT_STOP_ALARM", "3", "timeout", ctx());
        manager.record("INPUT_STOP_ALARM", "3", "timeout 2", ctx());
        manager.record("INPUT_STOP_ALARM", "3", "timeout 3", ctx());
        let entries = manager.serialize();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alarm_count, "3");
        assert_eq!(entries[0].alarm_message, "timeout 3");
        assert_eq!(entries[0].input_name.as_deref(), Some("cursor-hook"));
    }

    #[test]
    fn distinguishes_alarms_by_context_and_clears_after_serialize() {
        let manager = manager();
        manager.record(
            "FLUSH_SEND_ALARM",
            "2",
            "fail A",
            Some(AlarmContext {
                input_name: None,
                endpoint_name: Some("ep1".into()),
            }),
        );
        manager.record(
            "FLUSH_SEND_ALARM",
            "2",
            "fail B",
            Some(AlarmContext {
                input_name: None,
                endpoint_name: Some("ep2".into()),
            }),
        );
        let entries = manager.serialize();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].endpoint_name.as_deref(), Some("ep1"));
        assert_eq!(entries[1].endpoint_name.as_deref(), Some("ep2"));
        manager.record("HOOK_INSTALL_ALARM", "2", "install failed", None);
        manager.serialize();
        assert!(manager.serialize().is_empty());
    }
}
