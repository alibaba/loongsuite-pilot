//! Loose WorkBuddy transcript and hook shapes from `workbuddy-types.ts`.

use serde_json::Value;

/// One JSONL transcript object. Fields are open; the builder reads them by name.
pub type WorkBuddyRecord = serde_json::Map<String, Value>;

/// Structural hook fact used when the transcript omits a tool id or timestamp.
#[derive(Clone, Debug)]
pub struct WorkBuddyHookEvent {
    pub event_name: String,
    pub observed_at_ms: f64,
    pub session_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
}

/// Arguments for [`super::build_work_buddy_events`].
#[derive(Clone, Debug)]
pub struct WorkBuddyBuildOptions {
    pub session_id: String,
    pub hook_events: Vec<WorkBuddyHookEvent>,
}

impl WorkBuddyBuildOptions {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            hook_events: Vec::new(),
        }
    }
}
