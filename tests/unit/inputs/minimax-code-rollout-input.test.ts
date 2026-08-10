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
    // Delete any persisted state.json so each test starts with a clean
    // stateStore. Without this, prior tests' persisted turnStepMap / offsets
    // leak into subsequent tests (StateStore.load() re-hydrates from disk).
    fs.rmSync(path.join(TMPDIR, 'state.json'), { force: true });
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
    expect(result).toEqual([]);
  });

  it('processSessionLine 缺 sessionId 时从 model-io-sess_<sid>.jsonl 文件名提取', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n')[0]);
    delete rec.sessionId;
    const entries = await (input as any).processSessionLine(
      rec,
      '/tmp/rollout/model-io-sess_abc-def-123.jsonl',
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]!['gen_ai.session.id']).toBe('abc-def-123');
  });

  it('processSessionLine 解析 model-io record → emit [llm.request, llm.response] pair', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries).toHaveLength(2);

    // ── request entry (entries[0])
    const requestEntry = entries[0];
    expect(requestEntry['event.name']).toBe('llm.request');
    expect(requestEntry['gen_ai.agent.type']).toBe('minimax-code');
    expect(requestEntry['gen_ai.agent.name']).toBe('MiniMax Code');
    expect(requestEntry['gen_ai.session.id']).toBe(rec.sessionId);
    const inMsgs = requestEntry['gen_ai.input.messages'];
    expect(Array.isArray(inMsgs)).toBe(true);
    expect(inMsgs.length).toBeGreaterThan(0);
    for (const m of inMsgs) {
      expect(m.role).toBeDefined();
      expect(Array.isArray(m.parts)).toBe(true);
    }
    expect(requestEntry['gen_ai.request.id']).toBeDefined();
    expect(requestEntry['gen_ai.response.id']).toBeDefined();

    // ── response entry (entries[1])
    const responseEntry = entries[1];
    expect(responseEntry['event.name']).toBe('llm.response');
    expect(responseEntry['gen_ai.session.id']).toBe(rec.sessionId);
    expect(responseEntry['gen_ai.request.id']).toBe(requestEntry['gen_ai.request.id']);
    expect(responseEntry['gen_ai.response.id']).toBe(requestEntry['gen_ai.response.id']);
    const outMsgs = responseEntry['gen_ai.output.messages'];
    expect(Array.isArray(outMsgs)).toBe(true);
    expect(outMsgs[0].role).toBe('assistant');
    expect(outMsgs[0].finish_reason).toBeDefined();
    expect(responseEntry['gen_ai.usage.input_tokens']).toBe(10);
    expect(responseEntry['gen_ai.usage.output_tokens']).toBe(20);

    // time boundaries: request.entry.time_unix_nano <= response.entry.time_unix_nano
    expect(BigInt(requestEntry['time_unix_nano'])).toBeLessThanOrEqual(
      BigInt(responseEntry['time_unix_nano']),
    );
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
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries[1]!['gen_ai.response.finish_reasons']).toEqual(['stop']);
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
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // trace_id 在 request 和 response entry 上应一致 (OTLP pair key)
    expect(entries[0]!.trace_id).toBe('11111111222233334444555555555555');
    expect(entries[1]!.trace_id).toBe('11111111222233334444555555555555');
    expect(entries[0]!.trace_id).toMatch(/^[0-9a-f]{32}$/);
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
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // input.messages 应该在 request entry (entries[0])
    const inMsgs = entries[0]!['gen_ai.input.messages'];
    const toolPart = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_call_response');
    expect(toolPart).toBeDefined();
    expect(toolPart.id).toBe('call-1');
    // 不应有 tool_result 残留
    const stale = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_result');
    expect(stale).toBeUndefined();
  });

  it('processSessionLine: tool definitions 抽取并归一化为 ARMS FunctionToolDefinition (在 request entry)', async () => {
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
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // tool.definitions 在 request entry
    const defs = entries[0]!['gen_ai.tool.definitions'];
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
    expect(persisted.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
  });

  // ─── Round 2: turnStepMap 持久化 ───

  it('Round 2: 同 turnId + 同 requestId (retry) 共享 step.id', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      requestId: 'req-1',
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      response: { modelId: 'm1', finishReason: 'stop' },
    };
    const rec2: any = {
      ...rec1,
      attempt: 2,
      response: { modelId: 'm1', finishReason: 'stop' },
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s1');
  });

  it('Round 2: 同 turn 不同 requestId → 递增 stepIdx', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A', requestId: 'req-1',
      startedAt: 1700000000000, completedAt: 1700000001234,
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const rec2: any = {
      ...rec1, requestId: 'req-2', startedAt: 1700000005000,
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s2');
  });

  it('Round 2: 不同 turnId 各自从 s1 开始', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A', requestId: 'req-1',
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const rec2: any = {
      ...rec1, turnId: 'turn-B', requestId: 'req-1',
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-B:s1');
  });

  it('Round 2: 缺 turnId 时不分配 step.id (validator 诊断)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io', sessionId: 's1', requestId: 'req-1',
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const e = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(e!['gen_ai.step.id']).toBeUndefined();
  });

  it('Round 2: 跨 input 实例 + 共享 stateStore → step.id 复用序号', async () => {
    const input1 = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A',
      request: { requestId: 'req-1', messages: [] },
      response: { modelId: 'm1' },
    };
    const e1 = await (input1 as any).processSessionLine(rec1, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');

    // 模拟重启: 新 input 实例, 复用同一 stateStore
    const input2 = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec2: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A',
      request: { requestId: 'req-2', messages: [] },
      response: { modelId: 'm1' },
    };
    const e2 = await (input2 as any).processSessionLine(rec2, '/tmp/x.jsonl');
    // 持久化后 nextStepIdx 已递增 → s2
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s2');
  });

  // ─── Round 2: 文件轮转 (inode 变化) ───

  it('Round 2: 文件 inode 变更 (轮转) → turnStepMap 清空,新 turnId 从 s1 重新开始', async () => {
    const sessDir = path.join(TMPDIR, 'rollout-rot');
    fs.mkdirSync(sessDir, { recursive: true });
    const target = path.join(sessDir, 'model-io-sess_rotate.jsonl');
    fs.writeFileSync(target, '');

    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: sessDir });
    await (input as any).onStart();

    const stateKey = `minimax-code-rollout:${target}`;
    // pre-populate stale turnStepMap with old turnId + high nextStepIdx
    stateStore.update(stateKey, {
      extra: {
        minimaxCodeRollout: {
          inode: 999999, // mismatched inode forces rotation detection
          turnStepMap: {
            'turn_old-stale': { requestSet: ['old-req'], nextStepIdx: 99 },
          },
        },
      },
    });

    // Rotate: rewrite file (new inode)
    fs.unlinkSync(target);
    fs.writeFileSync(target, '');

    await input.collect();
    const after = stateStore.get(stateKey);
    expect(after.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
    // 旧 turnStepMap 已清空
    expect(after.extra.minimaxCodeRollout.turnStepMap['turn_old-stale']).toBeUndefined();
  });

  it('Round 2: 文件 inode=0 sentinel (file appeared after onStart) → seed inode 不清 turnStepMap', async () => {
    const sessDir = path.join(TMPDIR, 'rollout-late');
    fs.mkdirSync(sessDir, { recursive: true });
    const target = path.join(sessDir, 'model-io-sess_late-appear.jsonl');
    // 先不调 onStart,模拟"文件在 onStart 之后才出现"
    fs.writeFileSync(target, '');

    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: sessDir });
    // 不调 onStart
    const stateKey = `minimax-code-rollout:${target}`;

    // pre-populate turnStepMap with stale nextStepIdx=99 (没有 inode 字段)
    stateStore.update(stateKey, {
      extra: {
        minimaxCodeRollout: {
          inode: 0, // 0 sentinel
          turnStepMap: {
            'turn_x': { requestSet: ['req-x'], nextStepIdx: 99 },
          },
        },
      },
    });

    // 给文件 append 一些内容
    fs.appendFileSync(target, '{"a":1}\n');

    await input.collect();
    const after = stateStore.get(stateKey);
    // inode 0 sentinel 时 seed inode 但不清 turnStepMap
    expect(after.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
    // turn_x 的 nextStepIdx=99 还在
    expect(after.extra.minimaxCodeRollout.turnStepMap['turn_x'].nextStepIdx).toBe(99);
  });

  // ─── Round 2: interrupted 路径 ───

  it('Round 2: interrupted rollout (completedAt present, no finishReason/text/toolCalls) → 注入 interrupted finish_reason + 占位 output + 0 usage', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-interrupted', messages: [{ role: 'user', content: 'hi' }] },
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      response: {
        // 没有 finishReason / text / toolCalls
        modelId: 'm1',
        responseId: 'r-interrupted',
      },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const responseEntry = entries[1];
    expect(responseEntry['gen_ai.response.finish_reasons']).toEqual(['interrupted']);
    // 占位 output.messages
    const outMsgs = responseEntry['gen_ai.output.messages'];
    expect(Array.isArray(outMsgs)).toBe(true);
    expect(outMsgs.length).toBe(1);
    expect(outMsgs[0].role).toBe('assistant');
    expect(outMsgs[0].finish_reason).toBe('interrupted');
    // usage 全 0
    expect(responseEntry['gen_ai.usage.input_tokens']).toBe(0);
    expect(responseEntry['gen_ai.usage.output_tokens']).toBe(0);
    expect(responseEntry['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect(responseEntry['gen_ai.usage.cache_creation.input_tokens']).toBe(0);
  });

  it('Round 2: 正常 finishReason 时不注入 interrupted (走原 finish_reason)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-normal', messages: [] },
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      response: { modelId: 'm1', text: 'hello', finishReason: 'stop' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(entries[1]['gen_ai.usage.input_tokens']).not.toBe(0); // 真实值
  });

  it('Round 2: completedAt 缺失时不视为 interrupted (fallback to stop)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-no-completed', messages: [] },
      startedAt: 1700000000000,
      // completedAt missing
      response: { modelId: 'm1' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('Round 2: 有 text 但 completedAt 缺失 → 不视为 interrupted', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-text-only', messages: [] },
      // no completedAt
      response: { modelId: 'm1', text: 'partial response' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // 没有 completedAt 触发 interrupted 检测,fallback to resolveFinishReasons
    // 也没 finishReason → 'stop'
    expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });
});
