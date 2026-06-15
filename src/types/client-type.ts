/**
 * All supported AI coding tool types.
 * Extend this enum when adding a new agent.
 */
export enum ClientType {
  // IDE tools
  Cursor = 'cursor',
  Qoder = 'qoder',
  QoderCn = 'qoder-cn',
  QoderIdea = 'qoder-idea',
  QoderWork = 'qoder-work',
  QoderWorkCN = 'qoder-work-cn',
  Kiro = 'kiro',
  KiroCli = 'kiro-cli',
  Antigravity = 'antigravity',
  Lingma = 'lingma',
  LingmaVscode = 'lingma-vscode',
  Wukong = 'wukong',

  // CLI tools
  GeminiCli = 'gemini-cli',
  YkCli = 'ykcli',
  QwenCodeCli = 'qwen-code-cli',
  KimiCodeCli = 'kimi-code-cli',
  CodexSession = 'codex-session',
  QoderCli = 'qoder-cli',

  // Hook-based tools
  ClaudeCliHook = 'claude-code',
  IflowCliHook = 'iflow-cli-hook',
  CursorHook = 'cursor-hook',
  QoderCliHook = 'qoder-cli-hook',
  QoderCnHook = 'qoder-cn-hook',
  CodexCliHook = 'codex',
  ClineHook = 'cline-hook',
  GithubCopilotHook = 'github-copilot-hook',
  AoneCopilotHook = 'aone-copilot-hook',
  OpenCode = 'opencode',

}

export enum ToolType {
  IDE = 'ide',
  CLI = 'cli',
  Hook = 'hook',
  Plugin = 'plugin',
}

export enum CollectionMethod {
  /** Periodically read IDE local DiskKV / history files */
  IdeSnapshotPolling = 'ide-snapshot-polling',
  /** Incrementally query a local SQLite database */
  SqlitePolling = 'sqlite-polling',
  /** Intercept tool events via injected hook scripts, read JSONL logs */
  HookJsonl = 'hook-jsonl',
  /** Configure tool telemetry output to a file, poll and forward */
  CliTelemetryForwarding = 'cli-telemetry-forwarding',
  /** Read session record files (JSONL/JSON) */
  SessionFilePolling = 'session-file-polling',
  /** Access tool's Language Server via HTTP API */
  LsHttpApi = 'ls-http-api',
  /** Poll agent data via local CLI API (e.g. wukong) */
  CliApiPolling = 'cli-api-polling',
}
