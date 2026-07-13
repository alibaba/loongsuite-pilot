import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

export class KiroCliLogInput extends BaseHookInput {
  readonly id = 'kiro-cli-log';
  readonly agentType = ClientType.KiroCli;

  // Kiro's hook JSONL is written by the daemon's own delayedCollect subprocess,
  // so no daemon ⇒ no records. A cold start (state wiped) therefore always
  // means "restart with stale already-dispatched data" — safe to keep only the
  // last turn and skip the replay.
  protected coldStartKeepLastTurnOnly = true;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/kiro-cli'),
      logPrefix: opts?.logPrefix ?? 'kiro-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/kiro-cli'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/kiro-cli')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.KiroCli, 'kiro-cli');
  }
}
