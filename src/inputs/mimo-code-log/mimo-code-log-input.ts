import { INVOCATION_MESSAGE_ID_FIELD } from "../../../assets/hooks/shared/invocation-attributes.mjs";
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';

export class MimoCodeLogInput extends BaseHookInput {
  readonly id = 'mimo-code-log';
  readonly agentType = ClientType.MimoCode;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/mimo-code'),
      logPrefix: opts?.logPrefix ?? 'mimo-code',
      pollIntervalMs: opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/mimo-code'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/mimo-code')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const { 'pilot.invocation.native_message_id': messageId, ...body } = record;
    const entry = await transformHookRecord(body, ClientType.MimoCode, 'mimo-code');
    if (entry && typeof messageId === 'string') Object.assign(entry, { [INVOCATION_MESSAGE_ID_FIELD]: messageId });
    return entry;
  }
}
