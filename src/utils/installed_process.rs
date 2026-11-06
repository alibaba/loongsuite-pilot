//! 原生服务进程身份：安装目录、角色与数据目录必须同时匹配。

use std::ffi::{OsStr, OsString};
use std::path::Path;

use super::runtime_paths::{resource_file, runtime_metadata, safe_component};

fn matches_parts(
    exe: &Path,
    command: &[OsString],
    environment: &[OsString],
    cache: &Path,
    data: &Path,
    role: &str,
) -> bool {
    let arguments: Vec<_> = command.iter().skip(1).map(OsString::as_os_str).collect();
    let role_matches = match role {
        "collector" => {
            !command.is_empty() && (arguments.is_empty() || arguments == [OsStr::new("run")])
        }
        "updater" => arguments == [OsStr::new("run-updater")],
        _ => false,
    };
    if !role_matches {
        return false;
    }
    let checked = || -> anyhow::Result<bool> {
        anyhow::ensure!(runtime_metadata(cache)?.is_dir(), "缓存目录无效");
        let versions = cache.join("versions");
        anyhow::ensure!(runtime_metadata(&versions)?.is_dir(), "版本目录无效");
        let versions = std::fs::canonicalize(versions)?;
        let exe = std::fs::canonicalize(exe)?;
        let relative = exe.strip_prefix(&versions)?;
        let parts: Vec<_> = relative.components().collect();
        anyhow::ensure!(parts.len() == 3, "服务入口不在版本目录中");
        let version = parts[0].as_os_str().to_str().unwrap_or("");
        anyhow::ensure!(safe_component(version), "版本目录名无效");
        let root = versions.join(version);
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        anyhow::ensure!(
            std::fs::canonicalize(resource_file(&root, binary)?)? == exe,
            "进程不是原生服务入口"
        );
        resource_file(&root, "runtime-manifest.json")?;
        let expected = std::fs::canonicalize(data)?;
        let values: Vec<_> = environment
            .iter()
            .filter_map(|entry| {
                let (key, value) = entry.to_str()?.split_once('=')?;
                let matched = if cfg!(windows) {
                    key.eq_ignore_ascii_case("LOONGSUITE_PILOT_DATA_DIR")
                } else {
                    key == "LOONGSUITE_PILOT_DATA_DIR"
                };
                matched.then_some(value)
            })
            .collect();
        // 环境不可读、重复或未显式指定时拒绝，不能跨安装猜测归属。
        Ok(values.len() == 1
            && Path::new(values[0]).is_absolute()
            && std::fs::canonicalize(values[0])? == expected)
    };
    checked().unwrap_or(false)
}

pub fn is_installed_process(pid: u32, role: &str, cache: &Path, data: &Path) -> bool {
    inspect_process(pid, role, cache, data, false)
}

/// 健康确认还必须匹配 current 指向的二进制，不能接受仍存活的旧版本。
pub fn is_current_installed_process(pid: u32, role: &str, cache: &Path, data: &Path) -> bool {
    inspect_process(pid, role, cache, data, true)
}

fn matches_current_executable(exe: &Path, cache: &Path) -> bool {
    use std::io::Read;
    let checked = || -> anyhow::Result<bool> {
        let pointer = cache.join("current");
        let meta = runtime_metadata(&pointer)?;
        anyhow::ensure!(meta.is_file() && meta.len() <= 1024, "版本指针无效");
        let mut value = String::new();
        std::fs::File::open(&pointer)?
            .take(1025)
            .read_to_string(&mut value)?;
        anyhow::ensure!(value.len() <= 1024, "版本指针读取超限");
        let version = value.trim_start_matches('\u{feff}').trim();
        anyhow::ensure!(safe_component(version), "版本指针无效");
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        let target = resource_file(&cache.join("versions").join(version), binary)?;
        Ok(std::fs::canonicalize(exe)? == std::fs::canonicalize(target)?)
    };
    checked().unwrap_or(false)
}

fn inspect_process(pid: u32, role: &str, cache: &Path, data: &Path, current_only: bool) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_exe(sysinfo::UpdateKind::Always)
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_environ(sysinfo::UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else {
        return false;
    };
    if matches!(
        process.status(),
        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
    ) {
        return false;
    }
    process.exe().is_some_and(|exe| {
        matches_parts(exe, process.cmd(), process.environ(), cache, data, role)
            && (!current_only || matches_current_executable(exe, cache))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_identity_rejects_old_executables_and_invalid_current_pointers() {
        let root = tempfile::tempdir().unwrap();
        let binary = if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        };
        for name in ["old", "candidate"] {
            let dir = root.path().join("versions").join(name);
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            std::fs::write(dir.join(binary), "fixture").unwrap();
        }
        let old = root.path().join("versions/old").join(binary);
        let candidate = root.path().join("versions/candidate").join(binary);
        let pointer = root.path().join("current");
        assert!(!matches_current_executable(&candidate, root.path()));
        std::fs::write(&pointer, "\u{feff}candidate\r\n").unwrap();
        assert!(matches_current_executable(&candidate, root.path()));
        assert!(!matches_current_executable(&old, root.path()));
        std::fs::write(&pointer, "old\n").unwrap();
        assert!(matches_current_executable(&old, root.path()));
        assert!(!matches_current_executable(&candidate, root.path()));
        for invalid in ["", "../old", "missing", &"a".repeat(1025)] {
            std::fs::write(&pointer, invalid).unwrap();
            assert!(!matches_current_executable(&old, root.path()));
        }
        #[cfg(unix)]
        {
            std::fs::remove_file(&pointer).unwrap();
            let other = root.path().join("foreign-pointer");
            std::fs::write(&other, "old").unwrap();
            std::os::unix::fs::symlink(other, &pointer).unwrap();
            assert!(!matches_current_executable(&old, root.path()));
        }
        assert!(!is_current_installed_process(
            std::process::id(),
            "collector",
            root.path(),
            root.path()
        ));
    }

    #[test]
    fn identity_requires_exact_install_role_and_data_even_after_pointer_changes() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("缓存 张三 🚀");
        let data = root.path().join("数据");
        let version = cache.join("versions/1.2.0");
        std::fs::create_dir_all(version.join("bin")).unwrap();
        std::fs::create_dir(&data).unwrap();
        let exe = version.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        std::fs::write(&exe, b"fixture").unwrap();
        std::fs::write(version.join("runtime-manifest.json"), "{}").unwrap();
        let environment = vec![OsString::from(format!(
            "LOONGSUITE_PILOT_DATA_DIR={}",
            data.display()
        ))];
        let args = |values: &[&str]| -> Vec<OsString> {
            std::iter::once(exe.as_os_str().to_owned())
                .chain(values.iter().map(OsString::from))
                .collect()
        };
        assert!(matches_parts(
            &exe,
            &args(&[]),
            &environment,
            &cache,
            &data,
            "collector"
        ));
        assert!(matches_parts(
            &exe,
            &args(&["run"]),
            &environment,
            &cache,
            &data,
            "collector"
        ));
        assert!(matches_parts(
            &exe,
            &args(&["run-updater"]),
            &environment,
            &cache,
            &data,
            "updater"
        ));
        assert!(!matches_parts(
            &exe,
            &args(&["internal-span-enricher", "/tmp/updater-daemon.js.mjs"]),
            &environment,
            &cache,
            &data,
            "updater"
        ));
        for arguments in [
            &["run-updater"][..],
            &["run", "extra"],
            &["check"],
            &["internal-span-enricher", "/tmp/collector-daemon.js.mjs"],
            &["internal-span-enricher", "/tmp/updater-daemon.js.mjs"],
        ] {
            assert!(!matches_parts(
                &exe,
                &args(arguments),
                &environment,
                &cache,
                &data,
                "collector"
            ));
        }
        assert!(!matches_parts(
            &exe,
            &args(&["run"]),
            &[],
            &cache,
            &data,
            "collector"
        ));
        assert!(!matches_parts(
            &exe,
            &args(&["run"]),
            &[environment[0].clone(), environment[0].clone()],
            &cache,
            &data,
            "collector"
        ));
        assert!(!matches_parts(
            &exe,
            &args(&["run"]),
            &environment,
            root.path(),
            &data,
            "collector"
        ));
        assert!(!matches_parts(
            &exe,
            &args(&["run"]),
            &environment,
            &cache,
            root.path(),
            "collector"
        ));
        std::fs::write(cache.join("current"), "new-version").unwrap();
        assert!(matches_parts(
            &exe,
            &args(&["run"]),
            &environment,
            &cache,
            &data,
            "collector"
        ));
        let wrong = version.join("bin/foreign");
        std::fs::write(&wrong, "foreign").unwrap();
        assert!(!matches_parts(
            &wrong,
            &args(&["run"]),
            &environment,
            &cache,
            &data,
            "collector"
        ));
    }
}
