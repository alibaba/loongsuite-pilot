import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../types/index.js';

const PAYLOAD = Symbol('qwenpaw-payload');
const CONTENT_KEYS = new Set([
  'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions',
  'gen_ai.tool.definitions', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
]);
interface Reference { file: FileHandle; offset: number; length: number }
type StoredEntry = AgentActivityEntry & { [PAYLOAD]?: Reference };
interface TurnFile { file: FileHandle; filename: string; offset: number }

/** Transient payload spill, not a delivery journal. Source JSONL remains authoritative. */
export class QwenPawPayloadStore {
  private directory?: Promise<string>;
  private files = new Map<string, Promise<TurnFile>>();
  private operations = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir?: string) {}

  async prepare(key: string, entry: AgentActivityEntry): Promise<AgentActivityEntry> {
    const payload: Record<string, unknown> = {};
    const metadata: StoredEntry = { ...entry };
    for (const [name, value] of Object.entries(entry)) {
      if (value !== undefined && (CONTENT_KEYS.has(name) || (typeof value === 'string' && value.length > 16 * 1024))) {
        payload[name] = value;
        // Preserve the key for passthrough discovery, without retaining its body.
        metadata[name] = undefined;
      }
    }
    if (!Object.keys(payload).length) return entry;
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.file(key);
      const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
      const offset = state.offset;
      let written = 0;
      while (written < bytes.length) {
        const result = await state.file.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('QwenPaw payload write made no progress');
        written += result.bytesWritten;
      }
      state.offset += bytes.length;
      metadata[PAYLOAD] = { file: state.file, offset, length: bytes.length };
      return metadata;
    });
    this.operations.set(key, operation.catch(() => undefined));
    return operation;
  }

  async restore(entry: AgentActivityEntry): Promise<AgentActivityEntry> {
    const reference = (entry as StoredEntry)[PAYLOAD];
    if (!reference) return entry;
    const bytes = Buffer.allocUnsafe(reference.length);
    let read = 0;
    while (read < bytes.length) {
      const result = await reference.file.read(bytes, read, bytes.length - read, reference.offset + read);
      if (!result.bytesRead) throw new Error('QwenPaw payload was truncated');
      read += result.bytesRead;
    }
    return { ...entry, ...JSON.parse(bytes.toString('utf8')) };
  }

  async release(key: string): Promise<void> {
    await this.operations.get(key);
    const pending = this.files.get(key);
    this.files.delete(key);
    this.operations.delete(key);
    if (!pending) return;
    const state = await pending;
    await state.file.close();
    await rm(state.filename, { force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.files.keys()].map(key => this.release(key)));
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
  }

  private async file(key: string): Promise<TurnFile> {
    let pending = this.files.get(key);
    if (!pending) {
      pending = (async () => {
        if (!this.directory) {
          const directory = (async () => {
            const root = this.dataDir ? path.join(this.dataDir, 'logs') : os.tmpdir();
            await mkdir(root, { recursive: true });
            return mkdtemp(path.join(root, 'qwenpaw-payload-'));
          })();
          this.directory = directory;
          void directory.catch(() => { if (this.directory === directory) this.directory = undefined; });
        }
        const filename = path.join(await this.directory, createHash('sha256').update(key).digest('hex'));
        const file = await open(filename, 'wx+', 0o600);
        // Linux keeps the open descriptor readable after unlink and reclaims
        // its blocks even on SIGKILL. This is intentionally not crash replay.
        if (process.platform !== 'win32') {
          try { await rm(filename); } catch (error) { await file.close(); throw error; }
        }
        return { file, filename, offset: 0 };
      })();
      this.files.set(key, pending);
      void pending.catch(() => { if (this.files.get(key) === pending) this.files.delete(key); });
    }
    return pending;
  }
}
