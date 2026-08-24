import type { AgentDefinition } from '../types/index.js';
import { directoryExists, fileExists, resolveHome } from '../utils/fs-utils.js';
import { commandExists, detectAgent } from './detect-utils.js';
import {
  DshRuntimeLocator,
  type DshRuntimeTarget,
} from './dsh-runtime-locator.js';

export interface CliProbeResult {
  id: string;
  displayName: string;
  detected: boolean;
  reason: string;
}

interface DshRuntimeLocatorLike {
  locate(def: AgentDefinition): Promise<DshRuntimeTarget | null>;
}

export interface CliProbeOptions {
  listOnly?: boolean;
  /** Injectable for deterministic procfs tests. */
  dshRuntimeLocator?: DshRuntimeLocatorLike;
}

async function findDetectionReason(def: AgentDefinition): Promise<string> {
  for (const configuredPath of def.detection.paths) {
    const resolved = resolveHome(configuredPath);
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return configuredPath;
    }
  }
  for (const command of def.detection.commands) {
    try {
      if (await commandExists(command)) return `command: ${command}`;
    } catch {
      // Detection is best effort. A failed PATH lookup is an ordinary miss.
    }
  }
  return '';
}

function describeDshTarget(target: DshRuntimeTarget): string {
  switch (target.source) {
    case 'running-process':
      return `running process: DSH_HOME=${target.home}${target.pid === undefined ? '' : ` (pid ${target.pid})`}`;
    case 'pilot-env':
      return `DSH_HOME=${target.home}`;
    case 'configured-patch':
      return `configured patch: ${target.patchPath}`;
    case 'persisted':
      return `persisted patch: ${target.patchPath}`;
    case 'standard-detection':
      return '';
  }
}

/**
 * Probe one installer-selectable Agent.
 *
 * DSH is intentionally the only special case: its runtime home may exist only
 * in a running Node process environment, so the generic path/PATH boolean is
 * insufficient. All failures remain local to this Agent so one transient or
 * ambiguous procfs result cannot erase the complete installer menu.
 */
export async function probeAgentDefinition(
  def: AgentDefinition,
  options: CliProbeOptions = {},
): Promise<CliProbeResult> {
  const result: CliProbeResult = {
    id: def.id,
    displayName: def.displayName,
    detected: false,
    reason: '',
  };

  if (options.listOnly) return result;

  try {
    if (def.deployMode === 'dsh-yaml-patch') {
      const locator = options.dshRuntimeLocator ?? new DshRuntimeLocator();
      const target = await locator.locate(def);
      if (!target) return result;
      return {
        ...result,
        detected: true,
        reason: target.source === 'standard-detection'
          ? await findDetectionReason(def)
          : describeDshTarget(target),
      };
    }

    const detected = await detectAgent(def.detection);
    return {
      ...result,
      detected,
      reason: detected ? await findDetectionReason(def) : '',
    };
  } catch {
    return result;
  }
}

export async function probeAgentDefinitions(
  definitions: AgentDefinition[],
  options: CliProbeOptions = {},
): Promise<CliProbeResult[]> {
  const results: CliProbeResult[] = [];
  for (const def of definitions) {
    if (def.detection.paths.length === 0 && def.detection.commands.length === 0) {
      continue;
    }
    results.push(await probeAgentDefinition(def, options));
  }
  return results;
}
