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
});
