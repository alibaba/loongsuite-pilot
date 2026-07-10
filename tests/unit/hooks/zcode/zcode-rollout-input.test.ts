import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZcodeRolloutInput } from '../../../../src/inputs/zcode-rollout/zcode-rollout-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures');
const ROLLOUT_FIXTURE = path.join(FIXTURES, 'rollout', 'model-io-sess_ffe3655e-f152-4e05-bf1f-dfa560732218.jsonl');
// fixture 来源: 容器 dind-harness-ab49e683 真实抓取的 zcode v0.15.0 production
// rollout 记录 (sessionId sess_bff4423d / sess_18c4c0fc), slimmed (truncate 长
// description / parameters / messages) 但保留关键字段原貌:
//   - tools 为 OpenAI 嵌套形态 {type:'function', function:{name, description, parameters}}
//   - role=tool message 含 isError=true + 真实 "File does not exist" content
const V015_G1_FIXTURE = path.join(FIXTURES, 'rollout', 'model-io-sess_v015-g1-nested-tools.jsonl');
const V015_G2_FIXTURE = path.join(FIXTURES, 'rollout', 'model-io-sess_v015-g2-tool-error.jsonl');

// fixture 来源: researcher CP1 报告中真实抓取的 ZCode v3.2.3 rollout 记录
// (~/.zcode/cli/rollout/model-io-sess_*.jsonl, 含完整 LLM request + response payload)

let TMPDIR;
let stateStore: StateStore;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-rollout-test-'));
  fs.mkdirSync(path.join(TMPDIR, 'rollout'), { recursive: true });
  stateStore = new StateStore(path.join(TMPDIR, 'state.json'));
});

afterEach(() => {
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});

describe('ZcodeRolloutInput', () => {
  test('discoverSessionFiles 找到 model-io-sess_*.jsonl', async () => {
    const sessDir = path.join(TMPDIR, 'rollout');
    fs.copyFileSync(ROLLOUT_FIXTURE, path.join(sessDir, 'model-io-sess_test123.jsonl'));
    // 无关文件应该被过滤
    fs.writeFileSync(path.join(sessDir, 'other.jsonl'), '{}\n');

    const input = new ZcodeRolloutInput({
      stateStore,
      sessionDir: sessDir,
    });
    const files = await (input as any).discoverSessionFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/model-io-sess_test123\.jsonl$/);
  });

  test('onStart 预置 offset,首次安装不回放历史 (与 qoder-cli-session 行为一致)', async () => {
    const sessDir = path.join(TMPDIR, 'rollout');
    const target = path.join(sessDir, 'model-io-sess_test123.jsonl');
    fs.copyFileSync(ROLLOUT_FIXTURE, target);
    const stat = fs.statSync(target);

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: sessDir });
    await (input as any).onStart();

    const stateKey = `zcode-rollout:${target}`;
    expect(stateStore.getOffset(stateKey)).toBe(stat.size);
  });

  test('processSessionLine 把 model_io 记录展开为 llm.request + llm.response 两条事件', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const record = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(record, '/tmp/model-io-sess_x.jsonl');

    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);

    const [req, resp] = entries;
    // —— llm.request ——
    expect(req['event.name']).toBe('llm.request');
    expect(req['gen_ai.session.id']).toBe(record.sessionId);
    expect(req['gen_ai.turn.id']).toBe(record.turnId);
    expect(req['gen_ai.request.model']).toBe('glm-4.7');
    expect(req['gen_ai.request.id']).toBe(record.requestId);
    // pairing id (responseId 镜像到 request,converter pairLlm 据此配对)
    expect(req['gen_ai.response.id']).toBe(record.response.responseId);

    // input.messages 用 GenAI {role, parts} 形式 (converter 只识别 parts)
    const inMsgs = req['gen_ai.input.messages'];
    expect(inMsgs).toBeDefined();
    expect(Array.isArray(inMsgs)).toBe(true);
    expect(inMsgs.length).toBeGreaterThan(0);
    expect(inMsgs[0].role).toBeDefined();
    expect(Array.isArray(inMsgs[0].parts)).toBe(true);
    expect(inMsgs[0].parts.length).toBeGreaterThan(0);

    // 系统指令 + 工具定义应携带(payload 补全 LLM 上下文)
    expect(req['gen_ai.system_instructions']).toBeDefined();
    expect(req['gen_ai.tool.definitions']).toBeDefined();
    expect(Array.isArray(req['gen_ai.tool.definitions'])).toBe(true);

    // 时间戳 = startedAt (ms → nanos)
    const startedAtMs = new Date(record.startedAt).getTime();
    expect(Number(req['time_unix_nano'])).toBe(startedAtMs * 1_000_000);

    // —— llm.response ——
    expect(resp['event.name']).toBe('llm.response');
    expect(resp['gen_ai.request.id']).toBe(record.requestId);
    expect(resp['gen_ai.response.id']).toBe(record.response.responseId);
    // 时间戳 = completedAt (ms → nanos),确保 duration > 0
    const completedAtMs = new Date(record.completedAt).getTime();
    expect(Number(resp['time_unix_nano'])).toBe(completedAtMs * 1_000_000);
    expect(completedAtMs).toBeGreaterThan(startedAtMs);

    // usage
    expect(resp['gen_ai.usage.input_tokens']).toBe(10);
    expect(resp['gen_ai.usage.output_tokens']).toBe(20);

    // 第 1 条响应是 tool_use,output.messages.parts 应含 tool_call block
    const outMsgs = resp['gen_ai.output.messages'];
    expect(outMsgs).toBeDefined();
    expect(outMsgs[0].role).toBe('assistant');
    expect(Array.isArray(outMsgs[0].parts)).toBe(true);
    const toolCall = outMsgs[0].parts.find((p) => p.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.name).toBe('Bash');
    expect(toolCall.input).toEqual({ command: 'echo 4' });
  });

  test('finishReason 转换:tool-calls -> tool_calls (OTel GenAI 命名)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    // 第 1 条:finishReason=tool-calls → llm.response 携带 ['tool_calls']
    const rec1 = JSON.parse(lines[0]);
    const entries1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const resp1 = entries1.find((e) => e['event.name'] === 'llm.response');
    expect(resp1['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);

    // 第 2 条:finishReason=stop
    const rec2 = JSON.parse(lines[1]);
    const entries2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    const resp2 = entries2.find((e) => e['event.name'] === 'llm.response');
    expect(resp2['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  test('第 2 条记录响应 text 进 gen_ai.output.messages parts', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec2 = JSON.parse(lines[1]);
    const entries = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    const resp = entries.find((e) => e['event.name'] === 'llm.response');
    const outMsgs = resp['gen_ai.output.messages'];
    const textPart = outMsgs[0].parts.find((p) => p.type === 'text');
    expect(textPart.content).toBe('The answer is 4.');
  });

  test('TextPart 使用 ARMS GenAI 规范的 content 字段 (非 text)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec2 = JSON.parse(lines[1]);
    const entries = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    const resp = entries.find((e) => e['event.name'] === 'llm.response');
    const outMsgs = resp['gen_ai.output.messages'];
    const textPart = outMsgs[0].parts.find((p) => p.type === 'text');
    expect(textPart.content).toBeDefined();
    expect(textPart.text).toBeUndefined();
    // input.messages TextPart 也应使用 content
    const rec1 = JSON.parse(lines[0]);
    const entries1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const req = entries1.find((e) => e['event.name'] === 'llm.request');
    const inMsgs = req['gen_ai.input.messages'];
    const inTextPart = inMsgs.flatMap((m) => m.parts).find((p) => p.type === 'text');
    expect(inTextPart.content).toBeDefined();
    expect(inTextPart.text).toBeUndefined();
    // system_instructions TextPart 同样使用 content
    const sysInstr = req['gen_ai.system_instructions'];
    const sysTextPart = sysInstr.find((p) => p.type === 'text');
    expect(sysTextPart.content).toBeDefined();
    expect(sysTextPart.text).toBeUndefined();
  });

  test('output.messages per-message finish_reason 规范化: tool-calls -> tool_calls', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec1 = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const resp = entries.find((e) => e['event.name'] === 'llm.response');
    const outMsgs = resp['gen_ai.output.messages'];
    expect(outMsgs[0].finish_reason).toBe('tool_calls');
    const rec2 = JSON.parse(lines[1]);
    const entries2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    const resp2 = entries2.find((e) => e['event.name'] === 'llm.response');
    expect(resp2['gen_ai.output.messages'][0].finish_reason).toBe('stop');
  });

  test('traceId 去连字符转 32-hex (W3C)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec = JSON.parse(lines[0]);
    // fixture 的 traceId 是 UUID 8-4-4-4-12 带连字符
    expect(rec.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const expected = rec.traceId.replace(/-/g, '').toLowerCase();
    for (const entry of entries) {
      expect(entry.trace_id).toBe(expected);
      expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  test('缺 sessionId 时从文件名提取 (fallback)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec = JSON.parse(lines[0]);
    delete rec.sessionId;
    const entries = await (input as any).processSessionLine(
      rec,
      '/tmp/rollout/model-io-sess_abc-def-123.jsonl',
    );
    for (const entry of entries) {
      expect(entry['gen_ai.session.id']).toBe('abc-def-123');
    }
  });

  test('type 非 model-io 的记录跳过 (未来扩展兼容)', async () => {
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const result = await (input as any).processSessionLine(
      { type: 'other-event', sessionId: 's1' },
      '/tmp/x.jsonl',
    );
    expect(result).toBeNull();
  });

  test('checkAvailability 在目录不存在时返回 false', async () => {
    expect(await ZcodeRolloutInput.checkAvailability()).toBe(false);
  });

  // ─── plan 1.1: step.id allocation ───────────────────────────────────────
  // fixture 来源: 同上 fixture (model-io-sess_ffe3655e...jsonl, researcher CP1 真实抓取)
  // 用于断言 step.id = `${turnId}:s${idx+1}` 派生规则 + retry + 跨turn + 跨重启 + inode 变更

  test('step.id 由 turnId 派生: 4 records (mock 多 turn) → stepId 形如 turn_x:s1~:s2', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    // fixture 有 2 records 同 turnId; 改第 2 条的 turnId 模拟跨 turn 切换
    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);
    const rec1Turn = rec1.turnId; // turn_f01bfd26-...
    const rec2Turn = 'turn_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    rec2.turnId = rec2Turn;
    rec2.requestId = 'req-2-different';

    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');

    const req1 = e1.find((e: any) => e['event.name'] === 'llm.request');
    const resp1 = e1.find((e: any) => e['event.name'] === 'llm.response');
    const req2 = e2.find((e: any) => e['event.name'] === 'llm.request');
    const resp2 = e2.find((e: any) => e['event.name'] === 'llm.response');

    expect(req1['gen_ai.step.id']).toBe(`${rec1Turn}:s1`);
    expect(resp1['gen_ai.step.id']).toBe(`${rec1Turn}:s1`);
    expect(req2['gen_ai.step.id']).toBe(`${rec2Turn}:s1`);
    expect(resp2['gen_ai.step.id']).toBe(`${rec2Turn}:s1`);
  });

  test('同 turnId + 同 requestId (retry) 共享 step.id', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    // 模拟 attempt>1 retry: 同 turnId, 同 requestId, 不同 attempt
    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);
    rec2.turnId = rec1.turnId;
    rec2.requestId = rec1.requestId; // retry: same requestId → same step.id
    rec2.attempt = 2;

    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');

    const step1 = e1[0]['gen_ai.step.id'];
    const step2 = e2[0]['gen_ai.step.id'];
    expect(step1).toBe(`${rec1.turnId}:s1`);
    expect(step2).toBe(`${rec1.turnId}:s1`); // retry 共享
  });

  test('同 turn 不同 requestId → 递增 stepIdx', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);
    rec2.turnId = rec1.turnId; // 同 turn
    rec2.requestId = 'req-different-from-rec1';

    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');

    expect(e1[0]['gen_ai.step.id']).toBe(`${rec1.turnId}:s1`);
    expect(e2[0]['gen_ai.step.id']).toBe(`${rec1.turnId}:s2`);
  });

  test('跨重启: stateStore 持久化 extra.zcodeRollout.turnStepMap,新 record 复用序号', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const filePath = '/tmp/model-io-sess_restart.jsonl';
    const input1 = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec1 = JSON.parse(lines[0]);
    const e1 = await (input1 as any).processSessionLine(rec1, filePath);
    const turnId = rec1.turnId;
    expect(e1[0]['gen_ai.step.id']).toBe(`${turnId}:s1`);

    // 模拟重启: 新 input 实例,但复用同一 stateStore (state.json 已落盘)
    const stateKey = `zcode-rollout:${filePath}`;
    const persisted = stateStore.get(stateKey);
    expect(persisted.extra?.zcodeRollout?.turnStepMap?.[turnId]).toBeDefined();
    expect(persisted.extra.zcodeRollout.turnStepMap[turnId].nextStepIdx).toBe(1);

    const input2 = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec2 = JSON.parse(lines[1]);
    rec2.turnId = turnId;
    rec2.requestId = 'req-after-restart';
    const e2 = await (input2 as any).processSessionLine(rec2, filePath);
    // 复用持久化的 nextStepIdx=1 → s2
    expect(e2[0]['gen_ai.step.id']).toBe(`${turnId}:s2`);
  });

  test('文件 inode 变更 (轮转) → extra.zcodeRollout 清空,新 turnId 从 s1 重新开始', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const sessDir = path.join(TMPDIR, 'rollout');
    const target = path.join(sessDir, 'model-io-sess_rotate.jsonl');
    fs.copyFileSync(ROLLOUT_FIXTURE, target);

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: sessDir });
    await (input as any).onStart();

    const stateKey = `zcode-rollout:${target}`;
    // Pre-populate stale turnStepMap with old turnId + high nextStepIdx to
    // simulate long-running state from a previous session. If inode-change
    // clearing works, this stale entry is gone after collect().
    stateStore.update(stateKey, {
      extra: {
        zcodeRollout: {
          inode: 999999, // mismatched inode forces rotation detection
          turnStepMap: {
            'turn_old-stale': { requestSet: ['old-req'], nextStepIdx: 99 },
          },
        },
      },
    });

    // Rotate: delete + rewrite with one record (new inode)
    fs.unlinkSync(target);
    fs.writeFileSync(target, lines[0] + '\n');

    await input.collect();
    const after = stateStore.get(stateKey);
    expect(after.extra?.zcodeRollout?.inode).toBe(fs.statSync(target).ino);
    // Stale turn's counter must be gone — only the new turnId present.
    expect(after.extra.zcodeRollout.turnStepMap['turn_old-stale']).toBeUndefined();
    // New record allocated s1 (not continuing stale counter of 99+1=100).
    const newTurn = JSON.parse(lines[0]).turnId;
    expect(after.extra.zcodeRollout.turnStepMap[newTurn]).toBeDefined();
    expect(after.extra.zcodeRollout.turnStepMap[newTurn].nextStepIdx).toBe(1);
  });

  test('onStart 初始化 extra.zcodeRollout.inode (避免首 poll 误判轮转)', async () => {
    const sessDir = path.join(TMPDIR, 'rollout');
    const target = path.join(sessDir, 'model-io-sess_init.jsonl');
    fs.copyFileSync(ROLLOUT_FIXTURE, target);
    const stat = fs.statSync(target);

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: sessDir });
    await (input as any).onStart();

    const stateKey = `zcode-rollout:${target}`;
    const state = stateStore.get(stateKey);
    expect(state.extra?.zcodeRollout?.inode).toBe(stat.ino);
    expect(state.extra?.zcodeRollout?.turnStepMap).toEqual({});
  });

  test('缺 turnId 时返回 undefined step.id (不分配,validator 诊断)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec = JSON.parse(lines[0]);
    delete rec.turnId;
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    for (const entry of entries) {
      expect(entry['gen_ai.step.id']).toBeUndefined();
    }
  });

  // ─── CP5 fix: inode=0 sentinel must not trigger false rotation ──────────
  // 场景: ZCode 在 pilot 启动后才创建 rollout 文件 (onStart 没见过此文件)。
  // 修复前: 首次 collect() 时 prevRollout=undefined → allocateStepId 落盘
  // {inode:0, turnStepMap:{...}}; 第二次 collect() 的 pre-pass 看到 inode=0
  // !== stat.ino 误判轮转,清空 turnStepMap,导致 req2 重新从 s1 起步 (而非
  // s2),造成 step.id 错位 s1/s1/s2。
  // 修复后: pre-pass 在 prevRollout=undefined 或 inode=0 sentinel 时 seed
  // inode=stat.ino 但保留 turnStepMap,req2 正确分配 s2。
  test('inode=0 sentinel (file appeared after onStart): 后续 poll seed inode 不清 turnStepMap', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const sessDir = path.join(TMPDIR, 'rollout');
    const target = path.join(sessDir, 'model-io-sess_late-appear.jsonl');
    // 写入 1 条记录 (文件在 onStart 之后才出现)
    fs.writeFileSync(target, lines[0] + '\n');

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: sessDir });
    // 不调 onStart — 模拟文件在 onStart 之后才被 ZCode 创建

    const stateKey = `zcode-rollout:${target}`;
    // 第一次 collect: pre-pass seed inode (prevRollout=undefined 路径);
    // super.collect() 读 1 条记录 → allocateStepId 落盘 turnStepMap
    await input.collect();
    const after1 = stateStore.get(stateKey);
    const rec1 = JSON.parse(lines[0]);
    const turnId = rec1.turnId;
    expect(after1.extra?.zcodeRollout?.turnStepMap?.[turnId]?.requestSet).toEqual([rec1.requestId]);
    expect(after1.extra?.zcodeRollout?.turnStepMap?.[turnId]?.nextStepIdx).toBe(1);
    // 修复后 inode 在 pre-pass 已 seed 为真实 stat.ino (非 0 sentinel)
    expect(after1.extra?.zcodeRollout?.inode).toBe(fs.statSync(target).ino);

    // 追加第 2 条记录 (同 turn, 不同 requestId)
    const rec2 = JSON.parse(lines[1]);
    rec2.turnId = turnId;
    rec2.requestId = 'req-2-different-from-req-1';
    fs.appendFileSync(target, JSON.stringify(rec2) + '\n');

    // 第二次 collect: pre-pass 看到 inode=stat.ino (一致) 不触发轮转;
    // super.collect() 读第 2 条记录 → allocateStepId 复用 turnStepMap,
    // req2 分配 s2 (而非 s1)。
    await input.collect();
    const after2 = stateStore.get(stateKey);
    expect(after2.extra?.zcodeRollout?.inode).toBe(fs.statSync(target).ino);
    // 关键断言: req1 仍在 requestSet 中 (没被清空),req2 追加进去
    expect(after2.extra?.zcodeRollout?.turnStepMap?.[turnId]?.requestSet).toContain(rec1.requestId);
    expect(after2.extra?.zcodeRollout?.turnStepMap?.[turnId]?.requestSet).toContain(rec2.requestId);
    expect(after2.extra?.zcodeRollout?.turnStepMap?.[turnId]?.nextStepIdx).toBe(2);
  });

  // S3 中断路径 (Round 2 E2E): ZCode 被 `timeout 8` SIGTERM 截断,rollout
  // 记录已写入 (completedAt 存在) 但 response.finishReason=null、
  // response.usage=null、无 assistant output。修复前 LLM span 缺
  // gen_ai.output.messages / finish_reasons=['interrupted'] / usage.*,
  // 被 validate-trace + CLAUDE.md 高优铁律双重判 ERROR。修复后注入
  // 占位字段满足 MUST 规则。
  // fixture 来源: 基于 ROLLOUT_FIXTURE 改造,模拟 SIGTERM 中断 (response
  // 字段清空,保留 completedAt)。
  test('interrupted rollout (completedAt present, finishReason=null, no output): 注入 interrupted finish_reason + 占位 output + 0 usage', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    const base = JSON.parse(lines[0]);
    // 模拟中断:保留 startedAt/completedAt/requestId,清空 response 内容
    const interrupted = {
      ...base,
      response: {
        responseId: base.response.responseId,
        modelId: base.response.modelId,
        // finishReason 缺失
        // usage 缺失
        // text 缺失
        // toolCalls 缺失
      },
    };

    const entries = await (input as any).processSessionLine(interrupted, '/tmp/interrupted.jsonl');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);

    const resp = entries.find((e) => e['event.name'] === 'llm.response');
    expect(resp).toBeDefined();
    // 关键修复: finish_reasons = ['interrupted']
    expect(resp['gen_ai.response.finish_reasons']).toEqual(['interrupted']);
    // 关键修复: output.messages 非空 (CLAUDE.md 高优铁律)
    expect(resp['gen_ai.output.messages']).toBeDefined();
    expect(Array.isArray(resp['gen_ai.output.messages'])).toBe(true);
    expect(resp['gen_ai.output.messages'].length).toBeGreaterThan(0);
    expect(resp['gen_ai.output.messages'][0].role).toBe('assistant');
    expect(resp['gen_ai.output.messages'][0].parts[0].type).toBe('text');
    // 关键修复: usage.* = 0 (而不是 undefined/missing)
    expect(resp['gen_ai.usage.input_tokens']).toBe(0);
    expect(resp['gen_ai.usage.output_tokens']).toBe(0);
  });

  test('非中断路径 (finishReason 存在) 不注入 interrupted 占位字段', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });

    const rec = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec, '/tmp/normal.jsonl');
    const resp = entries.find((e) => e['event.name'] === 'llm.response');
    // 正常路径: finishReason 来自原 record (tool_calls),不是 interrupted
    expect(resp['gen_ai.response.finish_reasons']).not.toContain('interrupted');
    // usage 是真实值 (10/20),不是 0 占位
    expect(resp['gen_ai.usage.input_tokens']).toBe(10);
    expect(resp['gen_ai.usage.output_tokens']).toBe(20);
  });

  // P1 fix: ARMS GenAI semconv VALID_PART_TYPES = ['text', 'tool_call',
  // 'tool_call_response', 'reasoning']. 'tool_result' triggers schema WARN per
  // LLM span. Rollout's messageToParts must emit 'tool_call_response' for tool
  // role messages.
  test('tool role message part type 为 tool_call_response (非 tool_result, P1 fix)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    // record 1 的 request.messages[7] 是 role=tool (含 toolCallId/toolName)
    const rec2 = JSON.parse(lines[1]);
    const entries = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    const inMsgs = req['gen_ai.input.messages'];
    const toolResultPart = inMsgs
      .flatMap((m: any) => m.parts)
      .find((p: any) => p.type === 'tool_call_response');
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart.id).toBe('toolu_976lh8d7b5p');
    // 确认没有 tool_result 残留
    const staleToolResult = inMsgs
      .flatMap((m: any) => m.parts)
      .find((p: any) => p.type === 'tool_result');
    expect(staleToolResult).toBeUndefined();
  });

  // P1 fix: gen_ai.agent.name 大小写统一为 'ZCode'. 之前 rollout 路径未设置
  // agent.name,converter fallback 用 gen_ai.agent.type='zcode' (小写) 推导,
  // 与 hook 路径硬编码的 'ZCode' 冲突,同一 session 出现两个不同 agent.name。
  test('gen_ai.agent.name 显式设为 ZCode (与 hook 侧一致, P1 fix)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    for (const entry of entries) {
      expect(entry['gen_ai.agent.name']).toBe('ZCode');
    }
    // 第二条 record 也应一致
    const rec2 = JSON.parse(lines[1]);
    const entries2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    for (const entry of entries2) {
      expect(entry['gen_ai.agent.name']).toBe('ZCode');
    }
  });

  // G1 fix: gen_ai.tool.definitions 必须出现在每个 LLM span 上 (Round 2 E2E
  // 报告 0/57 LLM span 携带此字段). rollout input 现在从 request.body.tools
  // 抽取并归一化为 ARMS GenAI FunctionToolDefinition schema
  // ({type:'function', name, description?, parameters?}).
  // fixture 来源: researcher CP1 真实抓取的 v3.2.3 rollout 记录, tools 在
  // request.body.tools, 每项为 {name, description, input_schema}.
  test('G1: gen_ai.tool.definitions 出现在 llm.request 上并归一化为 ARMS schema', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const rec = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    expect(req['gen_ai.tool.definitions']).toBeDefined();
    expect(Array.isArray(req['gen_ai.tool.definitions'])).toBe(true);
    expect(req['gen_ai.tool.definitions'].length).toBeGreaterThan(0);
    // 每项必须满足 ARMS FunctionToolDefinition schema: type='function' + name
    for (const td of req['gen_ai.tool.definitions']) {
      expect(td.type).toBe('function');
      expect(typeof td.name).toBe('string');
      expect(td.name.length).toBeGreaterThan(0);
    }
    // input_schema 应被归一化为 parameters
    const firstTd = req['gen_ai.tool.definitions'][0];
    expect(firstTd.parameters).toBeDefined();
    expect(firstTd.input_schema).toBeUndefined();
  });

  // G1 fix: 鲁棒性 — 当 tools 字段位于 request.tools (而非 request.body.tools)
  // 时仍能抽取. v0.15.0 production rollout record 结构可能与 v3.2.3 fixture
  // 不同, extractToolDefinitions 尝试多条路径.
  test('G1: tools 位于 request.tools (非 request.body.tools) 仍能抽取 (版本鲁棒)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const rec = JSON.parse(lines[0]);
    // 把 tools 从 request.body.tools 移到 request.tools (模拟 v0.15.0 结构差异)
    const tools = rec.request.body.tools;
    delete rec.request.body.tools;
    rec.request.tools = tools;

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    expect(req['gen_ai.tool.definitions']).toBeDefined();
    expect(Array.isArray(req['gen_ai.tool.definitions'])).toBe(true);
    expect(req['gen_ai.tool.definitions'].length).toBe(tools.length);
    // 仍归一化为 ARMS schema
    expect(req['gen_ai.tool.definitions'][0].type).toBe('function');
    expect(req['gen_ai.tool.definitions'][0].parameters).toBeDefined();
  });

  // G1 fix: tools 字段完全缺失时, gen_ai.tool.definitions 不出现 (不报错)
  test('G1: tools 字段缺失时 gen_ai.tool.definitions 不出现 (fail-open)', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const rec = JSON.parse(lines[0]);
    delete rec.request.body.tools;

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    expect(req['gen_ai.tool.definitions']).toBeUndefined();
  });

  // ─── Round 3 fix (real v0.15.0 production data form) ────────────────────
  // tester-round3 报 FAIL: G1 normalizeToolDefinitions 只识别 flat 形态
  // {name, description, input_schema}; v0.15.0 production rollout 是 OpenAI
  // 嵌套形态 {type:'function', function:{name, description, parameters}}.
  // rec.name 取到 undefined → continue → 返回空 → gen_ai.tool.definitions
  // 不出现在 LLM span 上 (实测 3 个 trace 共 11 个 LLM span, 0 个携带).
  // fixture 来源: 真实 v0.15.0 rollout (sess_bff4423d) slimmed 切片, 保留
  // 嵌套形态原貌.

  test('G1 v0.15.0: OpenAI 嵌套 tools 形态 {type, function:{name, description, parameters}} 正确归一化', async () => {
    const lines = fs.readFileSync(V015_G1_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const rec = JSON.parse(lines[0]);
    // 确认 fixture 是嵌套形态
    const tools = rec.request.body.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].function).toBeDefined();
    expect(tools[0].function.name).toBeDefined();

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const entries = await (input as any).processSessionLine(rec, '/tmp/v015.jsonl');
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    expect(req['gen_ai.tool.definitions']).toBeDefined();
    expect(Array.isArray(req['gen_ai.tool.definitions'])).toBe(true);
    expect(req['gen_ai.tool.definitions'].length).toBe(tools.length);
    // 每项归一化为 ARMS FunctionToolDefinition: type='function' + name (顶层) + parameters
    for (const td of req['gen_ai.tool.definitions']) {
      expect(td.type).toBe('function');
      expect(typeof td.name).toBe('string');
      expect(td.name.length).toBeGreaterThan(0);
      expect(td.parameters).toBeDefined();
      // 不应残留 function 包装层
      expect(td.function).toBeUndefined();
    }
    // 第一项 name 应来自 function.name (而非顶层 undefined)
    expect(req['gen_ai.tool.definitions'][0].name).toBe(tools[0].function.name);
  });

  // G2 fix: tester-round3 报 FAIL — 失败 TOOL span 的 result 字段为
  // {"status":"error","error":"orphaned"} 占位. 根因: cmdPostToolUse 仅在
  // PostToolUse hook 事件到达时触发; 实测 zcode 在 Read 失败时不发射
  // PostToolUse 事件 (G2 全程 4 条 hook 事件无 tool.result; G1b 6 个
  // tool.call 只有 5 个 tool.result). 修复: rollout input 在构建 TOOL span
  // 时, 从 request.messages[role=tool] 按 tool_call_id 取 content 并写真实
  // 错误文本, 设 error.type='tool_execution_error'.
  // fixture 来源: 真实 v0.15.0 rollout (sess_18c4c0fc) slimmed 切片, 第二条
  // record 的 request.messages 含 role=tool isError=true content="File does
  // not exist. Note: your current working directory is /tmp/zc-e2e-g2."
  test('G2 v0.15.0: hook 缺失 tool.result 时, 从 rollout role=tool 消息合成真实错误文本 (非 orphaned)', async () => {
    const lines = fs.readFileSync(V015_G2_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(2);

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    // 第二条 record 的 request.messages 含 role=tool isError=true
    const rec2 = JSON.parse(lines[1]);
    const toolMsg = rec2.request.messages.find((m) => m.role === 'tool' && m.isError === true);
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain('File does not exist');

    const entries = await (input as any).processSessionLine(rec2, '/tmp/g2.jsonl');
    expect(Array.isArray(entries)).toBe(true);
    // 应包含 llm.request + llm.response + 至少 1 条 tool.result
    const toolResults = entries.filter((e) => e['event.name'] === 'tool.result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    const tr = toolResults[0];
    // 关键断言: 携带真实错误文本 (而非 {"status":"error","error":"orphaned"})
    expect(tr['gen_ai.tool.call.id']).toBe(toolMsg.toolCallId);
    expect(tr['gen_ai.tool.name']).toBe('Read');
    const result = tr['gen_ai.tool.call.result'];
    expect(result).toBeDefined();
    expect(result.status).toBe('error');
    expect(result.error).toContain('File does not exist');
    expect(result.error).not.toBe('orphaned');
    // 显式标 error.type='tool_execution_error' (而非 orphaned)
    expect(tr['error.type']).toBe('tool_execution_error');
    expect(tr['error.message']).toContain('File does not exist');
    // status 字段 (entry-builder 把 'error' 归一化为 'failure')
    expect(tr['gen_ai.tool.call.status']).toBe('error');
    expect(tr['tool.result.status']).toBe('failure');
    // trace/session/turn 与同 record 的 LLM span 一致; step.id 留空,
    // 由 flusher 的 ZcodeStepResolver 按 callId 回填到原始 tool.call 所在
    // STEP (即上一条 llm.response 声明该 tool_call 的 step), 避免落入
    // 当前 STEP 导致 tool.call↔tool.result 跨 STEP 配对失败.
    const req = entries.find((e) => e['event.name'] === 'llm.request');
    expect(tr['trace_id']).toBe(req['trace_id']);
    expect(tr['gen_ai.session.id']).toBe(req['gen_ai.session.id']);
    expect(tr['gen_ai.turn.id']).toBe(req['gen_ai.turn.id']);
    expect(tr['gen_ai.step.id']).toBeUndefined();
  });

  test('G2 v0.15.0: 成功 role=tool 消息 (isError absent/false) 不被合成 tool.result (留给 hook PostToolUse)', async () => {
    const lines = fs.readFileSync(V015_G2_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const rec2 = JSON.parse(lines[1]);
    // 把 role=tool 改为成功 (isError=false)
    const toolMsg = rec2.request.messages.find((m) => m.role === 'tool');
    toolMsg.isError = false;
    toolMsg.content = 'success output';

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const entries = await (input as any).processSessionLine(rec2, '/tmp/g2-success.jsonl');
    const toolResults = entries.filter((e) => e['event.name'] === 'tool.result');
    expect(toolResults.length).toBe(0);
  });

  test('G2 v0.15.0: 缺 toolCallId 的 role=tool 消息被跳过 (不报错)', async () => {
    const lines = fs.readFileSync(V015_G2_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    const rec2 = JSON.parse(lines[1]);
    // 删掉 toolCallId
    const toolMsg = rec2.request.messages.find((m) => m.role === 'tool');
    delete toolMsg.toolCallId;

    const input = new ZcodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'rollout') });
    const entries = await (input as any).processSessionLine(rec2, '/tmp/g2-no-callid.jsonl');
    const toolResults = entries.filter((e) => e['event.name'] === 'tool.result');
    expect(toolResults.length).toBe(0);
  });
});
