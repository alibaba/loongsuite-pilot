//! Exact historical shell/PowerShell policies. No external host runtime required.
use std::fs;
use std::path::PathBuf;
use std::process::Command;
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned()
}
fn ps1_files() -> Vec<String> {
    let output = Command::new("git")
        .args(["ls-files", "--", "*.ps1"])
        .current_dir(root())
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}
fn known_unconverted(path: &str) -> bool {
    matches!(
        path,
        "deploy/installer-opensource.ps1"
            | ".specify/extensions/git/scripts/powershell/auto-commit.ps1"
            | ".specify/extensions/git/scripts/powershell/git-common.ps1"
            | ".specify/extensions/git/scripts/powershell/initialize-repo.ps1"
    )
}
fn comment_offenders(text: &str) -> Vec<usize> {
    text.trim_start_matches('\u{feff}')
        .split('\n')
        .enumerate()
        .filter_map(|(i, line)| {
            if line.is_ascii() {
                return None;
            }
            if line.trim_start().starts_with('#') {
                return Some(i + 1);
            }
            let hash = line.find('#')?;
            let before = &line[..hash];
            (before.matches('"').count() % 2 == 0
                && before.matches('\'').count() % 2 == 0
                && !line[hash..].is_ascii())
            .then_some(i + 1)
        })
        .collect()
}
#[test]
fn source_ascii_l55_finds_original_minimum_of_actual_tracked_powershell_files() {
    assert!(
        ps1_files().len() > 10,
        "retain original >10 source inventory floor"
    );
}
#[test]
fn source_ascii_l61_keeps_every_original_comment_exception_and_reverse_ratchet() {
    for path in ps1_files() {
        let text = fs::read_to_string(root().join(&path)).unwrap();
        let offenders = comment_offenders(&text);
        if known_unconverted(&path) {
            assert!(
                !offenders.is_empty(),
                "cleaned source must leave original exception list: {path}"
            );
        } else {
            assert!(offenders.is_empty(), "{path}: {offenders:?}");
        }
    }
}
#[test]
fn source_ascii_l73_requires_bom_for_every_nonascii_byte_outside_original_exceptions() {
    for path in ps1_files()
        .into_iter()
        .filter(|path| !known_unconverted(path))
    {
        let bytes = fs::read(root().join(&path)).unwrap();
        assert!(
            bytes.starts_with(b"\xef\xbb\xbf") || bytes.is_ascii(),
            "BOM-less nonASCII PowerShell: {path}"
        );
    }
}
