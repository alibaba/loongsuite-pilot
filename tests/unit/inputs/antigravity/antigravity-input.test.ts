import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseSync } from '../../../../src/utils/node-sqlite.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { ClientType, MULTIMODAL_SUPPORTED_AGENT_IDS, type AgentActivityEntry } from '../../../../src/types/index.js';
import { resolveAgentSystem } from '../../../../src/normalization/agent-system-map.js';
import { WorkspacePolicy } from '../../../../src/core/workspace-policy.js';
import type { PathToUriFn } from '../../../../src/multimodal/index.js';
import {
  AntigravityInput,
  decodeProtoFields,
  extractWorkspacePathFromBlob,
  modelNameFromId,
  normalizeAntigravityModel,
  parseDurationNs,
  parseTimestampMs,
  readAntigravityConversationDb,
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

      const transcriptLines = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-05-06T00:01:39Z',
          content: 'Check repo status',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-05-06T00:01:40Z',
          model: 'gemini-4-neon-medium',
          thinking: 'Let me run git status.',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-05-06T00:01:42Z',
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
      // Pilot canonical schema: input_tokens includes cache_read + cache_creation
      expect(llmResp?.['gen_ai.usage.input_tokens']).toBe(3500);
      expect(llmResp?.['gen_ai.usage.cache_read.input_tokens']).toBe(2000);
      expect(llmResp?.['gen_ai.usage.cache_creation.input_tokens']).toBe(500);
      expect(llmResp?.['gen_ai.usage.output_tokens']).toBe(300);
      expect(llmResp?.['gen_ai.usage.total_tokens']).toBe(3800);
      expect(llmResp?.['gen_ai.response.time_to_first_token']).toBe(500_000_000);
      expect(llmResp?.['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);

      const toolCall = collected.find((e) => e['event.name'] === 'tool.call');
      const toolResult = collected.find((e) => e['event.name'] === 'tool.result');
      expect(toolCall?.['gen_ai.tool.name']).toBe('run_command');
      expect(toolResult?.['gen_ai.tool.name']).toBe('run_command');
      expect(toolResult?.['gen_ai.tool.call.id']).toBe(toolCall?.['gen_ai.tool.call.id']);
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

  it('respects WorkspacePolicy exclusions', async () => {
    const root = path.join(tmpDir, 'excluded-root');
    const convDir = path.join(root, 'conversations');
    const excludedWs = path.join(tmpDir, 'secret-repo');
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(excludedWs, { recursive: true });

    createConversationDb(path.join(convDir, 'secret.db'), {
      genRows: [
        [
          0,
          encodeGeneratorMetadata({
            model: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 100, totalOutputTokens: 20, visibleOutputTokens: 20, responseId: 'sec-1' },
            timestampSec: 1_778_000_500,
          }),
        ],
      ],
      trajectoryBlob: protoStringField(10, `file://${excludedWs}`),
    });

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

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-05-06T00:14:59Z', content: 'Run slow cmd' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-05-06T00:15:00Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 15' } }] }),
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
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-05-06T00:15:15Z', content: 'done' }) + '\n',
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
});
