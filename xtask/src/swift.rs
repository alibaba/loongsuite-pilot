//! Swift UI 构建与测试仅发生在开发/CI 阶段，安装态只使用预编译产物。

use anyhow::{bail, ensure, Context, Result};
use clap::ValueEnum;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BINARY: &str = "LoongSuitePilotMenuBarApp";
const TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum Arch {
    Arm64,
    X64,
    Universal,
}

impl Arch {
    fn bundle(self) -> &'static str {
        match self {
            Self::Arm64 => "darwin-arm64",
            Self::X64 => "darwin-x64",
            Self::Universal => "darwin-universal",
        }
    }

    fn slices(self) -> &'static [&'static str] {
        match self {
            Self::Arm64 => &["arm64"],
            Self::X64 => &["x86_64"],
            Self::Universal => &["arm64", "x86_64"],
        }
    }
}

pub fn build(
    root: &Path,
    arch: Option<Arch>,
    output: Option<&Path>,
    skip_tests: bool,
) -> Result<()> {
    ensure!(
        cfg!(target_os = "macos"),
        "Swift UI 必须在 macOS 构建；不接受跳过后返回成功"
    );
    let arch = arch.unwrap_or(if cfg!(target_arch = "aarch64") {
        Arch::Arm64
    } else {
        Arch::X64
    });
    let package = root.join("app/macos-status-bar");
    ensure!(
        package.join("Package.swift").is_file(),
        "Swift package 缺失"
    );
    let version = workspace_version(root)?;
    let timestamp = match std::env::var("SOURCE_DATE_EPOCH") {
        Ok(value) => chrono::DateTime::from_timestamp(value.parse::<i64>()?, 0)
            .context("SOURCE_DATE_EPOCH 越界")?,
        Err(std::env::VarError::NotPresent) => chrono::Utc::now(),
        Err(err) => return Err(err.into()),
    };
    let timestamp = timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let build_root = root.join("target/status-bar");
    fs::create_dir_all(&build_root)?;
    let staging = tempfile::Builder::new()
        .prefix("swift-")
        .tempdir_in(build_root)?;
    let staged_package = staging.path().join("package");
    copy_package(&package, &staged_package, &version, &timestamp)?;
    let sdk = query("--show-sdk-path")?;
    let swiftc = query_tool("swiftc")?;
    let swift = query_tool("swift")?;
    let sources = swift_sources(&staged_package.join("Sources").join(BINARY))?;
    if !skip_tests {
        let mut command = Command::new(swift);
        command
            .args(["test", "--package-path"])
            .arg(&staged_package)
            .arg("--scratch-path")
            .arg(staging.path().join("tests"));
        run(&mut command, "Swift 单元测试", TIMEOUT)?;
    }
    let mut binaries = Vec::new();
    for slice in arch.slices() {
        let binary = staging.path().join(format!("{BINARY}-{slice}"));
        let mut command = Command::new(&swiftc);
        command.args(compiler_args(slice, &sdk, &binary, &sources));
        run(&mut command, &format!("Swift {slice} 构建"), TIMEOUT)?;
        ensure!(binary.is_file(), "Swift 编译成功但未生成二进制");
        binaries.push(binary);
    }
    let binary = if binaries.len() == 1 {
        binaries[0].clone()
    } else {
        let combined = staging.path().join(BINARY);
        let mut command = Command::new("/usr/bin/lipo");
        command
            .arg("-create")
            .args(&binaries)
            .arg("-output")
            .arg(&combined);
        run(
            &mut command,
            "Swift universal 合并",
            Duration::from_secs(60),
        )?;
        combined
    };
    let mut verify = Command::new("/usr/bin/lipo");
    verify.arg(&binary).arg("-verify_arch").args(arch.slices());
    run(&mut verify, "Swift 架构校验", Duration::from_secs(30))?;
    let output = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| package.join("bin").join(arch.bundle()).join(BINARY));
    let parent = output.parent().context("输出路径没有父目录")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    fs::copy(&binary, temporary.path())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755))?;
    }
    temporary.persist(&output).map_err(|err| err.error)?;
    println!("Swift UI {version} 已构建：{}", output.display());
    Ok(())
}

pub fn workspace_version(root: &Path) -> Result<String> {
    let manifest: toml::Value = toml::from_str(&fs::read_to_string(root.join("Cargo.toml"))?)?;
    let version = manifest
        .get("package")
        .and_then(|v| v.get("version"))
        .and_then(toml::Value::as_str)
        .context("根 Cargo package.version 缺失")?;
    ensure!(
        !version.is_empty()
            && version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')),
        "Cargo 版本格式无效"
    );
    Ok(version.to_owned())
}

fn copy_package(source: &Path, target: &Path, version: &str, timestamp: &str) -> Result<()> {
    fs::create_dir_all(target)?;
    fs::copy(source.join("Package.swift"), target.join("Package.swift"))?;
    for name in ["Sources", "Tests"] {
        copy_tree(&source.join(name), &target.join(name))?;
    }
    // 临时包中的版本由 Cargo 决定，既不污染源码也不沿用旧 Node 构建时的版本。
    let body = format!(
        "enum BuildInfo {{\n    static let version = {}\n    static let buildTimestamp = {}\n}}\n",
        serde_json::to_string(version)?,
        serde_json::to_string(timestamp)?
    );
    fs::write(
        target.join("Sources").join(BINARY).join("BuildInfo.swift"),
        body,
    )?;
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(source)?.is_dir(),
        "Swift 源目录无效：{}",
        source.display()
    );
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        ensure!(
            !kind.is_symlink(),
            "Swift 源码不允许链接：{}",
            entry.path().display()
        );
        if kind.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        } else {
            ensure!(kind.is_file(), "Swift 源码不是普通文件");
            fs::copy(entry.path(), target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn swift_sources(source: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|v| v == "swift") {
            files.push(entry.path());
        }
    }
    files.sort();
    ensure!(!files.is_empty(), "Swift 源码为空");
    Ok(files)
}

fn compiler_args(arch: &str, sdk: &Path, output: &Path, sources: &[PathBuf]) -> Vec<OsString> {
    let mut args = vec![
        "-O".into(),
        "-target".into(),
        format!("{arch}-apple-macosx13.0").into(),
        "-sdk".into(),
        sdk.as_os_str().to_owned(),
        "-o".into(),
        output.as_os_str().to_owned(),
    ];
    for framework in ["AppKit", "SwiftUI", "Charts", "Combine"] {
        args.extend(["-framework".into(), framework.into()]);
    }
    args.extend(sources.iter().map(|path| path.as_os_str().to_owned()));
    args
}

fn query(flag: &str) -> Result<PathBuf> {
    query_xcrun(&["--sdk", "macosx", flag])
}

fn query_tool(tool: &str) -> Result<PathBuf> {
    query_xcrun(&["--sdk", "macosx", "--find", tool])
}

fn query_xcrun(args: &[&str]) -> Result<PathBuf> {
    let file = tempfile::NamedTempFile::new()?;
    let mut command = Command::new("/usr/bin/xcrun");
    command.args(args).stdout(file.reopen()?);
    run(&mut command, "查询 Xcode 工具链", Duration::from_secs(30))?;
    let path = PathBuf::from(fs::read_to_string(file.path())?.trim());
    ensure!(
        path.is_absolute() && path.exists(),
        "Xcode 返回了无效工具路径"
    );
    Ok(path)
}

fn run(command: &mut Command, label: &str, timeout: Duration) -> Result<()> {
    command.stdin(Stdio::null()).stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .with_context(|| format!("{label} 无法启动"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "{label} 失败：{status}");
            return Ok(());
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{label} 超时");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn architecture_and_unicode_arguments_are_not_shell_strings() {
        assert_eq!(Arch::Universal.slices(), ["arm64", "x86_64"]);
        for (arch, target) in [(Arch::Arm64, "arm64"), (Arch::X64, "x86_64")] {
            assert_eq!(arch.slices(), [target]);
            let source = PathBuf::from("/源码 🚀/App.swift");
            let args = compiler_args(
                target,
                Path::new("/SDK 空格"),
                Path::new("/输出 🚀/app"),
                std::slice::from_ref(&source),
            );
            assert!(args.windows(2).any(|pair| pair
                == [
                    OsString::from("-target"),
                    OsString::from(format!("{target}-apple-macosx13.0"))
                ]));
            assert!(args.contains(&OsString::from("/SDK 空格")));
            assert_eq!(args.last(), Some(&source.into_os_string()));
        }
    }

    #[test]
    fn staging_uses_cargo_version_without_mutating_source() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let source = root.join("app/macos-status-bar");
        let before = fs::read(source.join("Sources").join(BINARY).join("BuildInfo.swift")).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let package = temporary.path().join("package");
        let version = workspace_version(root).unwrap();
        copy_package(&source, &package, &version, "2026-01-01T00:00:00.000Z").unwrap();
        let generated =
            fs::read_to_string(package.join("Sources").join(BINARY).join("BuildInfo.swift"))
                .unwrap();
        assert!(generated.contains(&format!("version = \"{version}\"")));
        assert_eq!(
            fs::read(source.join("Sources").join(BINARY).join("BuildInfo.swift")).unwrap(),
            before
        );
        assert!(package
            .join("Tests/LoongSuitePilotMenuBarAppTests/FormattersTests.swift")
            .is_file());
    }

    #[test]
    fn unsupported_platform_cannot_report_success() {
        if !cfg!(target_os = "macos") {
            let root = tempfile::tempdir().unwrap();
            assert!(build(root.path(), None, None, false).is_err());
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}
