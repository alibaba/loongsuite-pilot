import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition, DeployResult } from '../types/deployment.js';
import { readContainerIdentity, type ContainerIdentity } from '../utils/container-identity.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { DeploymentManager } from './deployment-manager.js';
import { definitionAtHookSettings } from './persisted-deploy-paths.js';
import { postAlarm } from '../internal/post-alarm.js';

const logger = createLogger('HookInstall');

export const HOOK_INSTALL_RESULT_FILE = 'last-hook-install.json';
export const HOOK_INSTALL_SIGNAL_FILE = 'hook-install.signal';

export const HOOK_INSTALL_REASONS = [
  'not-detected',
  'uid-mismatch',
  'invalid-settings',
  'overwritten',
  'disabled',
  'unknown-id',
  'settings-dir-missing',
  'deploy-failed',
  'lock-timeout',
  'activation-pending',
  'activation-failed',
  'runtime-unprepared',
] as const;

export type HookInstallReason = typeof HOOK_INSTALL_REASONS[number];

export type HookInstallStatus = 'ok' | 'up-to-date' | 'skipped' | 'failed';

export interface HookInstallAgentResult {
  id: string;
  status: HookInstallStatus;
  reason: HookInstallReason | null;
  hint: string | null;
  settingsPath: string | null;
  deployMode: string | null;
}

export interface HookInstallReport {
  schema: 1;
  identity: string;
  ts: string;
  scope: 'detected' | 'named';
  agents: HookInstallAgentResult[];
  alarmSent?: boolean;
}

export type AgentSelection =
  | { kind: 'skip' }
  | { kind: 'detect'; warnLiteralNull: boolean }
  | { kind: 'named'; ids: string[]; warnLiteralNull: boolean };

const NULL_LITERAL = 'null';
const SKIP_TOKEN = 'none';

export function selectAgents(flag: string | undefined, envValue: string | undefined): AgentSelection {
  const chosen = flag !== undefined ? flag : envValue;
  const warnLiteralNull = (chosen ?? '').trim() === NULL_LITERAL;
  const normalized = (chosen ?? '').trim();
  if (chosen === undefined || normalized.length === 0 || normalized === NULL_LITERAL) {
    return { kind: 'detect', warnLiteralNull };
  }
  if (normalized === SKIP_TOKEN) return { kind: 'skip' };
  const ids = [...new Set(normalized.split(',').map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { kind: 'detect', warnLiteralNull };
  return { kind: 'named', ids, warnLiteralNull: false };
}

export function hintForReason(reason: HookInstallReason, agentId?: string): string {
  switch (reason) {
    case 'not-detected':
      return `Agent ${agentId ?? ''} was not detected. Set its home variable or install its command on PATH.`.replace('  ', ' ');
    case 'uid-mismatch':
      return 'Run hook install as the agent user. The home directory belongs to a different uid.';
    case 'invalid-settings':
      return 'The settings file is not valid JSON. Fix the reported file and line, then run hook install again.';
    case 'overwritten':
      return 'Settings changed after injection. Run hook install after rendering config, before the agent reads it.';
    case 'disabled':
      return `Agent ${agentId ?? ''} is disabled in config.agents.`.trim();
    case 'unknown-id':
      return `Unknown agent id ${agentId ?? ''}. Use an id from agents.d.`.replace('  ', ' ');
    case 'settings-dir-missing':
      return 'The settings directory is missing and could not be created. Check the home path and permissions.';
    case 'deploy-failed':
      return 'Deployment failed. Check the error and run hook install again.';
    case 'lock-timeout':
      return 'Timed out waiting for the deployment state lock. Retry hook install.';
    case 'activation-pending':
      return 'Plugin activation is still pending. Retry hook install after the agent finishes starting.';
    case 'activation-failed':
      return 'Plugin activation failed. Check the agent log and retry hook install.';
    case 'runtime-unprepared':
      return 'The Pilot data directory could not be prepared. Check --pilot-dir and directory permissions.';
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}

export function settingsPathForHome(def: AgentDefinition, home: string): string {
  if (def.id === 'grok-build') return path.join(home, 'hooks', 'loongsuite-pilot.json');
  const base = def.hook?.settingsPath ? path.basename(def.hook.settingsPath) : 'settings.json';
  return path.join(home, base);
}

export function hookInstallResultPath(dataDir: string): string {
  return path.join(dataDir, HOOK_INSTALL_RESULT_FILE);
}

export function hookInstallSignalPath(dataDir: string): string {
  return path.join(dataDir, HOOK_INSTALL_SIGNAL_FILE);
}

export function exitCodeFor(agents: HookInstallAgentResult[]): number {
  return agents.every(agent => agent.status === 'ok' || agent.status === 'up-to-date' || agent.status === 'skipped')
    ? 0
    : 1;
}

/** Stdout JSON matches the result file except the file-only alarmSent field. */
export function toPublicReport(report: HookInstallReport): Omit<HookInstallReport, 'alarmSent'> {
  return {
    schema: report.schema,
    identity: report.identity,
    ts: report.ts,
    scope: report.scope,
    agents: report.agents,
  };
}

export interface HookInstallRunOptions {
  dataDir: string;
  pilotDir: string;
  builtinAgentsDir?: string;
  agentsFlag?: string;
  envAgents?: string;
  homes?: Record<string, string>;
  /** When true, write last-hook-install.json and touch the signal. Eager injection leaves this false. */
  writeResult: boolean;
  /** Restrict which deploy modes run. Eager injection keeps hook and plugin-inject only. */
  deployModes?: ReadonlySet<string>;
  enabled?: (agentId: string) => boolean;
  euid?: number;
  homeOwner?: (home: string) => Promise<number | null>;
  identity?: ContainerIdentity;
  mode?: 'install' | 'status';
}

export interface HookInstallRunResult {
  exitCode: number;
  report: HookInstallReport;
  warnings: string[];
  wroteResult: boolean;
}

function failed(id: string, reason: HookInstallReason, deployMode: string | null, settingsPath: string | null = null): HookInstallAgentResult {
  return {
    id,
    status: 'failed',
    reason,
    hint: hintForReason(reason, id),
    settingsPath,
    deployMode,
  };
}

function fromDeploy(def: AgentDefinition, result: DeployResult, settingsPath: string | null): HookInstallAgentResult {
  if (result.success && result.skipped && result.reason === 'up-to-date') {
    return { id: def.id, status: 'up-to-date', reason: null, hint: null, settingsPath, deployMode: def.deployMode };
  }
  if (result.success && result.skipped && result.reason === 'not-detected') {
    return failed(def.id, 'not-detected', def.deployMode, settingsPath);
  }
  if (result.success && result.skipped && result.reason === 'disabled') {
    return failed(def.id, 'disabled', def.deployMode, settingsPath);
  }
  if (result.success && !result.skipped) {
    return { id: def.id, status: 'ok', reason: null, hint: null, settingsPath, deployMode: def.deployMode };
  }
  return failed(def.id, reasonFromError(result.error), def.deployMode, settingsPath);
}

function reasonFromError(error: string | undefined): HookInstallReason {
  const text = error ?? '';
  if (text.includes('lock-timeout')) return 'lock-timeout';
  if (/activation/i.test(text) && /pending/i.test(text)) return 'activation-pending';
  if (/activation/i.test(text) && /fail/i.test(text)) return 'activation-failed';
  if (/ENOENT|settings directory/i.test(text)) return 'settings-dir-missing';
  if (/JSON|SyntaxError|invalid settings/i.test(text)) return 'invalid-settings';
  return 'deploy-failed';
}

async function jsonErrorLine(file: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    JSON.parse(raw);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${file}: ${message}`;
  }
}

async function defaultHomeOwner(home: string): Promise<number | null> {
  try {
    const info = await stat(home);
    return info.uid;
  } catch {
    return null;
  }
}

export async function runHookInstall(opts: HookInstallRunOptions): Promise<HookInstallRunResult> {
  const selection = selectAgents(opts.agentsFlag, opts.envAgents);
  const warnings: string[] = [];
  if (selection.kind !== 'skip' && selection.warnLiteralNull) {
    warnings.push('LOONGSUITE_PILOT_AGENTS or --agents is the literal "null"; detecting all agents.');
  }
  const identity = opts.identity ?? readContainerIdentity();
  const ts = new Date().toISOString();
  if (selection.kind === 'skip') {
    const report: HookInstallReport = {
      schema: 1,
      identity: identity.identity,
      ts,
      scope: 'detected',
      agents: [],
    };
    return { exitCode: 0, report, warnings, wroteResult: false };
  }

  try {
    await mkdir(opts.dataDir, { recursive: true });
  } catch (err) {
    logger.warn('data dir prepare failed', { error: String(err) });
    const report: HookInstallReport = {
      schema: 1,
      identity: identity.identity,
      ts,
      scope: selection.kind === 'named' ? 'named' : 'detected',
      agents: [failed('*', 'runtime-unprepared', null)],
    };
    return { exitCode: 1, report, warnings, wroteResult: false };
  }

  const manager = new DeploymentManager({
    dataDir: opts.dataDir,
    pilotDir: opts.pilotDir,
    builtinAgentsDir: opts.builtinAgentsDir,
    installedBy: opts.mode === 'status' ? undefined : 'hook-install',
  });
  const defs = await manager.loadDefinitions();
  const byId = new Map(defs.map(def => [def.id, def]));
  const homes = opts.homes ?? {};
  const enabled = opts.enabled ?? (() => true);
  const euid = opts.euid ?? (typeof process.geteuid === 'function' ? process.geteuid() : process.getuid?.() ?? 0);
  const homeOwner = opts.homeOwner ?? defaultHomeOwner;
  const statusOnly = opts.mode === 'status';

  const selected: AgentDefinition[] = [];
  const agents: HookInstallAgentResult[] = [];
  if (selection.kind === 'named') {
    for (const id of selection.ids) {
      const def = byId.get(id);
      if (!def) {
        agents.push(failed(id, 'unknown-id', null));
        continue;
      }
      if (opts.deployModes && !opts.deployModes.has(def.deployMode)) continue;
      selected.push(def);
    }
  } else {
    for (const def of defs) {
      if (opts.deployModes && !opts.deployModes.has(def.deployMode)) continue;
      selected.push(def);
    }
  }

  for (const def of selected) {
    if (!enabled(def.id)) {
      if (selection.kind === 'named') agents.push(failed(def.id, 'disabled', def.deployMode));
      continue;
    }
    const home = homes[def.id];
    const targeted = home ? definitionAtHookSettings(def, settingsPathForHome(def, home)) : def;
    const settingsPath = targeted.hook?.settingsPath ?? targeted.pluginInject?.configPaths?.[0] ?? null;
    if (home) {
      const owner = await homeOwner(home);
      if (euid === 0 && owner !== null && owner !== 0) {
        agents.push(failed(def.id, 'uid-mismatch', def.deployMode, settingsPath));
        continue;
      }
    }
    if (settingsPath) {
      const invalid = await jsonErrorLine(settingsPath);
      if (invalid) {
        const result = failed(def.id, 'invalid-settings', def.deployMode, settingsPath);
        result.hint = `${hintForReason('invalid-settings', def.id)} ${invalid}`;
        agents.push(result);
        continue;
      }
    }

    try {
      if (statusOnly) {
        const detected = home ? true : await manager.isAgentDetected(targeted);
        if (!detected) {
          if (selection.kind === 'named') agents.push(failed(def.id, 'not-detected', def.deployMode, settingsPath));
          continue;
        }
        const needs = await manager.needsRedeploy(targeted);
        agents.push(needs
          ? failed(def.id, 'overwritten', def.deployMode, settingsPath)
          : { id: def.id, status: 'ok', reason: null, hint: null, settingsPath, deployMode: def.deployMode });
        continue;
      }

      const result = home
        ? await manager.deployHookFile(targeted, settingsPathForHome(def, home), true)
        : await manager.deploySingle(targeted);
      if (selection.kind === 'detect' && result.skipped && result.reason === 'not-detected') continue;
      agents.push(fromDeploy(def, result, settingsPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agents.push(failed(def.id, reasonFromError(message), def.deployMode, settingsPath));
    }
  }

  let scope: 'detected' | 'named' = selection.kind === 'named' ? 'named' : 'detected';
  if (scope === 'detected' && opts.writeResult) {
    const existing = await readJsonFile<HookInstallReport>(hookInstallResultPath(opts.dataDir));
    if (existing?.scope === 'named' && existing.identity === identity.identity) scope = 'named';
  }

  const report: HookInstallReport = {
    schema: 1,
    identity: identity.identity,
    ts,
    scope,
    agents,
  };

  const hasFailure = agents.some(agent => agent.status === 'failed');
  if (hasFailure && !statusOnly) {
    report.alarmSent = await postAlarmBounded('pilot_alarm', {
      alarm_type: 'HOOK_INSTALL_ALARM',
      identity: report.identity,
      ts: report.ts,
      agents: report.agents.filter(agent => agent.status === 'failed').map(agent => agent.id).join(','),
    });
  } else {
    report.alarmSent = !hasFailure;
  }

  let wroteResult = false;
  if (opts.writeResult && !statusOnly) {
    await writeJsonFile(hookInstallResultPath(opts.dataDir), report);
    const signal = hookInstallSignalPath(opts.dataDir);
    const now = new Date();
    try {
      await utimes(signal, now, now);
    } catch {
      await writeFile(signal, `${now.toISOString()}\n`);
    }
    wroteResult = true;
  }

  return { exitCode: exitCodeFor(agents), report, warnings, wroteResult };
}

async function postAlarmBounded(topic: string, data: Record<string, unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      postAlarm(topic, data, 3000),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } catch (err) {
    logger.warn('postAlarm failed', { error: String(err) });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
