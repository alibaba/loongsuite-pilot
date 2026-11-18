import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, type AgentActivityEntry } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import { transformHookRecord } from '../base/hook-record-transform.js';
import { readBoundedLineTail } from '../base/bounded-line-tail.js';
import { fileIdentity, matchesFileIdentity } from '../../utils/file-identity.js';

// Keep a backlog in one process from monopolizing every poll or allocating
// the entire unread tail. Rotate across files, including older active writers.
const MAX_FILES_PER_POLL = 4;

export interface QwenPawLogInputOptions extends Omit<SessionInputOptions, 'filePattern'> {}

/** Each QwenPaw process writes its own canonical JSONL; offsets survive restarts. */
export class QwenPawLogInput extends BaseSessionInput {
  readonly id = 'qwenpaw-log';
  readonly agentType = ClientType.QwenPaw;
  private nextFileIndex = 0;

  constructor(options: QwenPawLogInputOptions) {
    super({ ...options, filePattern: 'qwenpaw-*.jsonl' });
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    if (!files.length) return [];
    const start = this.nextFileIndex % files.length;
    const count = Math.min(files.length, MAX_FILES_PER_POLL);
    this.nextFileIndex = (start + count) % files.length;
    const entries: AgentActivityEntry[] = [];
    for (let i = 0; i < count; i++) {
      const file = files[(start + i) % files.length];
      const stateKey = `${this.id}:${file}`;
      const prior = this.stateStore.get(stateKey);
      let stat;
      try { stat = await fs.stat(file); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') await this.diagnoseUnreadablePath(file, 'event file');
        else if (code !== 'ENOENT') this.logger.warn('failed to stat QwenPaw event log', { file, code });
        continue;
      }
      if (!stat.isFile()) continue;
      const identityChanged = (prior.extra?.sourceIdentity !== undefined &&
        !matchesFileIdentity(prior.extra.sourceIdentity, stat)) ||
        (prior.extra?.sourceIdentity === undefined && prior.extra?.inode !== undefined && prior.extra.inode !== stat.ino);
      const previousOffset = this.stateStore.getOffset(stateKey);
      const reset = identityChanged || stat.size < previousOffset;
      const offset = reset ? 0 : previousOffset;
      const skipping = !reset && prior.extra?.skippingLine === true;
      if (stat.size <= offset && !reset) continue;
      try {
        const tail = await readBoundedLineTail(file, stat, offset, skipping, this.getInputRuntimeAccumulator());
        if (!tail) continue;
        if (tail.beganSkip) this.logger.warn('QwenPaw event exceeds the bounded line size; skipping it', { file });
        for (const line of tail.text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record: unknown = JSON.parse(line);
            if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
            const entry = await this.processSessionLine(record as Record<string, unknown>);
            if (entry) entries.push(entry);
          } catch (error) {
            this.logger.warn('invalid QwenPaw event line', { file, error: String(error) });
          }
        }
        if (tail.offset !== previousOffset) this.stateStore.setOffset(stateKey, tail.offset);
        const identity = fileIdentity(stat);
        if (prior.extra?.inode !== stat.ino || prior.extra?.sourceIdentity !== identity
          || prior.extra?.sourceBirthtimeMs !== stat.birthtimeMs || prior.extra?.skippingLine !== tail.skippingLine) {
          this.stateStore.update(stateKey, { extra: {
            inode: stat.ino, sourceIdentity: identity, sourceBirthtimeMs: stat.birthtimeMs,
            skippingLine: tail.skippingLine,
          } });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') await this.diagnoseUnreadablePath(file, 'event file');
        else this.logger.warn('failed to read QwenPaw event log', { file, code });
      }
    }
    return entries;
  }

  protected override async onStop(): Promise<void> {
    // One bounded final poll after the serialized cycle; any larger backlog is
    // resumed from its checkpoint on the next start.
    try {
      const entries = await this.collect();
      if (entries.length > 0) this.emit('entries', entries);
      await this.waitForPendingOutputs();
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
