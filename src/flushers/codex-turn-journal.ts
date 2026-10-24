import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../types/index.js';

const MAX_ACKNOWLEDGED_TURNS = 10_000;

export function codexTurnJournalGroupKey(entry: AgentActivityEntry): string {
  return createHash('sha256').update(JSON.stringify([
    entry['user.id'], entry['gen_ai.session.id'], entry['gen_ai.turn.id'],
  ])).digest('hex');
}

function validEntry(value: unknown): value is AgentActivityEntry {
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

  constructor(private readonly dir: string) {}

  append(entries: AgentActivityEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = await this.loadAcknowledgements();
      const groups = new Map<string, AgentActivityEntry[]>();
      for (const entry of entries.filter(validEntry)) {
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
          const prior = await fs.readFile(file).catch(error => {
            if (error.code === 'ENOENT') return Buffer.alloc(0);
            throw error;
          });
          if (prior.length && prior[prior.length - 1] !== 10) await fs.truncate(file, prior.lastIndexOf(10) + 1);
          this.initialized.add(key);
        }
        await fs.appendFile(file, group.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
        await fs.chmod(file, 0o600);
      }
    });
  }

  async *load(key?: string): AsyncGenerator<AgentActivityEntry[]> {
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
      const text = await fs.readFile(path.join(this.dir, file.name), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; // An ACK may remove a listed residual while replay advances.
        throw error;
      });
      const unique = new Map<string, AgentActivityEntry>();
      for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
        try {
          const entry: unknown = JSON.parse(line);
          if (validEntry(entry) && codexTurnJournalGroupKey(entry) === match[1]
            && !unique.has(entry['event.id'])) unique.set(entry['event.id'], entry);
        } catch { /* Ignore corrupt lines while preserving complete independent records. */ }
      }
      if (unique.size) yield [...unique.values()];
    }
  }

  async isAcknowledged(entry: AgentActivityEntry): Promise<boolean> {
    await this.pending;
    return validEntry(entry) && (await this.loadAcknowledgements()).has(codexTurnJournalGroupKey(entry));
  }

  acknowledge(entries: AgentActivityEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = await this.loadAcknowledgements();
      const keys = [...new Set(entries.filter(validEntry).map(codexTurnJournalGroupKey))];
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
        : [...new Set(entriesOrKey.filter(validEntry).map(codexTurnJournalGroupKey))];
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
    const excess = acknowledged.size - MAX_ACKNOWLEDGED_TURNS;
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
