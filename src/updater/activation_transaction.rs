//! 更新指针和服务入口的持久事务；取消时回滚，崩溃后在下次检查前恢复。

use super::activation_file_targets as binding;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TARGETS: usize = 32;
const MAX_JOURNAL_BYTES: usize = MAX_TARGETS * MAX_SNAPSHOT_BYTES * 4 + 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FileState {
    hex: String,
    mode: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    original: Option<FileState>,
    intended: Option<FileState>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u32,
    committed: bool,
    targets: BTreeMap<String, PathBuf>,
    changes: BTreeMap<String, Change>,
}

pub(crate) struct ActivationTransaction {
    path: PathBuf,
    targets: BTreeMap<String, PathBuf>,
    journal: Journal,
    finished: bool,
}

impl ActivationTransaction {
    pub fn begin(cache: &Path, targets: BTreeMap<String, PathBuf>) -> Result<Self> {
        ensure!(targets.len() <= MAX_TARGETS, "更新目标数量无效");
        let targets = binding::bind_all(targets)?;
        let journal_path = binding::bind(&cache.join("update-recovery.json"))?;
        binding::validate(&targets, &journal_path)?;
        ensure!(
            !targets.is_empty() && targets.len() <= MAX_TARGETS,
            "更新目标数量无效"
        );
        ensure!(
            targets.values().all(|path| path.is_absolute()),
            "更新目标必须为绝对路径"
        );
        ensure!(
            targets
                .values()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == targets.len(),
            "更新目标路径不能重复"
        );
        Self::recover(cache, targets.clone())?;
        let _resource_lock = binding::resource_lock(&targets)?;
        let changes = targets
            .iter()
            .map(|(key, path)| {
                Ok((
                    key.clone(),
                    Change {
                        original: snapshot(path)?,
                        intended: None,
                    },
                ))
            })
            .collect::<Result<_>>()?;
        let transaction = Self {
            path: journal_path,
            targets: targets.clone(),
            journal: Journal {
                schema: 2,
                committed: false,
                targets,
                changes,
            },
            finished: false,
        };
        transaction.persist()?;
        Ok(transaction)
    }

    pub fn recover(cache: &Path, targets: BTreeMap<String, PathBuf>) -> Result<()> {
        Self::recover_compatible(cache, targets.clone(), targets)
    }

    /// 仅允许调用方显式登记的旧完整目标集合，不能信任 journal 自带的任意路径。
    pub fn recover_compatible(
        cache: &Path,
        targets: BTreeMap<String, PathBuf>,
        legacy: BTreeMap<String, PathBuf>,
    ) -> Result<()> {
        Self::recover_registered(cache, &[targets, legacy], &BTreeMap::new())
    }

    /// Resource roles come from the fixed compiled registry; disk paths never authorize restoration.
    pub fn recover_registered(
        cache: &Path,
        required: &[BTreeMap<String, PathBuf>],
        registered: &BTreeMap<String, PathBuf>,
    ) -> Result<()> {
        ensure!(
            !required.is_empty() && required.len() <= 3,
            "恢复布局数量无效"
        );
        let path = binding::bind(&cache.join("update-recovery.json"))?;
        let Some(bytes) = read_bounded(&path, MAX_JOURNAL_BYTES)? else {
            return Ok(());
        };
        let journal: Journal =
            serde_json::from_slice(&bytes).context("更新恢复记录损坏，保留当前版本和恢复材料")?;
        ensure!(journal.targets.len() <= MAX_TARGETS, "更新目标数量无效");
        // Keep the original physical authority. Never canonicalize a recorded path
        // again and silently authorize the new destination of a replaced ancestor.
        for recorded in journal.targets.values() {
            binding::ensure_bound(recorded)?;
        }
        let base_keys: std::collections::BTreeSet<_> = journal
            .targets
            .keys()
            .filter(|key| !registered.contains_key(*key))
            .cloned()
            .collect();
        let base = required
            .iter()
            .find(|candidate| {
                candidate
                    .keys()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>()
                    == base_keys
            })
            .context("更新恢复记录的目标集合无效")?;
        let mut targets = binding::bind_all(base.clone())?;
        for (key, recorded) in &journal.targets {
            if let Some(allowed) = registered.get(key) {
                let allowed = binding::bind(allowed)?;
                ensure!(
                    binding::same(recorded, &allowed),
                    "运行资源恢复目标不属于当前安装"
                );
                targets.insert(key.clone(), recorded.clone());
            } else {
                ensure!(
                    targets
                        .get(key)
                        .is_some_and(|allowed| binding::same(recorded, allowed)),
                    "更新恢复记录的目标路径无效"
                );
            }
        }
        binding::validate(&targets, &path)?;
        ensure!(
            journal.schema == 2
                && journal.targets.len() == targets.len()
                && !targets.is_empty()
                && targets.len() <= MAX_TARGETS
                && targets.values().all(|path| path.is_absolute())
                && targets
                    .values()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == targets.len()
                && journal.changes.len() == targets.len()
                && journal.changes.keys().eq(targets.keys()),
            "更新恢复记录的目标集合无效"
        );
        if let Some(marker) = journal.changes.get(binding::DSH_MARKER) {
            if let Some(intended) = &marker.intended {
                ensure!(
                    intended.hex == hex::encode(b"enabled\n")
                        && intended.mode == comparable_mode(0o600),
                    "DSH 运行标记意图无效"
                );
            }
        }
        for change in journal.changes.values() {
            for state in [&change.original, &change.intended].into_iter().flatten() {
                ensure!(
                    state.hex.len() <= MAX_SNAPSHOT_BYTES * 2 && state.mode & !0o777 == 0,
                    "更新恢复记录无效"
                );
                hex::decode(&state.hex)?;
            }
        }
        let targets = journal.targets.clone();
        let mut transaction = Self {
            path,
            targets,
            journal,
            finished: false,
        };
        if transaction.journal.committed {
            transaction.finished = true;
            fs::remove_file(&transaction.path)?;
            return Ok(());
        }
        transaction.rollback()
    }

    pub fn original_bytes(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.journal
            .changes
            .get(key)
            .context("未知更新目标")?
            .original
            .as_ref()
            .map(|state| hex::decode(&state.hex).map_err(Into::into))
            .transpose()
    }

    pub fn write_preserving_mode(
        &mut self,
        key: &str,
        bytes: &[u8],
        default_mode: u32,
    ) -> Result<()> {
        let mode = self
            .journal
            .changes
            .get(key)
            .context("未知更新目标")?
            .original
            .as_ref()
            .map_or(default_mode, |state| state.mode);
        self.write(key, bytes, mode)
    }

    pub fn write(&mut self, key: &str, bytes: &[u8], mode: u32) -> Result<()> {
        let _resource_lock = binding::resource_lock(&self.targets)?;
        self.record_intent(key, bytes, mode)?;
        atomic_write(self.targets.get(key).context("未知更新目标")?, bytes, mode)
    }

    /// An exact producer-owned child side effect is journaled without enabling the Agent early.
    pub fn expect_dsh_marker(&mut self) -> Result<()> {
        let _resource_lock = binding::resource_lock(&self.targets)?;
        self.record_intent(binding::DSH_MARKER, b"enabled\n", 0o600)
    }

    fn record_intent(&mut self, key: &str, bytes: &[u8], mode: u32) -> Result<()> {
        ensure!(!self.finished, "更新事务已结束");
        ensure!(
            bytes.len() <= MAX_SNAPSHOT_BYTES && mode & !0o777 == 0,
            "更新文件超出快照限制"
        );
        self.check_bound()?;
        let path = self.targets.get(key).context("未知更新目标")?;
        binding::writable_parent(path)?;
        let change = self.journal.changes.get_mut(key).context("未知更新目标")?;
        ensure!(
            change.intended.is_none(),
            "每个更新目标只允许写入一次：{key}"
        );
        ensure!(
            snapshot(path)? == change.original,
            "更新目标已由其他进程修改：{key}"
        );
        if change.original.is_some() {
            ensure!(
                !crate::utils::runtime_paths::runtime_metadata(path)?
                    .permissions()
                    .readonly(),
                "更新目标为只读，保留原文件：{key}"
            );
        }
        change.intended = Some(FileState {
            hex: hex::encode(bytes),
            mode: comparable_mode(mode),
        });
        // 写入意图先持久化；崩溃发生在任一侧都能确定允许恢复的字节。
        self.persist()?;
        Ok(())
    }

    pub fn commit(&mut self) -> Result<()> {
        let _resource_lock = binding::resource_lock(&self.targets)?;
        self.check_bound()?;
        ensure!(!self.finished, "更新事务已结束");
        if let Some(marker) = self.journal.changes.get_mut(binding::DSH_MARKER) {
            if marker.intended.is_some()
                && snapshot(&self.targets[binding::DSH_MARKER])? == marker.original
            {
                marker.intended = None;
                self.persist()?;
            }
        }
        for (key, change) in &self.journal.changes {
            let expected = change.intended.as_ref().or(change.original.as_ref());
            ensure!(
                snapshot(&self.targets[key])?.as_ref() == expected,
                "更新目标在提交前被外部修改，保留恢复材料：{key}"
            );
        }
        self.journal.committed = true;
        if let Err(err) = self.persist() {
            self.journal.committed = false;
            return Err(err);
        }
        self.finished = true;
        // 提交记录已落盘，清理失败不会把成功更新误回滚。
        let _ = fs::remove_file(&self.path);
        Ok(())
    }

    pub fn rollback(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let _resource_lock = binding::resource_lock(&self.targets)?;
        self.check_bound()?;
        // 先检查全部目标，避免发现用户改动时只恢复了一半。
        for (key, change) in &self.journal.changes {
            let current = snapshot(&self.targets[key])?;
            ensure!(
                current == change.original
                    || (change.intended.is_some() && current == change.intended),
                "回滚目标已被外部修改，保留恢复材料：{key}"
            );
        }
        for (key, change) in &self.journal.changes {
            let path = &self.targets[key];
            if snapshot(path)? == change.original {
                continue;
            }
            match &change.original {
                Some(state) => atomic_write(path, &hex::decode(&state.hex)?, state.mode)?,
                None => match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err.into()),
                },
            }
        }
        fs::remove_file(&self.path)?;
        self.finished = true;
        Ok(())
    }

    fn check_bound(&self) -> Result<()> {
        binding::ensure_bound(&self.path)?;
        for path in self.targets.values() {
            binding::ensure_bound(path)?;
        }
        binding::validate(&self.targets, &self.path)
    }

    fn persist(&self) -> Result<()> {
        self.check_bound()?;
        binding::writable_parent(&self.path)?;
        let bytes = serde_json::to_vec(&self.journal)?;
        ensure!(bytes.len() <= MAX_JOURNAL_BYTES, "更新恢复记录大小超限");
        atomic_write(&self.path, &bytes, 0o600)
    }
}

impl Drop for ActivationTransaction {
    fn drop(&mut self) {
        if let Err(err) = self.rollback() {
            eprintln!(
                "更新回滚失败，恢复材料保留在 {}：{err:#}",
                self.path.display()
            );
        }
    }
}

fn comparable_mode(mode: u32) -> u32 {
    if cfg!(unix) {
        mode
    } else {
        0o644
    }
}

fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
        Ok(_) => {}
    }
    let meta = crate::utils::runtime_paths::runtime_metadata(path)?;
    ensure!(
        meta.is_file() && meta.len() <= limit as u64,
        "更新目标不是受支持的普通文件：{}",
        path.display()
    );
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "更新文件读取超限");
    Ok(Some(bytes))
}

fn snapshot(path: &Path) -> Result<Option<FileState>> {
    let Some(bytes) = read_bounded(path, MAX_SNAPSHOT_BYTES)? else {
        return Ok(None);
    };
    #[cfg(unix)]
    let meta = crate::utils::runtime_paths::runtime_metadata(path)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let mode = 0o644;
    Ok(Some(FileState {
        hex: hex::encode(bytes),
        mode,
    }))
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().context("更新文件缺少父目录")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|err| err.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(root: &Path) -> BTreeMap<String, PathBuf> {
        [
            ("current".into(), root.join("current")),
            ("service".into(), root.join("bin/service")),
        ]
        .into()
    }

    #[test]
    fn duplicate_target_paths_are_rejected_before_journal_creation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let targets = [("config".into(), path.clone()), ("layout".into(), path)].into();
        assert!(ActivationTransaction::begin(root.path(), targets).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancellation_restores_bytes_permissions_and_missing_targets() {
        let root = tempfile::tempdir().unwrap();
        atomic_write(&root.path().join("current"), b"old\r\n", 0o640).unwrap();
        {
            let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
            tx.write("current", b"new\n", 0o600).unwrap();
            tx.write("service", b"new service", 0o755).unwrap();
        }
        let state = snapshot(&root.path().join("current")).unwrap().unwrap();
        assert_eq!(hex::decode(state.hex).unwrap(), b"old\r\n");
        #[cfg(unix)]
        assert_eq!(state.mode, 0o640);
        assert!(!root.path().join("bin/service").exists());
        assert!(!root.path().join("update-recovery.json").exists());
    }

    #[test]
    fn crash_recovery_and_commit_have_distinct_outcomes() {
        let root = tempfile::tempdir().unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        tx.finished = true; // 模拟进程退出，保留磁盘 journal，不运行 Drop 回滚。
        drop(tx);
        ActivationTransaction::recover(root.path(), targets(root.path())).unwrap();
        assert!(!root.path().join("current").exists());
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        tx.commit().unwrap();
        drop(tx);
        assert_eq!(fs::read(root.path().join("current")).unwrap(), b"new");
    }

    #[test]
    fn recovery_accepts_journals_larger_than_a_single_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let old = vec![b'a'; MAX_SNAPSHOT_BYTES];
        atomic_write(&root.path().join("current"), &old, 0o640).unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        assert!(
            snapshot(&root.path().join("current")).unwrap()
                == tx.journal.changes["current"].intended
        );
        assert!(tx.write("current", b"another", 0o600).is_err());
        tx.finished = true;
        drop(tx);
        assert!(
            fs::metadata(root.path().join("update-recovery.json"))
                .unwrap()
                .len()
                > MAX_SNAPSHOT_BYTES as u64
        );
        ActivationTransaction::recover(root.path(), targets(root.path())).unwrap();
        assert_eq!(fs::read(root.path().join("current")).unwrap(), old);
    }

    #[test]
    fn commit_rejects_changed_written_and_unwritten_targets_and_preserves_journal() {
        for key in ["current", "service"] {
            let root = tempfile::tempdir().unwrap();
            let targets = targets(root.path());
            atomic_write(&targets["service"], b"old service", 0o600).unwrap();
            let mut tx = ActivationTransaction::begin(root.path(), targets.clone()).unwrap();
            tx.write("current", b"new", 0o600).unwrap();
            fs::write(&targets[key], b"concurrent").unwrap();
            assert!(tx.commit().is_err());
            assert!(!tx.journal.committed);
            assert!(tx.path.exists());
            assert!(tx.rollback().is_err());
            tx.finished = true;
            drop(tx);
            assert!(ActivationTransaction::recover(root.path(), targets.clone()).is_err());
            assert_eq!(fs::read(&targets[key]).unwrap(), b"concurrent");
            assert!(root.path().join("update-recovery.json").exists());
        }
    }

    #[test]
    fn committed_transaction_rejects_more_writes_without_creating_a_journal() {
        let root = tempfile::tempdir().unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        tx.commit().unwrap();
        assert!(tx.write("service", b"late write", 0o600).is_err());
        assert!(tx.commit().is_err());
        assert!(!root.path().join("bin/service").exists());
        assert!(!root.path().join("update-recovery.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn readonly_target_is_rejected_before_recording_write_intent() {
        let root = tempfile::tempdir().unwrap();
        atomic_write(&root.path().join("current"), b"read only", 0o400).unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        assert!(tx.write("current", b"new", 0o600).is_err());
        assert!(tx.journal.changes["current"].intended.is_none());
        tx.rollback().unwrap();
        assert_eq!(fs::read(root.path().join("current")).unwrap(), b"read only");
        assert_eq!(
            snapshot(&root.path().join("current"))
                .unwrap()
                .unwrap()
                .mode,
            0o400
        );
    }

    #[test]
    fn recovery_is_bound_to_exact_paths_not_only_target_keys() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        tx.finished = true;
        drop(tx);
        atomic_write(&other.path().join("current"), b"new", 0o600).unwrap();
        assert!(ActivationTransaction::recover(root.path(), targets(other.path())).is_err());
        assert_eq!(fs::read(other.path().join("current")).unwrap(), b"new");
        assert!(root.path().join("update-recovery.json").exists());
        ActivationTransaction::recover(root.path(), targets(root.path())).unwrap();
        assert!(!root.path().join("current").exists());
    }

    #[test]
    fn external_changes_and_corrupt_journal_are_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let mut tx = ActivationTransaction::begin(root.path(), targets(root.path())).unwrap();
        tx.write("current", b"new", 0o600).unwrap();
        fs::write(root.path().join("current"), b"user").unwrap();
        assert!(tx.rollback().is_err());
        tx.finished = true;
        assert!(ActivationTransaction::recover(root.path(), targets(root.path())).is_err());
        assert_eq!(fs::read(root.path().join("current")).unwrap(), b"user");
        fs::write(root.path().join("update-recovery.json"), b"{").unwrap();
        assert!(ActivationTransaction::recover(root.path(), targets(root.path())).is_err());
    }
}

include!("activation_resource_history_tests.rs");
