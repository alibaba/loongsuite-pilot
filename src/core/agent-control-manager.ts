import type { AgentControlConfig, AgentControlMode } from '../types/index.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const DEFAULT_AGENT_CONTROL_PATH = '~/.loongsuite-pilot/agent-control.json';
const logger = createLogger('AgentControlManager');

/**
 * Three-tier gating manager for agent admission control.
 *
 * Mode precedence:
 *   "on"  → force-enable regardless of other conditions
 *   "off" → force-disable regardless of other conditions
 *   "auto"(default) → delegate to the next layer (config default / isAvailable)
 */
export class AgentControlManager {
  private config: AgentControlConfig = { version: 3, tools: {} };
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveHome(DEFAULT_AGENT_CONTROL_PATH);
  }

  async load(): Promise<void> {
    const data = await readJsonFile<AgentControlConfig>(this.filePath);
    if (data && typeof data.tools === 'object') {
      this.config = { version: data.version ?? 3, tools: data.tools };
    }
    logger.info('loaded agent-control config', {
      tools: Object.keys(this.config.tools).length,
    });
  }

  async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.config);
  }

  /**
   * Resolve whether a tool should be enabled.
   *
   * @param agentId   — unique agent identifier (e.g. "qoder", "cursor")
   * @param defaultWhenAuto — what to return when mode is "auto" (from config/defaults)
   */
  resolveEnabled(agentId: string, defaultWhenAuto = true): boolean {
    const mode = this.getMode(agentId);
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return defaultWhenAuto;
  }

  getMode(agentId: string): AgentControlMode {
    return this.config.tools[agentId] ?? 'auto';
  }

  setMode(agentId: string, mode: AgentControlMode): void {
    this.config.tools[agentId] = mode;
  }

  getAllModes(): Record<string, AgentControlMode> {
    return { ...this.config.tools };
  }
}
