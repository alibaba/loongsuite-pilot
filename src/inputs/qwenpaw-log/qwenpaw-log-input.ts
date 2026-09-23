import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, type AgentActivityEntry } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

export interface QwenPawLogInputOptions extends Omit<SessionInputOptions, 'filePattern'> {}

/** Each QwenPaw process writes its own canonical JSONL; offsets survive restarts. */
export class QwenPawLogInput extends BaseSessionInput {
  readonly id = 'qwenpaw-log';
  readonly agentType = ClientType.QwenPaw;

  constructor(options: QwenPawLogInputOptions) {
    super({ ...options, filePattern: 'qwenpaw-*.jsonl' });
  }

  protected override async onStop(): Promise<void> {
    // BaseInput has stopped polling and awaited its serialized cycle before
    // calling this hook. Read native shutdown's final records only now, then
    // let InputManager drain the emitted batch before the flusher shuts down.
    try {
      const entries = await this.collect();
      if (entries.length > 0) this.emit('entries', entries);
      await this.stateStore.save();
    } catch (error) {
      this.logger.error('final QwenPaw collection failed', { error: String(error) });
      this.emit('collect-error', error);
    }
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isFile() && /^qwenpaw-.+\.jsonl$/.test(entry.name))
        .map(entry => path.join(this.sessionDir, entry.name))
        .sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        await this.diagnoseUnreadablePath(this.sessionDir, 'session directory');
      } else if (code !== 'ENOENT') {
        this.logger.warn('failed to discover QwenPaw event logs', { code });
      }
      return [];
    }
  }

  protected async processSessionLine(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    if (record['gen_ai.agent.type'] !== ClientType.QwenPaw) return null;
    return transformHookRecord(record, ClientType.QwenPaw, 'qwenpaw');
  }
}
