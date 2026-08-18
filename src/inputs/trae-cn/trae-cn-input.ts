import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

export interface TraeCNInputOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
}

/**
 * Reads canonical event_t JSONL records produced by assets/hooks/trae-cn-hook-processor.mjs.
 *
 * TRAE CN exposes hook events but does not expose token usage or model reasoning
 * in the official hook payload. The hook processor therefore emits explicit
 * `gen_ai.observability.missing.*` markers instead of fabricating values; local
 * dashboards can render those markers as red gaps.
 */
export class TraeCNInput extends BaseHookInput {
  readonly id = 'trae-cn-hook';
  readonly agentType = ClientType.TraeCN;
  private lastAgentVersion = '';

  constructor(opts: TraeCNInputOptions) {
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/trae-cn/history'),
      logPrefix: opts.logPrefix ?? 'trae-cn',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.trae-cn'))
      || directoryExists(resolveHome('~/Library/Application Support/Trae CN'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.trae-cn'),
      resolveHome('~/.loongsuite-pilot/logs/trae-cn/history'),
      resolveHome('~/Library/Application Support/Trae CN'),
    ];
  }

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const version = record['agent.trae.version'] ?? record.version;
    if (typeof version === 'string' && version) this.lastAgentVersion = version;
    return transformHookRecord(record, ClientType.TraeCN, 'trae');
  }
}
