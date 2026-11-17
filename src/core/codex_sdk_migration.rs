//! One-time recovery of the old embedded Codex state into full Pilot.

use crate::checkpoints::{key_in_namespace, InputState, StateStore};
use crate::sdk::outbox::Outbox;
use crate::utils::source_access::private_path;
use anyhow::{anyhow, ensure, Context};
use fs2::FileExt;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::Path;

const MIGRATED: &str = "__pilot_codex_shell_migrated_v1";

pub(super) async fn migrate(
    data: &Path,
    state: &StateStore,
    manager: &super::InputManager,
) -> anyhow::Result<()> {
    for input in ["codex-transcript", "codex-aborted-turn"] {
        let root = data.join("state").join(format!("standalone-{input}-sdk"));
        migrate_input(&root, input, state, manager)
            .await
            .with_context(|| format!("migrate {input}"))?;
    }
    Ok(())
}

async fn migrate_input(
    root: &Path,
    input: &str,
    state: &StateStore,
    manager: &super::InputManager,
) -> anyhow::Result<()> {
    let deliveries = root.join("outbox");
    let database = deliveries.join("delivery.sqlite");
    match std::fs::symlink_metadata(&database) {
        Ok(metadata) => ensure!(metadata.is_file(), "invalid previous SDK database"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    private_path(&database)?;
    let lock_path = root.join("collector.lock");
    private_path(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.try_lock_exclusive()?;

    let options = Default::default();
    let queue = Outbox::open(&deliveries, options)?;
    let checkpoints = queue.saved_checkpoints()?;
    if checkpoints.iter().any(|(source, _)| source == MIGRATED) {
        return Ok(());
    }
    let mut imported = BTreeMap::new();
    for (_, text) in checkpoints {
        let snapshot = serde_json::from_str::<Map<String, Value>>(&text)?;
        for (key, value) in snapshot {
            if !key_in_namespace(&key, input) {
                continue;
            }
            let fields = value
                .as_object()
                .context("invalid Codex SDK checkpoint entry")?;
            if let Some(previous) = imported.insert(key, fields.clone()) {
                ensure!(
                    previous == *fields,
                    "conflicting Codex SDK source checkpoints"
                );
            }
        }
    }

    loop {
        let (rows, _) = queue.read_batch(&Default::default())?;
        if rows.is_empty() {
            break;
        }
        let entries = rows
            .iter()
            .map(|(_, payload)| serde_json::from_slice(payload))
            .collect::<Result<Vec<_>, _>>()?;
        let encoded = rows.iter().map(|(_, payload)| payload.clone()).collect();
        // Startup still needs to reach the Qoder collector when a destination
        // cannot take the previous Codex queue. Pending rows stay in that queue.
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            manager.accept_sdk_batch(input, entries, encoded),
        )
        .await
        .context("previous Codex batch delivery timed out")?
        .map_err(|e| anyhow!(e))?;
        queue.ack(&rows)?;
    }
    if !imported.is_empty() {
        for (key, fields) in imported {
            let checkpoint = fields
                .into_iter()
                .fold(InputState::new(), |entry, (field, value)| {
                    entry.with_checkpoint_extension(&field, value)
                });
            state.set(&key, checkpoint);
        }
        state.save().await?;
    }
    // Retain the source journal. A restart after migration must use the
    // shell's newer cursor instead of importing the retired cursor again.
    queue.checkpoint(MIGRATED, "{}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flushers::{BaseFlusher, FlushError};
    use crate::types::AgentActivityEntry;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Output(Mutex<Vec<Vec<u8>>>);

    #[async_trait]
    impl BaseFlusher for Output {
        fn name(&self) -> &str {
            "migration-test"
        }

        async fn send(&self, _: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
            unreachable!("migration preserves encoded bytes")
        }

        async fn send_batch(
            &self,
            _: Vec<AgentActivityEntry>,
            _: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            unreachable!("migration preserves encoded bytes")
        }

        async fn send_prepared_batch(
            &self,
            _: Vec<AgentActivityEntry>,
            bytes: Vec<Vec<u8>>,
        ) -> Result<(), FlushError> {
            self.0.lock().unwrap().extend(bytes);
            Ok(())
        }

        async fn flush(&self) -> Result<(), FlushError> {
            Ok(())
        }

        async fn shutdown(&self) -> Result<(), FlushError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn codex_migration_replays_before_advancing_and_never_rewinds_on_restart() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("state/standalone-codex-transcript-sdk");
        let legacy = StateStore::new(root.path().join("input-state.json"));
        let manager = super::super::InputManager::new();
        let pending = br#"{"event.id":"same-event","event.name":"other","gen_ai.agent.type":"codex","future":true}"#;
        let queue = Outbox::open(&previous.join("outbox"), Default::default()).unwrap();
        queue.checkpoint(
            "original",
            r#"{"codex-transcript:rollout":{"lastOffset":22,"future":true},"qoder-trace":{"lastOffset":1}}"#,
        ).unwrap();
        queue.enqueue_hook(pending).unwrap();

        assert!(migrate(root.path(), &legacy, &manager).await.is_err());
        assert_eq!(queue.read_batch(&Default::default()).unwrap().0.len(), 1);
        assert_ne!(legacy.get_offset("codex-transcript:rollout"), 22.0);

        let output = Arc::new(Output::default());
        manager.set_flusher(output.clone());
        migrate(root.path(), &legacy, &manager).await.unwrap();
        assert_eq!(*output.0.lock().unwrap(), vec![pending.to_vec()]);
        assert!(queue.read_batch(&Default::default()).unwrap().0.is_empty());
        assert_eq!(legacy.get_offset("codex-transcript:rollout"), 22.0);
        assert_eq!(
            legacy.get("codex-transcript:rollout").get_field("future"),
            Some(Value::Bool(true))
        );
        assert!(!legacy.keys().contains(&"qoder-trace".into()));

        legacy.set_offset("codex-transcript:rollout", 27.0);
        migrate(root.path(), &legacy, &manager).await.unwrap();
        assert_eq!(legacy.get_offset("codex-transcript:rollout"), 27.0);
        assert_eq!(output.0.lock().unwrap().len(), 1);
    }
}
