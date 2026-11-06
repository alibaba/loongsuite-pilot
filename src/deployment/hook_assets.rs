//! 将本安装声明的 Hook 及共享薄入口部署到 data/hooks；配置写入前校验资源。

use crate::types::AgentDefinition;
use crate::updater::ActivationTransaction;
use crate::utils::runtime_paths::{
    build_edition, build_target, is_development_root, resource_file, runtime_metadata,
    RuntimeManifest,
};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

fn managed_assets(def: &AgentDefinition, data: &Path) -> Result<Vec<String>> {
    let Some(hook) = &def.hook else {
        return Ok(Vec::new());
    };
    let prefix = format!(
        "{}/hooks/",
        data.to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
    );
    let mut assets = Vec::new();
    for command in std::iter::once(&hook.hook_command)
        .chain(hook.interceptor.iter().map(|item| &item.hook_command))
    {
        let normalized = command.trim_start_matches('"').replace('\\', "/");
        let Some(relative) = normalized.strip_prefix(&prefix) else {
            continue;
        };
        let end = [".ps1", ".sh"]
            .iter()
            .filter_map(|suffix| relative.find(suffix).map(|index| index + suffix.len()))
            .min()
            .context("托管 Hook 命令缺少平台脚本扩展名")?;
        let relative = &relative[..end];
        ensure!(
            !relative.contains('/') && !relative.contains(['\r', '\n', '"']),
            "托管 Hook 路径无效"
        );
        if !assets.iter().any(|path| path == relative) {
            assets.push(relative.to_string());
        }
    }
    if assets.iter().any(|path| path.ends_with(".sh")) {
        assets.push("shared/native.sh".into());
    }
    if assets.iter().any(|path| path.ends_with(".ps1")) {
        assets.push("shared/native.ps1".into());
    }
    Ok(assets)
}

fn safe_destination(root: &Path, relative: &str) -> Result<PathBuf> {
    let validate = |path: &Path, directory: bool| -> Result<()> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                let meta = crate::utils::runtime_paths::runtime_metadata(path)?;
                ensure!(
                    if directory {
                        meta.is_dir()
                    } else {
                        meta.is_file()
                    },
                    "Hook 目标路径类型错误：{}",
                    path.display()
                );
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        Ok(())
    };
    validate(root, true)?;
    let mut path = root.to_path_buf();
    let components: Vec<_> = std::iter::once("hooks")
        .chain(relative.split('/'))
        .collect();
    for (index, component) in components.iter().enumerate() {
        ensure!(
            !component.is_empty()
                && *component != "."
                && *component != ".."
                && !component.contains(['\\', ':', '\r', '\n']),
            "Hook 目标路径无效"
        );
        path.push(component);
        validate(&path, index + 1 < components.len())?;
    }
    Ok(path)
}

fn load_assets(def: &AgentDefinition, pilot: &Path, data: &Path) -> Result<Vec<(String, String)>> {
    let assets = managed_assets(def, data)?;
    if assets.is_empty() {
        return Ok(Vec::new());
    }
    let manifest = match std::fs::symlink_metadata(pilot.join("runtime-manifest.json")) {
        Ok(_) => {
            let mut bytes = Vec::new();
            std::fs::File::open(resource_file(pilot, "runtime-manifest.json")?)?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 4 * 1024 * 1024, "Hook 运行清单大小超限");
            let manifest: RuntimeManifest =
                serde_json::from_slice(&bytes).context("Hook 运行清单格式错误")?;
            ensure!(
                manifest.schema == 1 && manifest.runtime == "rust",
                "Hook 运行清单版本或运行时无效"
            );
            ensure!(
                manifest.version == env!("CARGO_PKG_VERSION")
                    && manifest.target == build_target()
                    && manifest.edition == build_edition(),
                "Hook 运行清单与当前二进制不匹配"
            );
            Some(manifest)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ensure!(
                is_development_root(pilot),
                "Hook 资源根缺少 runtime-manifest.json"
            );
            None
        }
        Err(err) => return Err(err.into()),
    };
    assets
        .into_iter()
        .map(|relative| {
            let source = format!("assets/hooks/{relative}");
            let bytes = std::fs::read(resource_file(pilot, &source)?)?;
            if let Some(manifest) = &manifest {
                let mut entries = manifest
                    .resources
                    .iter()
                    .filter(|item| item.path.eq_ignore_ascii_case(&source));
                let entry = entries
                    .next()
                    .context(format!("Hook 资源未登记：{source}"))?;
                ensure!(
                    entry.path == source && entries.next().is_none(),
                    "Hook 资源未唯一登记：{source}"
                );
                ensure!(
                    hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&entry.sha256),
                    "Hook 资源摘要不匹配：{source}"
                );
            }
            // 发布和健康检查使用已经核对摘要的同一份字节。
            Ok((relative, String::from_utf8(bytes)?))
        })
        .collect()
}

pub(super) fn recovery_pending(root: &Path) -> bool {
    !matches!(std::fs::symlink_metadata(root.join(".hook-install/update-recovery.json")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound)
}

// Freeze config paths before taking locks. The same prepared set must drive
// both locks and the recovery journal; never resolve parent links again inside
// the transaction after its locks have been acquired.
pub(super) struct HookConfigTargets(BTreeMap<String, PathBuf>);

pub(super) struct HookAssets {
    root: PathBuf,
    files: Vec<(String, PathBuf, String)>,
}

impl HookAssets {
    pub(super) fn configuration_cleanup(root: &Path) -> Self {
        Self {
            root: root.into(),
            files: Vec::new(),
        }
    }

    pub(super) fn load(def: &AgentDefinition, pilot: Option<&Path>, root: &Path) -> Result<Self> {
        let assets = match pilot {
            Some(pilot) => load_assets(def, pilot, root)?,
            None => Vec::new(),
        };
        let mut files = Vec::new();
        for (relative, content) in assets {
            let path = safe_destination(root, &relative)?;
            files.push((relative, path, content));
        }
        if !files.is_empty() {
            let binary = super::runtime_launcher::hook_binary(root)?
                .to_string_lossy()
                .into_owned();
            ensure!(!binary.contains(['\r', '\n']), "原生二进制路径无效");
            files.push((
                "pilot-bin".into(),
                safe_destination(root, "pilot-bin")?,
                format!("{binary}\n"),
            ));
        }
        Ok(Self {
            root: root.into(),
            files,
        })
    }

    pub(super) fn cleanup(def: &AgentDefinition, root: &Path, managed: bool) -> Result<Self> {
        // 清理只需要当前声明的目标集合，不要求待删除引用的源包仍然完整。
        let mut files = Vec::new();
        if managed {
            for relative in managed_assets(def, root)? {
                let path = safe_destination(root, &relative)?;
                files.push((relative, path, String::new()));
            }
            if !files.is_empty() {
                files.push((
                    "pilot-bin".into(),
                    safe_destination(root, "pilot-bin")?,
                    String::new(),
                ));
            }
        }
        Ok(Self {
            root: root.into(),
            files,
        })
    }

    fn targets(&self, configs: &HookConfigTargets) -> BTreeMap<String, PathBuf> {
        let mut targets = configs.0.clone();
        for (relative, path, _) in &self.files {
            targets.insert(format!("asset:{relative}"), path.clone());
        }
        targets
    }

    pub(super) fn prepare_configs(
        configs: &BTreeMap<String, PathBuf>,
    ) -> Result<HookConfigTargets> {
        pin_configuration_targets(configs).map(HookConfigTargets)
    }

    pub(super) fn begin(&self, configs: &HookConfigTargets) -> Result<ActivationTransaction> {
        for (relative, _, _) in &self.files {
            safe_destination(&self.root, relative)?;
        }
        let directory = self.root.join(".hook-install");
        private_directory(&directory)?;
        ActivationTransaction::begin(&directory, self.targets(configs))
    }

    pub(super) fn prepare(&self, transaction: &mut ActivationTransaction) -> Result<()> {
        for (relative, path, content) in &self.files {
            safe_destination(&self.root, relative)?;
            let key = format!("asset:{relative}");
            #[cfg(unix)]
            let executable_repair = {
                use std::os::unix::fs::PermissionsExt;
                relative.ends_with(".sh")
                    && std::fs::metadata(path)
                        .is_ok_and(|meta| meta.permissions().mode() & 0o111 == 0)
            };
            #[cfg(not(unix))]
            let executable_repair = {
                let _ = path;
                false
            };
            if executable_repair
                || transaction.original_bytes(&key)?.as_deref() != Some(content.as_bytes())
            {
                if relative.ends_with(".sh") {
                    transaction.write(&key, content.as_bytes(), 0o755)?;
                } else {
                    transaction.write_preserving_mode(&key, content.as_bytes(), 0o600)?;
                }
            }
        }
        Ok(())
    }

    /// 资源锁 → 排序后的全部配置锁 → Claude 兼容锁；恢复后从快照重新规划，一次写入每个目标。
    pub(super) async fn apply(
        &self,
        configs: BTreeMap<String, PathBuf>,
        claude_settings: Option<&str>,
        uninstall: bool,
        build: impl FnOnce(&ActivationTransaction) -> Result<BTreeMap<String, String>> + Send,
    ) -> Result<()> {
        private_directory(&self.root)?;
        let configs = Self::prepare_configs(&configs)?;
        let lock = self.root.join(".hook-assets.lock");
        super::with_deployed_state_lock(
            lock.to_str().context("Hook 锁路径编码无效")?,
            || async {
                if uninstall {
                    ensure!(
                        !recovery_pending(&self.root),
                        "Hook 事务待恢复，停止清理并保留配置与资源"
                    );
                }
                let mut paths: Vec<_> = configs
                    .0
                    .iter()
                    .map(|(key, path)| {
                        let mut lock = path.as_os_str().to_owned();
                        // 与外层状态写入者使用同一把锁；配置仍沿用跨安装共享锁。
                        lock.push(if key == "state" {
                            ".lock"
                        } else {
                            ".loongsuite-pilot.lock"
                        });
                        PathBuf::from(lock)
                    })
                    .collect();
                paths.sort();
                paths.dedup();
                with_config_locks(&paths, || async {
                    let execute =
                        || {
                            let mut transaction = self.begin(&configs)?;
                            let result = (|| {
                                let edits = build(&transaction)?;
                                if !uninstall {
                                    self.prepare(&mut transaction)?;
                                }
                                if edits.contains_key("config")
                                    && configs.0.contains_key("backup")
                                    && transaction.original_bytes("backup")?.is_none()
                                {
                                    if let Some(original) = transaction.original_bytes("config")? {
                                        transaction.write("backup", &original, 0o600)?;
                                    }
                                }
                                for (key, content) in edits {
                                    ensure!(
                                        configs.0.contains_key(&key) && key != "backup",
                                        "未知 Hook 配置目标"
                                    );
                                    transaction.write_preserving_mode(
                                        &key,
                                        content.as_bytes(),
                                        0o600,
                                    )?;
                                }
                                transaction.commit()
                            })();
                            if let Err(err) = result {
                                return match transaction.rollback() {
                                    Ok(()) => Err(err),
                                    Err(rollback) => Err(err
                                        .context(format!("Hook 配置与资源恢复失败：{rollback:#}"))),
                                };
                            }
                            Ok(())
                        };
                    if let Some(settings) = claude_settings {
                        crate::hooks::with_claude_settings_lock(
                            settings,
                            || async { execute() },
                            10_000,
                        )
                        .await
                        .map_err(anyhow::Error::msg)?
                    } else {
                        execute()
                    }
                })
                .await
            },
            10_000,
        )
        .await
    }
}

pub(super) fn private_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => ensure!(runtime_metadata(path)?.is_dir(), "Hook 目录类型无效"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path)?;
            ensure!(runtime_metadata(path)?.is_dir(), "Hook 目录类型无效");
        }
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

/// Agent homes may be directory links (for example ~/.cursor on another
/// disk). Pin the resolved parent while leaving the file itself unresolved:
/// snapshot/write still reject a linked config file and all runtime assets
/// retain their stricter path validation.
fn pin_configuration_targets(
    configs: &BTreeMap<String, PathBuf>,
) -> Result<BTreeMap<String, PathBuf>> {
    configs
        .iter()
        .map(|(key, path)| {
            #[cfg(unix)]
            let path = if key == "state" {
                path.clone()
            } else {
                pin_configuration_parent(path)?
            };
            #[cfg(not(unix))]
            let path = path.clone();
            Ok((key.clone(), path))
        })
        .collect()
}

#[cfg(unix)]
fn pin_configuration_parent(path: &Path) -> Result<PathBuf> {
    let file = path.file_name().context("Hook 配置缺少文件名")?;
    let mut parent = path.parent().context("Hook 配置缺少父目录")?;
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(parent) {
            Ok(mut resolved) => {
                ensure!(resolved.is_dir(), "Hook 配置父路径不是目录");
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                resolved.push(file);
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    parent
                        .file_name()
                        .context("Hook 配置父路径不存在")?
                        .to_os_string(),
                );
                parent = parent.parent().context("Hook 配置缺少已存在的祖先目录")?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

async fn with_config_locks<T, Fut>(
    paths: &[PathBuf],
    body: impl FnOnce() -> Fut + Send,
) -> Result<T>
where
    T: Send,
    Fut: std::future::Future<Output = Result<T>> + Send,
{
    let Some((path, remaining)) = paths.split_first() else {
        return body().await;
    };
    private_directory(path.parent().context("Hook 配置缺少父目录")?)?;
    super::with_deployed_state_lock(
        path.to_str().context("Hook 配置锁路径编码无效")?,
        || Box::pin(with_config_locks(remaining, body)),
        10_000,
    )
    .await
}

#[cfg(test)]
pub(super) fn seed_development_root(pilot: &Path) {
    for directory in ["src", "agents.d", "assets"] {
        std::fs::create_dir_all(pilot.join(directory)).unwrap();
    }
    std::fs::write(pilot.join("Cargo.toml"), "[package]\nname = 'fixture'\n").unwrap();
    std::fs::write(pilot.join("src/main.rs"), "fn main() {}\n").unwrap();
}

#[cfg(test)]
async fn prepare(def: &AgentDefinition, pilot: &Path, data: &Path) -> Result<()> {
    HookAssets::load(def, Some(pilot), data)?
        .apply(BTreeMap::new(), None, false, |_| Ok(BTreeMap::new()))
        .await
}

pub fn healthy(def: &AgentDefinition, pilot: &Path, data: &Path) -> bool {
    if recovery_pending(data) {
        return false;
    }
    let Ok(assets) = load_assets(def, pilot, data) else {
        return false;
    };
    if assets.is_empty() {
        return true;
    }
    let Ok(binary) = super::runtime_launcher::hook_binary(data) else {
        return false;
    };
    if !binary.is_file() {
        return false;
    }
    let Ok(pin) = safe_destination(data, "pilot-bin") else {
        return false;
    };
    if std::fs::read_to_string(pin).ok().as_deref()
        != Some(format!("{}\n", binary.display()).as_str())
    {
        return false;
    }
    assets.into_iter().all(|(relative, content)| {
        let Ok(path) = safe_destination(data, &relative) else {
            return false;
        };
        if std::fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
            return false;
        }
        #[cfg(unix)]
        if relative.ends_with(".sh") {
            use std::os::unix::fs::PermissionsExt;
            return std::fs::metadata(path)
                .is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0);
        }
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_hook_lock_wait_does_not_publish_and_releases_resource_lock() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        let lock = format!("{}.loongsuite-pilot.lock", config.display());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            super::super::with_deployed_state_lock(
                &lock,
                || async {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(())
                },
                1000,
            )
            .await
            .unwrap();
        });
        entered_rx.await.unwrap();
        let data = root.path().join("data");
        let assets = HookAssets {
            root: data.clone(),
            files: Vec::new(),
        };
        let targets = BTreeMap::from([("config".into(), config.clone())]);
        let task = tokio::spawn(async move {
            assets
                .apply(targets, None, false, |_| {
                    Ok(BTreeMap::from([("config".into(), "{\"new\":true}".into())]))
                })
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !data.join(".hook-assets.lock").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{}");
        assert!(!recovery_pending(&data));
        release_tx.send(()).unwrap();
        blocker.await.unwrap();
        HookAssets {
            root: data,
            files: Vec::new(),
        }
        .apply(
            BTreeMap::from([("config".into(), config.clone())]),
            None,
            false,
            |_| {
                Ok(BTreeMap::from([(
                    "config".into(),
                    "{\"retry\":true}".into(),
                )]))
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(config).unwrap(), "{\"retry\":true}");
    }

    #[tokio::test]
    async fn hook_transaction_external_edit_conflict_preserves_recovery_evidence() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        let assets = HookAssets {
            root: root.path().join("data"),
            files: Vec::new(),
        };
        let targets = BTreeMap::from([("config".into(), config.clone())]);
        let result = assets
            .apply(targets.clone(), None, false, |_| {
                std::fs::write(&config, "{\"user\":true}")?;
                Ok(BTreeMap::from([(
                    "config".into(),
                    "{\"pilot\":true}".into(),
                )]))
            })
            .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{\"user\":true}");
        assert!(recovery_pending(&assets.root));
        assert!(assets
            .apply(targets, None, true, |_| Ok(BTreeMap::new()))
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{\"user\":true}");
    }

    #[test]
    fn destinations_reject_wrong_types_and_path_components() {
        let dir = tempfile::tempdir().unwrap();
        for relative in [
            "../escape.sh",
            "shared/../../escape.sh",
            "C:/escape.sh",
            "shared\\escape.sh",
        ] {
            assert!(
                safe_destination(dir.path(), relative).is_err(),
                "{relative}"
            );
        }
        std::fs::create_dir_all(dir.path().join("hooks/pilot-bin")).unwrap();
        assert!(safe_destination(dir.path(), "pilot-bin").is_err());
        std::fs::write(dir.path().join("hooks/shared"), "not-a-directory").unwrap();
        assert!(safe_destination(dir.path(), "shared/native.sh").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_data_roots_and_binary_pins_are_not_healthy_or_overwritten() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let pilot = root.path().join("candidate");
        seed_development_root(&pilot);
        std::fs::create_dir_all(pilot.join("assets/hooks/shared")).unwrap();
        std::fs::write(pilot.join("assets/hooks/shared/native.sh"), "shared").unwrap();
        std::fs::write(
            pilot.join("assets/hooks/cursor-loongsuite-pilot-hook.sh"),
            "entry",
        )
        .unwrap();
        for link_kind in ["root", "pin", "shared"] {
            let data = root.path().join(link_kind);
            let external = root.path().join(format!("external-{link_kind}"));
            std::fs::create_dir_all(&external).unwrap();
            let mut def: AgentDefinition =
                serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
            def.hook.as_mut().unwrap().hook_command =
                format!("{}/hooks/cursor-loongsuite-pilot-hook.sh", data.display());
            if link_kind == "root" {
                symlink(&external, &data).unwrap();
            } else {
                std::fs::create_dir_all(data.join("hooks")).unwrap();
                if link_kind == "pin" {
                    let target = external.join("pilot-bin");
                    std::fs::write(
                        &target,
                        format!("{}\n", std::env::current_exe().unwrap().display()),
                    )
                    .unwrap();
                    symlink(target, data.join("hooks/pilot-bin")).unwrap();
                } else {
                    symlink(&external, data.join("hooks/shared")).unwrap();
                }
            }
            let before = std::fs::read_dir(&external).unwrap().count();
            assert!(!healthy(&def, &pilot, &data));
            assert!(prepare(&def, &pilot, &data).await.is_err());
            assert!(!data.join("hooks/cursor-loongsuite-pilot-hook.sh").exists());
            assert_eq!(std::fs::read_dir(&external).unwrap().count(), before);
        }
    }

    #[test]
    fn hook_assets_require_manifest_or_explicit_development_layout() {
        let root = tempfile::tempdir().unwrap();
        let pilot = root.path().join("candidate");
        let data = root.path().join("data");
        std::fs::create_dir_all(pilot.join("assets/hooks/shared")).unwrap();
        std::fs::write(pilot.join("assets/hooks/fixture.sh"), "entry").unwrap();
        std::fs::write(pilot.join("assets/hooks/shared/native.sh"), "shared").unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
        def.hook.as_mut().unwrap().hook_command = format!("{}/hooks/fixture.sh", data.display());
        assert!(HookAssets::load(&def, Some(&pilot), &data).is_err());
        std::fs::write(pilot.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::create_dir(pilot.join("src")).unwrap();
        std::fs::write(pilot.join("src/main.rs"), "fn main() {}\n").unwrap();
        assert!(HookAssets::load(&def, Some(&pilot), &data).is_err());
        seed_development_root(&pilot);
        assert!(HookAssets::load(&def, Some(&pilot), &data).is_ok());
        for invalid in [b"broken [".to_vec(), vec![b' '; 4 * 1024 * 1024 + 1]] {
            std::fs::write(pilot.join("runtime-manifest.json"), invalid).unwrap();
            assert!(HookAssets::load(&def, Some(&pilot), &data).is_err());
        }
        assert!(!data.exists());
    }

    #[cfg(unix)]
    #[test]
    fn linked_hook_sources_and_manifest_are_rejected_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let pilot = root.path().join("candidate");
        let data = root.path().join("data");
        seed_development_root(&pilot);
        std::fs::create_dir_all(pilot.join("assets/hooks/shared")).unwrap();
        std::fs::write(pilot.join("assets/hooks/fixture.sh"), "entry").unwrap();
        let external = root.path().join("external");
        std::fs::write(&external, "shared").unwrap();
        std::os::unix::fs::symlink(&external, pilot.join("assets/hooks/shared/native.sh")).unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
        def.hook.as_mut().unwrap().hook_command = format!("{}/hooks/fixture.sh", data.display());
        assert!(HookAssets::load(&def, Some(&pilot), &data).is_err());
        std::fs::remove_file(pilot.join("assets/hooks/shared/native.sh")).unwrap();
        std::fs::write(pilot.join("assets/hooks/shared/native.sh"), "shared").unwrap();
        std::os::unix::fs::symlink(
            root.path().join("missing"),
            pilot.join("runtime-manifest.json"),
        )
        .unwrap();
        assert!(HookAssets::load(&def, Some(&pilot), &data).is_err());
        assert!(!data.exists());
        assert_eq!(std::fs::read_to_string(external).unwrap(), "shared");
    }

    #[tokio::test]
    async fn shared_assets_are_required_and_status_never_repairs() {
        let root = tempfile::tempdir().unwrap();
        let pilot = root.path().join("candidate");
        seed_development_root(&pilot);
        let data = root.path().join("数据 🚀");
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
        def.hook.as_mut().unwrap().hook_command =
            format!("{}/hooks/cursor-loongsuite-pilot-hook.ps1", data.display());
        std::fs::create_dir_all(pilot.join("assets/hooks/shared")).unwrap();
        std::fs::write(
            pilot.join("assets/hooks/cursor-loongsuite-pilot-hook.ps1"),
            "entry",
        )
        .unwrap();
        assert!(prepare(&def, &pilot, &data).await.is_err());
        assert!(!data.exists());
        std::fs::write(pilot.join("assets/hooks/shared/native.ps1"), "shared").unwrap();
        prepare(&def, &pilot, &data).await.unwrap();
        assert!(healthy(&def, &pilot, &data));
        std::fs::write(data.join("hooks/shared/native.ps1"), "tampered").unwrap();
        assert!(!healthy(&def, &pilot, &data));
        assert_eq!(
            std::fs::read_to_string(data.join("hooks/shared/native.ps1")).unwrap(),
            "tampered"
        );
        prepare(&def, &pilot, &data).await.unwrap();
        assert!(healthy(&def, &pilot, &data));
    }
}
