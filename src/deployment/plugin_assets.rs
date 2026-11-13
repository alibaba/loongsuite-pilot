//! 宿主插件运行资源白名单；只从当前候选包读取，不借用工作区或其他安装。

use crate::types::AgentDefinition;
use crate::updater::ActivationTransaction;
use crate::utils::runtime_paths::{resource_file, runtime_metadata, RuntimeManifest};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SHARED: &str = "shared/resource-context.mjs";
const RAW_WRITER: &str = "shared/raw-jsonl-writer.mjs";
const RAW_GATE: &str = "shared/raw-source-gate.mjs";

pub(super) fn recovery_pending(data: &Path) -> bool {
    // 错误、链接和损坏记录均不能作为健康或可卸载状态。
    !matches!(
        std::fs::symlink_metadata(data.join(".plugin-install/update-recovery.json")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound
    )
}

/// 锁顺序固定为安装资源锁 → 配置锁；不同安装编辑同一 Agent 配置也必须串行。
pub(super) async fn with_plugin_locks<T, Fut>(
    data: Option<&Path>,
    config: &Path,
    body: impl FnOnce() -> Fut,
) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    let settings = || async {
        let parent = config.parent().context("插件配置缺少父目录")?;
        std::fs::create_dir_all(parent)?;
        ensure!(runtime_metadata(parent)?.is_dir(), "插件配置父目录无效");
        let mut name = config.as_os_str().to_owned();
        name.push(".loongsuite-pilot.lock");
        let lock = PathBuf::from(name);
        super::with_deployed_state_lock(
            lock.to_str().context("插件配置锁路径编码无效")?,
            body,
            5000,
        )
        .await
    };
    if let Some(data) = data {
        ensure!(runtime_metadata(data)?.is_dir(), "插件数据目录无效");
        let lock = data.join(".plugin-assets.lock");
        super::with_deployed_state_lock(
            lock.to_str().context("插件资源锁路径编码无效")?,
            settings,
            5000,
        )
        .await
    } else {
        settings().await
    }
}

fn bundle(def: &AgentDefinition) -> Result<(&'static str, &'static [&'static str])> {
    match def.id.as_str() {
        "opencode" => Ok((
            "opencode",
            &[
                "opencode/index.js",
                "opencode/package.json",
                "opencode/plugin.mjs",
                "opencode/v2.mjs",
                SHARED,
            ],
        )),
        "mimo-code" => Ok((
            "mimo-code/plugin.mjs",
            &["mimo-code/plugin.mjs", "mimo-code/package.json", SHARED],
        )),
        "pi-coding-agent" => Ok((
            "pi-coding-agent/index.mjs",
            &["pi-coding-agent/index.mjs", SHARED],
        )),
        "openclaw" => Ok((
            "openclaw",
            &[
                "openclaw/plugin.mjs",
                "openclaw/package.json",
                "openclaw/openclaw.plugin.json",
                "openclaw/compatibility.mjs",
                "openclaw/runtime-version.mjs",
                "openclaw/legacy-adapter.mjs",
                "openclaw/legacy-utils.mjs",
                "openclaw/subagent-context.mjs",
                "openclaw/interceptor.mjs",
                "openclaw/first-token.mjs",
                SHARED,
            ],
        )),
        _ if def.pi_sdk.is_some() => Ok((
            "pi-coding-agent/index.mjs",
            &["pi-coding-agent/index.mjs", SHARED],
        )),
        _ => anyhow::bail!("缺少宿主插件资源声明：{}", def.id),
    }
}

fn destination(data: &Path, relative: &str) -> Result<PathBuf> {
    let validate = |path: &Path, directory: bool| -> Result<()> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                let meta = runtime_metadata(path)?;
                ensure!(
                    if directory {
                        meta.is_dir()
                    } else {
                        meta.is_file()
                    },
                    "插件目标路径类型无效：{}",
                    path.display()
                );
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        Ok(())
    };
    validate(data, true)?;
    let mut path = data.to_path_buf();
    let components: Vec<_> = std::iter::once("plugins")
        .chain(relative.split('/'))
        .collect();
    for (index, component) in components.iter().enumerate() {
        ensure!(
            !component.is_empty()
                && *component != "."
                && *component != ".."
                && !component.contains(['\\', ':'])
                && !component.chars().any(char::is_control),
            "插件目标路径无效"
        );
        path.push(component);
        validate(&path, index + 1 < components.len())?;
    }
    Ok(path)
}

struct Asset {
    relative: String,
    content: String,
}

pub(super) struct PluginConfigEdit {
    pub content: String,
    pub backup: bool,
}

/// 所有源文件及摘要先行验证，避免缺少共享依赖时留下半套插件。
pub(super) struct PluginAssets {
    data: PathBuf,
    files: Vec<Asset>,
}

impl PluginAssets {
    pub(super) fn load(def: &AgentDefinition, pilot: &Path, data: &Path) -> Result<Self> {
        let config = def
            .plugin_inject
            .as_ref()
            .context("缺少 pluginInject 配置")?;
        let spec = config
            .plugin_spec
            .replace("$PILOT_DATA", &data.to_string_lossy());
        let raw = spec
            .strip_prefix("file://")
            .unwrap_or(&spec)
            .replace('\\', "/");
        let prefix = format!(
            "{}/plugins/",
            data.to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
        );
        // 非托管外部插件保持原声明语义，不复制到 Pilot 目录。
        let Some(relative) = raw.strip_prefix(&prefix) else {
            ensure!(
                !config.plugin_spec.contains("$PILOT_DATA"),
                "托管插件路径无效"
            );
            return Ok(Self {
                data: data.into(),
                files: Vec::new(),
            });
        };
        let (entry, files) = bundle(def)?;
        if def.pi_sdk.is_some() {
            ensure!(
                relative == format!("pi-coding-agent/agents/{}.mjs", def.id),
                "PI SDK 插件入口无效"
            );
            // 此包装文件由 Rust registry 生成，不能拿静态插件覆盖它。
            resource_file(data, &format!("plugins/{relative}"))?;
        } else {
            // The exact pre-directory OpenCode entry is still an official,
            // verified member of the same bundle. All companion/manifest and
            // source/destination checks below remain mandatory.
            let legacy_opencode_entry = def.id == "opencode"
                && entry == "opencode"
                && relative == "opencode/plugin.mjs"
                && files.contains(&"opencode/plugin.mjs");
            ensure!(
                relative == entry || legacy_opencode_entry,
                "托管插件入口与资源声明不匹配：{}",
                def.id
            );
        }
        let manifest = match std::fs::symlink_metadata(pilot.join("runtime-manifest.json")) {
            Ok(_) => Some(serde_json::from_slice::<RuntimeManifest>(&std::fs::read(
                resource_file(pilot, "runtime-manifest.json")?,
            )?)?),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                ensure!(
                    pilot.join("Cargo.toml").is_file() && pilot.join("src/main.rs").is_file(),
                    "插件资源根缺少 runtime-manifest.json"
                );
                None
            }
            Err(err) => return Err(err.into()),
        };
        let mut loaded = Vec::new();
        let mut pending = files.to_vec();
        let mut index = 0;
        while let Some(&relative) = pending.get(index) {
            index += 1;
            let source = format!("assets/plugins/{relative}");
            let bytes = std::fs::read(resource_file(pilot, &source)?)?;
            if let Some(manifest) = &manifest {
                let entries: Vec<_> = manifest
                    .resources
                    .iter()
                    .filter(|item| item.path == source)
                    .collect();
                ensure!(entries.len() == 1, "插件资源未唯一登记在运行清单：{source}");
                ensure!(
                    entries[0].sha256 == hex::encode(Sha256::digest(&bytes)),
                    "插件资源摘要不匹配：{source}"
                );
            }
            // Historical plugin bundles never imported the shared raw writer.
            // A current entry must carry both verified companion files.
            if !pending.contains(&RAW_WRITER)
                && bytes
                    .windows(RAW_WRITER.len())
                    .any(|part| part == RAW_WRITER.as_bytes())
            {
                pending.extend([RAW_WRITER, RAW_GATE]);
            }
            destination(data, relative)?;
            loaded.push(Asset {
                relative: relative.into(),
                content: String::from_utf8(bytes)?,
            });
        }
        Ok(Self {
            data: data.into(),
            files: loaded,
        })
    }

    pub(super) fn healthy(&self) -> bool {
        self.files.iter().all(|asset| {
            destination(&self.data, &asset.relative).is_ok_and(|path| {
                std::fs::read(path).is_ok_and(|bytes| bytes == asset.content.as_bytes())
            })
        })
    }

    pub(super) fn managed(&self) -> bool {
        !self.files.is_empty()
    }

    fn install_targets(&self, config: &Path) -> Result<BTreeMap<String, PathBuf>> {
        ensure!(self.managed(), "非托管插件没有资源事务");
        let mut targets = BTreeMap::new();
        for asset in &self.files {
            targets.insert(
                format!("asset:{}", asset.relative),
                destination(&self.data, &asset.relative)?,
            );
        }
        targets.insert("config".into(), config.to_path_buf());
        targets.insert(
            "backup".into(),
            PathBuf::from(format!("{}.bak", config.display())),
        );
        Ok(targets)
    }

    fn state_role(&self) -> BTreeMap<String, PathBuf> {
        if !self
            .files
            .iter()
            .any(|asset| asset.relative == "pi-coding-agent/index.mjs")
        {
            return BTreeMap::new();
        }
        BTreeMap::from([(
            "deployment-state".into(),
            self.data.join("deployed-agents.json"),
        )])
    }

    // Optional role is fixed under this installation, never read from journal
    // paths. Legacy schema2 transactions without the role remain recoverable.
    pub(super) fn recover_install(&self, config: &Path) -> Result<()> {
        let directory = self.data.join(".plugin-install");
        if recovery_pending(&self.data) {
            ActivationTransaction::recover_registered(
                &directory,
                &[self.install_targets(config)?],
                &self.state_role(),
            )?;
        }
        Ok(())
    }

    pub(super) async fn recover_config(
        &self,
        config: &Path,
        authorize: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        with_plugin_locks(Some(&self.data), config, || async {
            let state_lock = self.data.join("deployed-agents.json.lock");
            super::with_deployed_state_lock(
                state_lock.to_str().context("invalid state lock path")?,
                || async {
                    authorize()?;
                    self.recover_install(config)
                },
                5000,
            )
            .await
        })
        .await
    }

    fn begin_install(&self, config: &Path) -> Result<ActivationTransaction> {
        self.recover_install(config)?;
        let targets = self.install_targets(config)?;
        let directory = self.data.join(".plugin-install");
        match std::fs::symlink_metadata(&directory) {
            Ok(_) => ensure!(runtime_metadata(&directory)?.is_dir(), "插件恢复目录无效"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&directory)?;
            }
            Err(err) => return Err(err.into()),
        }
        // 全部目标由当前声明和已选配置推导，拒绝恢复记录中的任意其他路径。
        ActivationTransaction::begin(&directory, targets)
    }

    fn prepare(&self, transaction: &mut ActivationTransaction) -> Result<()> {
        for asset in &self.files {
            destination(&self.data, &asset.relative)?;
            let key = format!("asset:{}", asset.relative);
            if transaction.original_bytes(&key)?.as_deref() != Some(asset.content.as_bytes()) {
                transaction.write_preserving_mode(&key, asset.content.as_bytes(), 0o600)?;
            }
        }
        Ok(())
    }

    fn write_config(
        transaction: &mut ActivationTransaction,
        edit: Option<PluginConfigEdit>,
    ) -> Result<()> {
        if let Some(edit) = edit {
            if edit.backup && transaction.original_bytes("backup")?.is_none() {
                if let Some(original) = transaction.original_bytes("config")? {
                    transaction.write("backup", &original, 0o600)?;
                }
            }
            transaction.write_preserving_mode("config", edit.content.as_bytes(), 0o600)?;
        }
        Ok(())
    }

    /// A relocation publishes the config/resources and its fixed state role in
    /// one schema2 transaction, with state written last. Lock order is always
    /// resources -> config -> deployment state.
    pub(super) async fn install_config_and_state<T>(
        &self,
        config: &Path,
        build: impl FnOnce(Option<&str>) -> Result<Option<PluginConfigEdit>>,
        build_state: impl FnOnce(Option<&[u8]>) -> Result<(Vec<u8>, T)>,
    ) -> Result<T> {
        std::fs::create_dir_all(&self.data)?;
        with_plugin_locks(Some(&self.data), config, || async {
            let state_lock = self.data.join("deployed-agents.json.lock");
            super::with_deployed_state_lock(
                state_lock.to_str().context("invalid state lock path")?,
                || async {
                    self.recover_install(config)?;
                    let mut targets = self.install_targets(config)?;
                    targets.extend(self.state_role());
                    let mut transaction =
                        ActivationTransaction::begin(&self.data.join(".plugin-install"), targets)?;
                    let result: Result<T> = (|| {
                        let original = transaction.original_bytes("config")?;
                        let original = original.as_deref().map(std::str::from_utf8).transpose()?;
                        let edit = build(original)?;
                        let state = transaction.original_bytes("deployment-state")?;
                        let (state_bytes, value) = build_state(state.as_deref())?;
                        self.prepare(&mut transaction)?;
                        Self::write_config(&mut transaction, edit)?;
                        transaction.write_preserving_mode(
                            "deployment-state",
                            &state_bytes,
                            0o600,
                        )?;
                        transaction.commit()?;
                        Ok(value)
                    })();
                    match result {
                        Ok(value) => Ok(value),
                        Err(error) => match transaction.rollback() {
                            Ok(()) => Err(error),
                            Err(rollback) => Err(error.context(format!(
                                "plugin relocation rollback failed: {rollback:#}"
                            ))),
                        },
                    }
                },
                5000,
            )
            .await
        })
        .await
    }

    /// 配置、首次备份与全部共享资源使用同一持久事务；恢复完成后重新计算配置变更。
    pub(super) async fn install_config(
        &self,
        config: &Path,
        build: impl FnOnce(Option<&str>) -> Result<Option<PluginConfigEdit>>,
    ) -> Result<()> {
        for asset in &self.files {
            destination(&self.data, &asset.relative)?;
        }
        std::fs::create_dir_all(&self.data)?;
        with_plugin_locks(Some(&self.data), config, || async {
            let state_lock = self.data.join("deployed-agents.json.lock");
            super::with_deployed_state_lock(
                state_lock.to_str().context("invalid state lock path")?,
                || async {
                    let mut transaction = self.begin_install(config)?;
                    let result = (|| {
                        let original = transaction.original_bytes("config")?;
                        let original = original.as_deref().map(std::str::from_utf8).transpose()?;
                        let edit = build(original)?;
                        self.prepare(&mut transaction)?;
                        Self::write_config(&mut transaction, edit)?;
                        transaction.commit()
                    })();
                    if let Err(err) = result {
                        return match transaction.rollback() {
                            Ok(()) => Err(err),
                            Err(rollback) => {
                                Err(err.context(format!("插件配置与资源恢复失败：{rollback:#}")))
                            }
                        };
                    }
                    Ok(())
                },
                5000,
            )
            .await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(id: &str) -> AgentDefinition {
        serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("agents.d/{id}.json")),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn plugin_allowlist_contains_every_relative_import() {
        let imports =
            regex::Regex::new(r#"(?:from\s*|import\s*\(\s*|require\s*\(\s*)[\"'](\.[^\"']+)[\"']"#)
                .unwrap();
        let pilot = Path::new(env!("CARGO_MANIFEST_DIR"));
        for id in ["opencode", "mimo-code", "pi-coding-agent", "openclaw"] {
            let def = definition(id);
            let data = tempfile::tempdir().unwrap();
            let assets = PluginAssets::load(&def, pilot, data.path()).unwrap();
            let files = assets.files.iter().map(|asset| asset.relative.as_str());
            let paths: std::collections::HashSet<_> = files
                .clone()
                .map(|file| {
                    std::fs::canonicalize(
                        resource_file(pilot, &format!("assets/plugins/{file}")).unwrap(),
                    )
                    .unwrap()
                })
                .collect();
            for file in files.filter(|file| file.ends_with(".mjs")) {
                let source = resource_file(pilot, &format!("assets/plugins/{file}")).unwrap();
                let content = std::fs::read_to_string(&source).unwrap();
                for capture in imports.captures_iter(&content) {
                    let dependency =
                        std::fs::canonicalize(source.parent().unwrap().join(&capture[1])).unwrap();
                    assert!(
                        paths.contains(&dependency),
                        "{id}: {file} 的依赖 {} 不在白名单",
                        &capture[1]
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn all_declared_plugin_bundles_deploy_with_shared_dependencies_and_restore() {
        let root = tempfile::tempdir().unwrap();
        for id in ["opencode", "mimo-code", "pi-coding-agent", "openclaw"] {
            let data = root.path().join(id);
            let assets = PluginAssets::load(
                &definition(id),
                Path::new(env!("CARGO_MANIFEST_DIR")),
                &data,
            )
            .unwrap();
            assert!(!assets.healthy());
            assert!(!data.exists());
            let mut transaction = assets.begin_install(&data.join("settings.json")).unwrap();
            assets.prepare(&mut transaction).unwrap();
            assert!(assets.healthy());
            let shared = data.join("plugins").join(SHARED);
            assert!(shared.is_file());
            transaction.rollback().unwrap();
            assert!(!shared.exists());
            assert!(!assets.healthy());
        }
    }

    #[tokio::test]
    async fn changed_assets_restore_old_content_but_never_overwrite_concurrent_changes() {
        let root = tempfile::tempdir().unwrap();
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            root.path(),
        )
        .unwrap();
        let entry = root.path().join("plugins/opencode/plugin.mjs");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "previous").unwrap();
        let mut transaction = assets
            .begin_install(&root.path().join("settings.json"))
            .unwrap();
        assets.prepare(&mut transaction).unwrap();
        transaction.rollback().unwrap();
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), "previous");
        let mut transaction = assets
            .begin_install(&root.path().join("settings.json"))
            .unwrap();
        assets.prepare(&mut transaction).unwrap();
        std::fs::write(&entry, "concurrent").unwrap();
        assert!(transaction.rollback().is_err());
        assert_eq!(std::fs::read_to_string(entry).unwrap(), "concurrent");
    }

    #[tokio::test]
    async fn failed_install_cannot_remove_another_successful_installs_shared_assets() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let load = || {
            PluginAssets::load(
                &definition("opencode"),
                Path::new(env!("CARGO_MANIFEST_DIR")),
                &data,
            )
            .unwrap()
        };
        let first = load();
        let second = load();
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        std::fs::create_dir_all(&data).unwrap();
        let failed = tokio::spawn(async move {
            let lock = first.data.join(".plugin-assets.lock");
            super::super::with_deployed_state_lock::<(), _>(
                &lock.to_string_lossy(),
                || async {
                    let mut transaction = first.begin_install(&first.data.join("settings.json"))?;
                    first.prepare(&mut transaction)?;
                    ready.send(()).unwrap();
                    released.await.unwrap();
                    anyhow::bail!("配置提交失败")
                },
                5000,
            )
            .await
        });
        started.await.unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let seen = entered.clone();
        let succeeded = tokio::spawn(async move {
            second
                .install_config(&second.data.join("settings.json"), |_| {
                    seen.store(true, Ordering::SeqCst);
                    Ok(None)
                })
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        assert!(!entered.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert!(failed.await.unwrap().is_err());
        succeeded.await.unwrap().unwrap();
        assert!(load().healthy());
    }

    #[tokio::test]
    async fn crash_and_cancel_restore_config_backup_and_resources_as_one_unit() {
        for outcome in ["cancel", "crash"] {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("数据 🚀");
            let config = root.path().join("用户配置.jsonc");
            let original = "\u{feff}{ // 用户注释\r\n  \"plugins\": []\r\n}\r\n";
            std::fs::write(&config, original).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o640)).unwrap();
            }
            let assets = PluginAssets::load(
                &definition("opencode"),
                Path::new(env!("CARGO_MANIFEST_DIR")),
                &data,
            )
            .unwrap();
            let mut transaction = assets.begin_install(&config).unwrap();
            assets.prepare(&mut transaction).unwrap();
            PluginAssets::write_config(
                &mut transaction,
                Some(PluginConfigEdit {
                    content: "{\"plugins\":[\"pending\"]}".into(),
                    backup: true,
                }),
            )
            .unwrap();
            assert!(assets.healthy());
            let backup = PathBuf::from(format!("{}.bak", config.display()));
            assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
            if outcome == "cancel" {
                drop(transaction);
            } else {
                std::mem::forget(transaction);
                // 重启后按相同白名单恢复；不从 journal 接受未授权目标。
                let recovered = assets.begin_install(&config).unwrap();
                assert_eq!(
                    recovered.original_bytes("config").unwrap().unwrap(),
                    original.as_bytes()
                );
                drop(recovered);
            }
            assert!(!assets.healthy());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
            assert!(!backup.exists());
            assert!(!data.join(".plugin-install/update-recovery.json").exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&config).unwrap().permissions().mode() & 0o777,
                    0o640
                );
            }
            assets
                .install_config(&config, |raw| {
                    assert_eq!(raw, Some(original));
                    Ok(Some(PluginConfigEdit {
                        content: "{\"plugins\":[\"installed\"]}".into(),
                        backup: true,
                    }))
                })
                .await
                .unwrap();
            assert!(assets.healthy());
            let installed = std::fs::read(&config).unwrap();
            let modified = std::fs::metadata(&config).unwrap().modified().unwrap();
            assets.install_config(&config, |_| Ok(None)).await.unwrap();
            assert_eq!(std::fs::read(&config).unwrap(), installed);
            assert_eq!(
                std::fs::metadata(&config).unwrap().modified().unwrap(),
                modified
            );
            assert_eq!(std::fs::read_to_string(backup).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn external_config_change_preserves_all_recovery_material_and_shared_files() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            root.path(),
        )
        .unwrap();
        let mut transaction = assets.begin_install(&config).unwrap();
        assets.prepare(&mut transaction).unwrap();
        PluginAssets::write_config(
            &mut transaction,
            Some(PluginConfigEdit {
                content: "{\"pending\":true}".into(),
                backup: true,
            }),
        )
        .unwrap();
        std::fs::write(&config, "{\"user\":true}").unwrap();
        assert!(transaction.rollback().is_err());
        std::mem::forget(transaction);
        let result = assets
            .install_config(&config, |_| panic!("冲突未解决时不得执行新部署"))
            .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(config).unwrap(), "{\"user\":true}");
        assert!(assets.healthy());
        assert!(root
            .path()
            .join(".plugin-install/update-recovery.json")
            .exists());
        assert!(root.path().join("settings.json.bak").exists());
    }

    #[tokio::test]
    async fn settings_lock_serializes_different_installations_and_removal() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let (ready, started) = tokio::sync::oneshot::channel();
        let held_config = config.clone();
        let holding = tokio::spawn(async move {
            with_plugin_locks(Some(&first), &held_config, || async {
                ready.send(()).unwrap();
                std::future::pending::<Result<()>>().await
            })
            .await
        });
        started.await.unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let seen = entered.clone();
        let waiting_config = config.clone();
        let waiting = tokio::spawn(async move {
            with_plugin_locks(Some(&second), &waiting_config, || async {
                seen.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        assert!(!entered.load(Ordering::SeqCst));
        holding.abort();
        assert!(holding.await.unwrap_err().is_cancelled());
        waiting.await.unwrap().unwrap();
        assert!(entered.load(Ordering::SeqCst));
        with_plugin_locks(None, &config, || async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{}");
    }

    #[tokio::test]
    async fn production_retry_recovers_complete_but_uncommitted_installation() {
        use super::super::PluginInjectStrategy;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("数据 🚀");
        let config = root.path().join("settings.jsonc");
        let original = "\u{feff}{ // 用户配置\r\n  \"plugin\": [\"user-plugin\"]\r\n}\r\n";
        std::fs::write(&config, original).unwrap();
        let mut def = definition("opencode");
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![config.to_string_lossy().into_owned()];
        let assets =
            PluginAssets::load(&def, Path::new(env!("CARGO_MANIFEST_DIR")), &data).unwrap();
        let mut strategy = PluginInjectStrategy::new(
            data.to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        assert!(strategy.deploy_with(&def).await.success);
        let installed = std::fs::read_to_string(&config).unwrap();
        let backup = PathBuf::from(format!("{}.bak", config.display()));
        std::fs::write(&backup, "用户已有备份").unwrap();
        std::fs::write(&config, original).unwrap();
        let mut transaction = assets.begin_install(&config).unwrap();
        assets.prepare(&mut transaction).unwrap();
        PluginAssets::write_config(
            &mut transaction,
            Some(PluginConfigEdit {
                content: installed.clone(),
                backup: true,
            }),
        )
        .unwrap();
        std::mem::forget(transaction);
        assert!(assets.healthy());
        assert!(strategy.needs_deploy_with(&def, None).await);
        let journal = data.join(".plugin-install/update-recovery.json");
        let evidence = std::fs::read(&journal).unwrap();
        assert!(!strategy.remove_plugin(&def).await);
        assert_eq!(std::fs::read(&journal).unwrap(), evidence);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), installed);
        let result = strategy.deploy_with(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert!(!recovery_pending(&data));
        assert!(!strategy.needs_deploy_with(&def, None).await);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), installed);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "用户已有备份");
        assert!(strategy.remove_plugin(&def).await);
        let cleaned = std::fs::read_to_string(&config).unwrap();
        assert!(cleaned.contains("// 用户配置\r\n"));
        assert!(cleaned.contains("user-plugin"));
        assert!(!cleaned.contains("file://"));
    }

    #[tokio::test]
    async fn concurrent_installs_and_cleanup_preserve_each_others_config_entries() {
        use super::super::PluginInjectStrategy;
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.jsonc");
        let original = "{ // 用户配置\n  \"plugin\": [\"user-plugin\"]\n}\n";
        std::fs::write(&config, original).unwrap();
        let mut def = definition("opencode");
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![config.to_string_lossy().into_owned()];
        let mut first = PluginInjectStrategy::new(
            root.path().join("安装 A").to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let mut second = PluginInjectStrategy::new(
            root.path().join("安装 B").to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let (a, b) = tokio::join!(first.deploy_with(&def), second.deploy_with(&def));
        assert!(a.success, "{:?}", a.error);
        assert!(b.success, "{:?}", b.error);
        assert!(!first.needs_deploy_with(&def, None).await);
        assert!(!second.needs_deploy_with(&def, None).await);
        let (removed, installed) =
            tokio::join!(first.remove_plugin(&def), second.deploy_with(&def));
        assert!(removed);
        assert!(installed.success, "{:?}", installed.error);
        let text = std::fs::read_to_string(&config).unwrap();
        let json =
            crate::utils::parse_json_document(&text, crate::utils::JsonSyntax::Jsonc).unwrap();
        let entries = json["plugin"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], "user-plugin");
        assert_eq!(
            reqwest::Url::parse(entries[1].as_str().unwrap())
                .unwrap()
                .to_file_path()
                .unwrap(),
            root.path().join("安装 B/plugins/opencode")
        );
        assert!(text.contains("// 用户配置"));
        assert_eq!(
            std::fs::read_to_string(format!("{}.bak", config.display())).unwrap(),
            original
        );
        assert!(!second.needs_deploy_with(&def, None).await);
    }

    #[test]
    fn plugin_crash_subprocess_fixture() {
        let Some(root) = std::env::var_os("PILOT_PLUGIN_CRASH_FIXTURE") else {
            return;
        };
        let root = PathBuf::from(root);
        let data = root.join("data");
        let config = root.join("settings.jsonc");
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &data,
        )
        .unwrap();
        let mut transaction = assets.begin_install(&config).unwrap();
        assets.prepare(&mut transaction).unwrap();
        PluginAssets::write_config(
            &mut transaction,
            Some(PluginConfigEdit {
                content: "{\"pending\":true}".into(),
                backup: true,
            }),
        )
        .unwrap();
        // 仅由隔离测试子进程调用；真实进程退出不执行事务 Drop。
        std::process::exit(17);
    }

    #[tokio::test]
    async fn process_exit_preserves_journal_and_official_install_recovers_it() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.jsonc");
        let original = "\u{feff}{ // 用户注释\r\n  \"plugin\": []\r\n}\r\n";
        std::fs::write(&config, original).unwrap();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "deployment::plugin_assets::tests::plugin_crash_subprocess_fixture",
            ])
            .env_clear()
            .env("PILOT_PLUGIN_CRASH_FIXTURE", root.path())
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .current_dir(root.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), command.status())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(17));
        let data = root.path().join("data");
        assert!(recovery_pending(&data));
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "{\"pending\":true}"
        );
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &data,
        )
        .unwrap();
        assets
            .install_config(&config, |raw| {
                assert_eq!(raw, Some(original));
                Ok(None)
            })
            .await
            .unwrap();
        assert!(assets.healthy());
        assert!(!recovery_pending(&data));
        assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
        assert!(!root.path().join("settings.jsonc.bak").exists());
    }

    #[tokio::test]
    async fn pending_installation_rejects_other_target_sets_before_any_write() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            root.path(),
        )
        .unwrap();
        let mut transaction = assets.begin_install(&config).unwrap();
        assets.prepare(&mut transaction).unwrap();
        PluginAssets::write_config(
            &mut transaction,
            Some(PluginConfigEdit {
                content: "{\"pending\":true}".into(),
                backup: true,
            }),
        )
        .unwrap();
        std::mem::forget(transaction);
        let journal = root.path().join(".plugin-install/update-recovery.json");
        let evidence = std::fs::read(&journal).unwrap();
        let other = PluginAssets::load(
            &definition("mimo-code"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            root.path(),
        )
        .unwrap();
        assert!(other
            .install_config(&config, |_| panic!("目标集合不匹配"))
            .await
            .is_err());
        let alternate = root.path().join("other-settings.json");
        assert!(assets
            .install_config(&alternate, |_| panic!("配置路径不匹配"))
            .await
            .is_err());
        assert!(!alternate.exists());
        assert!(!root.path().join("plugins/mimo-code").exists());
        assert_eq!(std::fs::read(&journal).unwrap(), evidence);
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "{\"pending\":true}"
        );
        // 正式入口必须以恢复后的原配置重新计算，而不是复用中断时的配置。
        assets
            .install_config(&config, |raw| {
                assert_eq!(raw, Some("{}"));
                Ok(Some(PluginConfigEdit {
                    content: "{\"complete\":true}".into(),
                    backup: true,
                }))
            })
            .await
            .unwrap();
        assert!(!recovery_pending(root.path()));
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "{\"complete\":true}"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("settings.json.bak")).unwrap(),
            "{}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readonly_config_rolls_back_resources_and_new_backup() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        std::fs::write(&config, "{}").unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o400)).unwrap();
        let assets = PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            root.path(),
        )
        .unwrap();
        assert!(assets
            .install_config(&config, |_| Ok(Some(PluginConfigEdit {
                content: "{\"new\":true}".into(),
                backup: true
            })))
            .await
            .is_err());
        assert!(!assets.healthy());
        assert_eq!(std::fs::read_to_string(config).unwrap(), "{}");
        assert!(!root.path().join("settings.json.bak").exists());
        assert!(!root
            .path()
            .join(".plugin-install/update-recovery.json")
            .exists());
    }

    #[test]
    fn missing_sources_and_unsafe_destinations_fail_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let pilot = root.path().join("candidate");
        std::fs::create_dir_all(pilot.join("assets/plugins/opencode")).unwrap();
        std::fs::write(pilot.join("assets/plugins/opencode/plugin.mjs"), "entry").unwrap();
        assert!(PluginAssets::load(&definition("opencode"), &pilot, &data).is_err());
        assert!(!data.exists());
        std::fs::create_dir_all(data.join("plugins/shared/resource-context.mjs")).unwrap();
        assert!(PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &data
        )
        .is_err());
        assert!(!data.join("plugins/opencode").exists());
        for relative in ["../outside", "a/../../outside", "a\\b", "C:/a"] {
            assert!(destination(&data, relative).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_plugin_roots_are_rejected_without_touching_external_files() {
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        let data = root.path().join("data");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&external, data.join("plugins")).unwrap();
        assert!(PluginAssets::load(
            &definition("opencode"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &data
        )
        .is_err());
        assert_eq!(std::fs::read_dir(external).unwrap().count(), 0);
    }
}

#[cfg(test)]
#[path = "plugin_assets_pi_relocation_tests.rs"]
mod pi_relocation_recovery_tests;
