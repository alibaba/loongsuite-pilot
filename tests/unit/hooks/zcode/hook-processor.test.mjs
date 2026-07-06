import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/zcode-hook-processor.mjs');
const FIXTURES = path.resolve(__dirname, 'fixtures');

// fixture 来源: researcher CP1 调研报告中真实抓取的 ZCode v3.2.3 hook 事件
// (见 .agent_context/zcode-research/fixtures/hook-events.jsonl)
const HOOK_EVENTS_PATH = path.join(FIXTURES, 'hook-events.jsonl');
const STOP_TRANSCRIPT_PATH = path.join(FIXTURES, 'stop-transcript.jsonl');

let DATA_DIR;
let TMPDIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-hook-test-'));
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});

function readHookEvents() {
  return fs.readFileSync(HOOK_EVENTS_PATH, 'utf-8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function runHook(subcommand, payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'zcode');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      records.push(JSON.parse(t));
    }
  }
  return records;
}

describe('zcode-hook-processor 端到端', () => {
  test('5 个 subcommand 各产出 1 条 JSONL 记录,event.name 正确', () => {
    const events = readHookEvents();
    // events[0] = SessionStart, [1] = UserPromptSubmit, [2] = PreToolUse,
    // [3] = PostToolUse, [4] = Stop
    const subcommandOf = (ev) => {
      const name = ev.hook_event_name;
      return name
        .replace(/([A-Z])/g, '-$1')
        .replace(/^-/, '')
        .toLowerCase();
    };

    for (const ev of events) {
      // Stop 事件需要 transcript_path 指向可读文件,这里给一个临时路径
      // (processor 容错:文件不存在时退回 hook payload 的 responseText)
      if (ev.hook_event_name === 'Stop') {
        const tmp = path.join(TMPDIR, 'transcript.jsonl');
        fs.copyFileSync(STOP_TRANSCRIPT_PATH, tmp);
        ev.transcript_path = tmp;
        ev.transcriptPath = tmp;
      }
      const r = runHook(subcommandOf(ev), ev);
      expect(r.status).toBe(0);
    }

    const records = readJsonlRecords();
    expect(records.length).toBe(5);

    const names = records.map((r) => r['event.name']);
    // session-start + user-prompt-submit + stop 都用 event.name='other',
    // 通过 gen_ai.agent.event.name 区分
    expect(names.filter((n) => n === 'other').length).toBe(3);
    expect(names).toContain('tool.call');         // pre-tool-use
    expect(names).toContain('tool.result');       // post-tool-use

    // session.start 与 user_prompt.submit 与 stop 都用 event.name='other',
    // 通过 gen_ai.agent.event.name 区分
    const otherRecords = records.filter((r) => r['event.name'] === 'other');
    expect(otherRecords.length).toBe(3);
    const agentEventNames = otherRecords.map((r) => r['gen_ai.agent.event.name']).sort();
    expect(agentEventNames).toEqual(['session.start', 'stop', 'user_prompt.submit']);
  });

  test('PreToolUse 事件携带 tool_name/tool_input/tool_use_id', () => {
    const events = readHookEvents();
    const pre = events.find((e) => e.hook_event_name === 'PreToolUse');
    const r = runHook('pre-tool-use', pre);
    expect(r.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.length).toBe(1);
    const rec = records[0];
    expect(rec['gen_ai.tool.name']).toBe('Bash');
    expect(rec['gen_ai.tool.call.id']).toBe('toolu_976lh8d7b5p');
    expect(rec['gen_ai.tool.call.arguments']).toEqual({ command: 'echo 4' });
    expect(rec['gen_ai.tool.risk.level']).toBe('high');
    expect(rec['gen_ai.tool.side_effect_scope']).toBe('system');
  });

  test('PostToolUse 事件解析 toolResultPreview JSON 字符串', () => {
    const events = readHookEvents();
    const post = events.find((e) => e.hook_event_name === 'PostToolUse');
    const r = runHook('post-tool-use', post);
    expect(r.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.length).toBe(1);
    const rec = records[0];
    expect(rec['gen_ai.tool.name']).toBe('Bash');
    // toolResultPreview 是 JSON 字符串,processor 应解析成 object
    expect(rec['gen_ai.tool.call.result']).toMatchObject({ stdout: '4\n', exitCode: 0 });
    expect(rec['tool.result.status']).toBe('completed');
  });

  test('Stop 事件不再发 llm.response (由 zcode-rollout input 补 per-LLM response)', () => {
    const events = readHookEvents();
    const stop = events.find((e) => e.hook_event_name === 'Stop');
    const tmp = path.join(TMPDIR, 'transcript.jsonl');
    fs.copyFileSync(STOP_TRANSCRIPT_PATH, tmp);
    stop.transcript_path = tmp;
    stop.transcriptPath = tmp;

    const r = runHook('stop', stop);
    expect(r.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.length).toBe(1);
    const rec = records[0];
    // Stop 改为发 "other" 事件标记 turn 元数据 (gen_ai.agent.event.name=stop,
    // tool.call.count), 不带 terminal finish_reason。terminal signal 由
    // rollout input 的最后一条 llm.response (finish_reason=stop) 提供;
    // turnIdleTimeoutMs 作为兜底。
    // 原因: Stop hook 在 ZCode 退出时立刻触发, 但 rollout 记录要等下一轮
    // poll (30s) 才能读到。若 Stop 带 end_turn, 会立即 flush 只含 hook
    // 工具事件的 buffer, 之后 rollout 的 llm.request/response 全被
    // late-arrival guard 丢弃, 造成 trace 丢 LLM span。
    expect(rec['event.name']).toBe('other');
    expect(rec['gen_ai.agent.event.name']).toBe('stop');
    expect(rec['gen_ai.response.finish_reasons']).toBeUndefined();
    expect(rec['gen_ai.output.messages']).toBeUndefined();
  });

  test('Stop 同步拷贝 transcript 到 pilot data dir (architect 硬约束)', () => {
    const events = readHookEvents();
    const stop = events.find((e) => e.hook_event_name === 'Stop');
    const tmp = path.join(TMPDIR, 'transcript.jsonl');
    fs.copyFileSync(STOP_TRANSCRIPT_PATH, tmp);
    stop.transcript_path = tmp;
    stop.transcriptPath = tmp;

    runHook('stop', stop);

    const persistDir = path.join(DATA_DIR, 'transcripts', 'zcode', stop.session_id);
    expect(fs.existsSync(persistDir)).toBe(true);
    const files = fs.readdirSync(persistDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/transcript\.jsonl$/);
    // 内容应与源一致
    const srcContent = fs.readFileSync(tmp, 'utf-8');
    const dstContent = fs.readFileSync(path.join(persistDir, files[0]), 'utf-8');
    expect(dstContent).toBe(srcContent);
  });

  test('缺 session_id 不崩溃 (fail-open)', () => {
    const r = runHook('session-start', { hook_event_name: 'SessionStart' });
    expect(r.status).toBe(0);
    // 不应写出任何 JSONL 记录
    expect(readJsonlRecords().length).toBe(0);
    // 应该有错误日志
    const errDir = path.join(DATA_DIR, 'logs', 'zcode', 'errors');
    expect(fs.existsSync(errDir)).toBe(true);
    const errFiles = fs.readdirSync(errDir).filter((f) => f.endsWith('.jsonl'));
    expect(errFiles.length).toBe(1);
  });

  test('未知 subcommand fail-open 不输出记录', () => {
    const r = runHook('unknown-thing', { hook_event_name: 'Whatever', session_id: 's1' });
    expect(r.status).toBe(0);
    expect(readJsonlRecords().length).toBe(0);
  });

  test('span_id 为 16-hex 自生成 (architect 硬约束:不用 ZCode 截断 UUID)', () => {
    const events = readHookEvents();
    const pre = events.find((e) => e.hook_event_name === 'PreToolUse');
    runHook('pre-tool-use', pre);
    const rec = readJsonlRecords()[0];
    // processor 必须自生成 16-hex spanId,不能用 ZCode 的 8-4-2 截断 UUID
    expect(rec.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('trace_id 去连字符转 32-hex (W3C)', () => {
    const events = readHookEvents();
    const pre = events.find((e) => e.hook_event_name === 'PreToolUse');
    runHook('pre-tool-use', pre);
    const rec = readJsonlRecords()[0];
    // ZCode fixture 的 traceId 是 8-4-4-4-12 UUID 格式带连字符
    expect(pre.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // processor 必须去连字符转 32-hex (W3C),否则 OTLP 转换器拒收并重新分配 traceId
    expect(rec.trace_id).toBe(pre.traceId.replace(/-/g, '').toLowerCase());
    expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.trace_id).not.toContain('-');
  });

  test('session_id 与 turn_id 透传', () => {
    const events = readHookEvents();
    const user = events.find((e) => e.hook_event_name === 'UserPromptSubmit');
    runHook('user-prompt-submit', user);
    const rec = readJsonlRecords()[0];
    expect(rec['gen_ai.session.id']).toBe(user.session_id);
    expect(rec['gen_ai.turn.id']).toBe(user.turnId);
  });

  test('user_prompt 携带 prompt 文本到 gen_ai.input.messages', () => {
    const events = readHookEvents();
    const user = events.find((e) => e.hook_event_name === 'UserPromptSubmit');
    runHook('user-prompt-submit', user);
    const rec = readJsonlRecords()[0];
    const msgs = rec['gen_ai.input.messages'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].parts[0].content).toBe(user.prompt);
    expect(msgs[0].parts[0].type).toBe('text');
  });

  test('AgentTeams resource attributes 进入 record (与 claude-code 行为一致)', () => {
    const events = readHookEvents();
    const pre = events.find((e) => e.hook_event_name === 'PreToolUse');
    const r = runHook('pre-tool-use', pre, {
      AGENTTEAMS_REMOTE_MANAGED: '1',
      AGENTTEAMS_RUNTIME: 'zcode',
      AGENTTEAMS_WORKER_NAME: 'local-worker',
      AGENTTEAMS_INSTANCE_ID: 'example-instance',
      AGENTTEAMS_TOKEN: 'should-not-leak',
    });
    expect(r.status).toBe(0);
    const rec = readJsonlRecords()[0];
    expect(rec.resourceAttributes).toEqual({
      'agentteams.worker.name': 'local-worker',
      'agentteams.instance.id': 'example-instance',
    });
    expect(rec['agentteams.token']).toBeUndefined();
    expect(rec['gen_ai.agent.name']).toBe('local-worker');
  });
});
