//! Alarm and statistic fan-out.
//!
//! The default build records nothing on the network. `send_alarm`, `send_status`,
//! `send_running_status`, and `post_alarm` return immediately. The `proprietary`
//! feature enables running-status samples and configured internal alarm/status
//! delivery. Missing private configuration keeps alarm/status delivery disabled.

use indexmap::IndexMap;
#[cfg(test)]
use std::cell::RefCell;

#[cfg(test)]
#[derive(Clone, Debug)]
pub struct RecordedSend {
    pub kind: &'static str,
    pub topic: String,
    pub fields: IndexMap<String, String>,
}

// 当前线程 Tokio 测试各自拥有记录与故障注入，禁止并发测试互相清空。
#[cfg(test)]
thread_local! {
    static RECORDED: RefCell<Vec<RecordedSend>> = const { RefCell::new(Vec::new()) };
    static INJECTED_ERROR: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub fn clear_sends() {
    RECORDED.with_borrow_mut(Vec::clear);
    INJECTED_ERROR.with_borrow_mut(|error| *error = None);
}

#[cfg(test)]
pub fn recorded_sends() -> Vec<RecordedSend> {
    RECORDED.with_borrow(Clone::clone)
}

#[cfg(test)]
pub fn inject_send_error(topic: &str, message: &str) {
    INJECTED_ERROR.with_borrow_mut(|error| *error = Some((topic.to_string(), message.to_string())));
}

#[cfg(test)]
pub fn injected_error(topic: &str) -> Option<String> {
    INJECTED_ERROR.with_borrow(|error| {
        error
            .as_ref()
            .and_then(|(needle, message)| (needle == topic).then(|| message.clone()))
    })
}

#[cfg(test)]
fn record(kind: &'static str, topic: &str, data: &IndexMap<String, String>) {
    RECORDED.with_borrow_mut(|sends| {
        sends.push(RecordedSend {
            kind,
            topic: topic.to_string(),
            fields: data.clone(),
        })
    });
}

pub fn send_alarm(topic: &str, data: &IndexMap<String, String>) {
    #[cfg(test)]
    record("alarm", topic, data);
    #[cfg(not(test))]
    crate::internal::alarm_sender::send_alarm(topic, data);
    #[cfg(test)]
    {
        let _ = (topic, data);
    }
}

pub fn send_status(topic: &str, data: &IndexMap<String, String>) {
    #[cfg(test)]
    record("status", topic, data);
    #[cfg(not(test))]
    crate::internal::alarm_sender::send_status(topic, data);
    #[cfg(test)]
    {
        let _ = (topic, data);
    }
}

pub fn send_running_status(data: &IndexMap<String, String>) {
    #[cfg(test)]
    record("running", "", data);
    #[cfg(all(feature = "proprietary", not(test)))]
    crate::internal::statistic::send_running_status(data);
    #[cfg(any(not(feature = "proprietary"), test))]
    {
        let _ = data;
    }
}

pub async fn post_alarm(topic: &str, data: &IndexMap<String, String>, timeout_ms: u64) -> bool {
    #[cfg(test)]
    record("post-alarm", topic, data);
    #[cfg(not(test))]
    {
        return crate::internal::alarm_sender::post_alarm(topic, data, timeout_ms).await;
    }
    #[cfg(test)]
    {
        let _ = (topic, data, timeout_ms);
        false
    }
}
