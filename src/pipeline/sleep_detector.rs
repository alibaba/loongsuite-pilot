//! Detects system sleep by watching the wall clock jump past the tick interval.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::create_logger;
use serde_json::{json, Map, Value};

const CHECK_INTERVAL_MS: u64 = 5_000;
const SLEEP_THRESHOLD_MS: i64 = 15_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WakeEvent {
    pub sleep_duration_ms: i64,
}

type WakeHandler = Arc<dyn Fn(WakeEvent) + Send + Sync>;

fn logger() -> crate::utils::BoundLogger {
    create_logger("SleepDetector")
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct SleepDetector {
    last_tick_ms: Arc<Mutex<i64>>,
    listeners: Arc<Mutex<Vec<WakeHandler>>>,
    running: Mutex<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for SleepDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl SleepDetector {
    pub fn new() -> Self {
        Self {
            last_tick_ms: Arc::new(Mutex::new(0)),
            listeners: Arc::new(Mutex::new(Vec::new())),
            running: Mutex::new(false),
            task: Mutex::new(None),
            now: Arc::new(wall_ms),
        }
    }

    pub fn on_wake(&self, handler: WakeHandler) {
        self.listeners.lock().unwrap().push(handler);
    }

    pub fn listener_count(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }

    pub fn start(&self) {
        let mut running = self.running.lock().unwrap();
        if *running {
            return;
        }
        *running = true;
        *self.last_tick_ms.lock().unwrap() = (self.now)();
        // 后台采样与动态订阅共享同一状态，stop 通过 JoinHandle 取消任务。
        let now = Arc::clone(&self.now);
        let listeners_for_task = Arc::clone(&self.listeners);
        let last_for_task = Arc::clone(&self.last_tick_ms);
        let task = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(CHECK_INTERVAL_MS));
            interval.tick().await;
            loop {
                interval.tick().await;
                tick(
                    last_for_task.as_ref(),
                    listeners_for_task.as_ref(),
                    now.as_ref(),
                );
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    pub fn stop(&self) {
        *self.running.lock().unwrap() = false;
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.listeners.lock().unwrap().clear();
    }

    /// One clock sample. Tests drive this directly instead of fake timers.
    pub fn tick_at(&self, now_ms: i64) {
        if !*self.running.lock().unwrap()
            && self.listener_count() == 0
            && *self.last_tick_ms.lock().unwrap() == 0
        {
            return;
        }
        let mut last = self.last_tick_ms.lock().unwrap();
        if *last == 0 && !*self.running.lock().unwrap() {
            return;
        }
        let elapsed = now_ms - *last;
        *last = now_ms;
        if elapsed > SLEEP_THRESHOLD_MS {
            let sleep_duration_ms = elapsed - CHECK_INTERVAL_MS as i64;
            let mut meta = Map::new();
            meta.insert("elapsedMs".into(), json!(elapsed));
            meta.insert("estimatedSleepMs".into(), json!(sleep_duration_ms));
            logger().info("system wake detected", Some(&meta));
            let event = WakeEvent { sleep_duration_ms };
            for handler in self.listeners.lock().unwrap().iter() {
                handler(event);
            }
        }
    }

    pub fn start_manual(&self, now_ms: i64) {
        *self.running.lock().unwrap() = true;
        *self.last_tick_ms.lock().unwrap() = now_ms;
    }
}

fn tick(
    last: &Mutex<i64>,
    listeners: &Mutex<Vec<WakeHandler>>,
    now: &(dyn Fn() -> i64 + Send + Sync),
) {
    let now_ms = now();
    let mut last = last.lock().unwrap();
    let elapsed = now_ms - *last;
    *last = now_ms;
    if elapsed > SLEEP_THRESHOLD_MS {
        let sleep_duration_ms = elapsed - CHECK_INTERVAL_MS as i64;
        let mut meta: Map<String, Value> = Map::new();
        meta.insert("elapsedMs".into(), json!(elapsed));
        meta.insert("estimatedSleepMs".into(), json!(sleep_duration_ms));
        logger().info("system wake detected", Some(&meta));
        let event = WakeEvent { sleep_duration_ms };
        for handler in listeners.lock().unwrap().iter() {
            handler(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_wake_when_gap_exceeds_threshold() {
        let detector = SleepDetector::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        detector.on_wake(Arc::new(move |event| {
            seen.lock().unwrap().push(event.sleep_duration_ms)
        }));
        detector.start_manual(0);
        detector.tick_at(5_000);
        assert!(events.lock().unwrap().is_empty());
        detector.tick_at(70_000);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0] >= 50_000);
    }

    #[test]
    fn does_not_emit_during_normal_ticks() {
        let detector = SleepDetector::new();
        let events = Arc::new(Mutex::new(0u32));
        let seen = Arc::clone(&events);
        detector.on_wake(Arc::new(move |_| *seen.lock().unwrap() += 1));
        detector.start_manual(0);
        for step in 1..=10 {
            detector.tick_at(step * 5_000);
        }
        assert_eq!(*events.lock().unwrap(), 0);
    }

    #[test]
    fn stop_clears_listeners() {
        let detector = SleepDetector::new();
        let events = Arc::new(Mutex::new(0u32));
        let seen = Arc::clone(&events);
        detector.on_wake(Arc::new(move |_| *seen.lock().unwrap() += 1));
        detector.start_manual(0);
        detector.stop();
        detector.tick_at(120_000);
        assert_eq!(*events.lock().unwrap(), 0);
        assert_eq!(detector.listener_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn background_sampling_shares_late_subscriptions_and_stops() {
        use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
        let now = Arc::new(AtomicI64::new(1));
        let clock = Arc::clone(&now);
        let mut detector = SleepDetector::new();
        detector.now = Arc::new(move || clock.load(Ordering::SeqCst));
        detector.start();
        detector.start();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        detector.on_wake(Arc::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(detector.listener_count(), 1);
        tokio::task::yield_now().await;
        now.store(70_000, Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_millis(CHECK_INTERVAL_MS)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(*detector.last_tick_ms.lock().unwrap(), 70_000);
        detector.stop();
        assert_eq!(detector.listener_count(), 0);
        now.store(140_000, Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_millis(CHECK_INTERVAL_MS)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn start_is_idempotent() {
        let detector = SleepDetector::new();
        detector.start_manual(0);
        detector.start_manual(0);
        detector.stop();
    }
}
