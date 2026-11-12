import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../types/index.js';

const MAX_ACKNOWLEDGED_TURNS = 10_000;

export function codexTurnJournalGroupKey(entry: AgentActivityEntry): string {
  return createHash('sha256').update(JSON.stringify([
    entry['user.id'], entry['gen_ai.session.id'], entry['gen_ai.turn.id'],
  ])).digest('hex');
}

export function isJournaledCodexEntry(value: unknown): value is AgentActivityEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as AgentActivityEntry;
  return entry['gen_ai.agent.type'] === 'codex' && typeof entry['user.id'] === 'string'
    && ['gen_ai.session.id', 'gen_ai.turn.id', 'event.id'].every(
      key => typeof entry[key] === 'string' && entry[key]!.length > 0,
    );
}

/** Pending Codex turns and bounded export acknowledgements across collector restarts. */
export class CodexTurnJournal {
  private pending: Promise<void> = Promise.resolve();
  private readonly initialized = new Set<string>();
  private acknowledgements?: Promise<Map<string, number>>;

  /** Production keeps 10,000 ACKs; a smaller bound exercises the same eviction policy in tests. */
  constructor(
    private readonly dir: string,
    private readonly acknowledgementLimit = MAX_ACKNOWLEDGED_TURNS,
  ) {
    if (!Number.isSafeInteger(acknowledgementLimit) || acknowledgementLimit < 1) {
      throw new RangeError('acknowledgementLimit must be a positive safe integer');
    }
  }

  append(entries: AgentActivityEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = await this.loadAcknowledgements();
      const groups = new Map<string, AgentActivityEntry[]>();
      for (const entry of entries.filter(isJournaledCodexEntry)) {
        const key = codexTurnJournalGroupKey(entry);
        if (acknowledged.has(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(entry);
      }
      if (!groups.size) return;
      await this.ensureDir();
      for (const [key, group] of groups) {
        const file = this.file(key);
        if (!this.initialized.has(key)) {
          // A crash may leave an incomplete final write; do not join a new JSON line to it.
          const length = await completeLength(file);
          if (length !== undefined) await fs.truncate(file, length);
          this.initialized.add(key);
        }
        await fs.appendFile(file, group.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
        await fs.chmod(file, 0o600);
      }
    });
  }

  /** Compatibility reader for callers that need a complete turn (conversion). */
  async *load(key?: string): AsyncGenerator<AgentActivityEntry[]> {
    let group: AgentActivityEntry[] = [];
    for await (const batch of this.loadBatches(key)) {
      group.push(...batch.entries);
      if (batch.last) {
        if (group.length) yield group;
        group = [];
      }
    }
  }

  /** Stream a retained turn without materializing its JSON text or all events. */
  async *loadBatches(key?: string): AsyncGenerator<{ key: string; entries: AgentActivityEntry[]; last: boolean }> {
    await this.pending;
    const acknowledged = await this.loadAcknowledgements();
    if (key !== undefined && !/^[a-f0-9]{64}$/.test(key)) return;
    const files = key ? await fs.lstat(this.file(key)).then(stat => [{
      name: path.basename(this.file(key)), isFile: () => stat.isFile(),
    }]).catch(error => { if (error.code === 'ENOENT') return []; throw error; })
      : await fs.readdir(this.dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const match = /^codex-turn-([a-f0-9]{64})\.jsonl$/.exec(file.name);
      if (!file.isFile() || !match || acknowledged.has(match[1])) continue;
      const filename = path.join(this.dir, file.name);
      const length = await completeLength(filename);
      if (!length) continue;
      const stream = createReadStream(filename, { end: length - 1, encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const seen = new Set<string>();
      let batch: AgentActivityEntry[] = [];
      let bytes = 0;
      try {
        for await (const line of lines) {
          let entry: unknown;
          try { entry = JSON.parse(line); } catch { continue; }
          if (!isJournaledCodexEntry(entry) || codexTurnJournalGroupKey(entry) !== match[1]
            || seen.has(entry['event.id'])) continue;
          seen.add(entry['event.id']);
          const size = Buffer.byteLength(line);
          if (batch.length && bytes + size > 1024 * 1024) {
            yield { key: match[1], entries: batch, last: false };
            batch = []; bytes = 0;
          }
          batch.push(entry); bytes += size;
        }
        yield { key: match[1], entries: batch, last: true };
      } finally { lines.close(); stream.destroy(); }
    }
  }

  async isAcknowledged(entry: AgentActivityEntry): Promise<boolean> {
    await this.pending;
    return isJournaledCodexEntry(entry) && (await this.loadAcknowledgements()).has(codexTurnJournalGroupKey(entry));
  }

  acknowledge(entries: AgentActivityEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = await this.loadAcknowledgements();
      const keys = [...new Set(entries.filter(isJournaledCodexEntry).map(codexTurnJournalGroupKey))];
      if (!keys.length) return;
      await this.ensureDir();
      for (const key of keys) {
        if (!acknowledged.has(key)) {
          const temporary = path.join(this.dir, `.codex-done-${randomUUID()}.tmp`);
          await fs.writeFile(temporary, JSON.stringify({ version: 1, key }), { mode: 0o600 });
          await fs.rename(temporary, this.doneFile(key));
          acknowledged.set(key, Date.now());
        }
        // The durable acknowledgement must exist before deleting pending content.
        await fs.unlink(this.file(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.initialized.delete(key);
      }
      await this.trimAcknowledgements(acknowledged);
    });
  }

  remove(entriesOrKey: AgentActivityEntry[] | string): Promise<void> {
    return this.enqueue(async () => {
      const keys = typeof entriesOrKey === 'string' ? [entriesOrKey]
        : [...new Set(entriesOrKey.filter(isJournaledCodexEntry).map(codexTurnJournalGroupKey))];
      for (const key of keys) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue;
        await fs.unlink(this.file(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.initialized.delete(key);
      }
    });
  }

  private file(key: string): string { return path.join(this.dir, `codex-turn-${key}.jsonl`); }
  private doneFile(key: string): string { return path.join(this.dir, `codex-done-${key}.json`); }
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
  }

  private loadAcknowledgements(): Promise<Map<string, number>> {
    return this.acknowledgements ??= (async () => {
      const acknowledged = new Map<string, number>();
      const files = await fs.readdir(this.dir, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files) {
        const match = /^codex-done-([a-f0-9]{64})\.json$/.exec(file.name);
        if (!file.isFile() || !match) continue;
        const fullPath = path.join(this.dir, file.name);
        const raw = await fs.readFile(fullPath, 'utf8');
        let metadata;
        try { metadata = JSON.parse(raw); } catch { continue; }
        if (metadata?.version === 1 && metadata.key === match[1]) {
          acknowledged.set(match[1], (await fs.stat(fullPath)).mtimeMs);
        }
      }
      await this.trimAcknowledgements(acknowledged);
      return acknowledged;
    })();
  }

  private async trimAcknowledgements(acknowledged: Map<string, number>): Promise<void> {
    const excess = acknowledged.size - this.acknowledgementLimit;
    if (excess <= 0) return;
    for (const [key] of [...acknowledged].sort((a, b) => a[1] - b[1]).slice(0, excess)) {
      // A crash may leave pending content behind the ACK; remove it before forgetting the ACK.
      await fs.unlink(this.file(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.initialized.delete(key);
      await fs.unlink(this.doneFile(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      acknowledged.delete(key);
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
}

/** Locate the last committed newline using bounded reads, including crash repair. */
async function completeLength(file: string): Promise<number | undefined> {
  const handle = await fs.open(file, 'r').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    let end = (await handle.stat()).size;
    const chunk = Buffer.alloc(64 * 1024);
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally { await handle.close(); }
}
