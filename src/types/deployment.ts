/**
 * Deployment types — agent definition, deploy strategy, and related interfaces.
 */

// ─── Deploy Mode ───

export type DeployMode = 'hook' | 'plugin-probe';
export type MountType = 'wrapper' | 'rc-inject' | 'env-inject';
export type HookFormat = 'flat' | 'nested';
export type PluginSourceType = 'oss' | 'tar';

// ─── Agent Definition (loaded from agents.d/*.json) ───

export interface AgentDetectionConfig {
  paths: string[];
  commands: string[];
}

export interface AgentHookConfig {
  settingsPath: string;
  events: string[];
  hookCommand: string;
  format: HookFormat;
  matcher?: string;
  replaceHookCommands?: string[];
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

export interface AgentDefinition {
  id: string;
  displayName: string;
  deployMode: DeployMode;
  detection: AgentDetectionConfig;
  hook?: AgentHookConfig;
  pluginProbe?: PluginProbeConfig;
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
