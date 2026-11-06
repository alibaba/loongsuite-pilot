use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

macro_rules! str_enum {
    ($name:ident { $($var:ident = $s:literal),* $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $var,)*
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$var),*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$var => $s,)*
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = String;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok($name::$var),)*
                    other => Err(format!("unknown {}: {other}", stringify!($name))),
                }
            }
        }
    };
}

str_enum!(ClientType {
    Cursor = "cursor",
    CopilotCli = "copilot",
    Qoder = "qoder",
    QoderCn = "qoder-cn",
    QoderIdea = "qoder-idea",
    QoderWork = "qoder-work",
    QoderWorkCN = "qoder-work-cn",
    QwenWorkCN = "qwen-work-cn",
    Kiro = "kiro",
    KiroCli = "kiro-cli",
    Antigravity = "antigravity",
    Lingma = "lingma",
    LingmaVscode = "lingma-vscode",
    Wukong = "wukong",
    WorkBuddy = "workbuddy",
    DoubaoWork = "doubao-work",
    GeminiCli = "gemini-cli",
    YkCli = "ykcli",
    QwenCodeCli = "qwen-code-cli",
    KimiCodeCli = "kimi-code-cli",
    CodexSession = "codex-session",
    QoderCli = "qoder-cli",
    CursorCli = "cursor-cli",
    PiCodingAgent = "pi-coding-agent",
    ClaudeCliHook = "claude-code",
    IflowCliHook = "iflow-cli-hook",
    CursorHook = "cursor-hook",
    QoderCliHook = "qoder-cli-hook",
    QoderIdeaHook = "qoder-idea-hook",
    QoderCnHook = "qoder-cn-hook",
    CodexCliHook = "codex",
    ClineHook = "cline-hook",
    GithubCopilotHook = "github-copilot-hook",
    AoneCopilotHook = "aone-copilot-hook",
    GrokBuildHook = "grok-build",
    OpenCode = "opencode",
    MimoCode = "mimo-code",
    Hermes = "hermes",
    OpenClaw = "openclaw",
    Dsh = "dsh",
});

str_enum!(ToolType {
    Ide = "ide",
    Cli = "cli",
    Hook = "hook",
    Plugin = "plugin",
});

str_enum!(CollectionMethod {
    IdeSnapshotPolling = "ide-snapshot-polling",
    SqlitePolling = "sqlite-polling",
    HookJsonl = "hook-jsonl",
    CliTelemetryForwarding = "cli-telemetry-forwarding",
    SessionFilePolling = "session-file-polling",
    LsHttpApi = "ls-http-api",
    CliApiPolling = "cli-api-polling",
});
