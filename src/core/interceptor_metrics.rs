use crate::interceptor::status::{unavailable, HookActivity, DIAGNOSTIC_CODES};
use crate::metrics::{AlarmContext, AlarmManager};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const COOLDOWN: Duration = Duration::from_secs(600);

#[derive(Default)]
pub(super) struct InterceptorMetrics {
    instances: Mutex<BTreeMap<&'static str, (Value, u64)>>,
    windows: Mutex<[Option<(Instant, u64)>; 6]>,
}

impl InterceptorMetrics {
    pub(super) fn observe(&self, id: &'static str, status: Value) {
        if !status.is_object() {
            return;
        }
        let mut instances = self.instances.lock().unwrap();
        let (previous, restarts) = instances.entry(id).or_insert((Value::Null, 0));
        if previous["worker_started_at"].is_string()
            && status["worker_started_at"].is_string()
            && previous["worker_started_at"] != status["worker_started_at"]
        {
            *restarts += 1;
        }
        *previous = status;
    }

    pub(super) fn snapshot(&self, enabled: bool) -> Value {
        let mut status = unavailable(enabled);
        let instances = self.instances.lock().unwrap();
        let mut activity = HookActivity::default();
        let mut has_activity = false;
        let mut details = serde_json::Map::new();
        let mut diagnostics = [0_u64; 6];
        let mut builtin = 0;
        for (id, (worker, restarts)) in instances.iter().filter(|(_, (w, _))| w["enabled"] == true)
        {
            status["enabled"] = json!(true);
            let was_running = status["running"] == true;
            if worker["collection_status"] == "ok" {
                status["collection_status"] = json!("ok");
            }
            if worker["running"] == true {
                status["running"] = json!(true);
            }
            if worker["sampled_at"].as_str() > status["sampled_at"].as_str() {
                status["sampled_at"] = worker["sampled_at"].clone();
            }
            if status["worker_started_at"].is_null() || (!was_running && worker["running"] == true)
            {
                status["worker_started_at"] = worker["worker_started_at"].clone();
            }
            status["worker_restarts_total"] =
                json!(status["worker_restarts_total"].as_u64().unwrap_or_default() + restarts);
            if let Ok(instance) =
                serde_json::from_value::<HookActivity>(worker["activity_totals"].clone())
            {
                activity.merge(&instance);
                has_activity = true;
            }
            for (total, code) in diagnostics.iter_mut().zip(DIAGNOSTIC_CODES) {
                *total += worker["diagnostics"][code].as_u64().unwrap_or_default();
            }
            builtin = builtin.max(worker["rules"]["builtin"].as_u64().unwrap_or_default());
            if status["rules"].is_null() || worker["rules"]["configured"].is_number() {
                status["rules"] = worker["rules"].clone();
            }
            let mut detail = worker.clone();
            detail.as_object_mut().unwrap().remove("activity_totals");
            detail["worker_restarts_total"] = json!(restarts);
            details.insert((*id).into(), detail);
        }
        if !details.is_empty() {
            status["rules"]["builtin"] = json!(builtin);
            status["diagnostics"] = json!(DIAGNOSTIC_CODES
                .into_iter()
                .zip(diagnostics)
                .collect::<BTreeMap<_, _>>());
            status["instances"] = Value::Object(details);
        }
        if has_activity {
            status["activity"] = activity.snapshot();
        }
        status
    }

    pub(super) fn fault(&self, alarm: &AlarmManager, index: usize, payload: &Value) {
        let suppressed = {
            let mut windows = self.windows.lock().unwrap();
            let previous = &mut windows[index];
            let suppressed = match previous {
                Some((since, count)) if since.elapsed() < COOLDOWN => {
                    *count = count.saturating_add(1);
                    return;
                }
                Some((_, count)) => *count,
                None => 0,
            };
            *previous = Some((Instant::now(), 0));
            suppressed
        };
        alarm.record_count(
            if index < 3 {
                "MANAGED_CONFIG_ALARM"
            } else {
                "INTERCEPTOR_REGEX_ALARM"
            },
            "2",
            &payload.to_string(),
            Some(AlarmContext {
                input_name: Some("interceptor".into()),
                endpoint_name: Some(DIAGNOSTIC_CODES[index].into()),
            }),
            suppressed.saturating_add(1),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_faults_aggregate_across_workers_without_resetting_cooldown() {
        let alarm = AlarmManager::new("127.0.0.1", "test", "test");
        let monitor = InterceptorMetrics::default();
        let diagnostic = json!({"reason":"invalid_cached_config"});
        monitor.fault(&alarm, 0, &diagnostic);
        assert_eq!(alarm.serialize()[0].alarm_count, "1");
        monitor.fault(&alarm, 0, &diagnostic);
        monitor.fault(&alarm, 0, &diagnostic);
        assert!(alarm.serialize().is_empty());
        let (_, count) = monitor.windows.lock().unwrap()[0].unwrap();
        monitor.windows.lock().unwrap()[0] = Some((Instant::now() - COOLDOWN, count));
        monitor.fault(&alarm, 0, &diagnostic);
        let rows = alarm.serialize();
        assert_eq!(rows[0].alarm_count, "3");
        assert_eq!(rows[0].endpoint_name.as_deref(), Some("config_rejected"));
    }
}
