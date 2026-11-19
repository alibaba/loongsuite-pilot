//! Existing host plug-in history formats that can run under the SDK.
use crate::inputs::base::HostedInput;
use crate::inputs::rest_support::{HookInputOptions, SdkHookBody};
use std::sync::Arc;

pub(crate) struct HookHistoryProfile {
    pub agent: &'static str,
    pub listener: &'static str,
    pub profile: &'static str,
    pub history: &'static str,
    pub build: fn(HookInputOptions) -> Arc<HostedInput<SdkHookBody>>,
}

pub(crate) const PROFILES: &[HookHistoryProfile] = &[HookHistoryProfile {
    agent: "cursor",
    listener: "cursor-hook",
    profile: "cursor_hook_v1",
    history: "logs/cursor/history",
    build: |options| crate::inputs::cursor_hook::CursorHookInput::new(options).sdk_hosted(),
}];

pub(crate) fn find(agent: &str) -> Option<&'static HookHistoryProfile> {
    PROFILES.iter().find(|profile| profile.agent == agent)
}
