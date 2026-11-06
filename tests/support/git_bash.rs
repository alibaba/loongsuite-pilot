//! Real Git Bash only; never resolve Windows' unrelated System32 WSL stub.
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn locate() -> PathBuf {
    let mut roots = Vec::new();
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(name) {
            roots.push(PathBuf::from(root).join("Git"));
        }
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(root).join("Programs").join("Git"));
    }
    for root in roots {
        let bin = root.join("usr").join("bin");
        let shell = bin.join("bash.exe");
        if shell.is_file() && bin.join("msys-2.0.dll").is_file() {
            return shell;
        }
    }
    panic!("real Git Bash is required for these source contracts; no installed usr/bin/bash.exe with its MSYS runtime was found")
}
pub fn configure(command: &mut Command, home: &Path, shell: &Path) {
    command.creation_flags(0x0800_0000);
    let mut paths = vec![shell.parent().unwrap().to_owned()];
    for name in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(name) {
            if name == "SystemRoot" {
                paths.push(PathBuf::from(&value).join("System32"));
            }
            command.env(name, value);
        }
    }
    command
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("BASH_ENV", "")
        .env("ENV", "");
}
