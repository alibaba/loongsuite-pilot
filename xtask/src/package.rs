//! 按原生 target 生成候选包；白名单、包内预检及解包回读共用运行时合同。

use anyhow::{ensure, Context, Result};
use clap::Args;
use loongsuite_pilot::updater::{unpack_release_archive, ArchiveFormat};
use loongsuite_pilot::utils::native_binary::validate_binary;
use loongsuite_pilot::utils::runtime_paths::{
    build_target, resource_file, sha256_file, validate_runtime, RuntimeManifest, RuntimeResource,
    SUPPORTED_TARGETS,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Args)]
pub struct Options {
    #[arg(long)]
    pub target: String,
    #[arg(long)]
    pub binary: PathBuf,
    /// SDK built from the same source/target as the native host.
    #[arg(long)]
    pub sdk_library: Option<PathBuf>,
    #[arg(long)]
    pub commit: String,
    #[arg(long, default_value = "opensource", value_parser = ["opensource", "proprietary"])]
    pub edition: String,
    #[arg(long, default_value = "target/packages")]
    pub output: PathBuf,
    #[arg(long)]
    pub status_bar_binary: Option<PathBuf>,
    /// 仅生成本地开发候选；此标记不得通过发布门禁。
    #[arg(long)]
    pub allow_dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    schema: u32,
    version: String,
    commit: String,
    target: String,
    edition: String,
    archive: String,
    sha256: String,
    dirty: bool,
    preflight: Value,
}

const HOST_ASSETS: &[&str] = &[
    "hooks/claude-code-fetch-intercept.mjs",
    "hooks/qodercli-token-intercept.mjs",
    "hooks/qodercli-runtime-wrapper.sh",
    "hooks/qoderwork-runtime-wrapper.mjs",
    "plugins/dsh/plugin.mjs",
    "plugins/hermes-agent/loongsuite-pilot/__init__.py",
    "plugins/hermes-agent/loongsuite-pilot/plugin.yaml",
    "plugins/mimo-code/plugin.mjs",
    "plugins/mimo-code/package.json",
    "plugins/opencode/plugin.mjs",
    "plugins/opencode/index.js",
    "plugins/opencode/package.json",
    "plugins/opencode/v2.mjs",
    "plugins/pi-coding-agent/index.mjs",
    "plugins/shared/resource-context.mjs",
    "plugins/openclaw/plugin.mjs",
    "plugins/openclaw/package.json",
    "plugins/openclaw/openclaw.plugin.json",
    "plugins/openclaw/compatibility.mjs",
    "plugins/openclaw/runtime-version.mjs",
    "plugins/openclaw/legacy-adapter.mjs",
    "plugins/openclaw/legacy-utils.mjs",
    "plugins/openclaw/subagent-context.mjs",
    "plugins/openclaw/interceptor.mjs",
    "plugins/openclaw/first-token.mjs",
];

pub fn build(root: &Path, options: Options) -> Result<()> {
    ensure!(
        SUPPORTED_TARGETS.contains(&options.target.as_str()),
        "不支持的目标平台"
    );
    ensure!(
        options.commit.len() == 40 && options.commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "必须指定完整提交 SHA"
    );
    let head = git(root, &["rev-parse", "HEAD"])?;
    ensure!(
        head.trim() == options.commit,
        "候选提交必须与当前源码 HEAD 一致"
    );
    let dirty = !git(root, &["status", "--porcelain", "--untracked-files=normal"])?
        .trim()
        .is_empty();
    ensure!(
        !dirty || options.allow_dirty,
        "工作区有未提交修改；本地候选需显式 --allow-dirty，不能作为发布证明"
    );
    let cargo: toml::Value = toml::from_str(&fs::read_to_string(root.join("Cargo.toml"))?)?;
    let version = cargo["package"]["version"]
        .as_str()
        .context("Cargo 版本缺失")?;
    let current = build_target().split('-').collect::<Vec<_>>();
    let target = options.target.split('-').collect::<Vec<_>>();
    ensure!(
        current.first() == target.first() && current.get(2) == target.get(2),
        "必须在目标 OS/架构执行包内预检"
    );
    validate_binary(&options.binary, &options.target)?;
    crate::hooks::sync(root, true)?;
    let files = runtime_files(root, &options.target)?;
    let output = root.join(&options.output);
    fs::create_dir_all(&output)?;
    let output = fs::canonicalize(output)?;
    let name = format!("loongsuite-pilot-{version}-{}", options.target);
    let artifact = output.join(&name);
    ensure!(
        !artifact.exists(),
        "候选产物目录已存在，拒绝覆盖：{}",
        artifact.display()
    );
    let temporary = tempfile::Builder::new()
        .prefix(".package-")
        .tempdir_in(&output)?;
    let staged = temporary.path().join(&name);
    fs::create_dir(&staged)?;
    for relative in files {
        copy(&resource_file(root, &relative)?, &staged.join(relative))?;
    }
    let binary = if options.target.contains("windows") {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    };
    copy(&options.binary, &staged.join(binary))?;
    let sdk_name = if options.target.contains("windows") {
        "loongsuite_pilot.dll"
    } else if options.target.contains("apple") {
        "libloongsuite_pilot.dylib"
    } else {
        "libloongsuite_pilot.so"
    };
    let sdk = options
        .sdk_library
        .clone()
        .unwrap_or_else(|| options.binary.with_file_name(sdk_name));
    loongsuite_pilot::utils::native_binary::validate_shared_library(&sdk, &options.target)
        .context("SDK must be built alongside the native host")?;
    copy(&sdk, &staged.join("bin").join(sdk_name))?;
    executable(&staged.join(binary))?;
    if options.target.contains("apple") {
        let ui = options
            .status_bar_binary
            .as_ref()
            .context("macOS 候选必须包含本架构 Swift UI")?;
        validate_binary(ui, &options.target)?;
        let arch = if options.target.starts_with("aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let dest = staged.join(format!(
            "app/macos-status-bar/bin/darwin-{arch}/LoongSuitePilotMenuBarApp"
        ));
        copy(ui, &dest)?;
        executable(&dest)?;
    } else {
        ensure!(
            options.status_bar_binary.is_none(),
            "非 macOS 包不得附带 Swift UI"
        );
    }
    fs::write(
        staged.join("VERSION"),
        format!("version={version}\ngit_commit={}\n", options.commit),
    )?;
    let resources = registered_files(&staged)?
        .into_iter()
        .map(|relative| {
            Ok(RuntimeResource {
                sha256: sha256_file(&staged.join(&relative))?,
                path: relative,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = RuntimeManifest {
        schema: 1,
        runtime: "rust".into(),
        version: version.into(),
        git_commit: options.commit.clone(),
        target: options.target.clone(),
        edition: options.edition.clone(),
        binary: binary.into(),
        resources,
    };
    fs::write(
        staged.join("runtime-manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    validate_runtime(&staged, version, &options.target, &options.edition)
        .context("暂存包运行时校验失败")?;
    validate_imports(&staged).context("暂存包宿主依赖校验失败")?;
    let format = ArchiveFormat::for_target(&options.target);
    let extension = if format == ArchiveFormat::Zip {
        "zip"
    } else {
        "tar.gz"
    };
    let archive_name = format!("{name}.{extension}");
    let publish = temporary.path().join("artifact");
    fs::create_dir(&publish)?;
    let archive = publish.join(&archive_name);
    archive_package(&staged, &archive, format, &name).context("候选归档生成失败")?;
    let bytes = read_archive(&archive).context("候选归档读取失败")?;
    let unpacked = unpack_release_archive(&bytes, format, temporary.path(), &name)
        .context("候选归档解包回读失败")?;
    validate_runtime(&unpacked.root, version, &options.target, &options.edition)
        .context("解包后运行时校验失败")?;
    let preflight =
        preflight(&unpacked.root, &manifest, temporary.path()).context("解包后原生命令预检失败")?;
    let sha256 = sha256_file(&archive)?;
    let candidate = Candidate {
        schema: 1,
        version: version.into(),
        commit: options.commit,
        target: options.target,
        edition: options.edition,
        archive: archive_name.clone(),
        sha256: sha256.clone(),
        dirty,
        preflight,
    };
    fs::write(
        publish.join("candidate.json"),
        serde_json::to_vec_pretty(&candidate)?,
    )?;
    fs::write(
        publish.join("SHA256SUMS"),
        format!("{sha256}  {archive_name}\n"),
    )?;
    fs::copy(
        staged.join("runtime-manifest.json"),
        publish.join("runtime-manifest.json"),
    )?;
    fs::rename(publish, &artifact)?;
    println!(
        "{}",
        serde_json::to_string(&json!({"artifact": artifact, "candidate": candidate}))?
    );
    Ok(())
}

fn runtime_files(root: &Path, target: &str) -> Result<BTreeSet<String>> {
    let mut files: BTreeSet<_> = crate::hooks::runtime_files().into_iter().collect();
    files.extend(HOST_ASSETS.iter().map(|path| format!("assets/{path}")));
    files.extend(["LICENSE".into(), "assets/dashboard/index.html".into()]);
    files.insert(format!(
        "scripts/loongsuite-pilot.{}",
        if target.contains("windows") {
            "ps1"
        } else {
            "sh"
        }
    ));
    if target.contains("apple") {
        files.insert("assets/dashboard-shortcut/AppIcon.icns".into());
    }
    for entry in fs::read_dir(root.join("agents.d"))? {
        let entry = entry?;
        ensure!(entry.file_type()?.is_file(), "Agent 目录包含非普通文件");
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Agent 文件名不是 UTF-8"))?;
        ensure!(name.ends_with(".json"), "Agent 目录包含非声明文件");
        files.insert(format!("agents.d/{name}"));
    }
    for entry in walkdir::WalkDir::new(root.join("assets/skills/loongsuite-pilot-ops")) {
        let entry = entry?;
        ensure!(!entry.file_type().is_symlink(), "技能资源不允许符号链接");
        if entry.file_type().is_file() {
            ensure!(
                entry.path().extension().is_some_and(|ext| ext == "md"),
                "未知技能资源类型"
            );
            files.insert(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .context("技能路径不是 UTF-8")?
                    .replace('\\', "/"),
            );
        }
    }
    Ok(files)
}

fn copy(source: &Path, destination: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(source)?.file_type().is_file(),
        "来源必须是普通文件：{}",
        source.display()
    );
    fs::create_dir_all(destination.parent().context("目标缺少父目录")?)?;
    fs::copy(source, destination).with_context(|| {
        format!(
            "资源复制失败：{} -> {}",
            source.display(),
            destination.display()
        )
    })?;
    if destination.extension().is_some_and(|ext| ext == "sh") {
        executable(destination)?;
    }
    Ok(())
}

fn executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn registered_files(root: &Path) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    for entry in walkdir::WalkDir::new(root).min_depth(1) {
        let entry = entry?;
        ensure!(!entry.file_type().is_symlink(), "候选包不能包含符号链接");
        if entry.file_type().is_file() {
            files.insert(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .context("候选路径不是 UTF-8")?
                    .replace('\\', "/"),
            );
        } else {
            ensure!(entry.file_type().is_dir(), "候选包不能包含特殊文件");
        }
    }
    Ok(files)
}

fn validate_imports(root: &Path) -> Result<()> {
    let pattern =
        regex::Regex::new(r#"(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.[^'"]+)['"]"#)?;
    let canonical = fs::canonicalize(root)?;
    for relative in registered_files(root)? {
        if !relative.ends_with(".mjs") {
            continue;
        }
        let path = resource_file(root, &relative)?;
        for captures in pattern.captures_iter(&fs::read_to_string(&path)?) {
            let import = path.parent().context("模块缺少父目录")?.join(&captures[1]);
            let resolved = fs::canonicalize(&import)
                .with_context(|| format!("宿主模块依赖缺失：{relative} -> {}", &captures[1]))?;
            ensure!(resolved.starts_with(&canonical), "宿主依赖越出候选包");
            resource_file(
                root,
                resolved
                    .strip_prefix(&canonical)?
                    .to_str()
                    .context("模块路径不是 UTF-8")?
                    .replace('\\', "/")
                    .as_str(),
            )?;
        }
    }
    Ok(())
}

fn archive_package(root: &Path, output: &Path, format: ArchiveFormat, name: &str) -> Result<()> {
    let files = registered_files(root)?;
    let file = File::create(output)?;
    match format {
        ArchiveFormat::TarGz => {
            let encoder = flate2::GzBuilder::new()
                .mtime(0)
                .write(file, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            for relative in files {
                let path = root.join(&relative);
                let mut header = tar::Header::new_ustar();
                header.set_size(fs::metadata(&path)?.len());
                header.set_mode(mode(&relative));
                header.set_uid(0);
                header.set_gid(0);
                header.set_mtime(0);
                header.set_entry_type(tar::EntryType::Regular);
                header.set_path(format!("{name}/{relative}"))?;
                header.set_cksum();
                archive.append(&header, File::open(path)?)?;
            }
            archive.into_inner()?.finish()?.sync_all()?;
        }
        ArchiveFormat::Zip => {
            let mut archive = zip::ZipWriter::new(file);
            for relative in files {
                let options =
                    zip::write::SimpleFileOptions::default().unix_permissions(mode(&relative));
                archive.start_file(format!("{name}/{relative}"), options)?;
                std::io::copy(&mut File::open(root.join(relative))?, &mut archive)?;
            }
            archive.finish()?.sync_all()?;
        }
    }
    Ok(())
}

fn mode(relative: &str) -> u32 {
    if relative.starts_with("bin/")
        || relative.ends_with(".sh")
        || relative.ends_with("/LoongSuitePilotMenuBarApp")
    {
        0o755
    } else {
        0o644
    }
}

fn preflight(root: &Path, manifest: &RuntimeManifest, temporary: &Path) -> Result<Value> {
    let home = temporary.join("预检 HOME 🚀");
    fs::create_dir_all(&home)?;
    let config = home.join("config.json");
    fs::write(&config, br#"{"enabled":false,"autoUpdate":{"enabled":false},"jsonl":{"enabled":false},"http":{"enabled":false},"sls":{"enabled":false},"otlpTrace":{"enabled":false}}"#)?;
    let before_home = snapshot(&home)?;
    let before_package = snapshot(root)?;
    let binary = root.join(&manifest.binary);
    let invoke = |args: &[&str]| -> Result<String> {
        let mut command = Command::new(&binary);
        command
            .args(args)
            .env_clear()
            .current_dir(root)
            .stdin(Stdio::null());
        for key in ["HOME", "USERPROFILE"] {
            command.env(key, &home);
        }
        for key in [
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
        ] {
            command.env(key, home.join(key.to_lowercase()));
        }
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("PATH", home.join("no-runtimes"))
            .env("LOONGSUITE_PILOT_RESOURCE_ROOT", root)
            .env("LOONGSUITE_PILOT_DATA_DIR", home.join("data"))
            .env("LOONGSUITE_PILOT_CACHE_DIR", home.join("cache"))
            .env("AGENT_DATA_COLLECTION_CONFIG", &config);
        run_bounded(&mut command, temporary, Duration::from_secs(30))
            .with_context(|| format!("预检命令失败：{} {}", binary.display(), args.join(" ")))
    };
    ensure!(
        invoke(&["--version"])?.trim() == format!("loongsuite-pilot {}", manifest.version),
        "候选二进制版本不匹配"
    );
    ensure!(
        invoke(&["probe", "--build-edition"])?.trim() == manifest.edition,
        "候选二进制 edition 不匹配"
    );
    let report: Value = serde_json::from_str(&invoke(&["check", "--json"])?)?;
    ensure!(
        report["schema"] == 1
            && report["ok"] == true
            && report["runtime"] == "rust"
            && report["version"] == manifest.version
            && report["target"] == manifest.target
            && report["edition"] == manifest.edition
            && report["check"]["details"]["gitCommit"] == manifest.git_commit,
        "候选包预检未满足运行合同"
    );
    ensure!(
        snapshot(&home)? == before_home,
        "预检修改了隔离 HOME 的文件、目录或权限"
    );
    ensure!(snapshot(root)? == before_package, "预检修改了候选包");
    Ok(report)
}

fn read_archive(path: &Path) -> Result<Vec<u8>> {
    const LIMIT: u64 = 512 * 1024 * 1024;
    ensure!(fs::metadata(path)?.len() <= LIMIT, "候选归档超过下载上限");
    let mut bytes = Vec::new();
    File::open(path)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= LIMIT, "候选归档超过下载上限");
    Ok(bytes)
}

#[derive(Debug, PartialEq, Eq)]
struct SnapshotEntry {
    digest: Option<String>,
    mode: u32,
}

fn snapshot(root: &Path) -> Result<BTreeMap<PathBuf, SnapshotEntry>> {
    let mut entries = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.is_file() || metadata.is_dir(),
            "预检路径不能包含链接或特殊文件"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "预检路径不能包含 reparse point"
            );
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode()
        };
        #[cfg(not(unix))]
        let mode = u32::from(metadata.permissions().readonly());
        let digest = metadata
            .is_file()
            .then(|| sha256_file(entry.path()))
            .transpose()?;
        entries.insert(
            entry.path().strip_prefix(root)?.into(),
            SnapshotEntry { digest, mode },
        );
    }
    Ok(entries)
}

fn read_output(mut file: File) -> Result<String> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024 * 1024, "候选预检输出超限");
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn run_bounded(
    command: &mut Command,
    temporary: &Path,
    timeout: Duration,
) -> Result<String> {
    let stdout = tempfile::tempfile_in(temporary)?;
    let stderr = tempfile::tempfile_in(temporary)?;
    command
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?);
    let mut child = loongsuite_pilot::utils::candidate_process::CandidateChild::spawn(command)
        .context("无法执行原生候选预检")?;
    let start = Instant::now();
    let status = loop {
        ensure!(
            stdout.metadata()?.len() <= 1024 * 1024 && stderr.metadata()?.len() <= 1024 * 1024,
            "候选预检输出超限"
        );
        if let Some(status) = child.try_wait().context("候选退出观察或进程树回收失败")?
        {
            break status;
        }
        ensure!(start.elapsed() < timeout, "候选预检超时");
        std::thread::sleep(Duration::from_millis(10));
    };
    let text = read_output(stdout)?;
    let error = read_output(stderr)?;
    ensure!(
        status.success(),
        "候选预检失败：{status}；stdout={}；stderr={}",
        text.chars().take(4096).collect::<String>(),
        error.chars().take(4096).collect::<String>()
    );
    Ok(text)
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .output()?;
    ensure!(output.status.success(), "无法核对候选提交与源码状态");
    Ok(String::from_utf8(output.stdout)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_musl_target_is_rejected_before_filesystem_or_candidate_execution() {
        let temporary = tempfile::tempdir().unwrap();
        let absent = temporary.path().join("no-source-or-binary");
        let output = temporary.path().join("must-not-be-created");
        for target in ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] {
            let error = build(
                &absent,
                Options {
                    sdk_library: None,
                    target: target.into(),
                    binary: absent.clone(),
                    commit: "a".repeat(40),
                    edition: "opensource".into(),
                    output: output.clone(),
                    status_bar_binary: None,
                    allow_dirty: true,
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("不支持的目标平台"), "{error:#}");
            assert!(!output.exists());
        }
    }

    #[test]
    fn every_supported_package_uses_native_core_binding_and_preserves_only_required_host_runtimes()
    {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        for target in SUPPORTED_TARGETS {
            let files = runtime_files(root, target).unwrap();
            for keep in [
                "assets/hooks/shared/native.sh",
                "assets/hooks/shared/native.ps1",
                "assets/hooks/qodercli-token-intercept.mjs",
                "assets/hooks/qodercli-runtime-wrapper.sh",
                "assets/hooks/qoderwork-runtime-wrapper.mjs",
            ] {
                assert!(files.contains(keep), "{target}: {keep}");
            }
            for retired in [
                "assets/hooks/shared/node-runtime.sh",
                "assets/hooks/shared/common.ps1",
                "scripts/collector-daemon.js",
                "scripts/updater-daemon.js",
            ] {
                assert!(!files.contains(retired), "{target}: {retired}");
            }
        }
    }

    #[test]
    fn whitelist_keeps_host_dependencies_and_excludes_standalone_legacy_tools() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let files = runtime_files(root, SUPPORTED_TARGETS[0]).unwrap();
        for relative in &files {
            assert!(resource_file(root, relative).is_ok(), "{relative}");
        }
        for keep in [
            "assets/hooks/qodercli-token-intercept.mjs",
            "assets/plugins/dsh/plugin.mjs",
            "assets/plugins/hermes-agent/loongsuite-pilot/__init__.py",
        ] {
            assert!(files.contains(keep));
        }
        for legacy in [
            "package.json",
            "Cargo.toml",
            "scripts/collector-daemon.js",
            "assets/plugins/dsh/cleanup.mjs",
            "assets/hooks/cursor-hook-processor.mjs",
        ] {
            assert!(!files.contains(legacy));
        }
        let temp = tempfile::tempdir().unwrap();
        for relative in &files {
            copy(&root.join(relative), &temp.path().join(relative)).unwrap();
        }
        validate_imports(temp.path()).unwrap();
        fs::remove_file(
            temp.path()
                .join("assets/plugins/shared/resource-context.mjs"),
        )
        .unwrap();
        assert!(validate_imports(temp.path()).is_err());
    }

    #[test]
    fn snapshot_detects_content_empty_directory_and_permission_changes() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.json");
        fs::write(&config, "old").unwrap();
        let before = snapshot(root.path()).unwrap();
        fs::write(&config, "new").unwrap();
        assert_ne!(snapshot(root.path()).unwrap(), before);
        fs::write(&config, "old").unwrap();
        assert_eq!(snapshot(root.path()).unwrap(), before);
        fs::create_dir(root.path().join("unexpected")).unwrap();
        assert_ne!(snapshot(root.path()).unwrap(), before);
        fs::remove_dir(root.path().join("unexpected")).unwrap();
        #[cfg(unix)]
        {
            executable(&config).unwrap();
            assert_ne!(snapshot(root.path()).unwrap(), before);
        }
    }

    #[test]
    fn preflight_child_fixture() {
        let Ok(mode) = std::env::var("PILOT_PACKAGE_TEST_CHILD") else {
            return;
        };
        match mode.as_str() {
            "success" => {
                println!("候选正常退出");
            }
            "failure" => {
                eprintln!("候选诊断证据");
                std::process::exit(7);
            }
            "stdout-failure" => {
                println!("{}", json!({"ok":false,"check":{"error":"候选 JSON 诊断"}}));
                std::process::exit(7);
            }
            "output" => {
                print!("{}", "x".repeat(1024 * 1024 + 1));
            }
            "stderr" => {
                eprint!("{}", "x".repeat(1024 * 1024 + 1));
            }
            "wait" => {
                std::thread::sleep(Duration::from_secs(60));
            }
            _ => panic!("未知测试场景"),
        }
    }

    #[test]
    fn bounded_process_preserves_success_without_descendants() {
        let temp = tempfile::tempdir().unwrap();
        for _ in 0..8 {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "package::tests::preflight_child_fixture",
                    "--nocapture",
                ])
                .env("PILOT_PACKAGE_TEST_CHILD", "success");
            let output = run_bounded(&mut command, temp.path(), Duration::from_secs(10)).unwrap();
            assert!(output.contains("候选正常退出"));
        }
    }

    #[test]
    fn bounded_process_reports_failures_and_reaps_timeout_and_excess_output() {
        let temp = tempfile::tempdir().unwrap();
        for mode in ["failure", "stdout-failure", "output", "stderr", "wait"] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "package::tests::preflight_child_fixture",
                    "--nocapture",
                ])
                .env_clear()
                .env("PILOT_PACKAGE_TEST_CHILD", mode)
                .stdin(Stdio::null());
            for key in ["SystemRoot", "WINDIR"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            let timeout = if mode == "wait" {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(10)
            };
            let error = run_bounded(&mut command, temp.path(), timeout)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(match mode {
                    "failure" => "候选诊断证据",
                    "stdout-failure" => "候选 JSON 诊断",
                    "wait" => "超时",
                    _ => "超限",
                }),
                "{mode}: {error}"
            );
        }
    }

    #[test]
    fn deterministic_archives_roundtrip_through_production_extractor() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("source");
        fs::create_dir_all(staged.join("bin")).unwrap();
        fs::write(staged.join("runtime-manifest.json"), "{}").unwrap();
        fs::write(staged.join("bin/pilot"), "native").unwrap();
        for format in [ArchiveFormat::TarGz, ArchiveFormat::Zip] {
            let a = root.path().join("first");
            let b = root.path().join("second");
            archive_package(&staged, &a, format, "pkg").unwrap();
            archive_package(&staged, &b, format, "pkg").unwrap();
            assert_eq!(sha256_file(&a).unwrap(), sha256_file(&b).unwrap());
            let unpacked =
                unpack_release_archive(&fs::read(a).unwrap(), format, root.path(), "pkg").unwrap();
            assert_eq!(
                fs::read(unpacked.root.join("bin/pilot")).unwrap(),
                b"native"
            );
        }
    }
    #[test]
    fn dashboard_shortcut_l99_six_native_packages_keep_real_icon_and_embedded_system_adapter() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let targets = [
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
            "x86_64-apple-darwin",
            "aarch64-apple-darwin",
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
        ];
        let icon = fs::read(root.join("assets/dashboard-shortcut/AppIcon.icns")).unwrap();
        assert!(icon.len() > 8);
        assert_eq!(&icon[..4], b"icns");
        assert_eq!(
            u32::from_be_bytes(icon[4..8].try_into().unwrap()) as usize,
            icon.len()
        );
        let native_source = fs::read_to_string(root.join("src/cli/dashboard_shortcut.rs")).unwrap();
        assert!(
            native_source.contains("include_str!(\"../../scripts/manage-dashboard-shortcut.js\")")
        );
        assert!(native_source.contains("/usr/bin/osascript"));
        let adapter =
            fs::read_to_string(root.join("scripts/manage-dashboard-shortcut.js")).unwrap();
        assert!(adapter.contains("Application") && adapter.contains("ObjC.import"));
        for target in targets {
            assert!(SUPPORTED_TARGETS.contains(&target));
            let files = runtime_files(root, target).unwrap();
            let staged = tempfile::tempdir().unwrap();
            for relative in &files {
                copy(
                    &resource_file(root, relative).unwrap(),
                    &staged.path().join(relative),
                )
                .unwrap();
            }
            let platform_icon = staged.path().join("assets/dashboard-shortcut/AppIcon.icns");
            if target.contains("apple") {
                assert_eq!(fs::read(platform_icon).unwrap(), icon, "{target}");
            } else {
                assert!(!platform_icon.exists(), "{target}");
            }
            assert_eq!(
                fs::read(staged.path().join("assets/dashboard/index.html")).unwrap(),
                fs::read(root.join("assets/dashboard/index.html")).unwrap()
            );
            assert!(files.contains(if target.contains("windows") {
                "scripts/loongsuite-pilot.ps1"
            } else {
                "scripts/loongsuite-pilot.sh"
            }));
            for retired in [
                "scripts/dashboard-shortcut.mjs",
                "scripts/dashboard-cli.mjs",
                "scripts/manage-dashboard-shortcut.js",
                "dist/index.js",
                "node_modules",
            ] {
                assert!(!files.contains(retired), "{target}: {retired}");
            }
        }
    }
}
