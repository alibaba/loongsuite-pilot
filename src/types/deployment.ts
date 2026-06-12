/**
 * Deployment types — agent definition, deploy strategy, and related interfaces.
 */

// ─── Deploy Mode ───

export type DeployMode = 'hook' | 'plugin-probe' | 'plugin-inject';
export type MountType = 'wrapper' | 'rc-inject' | 'env-inject';
export type HookFormat = 'flat' | 'nested';
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
  events: string[];
  hookCommand: string;
  format: HookFormat;
  matcher?: string;
  replaceHookCommands?: string[];
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
   */
  eventSubcommand?: 'kebab-case';
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
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  deployMode: DeployMode;
  detection: AgentDetectionConfig;
  hook?: AgentHookConfig;
  pluginProbe?: PluginProbeConfig;
  pluginInject?: PluginInjectConfig;
  input?: AgentInputConfig;
}

// ─── Deploy Result ───

export interface DeployResult {
  success: boolean;
  agentId: string;
  deployMode: DeployMode;
  skipped?: boolean;
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
}

export type DeployedAgentsState = Record<string, DeployedAgentRecord>;
