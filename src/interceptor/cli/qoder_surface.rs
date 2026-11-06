//! Decide whether a Qoder hook belongs to the desktop app or qodercli.

use crate::interceptor::types::QoderSurface;
use std::path::Path;

pub fn resolve_qoder_surface() -> Option<QoderSurface> {
    let explicit = std::env::var("QODER_CONFIG_DIR").ok();
    let ancestors = if classify_config_dir(explicit.as_deref()).is_some() {
        Vec::new()
    } else {
        ancestor_names()
    };
    resolve_qoder_surface_with(
        |key| {
            if key == "QODER_CONFIG_DIR" {
                explicit.clone()
            } else {
                None
            }
        },
        &ancestors,
    )
}

pub fn resolve_qoder_surface_with(
    env: impl Fn(&str) -> Option<String>,
    ancestors: &[String],
) -> Option<QoderSurface> {
    if let Some(surface) = classify_config_dir(env("QODER_CONFIG_DIR").as_deref()) {
        return Some(surface);
    }
    for name in ancestors {
        if let Some(surface) = classify_executable(name) {
            return Some(surface);
        }
    }
    None
}

pub fn classify_executable(raw: &str) -> Option<QoderSurface> {
    let name = normalize_name(raw);
    if name.is_empty() || is_non_qoder_host(&name) {
        return None;
    }
    if name.contains("qodercli") || name.contains("qoder-cli") || name.contains("qoder_cli") {
        return Some(QoderSurface::QoderCli);
    }
    if name.contains("qoderwork") || name.contains("qoder-work") {
        return None;
    }
    if name.contains("qwenwork") || name.contains("qwen-work") {
        return None;
    }
    if name.contains("qoder") {
        return Some(QoderSurface::Qoder);
    }
    None
}

fn classify_config_dir(raw: Option<&str>) -> Option<QoderSurface> {
    let raw = raw?;
    let normalized = raw.replace('\\', "/").to_lowercase();
    if normalized.contains(".qoderwork") {
        return None;
    }
    if normalized.contains(".qoder") {
        return Some(QoderSurface::Qoder);
    }
    None
}

fn is_non_qoder_host(name: &str) -> bool {
    name.contains("node")
        || name.contains("loongsuite-pilot")
        || name.contains("interceptor")
        || name.contains("coding-agent-security")
}

fn normalize_name(raw: &str) -> String {
    Path::new(raw)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(raw)
        .trim_end_matches(".exe")
        .trim_end_matches(".EXE")
        .to_lowercase()
}

fn ancestor_names() -> Vec<String> {
    // One native process snapshot, with no PowerShell/WMIC/ps subprocess.
    // The old port never read ancestors on Windows or macOS at all.
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let mut next = system
        .process(sysinfo::Pid::from_u32(std::process::id()))
        .and_then(|process| process.parent());
    let mut names = Vec::new();
    for _ in 0..12 {
        let Some(pid) = next.filter(|pid| pid.as_u32() > 1) else {
            break;
        };
        let Some(process) = system.process(pid) else {
            break;
        };
        names.push(
            process
                .exe()
                .filter(|path| !path.as_os_str().is_empty())
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| process.name().to_string_lossy().into_owned()),
        );
        next = process.parent();
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::types::QoderSurface;

    #[test]
    fn classifies_desktop_and_cli_executables() {
        assert_eq!(
            classify_executable("/usr/bin/qoder"),
            Some(QoderSurface::Qoder)
        );
        assert_eq!(classify_executable("Qoder.exe"), Some(QoderSurface::Qoder));
        assert_eq!(
            classify_executable("qodercli"),
            Some(QoderSurface::QoderCli)
        );
        assert_eq!(
            classify_executable("qoder-cli"),
            Some(QoderSurface::QoderCli)
        );
    }

    #[test]
    fn ignores_qoder_work_and_interceptor_hosts() {
        assert_eq!(classify_executable("qoderwork"), None);
        assert_eq!(classify_executable("QwenWorkCN"), None);
        assert_eq!(classify_executable("qwenworkcn.exe"), None);
        assert_eq!(classify_executable("node"), None);
        assert_eq!(classify_executable("interceptor-cli"), None);
    }

    #[test]
    fn prefers_qoder_config_dir_when_it_points_at_the_desktop_profile() {
        let surface = resolve_qoder_surface_with(
            |key| (key == "QODER_CONFIG_DIR").then(|| "/home/u/.qoder".to_string()),
            &["qodercli".into()],
        );
        assert_eq!(surface, Some(QoderSurface::Qoder));
    }

    const FIXTURE: &str = "interceptor::cli::qoder_surface::tests::native_surface_fixture";

    fn fixture_command(binary: &Path, root: &Path, mode: &str) -> std::process::Command {
        use std::process::Stdio;
        let mut command = std::process::Command::new(binary);
        command
            .args(["--exact", FIXTURE, "--nocapture"])
            .env_clear()
            .current_dir(root)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("PATH", root.join("no-runtimes"))
            .env("PILOT_SURFACE_FIXTURE_ROOT", root)
            .env("PILOT_SURFACE_FIXTURE_MODE", mode)
            .stdin(Stdio::null())
            .stdout(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join("stdout"))
                    .unwrap(),
            )
            .stderr(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join("stderr"))
                    .unwrap(),
            );
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
    }

    fn wait_fixture(command: &mut std::process::Command, root: &Path) {
        use crate::utils::candidate_process::CandidateChild;
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let mut child = loop {
            match CandidateChild::spawn(command) {
                Err(error)
                    if cfg!(target_os = "linux")
                        && error.raw_os_error() == Some(26)
                        && start.elapsed() < Duration::from_secs(1) =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                result => break result.unwrap(),
            }
        };
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "native surface fixture failed: {}",
                    std::fs::read_to_string(root.join("stderr")).unwrap()
                );
                return;
            }
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "native surface fixture timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn native_surface_fixture() {
        let Some(root) = std::env::var_os("PILOT_SURFACE_FIXTURE_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        match std::env::var("PILOT_SURFACE_FIXTURE_MODE")
            .unwrap()
            .as_str()
        {
            "parent" => {
                let original = std::env::var_os("PILOT_SURFACE_ORIGINAL_BINARY").unwrap();
                let mut command = fixture_command(Path::new(&original), root, "probe");
                // Inherit the outer fixture's process group/Job so its
                // deadline also terminates this probe if the parent is killed.
                assert!(command.status().unwrap().success());
            }
            "probe" => {
                let surface = match resolve_qoder_surface() {
                    Some(QoderSurface::Qoder) => "qoder",
                    Some(QoderSurface::QoderCli) => "qodercli",
                    None => "none",
                };
                std::fs::write(root.join("detected"), surface).unwrap();
            }
            _ => panic!("unknown fixture mode"),
        }
    }

    #[test]
    fn native_ancestor_lookup_recognizes_real_desktop_and_cli_parent_processes_without_shells() {
        for (name, expected) in [("qoder", "qoder"), ("qoder-cli", "qodercli")] {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().join("Qoder 研发 🚀");
            std::fs::create_dir(&directory).unwrap();
            let binary = directory.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            });
            std::fs::copy(std::env::current_exe().unwrap(), &binary).unwrap();
            let original = std::env::current_exe().unwrap();
            assert_eq!(
                classify_executable(original.file_name().unwrap().to_str().unwrap()),
                None
            );
            let mut command = fixture_command(&binary, root.path(), "parent");
            command.env("PILOT_SURFACE_ORIGINAL_BINARY", &original);
            wait_fixture(&mut command, root.path());
            assert_eq!(
                std::fs::read_to_string(root.path().join("detected")).unwrap(),
                expected
            );
        }
    }
}
