//! Exact package resource files required under $PILOT_DATA.
//! The append-only role registry bounds recovery; unknown siblings are never scanned or moved.
use crate::updater::activation_file_targets as binding;
use crate::updater::ActivationTransaction;
use crate::utils::runtime_paths::{
    build_edition, build_target, resource_file, runtime_metadata, sha256_file, validate_runtime,
    RuntimeManifest, RuntimeResource,
};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(crate) const SKILLS: &[&str] = &[
    "loongsuite-pilot-ops/SKILL.md",
    "loongsuite-pilot-ops/references/claude-code-diagnostics.md",
    "loongsuite-pilot-ops/references/codex-diagnostics.md",
    "loongsuite-pilot-ops/references/cursor-diagnostics.md",
    "loongsuite-pilot-ops/references/diagnostics.md",
    "loongsuite-pilot-ops/references/monitoring.md",
    "loongsuite-pilot-ops/references/opencode-diagnostics.md",
    "loongsuite-pilot-ops/references/qoder-cn-diagnostics.md",
    "loongsuite-pilot-ops/references/qoder-diagnostics.md",
    "loongsuite-pilot-ops/references/qoder-jetbrains-diagnostics.md",
    "loongsuite-pilot-ops/references/qoder-work-cn-diagnostics.md",
    "loongsuite-pilot-ops/references/qoderwork-diagnostics.md",
    "loongsuite-pilot-ops/references/qwen-code-cli-diagnostics.md",
    "loongsuite-pilot-ops/references/service-diagnostics.md",
    "loongsuite-pilot-ops/references/sls-diagnostics.md",
    "loongsuite-pilot-ops/references/sqlite-diagnostics.md",
    "loongsuite-pilot-ops/references/updater-diagnostics.md",
    "loongsuite-pilot-ops/references/watchdog-diagnostics.md",
    "loongsuite-pilot-ops/references/wukong-diagnostics.md",
];

const NODE_HOOK_ASSETS: &[&str] = &[
    "hooks/codex-loongsuite-pilot-hook.sh",
    "hooks/codex-loongsuite-pilot-hook.ps1",
    "hooks/codex-hook-processor.mjs",
    "hooks/shared/decode-payload.mjs",
    "hooks/shared/error-logger.mjs",
    "hooks/shared/hook-metrics.mjs",
    "hooks/shared/resource-context.mjs",
    "hooks/shared/sync-file-lock.mjs",
    "hooks/shared/upstream-context.mjs",
    "hooks/qoder-loongsuite-pilot-hook.sh",
    "hooks/qoder-loongsuite-pilot-hook.ps1",
    "hooks/interceptor-hook.sh",
    "hooks/interceptor-hook.ps1",
];

const QODER_CLI_WRAPPER: &str = "hooks/qodercli-runtime-wrapper.sh";
const QODER_CLI_PRELOAD: &str = "hooks/qodercli-token-intercept.mjs";

fn executable_hook_asset(relative: &str) -> bool {
    relative == QODER_CLI_WRAPPER
        || (NODE_HOOK_ASSETS.contains(&relative) && !relative.ends_with(".mjs"))
}

fn qoder_cli_asset(relative: &str) -> bool {
    cfg!(unix) && matches!(relative, QODER_CLI_WRAPPER | QODER_CLI_PRELOAD)
}

fn key(relative: &str) -> String {
    format!("{}{relative}", binding::RESOURCE_PREFIX)
}

/// Keep historical roles when package resources change. Recovery accepts only
/// recorded subsets of these exact paths plus a complete caller-supplied base layout.
pub(crate) fn registry(data: &Path, marker: bool) -> BTreeMap<String, PathBuf> {
    let mut paths: BTreeMap<_, _> = SKILLS
        .iter()
        .map(|relative| {
            let relative = format!("skills/{relative}");
            (key(&relative), data.join(&relative))
        })
        .collect();
    for relative in [
        "plugins/dsh/plugin.mjs",
        "plugins/shared/resource-context.mjs",
        "plugins/shared/pilot-config.mjs",
        "plugins/shared/raw-jsonl-writer.mjs",
        "plugins/shared/raw-source-gate.mjs",
        "plugins/shared/private-log-dir.cjs",
    ] {
        paths.insert(key(relative), data.join(relative));
    }
    for relative in NODE_HOOK_ASSETS {
        paths.insert(key(relative), data.join(relative));
    }
    if cfg!(unix) {
        for relative in [QODER_CLI_WRAPPER, QODER_CLI_PRELOAD] {
            paths.insert(key(relative), data.join(relative));
        }
    }
    if marker {
        paths.insert(
            binding::DSH_MARKER.into(),
            data.join("plugins/dsh/.collection-enabled"),
        );
    }
    paths
}

fn source_relative(path: &str) -> Option<&str> {
    path.strip_prefix("assets/").filter(|relative| {
        relative.starts_with("skills/")
            || qoder_cli_asset(relative)
            || matches!(
                *relative,
                "plugins/dsh/plugin.mjs"
                    | "plugins/shared/resource-context.mjs"
                    | "plugins/shared/pilot-config.mjs"
                    | "plugins/shared/raw-jsonl-writer.mjs"
                    | "plugins/shared/raw-source-gate.mjs"
                    | "plugins/shared/private-log-dir.cjs"
            )
    })
}

fn package_version(root: &Path) -> Result<String> {
    let path = resource_file(root, "VERSION")?;
    ensure!(runtime_metadata(&path)?.len() <= 65536, "资源版本文件超限");
    let text = std::fs::read_to_string(path)?;
    let mut versions = text
        .lines()
        .filter_map(|line| line.strip_prefix("version="));
    let version = versions.next().context("资源版本文件缺少 version")?;
    ensure!(
        versions.next().is_none() && semver::Version::parse(version).is_ok(),
        "资源版本文件无效"
    );
    Ok(version.into())
}

// Released Node packages lack a Rust manifest. The current/previous installation
// can establish provenance for existing assets by matching their original bytes.
pub(super) fn installed_node_version(root: &Path) -> Result<Option<String>> {
    if !root.join("package.json").is_file() || !root.join("dist/index.js").is_file() {
        return Ok(None);
    }
    let package = resource_file(root, "package.json")?;
    ensure!(
        runtime_metadata(&package)?.len() <= 64 * 1024,
        "Node 包说明超限"
    );
    let package: serde_json::Value = serde_json::from_slice(&std::fs::read(package)?)?;
    let version = package_version(root)?;
    ensure!(
        package["name"] == "loongsuite-pilot"
            && package["version"] == version
            && semver::Version::parse(&version)?.major == 1,
        "前序 Node Pilot 包身份无效"
    );
    resource_file(root, "dist/index.js")?;
    Ok(Some(version))
}

fn node_release_resources(
    root: &Path,
    requested: &[RuntimeResource],
) -> Result<Vec<RuntimeResource>> {
    if installed_node_version(root)?.is_none() {
        return Ok(Vec::new());
    }
    let mut resources = Vec::new();
    for entry in requested
        .iter()
        .filter(|entry| managed_relative(&entry.path).is_some())
    {
        let candidate = root.join(&entry.path);
        match std::fs::symlink_metadata(candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let path = resource_file(root, &entry.path)?;
        ensure!(
            runtime_metadata(&path)?.len() <= 4 * 1024 * 1024,
            "旧版资源文件超限"
        );
        resources.push(RuntimeResource {
            path: entry.path.clone(),
            sha256: sha256_file(&path)?,
        });
    }
    Ok(resources)
}

fn managed_relative(path: &str) -> Option<&str> {
    source_relative(path).or_else(|| {
        path.strip_prefix("assets/")
            .filter(|relative| NODE_HOOK_ASSETS.contains(relative))
    })
}

pub(super) fn node_rollback_resources(root: &Path, data: &Path) -> Result<Vec<RuntimeResource>> {
    let requested = registry(data, false)
        .keys()
        .filter_map(|key| key.strip_prefix(binding::RESOURCE_PREFIX))
        .map(|relative| RuntimeResource {
            path: format!("assets/{relative}"),
            sha256: String::new(),
        })
        .collect::<Vec<_>>();
    let mut resources = node_release_resources(root, &requested)?;
    let qoder = resource_file(root, "agents.d/qoder.json")?;
    resources.push(RuntimeResource {
        path: "agents.d/qoder.json".into(),
        sha256: sha256_file(&qoder)?,
    });
    Ok(resources)
}

fn trusted_hashes(
    pilot: &Path,
    cache: &Path,
    manifest: &RuntimeManifest,
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut trusted = BTreeMap::<String, BTreeSet<String>>::new();
    let mut add = |source: &[RuntimeResource]| {
        for entry in source {
            if managed_relative(&entry.path).is_some() {
                trusted
                    .entry(entry.path.clone())
                    .or_default()
                    .insert(entry.sha256.to_ascii_lowercase());
            }
        }
    };
    add(&manifest.resources);
    for role in ["current", "previous"] {
        let pointer = cache.join(role);
        match std::fs::symlink_metadata(&pointer) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let meta = runtime_metadata(&pointer)?;
        ensure!(meta.is_file() && meta.len() <= 256, "资源归属版本指针无效");
        let name = std::fs::read_to_string(pointer)?;
        ensure!(
            crate::utils::runtime_paths::safe_component(name.trim()),
            "资源归属版本指针无效"
        );
        let root = cache.join("versions").join(name.trim());
        if !root.join("runtime-manifest.json").exists() {
            if root.is_dir() {
                ensure!(
                    runtime_metadata(&cache.join("versions"))?.is_dir(),
                    "前序安装 versions 不是普通目录"
                );
                add(&node_release_resources(&root, &manifest.resources)?);
            }
            continue;
        }
        if std::fs::canonicalize(&root)? == std::fs::canonicalize(pilot)? {
            continue;
        }
        let version = package_version(&root)?;
        add(&validate_runtime(&root, &version, build_target(), build_edition())?.resources);
    }
    Ok(trusted)
}

fn plain_target(data: &Path, relative: &str) -> Result<(PathBuf, Option<Vec<u8>>)> {
    ensure!(
        data.is_absolute() && runtime_metadata(data)?.is_dir(),
        "资源数据根必须为普通绝对目录"
    );
    let anchor = binding::bind(&data.join(".__pilot_resource_context"))?;
    let expected_root = anchor.parent().context("资源数据根无效")?;
    let mut path = data.to_path_buf();
    let parts: Vec<_> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                let meta = runtime_metadata(&path)?;
                ensure!(
                    if index + 1 == parts.len() {
                        meta.is_file()
                    } else {
                        meta.is_dir()
                    },
                    "资源目标类型无效：{}",
                    path.display()
                );
            }
        }
    }
    let path = binding::bind(&path)?;
    ensure!(
        binding::same(&path, &binding::bind(&expected_root.join(relative))?),
        "资源祖先发生别名变化，保留原文件"
    );
    let original = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
        Ok(_) => {
            let meta = runtime_metadata(&path)?;
            ensure!(
                meta.is_file() && meta.len() <= 4 * 1024 * 1024,
                "资源目标不是有界普通文件"
            );
            let mut bytes = Vec::new();
            std::fs::File::open(&path)?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 4 * 1024 * 1024, "资源目标读取超限");
            Some(bytes)
        }
    };
    Ok((path, original))
}

struct File {
    key: String,
    path: PathBuf,
    bytes: Vec<u8>,
    original: Option<Vec<u8>>,
    executable_repair: bool,
}

impl File {
    fn needs_write(&self) -> bool {
        self.executable_repair || self.original.as_ref() != Some(&self.bytes)
    }
}

pub(crate) struct RuntimeDataAssets {
    files: Vec<File>,
    pub retained_skills: Vec<String>,
    retained_qoder_cli_assets: Vec<String>,
    marker: bool,
}

impl RuntimeDataAssets {
    pub fn load(
        pilot: &Path,
        data: &Path,
        cache: &Path,
        manifest: &RuntimeManifest,
    ) -> Result<Self> {
        let dsh = manifest
            .resources
            .iter()
            .any(|entry| entry.path == "assets/plugins/dsh/plugin.mjs");
        if manifest
            .resources
            .iter()
            .any(|entry| entry.path == "agents.d/dsh.json")
        {
            ensure!(dsh, "DSH 运行资源缺少 plugin.mjs");
        }
        if dsh {
            ensure!(
                manifest
                    .resources
                    .iter()
                    .any(|entry| entry.path == "assets/plugins/shared/resource-context.mjs"),
                "DSH 运行资源缺少共享依赖"
            );
        }
        let roles = registry(data, false);
        let mut inputs = Vec::new();
        for entry in &manifest.resources {
            let relative = if manifest.runtime == "node" {
                managed_relative(&entry.path)
            } else {
                source_relative(&entry.path)
            };
            let Some(relative) = relative else {
                continue;
            };
            if relative
                .split('/')
                .any(|part| part == ".DS_Store" || part.starts_with("._"))
            {
                continue;
            }
            let role = key(relative);
            ensure!(
                roles.contains_key(&role),
                "包包含未登记的运行资源角色：{relative}"
            );
            let source = resource_file(pilot, &entry.path)?;
            ensure!(
                runtime_metadata(&source)?.len() <= 4 * 1024 * 1024,
                "运行资源文件超出事务快照预算"
            );
            let bytes = std::fs::read(source)?;
            ensure!(bytes.len() <= 4 * 1024 * 1024, "运行资源文件读取超限");
            ensure!(
                hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&entry.sha256),
                "运行资源在计划期间被修改：{}",
                entry.path
            );
            inputs.push((role, relative.to_owned(), entry.path.clone(), bytes));
        }
        if inputs.is_empty() {
            return Ok(Self {
                files: Vec::new(),
                retained_skills: Vec::new(),
                retained_qoder_cli_assets: Vec::new(),
                marker: false,
            });
        }
        let trusted = trusted_hashes(pilot, cache, manifest)?;
        let mut files = Vec::new();
        let mut retained_skills = Vec::new();
        let mut retained_qoder_cli_assets = Vec::new();
        for (role, relative, source, bytes) in inputs {
            let qoder_cli = qoder_cli_asset(&relative);
            let optional = relative.starts_with("skills/") || qoder_cli;
            let retained = if qoder_cli {
                &mut retained_qoder_cli_assets
            } else {
                &mut retained_skills
            };
            let target = plain_target(data, &relative);
            let (path, original) = match target {
                Ok(target) => target,
                Err(_) if optional => {
                    retained.push(relative);
                    continue;
                }
                Err(error) => return Err(error),
            };
            let owned = original.as_ref().is_none_or(|old| {
                let digest = hex::encode(Sha256::digest(old));
                trusted
                    .get(&source)
                    .is_some_and(|known| known.contains(&digest))
            });
            if !owned {
                if optional {
                    retained.push(relative);
                    continue;
                }
                anyhow::bail!("必需运行资源含未知或用户修改的文件，拒绝覆盖：{relative}");
            }
            #[cfg(unix)]
            let executable_repair = {
                use std::os::unix::fs::PermissionsExt;
                executable_hook_asset(&relative)
                    && std::fs::metadata(&path)
                        .is_ok_and(|meta| meta.permissions().mode() & 0o100 == 0)
            };
            #[cfg(not(unix))]
            let executable_repair = false;
            if original.as_ref() != Some(&bytes) || executable_repair {
                let writable = binding::writable_parent(&path).and_then(|()| {
                    if original.is_some() {
                        ensure!(
                            !runtime_metadata(&path)?.permissions().readonly(),
                            "运行资源为只读"
                        );
                    }
                    Ok(())
                });
                if let Err(error) = writable {
                    if optional {
                        retained.push(relative);
                        continue;
                    }
                    return Err(error);
                }
            }
            files.push(File {
                key: role,
                path,
                bytes,
                original,
                executable_repair,
            });
        }
        // Each runtime module is one atomic file. Shared dependencies are installed first.
        files.sort_by_key(|file| {
            if file.key.contains("plugins/shared/") {
                0
            } else if file.key.contains("plugins/dsh/") {
                1
            } else {
                2
            }
        });
        Ok(Self {
            files,
            retained_skills,
            retained_qoder_cli_assets,
            marker: dsh,
        })
    }

    pub fn targets(&self, data: &Path, child_marker: bool) -> Result<BTreeMap<String, PathBuf>> {
        let mut targets: BTreeMap<_, _> = self
            .files
            .iter()
            .map(|file| (file.key.clone(), file.path.clone()))
            .collect();
        if child_marker && self.marker {
            let (path, _) = plain_target(data, "plugins/dsh/.collection-enabled")?;
            targets.insert(binding::DSH_MARKER.into(), path);
        }
        Ok(targets)
    }

    pub fn ready(&self) -> bool {
        self.files.iter().all(|file| !file.needs_write())
    }

    pub fn install(
        &self,
        transaction: &mut ActivationTransaction,
        child_marker: bool,
    ) -> Result<()> {
        if child_marker && self.marker {
            transaction.expect_dsh_marker()?;
        }
        for file in &self.files {
            ensure!(
                transaction.original_bytes(&file.key)? == file.original,
                "资源在计划后被并发修改：{}",
                file.key
            );
        }
        for file in &self.files {
            if file.needs_write() {
                if file
                    .key
                    .strip_prefix(binding::RESOURCE_PREFIX)
                    .is_some_and(executable_hook_asset)
                {
                    transaction.write(&file.key, &file.bytes, 0o755)?;
                } else {
                    transaction.write_preserving_mode(&file.key, &file.bytes, 0o644)?;
                }
            }
        }
        Ok(())
    }

    pub fn report(&self) {
        if !self.retained_qoder_cli_assets.is_empty() {
            eprintln!(
                "[runtime-resources] {}",
                serde_json::json!({
                    "preservedQoderCliAssets": self.retained_qoder_cli_assets
                })
            );
        }
        if !self.retained_skills.is_empty() {
            eprintln!(
                "[runtime-resources] {}",
                serde_json::json!({
                    "preservedOptionalSkills":{"count":self.retained_skills.len(),"paths":self.retained_skills}
                })
            );
        }
    }
}

pub(crate) fn recover(
    cache: &Path,
    base: BTreeMap<String, PathBuf>,
    legacy: BTreeMap<String, PathBuf>,
    data: &Path,
    hook_settings: BTreeMap<String, PathBuf>,
) -> Result<()> {
    let mut registered = registry(data, true);
    registered.extend(hook_settings);
    ActivationTransaction::recover_registered(cache, &[base, legacy], &registered)
}

pub(crate) fn recovery_pending(data: &Path) -> bool {
    !matches!(std::fs::symlink_metadata(data.join(".runtime-data-activation/update-recovery.json")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

fn recover_eager_locked(data: &Path) -> Result<()> {
    let directory = data.join(".runtime-data-activation");
    if recovery_pending(data) {
        ensure!(runtime_metadata(&directory)?.is_dir(), "资源恢复目录无效");
        ActivationTransaction::recover_registered(
            &directory,
            &[BTreeMap::new()],
            &registry(data, false),
        )?;
    }
    Ok(())
}

pub(crate) async fn recover_eager(data: &Path) -> Result<()> {
    if !recovery_pending(data) {
        return Ok(());
    }
    let lock = data.join(".runtime-data-activation.lock");
    super::with_deployed_state_lock(
        lock.to_str().context("资源锁路径编码无效")?,
        || async { recover_eager_locked(data) },
        5000,
    )
    .await
}

pub(crate) async fn prepare_eager(pilot: &Path, data: &Path) -> Result<()> {
    if !pilot.join("runtime-manifest.json").exists() {
        ensure!(
            !recovery_pending(data),
            "资源事务待恢复，当前运行入口缺少完整清单"
        );
        return Ok(());
    }
    let version = package_version(pilot)?;
    let manifest = validate_runtime(pilot, &version, build_target(), build_edition())?;
    let cache = std::env::var("LOONGSUITE_PILOT_CACHE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(crate::utils::resolve_home(&value)))
        .or_else(|| {
            pilot
                .parent()
                .filter(|parent| parent.file_name().is_some_and(|name| name == "versions"))
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
        .unwrap_or_else(|| data.to_path_buf());
    let cache = if cache.is_absolute() {
        cache
    } else {
        std::env::current_dir()?.join(cache)
    };
    if !recovery_pending(data) {
        let plan = RuntimeDataAssets::load(pilot, data, &cache, &manifest)?;
        if plan.ready() {
            plan.report();
            return Ok(());
        }
    }
    super::hook_assets::private_directory(&cache)?;
    let update = cache.join("update.lock");
    super::with_deployed_state_lock(
        update.to_str().context("更新锁路径编码无效")?,
        || async {
            let lock = data.join(".runtime-data-activation.lock");
            super::with_deployed_state_lock(
                lock.to_str().context("资源锁路径编码无效")?,
                || async {
                    recover_eager_locked(data)?;
                    let plan = RuntimeDataAssets::load(pilot, data, &cache, &manifest)?;
                    if plan.ready() {
                        plan.report();
                        return Ok(());
                    }
                    let targets = plan.targets(data, false)?;
                    let journal = data.join(".runtime-data-activation");
                    super::hook_assets::private_directory(&journal)?;
                    let mut transaction = ActivationTransaction::begin(&journal, targets)?;
                    plan.install(&mut transaction, false)?;
                    transaction.commit()?;
                    plan.report();
                    Ok(())
                },
                5000,
            )
            .await
        },
        5000,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_unchanged_assets_from_the_installed_node_package() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let old = cache.join("versions/1.17.1_83fc84c");
        let next = temp.path().join("candidate");
        let data = temp.path().join("data");
        let relative = "plugins/shared/pilot-config.mjs";
        let resource = format!("assets/{relative}");
        fs::create_dir_all(old.join("dist")).unwrap();
        fs::write(old.join("dist/index.js"), b"// Node entry").unwrap();
        fs::write(old.join("VERSION"), b"version=1.17.1\n").unwrap();
        fs::write(
            old.join("package.json"),
            br#"{"name":"loongsuite-pilot","version":"1.17.1"}"#,
        )
        .unwrap();
        fs::write(cache.join("current"), b"1.17.1_83fc84c\n").unwrap();
        for (path, contents) in [
            (old.join(&resource), b"// Node release asset".as_slice()),
            (data.join(relative), b"// Node release asset".as_slice()),
            (next.join(&resource), b"// Rust release asset".as_slice()),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        let manifest = RuntimeManifest {
            schema: 1,
            runtime: "rust".into(),
            version: "2.0.0".into(),
            git_commit: "a".repeat(40),
            target: build_target().into(),
            edition: build_edition().into(),
            binary: "bin/loongsuite-pilot".into(),
            resources: vec![RuntimeResource {
                path: resource.clone(),
                sha256: sha256_file(&next.join(&resource)).unwrap(),
            }],
        };
        let plan = RuntimeDataAssets::load(&next, &data, &cache, &manifest).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert!(plan.files[0].needs_write());

        fs::write(data.join(relative), b"// User edit").unwrap();
        assert!(RuntimeDataAssets::load(&next, &data, &cache, &manifest).is_err());
        assert_eq!(fs::read(data.join(relative)).unwrap(), b"// User edit");
    }
}
