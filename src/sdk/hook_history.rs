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
    agent: "openclaw",
    listener: "openclaw-plugin-log",
    profile: "openclaw_plugin_v1",
    history: "logs/openclaw",
    build: |options| {
        crate::inputs::openclaw_plugin::OpenClawPluginInput::new(
            crate::inputs::openclaw_plugin::OpenClawPluginInputOptions {
                state_store: options.state_store,
                log_dir: options.log_dir,
                log_prefix: options.log_prefix,
                poll_interval_ms: options.poll_interval_ms,
                data_dir: None,
            },
        )
        .sdk_hosted()
    },
}];

pub(crate) fn find(agent: &str) -> Option<&'static HookHistoryProfile> {
    PROFILES.iter().find(|profile| profile.agent == agent)
}
