import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { detectAgent } from './detect-utils.js';

/**
 * No-op deploy strategy for agents that share an already-installed hook with
 * another agent (e.g., Qoder for JetBrains shares the qoder Stop hook in
 * ~/.qoder/settings.json). Only detect() runs; deploy() is a successful no-op
 * and never writes settings or deployed-agents.json hook entries.
 */
export class DetectionOnlyStrategy implements DeployStrategy {
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(_def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    // Unreachable through DeploymentManager (needsDeploy is always false), but the
    // reason must still say "satisfied" rather than leaving it ambiguous.
    return {
      success: true,
      agentId: def.id,
      deployMode: 'detection-only',
      skipped: true,
      reason: 'up-to-date',
    };
  }

  async undeploy(_def: AgentDefinition): Promise<boolean> {
    return true;
  }
}
