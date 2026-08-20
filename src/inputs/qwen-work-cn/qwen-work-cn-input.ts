import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';

export interface QwenWorkCNInputOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
}

/** Reads canonical records produced by the dedicated QwenWorkCN Stop hook. */
export class QwenWorkCNInput extends BaseHookInput {
  readonly id = 'qwen-work-cn-hook';
  readonly agentType = ClientType.QwenWorkCN;
  private lastAgentVersion = '';

  constructor(opts: QwenWorkCNInputOptions) {
    super({
      stateStore: opts.stateStore,
      logDir: opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qwen-work-cn/history'),
      logPrefix: opts.logPrefix ?? 'qwen-work-cn',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qwenworkcn'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.qwenworkcn')];
  }

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    if (typeof record['event.name'] !== 'string') return null;
    if (typeof record['event.id'] !== 'string') return null;
    if (typeof record.time_unix_nano !== 'string') return null;

    const version = record.version;
    if (typeof version === 'string' && version) this.lastAgentVersion = version;

    const entry = {
      ...record,
      'gen_ai.agent.type': ClientType.QwenWorkCN,
    } as AgentActivityEntry;
    await enrichCanonicalEntryWithGit(
      entry as Record<string, unknown>,
      record,
      'qwen-work-cn',
    );
    return entry;
  }
}
