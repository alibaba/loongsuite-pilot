//! `node-bin` pointer checks and self-heal. Candidates must report Node >= 18.

use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MIN_NODE_MAJOR: u64 = 18;

#[derive(Clone)]
pub struct NodeBinProbe {
    pub exec_path: PathBuf,
    pub windows: bool,
    pub path_env: String,
    pub executable: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
    pub version_text: Arc<dyn Fn(&Path) -> Result<String, String> + Send + Sync>,
}

impl std::fmt::Debug for NodeBinProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeBinProbe")
            .field("exec_path", &self.exec_path)
            .field("windows", &self.windows)
            .finish()
    }
}

impl NodeBinProbe {
    pub fn system() -> Self {
        Self {
            exec_path: std::env::current_exe().unwrap_or_default(),
            windows: cfg!(windows),
            path_env: std::env::var("PATH").unwrap_or_default(),
            executable: Arc::new(path_is_executable),
            version_text: Arc::new(read_node_version),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeBinDiagnostic {
    pub original_path: String,
    pub path_exists: bool,
    pub path_executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeBinCheck {
    pub valid: bool,
    pub diagnostic: Option<NodeBinDiagnostic>,
}

pub fn check_node_bin(data_dir: &str, probe: &NodeBinProbe) -> NodeBinCheck {
    let node_bin_file = Path::new(data_dir).join("node-bin");
    let original = match std::fs::read_to_string(&node_bin_file) {
        Ok(text) => text.trim().to_string(),
        Err(_) => {
            return NodeBinCheck {
                valid: false,
                diagnostic: Some(NodeBinDiagnostic {
                    original_path: String::new(),
                    path_exists: false,
                    path_executable: false,
                }),
            };
        }
    };
    if !original.is_empty() && (probe.executable)(Path::new(&original)) {
        return NodeBinCheck {
            valid: true,
            diagnostic: None,
        };
    }
    if heal_node_bin(&node_bin_file, probe) {
        return NodeBinCheck {
            valid: true,
            diagnostic: None,
        };
    }
    NodeBinCheck {
        valid: false,
        diagnostic: Some(NodeBinDiagnostic {
            path_exists: !original.is_empty() && Path::new(&original).exists(),
            path_executable: !original.is_empty() && (probe.executable)(Path::new(&original)),
            original_path: original,
        }),
    }
}

fn heal_node_bin(node_bin_file: &Path, probe: &NodeBinProbe) -> bool {
    let Some(candidate) = find_node_candidate(node_bin_file.parent(), probe) else {
        return false;
    };
    let Some(dir) = node_bin_file.parent() else {
        return false;
    };
    let tmp = dir.join(format!(".node-bin.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, format!("{candidate}\n")).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, node_bin_file).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

pub fn find_node_candidate(data_dir: Option<&Path>, probe: &NodeBinProbe) -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(data_dir) = data_dir {
        if let Ok(entries) = std::fs::read_dir(data_dir.join("runtime")) {
            let mut names: Vec<String> = entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("node-v"))
                .collect();
            names.sort_by(|a, b| compare_node_runtime_dirs(a, b).reverse());
            let bin_name = if probe.windows { "node.exe" } else { "node" };
            for name in names {
                candidates.push(
                    data_dir
                        .join("runtime")
                        .join(&name)
                        .join("bin")
                        .join(bin_name),
                );
                if probe.windows {
                    candidates.push(data_dir.join("runtime").join(&name).join(bin_name));
                }
            }
        }
    }
    if (probe.executable)(&probe.exec_path) && suitable_version(&probe.exec_path, probe) {
        candidates.push(canonicalize_or_self(&probe.exec_path));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if let Ok(versions) =
        std::fs::read_dir(Path::new(&home).join(".nvm").join("versions").join("node"))
    {
        let mut names: Vec<_> = versions
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        names.reverse();
        for name in names {
            candidates.push(
                Path::new(&home)
                    .join(".nvm")
                    .join("versions")
                    .join("node")
                    .join(name)
                    .join("bin")
                    .join("node"),
            );
        }
    }
    candidates.push(
        Path::new(&home)
            .join(".fnm")
            .join("aliases")
            .join("default")
            .join("bin")
            .join("node"),
    );
    candidates.push(Path::new(&home).join(".volta").join("bin").join("node"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    candidates.push(PathBuf::from("/usr/local/bin/node"));
    candidates.push(Path::new(&home).join(".local").join("bin").join("node"));
    let delimiter = if probe.windows { ';' } else { ':' };
    for dir in probe.path_env.split(delimiter) {
        if !dir.is_empty() {
            candidates.push(Path::new(dir).join(if probe.windows { "node.exe" } else { "node" }));
        }
    }
    for candidate in candidates {
        if (probe.executable)(&candidate) && suitable_version(&candidate, probe) {
            return Some(
                canonicalize_or_self(&candidate)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    None
}

fn suitable_version(path: &Path, probe: &NodeBinProbe) -> bool {
    let Ok(text) = (probe.version_text)(path) else {
        return false;
    };
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix('v') else {
        return false;
    };
    let major = rest
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u64>()
        .unwrap_or(0);
    major >= MIN_NODE_MAJOR
}

fn compare_node_runtime_dirs(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| -> Vec<u64> {
        value
            .trim_start_matches("node-v")
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|ch| ch.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let a = parse(left);
    let b = parse(right);
    for index in 0..a.len().max(b.len()) {
        let diff = a
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&b.get(index).copied().unwrap_or(0));
        if diff != std::cmp::Ordering::Equal {
            return diff;
        }
    }
    std::cmp::Ordering::Equal
}

fn canonicalize_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    }
}

fn read_node_version(path: &Path) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&path).arg("--version").output();
        let _ = tx.send(output);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(output)) if output.status.success() => {
            String::from_utf8(output.stdout).map_err(|err| err.to_string())
        }
        Ok(Ok(output)) => Err(String::from_utf8_lossy(&output.stderr).to_string()),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err("ETIMEDOUT: --version timed out".to_string()),
    }
}

pub fn check_version_pointer(data_dir: &str, name_file: &str) -> bool {
    let Ok(name) = std::fs::read_to_string(Path::new(data_dir).join(name_file)) else {
        return false;
    };
    let name = name.trim();
    if name.is_empty() || name.contains('\0') {
        return false;
    }
    if Path::new(name).is_absolute() || name.split(['/', '\\']).any(|part| part == "..") {
        return false;
    }
    Path::new(data_dir).join("versions").join(name).is_dir()
}

pub fn count_versions(data_dir: &str) -> u64 {
    std::fs::read_dir(Path::new(data_dir).join("versions"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .map(|name| !name.starts_with('.'))
                        .unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0)
}

pub fn read_init_type(data_dir: &str) -> String {
    match std::fs::read_to_string(Path::new(data_dir).join("init-type")) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                "unknown".to_string()
            } else {
                trimmed.to_string()
            }
        }
        Err(_) => "unknown".to_string(),
    }
}
