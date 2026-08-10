import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { MinimaxCodeRolloutInput } from '../../../src/inputs/minimax-code-rollout/minimax-code-rollout-input.js';

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-code-rollout-test-'));
const ROLLOUT_FIXTURE = path.join(
  __dirname,
  '..',
  'hooks',
  'minimax-code',
  'fixtures',
  'rollout',
  'model-io-sess_test-session-001.jsonl',
);

describe('MinimaxCodeRolloutInput', () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    stateStore = new StateStore(path.join(TMPDIR, 'state.json'));
    await stateStore.load();
  });

  afterEach(() => {
    // Keep TMPDIR alive across tests; only remove the state.json file so
    // cross-test side effects (e.g. onStart reading the file we wrote) work.
    // Full TMPDIR cleanup happens in a single rmSync at process exit.
    fs.rmSync(path.join(TMPDIR, 'state.json'), { force: true });
  });

  it('id / agentType 与 ClientType.MiniMaxCode 一致', () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    expect(input.id).toBe('minimax-code-rollout');
    expect(input.agentType).toBe('minimax-code');
  });

  it('discoverSessionFiles 按 model-io-sess_*.jsonl 模式匹配', async () => {
    fs.mkdirSync(path.join(TMPDIR, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'model-io-sess_aaa.jsonl'), '');
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'model-io-sess_bbb.jsonl'), '');
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'other-prefix_ccc.jsonl'), '');
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'sub') });
    const files = await (input as any).discoverSessionFiles();
    expect(files.sort()).toEqual([
      path.join(TMPDIR, 'sub', 'model-io-sess_aaa.jsonl'),
      path.join(TMPDIR, 'sub', 'model-io-sess_bbb.jsonl'),
    ]);
  });

  it('processSessionLine 跳过 type 非 model-io 的记录', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const result = await (input as any).processSessionLine(
      { type: 'other', sessionId: 's1' },
      '/tmp/x.jsonl',
    );
    expect(result).toBeNull();
  });

  it('processSessionLine 缺 sessionId 时从 model-io-sess_<sid>.jsonl 文件名提取', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n')[0]);
    delete rec.sessionId;
    const entry = await (input as any).processSessionLine(
      rec,
      '/tmp/rollout/model-io-sess_abc-def-123.jsonl',
    );
    expect(entry).toBeTruthy();
    expect(entry!['gen_ai.session.id']).toBe('abc-def-123');
  });

  it('processSessionLine 解析 model-io record → llm.response entry (含 input.messages / output.messages / usage)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(lines[0]);
    const entry = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entry).toBeTruthy();
    expect(entry!['event.name']).toBe('llm.response');
    expect(entry!['gen_ai.agent.type']).toBe('minimax-code');
    expect(entry!['gen_ai.agent.name']).toBe('MiniMax Code');
    expect(entry!['gen_ai.session.id']).toBe(rec.sessionId);
    // input.messages: fixture 第一条 record 应至少有 user/system 消息
    const inMsgs = entry!['gen_ai.input.messages'];
    expect(Array.isArray(inMsgs)).toBe(true);
    expect(inMsgs.length).toBeGreaterThan(0);
    // 所有 parts 必须使用 ARMS GenAI parts 结构
    for (const m of inMsgs) {
      expect(m.role).toBeDefined();
      expect(Array.isArray(m.parts)).toBe(true);
    }
    // output.messages: 至少 assistant 一条
    const outMsgs = entry!['gen_ai.output.messages'];
    expect(Array.isArray(outMsgs)).toBe(true);
    expect(outMsgs[0].role).toBe('assistant');
    expect(outMsgs[0].finish_reason).toBeDefined();
    // usage
    expect(entry!['gen_ai.usage.input_tokens']).toBe(10);
    expect(entry!['gen_ai.usage.output_tokens']).toBe(20);
  });

  it('processSessionLine: finish_reasons 缺省 → ["stop"]', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 't1',
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      response: { modelId: 'm1', text: 'hello' /* no finishReason */ },
    };
    const entry = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entry!['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('processSessionLine: traceId UUID 带连字符 → 32-hex (W3C)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      traceId: '11111111-2222-3333-4444-555555555555',
      request: { messages: [] },
      response: { modelId: 'm1' },
    };
    const entry = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entry!.trace_id).toBe('11111111222233334444555555555555');
    expect(entry!.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('processSessionLine: tool.role 消息 parts.type 为 tool_call_response (P1 fix)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 't1',
      request: {
        messages: [
          { role: 'user', content: 'read /etc/hosts' },
          { role: 'tool', toolCallId: 'call-1', content: '127.0.0.1 localhost' },
        ],
      },
      response: { modelId: 'm1', text: 'done' },
    };
    const entry = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const inMsgs = entry!['gen_ai.input.messages'];
    const toolPart = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_call_response');
    expect(toolPart).toBeDefined();
    expect(toolPart.id).toBe('call-1');
    // 不应有 tool_result 残留
    const stale = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_result');
    expect(stale).toBeUndefined();
  });

  it('processSessionLine: tool definitions 抽取并归一化为 ARMS FunctionToolDefinition', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      request: {
        body: {
          model: 'm1',
          tools: [
            {
              type: 'function',
              function: {
                name: 'Read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
              },
            },
          ],
        },
      },
      response: { modelId: 'm1' },
    };
    const entry = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const defs = entry!['gen_ai.tool.definitions'];
    expect(defs).toBeDefined();
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe('function');
    expect(defs[0].name).toBe('Read');
    expect(defs[0].description).toBe('Read a file');
    expect(defs[0].parameters).toBeDefined();
    // OpenAI 嵌套形态展平后不应残留 function 包装
    expect(defs[0].function).toBeUndefined();
  });

  it('checkAvailability 在目录不存在时返回 false', async () => {
    const input = new MinimaxCodeRolloutInput({
      stateStore,
      sessionDir: path.join(TMPDIR, 'no-such-dir'),
    });
    expect(await MinimaxCodeRolloutInput.checkAvailability()).toBe(false);
  });

  it('onStart: 已存在 rollout 文件 → 状态 pre-seed offset 到 file size (避免回放历史)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const target = path.join(TMPDIR, 'model-io-sess_preseed.jsonl');
    fs.writeFileSync(target, '{"line":1}\n{"line":2}\n');
    await (input as any).onStart();
    const stateKey = `minimax-code-rollout:${target}`;
    const persisted = stateStore.get(stateKey);
    expect(persisted.lastOffset).toBe(fs.statSync(target).size);
    expect(persisted.extra?.inode).toBe(fs.statSync(target).ino);
  });
});
