import * as fs from 'node:fs/promises';
import path from 'node:path';
import { deserialize } from 'node:v8';
import { DoubaoWorkBudget, DoubaoWorkDeferred } from './doubao-work-budget.js';
import { chatCrc32c, chatTableEntries, readVarint as varint, unmaskChatCrc } from './doubao-chat-table.js';

const BLOCK_BYTES = 32 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_TASKS = 128;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const BLINK_ENVELOPE = Buffer.from('ff15fe000000000000000000000000ff0f', 'hex');
const ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

interface Source {
  identity: string;
  offset: number;
  fragment: Buffer[];
  fragmentBytes: number;
  stores: Map<string, ChatStoreSnapshot>;
  touchedMs: number;
  anchor?: Buffer;
  anchorOffset?: number;
  tableChunks?: Buffer[];
  tableEntries?: Generator<{ key: Buffer; value: Buffer; sequence: bigint }>;
  tableBytes?: number;
  tableStores?: Map<string, ChatStoreSnapshot>;
  readError?: unknown;
  recoveredRequests?: Set<string>;
}

interface ChatStoreSnapshot {
  key: string;
  sequence: bigint;
  tasks: Map<string, { sequence: bigint; value?: DoubaoChatContent }>;
}

export interface DoubaoChatContent {
  sessionId: string;
  localMessageId: string;
  sendMessageId: string;
  receiveMessageId: string;
  conversationId: string;
  queryMs: number;
  input: string;
  output: string;
  finished: boolean;
  finishMs?: number;
  finishReason?: string;
  modelId?: string;
}

/** Read only Chromium write-ahead logs and immutable tables. New messages rewrite the
 * client's task store there, including their exact request/session identities.
 * The database remains owned and locked by the client. Raw state never enters
 * Pilot checkpoints, and completed requests keep the existing log cursor.
 */
export class DoubaoChatReader {
  private readonly files = new Map<string, Source>();
  private bodyReadBytes = 0;

  constructor(private readonly userDataRoot: string, private readonly maxCacheBytes = MAX_CACHE_BYTES) {}

  clear(): void { this.files.clear(); }

  stats(): { files: number; bodyReadBytes: number; retainedBytes: number } {
    return { files: this.files.size, bodyReadBytes: this.bodyReadBytes,
      retainedBytes: [...this.files.values()].reduce((sum, source) => sum + source.fragmentBytes
        + (source.tableChunks?.reduce((bytes, chunk) => bytes + chunk.length, 0) ?? 0)
        + (source.tableBytes ?? 0)
        + storeBytes(source.tableStores)
        + storeBytes(source.stores), 0) };
  }

  async find(sessionId: string, budget: DoubaoWorkBudget): Promise<DoubaoChatContent | undefined> {
    if (!ID.test(sessionId)) return undefined;
    const names: string[] = [];
    const profiles = await fs.readdir(this.userDataRoot, { withFileTypes: true });
    const selectedProfiles = profiles.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
      && /^(?:Default|Profile \d+)$/.test(entry.name));
    if (selectedProfiles.length > 16) throw new Error('Doubao chat profile capacity exceeded');
    for (const profile of selectedProfiles) {
      const directory = path.join(this.userDataRoot, profile.name, 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb');
      try {
        const logs = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()
          && !entry.isSymbolicLink() && /^\d+\.(?:log|ldb)$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
        for (const log of logs) names.push(path.join(directory, log.name));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (names.length > MAX_FILES) throw new Error('Doubao chat file capacity exceeded');
    const observations = new Map<string, { sequence: bigint; value?: DoubaoChatContent }>();
    let readError: unknown;
    for (const name of this.files.keys()) if (!names.includes(name)) this.files.delete(name);
    for (const name of names) {
      try { await this.read(name, budget, sessionId); }
      catch (error) {
        if (error instanceof DoubaoWorkDeferred) throw error;
        readError = error; continue;
      }
      const source = this.files.get(name);
      if (source?.readError && !source.recoveredRequests?.has(sessionId)) { readError = source.readError; continue; }
      for (const snapshot of source?.stores.values() ?? []) {
        const observation = snapshot.tasks.get(sessionId);
        if (!observation) continue;
        const key = `${path.dirname(name)}:${snapshot.key}`;
        const previous = observations.get(key);
        if (!previous || observation.sequence > previous.sequence) observations.set(key, observation);
        else if (observation.sequence === previous.sequence
          && JSON.stringify(observation.value) !== JSON.stringify(previous.value)) return undefined;
      }
    }
    if (readError) throw readError;
    const results = [...observations.values()].flatMap(observation => observation.value ? [observation.value] : []);
    if (results.length > 1 && results.some(task => JSON.stringify(task) !== JSON.stringify(results[0]))) return undefined;
    return results[0];
  }

  private async read(name: string, budget: DoubaoWorkBudget, sessionId: string): Promise<void> {
    const handle = await fs.open(name, 'r');
    try {
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let source = this.files.get(name);
      if (source?.anchor && source.anchorOffset !== undefined && stat.size >= source.offset) {
        const anchor = Buffer.alloc(source.anchor.length);
        await budget.read(handle, anchor, anchor.length, source.anchorOffset, true);
        if (!source.anchor.equals(anchor)) source = undefined;
      }
      if (!source || source.identity !== identity || stat.size < source.offset) {
        source = { identity, offset: 0, fragment: [], fragmentBytes: 0, stores: new Map(), touchedMs: Date.now() };
        this.files.set(name, source);
      }
      if (name.endsWith('.ldb')) {
        if (stat.size > MAX_RECORD_BYTES) throw new Error('Doubao chat table capacity exceeded');
        source.tableChunks ??= [];
        while (source.offset < stat.size) {
          const length = Math.min(64 * 1024, stat.size - source.offset);
          if (budget.remainingBytes < length || budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
          const chunk = Buffer.allocUnsafe(length);
          const bytes = await budget.read(handle, chunk, length, source.offset);
          if (bytes !== length) throw new Error('Doubao chat table changed during read');
          this.bodyReadBytes += bytes;
          source.tableChunks.push(chunk); source.offset += bytes;
        }
        if (source.tableChunks.length) {
          source.tableEntries = chatTableEntries(Buffer.concat(source.tableChunks));
          source.tableBytes = source.offset;
          source.tableStores = new Map();
          source.tableChunks = [];
        }
        while (source.tableEntries) {
          if (budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
          let record;
          let snapshot;
          try {
            record = source.tableEntries.next();
            if (!record.done) snapshot = decodeChatValue(record.value.key, record.value.value, record.value.sequence);
          }
          catch (error) {
            source.tableStores = undefined; source.tableEntries = undefined; source.tableBytes = 0;
            this.files.delete(name);
            throw error;
          }
          if (record.done) {
            this.consume([...(source.tableStores?.values() ?? [])], source, sessionId);
            source.tableEntries = undefined; source.tableStores = undefined; source.tableBytes = 0; break;
          }
          if (snapshot) {
            mergeStoreObservation(source.tableStores!, snapshot);
            limitStoreTasks(source.tableStores!, sessionId);
          }
          budget.record(); await budget.yieldIfNeeded();
        }
        return;
      }
      while (source.offset < stat.size) {
        const readStart = source.offset;
        const available = Math.min(BLOCK_BYTES - source.offset % BLOCK_BYTES, stat.size - source.offset);
        if (available < 7) {
          if ((source.offset + available) % BLOCK_BYTES === 0) { source.offset += available; continue; }
          return;
        }
        if (budget.remainingBytes < available || budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
        const buffer = Buffer.allocUnsafe(available);
        const bytes = await budget.read(handle, buffer, available, source.offset);
        this.bodyReadBytes += bytes;
        if (bytes !== available) throw new Error('Doubao chat WAL changed during read');
        let position = 0;
        while (position + 7 <= bytes) {
          const length = buffer.readUInt16LE(position + 4), type = buffer[position + 6];
          if (length === 0 && type === 0) { position = bytes; source.offset = readStart + bytes; break; }
          if (position + 7 + length > bytes) break;
          const payload = buffer.subarray(position + 7, position + 7 + length);
          if (chatCrc32c(buffer.subarray(position + 6, position + 7 + length)) !== unmaskChatCrc(buffer.readUInt32LE(position))) {
            source.offset = readStart + position + 7 + length;
            source.fragment = []; source.fragmentBytes = 0;
            source.readError = new Error('Doubao chat WAL checksum mismatch');
            source.recoveredRequests = new Set();
            throw source.readError;
          }
          if (type === 1 || type === 2) { source.fragment = []; source.fragmentBytes = 0; }
          if (![1, 2, 3, 4].includes(type) || ((type === 3 || type === 4) && source.fragmentBytes === 0)) {
            source.offset = readStart + position + 7 + length;
            source.fragment = []; source.fragmentBytes = 0;
            source.readError = new Error('Invalid Doubao chat WAL fragment');
            source.recoveredRequests = new Set();
            throw source.readError;
          }
          const fragments = [...source.fragment, Buffer.from(payload)];
          const fragmentBytes = source.fragmentBytes + payload.length;
          if (fragmentBytes > MAX_RECORD_BYTES) {
            source.offset = readStart + position + 7 + length;
            source.fragment = []; source.fragmentBytes = 0;
            source.readError = new Error('Doubao chat WAL record capacity exceeded');
            source.recoveredRequests = new Set();
            throw source.readError;
          }
          if (type === 1 || type === 4) {
            source.offset = readStart + position + 7 + length;
            source.fragment = []; source.fragmentBytes = 0;
            try { this.consume(decodeChatSnapshots(Buffer.concat(fragments)), source, sessionId); }
            catch (error) { source.readError = error; source.recoveredRequests = new Set(); throw error; }
            source.fragment = []; source.fragmentBytes = 0;
          } else { source.fragment = fragments; source.fragmentBytes = fragmentBytes; }
          budget.record();
          position += 7 + length;
          source.offset = readStart + position;
          await budget.yieldIfNeeded();
        }
        if (bytes - position < 7 && (readStart + bytes) % BLOCK_BYTES === 0) {
          source.offset = readStart + bytes; position = bytes;
        }
        // A trailing partial physical record is retried on the next cycle.
        if (position < bytes) return;
      }
    } finally {
      try {
        const source = this.files.get(name);
        if (source && !name.endsWith('.ldb') && source.offset > 0 && budget.remainingBytes >= 32) {
          const length = Math.min(32, source.offset), anchor = Buffer.alloc(length);
          if (await budget.read(handle, anchor, length, source.offset - length, true) === length) {
            source.anchor = anchor; source.anchorOffset = source.offset - length;
          }
        }
      } finally { await handle.close(); }
    }
  }

  private consume(snapshots: ChatStoreSnapshot[], source: Source, sessionId: string): void {
    for (const snapshot of snapshots) {
      mergeStoreObservation(source.stores, snapshot);
      if (source.readError) {
        for (const [id, observation] of snapshot.tasks) if (observation.value) source.recoveredRequests?.add(id);
      }
    }
    limitStoreTasks(source.stores, sessionId);
    if (source.recoveredRequests) {
      const retainedIds = new Set([...source.stores.values()].flatMap(store => [...store.tasks.keys()]));
      for (const id of source.recoveredRequests) if (!retainedIds.has(id)) source.recoveredRequests.delete(id);
    }
    source.touchedMs = Date.now();
    const oldest = [...this.files.values()].sort((a, b) => a.touchedMs - b.touchedMs);
    for (const candidate of oldest) {
      while (this.stats().retainedBytes > this.maxCacheBytes && evictStoreTask(candidate.stores, sessionId)) {}
    }
  }
}

function mergeStoreObservation(stores: Map<string, ChatStoreSnapshot>, snapshot: ChatStoreSnapshot): void {
  let current = stores.get(snapshot.key);
  if (!current) {
    current = { key: snapshot.key, sequence: snapshot.sequence, tasks: new Map() };
    stores.set(snapshot.key, current);
  }
  if (snapshot.sequence > current.sequence) current.sequence = snapshot.sequence;
  for (const [id, observation] of snapshot.tasks) {
    const previous = current.tasks.get(id);
    if (!previous || observation.sequence > previous.sequence) current.tasks.set(id, observation);
  }
}

function storeBytes(stores: Map<string, ChatStoreSnapshot> | undefined): number {
  let bytes = 0;
  for (const snapshot of stores?.values() ?? []) {
    bytes += snapshot.key.length + 64;
    for (const observation of snapshot.tasks.values()) {
      bytes += 512;
      if (observation.value) bytes += Buffer.byteLength(observation.value.input) + Buffer.byteLength(observation.value.output);
    }
  }
  return bytes;
}

function evictStoreTask(stores: Map<string, ChatStoreSnapshot>, sessionId: string): boolean {
  for (const snapshot of stores.values()) {
    const id = [...snapshot.tasks.keys()].find(key => key !== sessionId);
    if (id) { snapshot.tasks.delete(id); return true; }
  }
  return false;
}

function limitStoreTasks(stores: Map<string, ChatStoreSnapshot>, sessionId: string): void {
  if (stores.size > MAX_TASKS) throw new Error('Doubao chat task-store capacity exceeded');
  let count = [...stores.values()].reduce((sum, snapshot) => sum + snapshot.tasks.size, 0);
  while (count > MAX_TASKS && evictStoreTask(stores, sessionId)) count--;
}

/** Chromium stores a Blink envelope around a V8-serialized plain object. */
export function decodeChatWriteBatch(record: Buffer): { sequence: bigint; value: DoubaoChatContent }[] {
  return decodeChatSnapshots(record).flatMap(snapshot => [...snapshot.tasks.values()].flatMap(observation =>
    observation.value ? [{ sequence: observation.sequence, value: observation.value }] : []));
}

function decodeChatSnapshots(record: Buffer): ChatStoreSnapshot[] {
  if (record.length < 12) throw new Error('Invalid Doubao chat write batch');
  const sequence = record.readBigUInt64LE(0), count = record.readUInt32LE(8);
  if (count > 65536) throw new Error('Doubao chat write batch capacity exceeded');
  let position = 12;
  const output: ChatStoreSnapshot[] = [];
  for (let index = 0; index < count; index++) {
    const type = record[position++];
    const keyLength = varint(record, position); position = keyLength.end;
    const key = record.subarray(position, position + keyLength.value); position += keyLength.value;
    if (position > record.length || ![0, 1].includes(type)) throw new Error('Invalid Doubao chat write batch entry');
    if (type === 0) {
      const snapshot = decodeChatValue(key, Buffer.alloc(0), sequence + BigInt(index));
      if (snapshot) output.push(snapshot);
      continue;
    }
    const valueLength = varint(record, position); position = valueLength.end;
    const value = record.subarray(position, position + valueLength.value); position += valueLength.value;
    if (position > record.length) throw new Error('Truncated Doubao chat write batch');
    const snapshot = decodeChatValue(key, value, sequence + BigInt(index));
    if (snapshot) output.push(snapshot);
  }
  if (position !== record.length) throw new Error('Invalid Doubao chat write batch length');
  return output;
}

function decodeChatValue(key: Buffer, value: Buffer, sequence: bigint): ChatStoreSnapshot | undefined {
  if (!isChatTaskKey(key)) return undefined;
  const snapshot: ChatStoreSnapshot = { key: key.toString('hex'), sequence, tasks: new Map() };
  if (!value.length) return snapshot;
  const version = varint(value, 0);
  if (!value.subarray(version.end, version.end + BLINK_ENVELOPE.length).equals(BLINK_ENVELOPE)) {
    throw new Error('Unsupported Doubao chat task-store encoding');
  }
  const state = deserialize(value.subarray(version.end + BLINK_ENVELOPE.length - 2));
  const tasks = state?.state?.mainTaskDataMap;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) throw new Error('Invalid Doubao chat task-store snapshot');
  for (const [sessionId, task] of Object.entries(tasks).slice(-MAX_TASKS)) {
    const projected = projectChatTask(sessionId, task);
    if (ID.test(sessionId)) snapshot.tasks.set(sessionId, { sequence, value: projected });
  }
  return snapshot;
}

function isChatTaskKey(key: Buffer): boolean {
  if (key.length < 8 || key[0] !== 0 || key[1] !== 2 || key[2] !== 1 || key[3] !== 1 || key[4] !== 1) return false;
  const length = varint(key, 5);
  if (length.end + length.value * 2 !== key.length || length.value > 256) return false;
  const text = Buffer.from(key.subarray(length.end)); text.swap16();
  return /^im-sdk:user:\d+:default-chat-im-protocol-store$/.test(text.toString('utf16le'));
}

function projectChatTask(sessionId: string, value: unknown): DoubaoChatContent | undefined {
  const task = value as Record<string, any>;
  const query = task?.requestQuery?.syncTask;
  if (!ID.test(sessionId) || task?.sessionId !== sessionId || query?.option?.unique_key !== sessionId
    || (query.option.conversation_mode !== undefined && query.option.conversation_mode !== 1) || query.option.agent_mode !== 2
    || !Number.isSafeInteger(query.option.create_time_ms)) return undefined;
  const sent = Object.values(task.sentMessages ?? {}) as Record<string, any>[];
  const received = Object.values(task.receivedMessages ?? {}) as Record<string, any>[];
  if (sent.length !== 1 || received.length !== 1) return undefined;
  const input = sent[0], output = received[0], a = input.extra, b = output.extra;
  if (input.sessionId !== sessionId || output.sessionId !== sessionId || a?.user_type !== 1 || b?.user_type !== 2
    || !ID.test(input.uniqueId) || !ID.test(a.message_id) || !ID.test(b.message_id)
    || b.reply_id !== a.message_id || a.conversation_id !== b.conversation_id || !ID.test(b.conversation_id)) return undefined;
  const inputText = chatText(a.content_blocks_v2), outputText = chatText(b.content_blocks_v2);
  if (inputText === undefined || outputText === undefined) return undefined;
  const finishMs = Number(b.ext?.finish_time_ms);
  return { sessionId, localMessageId: input.uniqueId, sendMessageId: a.message_id, receiveMessageId: b.message_id,
    conversationId: b.conversation_id, queryMs: query.option.create_time_ms, input: inputText, output: outputText,
    finished: b.ext?.is_finish === '1' && b.content_blocks_v2.every((block: Record<string, unknown>) => block.is_finish === true),
    ...(Number.isSafeInteger(finishMs) && finishMs >= query.option.create_time_ms ? { finishMs } : {}),
    ...(typeof b.ext?.finish_reason_chat === 'string' ? { finishReason: b.ext.finish_reason_chat.slice(0, 128) } : {}),
    ...(typeof b.ext?.model_id === 'string' && ID.test(b.ext.model_id) ? { modelId: b.ext.model_id } : {}) };
}

function chatText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 128) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block?.block_type !== 10000 || typeof block.content?.text_block?.text !== 'string') return undefined;
    parts.push(block.content.text_block.text);
  }
  const text = parts.join('\n');
  return Buffer.byteLength(text) <= MAX_CONTENT_BYTES ? text : undefined;
}
