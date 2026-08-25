/**
 * Deployment types — agent definition, deploy strategy, and related interfaces.
 */

// ─── Deploy Mode ───

export type DeployMode =
  | 'hook'
  | 'plugin-probe'
  | 'plugin-inject'
  | 'directory-plugin'
  | 'detection-only'
  | 'dsh-yaml-patch'
  | 'log-watch';
export type MountType = 'wrapper' | 'rc-inject' | 'env-inject';
export type HookFormat = 'flat' | 'nested';
export type SettingsSyntax = 'json' | 'jsonc';
export type PluginSourceType = 'oss' | 'tar';

// ─── Agent Definition (loaded from agents.d/*.json) ───

export interface AgentDetectionConfig {
  paths: string[];
  commands: string[];
}

/**
 * Codex hook trust 写入配置。仅当 agent 的 hook 协议要求 trust hash（如 codex v0.125+）时填写。
 *
 * pilot 在 deploy 时会按此配置在目标机器上动态计算 trust hash 并写入指定 TOML 文件。
 * 算法版本号 `trustAlgo` 留作上游算法变更时的升级抓手；marker 名用于幂等替换/清理 BEGIN/END 块。
 */
export interface TrustTomlConfig {
  /** Trust state 写入的 TOML 文件路径（如 ~/.codex/config.toml）。 */
  configPath: string;
  /** Trust hash 算法版本号。当前固定为 'v1'，对齐 codex 上游 fingerprint.rs。 */
  trustAlgo: 'v1';
  /** BEGIN/END marker 名（如 "otel-codex-hook"），用于幂等替换 + 清理老 plugin 残留。 */
  marker: string;
}

export interface AgentHookConfig {
  settingsPath: string;
  /**
   * Syntax accepted by the owning agent's settings file. Defaults to strict
   * JSON. JSONC files are edited in place so comments and unrelated formatting
   * survive hook installation.
   */
  settingsSyntax?: SettingsSyntax;
  events: string[];
  hookCommand: string;
  format: HookFormat;
  matcher?: string;
  /** Optional matcher override keyed by hook event name. */
  eventMatchers?: Record<string, string>;
  replaceHookCommands?: string[];
  /** Events previously owned by this hook that must be removed during deploy. */
  retiredEvents?: string[];
  /**
   * 可选的 trust TOML 配置。仅 Codex 等需要 trust hash 校验的 agent 填写。
   * 设置后，HookStrategy 在 deploy 时会调用 codex-trust-writer 写入对应 TOML 文件。
   */
  trustToml?: TrustTomlConfig;
  /**
   * 是否给每个 event 拼 subcommand 后缀（kebab-case）。默认 undefined（共享 command，
   * 适用 Cursor / Qoder 等 stdin 自带 hook_event_name 的 agent）。
   *
   * Claude / Codex 的 mjs handler 通过 argv 区分事件，设为 'kebab-case' 后，
   * buildHookDefinitions 会把 hookCommand 转成 `${hookCommand} ${kebabEvent}`，
   * trust hash 也用同样字符串，保证一致性。
   *
   * Kiro CLI 的 hook trigger 是 camelCase（userPromptSubmit/postToolUse/...），
   * 设为 'as-is' 后，buildHookDefinitions 会把 hookCommand 转成
   * `${hookCommand} ${event}`（事件名原样追加）。
   */
  eventSubcommand?: 'kebab-case' | 'as-is';
  /**
   * If true, omit quotes around the -File path on Windows.
   * Use for agents whose hook executor does direct spawn (not shell),
   * where the quoted path in -File "..." would become literal characters.
   */
  rawCommand?: boolean;
  /**
   * Windows-only: shell to declare on the nested hook entry
   * (`{ command, type, shell }`). Some hosts (Qoder family) require an explicit
   * `"shell": "powershell"` so the host runs the `.ps1` command through
   * PowerShell instead of its default shell. Ignored on non-Windows platforms
   * (where the command is a `.sh`), and only emitted for agents that set it —
   * codex must never set it (its settings use serde deny_unknown_fields).
   */
  winShell?: string;
  /**
   * Optional env block to merge into the agent's settings.json on deploy.
   *
   * Each value may contain the `$PILOT_DATA` token; AgentDefLoader resolves
   * it (recursively, honoring `LOONGSUITE_PILOT_DATA_DIR`) when loading the
   * agent definition, so HookStrategy receives already-expanded strings.
   *
   * Merge semantics:
   *   - Regular keys: overwrite if present
   *   - `BUN_OPTIONS` is treated as space-separated flags; if every token
   *     we would add is already present, the write is skipped to keep
   *     deploy idempotent and to coexist with other preload scripts the
   *     user may have configured.
   *
   * NOTE: settings.json env is read AFTER the agent's main process starts,
   * so it can only affect child processes the agent spawns. It cannot
   * influence runtime flags that the host process itself consumes at
   * startup — most notably `BUN_OPTIONS` for Bun-compiled binaries, which
   * Bun reads before any JS executes. For BUN_OPTIONS-style injections,
   * use a shell-rc wrapper instead (see installer-opensource.sh
   * inject_claude_code_fetch_intercept).
   */
  env?: Record<string, string>;
  /**
   * Kiro CLI 专用：settingsPath 指向的是一整个 Agent 定义 JSON
   * （~/.kiro/agents/<name>.json），需要顶层 name + tools 字段。
   * HookStrategy 在 ensureSettingsFile 时若文件缺失会用此模板 seed。
   */
  kiroAgent?: {
    name: string;
    tools: string[];
  };
}

export interface PluginSourceConfig {
  type: PluginSourceType;
  tarball?: string;
  url?: string;
  destDir: string;
  remoteUrl?: string;
}

export interface PluginInstallConfig {
  command: string;
  args: string[];
  cwd: string;
}

export interface PluginProbeConfig {
  source: PluginSourceConfig;
  mountType: MountType;
}

export interface AgentInputConfig {
  type: string;
  logDir?: string;
  [key: string]: unknown;
}

export interface PluginInjectConfig {
  configPaths: string[];
  pluginSpec: string;
  pluginId: string;
  replaceSpecs?: string[];
  /** Agent-specific config layout. Omitted for the legacy flat-array layout. */
  configShape?: 'openclaw-nested';
  /** Required plugin entry fields for nested config layouts. */
  entryConfig?: Record<string, unknown>;
  /** Target array field. Defaults to auto-detected `plugins` / `plugin`. */
  configKey?: string;
  /** Create the first config path with an empty object when none exists. */
  createIfMissing?: boolean;
}

export interface AgentRuntimeConfig {
  /** 运行时依赖的简述，如 "required-for-transcript" */
  nodeSqlite?: string;
  /** 该 builtin 首次可用的 Node 版本 */
  nodeSqliteSince?: string;
  /** 无该 builtin 时的 fallback 行为说明 */
  fallback?: string;
}

/**
 * Metadata for a custom Agent built on the high-level
 * `@earendil-works/pi-coding-agent` SDK.
 *
 * PI SDK integrations still deploy through the generic `plugin-inject`
 * strategy.  This marker identifies definitions managed by the public
 * `loongsuite-pilot agent ...` CLI so shared input gating, diagnostics, and
 * uninstall cleanup can include them without introducing another deploy mode.
 */
export interface PiSdkIntegrationConfig {
  schemaVersion: 1;
  /** Directory passed to createAgentSession({ agentDir }). */
  agentDir: string;
}

export interface DirectoryPluginConfig {
  /** Managed plugin directory copied by Pilot. */
  sourceDir: string;
  /** Final directory consumed by the target Agent. */
  targetDir: string;
  /** Ownership marker stored inside targetDir. */
  markerFile?: string;
  /** Optional target-native command used to activate the copied plugin. */
  activation?: DirectoryPluginActivationConfig;
}

export interface DirectoryPluginActivationConfig {
  /** Target Agent CLI executable. */
  command: string;
  /** Capability probe. A non-zero result means an older target does not require activation. */
  probeArgs?: string[];
  /** Maximum runtime for probe/enable/disable commands. */
  timeoutMs?: number;
  /** Arguments that enable the plugin after it has been copied. */
  enableArgs: string[];
  /** Best-effort arguments that disable the plugin before Pilot removes it. */
  disableArgs?: string[];
}

/**
 * Config for the `dsh-yaml-patch` deploy mode — Pilot manages a single
 * marked YAML block inside deepseek-harness's machine-wide user patch
 * layer (`$DSH_HOME/cordis.patch.yml`) so a plain `dsh` invocation loads
 * the Pilot plugin without wrappers or aliases.
 *
 * The strategy only ever appends/removes its own `# BEGIN/END <marker>`
 * block; non-Pilot bytes (user rows, comments, formatting) are preserved
 * verbatim. `entryId` is the stable YAML row id and doubles as the
 * conflict-detection key — another integration reusing the same id but a
 * different marker/path is rejected, not overwritten.
 */
export interface DshYamlPatchConfig {
  /** Absolute (variable-expanded) `file://` URL to the Pilot plugin.mjs. */
  pluginSource: string;
  /**
   * Patch YAML path. Defaults to `$DSH_HOME/cordis.patch.yml` when omitted.
   * `$DSH_HOME` expands to `~/.dsh` unless overridden by the environment.
   */
  patchPath?: string;
  /** Stable YAML row id used by Pilot and referenced in needsDeploy. */
  entryId: string;
  /** BEGIN/END marker name surrounding the Pilot-managed block. */
  marker: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  deployMode: DeployMode;
  detection: AgentDetectionConfig;
  /** Runtime id used by local worker activation, e.g. "claude-code". */
  localWorkerRuntime?: string;
  hook?: AgentHookConfig;
  pluginProbe?: PluginProbeConfig;
  pluginInject?: PluginInjectConfig;
  /** Present only for registered high-level PI SDK Agents. */
  piSdk?: PiSdkIntegrationConfig;
  directoryPlugin?: DirectoryPluginConfig;
  /** Present only for `dsh-yaml-patch` agents. */
  dshYamlPatch?: DshYamlPatchConfig;
  input?: AgentInputConfig;
  /** 运行时要求（如 node:sqlite）与无该依赖时的 fallback 声明 */
  runtime?: AgentRuntimeConfig;
}

// ─── Deploy Result ───

/**
 * Why a deploy was skipped. `skipped: true` alone is ambiguous — "the agent is
 * not installed here" and "its integration is already in place" are opposite
 * outcomes, and `loongsuite-pilot deploy --require` has to treat them
 * differently (the first is a build failure, the second is success).
 */
export type DeploySkipReason =
  /** detect() found no agent on this machine — nothing was instrumented. */
  | 'not-detected'
  /** Integration already present (includes detection-only agents, which never write). */
  | 'up-to-date'
  /** Turned off by the config.agents gate, so it was undeployed instead. */
  | 'disabled';

export interface DeployResult {
  success: boolean;
  agentId: string;
  deployMode: DeployMode;
  skipped?: boolean;
  /** Set whenever `skipped` is true. */
  reason?: DeploySkipReason;
  error?: string;
}

// ─── Deploy Strategy ───

export interface DeployStrategy {
  detect(def: AgentDefinition): Promise<boolean>;
  needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean>;
  deploy(def: AgentDefinition): Promise<DeployResult>;
  undeploy(def: AgentDefinition): Promise<boolean>;
}

// ─── Deployed Agent Record (persisted to deployed-agents.json) ───

export interface DeployedAgentRecord {
  deployMode: DeployMode;
  deployedAt: string;
  sourceHash?: string;
  lastRemoteCheckedAt?: string;
  /** Resolved external target for managed directory plugins. */
  targetDir?: string;
  /** Resolved cordis.patch.yml path used by the DSH integration lifecycle. */
  dshPatchPath?: string;
}

export type DeployedAgentsState = Record<string, DeployedAgentRecord>;
