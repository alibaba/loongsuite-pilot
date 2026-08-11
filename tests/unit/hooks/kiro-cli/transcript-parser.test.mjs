import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';

import { hasNodeSqlite } from '../../../../assets/hooks/kiro-cli/transcript-parser.mjs';

const PARSER = '../../../../assets/hooks/kiro-cli/transcript-parser.mjs';
const FIXTURE_CONV = new URL('./fixtures/round3_conv_raw.json', import.meta.url);

// node:sqlite 仅 Node ≥ 22.5 内置。Node 18/20 上无该 builtin，DB 相关用例 skip
// 而非 error（纯函数 parseConversationValue 不依赖 DB，始终跑）。
const DB_AVAILABLE = hasNodeSqlite();

// fixture 来源: researcher round3 调研报告同会话成对 fixture
// conversation_id f66fecc5-d8bb-4b26-ba93-c0575bf0fb4a，cwd /tmp/kiro_probe/work_r3
const CWD = '/tmp/kiro_probe/work_r3';
const CONV_ID = 'f66fecc5-d8bb-4b26-ba93-c0575bf0fb4a';

let TMP;
let DB_PATH;

function buildFixtureDb(convRawJson, cwd) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run(`CREATE TABLE conversations_v2 (
          key TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (key, conversation_id)
        )`);
        const now = Date.now();
        const stmt = db.prepare(
          `INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)`,
        );
        stmt.run(cwd, CONV_ID, JSON.stringify(convRawJson), now - 10000, now);
        stmt.finalize();
        db.close((cerr) => (cerr ? reject(cerr) : resolve()));
      });
    });
  });
}

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-transcript-test-'));
  DB_PATH = path.join(TMP, 'data.sqlite3');
  const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
  await buildFixtureDb(convRaw, CWD);
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('parseConversationValue (round3 fixture)', () => {
  test('history[] 为 STEP 主干，3 步（2 ToolUse + 1 Response）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);

    expect(parsed.conversationId).toBe(CONV_ID);
    expect(parsed.continuationId).toBe('c9eb7963-b0ab-4561-b75b-8f30ffbe8ff4');
    expect(parsed.modelId).toBe('auto');
    expect(parsed.steps.length).toBe(3);
    expect(parsed.credits.length).toBe(3);

    const kinds = parsed.steps.map((s) => s.kind);
    expect(kinds).toEqual(['ToolUse', 'ToolUse', 'NotToolUse']);
  });

  test('request_id ≠ message_id（各取各字段，不混用）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    for (const step of parsed.steps) {
      expect(step.stepId).not.toBe(step.responseId);
      expect(step.stepId.length).toBeGreaterThan(0);
      expect(step.responseId.length).toBeGreaterThan(0);
    }
    // hist2 实证值
    const last = parsed.steps[2];
    expect(last.stepId).toBe('153ca0d0-eedd-4573-ad43-e4b16d742d51');
    expect(last.responseId).toBe('5ca50dc2-6cbb-40f1-b934-52e803af2111');
  });

  test('STEP 切分无重叠：前一条 stream_end < 后一条 request_start', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    const steps = parsed.steps;
    expect(steps[0].endTimeMs).toBeLessThan(steps[1].startTimeMs);
    expect(steps[1].endTimeMs).toBeLessThan(steps[2].startTimeMs);
  });

  test('tool_use_id 提取正确（fs_read/fs_write）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    expect(parsed.steps[0].tools[0].name).toBe('fs_read');
    expect(parsed.steps[0].tools[0].id).toBe('tooluse_9ZXIR6XBjCnWiGGEZrHWGQ');
    expect(parsed.steps[1].tools[0].name).toBe('fs_write');
    expect(parsed.steps[1].tools[0].id).toBe('tooluse_MigrAULbTpGOiFQo4BFZ3d');
    expect(parsed.steps[2].tools.length).toBe(0);
  });

  test('最终回答步为真实 Response（非 derived）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    const last = parsed.steps[2];
    expect(last.kind).toBe('NotToolUse');
    expect(last.assistantText).toContain('hello kiro round3');
    expect(last.assistantText).toContain('round3-finished');
  });

  test('token 在 transcript 中恒 null（credit-only）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    const convValue = convRaw.history.map((h) => h.request_metadata);
    for (const rm of convValue) {
      expect(rm.total_tokens).toBeNull();
      expect(rm.output_tokens).toBeNull();
      expect(rm.uncached_input_tokens).toBeNull();
    }
    // credit 非 null
    expect(parsed.credits.every((c) => typeof c === 'number' && c > 0)).toBe(true);
  });

  test('首轮 step 提取用户原始 prompt（history[0].user.content.Prompt.prompt）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    const parsed = parseConversationValue(convRaw);
    // 仅首轮（Prompt 型）非空，后续两轮为 ToolUseResults 型 → ''
    expect(parsed.steps[0].userPrompt).toContain('sample.txt');
    expect(parsed.steps[1].userPrompt).toBe('');
    expect(parsed.steps[2].userPrompt).toBe('');
  });

  test('Prompt/prompt 大小写与嵌套兜底兼容', async () => {
    const { parseConversationValue } = await import(PARSER);
    // fixture 来源: 构造 history[0].user.content 用 lowercase prompt key 的等价结构
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    convRaw.history[0].user.content = { prompt: { prompt: '小写键兜底文本' } };
    const parsed = parseConversationValue(convRaw);
    expect(parsed.steps[0].userPrompt).toBe('小写键兜底文本');

    // content 直接为 string
    convRaw.history[0].user.content = '纯字符串 prompt';
    expect(parseConversationValue(convRaw).steps[0].userPrompt).toBe('纯字符串 prompt');

    // 缺 user 节点 → ''
    delete convRaw.history[0].user;
    expect(parseConversationValue(convRaw).steps[0].userPrompt).toBe('');
  });
});

describe.skipIf(!DB_AVAILABLE)('readTranscriptForCwd (sqlite, round3 fixture DB)', () => {
  test('按 cwd 命中会话，返回 steps + updatedMs', async () => {
    const { readTranscriptForCwd } = await import(PARSER);
    const t = await readTranscriptForCwd(CWD, { dbPath: DB_PATH });
    expect(t).not.toBeNull();
    expect(t.conversationId).toBe(CONV_ID);
    expect(t.steps.length).toBe(3);
    expect(t.updatedMs).toBeGreaterThan(0);
  });

  test('未命中 cwd 返回 null', async () => {
    const { readTranscriptForCwd } = await import(PARSER);
    const t = await readTranscriptForCwd('/no/such/cwd', { dbPath: DB_PATH });
    expect(t).toBeNull();
  });

  test('空 cwd 返回 null（不崩溃）', async () => {
    const { readTranscriptForCwd } = await import(PARSER);
    const t = await readTranscriptForCwd('', { dbPath: DB_PATH });
    expect(t).toBeNull();
  });

  test('sinceUpdatedMs 增量：过滤掉旧行', async () => {
    const { readTranscriptForCwd } = await import(PARSER);
    const first = await readTranscriptForCwd(CWD, { dbPath: DB_PATH });
    const after = await readTranscriptForCwd(CWD, { dbPath: DB_PATH, sinceUpdatedMs: first.updatedMs });
    expect(after).toBeNull();
  });
});

// ─── extractToolUseResults: Text + Json 两种 content 都提取（回归 MCP 工具 Json 结果丢失）───
describe('kiro-cli transcript-parser toolUseResults 提取（Text + Json）', () => {
  test('Text content 正常提取', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = {
      conversation_id: 'c-text',
      history: [
        { user: { content: { Prompt: { prompt: 'p' } } },
          assistant: { ToolUse: { message_id: 'm0', tool_uses: [{ id: 't0', name: 'read', args: {} }] } },
          request_metadata: { request_id: 'r0', message_id: 'm0', request_start_timestamp_ms: 1, stream_end_timestamp_ms: 2 } },
        { user: { content: { ToolUseResults: { tool_use_results: [{ tool_use_id: 't0', content: [{ Text: 'hello text result' }] }] } } },
          assistant: { Response: { message_id: 'm1', content: [{ kind: 'text', data: 'done' }] } },
          request_metadata: { request_id: 'r1', message_id: 'm1', request_start_timestamp_ms: 3, stream_end_timestamp_ms: 4 } },
      ],
    };
    const parsed = parseConversationValue(convRaw);
    expect(parsed.steps[1].toolUseResults).toEqual(['hello text result']);
  });

  test('Json content（MCP 工具结果）也提取，不再丢', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = {
      conversation_id: 'c-json',
      history: [
        { user: { content: { Prompt: { prompt: 'p' } } },
          assistant: { ToolUse: { message_id: 'm0', tool_uses: [{ id: 't0', name: 'list_directory', args: {} }] } },
          request_metadata: { request_id: 'r0', message_id: 'm0', request_start_timestamp_ms: 1, stream_end_timestamp_ms: 2 } },
        { user: { content: { ToolUseResults: { tool_use_results: [{ tool_use_id: 't0', content: [{ Json: { content: [{ type: 'text', text: 'Allowed directories:\n/Users/yunshen/Documents' }], structuredContent: { content: 'Allowed directories' } } }] }] } } },
          assistant: { Response: { message_id: 'm1', content: [{ kind: 'text', data: 'done' }] } },
          request_metadata: { request_id: 'r1', message_id: 'm1', request_start_timestamp_ms: 3, stream_end_timestamp_ms: 4 } },
      ],
    };
    const parsed = parseConversationValue(convRaw);
    // 旧逻辑：Json 被跳过 → toolUseResults=[]。修复后：提取 Json.content[].text
    expect(parsed.steps[1].toolUseResults).toEqual(['Allowed directories:\n/Users/yunshen/Documents']);
  });

  test('CancelledToolUses 也提取（kiro-cli 把取消的工具结果放这）', async () => {
    const { parseConversationValue } = await import(PARSER);
    const convRaw = {
      conversation_id: 'c-cancel',
      history: [
        { user: { content: { Prompt: { prompt: 'p' } } },
          assistant: { ToolUse: { message_id: 'm0', tool_uses: [{ id: 't0', name: 'shell', args: {} }] } },
          request_metadata: { request_id: 'r0', message_id: 'm0', request_start_timestamp_ms: 1, stream_end_timestamp_ms: 2 } },
        { user: { content: { CancelledToolUses: { prompt: 'p', tool_use_results: [{ tool_use_id: 't0', content: [{ Text: 'Tool use was cancelled by the user' }], status: 'cancelled' }] } } },
          assistant: { Response: { message_id: 'm1', content: [{ kind: 'text', data: 'ok' }] } },
          request_metadata: { request_id: 'r1', message_id: 'm1', request_start_timestamp_ms: 3, stream_end_timestamp_ms: 4 } },
      ],
    };
    const parsed = parseConversationValue(convRaw);
    // 旧逻辑：CancelledToolUses 不被读取 → toolUseResults=[]。修复后：提取
    expect(parsed.steps[1].toolUseResults).toEqual(['Tool use was cancelled by the user']);
  });
});
