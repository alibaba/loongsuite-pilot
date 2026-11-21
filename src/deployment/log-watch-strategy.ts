import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from "../types/index.js";
import { detectAgent } from "./detect-utils.js";

/**
 * Deploy strategy for log-watch agents (e.g. trae-agent). The target tool
 * writes a single trajectory JSON file that is overwritten each cycle; no
 * shell hook, plugin, or settings file is installed. Only `detect()` runs;
 * `deploy()` is a successful no-op, mirroring DetectionOnlyStrategy but
 * flagged under the dedicated `log-watch` mode so input wiring can branch
 * on it without overloading `detection-only`.
 */
export class LogWatchStrategy implements DeployStrategy {
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(_def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    return {
      success: true,
      agentId: def.id,
      deployMode: "log-watch",
      skipped: true,
      reason: "up-to-date",
    };
  }

  async undeploy(_def: AgentDefinition): Promise<boolean> {
    return true;
  }
}
