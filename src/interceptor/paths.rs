//! On-disk layout under `{dataDir}/interceptor`.

use crate::utils::{resolve_data_dir, resolve_home};
use std::path::{Path, PathBuf};

fn root(data_dir: Option<&str>) -> PathBuf {
    let resolved = match data_dir {
        Some(dir) => resolve_home(dir),
        None => resolve_data_dir(None),
    };
    Path::new(&resolved).join("interceptor")
}

pub fn interceptor_data_dir(data_dir: Option<&str>) -> PathBuf {
    root(data_dir)
}

pub fn interceptor_runtime_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("runtime.json")
}

pub fn interceptor_pid_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("interceptor.pid")
}

pub fn interceptor_log_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("logs").join("interceptor.log")
}

pub fn interceptor_access_log_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("logs").join("access.log")
}

pub fn interceptor_tool_verdict_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("tool-verdicts.json")
}

pub fn interceptor_lock_path(data_dir: Option<&str>) -> PathBuf {
    root(data_dir).join("interceptor.lock")
}

pub fn default_pilot_data_dir() -> String {
    resolve_data_dir(None)
}
