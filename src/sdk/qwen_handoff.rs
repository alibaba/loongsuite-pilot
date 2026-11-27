//! Ownership transfer of the two standalone Qwen Work CN collectors.
use super::outbox::{LegacyCheckpointHandoff, Outbox, ShellCheckpoint};
use crate::checkpoints::{key_in_namespace, InputState, StateStore};
use crate::utils::source_access::private_path;
use anyhow::{ensure, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

pub(crate) struct QwenHandoff {
    input: &'static str,
    handoff: LegacyCheckpointHandoff,
    sdk_dir: PathBuf,
}

impl QwenHandoff {
    pub(crate) fn installed(data: &Path) -> Result<Vec<Self>> {
        let mut sources = Vec::new();
        for input in ["qwen-work-cn-trace", "qwen-work-cn-collaboration"] {
            let handoff = LegacyCheckpointHandoff::for_input(input).expect("Qwen input handoff");
            let sdk_dir = handoff.data_dir(data, input);
            let database = sdk_dir.join("outbox/delivery.sqlite");
            private_path(&database)?;
            match fs::symlink_metadata(database) {
                Ok(metadata) => {
                    ensure!(
                        metadata.is_file(),
                        "{input} SDK outbox is not a regular file"
                    );
                    sources.push(Self {
                        input,
                        handoff,
                        sdk_dir,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(sources)
    }

    pub(crate) async fn export_for_rollback(
        sources: Vec<Self>,
        legacy: &StateStore,
    ) -> Result<Vec<File>> {
        if sources.is_empty() {
            return Ok(Vec::new());
        }
        let mut locks = Vec::with_capacity(sources.len());
        let mut export = Vec::new();
        let mut cursors = Vec::new();
        legacy.check_for_handoff(None).await?;
        // Check both independent outboxes before changing the common cursor
        // file. Keep ownership until the installer commits the version switch.
        for source in sources {
            let input = source.input;
            let lock_path = source.sdk_dir.join("collector.lock");
            private_path(&lock_path)?;
            let lock = OpenOptions::new().read(true).write(true).open(lock_path)?;
            fs2::FileExt::try_lock_exclusive(&lock)
                .with_context(|| format!("{input} SDK still owns its checkpoint"))?;
            locks.push(lock);
            let outbox = source.sdk_dir.join("outbox");
            let (key, validate) = source
                .handoff
                .legacy_cursor()
                .expect("Qwen checkpoint format");
            match Outbox::drained_shell_checkpoint(&outbox, None, source.handoff)
                .with_context(|| format!("could not read {input} SDK checkpoint"))?
            {
                ShellCheckpoint::Pending => anyhow::bail!(
                    "{input} SDK activity is still queued. Start the current release and let delivery finish before retrying the rollback"
                ),
                ShellCheckpoint::Exported { has_progress } => {
                    legacy.check_for_handoff(has_progress.then_some((key, validate))).await?;
                }
                ShellCheckpoint::Ready(text) => {
                    if let Some(text) = text {
                        let snapshot: serde_json::Map<String, serde_json::Value> =
                            serde_json::from_str(&text)?;
                        let verified = snapshot.into_iter().map(|(id, value)| {
                            ensure!(key_in_namespace(&id, key), "{input} SDK checkpoint belongs to another input");
                            let state = InputState::from_json(value)
                                .with_context(|| format!("invalid {input} SDK checkpoint entry"))?;
                            Ok((id, state))
                        }).collect::<Result<Vec<_>>>()?;
                        ensure!(
                            verified.iter().any(|(id, state)| id == key && validate(state)),
                            "{input} SDK checkpoint has no usable legacy cursor"
                        );
                        cursors.extend(verified);
                    }
                    export.push((outbox, source.handoff));
                }
            }
        }
        if !cursors.is_empty() {
            for (id, cursor) in cursors {
                legacy.set(&id, cursor);
            }
            legacy.save().await?;
        }
        for (outbox, handoff) in export {
            Outbox::mark_shell_checkpoint_exported(&outbox, handoff)?;
        }
        Ok(locks)
    }
}
