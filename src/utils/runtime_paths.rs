//! 原生运行资源与发行清单。

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const SUPPORTED_TARGETS: [&str; 6] = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
];

pub fn build_target() -> &'static str {
    target_for(
        std::env::consts::ARCH,
        std::env::consts::OS,
        cfg!(target_env = "gnu"),
        cfg!(target_env = "msvc"),
    )
}

fn target_for(arch: &str, os: &str, gnu: bool, msvc: bool) -> &'static str {
    match (arch, os, gnu, msvc) {
        ("x86_64", "linux", true, _) => SUPPORTED_TARGETS[0],
        ("aarch64", "linux", true, _) => SUPPORTED_TARGETS[1],
        ("x86_64", "macos", _, _) => SUPPORTED_TARGETS[2],
        ("aarch64", "macos", _, _) => SUPPORTED_TARGETS[3],
        ("x86_64", "windows", _, true) => SUPPORTED_TARGETS[4],
        ("aarch64", "windows", _, true) => SUPPORTED_TARGETS[5],
        _ => "unsupported",
    }
}

pub fn build_edition() -> &'static str {
    if crate::core::PROPRIETARY_BUILD {
        "proprietary"
    } else {
        "opensource"
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema: u32,
    pub runtime: String,
    pub version: String,
    pub git_commit: String,
    pub target: String,
    pub edition: String,
    pub binary: String,
    pub resources: Vec<RuntimeResource>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeResource {
    pub path: String,
    pub sha256: String,
}

pub fn resolve_resource_root(
    data_dir: &str,
    explicit: Option<&str>,
    module_roots: &[&str],
) -> Result<PathBuf> {
    let environment = std::env::var("LOONGSUITE_PILOT_RESOURCE_ROOT").ok();
    let cache = std::env::var("LOONGSUITE_PILOT_CACHE_DIR").ok();
    resolve_with(
        Path::new(&super::resolve_home(data_dir)),
        cache
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(super::resolve_home)
            .as_deref()
            .map(Path::new),
        explicit
            .or(environment.as_deref())
            .map(super::resolve_home)
            .as_deref()
            .map(Path::new),
        std::env::current_exe().ok().as_deref(),
        module_roots,
    )
}

fn root_marker(root: &Path) -> bool {
    root.join("runtime-manifest.json").exists() || development_root(root)
}

fn development_root(root: &Path) -> bool {
    root.join("Cargo.toml").is_file()
        && root.join("src/main.rs").is_file()
        && root.join("agents.d").is_dir()
        && root.join("assets").is_dir()
}

fn checked_root(root: &Path) -> Result<PathBuf> {
    ensure!(
        root_marker(root),
        "运行资源根缺少 runtime-manifest.json：{}",
        root.display()
    );
    ensure!(
        root.join("agents.d").is_dir() && root.join("assets").is_dir(),
        "运行资源目录不完整：{}",
        root.display()
    );
    fs::canonicalize(root).context("无法解析运行资源根")
}

fn resolve_with(
    data: &Path,
    cache: Option<&Path>,
    explicit: Option<&Path>,
    exe: Option<&Path>,
    module_roots: &[&str],
) -> Result<PathBuf> {
    if let Some(root) = explicit {
        return checked_root(root);
    }
    if let Some(exe) = exe {
        // 候选二进制使用自己的资源，不能被安装中的 current 指针覆盖。
        for root in exe.ancestors().skip(1).take(2) {
            if root_marker(root) {
                return checked_root(root);
            }
        }
        // 仅识别 Cargo target 目录内的开发二进制，不回退到任意 cwd。
        for root in exe.ancestors().skip(2).take(4) {
            if development_root(root) && exe.starts_with(root.join("target")) {
                return checked_root(root);
            }
        }
    }
    let cache = cache.unwrap_or(data);
    match fs::read_to_string(cache.join("current")) {
        Ok(version) => {
            let version = version.trim();
            ensure!(safe_component(version), "current 版本指针无效");
            let versions = fs::canonicalize(cache.join("versions")).context("版本目录不存在")?;
            let root = checked_root(&versions.join(version))?;
            ensure!(root.starts_with(&versions), "版本指针越出安装目录");
            return Ok(root);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).context("无法读取 current 版本指针"),
    }
    for root in module_roots {
        if root_marker(Path::new(root)) {
            return checked_root(Path::new(root));
        }
    }
    if root_marker(data) {
        return checked_root(data);
    }
    anyhow::bail!("找不到原生运行资源；请设置 LOONGSUITE_PILOT_RESOURCE_ROOT 或修复安装")
}

pub(crate) fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 240
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte))
}

/// 安装边界内禁止符号链接和 Windows junction/reparse point。
pub(crate) fn runtime_metadata(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("无法读取运行路径：{}", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "运行路径不能为符号链接：{}",
        path.display()
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "运行路径不能为 reparse point：{}",
            path.display()
        );
    }
    Ok(metadata)
}

/// 清单始终使用 '/'；拒绝 Windows drive/ADS、dot、空组件及符号链接。
pub fn resource_file(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(runtime_metadata(root)?.is_dir(), "运行资源根不是普通目录");
    ensure!(
        !relative.is_empty()
            && !relative.contains(['\\', ':'])
            && !relative.chars().any(char::is_control),
        "资源路径无效"
    );
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        ensure!(
            !component.is_empty() && component != "." && component != "..",
            "资源路径越界"
        );
        path.push(component);
        runtime_metadata(&path).with_context(|| format!("资源无效：{relative}"))?;
    }
    ensure!(path.is_file(), "资源不是普通文件：{relative}");
    ensure!(
        fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?),
        "资源越出安装目录"
    );
    Ok(path)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

pub fn validate_runtime(
    root: &Path,
    version: &str,
    target: &str,
    edition: &str,
) -> Result<RuntimeManifest> {
    let manifest_path = resource_file(root, "runtime-manifest.json")?;
    let mut manifest_bytes = Vec::new();
    fs::File::open(manifest_path)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut manifest_bytes)?;
    ensure!(manifest_bytes.len() <= 4 * 1024 * 1024, "运行清单大小超限");
    let manifest: RuntimeManifest =
        serde_json::from_slice(&manifest_bytes).context("运行清单格式错误")?;
    ensure!(
        manifest.schema == 1 && manifest.runtime == "rust",
        "不支持的运行清单或非 Rust 包"
    );
    ensure!(
        SUPPORTED_TARGETS.contains(&target) && manifest.target == target,
        "运行清单目标平台不匹配"
    );
    ensure!(
        manifest.version == version
            && semver::Version::parse(version).is_ok()
            && matches!(edition, "opensource" | "proprietary")
            && manifest.edition == edition,
        "运行清单版本或 edition 不匹配"
    );
    ensure!(
        manifest.git_commit.len() == 40
            && manifest
                .git_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "运行清单缺少完整提交 SHA"
    );
    let binary = if target.contains("windows") {
        "bin/loongsuite-pilot.exe"
    } else {
        "bin/loongsuite-pilot"
    };
    ensure!(manifest.binary == binary, "运行清单二进制路径无效");
    // Keep schema 1 and its existing fields: older updaters validate this
    // manifest before executing the candidate. The SDK is a hashed bin resource.
    let sdk = if target.contains("windows") {
        "bin/loongsuite_pilot.dll"
    } else if target.contains("apple") {
        "bin/libloongsuite_pilot.dylib"
    } else {
        "bin/libloongsuite_pilot.so"
    };
    if manifest
        .resources
        .iter()
        .any(|resource| resource.path == sdk)
    {
        super::native_binary::validate_shared_library(&resource_file(root, sdk)?, target)?;
    }
    let mut seen = HashSet::new();
    for resource in &manifest.resources {
        // 各平台使用相同的大小写唯一性规则，避免 Windows 上重复覆盖。
        ensure!(
            seen.insert(resource.path.to_lowercase()),
            "运行清单包含重复资源"
        );
        ensure!(
            resource.path != "runtime-manifest.json",
            "运行清单不能包含自身摘要"
        );
        ensure!(
            resource.sha256.len() == 64
                && resource.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "资源摘要格式无效"
        );
        let path = resource_file(root, &resource.path)?;
        ensure!(
            sha256_file(&path)?.eq_ignore_ascii_case(&resource.sha256),
            "资源摘要不匹配：{}",
            resource.path
        );
    }
    ensure!(
        seen.contains(binary) && seen.contains("version") && seen.contains("license"),
        "运行清单缺少二进制、VERSION 或 LICENSE"
    );
    ensure!(
        manifest
            .resources
            .iter()
            .any(|item| item.path.starts_with("agents.d/"))
            && manifest
                .resources
                .iter()
                .any(|item| item.path.starts_with("assets/")),
        "运行清单缺少 Agent 或 assets 资源"
    );
    let version_file = fs::read_to_string(resource_file(root, "VERSION")?)?;
    let recorded_version = version_file
        .lines()
        .find_map(|line| line.strip_prefix("version="))
        .unwrap_or(version_file.trim());
    ensure!(
        recorded_version.trim() == version,
        "VERSION 与运行清单不匹配"
    );
    // 拒绝未登记的运行文件；不允许测试从工作区补回包内缺失资源。
    let mut disk_paths = HashSet::new();
    for entry in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
        let entry = entry?;
        let metadata = runtime_metadata(entry.path())?;
        ensure!(
            metadata.is_dir() || metadata.is_file(),
            "运行目录包含非普通资源"
        );
        let relative = entry
            .path()
            .strip_prefix(root)?
            .to_str()
            .context("资源路径不是 UTF-8")?
            .replace('\\', "/");
        ensure!(
            disk_paths.insert(relative.to_lowercase()),
            "运行目录包含大小写路径别名：{relative}"
        );
        let top = relative.split('/').next().unwrap_or("");
        ensure!(
            matches!(
                top,
                "bin"
                    | "agents.d"
                    | "assets"
                    | "scripts"
                    | "app"
                    | "VERSION"
                    | "LICENSE"
                    | "runtime-manifest.json"
            ),
            "发行包包含非运行资源：{relative}"
        );
        ensure!(
            !relative
                .split('/')
                .any(|part| part.eq_ignore_ascii_case("node_modules"))
                && !matches!(
                    relative.as_str(),
                    "scripts/collector-daemon.js"
                        | "scripts/updater-daemon.js"
                        | "scripts/postinstall.js"
                ),
            "发行包包含旧运行时：{relative}"
        );
        if metadata.is_file() && relative != "runtime-manifest.json" {
            ensure!(
                manifest.resources.iter().any(|item| item.path == relative),
                "运行文件未登记：{relative}"
            );
        }
    }
    super::native_binary::validate_binary(&resource_file(root, binary)?, target)?;
    Ok(manifest)
}

pub fn is_development_root(root: &Path) -> bool {
    development_root(root) && !root.join("runtime-manifest.json").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(root: &Path) {
        fs::create_dir_all(root.join("agents.d")).unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("runtime-manifest.json"), "{}").unwrap();
    }

    #[test]
    fn platform_selection_never_falls_back_from_non_gnu_linux() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(target_for(arch, "linux", false, false), "unsupported");
            assert_eq!(target_for(arch, "linux", false, true), "unsupported");
            assert!(SUPPORTED_TARGETS.contains(&target_for(arch, "linux", true, false)));
            assert_eq!(target_for(arch, "windows", false, false), "unsupported");
        }
        for (arch, os, gnu, msvc, expected) in [
            ("x86_64", "linux", true, false, SUPPORTED_TARGETS[0]),
            ("aarch64", "linux", true, false, SUPPORTED_TARGETS[1]),
            ("x86_64", "macos", false, false, SUPPORTED_TARGETS[2]),
            ("aarch64", "macos", false, false, SUPPORTED_TARGETS[3]),
            ("x86_64", "windows", false, true, SUPPORTED_TARGETS[4]),
            ("aarch64", "windows", false, true, SUPPORTED_TARGETS[5]),
        ] {
            assert_eq!(target_for(arch, os, gnu, msvc), expected);
        }
        for arch in ["x86", "arm", "riscv64"] {
            assert_eq!(target_for(arch, "linux", true, false), "unsupported");
        }
    }

    #[test]
    fn ci_target_matrix_matches_runtime_support_exactly() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/e2e-injection/targets.json")).unwrap();
        let actual: Vec<_> = manifest["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["target"].as_str().unwrap())
            .collect();
        assert_eq!(actual, SUPPORTED_TARGETS);
    }

    #[test]
    fn candidate_and_explicit_roots_win_over_separate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("数据 🚀");
        let cache = dir.path().join("缓存");
        let installed = cache.join("versions/1.0.0");
        let candidate = dir.path().join("candidate");
        package(&installed);
        package(&candidate);
        fs::write(cache.join("current"), "1.0.0\n").unwrap();
        assert_eq!(
            resolve_with(&data, Some(&cache), None, None, &[]).unwrap(),
            fs::canonicalize(&installed).unwrap()
        );
        assert_eq!(
            resolve_with(
                &data,
                Some(&cache),
                None,
                Some(&candidate.join("bin/loongsuite-pilot")),
                &[]
            )
            .unwrap(),
            fs::canonicalize(&candidate).unwrap()
        );
        assert!(resolve_with(
            &data,
            Some(&cache),
            Some(&dir.path().join("missing")),
            None,
            &[]
        )
        .is_err());
        for bad in ["../candidate", "..", "/tmp", "C:\\temp", "1/2"] {
            fs::write(cache.join("current"), bad).unwrap();
            assert!(resolve_with(&data, Some(&cache), None, None, &[]).is_err());
        }
    }

    #[test]
    fn manifest_rejects_incompatible_incomplete_and_unlisted_resources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        fs::create_dir(root.join("bin")).unwrap();
        let binary = "bin/loongsuite-pilot";
        for (path, text) in [
            (binary, "binary fixture"),
            ("VERSION", "version=1.2.0\n"),
            ("LICENSE", "license"),
            ("agents.d/a.json", "{}"),
            ("assets/hook.sh", "hook"),
        ] {
            fs::write(root.join(path), text).unwrap();
        }
        fs::write(
            root.join(binary),
            super::super::native_binary::fixture_binary(SUPPORTED_TARGETS[0]),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(binary), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let manifest = RuntimeManifest {
            schema: 1,
            runtime: "rust".into(),
            version: "1.2.0".into(),
            git_commit: "a".repeat(40),
            target: SUPPORTED_TARGETS[0].into(),
            edition: "opensource".into(),
            binary: binary.into(),
            resources: [
                binary,
                "VERSION",
                "LICENSE",
                "agents.d/a.json",
                "assets/hook.sh",
            ]
            .iter()
            .map(|path| RuntimeResource {
                path: (*path).into(),
                sha256: sha256_file(&root.join(path)).unwrap(),
            })
            .collect(),
        };
        let original = serde_json::to_value(manifest).unwrap();
        let validate = |value: &serde_json::Value| {
            fs::write(
                root.join("runtime-manifest.json"),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
            validate_runtime(root, "1.2.0", SUPPORTED_TARGETS[0], "opensource")
        };
        assert!(validate(&original).is_ok());
        for (key, value) in [
            ("runtime", "node"),
            ("target", SUPPORTED_TARGETS[1]),
            ("version", "2.0.0"),
            ("edition", "proprietary"),
            ("binary", "dist/index.js"),
            ("gitCommit", "short"),
        ] {
            let mut bad = original.clone();
            bad[key] = value.into();
            assert!(validate(&bad).is_err(), "{key}");
        }
        let mut missing = original.clone();
        missing["resources"].as_array_mut().unwrap().remove(0);
        assert!(validate(&missing).is_err());
        let mut duplicate = original.clone();
        let extra = duplicate["resources"][0].clone();
        duplicate["resources"].as_array_mut().unwrap().push(extra);
        assert!(validate(&duplicate).is_err());
        let mut wrong_digest = original.clone();
        wrong_digest["resources"][0]["sha256"] = "0".repeat(64).into();
        assert!(validate(&wrong_digest).is_err());
        for name in [
            "scripts/loongsuite-pilot.sh",
            "app/ui",
            "extra",
            "dist/index.js",
            "package.json",
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "unlisted").unwrap();
            assert!(validate(&original).is_err(), "{name}");
            fs::remove_file(&path).unwrap();
            if name == "dist/index.js" {
                fs::remove_dir(root.join("dist")).unwrap();
            }
        }
        for name in [
            "dist/index.js",
            "scripts/collector-daemon.js",
            "assets/node_modules/entry.js",
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "legacy").unwrap();
            let mut listed = original.clone();
            listed["resources"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({"path": name, "sha256": sha256_file(&path).unwrap()}));
            assert!(validate(&listed).is_err(), "{name}");
            fs::remove_file(&path).unwrap();
            if name == "dist/index.js" {
                fs::remove_dir(root.join("dist")).unwrap();
            }
            if name.contains("node_modules") {
                fs::remove_dir(root.join("assets/node_modules")).unwrap();
            }
        }
        assert!(validate(&original).is_ok());
        fs::write(root.join("assets/extra"), "unlisted").unwrap();
        assert!(validate(&original).is_err());
    }

    #[test]
    fn rejects_traversal_and_links() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file"), "ok").unwrap();
        assert!(resource_file(dir.path(), "file").is_ok());
        for path in [
            "../file",
            "/file",
            "./file",
            "C:/file",
            "file:ads",
            "file\\other",
            "file/",
        ] {
            assert!(resource_file(dir.path(), path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("file"), dir.path().join("link")).unwrap();
            assert!(resource_file(dir.path(), "link").is_err());
        }
    }
    fn legacy_node_package(root: &Path) {
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::create_dir_all(root.join("agents.d")).unwrap();
        fs::write(root.join("dist/index.js"), "").unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
    }

    #[test]
    fn current_pointer_precedes_module_fallback_even_when_a_legacy_node_package_exists() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let installed = data.join("versions/v2");
        let legacy = data.join("package");
        let module = root.path().join("module");
        package(&installed);
        package(&module);
        legacy_node_package(&legacy);
        fs::write(data.join("current"), "v2\n").unwrap();
        assert_eq!(
            resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).unwrap(),
            fs::canonicalize(&installed).unwrap(),
        );
        assert!(legacy.join("dist/index.js").is_file());
        assert!(module.join("runtime-manifest.json").is_file());
    }

    #[test]
    fn legacy_node_package_does_not_override_complete_native_module_resources() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        legacy_node_package(&data.join("package"));
        let module = root.path().join("native-module");
        package(&module);
        assert_eq!(
            resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).unwrap(),
            fs::canonicalize(&module).unwrap(),
        );
        assert!(resolve_with(&data, None, None, None, &[]).is_err());
        assert!(data.join("package/dist/index.js").is_file());
    }

    #[test]
    fn native_binary_and_cargo_layouts_resolve_their_own_resources_without_module_urls() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        for (label, relative) in [
            ("bin-layout", "bin/loongsuite-pilot"),
            ("root-layout", "loongsuite-pilot"),
        ] {
            let own = root.path().join(label);
            package(&own);
            let exe = own.join(relative);
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(&exe, "candidate path fixture").unwrap();
            assert_eq!(
                resolve_with(&data, None, None, Some(&exe), &[]).unwrap(),
                fs::canonicalize(&own).unwrap()
            );
        }
        for relative in [
            "target/debug/loongsuite-pilot",
            "target/debug/deps/native-test-fixture",
        ] {
            let development = root.path().join(relative.replace('/', "-"));
            fs::create_dir_all(development.join("src")).unwrap();
            fs::create_dir_all(development.join("agents.d")).unwrap();
            fs::create_dir_all(development.join("assets")).unwrap();
            fs::write(development.join("Cargo.toml"), "").unwrap();
            fs::write(development.join("src/main.rs"), "").unwrap();
            let exe = development.join(relative);
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(&exe, "development path fixture").unwrap();
            assert_eq!(
                resolve_with(&data, None, None, Some(&exe), &[]).unwrap(),
                fs::canonicalize(&development).unwrap()
            );
        }
    }

    #[test]
    fn absent_module_markers_use_valid_data_resources_but_incomplete_native_packages_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let module = root.path().join("module");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&module).unwrap();
        assert!(resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).is_err());
        package(&data);
        assert_eq!(
            resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).unwrap(),
            fs::canonicalize(&data).unwrap(),
        );
        for missing in ["agents.d", "assets"] {
            package(&module);
            fs::remove_dir(module.join(missing)).unwrap();
            assert!(
                resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).is_err(),
                "{missing}"
            );
            // The old package.json marker is no longer consulted at all.
            fs::create_dir(module.join(missing)).unwrap();
            assert!(!module.join("package.json").exists());
            assert_eq!(
                resolve_with(&data, None, None, None, &[module.to_str().unwrap()]).unwrap(),
                fs::canonicalize(&module).unwrap(),
            );
        }
    }
}
