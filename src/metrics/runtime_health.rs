//! 原生安装健康检查：只读验证二进制、发行资源及版本指针，不执行或修复宿主运行时。

use crate::utils::runtime_paths::{
    build_edition, build_target, is_development_root, resource_file,
    runtime_metadata as reject_link, validate_runtime, RuntimeManifest,
};
use anyhow::{ensure, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct RuntimeProbe {
    pub exec_path: PathBuf,
    pub cache_dir: Option<PathBuf>,
}

impl RuntimeProbe {
    pub fn system() -> Self {
        Self {
            exec_path: std::env::current_exe().unwrap_or_default(),
            cache_dir: std::env::var("LOONGSUITE_PILOT_CACHE_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| PathBuf::from(crate::utils::resolve_home(&value))),
        }
    }
}

#[derive(Debug)]
pub struct RuntimeHealth {
    pub binary_valid: bool,
    pub diagnostic: Option<String>,
    pub current_version_valid: bool,
    pub rollback_available: bool,
    pub version_count: u64,
}

fn executable(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "原生二进制路径不是绝对路径");
    let metadata = reject_link(path)?;
    ensure!(metadata.is_file(), "原生二进制不是普通文件");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o111 != 0,
            "原生二进制没有执行权限"
        );
    }
    Ok(())
}

fn installed_binary(root: &Path) -> Result<PathBuf> {
    reject_link(root)?;
    let path = resource_file(root, "runtime-manifest.json")?;
    let manifest: RuntimeManifest = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(!manifest.version.trim().is_empty(), "发行版本为空");
    let manifest = validate_runtime(root, &manifest.version, build_target(), build_edition())?;
    let binary = resource_file(root, &manifest.binary)?;
    executable(&binary)?;
    Ok(binary)
}

fn running_binary(probe: &RuntimeProbe) -> Result<bool> {
    executable(&probe.exec_path)?;
    for root in probe.exec_path.ancestors().skip(1).take(2) {
        if root.join("runtime-manifest.json").exists() {
            let binary = installed_binary(root)?;
            ensure!(
                fs::canonicalize(binary)? == fs::canonicalize(&probe.exec_path)?,
                "运行二进制与发行清单不一致"
            );
            return Ok(false);
        }
    }
    for root in probe.exec_path.ancestors().skip(2).take(4) {
        if is_development_root(root) && probe.exec_path.starts_with(root.join("target")) {
            return Ok(true);
        }
    }
    anyhow::bail!("原生二进制缺少所属发行清单")
}

pub fn check_version_pointer(cache: &Path, name: &str) -> Result<PathBuf> {
    ensure!(matches!(name, "current" | "previous"), "版本指针名无效");
    let pointer = cache.join(name);
    ensure!(reject_link(&pointer)?.is_file(), "版本指针不是普通文件");
    let text = fs::read_to_string(&pointer)?;
    let version = text.trim();
    ensure!(
        !version.is_empty()
            && version != "."
            && version != ".."
            && version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')),
        "版本指针格式无效"
    );
    let versions = cache.join("versions");
    ensure!(reject_link(&versions)?.is_dir(), "版本根不是普通目录");
    let root = versions.join(version);
    ensure!(reject_link(&root)?.is_dir(), "版本目录无效");
    installed_binary(&root).context("版本指针指向的原生发行包无效")?;
    Ok(root)
}

pub fn check_runtime(data: &Path, probe: &RuntimeProbe) -> RuntimeHealth {
    let cache = probe.cache_dir.as_deref().unwrap_or(data);
    let running = running_binary(probe);
    let binary_valid = running.is_ok();
    let development = matches!(&running, Ok(true));
    let versions = cache.join("versions");
    let version_count = reject_link(&versions)
        .and_then(|meta| {
            ensure!(meta.is_dir(), "版本根不是普通目录");
            Ok(fs::read_dir(&versions)?)
        })
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    !entry.file_name().to_string_lossy().starts_with('.')
                        && reject_link(&entry.path()).is_ok_and(|meta| meta.is_dir())
                })
                .count() as u64
        })
        .unwrap_or(0);
    // 只有确定不存在才视作便携模式；悬空链接、无权限等均不能被当成缺省。
    let absent = |path: &Path| matches!(fs::symlink_metadata(path), Err(err) if err.kind() == std::io::ErrorKind::NotFound);
    let managed = !absent(&cache.join("current")) || !absent(&versions);
    // 便携包与 Cargo 开发态无须版本指针；安装态缺失或损坏指针必须报告失败。
    let current_version_valid = if managed {
        check_version_pointer(cache, "current").is_ok()
    } else {
        development || (binary_valid && !probe.exec_path.starts_with(cache.join("versions")))
    };
    RuntimeHealth {
        binary_valid,
        diagnostic: running.err().map(|error| format!("{error:#}")),
        current_version_valid,
        rollback_available: check_version_pointer(cache, "previous").is_ok(),
        version_count,
    }
}

pub fn read_init_type(data: &str) -> String {
    fs::read_to_string(Path::new(data).join("init-type"))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::runtime_paths::{sha256_file, RuntimeResource};

    fn package(root: &Path) -> PathBuf {
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        let mut resources = Vec::new();
        for (relative, text) in [
            (binary, "native fixture"),
            ("VERSION", "version=1.2.0\n"),
            ("LICENSE", "license"),
            ("agents.d/fixture.json", "{}"),
            ("assets/fixture", "resource"),
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if relative == binary {
                fs::write(
                    &path,
                    crate::utils::native_binary::fixture_binary(build_target()),
                )
                .unwrap();
            } else {
                fs::write(&path, text).unwrap();
            }
            resources.push(RuntimeResource {
                path: relative.into(),
                sha256: sha256_file(&path).unwrap(),
            });
        }
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
            target: build_target().into(),
            edition: build_edition().into(),
            binary: binary.into(),
            resources,
        };
        fs::write(
            root.join("runtime-manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        root.join(binary)
    }

    #[test]
    fn split_cache_and_binary_integrity_are_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("数据 🚀");
        let cache = temp.path().join("cache 空格");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("node-bin"), "/missing/legacy-node\n").unwrap();
        fs::write(data.join("current"), "../../unrelated").unwrap();
        let root = cache.join("versions/1.2.0_abc");
        let probe = RuntimeProbe {
            exec_path: package(&root),
            cache_dir: Some(cache.clone()),
        };
        fs::write(cache.join("current"), "1.2.0_abc\n").unwrap();
        fs::write(cache.join("previous"), "1.2.0_abc\n").unwrap();
        fs::write(cache.join("versions/not-a-directory"), "ignored").unwrap();
        let health = check_runtime(&data, &probe);
        assert!(health.binary_valid && health.current_version_valid && health.rollback_available);
        assert_eq!(health.version_count, 1);
        fs::write(root.join("assets/fixture"), "tampered").unwrap();
        let health = check_runtime(&data, &probe);
        assert!(
            !health.binary_valid && !health.current_version_valid && !health.rollback_available
        );
        assert!(health.diagnostic.unwrap().contains("摘要不匹配"));
        assert_eq!(
            fs::read_to_string(data.join("node-bin")).unwrap(),
            "/missing/legacy-node\n"
        );
        assert_eq!(
            fs::read_to_string(data.join("current")).unwrap(),
            "../../unrelated"
        );
    }

    #[test]
    fn rejects_legacy_empty_and_unsafe_versions() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("versions/old/dist")).unwrap();
        fs::write(temp.path().join("versions/old/dist/index.js"), "legacy").unwrap();
        for pointer in [
            "old",
            "",
            ".",
            "..",
            "../../elsewhere",
            "C:/other",
            "a\\b",
            "a\nb",
        ] {
            fs::write(temp.path().join("current"), pointer).unwrap();
            assert!(
                check_version_pointer(temp.path(), "current").is_err(),
                "{pointer:?}"
            );
        }
    }

    #[test]
    fn portable_native_package_does_not_require_node_or_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("absent-data");
        let probe = RuntimeProbe {
            exec_path: package(&temp.path().join("portable")),
            cache_dir: None,
        };
        let health = check_runtime(&data, &probe);
        assert!(health.binary_valid && health.current_version_valid);
        assert!(!health.rollback_available);
        assert!(!data.exists());
    }

    #[cfg(unix)]
    #[test]
    fn broken_versions_link_does_not_enable_portable_mode() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing"), data.join("versions")).unwrap();
        let probe = RuntimeProbe {
            exec_path: package(&temp.path().join("portable")),
            cache_dir: None,
        };
        let health = check_runtime(&data, &probe);
        assert!(health.binary_valid);
        assert!(!health.current_version_valid);
        assert_eq!(health.version_count, 0);
    }

    #[cfg(unix)]
    #[test]
    fn pointers_cannot_follow_symlinked_packages() {
        let temp = tempfile::tempdir().unwrap();
        package(&temp.path().join("outside"));
        fs::create_dir(temp.path().join("versions")).unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("outside"),
            temp.path().join("versions/linked"),
        )
        .unwrap();
        fs::write(temp.path().join("current"), "linked").unwrap();
        assert!(check_version_pointer(temp.path(), "current").is_err());
    }
}
