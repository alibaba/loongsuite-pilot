//! Independent initial exclusion boundary; never a delivered-output cursor.
use super::budget::{DoubaoWorkBudget, DoubaoWorkError, Result};
use super::state::FileCursor;
use crate::checkpoints::source_ownership::{
    create_small_record, open_source_strict, persist_small_record, read_small_record,
};
use crate::utils::file_identity::{identity_from_open, OpenedFileIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs::File;
const PREFIX_BYTES: usize = 64;
#[derive(Clone)]
pub(super) struct SourceRecovery {
    directory: PathBuf,
    scope: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation {
    schema: u8,
    scope: String,
    since_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
    birthtime_bits: u64,
}
impl From<&OpenedFileIdentity> for Identity {
    fn from(id: &OpenedFileIdentity) -> Self {
        Self {
            device: id.dev,
            inode: id.ino,
            birthtime_bits: id.birthtime_ms.to_bits(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Floor {
    offset: u64,
    anchor_sha256_hex: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    schema: u8,
    identity: Identity,
    prefix_length: usize,
    prefix_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    floor: Option<Floor>,
}
fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub(super) async fn identity(file: &File) -> Result<OpenedFileIdentity> {
    let std = file.try_clone().await?.into_std().await;
    Ok(identity_from_open(&std)?)
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
async fn prefix(
    file: &mut File,
    length: usize,
    budget: &mut DoubaoWorkBudget<'_>,
) -> Result<String> {
    if length == 0 {
        return Ok(sha(&[]));
    }
    if budget.remaining_bytes() < length as u64 {
        return Err(DoubaoWorkError::deferred("cycle_budget"));
    }
    let mut buffer = vec![0; length];
    let read = budget.read(file, &mut buffer, length, 0, false).await?;
    if read != length {
        return Err(DoubaoWorkError::deferred("source_refresh"));
    }
    Ok(sha(&buffer))
}
async fn boundary(
    file: &mut File,
    offset: u64,
    budget: &mut DoubaoWorkBudget<'_>,
) -> Result<String> {
    let length = offset.min(64) as usize;
    if length == 0 {
        return Ok(super::util::digest(""));
    }
    if budget.remaining_bytes() < length as u64 {
        return Err(DoubaoWorkError::deferred("cycle_budget"));
    }
    let mut bytes = [0; 64];
    let read = budget
        .read(file, &mut bytes, length, offset - length as u64, false)
        .await?;
    if read != length {
        return Err(DoubaoWorkError::deferred("source_refresh"));
    }
    Ok(super::util::digest(&hex::encode(&bytes[..length])))
}
impl SourceRecovery {
    pub(super) fn new(state_path: &Path, scope: String) -> Self {
        let absolute = if state_path.is_absolute() {
            state_path.to_owned()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(state_path)
        };
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        let key = sha(normalized.as_os_str().as_encoded_bytes());
        let parent = normalized
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        Self {
            directory: parent
                .join(".pilot-source-ownership")
                .join(key)
                .join("doubao-work")
                .join(&scope),
            scope,
        }
    }
    pub(super) async fn initial_epoch(&self, proposed: i64) -> Result<i64> {
        if let Some(value) = read_small_record(self.directory.join("installation.json")).await? {
            let record: Installation = serde_json::from_value(value)?;
            if record.schema != 1
                || record.scope != self.scope
                || record.since_ms < super::util::MIN_MS
                || record.since_ms >= super::util::MAX_MS
            {
                return Err(DoubaoWorkError::invalid(
                    "Invalid Doubao source installation proof",
                ));
            }
            return Ok(record.since_ms);
        }
        let record = Installation {
            schema: 1,
            scope: self.scope.clone(),
            since_ms: proposed,
        };
        if create_small_record(
            self.directory.clone(),
            "installation.json".into(),
            serde_json::to_value(record)?,
        )
        .await?
        {
            return Ok(proposed);
        }
        let value = read_small_record(self.directory.join("installation.json"))
            .await?
            .ok_or_else(|| DoubaoWorkError::invalid("Lost durable Doubao installation proof"))?;
        let record: Installation = serde_json::from_value(value)?;
        if record.schema != 1
            || record.scope != self.scope
            || record.since_ms < super::util::MIN_MS
            || record.since_ms >= super::util::MAX_MS
        {
            return Err(DoubaoWorkError::invalid(
                "Invalid durable Doubao installation proof",
            ));
        }
        Ok(record.since_ms)
    }
    fn name(&self, id: &Identity) -> String {
        format!(
            "{}.json",
            sha(&serde_json::to_vec(id).expect("fixed source identity"))
        )
    }
    async fn read_proof(
        &self,
        file: &mut File,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<Option<Proof>> {
        let before = identity(file).await?;
        let id = Identity::from(&before);
        let Some(value) = read_small_record(self.directory.join(self.name(&id))).await? else {
            return Ok(None);
        };
        let proof: Proof = serde_json::from_value(value)?;
        if proof.schema != 1
            || (proof.prefix_length == 0 && proof.floor.as_ref().is_none_or(|f| f.offset != 0))
            || proof
                .floor
                .as_ref()
                .is_some_and(|f| f.offset < proof.prefix_length as u64)
            || proof.identity != id
            || proof.prefix_length > PREFIX_BYTES
            || !valid_hash(&proof.prefix_sha256)
            || proof
                .floor
                .as_ref()
                .is_some_and(|f| !valid_hash(&f.anchor_sha256_hex))
        {
            return Err(DoubaoWorkError::invalid("Invalid Doubao source proof"));
        }
        if before.size < proof.prefix_length as u64
            || proof.floor.as_ref().is_some_and(|f| before.size < f.offset)
        {
            return Ok(None);
        }
        if prefix(file, proof.prefix_length, budget).await? != proof.prefix_sha256 {
            return Ok(None);
        }
        if let Some(floor) = &proof.floor {
            if boundary(file, floor.offset, budget).await? != floor.anchor_sha256_hex {
                return Ok(None);
            }
        }
        let after = identity(file).await?;
        if Identity::from(&after) != id || after.size < before.size {
            return Err(DoubaoWorkError::deferred("source_refresh"));
        }
        Ok(Some(proof))
    }
    async fn save(&self, path: &Path, file: &mut File, proof: Proof) -> Result<()> {
        let before = identity(file).await?;
        let reopened = open_source_strict(path.to_owned()).await?;
        let at_path = identity(&reopened).await?;
        if Identity::from(&before) != proof.identity
            || Identity::from(&at_path) != proof.identity
            || proof
                .floor
                .as_ref()
                .is_some_and(|f| at_path.size < f.offset)
        {
            return Err(DoubaoWorkError::deferred("source_refresh"));
        }
        persist_small_record(
            self.directory.clone(),
            self.name(&proof.identity),
            serde_json::to_value(proof)?,
        )
        .await?;
        Ok(())
    }
    pub(super) async fn historical(
        &self,
        path: &Path,
        file: &mut File,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<FileCursor> {
        let before = identity(file).await?;
        let id = Identity::from(&before);
        if let Some(proof) = self.read_proof(file, budget).await? {
            let offset = proof.floor.as_ref().map_or(0, |floor| floor.offset);
            let anchor = proof
                .floor
                .map_or_else(|| super::util::digest(""), |f| f.anchor_sha256_hex);
            return Ok(FileCursor {
                identity: format!("{}:{}", before.dev, before.ino),
                birthtime_bits: Some(before.birthtime_ms.to_bits()),
                offset,
                anchor: Some(anchor),
                skipping_line: false,
            });
        }
        let length = before.size.min(PREFIX_BYTES as u64) as usize;
        let prefix_sha256 = prefix(file, length, budget).await?;
        let anchor = boundary(file, before.size, budget).await?;
        let after = identity(file).await?;
        if Identity::from(&after) != id || after.size < before.size {
            return Err(DoubaoWorkError::deferred("source_refresh"));
        }
        let proof = Proof {
            schema: 1,
            identity: id,
            prefix_length: length,
            prefix_sha256,
            floor: Some(Floor {
                offset: before.size,
                anchor_sha256_hex: anchor.clone(),
            }),
        };
        self.save(path, file, proof).await?;
        Ok(FileCursor {
            identity: format!("{}:{}", before.dev, before.ino),
            birthtime_bits: Some(before.birthtime_ms.to_bits()),
            offset: before.size,
            anchor: Some(anchor),
            skipping_line: false,
        })
    }
    pub(super) async fn before_live_read(
        &self,
        path: &Path,
        file: &mut File,
        budget: &mut DoubaoWorkBudget<'_>,
    ) -> Result<()> {
        if self.read_proof(file, budget).await?.is_some() {
            return Ok(());
        }
        let before = identity(file).await?;
        let id = Identity::from(&before);
        let length = before.size.min(PREFIX_BYTES as u64) as usize;
        let prefix_sha256 = prefix(file, length, budget).await?;
        let after = identity(file).await?;
        if Identity::from(&after) != id || after.size < before.size {
            return Err(DoubaoWorkError::deferred("source_refresh"));
        }
        let floor = (before.size == 0).then(|| Floor {
            offset: 0,
            anchor_sha256_hex: super::util::digest(""),
        });
        self.save(
            path,
            file,
            Proof {
                schema: 1,
                identity: id,
                prefix_length: length,
                prefix_sha256,
                floor,
            },
        )
        .await
    }
}
pub(super) async fn open_source(path: PathBuf) -> Result<File> {
    Ok(open_source_strict(path).await?)
}

#[cfg(test)]
mod tests {
    use super::super::budget::DoubaoWorkBudgetOptions;
    use super::*;
    use tokio::io::AsyncWriteExt;
    fn budget(bytes: u64) -> DoubaoWorkBudget<'static> {
        DoubaoWorkBudget::new(
            DoubaoWorkBudgetOptions {
                bytes,
                milliseconds: 1000,
                records: 4096,
            },
            None,
        )
    }
    fn recovery(root: &Path) -> SourceRecovery {
        SourceRecovery::new(&root.join("state.json"), "synthetic-scope".into())
    }
    #[tokio::test]
    async fn initial_epoch_and_floor_are_immutable_body_free_and_restore_after_append_and_rename() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("first.log");
        let history = format!("{}HISTORICAL_PRIVATE_END\n", "PRIVATE_HISTORY_".repeat(32));
        tokio::fs::write(&source, &history).await.unwrap();
        let recovery = recovery(root.path());
        let since = 1_792_897_200_000;
        assert_eq!(recovery.initial_epoch(since).await.unwrap(), since);
        assert_eq!(recovery.initial_epoch(since + 99_000).await.unwrap(), since);
        let mut file = open_source(source.clone()).await.unwrap();
        let mut first_budget = budget(512);
        let cursor = recovery
            .historical(&source, &mut file, &mut first_budget)
            .await
            .unwrap();
        assert_eq!(cursor.offset, history.len() as u64);
        assert_eq!(first_budget.remaining_bytes(), 512 - 128);
        let before = tokio::fs::read_dir(&recovery.directory).await.unwrap();
        drop(before);
        let target = root.path().join("rotated.log");
        tokio::fs::rename(&source, &target).await.unwrap();
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&target)
            .await
            .unwrap()
            .write_all(b"UNACCEPTED_FRESH_TAIL\n")
            .await
            .unwrap();
        let mut reopened = open_source(target.clone()).await.unwrap();
        let restored = recovery
            .historical(&target, &mut reopened, &mut budget(512))
            .await
            .unwrap();
        assert_eq!(restored.offset, cursor.offset);
        assert_eq!(restored.anchor, cursor.anchor);
        let id = Identity::from(&identity(&reopened).await.unwrap());
        let raw = tokio::fs::read(recovery.directory.join(recovery.name(&id)))
            .await
            .unwrap();
        let text = String::from_utf8(raw).unwrap();
        for private in [
            "PRIVATE_HISTORY",
            "HISTORICAL_PRIVATE_END",
            "UNACCEPTED_FRESH_TAIL",
            "lastOffset",
            "pending",
            "completed",
        ] {
            assert!(!text.contains(private), "{private}")
        }
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["floor"]["offset"], history.len());
    }
    #[tokio::test]
    async fn replaced_identity_and_changed_floor_boundary_cannot_inherit_an_old_exclusion() {
        for changed_identity in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("source.log");
            let old = "a".repeat(128) + "OLD_FLOOR";
            tokio::fs::write(&source, &old).await.unwrap();
            let recovery = recovery(root.path());
            recovery.initial_epoch(1_792_897_200_000).await.unwrap();
            let mut file = open_source(source.clone()).await.unwrap();
            let first = recovery
                .historical(&source, &mut file, &mut budget(512))
                .await
                .unwrap();
            if changed_identity {
                tokio::fs::rename(&source, root.path().join("keep-original-inode"))
                    .await
                    .unwrap();
            }
            let replacement = "a".repeat(128) + "NEW_FLOOR_AND_DISTINCT_TAIL";
            tokio::fs::write(&source, &replacement).await.unwrap();
            let mut replaced = open_source(source.clone()).await.unwrap();
            let restored = recovery
                .historical(&source, &mut replaced, &mut budget(512))
                .await
                .unwrap();
            assert_eq!(restored.offset, replacement.len() as u64);
            assert_ne!(restored.offset, first.offset);
        }
    }
    #[tokio::test]
    async fn new_live_source_proof_and_empty_zero_floor_do_not_become_delivered_cursors() {
        for empty in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("live.log");
            let recovery = recovery(root.path());
            recovery.initial_epoch(1_792_897_200_000).await.unwrap();
            tokio::fs::write(&source, if empty { "" } else { "PRIVATE_LIVE_RECORD\n" })
                .await
                .unwrap();
            let mut file = open_source(source.clone()).await.unwrap();
            recovery
                .before_live_read(&source, &mut file, &mut budget(512))
                .await
                .unwrap();
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&source)
                .await
                .unwrap()
                .write_all(b"FRESH_TAIL\n")
                .await
                .unwrap();
            let mut reopened = open_source(source.clone()).await.unwrap();
            let cursor = recovery
                .historical(&source, &mut reopened, &mut budget(512))
                .await
                .unwrap();
            assert_eq!(cursor.offset, 0);
            let id = Identity::from(&identity(&reopened).await.unwrap());
            let value = read_small_record(recovery.directory.join(recovery.name(&id)))
                .await
                .unwrap()
                .unwrap();
            if empty {
                assert_eq!(value["floor"]["offset"], 0)
            } else {
                assert!(value.get("floor").is_none())
            }
            assert!(!value.to_string().contains("PRIVATE_LIVE_RECORD"));
        }
    }
    #[tokio::test]
    async fn proof_reads_respect_the_source_budget_and_failed_capture_cannot_create_a_floor() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.log");
        tokio::fs::write(&source, "x".repeat(256)).await.unwrap();
        let recovery = recovery(root.path());
        recovery.initial_epoch(1_792_897_200_000).await.unwrap();
        let mut file = open_source(source.clone()).await.unwrap();
        let mut limited = budget(100);
        assert!(
            matches!(recovery.historical(&source,&mut file,&mut limited).await,Err(DoubaoWorkError::Deferred(reason))if reason=="cycle_budget")
        );
        assert_eq!(limited.remaining_bytes(), 36);
        let id = Identity::from(&identity(&file).await.unwrap());
        assert!(!recovery.directory.join(recovery.name(&id)).exists());
        let cursor = recovery
            .historical(&source, &mut file, &mut budget(512))
            .await
            .unwrap();
        assert_eq!(cursor.offset, 256);
    }
    #[tokio::test]
    async fn corrupt_record_and_blocked_metadata_writer_fail_before_source_progress() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.log");
        tokio::fs::write(&source, "PRIVATE\n").await.unwrap();
        let recovery = recovery(root.path());
        recovery.initial_epoch(1_792_897_200_000).await.unwrap();
        let mut file = open_source(source.clone()).await.unwrap();
        recovery
            .historical(&source, &mut file, &mut budget(512))
            .await
            .unwrap();
        let id = Identity::from(&identity(&file).await.unwrap());
        tokio::fs::write(recovery.directory.join(recovery.name(&id)), "{half")
            .await
            .unwrap();
        assert!(recovery
            .historical(&source, &mut file, &mut budget(512))
            .await
            .is_err());
        let blocked = tempfile::tempdir().unwrap();
        tokio::fs::write(blocked.path().join(".pilot-source-ownership"), "occupied")
            .await
            .unwrap();
        let blocked_recovery =
            SourceRecovery::new(&blocked.path().join("state.json"), "blocked".into());
        assert!(blocked_recovery
            .initial_epoch(1_792_897_200_000)
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn source_and_managed_metadata_symlinks_are_rejected_without_writing_elsewhere() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let real = root.path().join("real.log");
        tokio::fs::write(&real, "PRIVATE\n").await.unwrap();
        let link = root.path().join("link.log");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(open_source(link).await.is_err());
        std::os::unix::fs::symlink(
            elsewhere.path(),
            root.path().join(".pilot-source-ownership"),
        )
        .unwrap();
        assert!(recovery(root.path())
            .initial_epoch(1_792_897_200_000)
            .await
            .is_err());
        assert!(std::fs::read_dir(elsewhere.path())
            .unwrap()
            .next()
            .is_none());
    }
    #[tokio::test]
    async fn installation_creation_race_preserves_one_epoch_and_separate_state_files_do_not_share_ownership(
    ) {
        let root = tempfile::tempdir().unwrap();
        let a = recovery(root.path());
        let b = a.clone();
        let (first, second) = tokio::join!(
            a.initial_epoch(1_792_897_200_000),
            b.initial_epoch(1_792_897_299_000)
        );
        let first = first.unwrap();
        assert_eq!(first, second.unwrap());
        assert!([1_792_897_200_000, 1_792_897_299_000].contains(&first));
        let other = SourceRecovery::new(
            &root.path().join("other-state.json"),
            "synthetic-scope".into(),
        );
        assert_ne!(a.directory, other.directory);
        assert_eq!(
            other.initial_epoch(1_792_897_399_000).await.unwrap(),
            1_792_897_399_000
        );
        assert_eq!(a.initial_epoch(1_792_897_499_000).await.unwrap(), first);
    }
}
