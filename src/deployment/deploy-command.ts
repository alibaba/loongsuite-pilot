import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalyticsConfig, DeployResult } from '../types/index.js';
import { DeploymentManager } from './deployment-manager.js';
import { ensureRegisteredPiSdkWrappers } from '../pi-sdk/pi-sdk-agent-registry.js';
import { loadConfig } from '../core/config-loader.js';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger, redirectRootLoggerToStderr } from '../utils/logger.js';

const logger = createLogger('DeployCommand');

const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

/**
 * Check whether an agent is allowed to run based on the `config.agents` gate.
 * - No config.agents or empty: always true (backward compat)
 * - Otherwise: only if config.agents[agentId].enabled !== false
 */
export function isAgentGatedEnabled(config: AnalyticsConfig, agentId: string): boolean {
  const agents = config.agents;
  if (!agents || Object.keys(agents).length === 0) return true;
  return agents[agentId]?.enabled !== false;
}

/**
 * Resolve the package installation directory by reading the `current` pointer file.
 * Falls back to the module's own package root, then to dataDir.
 *
 * `moduleUrl` must be supplied by the caller so the module-root fallback is
 * anchored at the caller's file, not at this shared helper.
 */
export function resolvePilotDir(dataDir: string, moduleUrl: string): string {
  try {
    const currentFile = path.join(dataDir, 'current');
    const versionName = fsSync.readFileSync(currentFile, 'utf-8').trim();
    if (versionName) {
      const versionDir = path.join(dataDir, 'versions', versionName);
      if (fsSync.existsSync(versionDir)) {
        logger.debug('resolved pilotDir from current pointer', { pilotDir: versionDir });
        return versionDir;
      }
    }
  } catch {
    // current file doesn't exist — legacy or dev layout
  }

  const legacyPackageDir = path.join(dataDir, 'package');
  if (fsSync.existsSync(path.join(legacyPackageDir, 'dist', 'index.js'))) {
    return legacyPackageDir;
  }

  try {
    const moduleDir = path.dirname(fileURLToPath(moduleUrl));
    const candidates = [
      path.resolve(moduleDir, '..'),
      path.resolve(moduleDir, '..', '..'),
    ];
    for (const modulePackageDir of candidates) {
      const packageJson = path.join(modulePackageDir, 'package.json');
      const agentsDir = path.join(modulePackageDir, 'agents.d');
      if (
        fsSync.existsSync(packageJson)
        && fsSync.existsSync(agentsDir)
        && fsSync.statSync(packageJson).isFile()
        && fsSync.statSync(agentsDir).isDirectory()
      ) {
        logger.debug('resolved pilotDir from module package root', { pilotDir: modulePackageDir });
        return modulePackageDir;
      }
    }
  } catch {
    // Module URL is invalid or the runtime package does not include required assets.
  }

  return dataDir;
}

export interface DeployCommandOptions {
  /**
   * Agent ids whose instrumentation MUST be in place when the command returns.
   * "In place" includes an agent that was already deployed — re-running the
   * command in the same dataDir (a derived image rebuilding on top of an
   * instrumented base) has to stay green, so only `not-detected` / `disabled`
   * and hard failures count as unmet.
   */
  required: string[];
  json: boolean;
}

/** A required agent that did not end up instrumented, plus why. */
export interface UnmetRequirement {
  agentId: string;
  reason: 'not-detected' | 'disabled' | 'failed' | 'unknown-id';
  error?: string;
}

/**
 * `loongsuite-pilot deploy` — run hook registration / plugin installation once,
 * synchronously, then exit.
 *
 * The collector performs the same deployment during `orchestrator.start()`, but
 * only as a side effect of a long-running daemon. Image builds need it as a
 * foreground step with an exit code: a `docker build` layer tears the daemon down
 * as soon as the RUN command returns, so whether the hooks were written before
 * the layer is committed would otherwise be a race.
 */
export async function runDeployCommand(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  // Deployment logs are diagnostics, not the command's output. Keep stdout clean
  // so `--json` stays machine-readable.
  redirectRootLoggerToStderr();

  const config = await loadConfig();
  const dataDir = resolveHome(config.dataDir || DEFAULT_DATA_DIR);
  const pilotDir = resolvePilotDir(dataDir, import.meta.url);

  // Registered PI SDK agents live in dataDir, not agents.d — their generated
  // wrappers must exist before deployAll walks the definition list.
  await ensureRegisteredPiSdkWrappers(dataDir).catch(err => {
    logger.warn('failed to restore PI SDK agent wrappers', { error: String(err) });
    return 0;
  });

  const manager = new DeploymentManager({ dataDir, pilotDir });
  const results = await manager.deployAll(def => isAgentGatedEnabled(config, def.id));

  // Probe workers started during detection must not survive into the image: a
  // worker.pid written on the build host can collide with a live pid in the
  // container's fresh PID namespace, and isWorkerRunning() would then report a
  // worker that does not exist — leaving telemetry silently off. A failure here
  // is reported, not swallowed, because the leftover pid is the actual hazard.
  let workerStopFailed = false;
  await manager.stopWorkers().catch(err => {
    workerStopFailed = true;
    logger.error('failed to stop probe workers', { error: String(err) });
  });

  const knownIds = new Set(manager.getDefinitions().map(def => def.id));
  const unmet = collectUnmet(opts.required, knownIds, results);

  if (opts.json) {
    console.log(JSON.stringify({
      dataDir,
      pilotDir,
      results,
      required: opts.required,
      unmet,
      workerStopFailed,
    }, null, 2));
  } else {
    printHuman(results, opts.required, unmet, workerStopFailed);
  }

  return deployExitCode(results, unmet, workerStopFailed);
}

/**
 * Map a deploy outcome to a process exit code.
 *
 * A hard failure counts even when nobody required that agent: without this, a
 * caller that passes no --require at all would let a plugin-extraction error
 * pass as a successful build layer.
 */
export function deployExitCode(
  results: DeployResult[],
  unmet: UnmetRequirement[],
  workerStopFailed: boolean,
): number {
  const failed = results.some(r => !r.success);
  return unmet.length > 0 || failed || workerStopFailed ? 1 : 0;
}

/**
 * Decide which required agents did not end up instrumented.
 *
 * `skipped` on its own says nothing: `up-to-date` means the integration is in
 * place (including detection-only agents, which never write anything), while
 * `not-detected` and `disabled` mean it is not. Treating every skip as a failure
 * makes the command non-idempotent and permanently unsatisfiable for
 * detection-only agents.
 */
export function collectUnmet(
  required: string[],
  knownIds: Set<string>,
  results: DeployResult[],
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];

  for (const agentId of required) {
    if (!knownIds.has(agentId)) {
      unmet.push({ agentId, reason: 'unknown-id' });
      continue;
    }
    const result = results.find(r => r.agentId === agentId);
    if (!result) {
      unmet.push({ agentId, reason: 'not-detected' });
      continue;
    }
    if (!result.success) {
      unmet.push({ agentId, reason: 'failed', error: result.error });
      continue;
    }
    if (result.skipped && result.reason !== 'up-to-date') {
      unmet.push({ agentId, reason: result.reason === 'disabled' ? 'disabled' : 'not-detected' });
    }
  }

  return unmet;
}

const SKIP_LABEL: Record<string, string> = {
  'not-detected': 'not detected on this machine',
  'up-to-date': 'already in place',
  disabled: 'disabled by the config.agents gate',
};

function printHuman(
  results: DeployResult[],
  required: string[],
  unmet: UnmetRequirement[],
  workerStopFailed: boolean,
): void {
  const deployed = results.filter(r => r.success && !r.skipped);
  const skipped = results.filter(r => r.skipped);
  const failed = results.filter(r => !r.success);

  for (const r of deployed) {
    console.log(`  ✅ ${r.agentId} (${r.deployMode}) deployed`);
  }
  for (const r of skipped) {
    const why = SKIP_LABEL[r.reason ?? ''] ?? 'reason not reported';
    console.log(`  ➖ ${r.agentId} (${r.deployMode}) skipped — ${why}`);
  }
  for (const r of failed) {
    console.log(`  ❌ ${r.agentId} (${r.deployMode}) failed — ${r.error ?? 'unknown error'}`);
  }
  console.log(
    `deploy complete: ${deployed.length} deployed, ${skipped.length} skipped, ${failed.length} failed`,
  );

  if (workerStopFailed) {
    console.error('');
    console.error('❌ probe workers could not be stopped');
    console.error('   A worker.pid left in the image can collide with an unrelated pid in the');
    console.error("   container's PID namespace, which makes the collector believe a worker is");
    console.error('   already running and silently skip starting one.');
  }

  if (unmet.length === 0) {
    if (required.length > 0) {
      console.log(`✅ all required agents are instrumented: ${required.join(', ')}`);
    }
    return;
  }

  console.error('');
  console.error(`❌ required agents are not instrumented: ${unmet.map(u => u.agentId).join(', ')}`);
  for (const u of unmet) {
    switch (u.reason) {
      case 'unknown-id':
        console.error(`   ${u.agentId}: no such agent id — check the spelling against \`loongsuite-pilot info\``);
        break;
      case 'not-detected':
        console.error(`   ${u.agentId}: not detected. In an image build, install the agent and set its`);
        console.error('     environment (e.g. HERMES_HOME) in the SAME layer, before this step.');
        break;
      case 'disabled':
        console.error(`   ${u.agentId}: disabled by the config.agents gate — remove it from the gate or from --require`);
        break;
      case 'failed':
        console.error(`   ${u.agentId}: deployment failed — ${u.error ?? 'unknown error'}`);
        break;
    }
  }
}

export function parseArgs(argv: string[]): DeployCommandOptions {
  const required: string[] = [];
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--require') {
      required.push(...requireIds(argv[++i], '--require <ids>'));
    } else if (arg.startsWith('--require=')) {
      required.push(...requireIds(arg.slice('--require='.length), '--require=<ids>'));
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return { required: [...new Set(required)], json };
}

/**
 * Parse a --require value, refusing anything that would silently disable the gate.
 *
 * An empty value is the dangerous case: `--require ""` or `--require=$EMPTY_ARG`
 * used to parse as "require nothing" and exit 0, so a build that meant to assert
 * instrumentation asserted nothing instead. A missing value is just as bad in the
 * other direction: `deploy --require --json` would have taken `--json` as an
 * agent id and then failed for the wrong reason.
 */
function requireIds(raw: string | undefined, usage: string): string[] {
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`${usage} requires a value (got ${raw === undefined ? 'nothing' : raw})`);
  }
  const ids = splitIds(raw);
  if (ids.length === 0) {
    throw new Error(
      `${usage} was given an empty value. Omit --require entirely if no agent is required — `
      + 'an empty list would silently disable the check.',
    );
  }
  return ids;
}

function splitIds(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
