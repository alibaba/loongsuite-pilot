//! 从同一入口表生成薄平台 Hook；--check 只读，防止平台分支漂移。

use anyhow::{ensure, Context, Result};
use std::{fs, path::Path};

struct Hook {
    file: &'static str,
    agent: &'static str,
    mode: Mode,
}

enum Mode {
    Payload,
    Event(&'static [&'static str]),
    Identity,
    FixedIdentity,
    Interceptor,
}

const HOOKS: &[Hook] = &[
    Hook {
        file: "copilot-loongsuite-pilot-hook",
        agent: "copilot",
        mode: Mode::Event(&[
            "session-start",
            "user-prompt-submit",
            "user-prompt-submitted",
            "pre-tool-use",
            "post-tool-use",
            "post-tool-use-failure",
            "session-end",
            "stop",
            "agent-stop",
        ]),
    },
    Hook {
        file: "cursor-loongsuite-pilot-hook",
        agent: "cursor",
        mode: Mode::Payload,
    },
    Hook {
        file: "claude-code-loongsuite-pilot-hook",
        agent: "claude-code",
        mode: Mode::Event(&[
            "pre-tool-use",
            "stop",
            "stop-failure",
            "subagent-start",
            "subagent-stop",
        ]),
    },
    Hook {
        file: "codex-loongsuite-pilot-hook",
        agent: "codex",
        mode: Mode::Event(&[]),
    },
    Hook {
        file: "grok-build-loongsuite-pilot-hook",
        agent: "grok-build",
        mode: Mode::Event(&["stop", "stop_failure", "user_prompt_submit", "session_end"]),
    },
    Hook {
        file: "kiro-cli-loongsuite-pilot-hook",
        agent: "kiro-cli",
        mode: Mode::Event(&[]),
    },
    Hook {
        file: "qwen-code-cli-loongsuite-pilot-hook",
        agent: "qwen-code-cli",
        mode: Mode::Event(&["stop", "subagent-start", "subagent-stop"]),
    },
    Hook {
        file: "workbuddy-loongsuite-pilot-hook",
        agent: "workbuddy",
        mode: Mode::Event(&[]),
    },
    Hook {
        file: "qoder-loongsuite-pilot-hook",
        agent: "qoder",
        mode: Mode::Identity,
    },
    Hook {
        file: "qodercn-loongsuite-pilot-hook",
        agent: "qoder-cn",
        mode: Mode::Identity,
    },
    Hook {
        file: "qoderwork-loongsuite-pilot-hook",
        agent: "qoder-work",
        mode: Mode::Identity,
    },
    Hook {
        file: "qoderworkcn-loongsuite-pilot-hook",
        agent: "qoder-work-cn",
        mode: Mode::Identity,
    },
    Hook {
        file: "qwenworkcn-loongsuite-pilot-hook",
        agent: "qwen-work-cn",
        mode: Mode::FixedIdentity,
    },
    Hook {
        file: "interceptor-hook",
        agent: "qoder-auto",
        mode: Mode::Interceptor,
    },
    Hook {
        file: "interceptor-qwenworkcn-hook",
        agent: "qwen-work-cn",
        mode: Mode::Interceptor,
    },
];

fn powershell(hook: &Hook) -> String {
    let agent = hook.agent;
    let empty = if matches!(
        hook.mode,
        Mode::Identity | Mode::FixedIdentity | Mode::Interceptor
    ) {
        ""
    } else {
        "{}"
    };
    let mut script = format!("$ErrorActionPreference = 'Stop'\n$EmptyResult = '{empty}'\n");
    script.push_str("# Resolve signed built-in modules by their exact PSHOME manifests. Short-name\n# autoload can stall in isolated Windows PowerShell 5.1 environments.\ntry {\n    Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\n    Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop\n} catch {\n    try { Microsoft.PowerShell.Utility\\Write-Error '[loongsuite-pilot] built-in PowerShell modules unavailable' -ErrorAction Continue } catch {}\n    if ($EmptyResult) { $EmptyResult }\n    exit 0\n}\n");
    script.push_str(&format!("$NativeArgs = @('hook-process', '{agent}')\n"));
    if matches!(agent, "qoder" | "qoder-cn") {
        script.push_str("$NativeArgs += '--wakeup-only'\n");
    }
    match hook.mode {
        Mode::Payload => {}
        Mode::Event(allowed) => {
            script.push_str("$Event = if ($args.Count -gt 0) { $args[0] } else { 'unknown' }\n");
            if !allowed.is_empty() {
                let allowed = allowed
                    .iter()
                    .map(|event| format!("'{event}'"))
                    .collect::<Vec<_>>()
                    .join(", ");
                script.push_str(&format!(
                    "if ($Event -notin @({allowed})) {{ Write-Output $EmptyResult; exit 0 }}\n"
                ));
            }
            script.push_str("$NativeArgs += $Event\n");
        }
        Mode::Identity => {
            script.push_str(&format!("$AgentId = if ($args.Count -gt 0) {{ $args[0] }} else {{ '{agent}' }}\n$NativeArgs += @('--agent-id', $AgentId, '--log-prefix', $AgentId)\n"));
        }
        Mode::FixedIdentity => {
            script.push_str(&format!(
                "$NativeArgs += @('--agent-id', '{agent}', '--log-prefix', '{agent}')\n"
            ));
        }
        Mode::Interceptor => {
            script.push_str(&format!(
                "$NativeArgs = @('interceptor', 'hook', '--agent', '{agent}') + $args\n"
            ));
        }
    }
    script.push_str("try {\n    . (Join-Path $PSScriptRoot 'shared\\native.ps1')\n    Invoke-PilotNative -HookDir $PSScriptRoot -Arguments $NativeArgs -EmptyResult $EmptyResult\n} catch {\n    Write-Error '[loongsuite-pilot] native hook bootstrap failed' -ErrorAction Continue\n    if ($EmptyResult) { Write-Output $EmptyResult }\n}\nexit 0\n");
    script
}

fn shell(hook: &Hook) -> String {
    let agent = hook.agent;
    let empty = if matches!(hook.mode, Mode::Identity | Mode::Interceptor) {
        ""
    } else {
        "{}"
    };
    let bootstrap = if agent == "qoder-cn" {
        "if [ -z \"${BASH_VERSION:-}\" ]; then\n  exec bash -- \"$0\" \"$@\"\nfi\nset +o posix\n"
    } else {
        ""
    };
    let mut script = format!("#!/usr/bin/env bash\n{bootstrap}set -u\nEMPTY_RESULT='{empty}'\nNATIVE_ARGS=('hook-process' '{agent}')\n");
    if matches!(agent, "qoder" | "qoder-cn") {
        script.push_str("NATIVE_ARGS+=('--wakeup-only')\n");
    }
    match hook.mode {
        Mode::Payload => {}
        Mode::Event(allowed) => {
            script.push_str("EVENT=\"${1:-unknown}\"\n");
            if !allowed.is_empty() {
                script.push_str(&format!("case \"$EVENT\" in {}) ;; *) printf '%s\\n' \"$EMPTY_RESULT\"; exit 0 ;; esac\n", allowed.join("|")));
            }
            script.push_str("NATIVE_ARGS+=(\"$EVENT\")\n");
        }
        Mode::Identity => {
            script.push_str(&format!("AGENT_ID=\"${{1:-{agent}}}\"\nNATIVE_ARGS+=('--agent-id' \"$AGENT_ID\" '--log-prefix' \"$AGENT_ID\")\n"));
        }
        Mode::FixedIdentity => {
            script.push_str(&format!(
                "NATIVE_ARGS+=('--agent-id' '{agent}' '--log-prefix' '{agent}')\n"
            ));
        }
        Mode::Interceptor => {
            script.push_str(&format!(
                "NATIVE_ARGS=('interceptor' 'hook' '--agent' '{agent}' \"$@\")\n"
            ));
        }
    }
    script.push_str(
        r#"HOOK_DIR="${BASH_SOURCE[0]%/*}"
[[ "$HOOK_DIR" != "${BASH_SOURCE[0]}" ]] || HOOK_DIR=.
if HOOK_DIR="$(cd -- "$HOOK_DIR" && pwd -P)" && source "$HOOK_DIR/shared/native.sh"; then
  pilot_invoke_native "$HOOK_DIR" "$EMPTY_RESULT" "${NATIVE_ARGS[@]}"
else
  printf '%s\n' '[loongsuite-pilot] native hook bootstrap failed' >&2
  [[ -z "$EMPTY_RESULT" ]] || printf '%s\n' "$EMPTY_RESULT"
fi
exit 0
"#,
    );
    script
}

pub fn runtime_files() -> Vec<String> {
    HOOKS
        .iter()
        .flat_map(|hook| {
            ["sh", "ps1"].map(|extension| format!("assets/hooks/{}.{extension}", hook.file))
        })
        .chain([
            "assets/hooks/shared/native.sh".into(),
            "assets/hooks/shared/native.ps1".into(),
        ])
        .collect()
}

pub fn sync(root: &Path, check: bool) -> Result<()> {
    let directory = root.join("assets/hooks");
    let mut stale = Vec::new();
    for hook in HOOKS {
        for (extension, content) in [("ps1", powershell(hook)), ("sh", shell(hook))] {
            let path = directory.join(format!("{}.{extension}", hook.file));
            ensure!(content.is_ascii(), "PowerShell 5.1 无 BOM 脚本必须为 ASCII");
            if fs::read(&path).ok().as_deref() == Some(content.as_bytes()) {
                continue;
            }
            if check {
                stale.push(path.display().to_string());
            } else {
                fs::write(&path, content)
                    .with_context(|| format!("无法生成 {}", path.display()))?;
                #[cfg(unix)]
                if extension == "sh" {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
                }
            }
        }
    }
    ensure!(stale.is_empty(), "Hook 入口未同步：{}", stale.join(", "));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrappers_keep_arguments_and_do_not_load_host_runtimes() {
        for hook in HOOKS {
            let script = powershell(hook);
            assert!(script.is_ascii());
            assert!(script.contains(hook.agent));
            for forbidden in [
                "node",
                ".mjs",
                "Get-Content",
                "ProcessStartInfo",
                "ReadToEnd",
                "2>$null",
                "Out-Null",
            ] {
                assert!(!script.contains(forbidden), "{}: {forbidden}", hook.file);
            }
            assert!(script.ends_with("exit 0\n"));
        }
    }

    #[test]
    fn check_refuses_missing_and_modified_wrappers_without_writing() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("assets/hooks")).unwrap();
        assert!(sync(root.path(), true).is_err());
        assert_eq!(
            fs::read_dir(root.path().join("assets/hooks"))
                .unwrap()
                .count(),
            0
        );
        sync(root.path(), false).unwrap();
        sync(root.path(), true).unwrap();
        let path = root
            .path()
            .join("assets/hooks/cursor-loongsuite-pilot-hook.ps1");
        fs::write(&path, "modified").unwrap();
        assert!(sync(root.path(), true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "modified");
    }
}
