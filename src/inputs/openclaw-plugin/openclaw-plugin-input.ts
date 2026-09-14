import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

const DEFAULT_PILOT_DATA_DIR = '~/.loongsuite-pilot';
const SESSION_LIFECYCLE_HOOKS = new Set(['session_start', 'session_end']);

export type OpenClawPluginInputOptions =
  Omit<Partial<HookInputOptions>, 'stateStore'>
  & Pick<HookInputOptions, 'stateStore'>
  & { dataDir?: string };

export function resolveOpenClawPluginLogDir(dataDir?: string): string {
  const resolvedDataDir = resolveHome(
    dataDir || process.env.LOONGSUITE_PILOT_DATA_DIR || DEFAULT_PILOT_DATA_DIR,
  );
  return path.join(resolvedDataDir, 'logs', 'openclaw');
}

export async function ensureOpenClawPluginLogDir(logDir: string): Promise<void> {
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(logDir, 0o700);
}

/**
 * Tails the private JSONL event stream written by the injected OpenClaw plugin
 * and transforms each canonical hook record for the shared Pilot pipeline.
 */
export class OpenClawPluginInput extends BaseHookInput {
  readonly id = 'openclaw-plugin-log';
  readonly agentType = ClientType.OpenClaw;

  constructor(opts: OpenClawPluginInputOptions) {
    if (!opts?.stateStore) {
      throw new TypeError('OpenClawPluginInput requires a stateStore');
    }
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveOpenClawPluginLogDir(opts.dataDir),
      logPrefix: opts?.logPrefix ?? 'openclaw',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(dataDir?: string): Promise<boolean> {
    return directoryExists(resolveOpenClawPluginLogDir(dataDir));
  }

  static getWatchPaths(dataDir?: string): string[] {
    return [resolveOpenClawPluginLogDir(dataDir)];
  }

  protected override async onStart(): Promise<void> {
    await ensureOpenClawPluginLogDir(this.logDir);
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const hook = record['agent.openclaw.hook'];

    // Session lifecycle hooks are collector control-plane signals, not turns.
    // Forwarding them creates trace groups with only ENTRY and AGENT spans.
    if (typeof hook === 'string' && SESSION_LIFECYCLE_HOOKS.has(hook)) {
      return null;
    }

    let canonicalRecord = record;
    if (hook === 'before_model_resolve') {
      // before_agent_run contains the same prompt plus richer turn context and
      // is the single canonical source for ENTRY/AGENT input messages.
      canonicalRecord = { ...record };
      delete canonicalRecord['gen_ai.input.messages'];
      delete canonicalRecord['gen_ai.input.messages_delta'];
      delete canonicalRecord['input.messages'];
      delete canonicalRecord['input.messages_delta'];
    }

    return transformHookRecord(canonicalRecord, ClientType.OpenClaw, 'openclaw');
  }
}
