//! Real-shell source contracts. No user profile or actual Agent is invoked.
use super::*;
use std::process::{Command, Output};
#[cfg(windows)]
#[path = "../../tests/support/git_bash.rs"]
mod git_bash;
const ALIAS:&str="alias claude='all_proxy=http://127.0.0.1:7899 /usr/local/bin/claude --dangerously-skip-permissions'";
const PROBE: &str = "command() { echo \"WRAP_RAN BUN_OPTIONS=$BUN_OPTIONS args=[$*]\"; }";
fn block(id: &str) -> String {
    let def = intercept_rc_blocks()
        .into_iter()
        .find(|d| d.id == id)
        .unwrap();
    (def.render)(&format!("/tmp/pilot-hooks/{}", def.script_name))
}
fn run(shell: &str, script: &str) -> Output {
    let home = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    let program = if shell == "bash" {
        git_bash::locate()
    } else {
        std::path::PathBuf::from(shell)
    };
    #[cfg(not(windows))]
    let program = std::path::PathBuf::from(shell);
    let mut cmd = Command::new(&program);
    cmd.env_clear();
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    if shell == "bash" {
        cmd.args(["--noprofile", "--norc", "-c"]);
    } else {
        cmd.args(["-f", "-c"]);
    }
    let script = if shell == "bash" {
        format!("shopt -s expand_aliases\n{script}")
    } else {
        script.to_string()
    };
    cmd.arg(script)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("ZDOTDIR", home.path())
        .env("BASH_ENV", "")
        .env("ENV", "")
        .env(
            "PATH",
            if cfg!(windows) {
                std::env::var_os("PATH").unwrap_or_default()
            } else {
                std::ffi::OsString::from("/usr/bin:/bin")
            },
        )
        .env("TMPDIR", home.path())
        .env("TEMP", home.path())
        .env("TMP", home.path())
        .current_dir(home.path())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    if shell == "bash" {
        git_bash::configure(&mut cmd, home.path(), &program);
    }
    cmd.output().expect("required real shell is unavailable")
}
fn success(out: Output) -> String {
    assert!(
        out.status.success(),
        "real shell failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
#[test]
fn shell_l56_bash_active_claude_alias_sources_without_shadowing() {
    let out = success(run(
        "bash",
        &format!(
            "{ALIAS}\n{}\necho SRC_OK\nalias claude",
            block("claude-code-rc")
        ),
    ));
    assert!(out.contains("SRC_OK"));
    assert!(out.contains("dangerously-skip-permissions"));
    assert!(!out.contains("WRAP_RAN"));
}
#[test]
fn shell_l64_bash_wrapper_composes_bun_options_and_forwards_arguments() {
    let out = success(run(
        "bash",
        &format!(
            "export BUN_OPTIONS='--preload=/user/own.mjs'\n{}\n{PROBE}\nclaude hello",
            block("claude-code-rc")
        ),
    ));
    assert!(out.contains("WRAP_RAN"));
    assert!(out.contains("claude-code-fetch-intercept.mjs"));
    assert!(out.contains("/user/own.mjs"));
    assert!(out.contains("args=[claude hello]"));
}
#[test]
fn shell_l75_bash_user_claude_function_is_preserved() {
    let out = success(run(
        "bash",
        &format!(
            "claude() {{ echo USER_FN; }}\n{}\nclaude",
            block("claude-code-rc")
        ),
    ));
    assert!(out.contains("USER_FN"));
}
#[test]
fn shell_l81_bash_double_source_is_idempotent() {
    let body = block("claude-code-rc");
    let out = success(run(
        "bash",
        &format!("{body}\n{body}\n{PROBE}\nclaude x\necho DONE"),
    ));
    assert!(out.contains("DONE"));
    assert_eq!(out.matches("WRAP_RAN").count(), 1);
}
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "requires real zsh; original source skipIf(!HAS_ZSH); explicitly run --ignored when installed"
)]
fn shell_l90_zsh_active_claude_alias_sources_without_shadowing() {
    let out = success(run(
        "zsh",
        &format!(
            "{ALIAS}\n{}\necho SRC_OK\nwhich claude",
            block("claude-code-rc")
        ),
    ));
    assert!(out.contains("SRC_OK"));
    assert!(out.contains("dangerously-skip-permissions"));
    assert!(!out.contains("WRAP_RAN"));
}
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "requires real zsh; original source skipIf(!HAS_ZSH); explicitly run --ignored when installed"
)]
fn shell_l98_zsh_wrapper_composes_bun_options_and_forwards_arguments() {
    let out = success(run(
        "zsh",
        &format!(
            "export BUN_OPTIONS='--preload=/user/own.mjs'\n{}\n{PROBE}\nclaude hello",
            block("claude-code-rc")
        ),
    ));
    assert!(out.contains("WRAP_RAN"));
    assert!(out.contains("claude-code-fetch-intercept.mjs"));
    assert!(out.contains("/user/own.mjs"));
    assert!(out.contains("args=[claude hello]"));
}
#[test]
fn shell_l110_bash_active_qodercli_alias_sources_and_is_preserved() {
    let out = success(run(
        "bash",
        &format!(
            "alias qodercli='/usr/local/bin/qodercli --user-flag'\n{}\necho SRC_OK\nalias qodercli",
            block("qodercli-rc")
        ),
    ));
    assert!(out.contains("SRC_OK"));
    assert!(out.contains("--user-flag"));
}
fn old_bare() -> &'static str {
    "# loongsuite-pilot BEGIN claude-code-intercept\nclaude() { BUN_OPTIONS=\"--preload=/old ${BUN_OPTIONS}\" command claude \"$@\"; }\n# loongsuite-pilot END claude-code-intercept"
}
#[test]
fn shell_l133_actual_old_bare_block_fails_under_an_active_alias() {
    let out = run(
        "bash",
        &format!("{ALIAS}\n{}\necho SHOULD_NOT_REACH", old_bare()),
    );
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("SHOULD_NOT_REACH"));
    assert!(String::from_utf8_lossy(&out.stderr).contains("syntax error"));
}
#[test]
fn shell_l143_migrated_rc_sources_cleanly_and_the_old_bare_block_is_gone() {
    let old = format!("# user-top\n{}\n", old_bare());
    let migrated = format!(
        "{}\n{}\n",
        strip_marker_block(
            &old,
            "loongsuite-pilot BEGIN claude-code-intercept",
            "loongsuite-pilot END claude-code-intercept"
        ),
        block("claude-code-rc")
    );
    assert!(!migrated
        .lines()
        .any(|l| l.trim_start().starts_with("claude()")));
    assert!(!migrated.contains("--preload=/old"));
    let out = success(run(
        "bash",
        &format!("{ALIAS}\n{migrated}\necho SRC_OK\nalias claude"),
    ));
    assert!(out.contains("SRC_OK"));
    assert!(out.contains("dangerously-skip-permissions"));
}
