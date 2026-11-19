import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const sqliteMockState = vi.hoisted(() => ({ unavailable: false }));
vi.mock('../../../../src/utils/node-sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/node-sqlite.js')>();
  return {
    ...actual,
    loadDatabaseSync: () => (sqliteMockState.unavailable ? null : actual.loadDatabaseSync()),
  };
});

import { loadDatabaseSync } from '../../../../src/utils/node-sqlite.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { ClientType, MULTIMODAL_SUPPORTED_AGENT_IDS, type AgentActivityEntry } from '../../../../src/types/index.js';
import { resolveAgentSystem } from '../../../../src/normalization/agent-system-map.js';
import { WorkspacePolicy } from '../../../../src/core/workspace-policy.js';
import { MultimodalProcessor, type PathToUriFn } from '../../../../src/multimodal/index.js';
import {
  AntigravityInput,
  decodeProtoFields,
  extractWorkspacePathFromBlob,
  modelNameFromId,
  normalizeAntigravityModel,
  parseDurationNs,
  parseTimestampMs,
  readAntigravityConversationDb,
  readAntigravityTranscript,
  resolveAntigravityProvider,
} from '../../../../src/inputs/antigravity/index.js';

// --- Minimal Protobuf encoder helpers for test fixtures ---

function encodeVarint(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  const bytes: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function protoVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes(encodeVarint((fieldNumber << 3) | 0), encodeVarint(value));
}

function protoBytesField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concatBytes(encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload);
}

function protoStringField(fieldNumber: number, text: string): Uint8Array {
  return protoBytesField(fieldNumber, new TextEncoder().encode(text));
}

function protoTimestamp(seconds: number, nanos = 0): Uint8Array {
  return concatBytes(
    protoVarintField(1, seconds),
    ...(nanos > 0 ? [protoVarintField(2, nanos)] : []),
  );
}

function protoDuration(seconds: number, nanos = 0): Uint8Array {
  return concatBytes(
    ...(seconds > 0 ? [protoVarintField(1, seconds)] : []),
    ...(nanos > 0 ? [protoVarintField(2, nanos)] : []),
  );
}

interface UsageFixture {
  modelId?: number;
  inputTokens?: number;
  totalOutputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  visibleOutputTokens?: number;
  provider?: number;
  messageId?: string;
  responseId?: string;
}

function encodeModelUsage(u: UsageFixture): Uint8Array {
  const parts: Uint8Array[] = [];
  if (u.modelId) parts.push(protoVarintField(1, u.modelId));
  if (u.inputTokens) parts.push(protoVarintField(2, u.inputTokens));
  if (u.totalOutputTokens) parts.push(protoVarintField(3, u.totalOutputTokens));
  if (u.cacheCreationTokens) parts.push(protoVarintField(4, u.cacheCreationTokens));
  if (u.cacheReadTokens) parts.push(protoVarintField(5, u.cacheReadTokens));
  if (u.provider) parts.push(protoVarintField(6, u.provider));
  if (u.messageId) parts.push(protoStringField(7, u.messageId));
  if (u.reasoningTokens) parts.push(protoVarintField(9, u.reasoningTokens));
  if (u.visibleOutputTokens) parts.push(protoVarintField(10, u.visibleOutputTokens));
  if (u.responseId) parts.push(protoStringField(11, u.responseId));
  return concatBytes(...parts);
}

function encodeGeneratorMetadata(opts: {
  model?: string;
  modelId?: number;
  usage?: UsageFixture;
  retries?: UsageFixture[];
  timestampSec?: number;
  ttftSec?: number;
  streamSec?: number;
  stepIndices?: number[];
}): Uint8Array {
  const chatParts: Uint8Array[] = [];
  if (opts.modelId) chatParts.push(protoVarintField(3, opts.modelId));
  if (opts.usage) chatParts.push(protoBytesField(4, encodeModelUsage(opts.usage)));
  if (opts.timestampSec) {
    chatParts.push(protoBytesField(9, protoBytesField(4, protoTimestamp(opts.timestampSec))));
  }
  if (opts.ttftSec !== undefined) {
    const secs = Math.floor(opts.ttftSec);
    const nanos = Math.round((opts.ttftSec - secs) * 1e9);
    chatParts.push(protoBytesField(11, protoDuration(secs, nanos)));
  }
  if (opts.streamSec !== undefined) {
    const secs = Math.floor(opts.streamSec);
    const nanos = Math.round((opts.streamSec - secs) * 1e9);
    chatParts.push(protoBytesField(12, protoDuration(secs, nanos)));
  }
  for (const retry of opts.retries ?? []) {
    chatParts.push(protoBytesField(17, protoBytesField(2, encodeModelUsage(retry))));
  }
  if (opts.model) chatParts.push(protoStringField(19, opts.model));

  const rootParts: Uint8Array[] = [protoBytesField(1, concatBytes(...chatParts))];
  if (opts.stepIndices && opts.stepIndices.length > 0) {
    const packed = concatBytes(...opts.stepIndices.map((i) => encodeVarint(i)));
    rootParts.push(protoBytesField(2, packed));
  }
  return concatBytes(...rootParts);
}

function encodeStepMetadata(opts: {
  timestampSec?: number;
  usage?: UsageFixture;
  model?: string;
  modelId?: number;
  provider?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.timestampSec) parts.push(protoBytesField(1, protoTimestamp(opts.timestampSec)));
  if (opts.usage) parts.push(protoBytesField(9, encodeModelUsage(opts.usage)));
  if (opts.model || opts.modelId || opts.provider) {
    const info: Uint8Array[] = [];
    if (opts.modelId) info.push(protoVarintField(1, opts.modelId));
    if (opts.provider) info.push(protoVarintField(7, opts.provider));
    if (opts.model) info.push(protoStringField(12, opts.model));
    parts.push(protoBytesField(24, concatBytes(...info)));
  }
  return concatBytes(...parts);
}

function createConversationDb(
  dbPath: string,
  opts: {
    genRows: Array<[number, Uint8Array]>;
    stepRows?: Array<[number, Uint8Array]>;
    trajectoryBlob?: Uint8Array;
  },
): void {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) throw new Error('node:sqlite required for tests');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY DEFAULT 'main', data BLOB);
    `);
    const insGen = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    for (const [idx, blob] of opts.genRows) {
      insGen.run(idx, blob, blob.length);
    }
    const insStep = db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)');
    for (const [idx, blob] of opts.stepRows ?? []) {
      insStep.run(idx, blob);
    }
    if (opts.trajectoryBlob) {
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
        'main',
        opts.trajectoryBlob,
      );
    }
  } finally {
    db.close();
  }
}

describe('Antigravity protobuf & model normalizer', () => {
  it('decodes protobuf timestamps, durations, and rejects truncated blobs', () => {
    const ts = parseTimestampMs(protoTimestamp(1_778_000_000, 250_000_000));
    expect(ts).toBe(1_778_000_000_250);

    const dur = parseDurationNs(protoDuration(1, 500_000_000));
    expect(dur).toBe(1_500_000_000);
    // Reject nanos >= 1e9
    expect(parseDurationNs(protoDuration(0, 1_500_000_000))).toBeUndefined();

    // Extract workspace URI cleanly with spaces (%20), non-ASCII UTF-8, and adjacent protobuf fields
    const wsBlob = concatBytes(
      protoStringField(1, 'file:///Users/dev/my%20repo/%E4%B8%AD%E6%96%87'),
      protoStringField(15, 'adjacent-field-with-tag-z'),
    );
    expect(extractWorkspacePathFromBlob(wsBlob)).toBe('/Users/dev/my repo/中文');

    // Truncated length-delimited field throws cleanly
    expect(() => decodeProtoFields(new Uint8Array([0x0a, 0x10, 0x01, 0x02]))).toThrow();
    // Overflowing varint (>10 bytes) throws cleanly
    expect(() => decodeProtoFields(new Uint8Array(12).fill(0x80))).toThrow();
  });

  it('normalizes Antigravity display names, model IDs, and providers', () => {
    expect(normalizeAntigravityModel('Gemini 3.8 Flash (High)')).toBe('gemini-3.8-flash-high');
    expect(normalizeAntigravityModel('Gemini 4 Neon (Medium)')).toBe('gemini-4-neon-medium');
    expect(normalizeAntigravityModel('model_placeholder_m318')).toBe('gemini-3.8-flash-high');
    expect(modelNameFromId(1318)).toBe('gemini-3.8-flash-high');
    expect(modelNameFromId(1402)).toBe('claude-opus-5-5');
    expect(resolveAntigravityProvider('gemini-4-neon-medium')).toBe('gcp.gemini');
    expect(resolveAntigravityProvider('claude-opus-5-5')).toBe('anthropic');
    expect(resolveAntigravityProvider('gpt-oss-120b-medium')).toBe('openai');
  });

  it('maps all three Antigravity client types to the antigravity agent system', () => {
    expect(resolveAgentSystem(ClientType.Antigravity)).toBe('antigravity');
    expect(resolveAgentSystem(ClientType.AntigravityIde)).toBe('antigravity');
    expect(resolveAgentSystem(ClientType.AntigravityCli)).toBe('antigravity');
  });
});

describe('Antigravity SQLite reader & AntigravityInput', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-antigravity-test-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads gen_metadata + steps, deduplicates mirrors/retries, and extracts workspace', async () => {
    const dbPath = path.join(tmpDir, 'session-1.db');
    const primaryUsage: UsageFixture = {
      inputTokens: 400,
      totalOutputTokens: 200,
      cacheCreationTokens: 30,
      cacheReadTokens: 500,
      reasoningTokens: 50,
      visibleOutputTokens: 150,
      responseId: 'resp-1',
    };
    const retryUsage: UsageFixture = {
      inputTokens: 100,
      totalOutputTokens: 20,
      visibleOutputTokens: 20,
      responseId: 'resp-retry-1',
    };
    const continuationUsage: UsageFixture = {
      inputTokens: 300,
      totalOutputTokens: 100,
      reasoningTokens: 25,
      visibleOutputTokens: 75,
      responseId: 'resp-2',
    };

    const trajBlob = concatBytes(
      protoBytesField(2, protoTimestamp(1_778_000_000)),
      protoStringField(10, 'file:///Users/dev/project-alpha'),
    );

    createConversationDb(dbPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: primaryUsage,
            // Include a mirror of primaryUsage (must be dropped) + one real retry (must be kept)
            retries: [primaryUsage, retryUsage],
            timestampSec: 1_778_000_010,
            ttftSec: 0.4,
            streamSec: 1.2,
            stepIndices: [1],
          }),
        ],
        [
          1,
          // Continuation without model inherits Gemini 3.8 Flash (High)
          encodeGeneratorMetadata({
            usage: continuationUsage,
            timestampSec: 1_778_000_020,
            stepIndices: [3],
          }),
        ],
      ],
      stepRows: [
        // Duplicate of primaryUsage in steps table should merge, not double-count
        [1, encodeStepMetadata({ timestampSec: 1_778_000_010, usage: primaryUsage })],
      ],
      trajectoryBlob: trajBlob,
    });

    const snapshot = await readAntigravityConversationDb(dbPath);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBe('session-1');
    expect(snapshot!.workspacePath).toBe('/Users/dev/project-alpha');
    // primaryUsage (merged), retryUsage, continuationUsage -> 3 unique events
    expect(snapshot!.events).toHaveLength(3);

    const primary = snapshot!.events.find((e) => e.messageId === 'resp-1')!;
    expect(primary.model).toBe('gemini-3.8-flash-high');
    expect(primary.freshInputTokens).toBe(400);
    expect(primary.cacheReadTokens).toBe(500);
    expect(primary.cacheCreationTokens).toBe(30);
    expect(primary.totalOutputTokens).toBe(200);
    expect(primary.ttftNs).toBe(400_000_000);

    const cont = snapshot!.events.find((e) => e.messageId === 'resp-2')!;
    expect(cont.model).toBe('gemini-3.8-flash-high');
  });

  it('skips empty SQLite files cleanly', async () => {
    const emptyPath = path.join(tmpDir, 'empty.db');
    await fs.writeFile(emptyPath, '');
    const snapshot = await readAntigravityConversationDb(emptyPath);
    expect(snapshot).toBeNull();
  });

  it('emits normalized events for all three agent types with transcript enrichment', async () => {
    const variants: Array<{ clientType: ClientType.Antigravity | ClientType.AntigravityIde | ClientType.AntigravityCli; dir: string }> = [
      { clientType: ClientType.Antigravity, dir: 'antigravity' },
      { clientType: ClientType.AntigravityIde, dir: 'antigravity-ide' },
      { clientType: ClientType.AntigravityCli, dir: 'antigravity-cli' },
    ];

    for (const { clientType, dir } of variants) {
      const root = path.join(tmpDir, dir);
      const convDir = path.join(root, 'conversations');
      const sid = `sess-${dir}`;
      const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
      await fs.mkdir(convDir, { recursive: true });
      await fs.mkdir(logsDir, { recursive: true });

      createConversationDb(path.join(convDir, `${sid}.db`), {
        genRows: [
          [
            0,
            encodeGeneratorMetadata({
              model: 'Gemini 4 Neon (Medium)',
              usage: {
                inputTokens: 1000,
                cacheReadTokens: 2000,
                cacheCreationTokens: 500,
                totalOutputTokens: 300,
                reasoningTokens: 100,
                visibleOutputTokens: 200,
                responseId: `resp-${dir}`,
              },
              timestampSec: 1_778_000_100,
              ttftSec: 0.5,
              streamSec: 1.5,
              stepIndices: [1],
            }),
          ],
        ],
      });

      const respSec = 1_778_000_100;
      const transcriptLines = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date((respSec - 3) * 1000).toISOString(),
          content: 'Check repo status',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date((respSec - 2) * 1000).toISOString(),
          model: 'gemini-4-neon-medium',
          thinking: 'Let me run git status.',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date((respSec + 2) * 1000).toISOString(),
          content: 'On branch main',
        }),
      ];
      await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), transcriptLines.join('\n') + '\n');

      const input = new AntigravityInput({
        stateStore,
        clientType,
        dataRoot: root,
        collectHistorical: true,
      });

      const collected: AgentActivityEntry[] = [];
      input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
      await input.start();
      await input.stop();

      expect(collected.length).toBeGreaterThanOrEqual(5);
      expect(collected.every((e) => e['gen_ai.agent.type'] === clientType)).toBe(true);

      const userInput = collected.find((e) => e['event.name'] === 'other');
      expect(userInput?.['gen_ai.turn.start']).toBe(true);

      const llmReq = collected.find((e) => e['event.name'] === 'llm.request');
      expect(llmReq?.['gen_ai.request.model']).toBe('gemini-4-neon-medium');
      expect(llmReq?.['gen_ai.input.messages_delta']).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'Check repo status' }] },
      ]);
      expect(typeof llmReq?.['gen_ai.input.messages_hash']).toBe('string');

      const llmResp = collected.find((e) => e['event.name'] === 'llm.response');
      // gen_metadata timestamp is completion time; reqTsMs = respTsMs - (ttft + stream) = respSec - 2s
      expect(BigInt(llmResp!.time_unix_nano) - BigInt(llmReq!.time_unix_nano)).toBe(2_000_000_000n);
      expect(collected.map((e) => e['event.name'])).toEqual([
        'other',
        'llm.request',
        'llm.response',
        'tool.call',
        'tool.result',
      ]);
      // Pilot canonical schema: input_tokens includes cache_read + cache_creation
      expect(llmResp?.['gen_ai.usage.input_tokens']).toBe(3500);
      expect(llmResp?.['gen_ai.usage.cache_read.input_tokens']).toBe(2000);
      expect(llmResp?.['gen_ai.usage.cache_creation.input_tokens']).toBe(500);
      expect(llmResp?.['gen_ai.usage.output_tokens']).toBe(300);
      expect(llmResp?.['gen_ai.usage.total_tokens']).toBe(3800);
      expect(llmResp?.['gen_ai.usage.reasoning_output_tokens']).toBe(100);
      expect(llmResp?.['gen_ai.response.time_to_first_token']).toBe(500_000_000);
      expect(llmResp?.['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
      expect(llmReq?.['gen_ai.response.id']).toBe(llmResp?.['gen_ai.response.id']);
      expect(llmReq?.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(llmReq?.span_id).toBe(llmResp?.span_id);
      expect(llmReq?.parent_span_id).toBe(llmResp?.parent_span_id);
      expect(userInput?.trace_id).toBe(llmReq?.trace_id);
      expect(userInput?.parent_span_id).toBe('0000000000000001');

      const toolCall = collected.find((e) => e['event.name'] === 'tool.call');
      const toolResult = collected.find((e) => e['event.name'] === 'tool.result');
      expect(toolCall?.['gen_ai.tool.name']).toBe('run_command');
      expect(toolResult?.['gen_ai.tool.name']).toBe('run_command');
      expect(toolResult?.['gen_ai.tool.call.id']).toBe(toolCall?.['gen_ai.tool.call.id']);
      expect(toolResult?.span_id).toBe(toolCall?.span_id);
      expect(toolResult?.parent_span_id).toBe(llmReq?.parent_span_id);
      // tool.result must share the parent PLANNER_RESPONSE step.id for planTurnStream
      expect(toolResult?.['gen_ai.step.id']).toBe(toolCall?.['gen_ai.step.id']);
      expect(toolResult?.['gen_ai.step.id']).toBe(llmReq?.['gen_ai.step.id']);
      expect(toolResult?.['gen_ai.tool.call.duration']).toBe(2000);
    }
  });

  it('degrades gracefully without transcript.jsonl and avoids duplicates across restarts', async () => {
    const root = path.join(tmpDir, 'no-transcript');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const dbPath = path.join(convDir, 'legacy-sess.db');
    createConversationDb(dbPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: {
              inputTokens: 200,
              totalOutputTokens: 50,
              visibleOutputTokens: 50,
              responseId: 'legacy-resp-1',
            },
            timestampSec: 1_778_000_200,
          }),
        ],
      ],
    });

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityIde,
      dataRoot: root,
      collectHistorical: true,
    });
    const batch1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => batch1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(batch1.map((e) => e['event.name'])).toEqual(['llm.request', 'llm.response']);

    // Restart with same persisted StateStore -> must not re-emit
    await stateStore.save();
    const stateStore2 = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore2.load();
    const input2 = new AntigravityInput({
      stateStore: stateStore2,
      clientType: ClientType.AntigravityIde,
      dataRoot: root,
      collectHistorical: true,
    });
    const batch2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => batch2.push(...entries));
    await input2.start();
    await input2.stop();
    expect(batch2).toHaveLength(0);
  });

  it('seeds historical DBs on fresh start when collectHistorical is false and collects only new rows', async () => {
    const root = path.join(tmpDir, 'fresh-seed');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });
    const dbPath = path.join(convDir, 'active.db');

    createConversationDb(dbPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'old-1' },
            timestampSec: 1_778_000_300,
          }),
        ],
      ],
    });

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: root,
      collectHistorical: false,
    });
    const batch1: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => batch1.push(...entries));
    await input.start();
    await input.stop();
    // Fresh start seeds existing rows without replaying history
    expect(batch1).toHaveLength(0);

    // Append a new generation row and bump mtime
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const blob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 150, totalOutputTokens: 40, visibleOutputTokens: 40, responseId: 'new-2' },
        timestampSec: 1_778_000_400,
      });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, blob, blob.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const batch2: AgentActivityEntry[] = [];
    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: root,
      collectHistorical: false,
    });
    input2.on('entries', (entries: AgentActivityEntry[]) => batch2.push(...entries));
    await input2.start();
    await input2.stop();

    expect(batch2).toHaveLength(2);
    expect(batch2[1]?.['gen_ai.response.id']).toBe('new-2');
    expect(batch2[1]?.['gen_ai.agent.type']).toBe('antigravity-cli');
  });

  it('respects WorkspacePolicy exclusions (DB + transcript)', async () => {
    const root = path.join(tmpDir, 'excluded-root');
    const convDir = path.join(root, 'conversations');
    const excludedWs = path.join(tmpDir, 'secret-repo');
    const logsDir = path.join(root, 'brain', 'secret', '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(excludedWs, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    createConversationDb(path.join(convDir, 'secret.db'), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'sec-1' },
            timestampSec: 1_778_000_500,
            stepIndices: [1],
          }),
        ],
      ],
      trajectoryBlob: protoStringField(7, pathToFileURL(excludedWs).href),
    });
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-05-06T00:08:19Z', content: 'secret prompt' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-05-06T00:08:20Z', content: 'secret reply' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    input.setWorkspacePolicy(new WorkspacePolicy([excludedWs]));

    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();
    expect(collected).toHaveLength(0);
  });

  it('collects multimodal image and video attachments when enabled and respects uploadMode', async () => {
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('antigravity');
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('antigravity-ide');
    expect(MULTIMODAL_SUPPORTED_AGENT_IDS).toContain('antigravity-cli');

    const root = path.join(tmpDir, 'mm-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'mm-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const imgPath = path.join(root, 'brain', sid, '.user_uploaded', 'photo.jpg');
    const vidPath = path.join(root, 'brain', sid, '.user_uploaded', 'clip.mp4');
    const outImgPath = path.join(root, 'brain', sid, 'generated.png');

    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 4 Neon (Medium)',
            usage: { inputTokens: 500, totalOutputTokens: 100, visibleOutputTokens: 100, responseId: 'mm-1' },
            timestampSec: 1_778_000_600,
            stepIndices: [1],
          }),
        ],
      ],
    });

    const transcriptLines = [
      // Image + video only USER_INPUT (no text content)
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-05-06T00:09:59Z',
        media: [
          { mime_type: 'image/jpeg', uri: imgPath },
          { mime_type: 'video/mp4', uri: vidPath },
        ],
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-05-06T00:10:00Z',
        content: 'Here is the result.',
        media: [{ mime_type: 'image/png', uri: outImgPath }],
      }),
    ];
    await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), transcriptLines.join('\n') + '\n');

    const fakePathToUri: PathToUriFn = async (filePath) => {
      if (filePath.endsWith('.jpg')) {
        return { uri: 'oss://bucket/20260506/img.jpg', mime_type: 'image/jpeg', modality: 'image', size: 123, sha256: 'a' };
      }
      if (filePath.endsWith('.mp4')) {
        return { uri: 'oss://bucket/20260506/clip.mp4', mime_type: 'video/mp4', modality: 'video', size: 456, sha256: 'b' };
      }
      if (filePath.endsWith('.png')) {
        return { uri: 'oss://bucket/20260506/out.png', mime_type: 'image/png', modality: 'image', size: 789, sha256: 'c' };
      }
      return null;
    };

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
      multimodal: {
        enabled: true,
        uploadMode: 'all',
        pathToUri: fakePathToUri,
      },
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    const userInput = collected.find((e) => e['event.name'] === 'other');
    expect(userInput).toBeDefined();
    expect(userInput?.['gen_ai.input.multimodal_metadata']).toEqual([
      { uri: 'oss://bucket/20260506/img.jpg', mime_type: 'image/jpeg', modality: 'image' },
      { uri: 'oss://bucket/20260506/clip.mp4', mime_type: 'video/mp4', modality: 'video' },
    ]);

    const llmResp = collected.find((e) => e['event.name'] === 'llm.response');
    expect(llmResp?.['gen_ai.output.multimodal_metadata']).toEqual([
      { uri: 'oss://bucket/20260506/out.png', mime_type: 'image/png', modality: 'image' },
    ]);

    const llmReq = collected.find((e) => e['event.name'] === 'llm.request');
    expect(llmReq?.['gen_ai.input.multimodal_metadata_delta']).toEqual([
      { uri: 'oss://bucket/20260506/img.jpg', mime_type: 'image/jpeg', modality: 'image' },
      { uri: 'oss://bucket/20260506/clip.mp4', mime_type: 'video/mp4', modality: 'video' },
    ]);

    // When uploadMode is 'none', no media metadata is attached and image-only USER_INPUT is omitted
    const storeNone = new StateStore(path.join(tmpDir, 'state-none.json'));
    await storeNone.load();
    const inputNone = new AntigravityInput({
      stateStore: storeNone,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
      multimodal: { enabled: false, uploadMode: 'none', pathToUri: fakePathToUri },
    });
    const collectedNone: AgentActivityEntry[] = [];
    inputNone.on('entries', (entries: AgentActivityEntry[]) => collectedNone.push(...entries));
    await inputNone.start();
    await inputNone.stop();
    expect(collectedNone.find((e) => e['event.name'] === 'other')).toBeUndefined();
    expect(collectedNone.find((e) => e['event.name'] === 'llm.response')?.['gen_ai.output.multimodal_metadata']).toBeUndefined();
  });

  it('populates gen_ai.input.messages_delta across multi-step tool-calling turns', async () => {
    const root = path.join(tmpDir, 'delta-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'delta-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 200, totalOutputTokens: 50, visibleOutputTokens: 50, responseId: 'd-1' },
            timestampSec: 1_778_000_700,
            stepIndices: [1, 2],
          }),
        ],
        [
          1,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 350, totalOutputTokens: 80, visibleOutputTokens: 80, responseId: 'd-2' },
            timestampSec: 1_778_000_705,
            stepIndices: [3],
          }),
        ],
      ],
    });

    const transcriptLines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-05-06T00:11:39Z', content: 'List files' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-05-06T00:11:40Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-05-06T00:11:42Z', content: 'README.md' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-05-06T00:11:45Z', content: 'Found README.md.' }),
    ];
    await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), transcriptLines.join('\n') + '\n');

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: root,
      collectHistorical: true,
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    const reqs = collected.filter((e) => e['event.name'] === 'llm.request');
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'List files' }] },
    ]);
    expect(reqs[1]?.['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: `${sid}:step:1:tc:0`,
            name: 'run_command',
            arguments: { CommandLine: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: `${sid}:step:1:tc:0`,
            response: 'README.md',
          },
        ],
      },
    ]);
  });

  it('deduplicates repeated/out-of-order step_index lines so turn.id stays consistent', async () => {
    const root = path.join(tmpDir, 'dup-step-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'dup-turn-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Claude Opus 5.5',
            modelId: 1402,
            usage: { inputTokens: 100, totalOutputTokens: 40, visibleOutputTokens: 40, responseId: 'dt-1' },
            timestampSec: 1_778_000_800,
            stepIndices: [1],
          }),
        ],
      ],
    });

    // Simulate Antigravity appending duplicate step_index: 0 after step_index: 1 (exact same timestamp)
    const sameIso = new Date(1_778_000_800 * 1000).toISOString();
    const transcriptLines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: sameIso, content: 'Hello' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: sameIso, content: 'Hi!' }),
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: sameIso, content: 'Hello' }),
    ];
    await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), transcriptLines.join('\n') + '\n');

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    const others = collected.filter((e) => e['event.name'] === 'other');
    expect(others).toHaveLength(1);
    expect(others[0]?.['gen_ai.turn.id']).toBe(`${sid}:turn:1`);
    // Provider inferred from Claude turn model rather than hardcoded gcp.gemini
    expect(others[0]?.['gen_ai.provider.name']).toBe('anthropic');
    // Same-ms sort places other -> llm.request -> llm.response
    expect(collected.map((e) => e['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
    expect(collected.every((e) => e['gen_ai.turn.id'] === `${sid}:turn:1`)).toBe(true);
  });

  it('delivers tool.result across poll cycles when result step lands after PLANNER_RESPONSE', async () => {
    const root = path.join(tmpDir, 'cross-poll-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'cross-poll-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const dbPath = path.join(convDir, `${sid}.db`);
    createConversationDb(dbPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'cp-1' },
            timestampSec: 1_778_000_900,
            stepIndices: [1],
          }),
        ],
      ],
    });

    const cpSec = 1_778_000_900;
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((cpSec - 1) * 1000).toISOString(), content: 'Run slow cmd' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(cpSec * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 15' } }] }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const cycle1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => cycle1.push(...entries));
    await input1.start();
    await input1.stop();

    const call1 = cycle1.find((e) => e['event.name'] === 'tool.call');
    expect(call1).toBeDefined();
    expect(cycle1.find((e) => e['event.name'] === 'tool.result')).toBeUndefined();

    // Cycle 2: tool result step lands later
    await fs.appendFile(
      transcriptPath,
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((cpSec + 15) * 1000).toISOString(), content: 'done' }) + '\n',
    );

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const cycle2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => cycle2.push(...entries));
    await input2.start();
    await input2.stop();

    const result2 = cycle2.find((e) => e['event.name'] === 'tool.result');
    expect(result2).toBeDefined();
    expect(result2?.['gen_ai.tool.call.id']).toBe(call1?.['gen_ai.tool.call.id']);
    expect(result2?.['gen_ai.step.id']).toBe(call1?.['gen_ai.step.id']);
    expect(result2?.['gen_ai.tool.call.duration']).toBe(15_000);
  });

  it('prevents infinite replay in long sessions (>512 events) via monotonic genIdx watermark', async () => {
    const root = path.join(tmpDir, 'long-sess-root');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });
    const dbPath = path.join(convDir, 'long.db');

    const genRows: Array<[number, Uint8Array]> = [];
    for (let i = 0; i < 530; i++) {
      genRows.push([
        i,
        encodeGeneratorMetadata({
          model: 'Gemini 3.8 Flash (High)',
          usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: `r-${i}` },
          timestampSec: 1_778_001_000 + i,
        }),
      ]);
    }
    createConversationDb(dbPath, { genRows });

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: root,
      collectHistorical: true,
    });
    const batch1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => batch1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(batch1.filter((e) => e['event.name'] === 'llm.response')).toHaveLength(530);

    // Append 1 new row (idx 530) -> must emit ONLY the 1 new row, NOT replay rows 0..17
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const blob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: 'r-530' },
        timestampSec: 1_778_002_000,
      });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(530, blob, blob.length);
    } finally {
      db.close();
    }

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: root,
      collectHistorical: true,
    });
    const batch2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => batch2.push(...entries));
    await input2.start();
    await input2.stop();
    const resps2 = batch2.filter((e) => e['event.name'] === 'llm.response');
    expect(resps2).toHaveLength(1);
    expect(resps2[0]?.['gen_ai.response.id']).toBe('r-530');
  });

  it('persists seeded=true on empty conversationsDir and checks availability / watchPaths', async () => {
    const root = path.join(tmpDir, 'empty-seed-root');
    expect(await AntigravityInput.checkAvailability(ClientType.Antigravity, root)).toBe(false);
    expect(AntigravityInput.getWatchPaths(ClientType.Antigravity, root)).toEqual([
      root,
      path.join(root, 'conversations'),
    ]);

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    await input1.start();
    await input1.stop();

    // Now user creates their first conversation after Pilot started
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });
    expect(await AntigravityInput.checkAvailability(ClientType.Antigravity, root)).toBe(true);
    createConversationDb(path.join(convDir, 'first.db'), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 50, totalOutputTokens: 10, visibleOutputTokens: 10, responseId: 'first-1' },
            timestampSec: 1_778_003_000,
          }),
        ],
      ],
    });

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const batch2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => batch2.push(...entries));
    await input2.start();
    await input2.stop();
    expect(batch2.filter((e) => e['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it('uses native SQLite turn UUID (f12), tool call ID (f4.1), exec/done timestamps (f32/f8), and step-0 SYSTEM_MESSAGE', async () => {
    const root = path.join(tmpDir, 'native-meta-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'subagent-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const nativeTurnUuid = '492c6b8f-0aff-4686-a5a2-d98e74089425';
    const baseSec = 1_778_005_000;

    // Encode steps.metadata with native f1 (created), f4 (tool call), f8 (completed), f12 (turnId), f32 (execStarted)
    const step0Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec, 100_000_000)),
      protoStringField(12, nativeTurnUuid),
    );
    const step1Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec, 200_000_000)),
      protoBytesField(8, protoTimestamp(baseSec + 3, 500_000_000)),
      protoStringField(12, nativeTurnUuid),
    );
    const step2Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec + 3, 400_000_000)),
      protoBytesField(4, concatBytes(protoStringField(1, 'call_5733556713250294416'), protoStringField(2, 'run_command'))),
      protoBytesField(8, protoTimestamp(baseSec + 5, 537_000_000)),
      protoStringField(12, nativeTurnUuid),
      protoBytesField(32, protoTimestamp(baseSec + 3, 500_000_000)),
    );

    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 4 Neon (Medium)',
            usage: { inputTokens: 300, totalOutputTokens: 120, reasoningTokens: 40, visibleOutputTokens: 80, responseId: 'sub-r1' },
            timestampSec: baseSec + 3,
            stepIndices: [1, 2],
          }),
        ],
      ],
      stepRows: [
        [0, step0Meta],
        [1, step1Meta],
        [2, step2Meta],
      ],
    });

    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), content: 'Subagent task prompt' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }] }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((baseSec + 3) * 1000).toISOString(), content: '/workspace' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    expect(collected.map((e) => e['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
    ]);
    // All events share native turn UUID and deterministic trace_id
    expect(collected.every((e) => e['gen_ai.turn.id'] === `${sid}:${nativeTurnUuid}`)).toBe(true);
    const traceIds = new Set(collected.map((e) => e.trace_id));
    expect(traceIds.size).toBe(1);

    const llmReq = collected[1]!;
    expect(llmReq['gen_ai.input.messages_delta']).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Subagent task prompt' }] },
    ]);

    const toolCall = collected[3]!;
    const toolResult = collected[4]!;
    expect(toolCall['gen_ai.tool.call.id']).toBe('call_5733556713250294416');
    expect(toolResult['gen_ai.tool.call.id']).toBe('call_5733556713250294416');
    // Real tool execution duration from steps.metadata f8 - f32 = 2037ms
    expect(toolResult['gen_ai.tool.call.duration']).toBe(2037);
  });

  it('rejects bare file://, root /, Windows drive roots, and remote UNC URIs and prioritizes native workspace fields', () => {
    const bareFile = protoStringField(1, 'file://');
    const rootFile = protoStringField(1, 'file:///');
    const winDriveRoot = protoStringField(7, 'file:///C:/');
    const uncRemote = protoStringField(7, 'file://evil-server/share/repo');
    // Earlier unrelated file:// URI in field 3 must lose to native workspace field 1.1
    const nativePrioritized = concatBytes(
      protoStringField(3, 'file:///tmp/unrelated.txt'),
      protoBytesField(1, protoStringField(1, 'file:///Users/demo/real-workspace')),
    );
    const mixed = concatBytes(
      protoStringField(7, 'file:///'),
      protoStringField(7, 'file://evil-server/share'),
      protoStringField(7, 'file:///Users/demo/project'),
    );
    expect(extractWorkspacePathFromBlob(bareFile)).toBeUndefined();
    expect(extractWorkspacePathFromBlob(rootFile)).toBeUndefined();
    expect(extractWorkspacePathFromBlob(winDriveRoot)).toBeUndefined();
    expect(extractWorkspacePathFromBlob(uncRemote)).toBeUndefined();
    expect(extractWorkspacePathFromBlob(nativePrioritized)).toBe('/Users/demo/real-workspace');
    expect(extractWorkspacePathFromBlob(mixed)).toBe('/Users/demo/project');
  });

  it('reads >8 MiB multi-chunk transcripts with a multi-byte UTF-8 character straddling byte 524,288 and skips >4 MiB lines', async () => {
    const root = path.join(tmpDir, 'utf8-chunk-root');
    const sid = 'chunk-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(logsDir, { recursive: true });

    // Compute exact byte offset so a 3-byte UTF-8 character ('中', 0xe4 0xb8 0xad)
    // literally straddles the 512 KiB (524,288) read chunk boundary (byte 524,287..524,289).
    const chunkBoundary = 512 * 1024;
    const straddleText = '中文测试边界🚀🎉✨你好世界';
    const straddlePrefix = '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"';
    const line0Template = (padLen: number) =>
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'a'.repeat(padLen),
      });
    const baseLen = Buffer.byteLength(`${line0Template(0)}\n${straddlePrefix}`, 'utf-8');
    // Put byte 0 of '中' at offset chunkBoundary - 1 so bytes 1 & 2 fall into chunk 2
    const padLen = chunkBoundary - 1 - baseLen;
    const line0 = line0Template(padLen);
    const line1 = `${straddlePrefix}${straddleText}"}`;
    expect(Buffer.byteLength(`${line0}\n${straddlePrefix}`, 'utf-8')).toBe(chunkBoundary - 1);

    // Oversized (>4 MiB) single line that must be skipped without aborting subsequent lines
    const oversizedLine = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'z'.repeat(4 * 1024 * 1024 + 128),
    });
    // Add a valid 3.8 MiB line so total file size exceeds 8 MiB
    const largeValidLine = JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'b'.repeat(3_800_000),
    });
    const finalLine = JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'recovered past 8 MiB',
    });

    const fullPayload = `${line0}\n${line1}\n${oversizedLine}\n${largeValidLine}\n${finalLine}\n`;
    expect(Buffer.byteLength(fullPayload, 'utf-8')).toBeGreaterThan(8 * 1024 * 1024);
    await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), fullPayload);

    const transcript = await readAntigravityTranscript(root, sid);
    expect(transcript).not.toBeNull();
    expect(transcript!.steps.map((s) => s.stepIndex)).toEqual([0, 1, 3, 4]);
    expect(transcript!.byStepIndex.get(1)?.content).toBe(straddleText);
    expect(transcript!.byStepIndex.get(1)?.content).not.toContain('\uFFFD');
    expect(transcript!.byStepIndex.get(4)?.content).toBe('recovered past 8 MiB');
  });

  it('does not advance watermarks on 0-token rows and deduplicates cross-cycle steps -> gen_metadata responseId arrival', async () => {
    const root = path.join(tmpDir, 'zero-token-dedup-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'dedup-sess';
    await fs.mkdir(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${sid}.db`);

    // Cycle 1:
    // - step 1 has token-bearing usage WITHOUT responseId (fallback key step:<sid>:1)
    // - gen_metadata idx=5 has a 0-token placeholder row (must NOT advance maxEmittedGenIdx to 5)
    const step1Usage = encodeModelUsage({
      inputTokens: 120,
      totalOutputTokens: 30,
      visibleOutputTokens: 30,
    });
    const step1Meta = concatBytes(
      protoBytesField(1, protoTimestamp(1_778_006_000)),
      protoBytesField(9, step1Usage),
    );
    const zeroGenBlob = encodeGeneratorMetadata({
      model: 'Gemini 3.8 Flash (High)',
      usage: { inputTokens: 0, totalOutputTokens: 0, visibleOutputTokens: 0 },
      timestampSec: 1_778_006_010,
      stepIndices: [3],
    });
    createConversationDb(dbPath, {
      stepRows: [[1, step1Meta]],
      genRows: [[5, zeroGenBlob]],
    });

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const cycle1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => cycle1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(cycle1.filter((e) => e['event.name'] === 'llm.response')).toHaveLength(1);

    // Cycle 2:
    // - gen_metadata idx=1 lands WITH responseId='late-r1' for step 1 (must dedup against step:<sid>:1!)
    // - gen_metadata idx=5 is updated to now carry tokens with responseId='r-5' (must NOT be skipped!)
    // - gen_metadata idx=6 lands with a distinct responseId='r-6' also referencing step 3 (must NOT merge into r-5!)
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const lateR1 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 120, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'late-r1' },
        timestampSec: 1_778_006_001,
        stepIndices: [1],
      });
      const filled5 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 200, totalOutputTokens: 50, visibleOutputTokens: 50, responseId: 'r-5' },
        timestampSec: 1_778_006_015,
        stepIndices: [3],
      });
      const distinct6 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 210, totalOutputTokens: 60, visibleOutputTokens: 60, responseId: 'r-6' },
        timestampSec: 1_778_006_020,
        stepIndices: [3],
      });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, lateR1, lateR1.length);
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 5').run(filled5, filled5.length);
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(6, distinct6, distinct6.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const cycle2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => cycle2.push(...entries));
    await input2.start();
    await input2.stop();

    const resps2 = cycle2.filter((e) => e['event.name'] === 'llm.response');
    expect(resps2.map((e) => e['gen_ai.response.id'])).toEqual(['r-5', 'r-6']);
  });

  it('defers seeding a transiently unreadable DB during fresh seed without replaying its history on recovery', async () => {
    const root = path.join(tmpDir, 'deferred-seed-root');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const goodPath = path.join(convDir, 'good.db');
    const busyPath = path.join(convDir, 'busy.db');
    createConversationDb(goodPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'good-old' },
            timestampSec: 1_778_007_000,
          }),
        ],
      ],
    });
    // Simulate a transiently unreadable DB (invalid SQLite header) during initial fresh seed
    await fs.writeFile(busyPath, 'not-a-valid-sqlite-file-yet');

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const batch1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => batch1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(batch1).toHaveLength(0);

    // Now busy.db becomes readable with pre-existing historical rows, AND a brand-new DB is created
    await fs.unlink(busyPath);
    createConversationDb(busyPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 999, totalOutputTokens: 88, visibleOutputTokens: 88, responseId: 'busy-historical' },
            timestampSec: 1_778_007_001,
          }),
        ],
      ],
    });
    createConversationDb(path.join(convDir, 'brand-new.db'), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 50, totalOutputTokens: 10, visibleOutputTokens: 10, responseId: 'brand-new-1' },
            timestampSec: 1_778_007_010,
          }),
        ],
      ],
    });

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const batch2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => batch2.push(...entries));
    await input2.start();
    await input2.stop();

    // busy.db's historical event is seeded (NOT replayed), while brand-new.db IS collected
    const resps2 = batch2.filter((e) => e['event.name'] === 'llm.response');
    expect(resps2.map((e) => e['gen_ai.response.id'])).toEqual(['brand-new-1']);

    // Subsequent new row on busy.db IS collected
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(busyPath);
    try {
      const blob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 70, totalOutputTokens: 15, visibleOutputTokens: 15, responseId: 'busy-after-seed' },
        timestampSec: 1_778_007_020,
      });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, blob, blob.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(busyPath, future, future);

    const input3 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const batch3: AgentActivityEntry[] = [];
    input3.on('entries', (entries: AgentActivityEntry[]) => batch3.push(...entries));
    await input3.start();
    await input3.stop();
    expect(batch3.filter((e) => e['event.name'] === 'llm.response').map((e) => e['gen_ai.response.id'])).toEqual([
      'busy-after-seed',
    ]);
  });

  it('waits on RUNNING tool steps and retires cancelled pending tool calls when conversation advances', async () => {
    const root = path.join(tmpDir, 'pending-status-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'pending-status-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_008_000;
    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'ps-1' },
            timestampSec: baseSec,
            stepIndices: [1],
          }),
        ],
      ],
    });

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Run two tools' }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(baseSec * 1000).toISOString(),
          tool_calls: [
            { id: 'tc-running', name: 'run_command', args: { CommandLine: 'echo hi' } },
            { id: 'tc-cancelled', name: 'write_file', args: { Path: '/tmp/x' } },
          ],
        }),
        // step 2 is still RUNNING -> must NOT emit tool.result yet!
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: new Date((baseSec + 1) * 1000).toISOString(), content: 'partial...' }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();

    expect(c1.filter((e) => e['event.name'] === 'tool.call')).toHaveLength(2);
    expect(c1.filter((e) => e['event.name'] === 'tool.result')).toHaveLength(0);

    // Cycle 2: step 2 finishes (DONE); step 3 (tc-cancelled) was never written and user sends new USER_INPUT at step 4
    await fs.appendFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((baseSec + 4) * 1000).toISOString(), content: 'final output' }),
        JSON.stringify({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec + 5) * 1000).toISOString(), content: 'Next turn' }),
      ].join('\n') + '\n',
    );

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    const results2 = c2.filter((e) => e['event.name'] === 'tool.result');
    expect(results2).toHaveLength(1);
    expect(results2[0]?.['gen_ai.tool.call.id']).toBe('tc-running');
    expect(results2[0]?.['gen_ai.tool.call.result']).toBe('final output');

    // Cancelled tool call must have been retired from checkpoint pendingToolCalls
    const cp = stateStore.get(ClientType.Antigravity)?.extra?.antigravityCheckpoint as {
      sessions: Record<string, { pendingToolCalls: unknown[] }>;
    };
    expect(cp.sessions[sid]?.pendingToolCalls).toEqual([]);
  });

  it('preserves turn grouping when two turns share the exact same millisecond timestamp', async () => {
    const root = path.join(tmpDir, 'same-ms-turns-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'same-ms-turns';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const tsSec = 1_778_009_000;
    const iso = new Date(tsSec * 1000).toISOString();
    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 't1-r' },
            timestampSec: tsSec,
            stepIndices: [1],
          }),
        ],
        [
          1,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 120, totalOutputTokens: 25, visibleOutputTokens: 25, responseId: 't2-r' },
            timestampSec: tsSec,
            stepIndices: [3],
          }),
        ],
      ],
    });
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso, content: 'Turn 1' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, content: 'Reply 1' }),
        JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso, content: 'Turn 2' }),
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, content: 'Reply 2' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    expect(collected.map((e) => `${e['gen_ai.turn.id']}:${e['event.name']}`)).toEqual([
      `${sid}:turn:1:other`,
      `${sid}:turn:1:llm.request`,
      `${sid}:turn:1:llm.response`,
      `${sid}:turn:2:other`,
      `${sid}:turn:2:llm.request`,
      `${sid}:turn:2:llm.response`,
    ]);
  });

  it('drains >16 DB backlog cleanly via delayed backlogTimer and does not spin when all DBs fail', async () => {
    const root = path.join(tmpDir, 'backlog-root');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    for (let i = 0; i < 20; i++) {
      createConversationDb(path.join(convDir, `sess-${String(i).padStart(2, '0')}.db`), {
        genRows: [
          [
            0,
            encodeGeneratorMetadata({
              model: 'Gemini 3.8 Flash (High)',
              usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: `b-${i}` },
              timestampSec: 1_778_010_000 + i,
            }),
          ],
        ],
      });
    }

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
      pollIntervalMs: 60_000, // Long poll interval proves backlogTimer drained the remaining 4 DBs
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await new Promise((r) => setTimeout(r, 250));
    await input.stop();

    const resps = collected.filter((e) => e['event.name'] === 'llm.response');
    expect(resps).toHaveLength(20);

    // Now verify Top-16 persistently failing DBs enter backoff and do NOT starve healthy #17..20 DBs or spin
    const failRoot = path.join(tmpDir, 'backlog-fail-root');
    const failConvDir = path.join(failRoot, 'conversations');
    await fs.mkdir(failConvDir, { recursive: true });
    // Create 4 older healthy DBs FIRST (lower mtime -> behind Top-16)
    const olderDate = new Date(Date.now() - 10_000);
    for (let i = 0; i < 4; i++) {
      const p = path.join(failConvDir, `healthy-${i}.db`);
      createConversationDb(p, {
        genRows: [
          [
            0,
            encodeGeneratorMetadata({
              model: 'Gemini 3.8 Flash (High)',
              usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: `h-${i}` },
              timestampSec: 1_778_010_500 + i,
            }),
          ],
        ],
      });
      await fs.utimes(p, olderDate, olderDate);
    }
    // Create 16 newer corrupt DBs (higher mtime -> occupy Top-16 in Cycle 1)
    for (let i = 0; i < 16; i++) {
      await fs.writeFile(path.join(failConvDir, `bad-${String(i).padStart(2, '0')}.db`), 'corrupt-sqlite');
    }
    const failStore = new StateStore(path.join(tmpDir, 'fail-state.json'));
    await failStore.load();
    const failInput = new AntigravityInput({
      stateStore: failStore,
      clientType: ClientType.AntigravityCli,
      dataRoot: failRoot,
      collectHistorical: true,
      pollIntervalMs: 60_000,
    });
    const healthyCollected: AgentActivityEntry[] = [];
    let runtimeDeltas = 0;
    failInput.on('entries', (entries: AgentActivityEntry[]) => healthyCollected.push(...entries));
    failInput.on('input-runtime-delta', () => { runtimeDeltas++; });
    await failInput.start();
    await new Promise((r) => setTimeout(r, 250));
    await failInput.stop();
    // Cycle 1 backs off the 16 bad DBs; Cycle 2 drains all 4 healthy #17..20 DBs and STOPS (no spin!)
    expect(healthyCollected.filter((e) => e['event.name'] === 'llm.response')).toHaveLength(4);
    expect(runtimeDeltas).toBe(2);
  });

  it('evicts sessions past 512 cap with a watermark so evicted old sessions are never replayed', async () => {
    const root = path.join(tmpDir, 'eviction-root');
    const convDir = path.join(root, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    // Pre-populate StateStore with 512 tracked sessions at mtime 2_000_000..2_000_511
    // plus one brand-new DB at mtime 2_001_000 AND one older evicted DB at mtime 1_000_000
    const sessions: Record<string, unknown> = {};
    for (let i = 0; i < 512; i++) {
      sessions[`hist-${i}`] = {
        effectiveMtimeMs: 2_000_000 + i,
        effectiveSize: 100,
        maxEmittedGenIdx: 0,
        maxEmittedStepIdx: -1,
        emittedUsageKeys: [`response:h-${i}`],
        lastTranscriptStepIndex: -1,
        pendingToolCalls: [],
      };
    }
    stateStore.set(ClientType.Antigravity, {
      lastTimestamp: Date.now(),
      extra: {
        antigravityCheckpoint: {
          schema: 1,
          seeded: true,
          evictedWatermarkMtimeMs: 0,
          sessions,
        },
      },
    });

    // Place the oldest tracked session (`hist-0`) on disk with its exact old mtime (2_000_000)
    // and add a new session (`newest`) so saving 513 sessions evicts `hist-0` and sets watermark=2_000_000.
    const oldestDb = path.join(convDir, 'hist-0.db');
    createConversationDb(oldestDb, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: 'h-0' },
            timestampSec: 1_778_011_000,
          }),
        ],
      ],
    });
    const oldDate = new Date(2_000_000);
    await fs.utimes(oldestDb, oldDate, oldDate);
    // Keep hist-0's size matching the pre-populated checkpoint so cycle 1 skips it and evicts it
    const oldStat = await fs.stat(oldestDb);
    (sessions['hist-0'] as { effectiveSize: number }).effectiveSize = oldStat.size;

    const newestDb = path.join(convDir, 'newest.db');
    createConversationDb(newestDb, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 20, totalOutputTokens: 8, visibleOutputTokens: 8, responseId: 'newest-r1' },
            timestampSec: 1_778_011_100,
          }),
        ],
      ],
    });

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.filter((e) => e['event.name'] === 'llm.response').map((e) => e['gen_ai.response.id'])).toEqual([
      'newest-r1',
    ]);

    // Verify hist-0 was evicted and evictedWatermarkMtimeMs recorded
    const cp = stateStore.get(ClientType.Antigravity)?.extra?.antigravityCheckpoint as {
      evictedWatermarkMtimeMs: number;
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(cp.sessions)).toHaveLength(512);
    expect(cp.sessions['hist-0']).toBeUndefined();
    expect(cp.evictedWatermarkMtimeMs).toBeGreaterThanOrEqual(2_000_000);

    // Cycle 2 must NOT replay evicted hist-0.db
    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: false,
    });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();
    expect(c2).toHaveLength(0);
  });

  it('converts image and video media via real MultimodalProcessor with symlinked dataRoot and rejects paths outside allowedRootPaths', async () => {
    const realRoot = path.join(tmpDir, 'real-mm-root');
    const symlinkRoot = path.join(tmpDir, 'symlink-mm-root');
    const outsideDir = path.join(tmpDir, 'outside-secret');
    const convDir = path.join(realRoot, 'conversations');
    const sid = 'real-mm-sess';
    const brainSessionDir = path.join(realRoot, 'brain', sid);
    const logsDir = path.join(brainSessionDir, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(realRoot, symlinkRoot);

    // Minimal valid PNG header + minimal valid MP4 ftyp header
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const mp4Bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // "isom"
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    ]);
    const inImg = path.join(brainSessionDir, 'input.png');
    const symlinkMediaImg = path.join(brainSessionDir, 'symlinked-media.png');
    const toolVid = path.join(brainSessionDir, 'tool-clip.mp4');
    const outImg = path.join(brainSessionDir, 'output.png');
    const outsideImg = path.join(outsideDir, 'blocked.png');
    await fs.writeFile(inImg, pngBytes);
    await fs.writeFile(toolVid, mp4Bytes);
    await fs.writeFile(outImg, pngBytes);
    await fs.writeFile(outsideImg, pngBytes);
    await fs.symlink(inImg, symlinkMediaImg);

    const tsSec = 1_778_012_000;
    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 4 Neon (Medium)',
            usage: { inputTokens: 100, totalOutputTokens: 40, visibleOutputTokens: 40, responseId: 'rmm-1' },
            timestampSec: tsSec,
            stepIndices: [1, 2],
          }),
        ],
      ],
    });

    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date((tsSec - 1) * 1000).toISOString(),
          content: 'Check these',
          media: [
            { mime_type: 'image/png', uri: inImg },
            { mime_type: 'image/png', uri: symlinkMediaImg },
            { mime_type: 'image/png', uri: outsideImg },
          ],
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(tsSec * 1000).toISOString(),
          content: 'Rendered',
          media: [{ mime_type: 'image/png', uri: outImg }],
          tool_calls: [{ id: 'tc-vid', name: 'browser', args: {} }],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date((tsSec + 2) * 1000).toISOString(),
          content: 'Captured video',
          media: [{ mime_type: 'video/mp4', uri: toolVid }],
        }),
      ].join('\n') + '\n',
    );

    const uploaded: string[] = [];
    const processor = new MultimodalProcessor('oss://test-bucket/mm', {
      upload: async (item) => {
        uploaded.push(`${item.contentType}:${item.targetPath}`);
        return true;
      },
      shutdown: async () => {},
    });

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: symlinkRoot,
      collectHistorical: true,
      multimodal: {
        enabled: true,
        uploadMode: 'all',
        processor,
      },
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();
    await processor.shutdown();

    const userEv = collected.find((e) => e['event.name'] === 'other');
    expect(userEv?.['gen_ai.input.multimodal_metadata']).toHaveLength(1);
    expect(userEv?.['gen_ai.input.multimodal_metadata']?.[0]).toMatchObject({
      mime_type: 'image/png',
      modality: 'image',
    });

    const respEv = collected.find((e) => e['event.name'] === 'llm.response');
    expect(respEv?.['gen_ai.output.multimodal_metadata']).toHaveLength(1);
    expect(respEv?.['gen_ai.output.multimodal_metadata']?.[0]).toMatchObject({
      mime_type: 'image/png',
      modality: 'image',
    });

    const toolResEv = collected.find((e) => e['event.name'] === 'tool.result');
    expect(toolResEv?.['gen_ai.input.multimodal_metadata']).toHaveLength(1);
    expect(toolResEv?.['gen_ai.input.multimodal_metadata']?.[0]).toMatchObject({
      mime_type: 'video/mp4',
      modality: 'video',
    });
    expect(uploaded.some((u) => u.startsWith('image/png:'))).toBe(true);
    expect(uploaded.some((u) => u.startsWith('video/mp4:'))).toBe(true);
  });

  it('gracefully no-ops and warns only once across cycles when node:sqlite is unavailable', async () => {
    const root = path.join(tmpDir, 'no-sqlite-root');
    await fs.mkdir(path.join(root, 'conversations'), { recursive: true });
    sqliteMockState.unavailable = true;
    try {
      const input = new AntigravityInput({
        stateStore,
        clientType: ClientType.Antigravity,
        dataRoot: root,
        collectHistorical: true,
        pollIntervalMs: 30,
      });
      const warnSpy = vi.spyOn(
        (input as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      );
      const collected: AgentActivityEntry[] = [];
      let cycles = 0;
      input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
      input.on('input-runtime-delta', () => { cycles++; });
      await input.start();
      await new Promise((r) => setTimeout(r, 90));
      await input.stop();
      expect(collected).toHaveLength(0);
      expect(cycles).toBeGreaterThanOrEqual(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      sqliteMockState.unavailable = false;
    }
  });

  it('disambiguates retry/multi-usage llmSpanId, responseId, and event.id and guarantees strictly non-zero LLM span duration', async () => {
    const root = path.join(tmpDir, 'retry-span-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'retry-span-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_013_000;
    // Simulate:
    // 1) step 1 has stale steps.metadata completedAtMs === createdAtMs (reproducing live af6f2338 step 515!)
    //    while gen_metadata has real completion timestamp +10s AND a retry usage without messageId!
    const step1Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec)),
      protoBytesField(8, protoTimestamp(baseSec)), // stale completedAtMs === createdAtMs
    );
    const retryUsage = encodeModelUsage({ inputTokens: 80, totalOutputTokens: 15, visibleOutputTokens: 15 });
    const mainUsage = encodeModelUsage({ inputTokens: 100, totalOutputTokens: 40, visibleOutputTokens: 40 });
    const gen0Blob = concatBytes(
      protoBytesField(
        1,
        concatBytes(
          protoBytesField(4, mainUsage),
          protoBytesField(9, protoBytesField(4, protoTimestamp(baseSec + 10))),
          protoBytesField(11, protoDuration(5, 0)),
          protoBytesField(12, protoDuration(5, 0)),
          protoBytesField(17, protoBytesField(2, retryUsage)),
          protoStringField(19, 'Gemini 4 Neon (Medium)'),
        ),
      ),
      protoVarintField(2, 1),
    );
    createConversationDb(path.join(convDir, `${sid}.db`), {
      stepRows: [[1, step1Meta]],
      genRows: [[0, gen0Blob]],
    });
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Hello' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), content: 'World' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    const reqs = collected.filter((e) => e['event.name'] === 'llm.request');
    const resps = collected.filter((e) => e['event.name'] === 'llm.response');
    expect(reqs).toHaveLength(2);
    expect(resps).toHaveLength(2);

    // Every event.id across all entries must be unique
    const eventIds = collected.map((e) => e['event.id']);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    // The 2 LLM calls on step 1 must have distinct span_id and response.id
    expect(new Set(resps.map((e) => e.span_id)).size).toBe(2);
    expect(new Set(resps.map((e) => e['gen_ai.response.id'])).size).toBe(2);
    // Every (llm.request, llm.response) pair must have strictly positive duration (resp > req)
    for (const resp of resps) {
      const req = reqs.find((r) => r['gen_ai.response.id'] === resp['gen_ai.response.id'])!;
      expect(BigInt(resp.time_unix_nano) > BigInt(req.time_unix_nano)).toBe(true);
    }
    // Primary usage recovered real 10s completion time from gen_metadata despite stale steps.completedAtMs
    const primaryResp = resps.find((r) => r['gen_ai.usage.output_tokens'] === 40)!;
    const primaryReq = reqs.find((r) => r['gen_ai.response.id'] === primaryResp['gen_ai.response.id'])!;
    expect(BigInt(primaryResp.time_unix_nano) - BigInt(primaryReq.time_unix_nano)).toBe(10_000_000_000n);
  });

  it('unifies Loop 2/3 turnId, latches turnId across delayed native UUIDs, emits single turn.start, and handles mid-session SYSTEM_MESSAGE turns', async () => {
    const root = path.join(tmpDir, 'turn-latch-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'turn-latch-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_014_000;
    const dbPath = path.join(convDir, `${sid}.db`);
    const turn1Uuid = '11111111-1111-1111-1111-111111111111';
    const turn2Uuid = '22222222-2222-2222-2222-222222222222';

    // Cycle 1: step 0 SYSTEM_MESSAGE + step 1 USER_INPUT + step 2 PLANNER_RESPONSE (no native turnId on step 2, ONLY on step 3 tool result!)
    createConversationDb(dbPath, {
      stepRows: [
        [3, concatBytes(protoBytesField(1, protoTimestamp(baseSec + 2)), protoStringField(12, turn1Uuid))],
      ],
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'tl-1' },
            timestampSec: baseSec + 1,
            stepIndices: [2, 3],
          }),
        ],
      ],
    });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: new Date((baseSec - 2) * 1000).toISOString(), content: 'System boot' }),
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'User ask' }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), tool_calls: [{ id: 'c1', name: 'read_file', args: {} }] }),
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((baseSec + 2) * 1000).toISOString(), content: 'file ok' }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();

    // All Turn 1 events (other, llm.request, llm.response, tool.call, tool.result) share turn1Uuid!
    expect(c1.every((e) => e['gen_ai.turn.id'] === `${sid}:${turn1Uuid}`)).toBe(true);
    // Single gen_ai.turn.start=true even though step 0 SYSTEM_MESSAGE and step 1 USER_INPUT both emitted
    const starts1 = c1.filter((e) => e['gen_ai.turn.start'] === true);
    expect(starts1).toHaveLength(1);

    // Cycle 2: mid-session SYSTEM_MESSAGE (step 4) with a NEW native turn UUID (turn2Uuid) wakes up the agent
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const s4Meta = concatBytes(protoBytesField(1, protoTimestamp(baseSec + 10)), protoStringField(12, turn2Uuid));
      const s5Meta = concatBytes(protoBytesField(1, protoTimestamp(baseSec + 11)), protoBytesField(8, protoTimestamp(baseSec + 13)), protoStringField(12, turn2Uuid));
      const g1Blob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 150, totalOutputTokens: 40, visibleOutputTokens: 40, responseId: 'tl-2' },
        timestampSec: baseSec + 13,
        stepIndices: [5],
      });
      db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(4, s4Meta);
      db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(5, s5Meta);
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, g1Blob, g1Blob.length);
    } finally {
      db.close();
    }
    await fs.appendFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: new Date((baseSec + 10) * 1000).toISOString(), content: 'Background task finished' }),
        JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date((baseSec + 11) * 1000).toISOString(), content: 'Acknowledged' }),
      ].join('\n') + '\n',
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input2 = new AntigravityInput({
      stateStore,
      clientType: ClientType.Antigravity,
      dataRoot: root,
      collectHistorical: true,
    });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    expect(c2.map((e) => e['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
    expect(c2.every((e) => e['gen_ai.turn.id'] === `${sid}:${turn2Uuid}`)).toBe(true);
    expect(c2[0]?.['gen_ai.turn.start']).toBe(true);
    expect(c2[1]?.['gen_ai.input.messages_delta']).toContainEqual({
      role: 'system',
      parts: [{ type: 'text', content: 'Background task finished' }],
    });
  });

  it('does not drop an out-of-order lower genIdx row that gains tokens after a higher genIdx already emitted', async () => {
    const root = path.join(tmpDir, 'ooo-zero-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'ooo-sess';
    await fs.mkdir(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${sid}.db`);

    // Cycle 1: genIdx=1 is 0-token placeholder, genIdx=2 already has tokens!
    createConversationDb(dbPath, {
      genRows: [
        [1, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 0, totalOutputTokens: 0 }, timestampSec: 1_778_015_001 })],
        [2, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 200, totalOutputTokens: 50, visibleOutputTokens: 50, responseId: 'ooo-2' }, timestampSec: 1_778_015_002 })],
      ],
    });

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.filter((e) => e['event.name'] === 'llm.response').map((e) => e['gen_ai.response.id'])).toEqual(['ooo-2']);

    // Cycle 2: genIdx=1 now receives tokens -> must NOT be dropped!
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const filled1 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 150, totalOutputTokens: 40, visibleOutputTokens: 40, responseId: 'ooo-1-late' },
        timestampSec: 1_778_015_003,
      });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(filled1, filled1.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();
    expect(c2.filter((e) => e['event.name'] === 'llm.response').map((e) => e['gen_ai.response.id'])).toEqual(['ooo-1-late']);
  });

  it('defers Loop 3 on streaming PLANNER_RESPONSE, emits completed background RUNNING tools, sets error.type, and latches toolCallId across cycles', async () => {
    const root = path.join(tmpDir, 'stream-gate-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'stream-gate-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_016_000;
    const dbPath = path.join(convDir, `${sid}.db`);
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    // Cycle 1: step 1 PLANNER_RESPONSE is still RUNNING without tool_calls -> Loop 3 must NOT prematurely emit ['stop']!
    createConversationDb(dbPath, {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'sg-1' },
            timestampSec: baseSec + 1,
            stepIndices: [1],
          }),
        ],
      ],
    });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Run cmd' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: new Date(baseSec * 1000).toISOString() }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.map((e) => e['event.name'])).toEqual(['other']);

    // Cycle 2: step 1 finishes (DONE) with 2 tool_calls (no tc.id yet, no steps.metadata row yet -> fallback callIds latched).
    // Step 2 is ERROR (must attach error.type), step 3 is not written yet (pending).
    await fs.appendFile(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(baseSec * 1000).toISOString(),
          tool_calls: [
            { name: 'read_file', args: { Path: '/missing' } },
            { name: 'run_command', args: { CommandLine: 'bg-task' } },
          ],
        }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: new Date((baseSec + 2) * 1000).toISOString(), content: 'ENOENT' }),
      ].join('\n') + '\n',
    );

    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    const resp2 = c2.find((e) => e['event.name'] === 'llm.response')!;
    expect(resp2['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    const errToolResult = c2.find((e) => e['event.name'] === 'tool.result')!;
    // buildAgentActivityEntry normalizes 'error' -> 'failure' and keeps error.type
    expect(errToolResult['tool.result.status']).toBe('failure');
    expect(errToolResult['error.type']).toBe('antigravity.tool_failed');
    const pendingCallId = c2.filter((e) => e['event.name'] === 'tool.call')[1]!['gen_ai.tool.call.id'];
    expect(pendingCallId).toBe(`${sid}:step:1:tc:1`);

    // Cycle 3: step 3 lands with transcript status='RUNNING' (backgrounded run_command!) BUT SQLite has
    // completedAtMs AND a late native toolCallId; step 4 is a CHECKPOINT compaction call (must be skipped
    // from ordinary llm.request/llm.response); step 5 is the next PLANNER_RESPONSE!
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const s3Meta = concatBytes(
        protoBytesField(1, protoTimestamp(baseSec + 2)),
        protoBytesField(4, concatBytes(protoStringField(1, 'call_late_native_id'), protoStringField(2, 'run_command'))),
        protoBytesField(8, protoTimestamp(baseSec + 12)),
        protoBytesField(32, protoTimestamp(baseSec + 2)),
      );
      const s4Usage = encodeModelUsage({ inputTokens: 500, totalOutputTokens: 120, visibleOutputTokens: 120, responseId: 'ckpt-1' });
      const s4Meta = concatBytes(
        protoBytesField(1, protoTimestamp(baseSec + 13)),
        protoBytesField(8, protoTimestamp(baseSec + 15)),
        protoBytesField(9, s4Usage),
      );
      const g1Blob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 200, totalOutputTokens: 50, visibleOutputTokens: 50, responseId: 'sg-2' },
        timestampSec: baseSec + 18,
        stepIndices: [5],
      });
      db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(3, s3Meta);
      db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(4, s4Meta);
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, g1Blob, g1Blob.length);
    } finally {
      db.close();
    }
    await fs.appendFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: new Date((baseSec + 2) * 1000).toISOString(), content: 'background output' }),
        JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: new Date((baseSec + 13) * 1000).toISOString(), content: 'Compacted summary text' }),
        JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date((baseSec + 16) * 1000).toISOString(), content: 'All done' }),
      ].join('\n') + '\n',
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input3 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c3: AgentActivityEntry[] = [];
    input3.on('entries', (entries: AgentActivityEntry[]) => c3.push(...entries));
    await input3.start();
    await input3.stop();

    // Background RUNNING tool with SQLite completedAtMs IS emitted with latched callId (no drift!)
    const bgToolResult = c3.find((e) => e['event.name'] === 'tool.result')!;
    expect(bgToolResult).toBeDefined();
    expect(bgToolResult['gen_ai.tool.call.id']).toBe(pendingCallId);
    expect(bgToolResult['gen_ai.tool.call.duration']).toBeGreaterThan(0);

    // CHECKPOINT compaction step (ckpt-1) is skipped from llm.request/llm.response;
    // only step 5 PLANNER_RESPONSE (sg-2) is emitted and preserves latched callId in messages_delta!
    const llmReqs3 = c3.filter((e) => e['event.name'] === 'llm.request');
    const llmResps3 = c3.filter((e) => e['event.name'] === 'llm.response');
    expect(llmReqs3.map((e) => e['gen_ai.response.id'])).toEqual(['sg-2']);
    expect(llmResps3.map((e) => e['gen_ai.response.id'])).toEqual(['sg-2']);
    const deltaJson = JSON.stringify(llmReqs3[0]!['gen_ai.input.messages_delta']);
    expect(deltaJson).toContain(pendingCallId);
    expect(deltaJson).not.toContain('call_late_native_id');
  });

  it('orders same-millisecond multi-step events within one turn by step index without interleaving', async () => {
    const root = path.join(tmpDir, 'same-ms-steps-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'same-ms-steps';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const tsSec = 1_778_017_000;
    const iso = new Date(tsSec * 1000).toISOString();
    createConversationDb(path.join(convDir, `${sid}.db`), {
      genRows: [
        [0, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 's1' }, timestampSec: tsSec, stepIndices: [1] })],
        [1, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 120, totalOutputTokens: 25, visibleOutputTokens: 25, responseId: 's2' }, timestampSec: tsSec, stepIndices: [3] })],
      ],
    });
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso, content: 'One turn, two steps' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, tool_calls: [{ id: 'tc1', name: 'read_file', args: {} }] }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso, content: 'ok' }),
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, content: 'Final' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    expect(collected.map((e) => `${e['gen_ai.step.id']?.split(':').slice(-2).join(':')}:${e['event.name']}`)).toEqual([
      'step:0:other',
      'step:1:llm.request',
      'step:1:llm.response',
      'step:1:tool.call',
      'step:1:tool.result',
      'step:3:llm.request',
      'step:3:llm.response',
    ]);
    // Every LLM span must have >= 1ms duration so readNanoMs (div 1_000_000n) never truncates to 0ms
    const reqs = collected.filter((e) => e['event.name'] === 'llm.request');
    const resps = collected.filter((e) => e['event.name'] === 'llm.response');
    for (const resp of resps) {
      const req = reqs.find((r) => r['gen_ai.response.id'] === resp['gen_ai.response.id'])!;
      expect(BigInt(resp.time_unix_nano) - BigInt(req.time_unix_nano)).toBeGreaterThanOrEqual(1_000_000n);
    }
  });

  it('keeps Loop 2 and Loop 3 symmetric when SQLite completedAtMs lands before RUNNING PLANNER_RESPONSE flushes tool_calls', async () => {
    const root = path.join(tmpDir, 'sym-gate-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'sym-gate-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_018_000;
    const dbPath = path.join(convDir, `${sid}.db`);
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    // Cycle 1: SQLite ALREADY has completedAtMs on step 1, while transcript still shows
    // RUNNING with partial text content and NO tool_calls yet -> BOTH Loop 2 and Loop 3 must defer!
    const step1Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec)),
      protoBytesField(8, protoTimestamp(baseSec + 2)),
    );
    createConversationDb(dbPath, {
      stepRows: [[1, step1Meta]],
      genRows: [
        [0, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 100, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'sym-1' }, timestampSec: baseSec + 2, stepIndices: [1] })],
      ],
    });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Inspect repo' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: new Date(baseSec * 1000).toISOString(), content: 'Let me check...' }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.map((e) => e['event.name'])).toEqual(['other']);

    // Cycle 2: step 1 finishes DONE with tool_calls -> BOTH tool.call and llm.response ['tool_call'] emit!
    await fs.appendFile(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(baseSec * 1000).toISOString(),
          content: 'Let me check...',
          tool_calls: [{ id: 'tc-sym', name: 'read_file', args: { Path: 'a.ts' } }],
        }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((baseSec + 3) * 1000).toISOString(), content: 'ok' }),
      ].join('\n') + '\n',
    );

    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    expect(c2.map((e) => e['event.name'])).toEqual(['llm.request', 'llm.response', 'tool.call', 'tool.result']);
    expect(c2[1]?.['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(c2[2]?.['gen_ai.tool.call.id']).toBe('tc-sym');
  });

  it('preserves early Turn 2 native UUID when Turn 2 SQLite usage arrives before transcript USER_INPUT', async () => {
    const root = path.join(tmpDir, 'early-turn2-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'early-t2-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_019_000;
    const t1Uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const t2Uuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    createConversationDb(path.join(convDir, `${sid}.db`), {
      stepRows: [
        [0, concatBytes(protoBytesField(1, protoTimestamp(baseSec)), protoStringField(12, t1Uuid))],
        [1, concatBytes(protoBytesField(1, protoTimestamp(baseSec + 1)), protoBytesField(8, protoTimestamp(baseSec + 2)), protoStringField(12, t1Uuid))],
        [3, concatBytes(protoBytesField(1, protoTimestamp(baseSec + 10)), protoBytesField(8, protoTimestamp(baseSec + 12)), protoStringField(12, t2Uuid))],
      ],
      genRows: [
        [0, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'et-1' }, timestampSec: baseSec + 2, stepIndices: [1] })],
        [1, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 120, totalOutputTokens: 25, visibleOutputTokens: 25, responseId: 'et-2' }, timestampSec: baseSec + 12, stepIndices: [3] })],
      ],
    });
    // Transcript only has Turn 1 so far; Turn 2 USER_INPUT (step 2) hasn't flushed yet
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), content: 'Turn 1' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date((baseSec + 1) * 1000).toISOString(), content: 'Reply 1' }),
      ].join('\n') + '\n',
    );

    const input = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const collected: AgentActivityEntry[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => collected.push(...entries));
    await input.start();
    await input.stop();

    const resp1 = collected.find((e) => e['gen_ai.response.id'] === 'et-1' && e['event.name'] === 'llm.response')!;
    const resp2 = collected.find((e) => e['gen_ai.response.id'] === 'et-2' && e['event.name'] === 'llm.response')!;
    expect(resp1['gen_ai.turn.id']).toBe(`${sid}:${t1Uuid}`);
    // Turn 2 usage must keep its own native Turn UUID (NOT folded into Turn 1!)
    expect(resp2['gen_ai.turn.id']).toBe(`${sid}:${t2Uuid}`);
  });

  it('keeps PendingToolCall alive when intermediate CHECKPOINT lands before tool result, and skips compaction in turnProviderMap', async () => {
    const root = path.join(tmpDir, 'pending-ckpt-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'pending-ckpt-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_020_000;
    const dbPath = path.join(convDir, `${sid}.db`);
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    // Cycle 1: PLANNER_RESPONSE emits tool.call; result not written yet -> pending
    createConversationDb(dbPath, {
      genRows: [
        [0, encodeGeneratorMetadata({ model: 'Claude Opus 5.5', modelId: 1402, usage: { inputTokens: 100, totalOutputTokens: 30, visibleOutputTokens: 30, responseId: 'pc-1' }, timestampSec: baseSec + 1, stepIndices: [1] })],
      ],
    });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Do work' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), tool_calls: [{ id: 'tc-pc', name: 'run_command', args: { CommandLine: 'ls' } }] }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.find((e) => e['event.name'] === 'tool.call')).toBeDefined();
    expect(c1.find((e) => e['event.name'] === 'tool.result')).toBeUndefined();

    // Cycle 2: Antigravity inserts a CHECKPOINT into step 2 before the tool result lands -> pending must NOT be retired!
    await fs.appendFile(
      transcriptPath,
      JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: new Date((baseSec + 2) * 1000).toISOString(), content: 'Checkpoint' }) + '\n',
    );
    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();
    expect(c2).toHaveLength(0);

    // Cycle 3: Real tool result lands at step 3 -> drained cleanly!
    await fs.appendFile(
      transcriptPath,
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: new Date((baseSec + 5) * 1000).toISOString(), content: 'tool done' }) + '\n',
    );
    const input3 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c3: AgentActivityEntry[] = [];
    input3.on('entries', (entries: AgentActivityEntry[]) => c3.push(...entries));
    await input3.start();
    await input3.stop();

    const tr = c3.find((e) => e['event.name'] === 'tool.result');
    expect(tr).toBeDefined();
    expect(tr?.['gen_ai.tool.call.id']).toBe('tc-pc');
    expect(tr?.['gen_ai.tool.call.result']).toBe('tool done');
  });

  it('survives >512-key eviction for deferred 0-token rows and prevents cross-table steps->gen_metadata replay after eviction', async () => {
    const root = path.join(tmpDir, 'evict-cross-table-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'evict-ct-sess';
    await fs.mkdir(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${sid}.db`);

    // Cycle 1:
    // - step 5 has steps-only usage (emitted first -> evicted when 520 genRows follow!)
    // - genIdx 1 is a 0-token placeholder row (tracked in deferredGenIdxs!)
    // - genIdx 2..521 are 520 token-bearing rows (causing 512-key eviction so maxEmittedGenIdx >= 8 and maxEmittedStepIdx = 5)
    const step5Usage = encodeModelUsage({ inputTokens: 50, totalOutputTokens: 10, visibleOutputTokens: 10 });
    const step5Meta = concatBytes(protoBytesField(1, protoTimestamp(1_778_021_000)), protoBytesField(9, step5Usage));
    const genRows: Array<[number, Uint8Array]> = [
      [1, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 0, totalOutputTokens: 0 }, timestampSec: 1_778_021_001 })],
    ];
    for (let i = 2; i <= 521; i++) {
      genRows.push([
        i,
        encodeGeneratorMetadata({
          model: 'Gemini 3.8 Flash (High)',
          usage: { inputTokens: 10, totalOutputTokens: 5, visibleOutputTokens: 5, responseId: `ev-${i}` },
          timestampSec: 1_778_021_000 + i,
        }),
      ]);
    }
    createConversationDb(dbPath, { stepRows: [[5, step5Meta]], genRows });

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.AntigravityCli, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    expect(c1.filter((e) => e['event.name'] === 'llm.response')).toHaveLength(521);

    // Cycle 2:
    // - genIdx 1 finally receives tokens -> MUST be emitted despite maxEmittedGenIdx > 1!
    // - genIdx 600 references already-evicted step 5 -> MUST NOT replay step 5 (maxEmittedStepIdx = 5)!
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const filled1 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 77, totalOutputTokens: 22, visibleOutputTokens: 22, responseId: 'late-zero-1' },
        timestampSec: 1_778_022_000,
      });
      const lateGenForStep5 = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 50, totalOutputTokens: 10, visibleOutputTokens: 10, responseId: 'late-step5-dup' },
        timestampSec: 1_778_022_001,
        stepIndices: [5],
      });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(filled1, filled1.length);
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(600, lateGenForStep5, lateGenForStep5.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.AntigravityCli, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    const resps2 = c2.filter((e) => e['event.name'] === 'llm.response');
    expect(resps2.map((e) => e['gen_ai.response.id'])).toEqual(['late-zero-1']);
  });

  it('tracks cross-cycle retries via persisted emittedPrimaryStepIdxs without reusing parent step bounds', async () => {
    const root = path.join(tmpDir, 'cross-cycle-retry-root');
    const convDir = path.join(root, 'conversations');
    const sid = 'cc-retry-sess';
    const logsDir = path.join(root, 'brain', sid, '.system_generated', 'logs');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const baseSec = 1_778_023_000;
    const dbPath = path.join(convDir, `${sid}.db`);
    const step1Meta = concatBytes(
      protoBytesField(1, protoTimestamp(baseSec)),
      protoBytesField(8, protoTimestamp(baseSec + 5)),
    );
    createConversationDb(dbPath, {
      stepRows: [[1, step1Meta]],
      genRows: [
        [0, encodeGeneratorMetadata({ model: 'Gemini 3.8 Flash (High)', usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'cc-main' }, timestampSec: baseSec + 5, stepIndices: [1] })],
      ],
    });
    await fs.writeFile(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date((baseSec - 1) * 1000).toISOString(), content: 'Hi' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseSec * 1000).toISOString(), content: 'Hello' }),
      ].join('\n') + '\n',
    );

    const input1 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c1: AgentActivityEntry[] = [];
    input1.on('entries', (entries: AgentActivityEntry[]) => c1.push(...entries));
    await input1.start();
    await input1.stop();
    const mainResp = c1.find((e) => e['event.name'] === 'llm.response')!;

    // Cycle 2: A retry row with a strong responseId arrives on the same step 1 at baseSec + 12 (duration 2s)
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    try {
      const retryBlob = encodeGeneratorMetadata({
        model: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 100, totalOutputTokens: 25, visibleOutputTokens: 25, responseId: 'cc-retry' },
        timestampSec: baseSec + 12,
        ttftSec: 1,
        streamSec: 1,
        stepIndices: [1],
      });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, retryBlob, retryBlob.length);
    } finally {
      db.close();
    }
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const input2 = new AntigravityInput({ stateStore, clientType: ClientType.Antigravity, dataRoot: root, collectHistorical: true });
    const c2: AgentActivityEntry[] = [];
    input2.on('entries', (entries: AgentActivityEntry[]) => c2.push(...entries));
    await input2.start();
    await input2.stop();

    const retryReq = c2.find((e) => e['event.name'] === 'llm.request')!;
    const retryResp = c2.find((e) => e['event.name'] === 'llm.response')!;
    expect(retryResp.span_id).not.toBe(mainResp.span_id);
    // Retry uses its own 2s window (baseSec+10..baseSec+12), NOT parent step's baseSec..baseSec+5!
    expect(BigInt(retryReq.time_unix_nano)).toBe(BigInt((baseSec + 10) * 1000) * 1_000_000n);
    expect(BigInt(retryResp.time_unix_nano)).toBe(BigInt((baseSec + 12) * 1000) * 1_000_000n);
  });
});
