import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition, DeployResult } from '../types/deployment.js';
import { readContainerIdentity, type ContainerIdentity } from '../utils/container-identity.js';
import { readJsonFile, resolveHome, writeJsonFile } from '../utils/fs-utils.js';
import { readJsonDocument, type JsonSyntax } from '../utils/json-document.js';
import { withDeployedStateLock } from './deployed-state-merge.js';
import { createLogger } from '../utils/logger.js';
import { DeploymentManager } from './deployment-manager.js';
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

/** Path of a declared file relative to a detection home, or null when it sits outside. */
export function relativeToDetectionHome(declaredPath: string, detectionPaths: string[]): string | null {
  const declared = path.resolve(resolveHome(declaredPath));
  for (const detectionPath of detectionPaths) {
    if (!detectionPath.trim()) continue;
    const root = path.resolve(resolveHome(detectionPath));
    const rel = path.relative(root, declared);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return rel;
  }
  return null;
}

/**
 * Rewrite the file this install writes so it stays under `home` with the same
 * relative path the definition uses under its detection home. Returns null when
 * that relative path cannot be derived; callers must fail instead of writing
 * the default location.
 */
export function definitionAtInstallHome(def: AgentDefinition, home: string): AgentDefinition | null {
  const root = path.resolve(home);
  if (def.hook?.settingsPath) {
    const rel = relativeToDetectionHome(def.hook.settingsPath, def.detection.paths);
    if (!rel) return null;
    return {
      ...def,
      detection: { ...def.detection, paths: [root, ...def.detection.paths] },
      hook: { ...def.hook, settingsPath: path.join(root, rel) },
    };
  }
  if (def.pluginInject?.configPaths?.length) {
    const rewritten: string[] = [];
    for (const configPath of def.pluginInject.configPaths) {
      const rel = relativeToDetectionHome(configPath, def.detection.paths);
      if (!rel) return null;
      rewritten.push(path.join(root, rel));
    }
    return {
      ...def,
      detection: { ...def.detection, paths: [root, ...def.detection.paths] },
      pluginInject: { ...def.pluginInject, configPaths: rewritten },
    };
  }
  return null;
}

export function hookInstallResultPath(dataDir: string): string {
  return path.join(dataDir, HOOK_INSTALL_RESULT_FILE);
}

export function hookInstallSignalPath(dataDir: string): string {
  return path.join(dataDir, HOOK_INSTALL_SIGNAL_FILE);
}

/**
 * Keep earlier named successes that this run did not replace with a new success.
 * A failed extra home for the same id must not drop the id: that would make the
 * daemon uninstall every settings file already written for it.
 */
export function mergeInstalledAgents(
  existing: HookInstallAgentResult[] | undefined,
  current: HookInstallAgentResult[],
): HookInstallAgentResult[] {
  const currentById = new Map(current.map(agent => [agent.id, agent]));
  const merged: HookInstallAgentResult[] = [];
  const seen = new Set<string>();
  for (const previous of existing ?? []) {
    if (previous.status !== 'ok' && previous.status !== 'up-to-date') continue;
    const now = currentById.get(previous.id);
    seen.add(previous.id);
    if (now && (now.status === 'ok' || now.status === 'up-to-date')) merged.push(now);
    else if (now && now.status === 'failed') {
      merged.push(previous);
      merged.push(now);
    } else merged.push(previous);
  }
  for (const now of current) {
    if (!seen.has(now.id)) merged.push(now);
  }
  return merged;
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
  return failed(def.id, classifyDeployError(result.error), def.deployMode, settingsPath);
}

export function classifyDeployError(error: unknown): HookInstallReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (code === 'lock-timeout' || text.includes('lock-timeout')) return 'lock-timeout';
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC') return 'deploy-failed';
  if (code === 'ENOENT' || /\bENOENT\b/.test(text) || text.includes('settings directory')) return 'settings-dir-missing';
  if (/\bactivation\b/i.test(text) && /\bpending\b/i.test(text)) return 'activation-pending';
  if (/\bactivation\b/i.test(text) && /\bfail/i.test(text)) return 'activation-failed';
  if (error instanceof SyntaxError || text.includes('SyntaxError') || /\binvalid JSONC?\b/i.test(text) || text.includes('invalid settings')) {
    return 'invalid-settings';
  }
  return 'deploy-failed';
}

function settingsSyntax(def: AgentDefinition, file: string | null): JsonSyntax {
  if (def.hook?.settingsSyntax) return def.hook.settingsSyntax;
  if (file?.endsWith('.jsonc')) return 'jsonc';
  return 'json';
}

/** Missing and empty files are installable. JSONC comments and a leading BOM are too. */
async function settingsDocumentError(file: string, syntax: JsonSyntax): Promise<string | null> {
  const document = await readJsonDocument(file, syntax);
  if (document.status === 'missing' || document.status === 'empty' || document.status === 'ok') return null;
  return `${file}: ${document.error.message}`;
}

export async function markHookInstallAlarmSent(file: string, expectedTs: string): Promise<'marked' | 'already' | 'stale'> {
  return withDeployedStateLock(`${file}.lock`, async () => {
    const current = await readJsonFile<HookInstallReport>(file);
    if (!current || current.ts !== expectedTs) return 'stale';
    if (current.alarmSent === true) return 'already';
    current.alarmSent = true;
    await writeJsonFile(file, current);
    return 'marked';
  });
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
      scope: 'detected',
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
    const targeted = home ? definitionAtInstallHome(def, home) : def;
    if (home && !targeted) {
      const unsupported = failed(def.id, 'deploy-failed', def.deployMode);
      unsupported.hint = `--home cannot be applied to ${def.id}. The definition has no settings path under its detection home.`;
      agents.push(unsupported);
      continue;
    }
    const active = targeted ?? def;
    const settingsPath = active.hook?.settingsPath ?? active.pluginInject?.configPaths?.[0] ?? null;
    if (home) {
      const owner = await homeOwner(home);
      if (euid === 0 && owner !== null && owner !== 0) {
        agents.push(failed(def.id, 'uid-mismatch', active.deployMode, settingsPath));
        continue;
      }
    }
    if (settingsPath) {
      const invalid = await settingsDocumentError(settingsPath, settingsSyntax(active, settingsPath));
      if (invalid) {
        const result = failed(def.id, 'invalid-settings', active.deployMode, settingsPath);
        result.hint = `${hintForReason('invalid-settings', def.id)} ${invalid}`;
        agents.push(result);
        continue;
      }
    }

    try {
      if (statusOnly) {
        const detected = home ? true : await manager.isAgentDetected(active);
        if (!detected) {
          if (selection.kind === 'named') agents.push(failed(def.id, 'not-detected', active.deployMode, settingsPath));
          continue;
        }
        const needs = await manager.needsRedeploy(
          active,
          home && settingsPath ? { settingsPath } : undefined,
        );
        if (!needs) {
          agents.push({ id: def.id, status: 'ok', reason: null, hint: null, settingsPath, deployMode: active.deployMode });
          continue;
        }
        const known = def.id === 'grok-build' && settingsPath
          ? manager.recordedSettingsPaths(def.id).includes(path.resolve(settingsPath))
          : manager.hasRecord(def.id);
        agents.push(failed(def.id, known ? 'overwritten' : 'not-detected', active.deployMode, settingsPath));
        continue;
      }

      const result = home
        ? await manager.deployPrepared(active, true)
        : await manager.deploySingle(active);
      if (selection.kind === 'detect' && result.skipped && result.reason === 'not-detected') continue;
      agents.push(fromDeploy(def, result, settingsPath));
    } catch (err) {
      agents.push(failed(def.id, classifyDeployError(err), active.deployMode, settingsPath));
    }
  }

  const hasFailure = agents.some(agent => agent.status === 'failed');
  let alarmSent = !hasFailure;
  if (hasFailure && !statusOnly) {
    alarmSent = await postAlarmBounded('pilot_alarm', {
      alarm_type: 'HOOK_INSTALL_ALARM',
      identity: identity.identity,
      ts,
      agents: agents.filter(agent => agent.status === 'failed').map(agent => agent.id).join(','),
    });
  }

  let scope: 'detected' | 'named' = selection.kind === 'named'
    && agents.some(agent => agent.status === 'ok' || agent.status === 'up-to-date')
    ? 'named'
    : 'detected';
  let wroteResult = false;
  if (opts.writeResult && !statusOnly) {
    const file = hookInstallResultPath(opts.dataDir);
    // Same lock as markHookInstallAlarmSent. The mark re-reads under this lock
    // and writes alarmSent only when ts is unchanged, so it cannot put an older
    // report back over the one this call publishes.
    const persisted = await withDeployedStateLock(`${file}.lock`, async () => {
      const latest = await readJsonFile<HookInstallReport>(file);
      const sameNamedContainer = latest?.scope === 'named' && latest.identity === identity.identity;
      const merged = sameNamedContainer ? mergeInstalledAgents(latest?.agents, agents) : agents;
      const installed = merged.some(agent => agent.status === 'ok' || agent.status === 'up-to-date');
      const nextScope: 'detected' | 'named' = installed && (selection.kind === 'named' || sameNamedContainer)
        ? 'named'
        : 'detected';
      const next: HookInstallReport = {
        schema: 1,
        identity: identity.identity,
        ts,
        scope: nextScope,
        agents: merged,
        alarmSent,
      };
      await writeJsonFile(file, next);
      return next;
    });
    scope = persisted.scope;
    const signal = hookInstallSignalPath(opts.dataDir);
    const now = new Date();
    try {
      await utimes(signal, now, now);
    } catch {
      await writeFile(signal, `${now.toISOString()}\n`);
    }
    wroteResult = true;
  }

  return {
    exitCode: exitCodeFor(agents),
    report: { schema: 1, identity: identity.identity, ts, scope, agents },
    warnings,
    wroteResult,
  };
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
