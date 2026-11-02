//! 候选包暂存与服务入口同步；不启动服务，不覆盖任何已有版本目录。

use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::updater::ActivationTransaction;
use crate::utils::runtime_paths::{
    build_edition, build_target, resource_file, runtime_metadata, validate_runtime, RuntimeManifest,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallPaths {
    source_dir: PathBuf,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    config_path: PathBuf,
    #[serde(default)]
    bin_dir: Option<PathBuf>,
    #[serde(default)]
    config_options: Option<Value>,
    #[serde(default)]
    deploy_hooks: bool,
}

pub(crate) async fn run(operation: &str, input: Value) -> Result<String> {
    // 反序列化诊断不能回显输入值。
    let paths: InstallPaths =
        serde_json::from_value(input).map_err(|_| anyhow::anyhow!("原生安装路径参数无效"))?;
    for path in [
        &paths.source_dir,
        &paths.cache_dir,
        &paths.data_dir,
        &paths.config_path,
    ]
    .into_iter()
    .map(PathBuf::as_path)
    .chain(paths.bin_dir.as_deref())
    {
        ensure!(path.is_absolute(), "安装路径必须为绝对路径");
        ensure!(
            !path.to_string_lossy().chars().any(char::is_control),
            "安装路径含控制字符"
        );
    }
    ensure!(
        !paths.deploy_hooks || operation == "publish-package",
        "仅发布操作允许部署 Hook"
    );
    ensure!(
        paths.config_options.is_none() || !matches!(operation, "sync-service" | "rollback-package"),
        "服务同步不允许修改配置"
    );
    let rollback_version = (operation == "rollback-package")
        .then(|| rollback_source_version(&paths))
        .transpose()?;
    let manifest = validate_runtime(
        &paths.source_dir,
        rollback_version
            .as_deref()
            .unwrap_or(env!("CARGO_PKG_VERSION")),
        build_target(),
        build_edition(),
    )?;
    let prepared = PreparedConfig::load(&paths)?;
    preflight(&paths, &manifest, prepared.as_ref()).await?;
    private_directory(&paths.cache_dir)?;
    let lock = paths.cache_dir.join("update.lock");
    super::with_deployed_state_lock(
        lock.to_str().context("安装锁路径编码无效")?,
        || async {
            if operation == "stage-package" {
                ensure!(
                    !journal_exists(&paths.cache_dir)?
                        && !journal_exists(&paths.cache_dir.join("service-sync"))?,
                    "存在未完成的更新事务；保留恢复材料，拒绝独立安装写入"
                );
            }
            match operation {
                "stage-package" => Ok(stage(&paths.source_dir, &paths.cache_dir, &manifest)?
                    .file_name()
                    .and_then(|name| name.to_str())
                    .context("候选名称编码无效")?
                    .to_owned()),
                "sync-service" | "publish-package" | "rollback-package" => {
                    let bin = paths.bin_dir.as_deref().context("服务同步缺少 binDir")?;
                    private_directory(bin)?;
                    let destination = bin.join(if cfg!(windows) {
                        "loongsuite-pilot-service.ps1"
                    } else {
                        "loongsuite-pilot"
                    });
                    with_service_lock(&destination, || async {
                        let config_parent = paths.config_path.parent().context("配置缺少父目录")?;
                        private_directory(config_parent)?;
                        let config_lock = paths.config_path.with_extension("json.lock");
                        super::with_deployed_state_lock(
                            config_lock.to_str().context("配置锁路径编码无效")?,
                            || async {
                                let targets = activation_targets(
                                    &paths.cache_dir,
                                    &destination,
                                    &paths.config_path,
                                );
                                recover_runtime_files(&paths.cache_dir, targets.clone())?;
                                let prepared = PreparedConfig::load(&paths)?;
                                if operation == "rollback-package" {
                                    ensure!(rollback_source_version(&paths)? == manifest.version,
                                        "回滚目标在等待锁期间被修改");
                                    validate_runtime(&paths.source_dir, &manifest.version,
                                        build_target(), build_edition())?;
                                }
                                preflight(&paths, &manifest, prepared.as_ref()).await?;
                                check_service_owner(
                                    &destination,
                                    &paths.cache_dir,
                                    &paths.data_dir,
                                )?;
                                let publish = matches!(operation, "publish-package" | "rollback-package");
                                let files = service_files(
                                    &paths.source_dir,
                                    &destination,
                                    &paths.cache_dir,
                                    &paths.data_dir,
                                    &paths.config_path,
                                    publish,
                                )?;
                                if publish {
                                    ensure!(
                                        fs::canonicalize(
                                            paths.source_dir.parent().context("候选缺少父目录")?
                                        )? == fs::canonicalize(paths.cache_dir.join("versions"))?,
                                        "发布候选必须位于本安装 versions 目录"
                                    );
                                }
                                let mut transaction =
                                    ActivationTransaction::begin(&paths.cache_dir, targets)?;
                                if let Some(prepared) = &prepared {
                                    ensure!(
                                        super::installer_helper::read_config(&paths.config_path)?.0
                                            == prepared.original,
                                        "配置被并发修改；已中止发布"
                                    );
                                    transaction.write("config", &prepared.bytes, prepared.mode)?;
                                }
                                if paths.deploy_hooks {
                                    candidate_command(
                                        &paths,
                                        &manifest,
                                        &paths.config_path,
                                        &["hook", "install", "--json"],
                                    )
                                    .await
                                    .context("Hook 部署失败；恢复配置和版本入口")?;
                                }
                                if publish {
                                    let name = paths
                                        .source_dir
                                        .file_name()
                                        .and_then(|v| v.to_str())
                                        .context("候选目录名无效")?;
                                    ensure!(
                                        crate::utils::runtime_paths::safe_component(name),
                                        "候选目录名无效"
                                    );
                                    if let Some(previous) =
                                        read_pointer(&paths.cache_dir.join("current"))?
                                    {
                                        if previous != name {
                                            transaction.write(
                                                "previous",
                                                format!("{previous}\n").as_bytes(),
                                                0o600,
                                            )?;
                                        }
                                    }
                                    transaction.write(
                                        "current",
                                        format!("{name}\n").as_bytes(),
                                        0o600,
                                    )?;
                                }
                                for (key, (bytes, mode)) in files {
                                    transaction.write(&key, &bytes, mode)?;
                                }
                                transaction.commit()?;
                                if let Err(error) = cleanup_legacy_windows_cli(
                                    &destination, &paths.cache_dir, &paths.data_dir,
                                ) {
                                    crate::utils::create_logger("NativeInstall").warn(
                                        "legacy CLI cleanup failed; native publication remains committed",
                                        json!({"error":format!("{error:#}")}).as_object(),
                                    );
                                }
                                Ok(String::new())
                            },
                            5_000,
                        )
                        .await
                    })
                    .await
                }
                _ => anyhow::bail!("未知原生安装操作"),
            }
        },
        5_000,
    )
    .await
}

/// Rollback uses the current helper's validation and container capability
/// gates, while accepting the installed previous native version's own semver.
/// No caller-supplied package can replace the guarded previous pointer.
fn rollback_source_version(paths: &InstallPaths) -> Result<String> {
    ensure!(
        paths.config_options.is_none() && !paths.deploy_hooks,
        "回滚不允许修改配置或重新部署 Hook"
    );
    ensure!(
        runtime_metadata(&paths.cache_dir)?.is_dir()
            && runtime_metadata(&paths.cache_dir.join("versions"))?.is_dir(),
        "回滚安装目录不是普通目录"
    );
    let previous =
        read_pointer(&paths.cache_dir.join("previous"))?.context("没有可回滚的版本指针")?;
    ensure!(
        paths.source_dir == paths.cache_dir.join("versions").join(previous),
        "回滚目标与本安装 previous 指针不匹配"
    );
    let manifest_path = resource_file(&paths.source_dir, "runtime-manifest.json")?;
    let mut bytes = Vec::new();
    fs::File::open(manifest_path)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4 * 1024 * 1024, "回滚运行清单大小超限");
    let manifest: RuntimeManifest = serde_json::from_slice(&bytes).context("回滚运行清单无效")?;
    Ok(manifest.version)
}

pub(super) fn read_pointer(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    ensure!(
        runtime_metadata(path)?.is_file() && fs::metadata(path)?.len() <= 1024,
        "版本指针不是受支持的普通文件"
    );
    let mut value = String::new();
    fs::File::open(path)?
        .take(1025)
        .read_to_string(&mut value)?;
    ensure!(value.len() <= 1024, "版本指针读取超限");
    let value = value.trim_start_matches('\u{feff}').trim();
    ensure!(
        crate::utils::runtime_paths::safe_component(value),
        "版本指针无效；未覆盖原文件"
    );
    Ok(Some(value.to_owned()))
}

fn private_directory(path: &Path) -> Result<()> {
    // 拒绝直接安装目录链接；系统祖先（例如 macOS /var）允许平台正常解析。
    let mut missing = Vec::new();
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                ensure!(
                    runtime_metadata(ancestor)?.is_dir(),
                    "安装父路径不是普通目录"
                );
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing.push(ancestor),
            Err(error) => return Err(error.into()),
        }
    }
    for directory in missing.into_iter().rev() {
        #[cfg(unix)]
        let mut builder = fs::DirBuilder::new();
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(runtime_metadata(directory)?.is_dir(), "安装目录被并发替换");
    }
    Ok(())
}

fn stage(source: &Path, cache: &Path, manifest: &RuntimeManifest) -> Result<PathBuf> {
    let versions = cache.join("versions");
    private_directory(&versions)?;
    // 暂存名称不匹配 updater 的已发布版本 GC 规则，指针发布前不会被并发清走。
    let mut builder = tempfile::Builder::new();
    builder.prefix(".candidate-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let staging = builder.tempdir_in(&versions)?;
    for resource in &manifest.resources {
        let source = resource_file(source, &resource.path)?;
        let destination = staging.path().join(&resource.path);
        private_directory(destination.parent().context("资源缺少父目录")?)?;
        let mut input = fs::File::open(&source)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)?;
        std::io::copy(&mut input, &mut output)?;
        output.set_permissions(runtime_metadata(&source)?.permissions())?;
        output.sync_all()?;
    }
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(staging.path().join("runtime-manifest.json"))?;
    output.write_all(&serde_json::to_vec(manifest)?)?;
    output.sync_all()?;
    validate_runtime(
        staging.path(),
        &manifest.version,
        &manifest.target,
        &manifest.edition,
    )?;
    // TempDir 的根权限始终保持私有；复制失败时自动清理，不留下半个候选包。
    Ok(staging.keep())
}

struct PreparedConfig {
    original: Option<Vec<u8>>,
    bytes: Vec<u8>,
    mode: u32,
}

impl PreparedConfig {
    fn load(paths: &InstallPaths) -> Result<Option<Self>> {
        let Some(value) = &paths.config_options else {
            return Ok(None);
        };
        // Windows 5.1 的嵌套 hashtable 编码不稳定，因此也接受内层 JSON 字符串。
        let value = match value {
            Value::String(raw) => super::installer_helper::parse_json(raw)?,
            value => value.clone(),
        };
        let mut options = super::installer_config::Options::new(value)?;
        for (key, path) in [
            ("dataDir", &paths.data_dir),
            ("configPath", &paths.config_path),
        ] {
            let supplied = options.text(key);
            ensure!(
                supplied.is_empty() || Path::new(&supplied) == path,
                "配置选项与安装路径不匹配"
            );
            options.0.insert(key.into(), json!(path));
        }
        let (original, old) = super::installer_helper::read_config(&paths.config_path)?;
        ensure!(
            !old.get("sls").is_some_and(Value::is_array),
            "安装器不支持修改多个 SLS flusher"
        );
        let next = super::installer_config::merge(&old, &options)?;
        let bytes = super::installer_helper::encode_config(original.as_deref(), &old, &next)?;
        let permissions = if original.is_some() {
            let permissions = runtime_metadata(&paths.config_path)?.permissions();
            ensure!(!permissions.readonly(), "配置为只读；保留原文件");
            Some(permissions)
        } else {
            None
        };
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            permissions.map_or(0o600, |permissions| permissions.mode() & 0o777)
        };
        #[cfg(not(unix))]
        let mode = {
            let _ = permissions;
            0o600
        };
        Ok(Some(Self {
            original,
            bytes,
            mode,
        }))
    }
}

async fn candidate_command(
    paths: &InstallPaths,
    manifest: &RuntimeManifest,
    config: &Path,
    args: &[&str],
) -> Result<String> {
    let binary = resource_file(&paths.source_dir, &manifest.binary)?;
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .current_dir(&paths.source_dir)
        .env("LOONGSUITE_PILOT_RESOURCE_ROOT", &paths.source_dir)
        .env("LOONGSUITE_PILOT_DATA_DIR", &paths.data_dir)
        .env("LOONGSUITE_PILOT_CACHE_DIR", &paths.cache_dir)
        .env("AGENT_DATA_COLLECTION_CONFIG", config)
        .env_remove("LOONGSUITE_PILOT_INSTALL_INPUT")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("LP_") {
            command.env_remove(key);
        }
    }
    let output = crate::utils::candidate_process::output(
        &mut command,
        std::time::Duration::from_secs(30),
        1024 * 1024,
    )
    .await?;
    // 子进程诊断可能包含配置值，不能直接回显。
    ensure!(
        output.status.success(),
        "候选命令执行失败（exit={}）",
        output.status.code().unwrap_or(-1)
    );
    String::from_utf8(output.stdout).context("候选命令输出不是 UTF-8")
}

async fn preflight(
    paths: &InstallPaths,
    manifest: &RuntimeManifest,
    prepared: Option<&PreparedConfig>,
) -> Result<()> {
    let mut preview = None;
    if let Some(prepared) = prepared {
        let mut temporary = tempfile::NamedTempFile::new()?;
        temporary.write_all(&prepared.bytes)?;
        temporary.as_file().sync_all()?;
        preview = Some(temporary);
    }
    let config = preview
        .as_ref()
        .map_or(paths.config_path.as_path(), |file| file.path());
    let mut reports = Vec::new();
    for args in [vec!["--version"], vec!["check", "--json"]] {
        reports.push(candidate_command(paths, manifest, config, &args).await?);
    }
    ensure!(
        reports[0].trim() == format!("loongsuite-pilot {}", manifest.version),
        "候选二进制版本不匹配"
    );
    let report: Value = serde_json::from_str(&reports[1]).context("候选预检报告无效")?;
    ensure!(
        report["schema"] == 1
            && report["ok"] == true
            && report["runtime"] == "rust"
            && report["version"] == manifest.version
            && report["target"] == manifest.target
            && report["edition"] == manifest.edition
            && report["check"]["details"]["gitCommit"] == manifest.git_commit,
        "候选预检报告与安装包不匹配"
    );
    check_container_candidate(&paths.cache_dir, &paths.data_dir, &report)?;
    Ok(())
}

pub(crate) fn check_container_candidate(cache: &Path, data: &Path, report: &Value) -> Result<()> {
    if super::runtime_launcher::RuntimeLauncher::read(cache, data)?.is_some() {
        require_container_runtime_capabilities(report)?;
    }
    Ok(())
}

fn require_container_runtime_capabilities(report: &Value) -> Result<()> {
    let capabilities = &report["check"]["details"]["runtimeCapabilities"];
    ensure!(
        capabilities["containerServiceHelper"].as_u64() == Some(1)
            && capabilities["containerHookPin"].as_u64() == Some(1),
        "候选运行时不支持本安装的容器服务入口与 Hook pin；保留当前版本、入口和配置"
    );
    Ok(())
}

fn journal_exists(cache: &Path) -> Result<bool> {
    match fs::symlink_metadata(cache.join("update-recovery.json")) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn activation_targets(
    cache: &Path,
    destination: &Path,
    config: &Path,
) -> BTreeMap<String, PathBuf> {
    let mut targets = service_targets(destination);
    targets.insert("current".into(), cache.join("current"));
    targets.insert("previous".into(), cache.join("previous"));
    targets.insert("config".into(), config.to_owned());
    targets
}

/// 所有调用者先持有 update.lock，再持有服务目录锁；恢复和健康确认之间不可释放。
pub(crate) async fn with_service_lock<T, Fut>(
    destination: &Path,
    body: impl FnOnce() -> Fut,
) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    let parent = destination.parent().context("服务入口缺少父目录")?;
    private_directory(parent)?;
    let lock = parent.join(".loongsuite-pilot-service.lock");
    super::with_deployed_state_lock(lock.to_str().context("服务锁路径编码无效")?, body, 5000).await
}

/// 兼容已落盘的独立服务事务；后续写入一律使用完整目标集合和同一个 journal。
pub(crate) fn recover_runtime_files(
    cache: &Path,
    targets: BTreeMap<String, PathBuf>,
) -> Result<()> {
    let legacy = cache.join("service-sync");
    ensure!(
        !(journal_exists(cache)? && journal_exists(&legacy)?),
        "存在两个未完成的安装事务；恢复顺序不明确，保留全部恢复材料"
    );
    if journal_exists(&legacy)? {
        let service = targets.get("service").context("恢复目标缺少服务入口")?;
        ActivationTransaction::recover(&legacy, service_targets(service))?;
    }
    let mut legacy_targets = targets.clone();
    legacy_targets.remove("config");
    ActivationTransaction::recover_compatible(cache, targets, legacy_targets)
}

pub(crate) fn cleanup_legacy_windows_cli(
    destination: &Path,
    cache: &Path,
    data: &Path,
) -> Result<bool> {
    super::legacy_cli_cleanup::cleanup(destination, cache, data)
}

pub(crate) fn check_service_owner(destination: &Path, cache: &Path, data: &Path) -> Result<()> {
    let path = destination.with_file_name("loongsuite-pilot-layout.json");
    match fs::symlink_metadata(&path) {
        // 兼容尚未生成 layout 的旧安装；已有 layout 时不允许跨安装接管。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    ensure!(runtime_metadata(&path)?.is_file(), "服务布局不是普通文件");
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 64 * 1024, "服务布局大小超限");
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let layout: Value = serde_json::from_slice(bytes)
        .map_err(|_| anyhow::anyhow!("服务布局损坏；未覆盖现有入口"))?;
    for (key, expected) in [("cacheDir", cache), ("dataDir", data)] {
        let actual = layout
            .get(key)
            .and_then(Value::as_str)
            .context("服务布局缺少安装归属")?;
        ensure!(
            Path::new(actual) == expected,
            "服务入口属于其他安装；拒绝覆盖 {key}"
        );
    }
    Ok(())
}

pub(crate) fn service_targets(destination: &Path) -> BTreeMap<String, PathBuf> {
    let mut targets: BTreeMap<_, _> = [
        ("service".into(), destination.to_owned()),
        (
            "layout".into(),
            destination.with_file_name("loongsuite-pilot-layout.json"),
        ),
    ]
    .into();
    if destination
        .extension()
        .is_some_and(|extension| extension == "ps1")
    {
        targets.insert(
            "launcher".into(),
            destination.with_file_name("loongsuite-pilot.cmd"),
        );
    }
    targets
}

pub(crate) fn service_files(
    root: &Path,
    destination: &Path,
    cache: &Path,
    data: &Path,
    config: &Path,
    activate_source: bool,
) -> Result<BTreeMap<String, (Vec<u8>, u32)>> {
    let windows = destination
        .extension()
        .is_some_and(|extension| extension == "ps1");
    let script = resource_file(
        root,
        if windows {
            "scripts/loongsuite-pilot.ps1"
        } else {
            "scripts/loongsuite-pilot.sh"
        },
    )?;
    let mut bytes = fs::read(script)?;
    if windows {
        if !bytes.starts_with(b"\xef\xbb\xbf") {
            bytes.splice(0..0, [0xef, 0xbb, 0xbf]);
        }
    } else {
        let mut source = std::str::from_utf8(&bytes)
            .context("服务脚本不是 UTF-8")?
            .to_owned();
        if let Some(runtime) = super::runtime_launcher::RuntimeLauncher::read(cache, data)? {
            source = runtime.bind(&source, destination, config, root, activate_source)?;
        }
        let (shebang, rest) = source.split_once('\n').context("服务脚本缺少 shebang")?;
        ensure!(shebang.starts_with("#!"), "服务脚本缺少 shebang");
        let mut bound = format!("{shebang}\n# 本安装的默认路径；显式环境变量优先。\n");
        for (name, path) in [
            ("LOONGSUITE_PILOT_CACHE_DIR", cache),
            ("LOONGSUITE_PILOT_DATA_DIR", data),
            ("AGENT_DATA_COLLECTION_CONFIG", config),
        ] {
            let text = path.to_str().context("服务路径编码无效")?;
            ensure!(!text.chars().any(char::is_control), "服务路径含控制字符");
            let quoted = text.replace('\'', "'\"'\"'");
            bound.push_str(&format!(
                "if [ -z \"${{{name}:-}}\" ]; then export {name}='{quoted}'; fi\n"
            ));
        }
        bound.push_str(rest);
        bytes = bound.into_bytes();
    }
    let mut files: BTreeMap<_, _> = [
        ("service".into(), (bytes, 0o755)),
        (
            "layout".into(),
            (
                serde_json::to_vec_pretty(
                    &json!({"dataDir":data,"cacheDir":cache,"configPath":config}),
                )?,
                0o600,
            ),
        ),
    ]
    .into();
    if windows {
        files.insert("launcher".into(), (b"@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0loongsuite-pilot-service.ps1\" %*\r\n".to_vec(), 0o755));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn container_runtime_requires_both_actual_integer_capabilities() {
        let report = |service: Value, hook: Value| {
            json!({
                "check":{"details":{"runtimeCapabilities":{
                    "containerServiceHelper":service,"containerHookPin":hook
                }}}
            })
        };
        assert!(require_container_runtime_capabilities(&report(json!(1), json!(1))).is_ok());
        for wrong in [
            Value::Null,
            json!(0),
            json!(2),
            json!(-1),
            json!(1.0),
            json!("1"),
            json!(true),
            json!({}),
            json!([]),
        ] {
            assert!(
                require_container_runtime_capabilities(&report(wrong.clone(), json!(1))).is_err()
            );
            assert!(require_container_runtime_capabilities(&report(json!(1), wrong)).is_err());
        }
        for missing in [
            json!({}),
            json!({"check":{"details":{}}}),
            json!({"runtimeCapabilities":{"containerServiceHelper":1,"containerHookPin":1}}),
        ] {
            assert!(require_container_runtime_capabilities(&missing).is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn candidate_output_is_bounded_on_both_streams() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("probe");
        let paths = InstallPaths {
            source_dir: root.path().into(),
            cache_dir: root.path().join("cache"),
            data_dir: root.path().join("data"),
            config_path: root.path().join("config"),
            bin_dir: None,
            config_options: None,
            deploy_hooks: false,
        };
        let manifest: RuntimeManifest = serde_json::from_value(json!({
            "schema":1,"runtime":"rust","version":env!("CARGO_PKG_VERSION"),
            "gitCommit":"a".repeat(40),"target":build_target(),"edition":build_edition(),
            "binary":"probe","resources":[]
        }))
        .unwrap();
        for stream in ["", " >&2"] {
            fs::write(
                &binary,
                format!("#!/bin/sh\nwhile :; do printf '%01024d' 0{stream}; done\n"),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
            let start = std::time::Instant::now();
            let error = candidate_command(&paths, &manifest, &paths.config_path, &[])
                .await
                .unwrap_err();
            assert!(error.to_string().contains("输出超限"));
            assert!(start.elapsed() < std::time::Duration::from_secs(5));
        }
        assert!(!paths.cache_dir.exists());
        assert!(!paths.data_dir.exists());
    }

    #[test]
    fn recovery_restores_config_and_accepts_only_the_known_legacy_layout() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let destination = root.path().join("bin/service");
        let config = root.path().join("config.json");
        fs::create_dir_all(&cache).unwrap();
        let targets = activation_targets(&cache, &destination, &config);
        let mut legacy = targets.clone();
        legacy.remove("config");
        let mut tx = ActivationTransaction::begin(&cache, legacy).unwrap();
        tx.write("current", b"interrupted", 0o600).unwrap();
        std::mem::forget(tx);
        recover_runtime_files(&cache, targets.clone()).unwrap();
        assert!(!cache.join("current").exists());
        fs::write(&config, b"\xef\xbb\xbf{\"keep\":1}\r\n").unwrap();
        let original = fs::read(&config).unwrap();
        let mut tx = ActivationTransaction::begin(&cache, targets.clone()).unwrap();
        tx.write("config", b"{}", 0o600).unwrap();
        tx.write("current", b"new-version", 0o600).unwrap();
        std::mem::forget(tx);
        let other = activation_targets(&cache, &destination, &root.path().join("other-config"));
        assert!(recover_runtime_files(&cache, other).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"{}");
        recover_runtime_files(&cache, targets).unwrap();
        assert_eq!(fs::read(config).unwrap(), original);
        assert!(!cache.join("current").exists());
    }

    #[test]
    fn legacy_service_journal_is_recovered_before_a_new_publication() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let destination = root.path().join("bin/service");
        let legacy = cache.join("service-sync");
        fs::create_dir_all(&legacy).unwrap();
        let mut tx = ActivationTransaction::begin(&legacy, service_targets(&destination)).unwrap();
        tx.write("service", b"interrupted", 0o755).unwrap();
        std::mem::forget(tx); // 模拟进程崩溃，磁盘恢复记录仍在。
        recover_runtime_files(
            &cache,
            activation_targets(&cache, &destination, &root.path().join("config.json")),
        )
        .unwrap();
        assert!(!destination.exists());
        assert!(!legacy.join("update-recovery.json").exists());
        let mut tx = ActivationTransaction::begin(
            &cache,
            activation_targets(&cache, &destination, &root.path().join("config.json")),
        )
        .unwrap();
        tx.write("service", b"next", 0o755).unwrap();
        tx.commit().unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"next");
    }

    #[test]
    fn ambiguous_journals_are_preserved_without_partial_recovery() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let destination = root.path().join("bin/service");
        let legacy = cache.join("service-sync");
        fs::create_dir_all(&legacy).unwrap();
        let mut tx = ActivationTransaction::begin(&legacy, service_targets(&destination)).unwrap();
        tx.write("service", b"interrupted", 0o755).unwrap();
        std::mem::forget(tx);
        let tx = ActivationTransaction::begin(
            &cache,
            activation_targets(&cache, &destination, &root.path().join("config.json")),
        )
        .unwrap();
        std::mem::forget(tx);
        assert!(recover_runtime_files(
            &cache,
            activation_targets(&cache, &destination, &root.path().join("config.json"))
        )
        .is_err());
        assert_eq!(fs::read(destination).unwrap(), b"interrupted");
        assert!(legacy.join("update-recovery.json").exists());
        assert!(cache.join("update-recovery.json").exists());
    }

    #[test]
    fn service_layout_rejects_other_installations_and_invalid_ownership() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("service.ps1");
        let layout = root.path().join("loongsuite-pilot-layout.json");
        let cache = root.path().join("cache");
        let data = root.path().join("data");
        let valid = json!({"cacheDir":cache,"dataDir":data});
        fs::write(&layout, format!("\u{feff}{valid}")).unwrap();
        check_service_owner(&destination, &cache, &data).unwrap();
        assert!(check_service_owner(&destination, &root.path().join("other"), &data).is_err());
        assert!(check_service_owner(&destination, &cache, &root.path().join("other")).is_err());
        for invalid in ["broken", "{}", "[]", "null"] {
            fs::write(&layout, invalid).unwrap();
            assert!(check_service_owner(&destination, &cache, &data).is_err());
            assert_eq!(fs::read_to_string(&layout).unwrap(), invalid);
        }
    }
}
