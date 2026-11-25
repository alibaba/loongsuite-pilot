//! Existing host plug-in history formats that can run under the SDK.
use super::outbox::{LegacyCheckpointHandoff, Outbox, ShellCheckpoint};
pub(crate) use super::policy::canonical_candidate as canonical_data_dir;
use super::policy::{Init, Policy};
use crate::checkpoints::{key_in_namespace, StateStore};
use crate::inputs::base::HostedInput;
use crate::inputs::rest_support::{has_usable_hook_log_cursor, HookInputOptions, SdkHookBody};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
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

impl HookHistoryProfile {
    pub(crate) fn sdk_data(&self, data: &Path) -> PathBuf {
        data.join("state")
            .join(format!("standalone-{}-sdk", self.agent))
    }

    pub(crate) fn policy(
        &self,
        data: &Path,
        poll_ms: u64,
        capture: Option<bool>,
        exclude: &[String],
        mask: Option<&crate::types::MaskConfig>,
    ) -> Value {
        let mut policy = json!({
            "agents": [self.agent],
            "hcd": {"agent_configs": {(self.agent): {"collection": {
                "enabled": true, "profile": self.profile,
                "allowed_roots": [data],
                "sources": [{"id": "history", "type": "hook_jsonl", "path": data.join(self.history)}],
                "limits": {"poll_interval_ms": poll_ms},
                "pilot_host": {
                    "data_dir": data,
                    "capture_message_content": capture,
                    "exclude_workspaces": exclude,
                },
            }}}},
        });
        if let Some(mask) = mask {
            policy["sdk_options"] = json!({"mask": mask});
        }
        policy
    }

    pub(crate) fn has_outbox(&self, data: &Path) -> anyhow::Result<bool> {
        let database = self.sdk_data(data).join("outbox/delivery.sqlite");
        crate::utils::source_access::private_path(&database)?;
        match std::fs::symlink_metadata(database) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn can_export_checkpoint(
        &self,
        checkpoint: &StateStore,
        has_progress: bool,
    ) -> anyhow::Result<bool> {
        let usable = has_usable_hook_log_cursor(&checkpoint.get(self.listener));
        anyhow::ensure!(
            usable || !has_progress,
            "SDK checkpoint for {} has no usable Hook log cursor; previous Pilot checkpoint retained",
            self.listener
        );
        Ok(usable)
    }

    /// Before opening a legacy reader, transfer the SQLite cursor only once
    /// the queue has drained. Keep SDK ownership until the caller cuts over.
    pub(crate) async fn export_checkpoint(
        &self,
        data: &Path,
        legacy: &StateStore,
    ) -> anyhow::Result<LegacyHistoryOwnership> {
        let data = canonical_data_dir(data)?;
        if !self.has_outbox(&data)? {
            return Ok(LegacyHistoryOwnership::Ready(None));
        }
        let sdk_data = self.sdk_data(&data);
        let outbox = sdk_data.join("outbox");
        let lock_path = sdk_data.join("collector.lock");
        crate::utils::source_access::private_path(&lock_path)?;
        let lock = OpenOptions::new().read(true).write(true).open(lock_path)?;
        fs2::FileExt::try_lock_exclusive(&lock)?;
        let init = Init {
            data_dir: sdk_data.clone(),
            resource_dir: data.clone(),
            home_dir: None,
            codex_home: None,
            user_id: String::new(),
        };
        // Privacy and polling affect the reader, but are excluded from its
        // namespace. Build the same source plan used at normal startup.
        let policy = self.policy(
            &data,
            crate::utils::DEFAULT_POLL_INTERVAL_MS,
            None,
            &[],
            None,
        );
        let plan = Policy::parse(policy, &init)?;
        let namespace = plan.agents[self.agent].namespace();
        let handoff = LegacyCheckpointHandoff::HookHistory(self.agent);
        match Outbox::checkpoint_for_shell(&outbox, &namespace, handoff)? {
            ShellCheckpoint::Pending => return Ok(LegacyHistoryOwnership::Pending),
            ShellCheckpoint::Exported { has_progress } => {
                legacy
                    .check_for_handoff(
                        has_progress.then_some((self.listener, has_usable_hook_log_cursor)),
                    )
                    .await?;
                return Ok(LegacyHistoryOwnership::Ready(Some(lock)));
            }
            ShellCheckpoint::Ready(text) => {
                if let Some(text) = text {
                    legacy.check_for_handoff(None).await?;
                    let checkpoint = StateStore::new(
                        sdk_data
                            .join("sources")
                            .join(namespace)
                            .join("input-state.json"),
                    );
                    checkpoint.load_checkpoint_text(&text)?;
                    if self.can_export_checkpoint(&checkpoint, text != "{}")? {
                        for id in checkpoint.keys() {
                            if key_in_namespace(&id, self.listener) {
                                legacy.set(&id, checkpoint.get(&id));
                            }
                        }
                        legacy.save().await?;
                    }
                }
            }
        }
        Outbox::mark_shell_checkpoint_exported(&outbox, handoff)?;
        Ok(LegacyHistoryOwnership::Ready(Some(lock)))
    }
}

pub(crate) enum LegacyHistoryOwnership {
    Pending,
    Ready(Option<File>),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoints::InputState;
    use crate::sdk::policy::Delivery;

    #[tokio::test]
    async fn openclaw_handoff_waits_for_ack_and_preserves_newer_legacy_progress() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let profile = find("openclaw").unwrap();
        std::fs::create_dir_all(root.join(profile.history)).unwrap();
        let sdk_data = profile.sdk_data(&root);
        let init = Init {
            data_dir: sdk_data.clone(),
            resource_dir: root.clone(),
            home_dir: None,
            codex_home: None,
            user_id: String::new(),
        };
        let policy = profile.policy(&root, 1234, Some(true), &[], None);
        let namespace = Policy::parse(policy, &init).unwrap().agents["openclaw"].namespace();
        let delivery = Delivery::default();
        let queue = Outbox::open(&sdk_data.join("outbox"), delivery.clone()).unwrap();
        File::create(sdk_data.join("collector.lock")).unwrap();
        let checkpoint =
            r#"{"openclaw-plugin-log":{"lastFile":"openclaw-2026-10-01.jsonl","lastOffset":97}}"#;
        let legacy_cursor = |offset| {
            InputState::new()
                .with_last_file("openclaw-2026-10-01.jsonl")
                .with_last_offset(offset)
        };
        queue.checkpoint(&namespace, checkpoint).unwrap();
        queue
            .enqueue_hook(br#"{"event.id":"pending-openclaw"}"#)
            .unwrap();

        let checkpoint_path = root.join("logs/input-state.json");
        let legacy = StateStore::new(&checkpoint_path);
        legacy.set(profile.listener, legacy_cursor(31.0));
        legacy.set("codex-transcript", InputState::new().with_last_offset(52.0));
        legacy.save().await.unwrap();
        assert!(matches!(
            profile.export_checkpoint(&root, &legacy).await.unwrap(),
            LegacyHistoryOwnership::Pending
        ));
        assert_eq!(legacy.get_offset(profile.listener), 31.0);

        queue.ack(&queue.read_batch(&delivery).unwrap().0).unwrap();
        queue
            .checkpoint(&namespace, r#"{"openclaw-plugin-log":{}}"#)
            .unwrap();
        assert!(profile.export_checkpoint(&root, &legacy).await.is_err());
        assert_eq!(legacy.get_offset(profile.listener), 31.0);
        queue.checkpoint(&namespace, checkpoint).unwrap();
        assert!(matches!(
            profile.export_checkpoint(&root, &legacy).await.unwrap(),
            LegacyHistoryOwnership::Ready(Some(_))
        ));
        assert_eq!(legacy.get_offset(profile.listener), 97.0);
        legacy.set(profile.listener, legacy_cursor(128.0));
        legacy.save().await.unwrap();
        assert!(matches!(
            profile.export_checkpoint(&root, &legacy).await.unwrap(),
            LegacyHistoryOwnership::Ready(Some(_))
        ));
        assert_eq!(legacy.get_offset(profile.listener), 128.0);
        assert_eq!(legacy.get_offset("codex-transcript"), 52.0);

        std::fs::remove_file(checkpoint_path).unwrap();
        assert!(profile.export_checkpoint(&root, &legacy).await.is_err());
    }
}
