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

  // G2 fix: PostToolUse with isError=true must capture the real error content
  // (e.g. "File does not exist") into gen_ai.tool.call.result and mark status
  // as 'error'. Without this fix the result would be empty and the flusher's
  // orphan synthesis would later overwrite it with {"status":"error","error":"orphaned"},
  // losing the real error text the LLM/user needs to see.
  // fixture 来源: 基于 hook-events.jsonl PostToolUse 改造 (isError=true +
  // toolResultPreview 含 file-not-found 错误文本, 模拟 T1: Read /nonexistent-xyz-123)
  test('PostToolUse isError=true 透传真实 error 内容到 gen_ai.tool.call.result (G2 fix)', () => {
    const events = readHookEvents();
    const post = events.find((e) => e.hook_event_name === 'PostToolUse');
    // 模拟失败 Read: toolName=Read, isError=true, toolResultPreview 含真实错误
    const failedRead = {
      ...post,
      toolName: 'Read',
      tool_name: 'Read',
      toolInput: { file_path: '/nonexistent-xyz-123' },
      tool_input: { file_path: '/nonexistent-xyz-123' },
      isError: true,
      toolResultPreview: '{"error":"File does not exist: /nonexistent-xyz-123","status":"error"}',
    };
    const r = runHook('post-tool-use', failedRead);
    expect(r.status).toBe(0);
    const rec = readJsonlRecords()[0];
    // 真实错误文本必须透传 (非 "orphaned" 兜底)
    expect(rec['gen_ai.tool.call.result']).toMatchObject({
      error: 'File does not exist: /nonexistent-xyz-123',
      status: 'error',
    });
    expect(rec['gen_ai.tool.call.result']).not.toMatchObject({ error: 'orphaned' });
    expect(rec['gen_ai.tool.call.status']).toBe('error');
    expect(rec['tool.result.status']).toBe('error');
    expect(rec['error.type']).toBe('tool_execution_error');
    expect(rec['error.message']).toContain('File does not exist');
  });

  // G2 fix: 当 toolResultPreview 缺失但 isError=true 时, 从 sibling 字段
  // (error/errorMessage/stderr) 兜底取真实错误内容
  test('PostToolUse isError=true 且 toolResultPreview 缺失时从 error 字段兜底 (G2 fix)', () => {
    const events = readHookEvents();
    const post = events.find((e) => e.hook_event_name === 'PostToolUse');
    const failedNoPreview = {
      ...post,
      toolName: 'Read',
      tool_name: 'Read',
      toolInput: { file_path: '/nonexistent-xyz-123' },
      tool_input: { file_path: '/nonexistent-xyz-123' },
      isError: true,
      // toolResultPreview 缺失 — ZCode 有时只发 error 字段
      toolResultPreview: '',
      errorMessage: 'ENOENT: no such file or directory',
    };
    const r = runHook('post-tool-use', failedNoPreview);
    expect(r.status).toBe(0);
    const rec = readJsonlRecords()[0];
    expect(rec['gen_ai.tool.call.result']).toMatchObject({
      status: 'error',
      error: 'ENOENT: no such file or directory',
    });
    expect(rec['gen_ai.tool.call.result']).not.toMatchObject({ error: 'orphaned' });
    expect(rec['tool.result.status']).toBe('error');
  });

  // G2 fix: 成功路径 (isError 缺失/false) 行为不变, 不误标 error
  test('PostToolUse 成功路径不误标 error (isError=false)', () => {
    const events = readHookEvents();
    const post = events.find((e) => e.hook_event_name === 'PostToolUse');
    const success = { ...post, isError: false };
    const r = runHook('post-tool-use', success);
    expect(r.status).toBe(0);
    const rec = readJsonlRecords()[0];
    expect(rec['gen_ai.tool.call.status']).toBe('completed');
    expect(rec['tool.result.status']).toBe('completed');
    expect(rec['error.type']).toBeUndefined();
    expect(rec['error.message']).toBeUndefined();
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
    // tool.call.count), 并带 terminal finish_reason 触发 Signal A flush。
    //
    // P0 race condition fix: rollout input 的 terminal llm.response 已在
    // flusher send() 中抑制 (agent.source === 'zcode-rollout' 时不触发 Signal
    // A), 改由 Stop 作为唯一 terminal signal。Stop 在所有 hook 工具事件写入
    // JSONL 后触发, 配合 turnFlushDebounceMs (35s > rollout 30s poll) 给
    // zcode-log (5s poll) 和 zcode-rollout (30s poll) 充足时间 dispatch。
    //
    // toolCallCount > 0 (正常): emit ['end_turn'] — LLM 已完成 turn, 工具结果齐全
    // toolCallCount === 0 (中断): emit ['interrupted'] — ZCode 被 kill 前未产出 tool_call
    expect(rec['event.name']).toBe('other');
    expect(rec['gen_ai.agent.event.name']).toBe('stop');
    expect(stop.toolCallCount).toBe(1); // fixture 是正常路径 (toolCallCount=1)
    expect(rec['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    // Stop 不发 llm.response, 所以不带 output.messages
    expect(rec['gen_ai.output.messages']).toBeUndefined();
  });

  test('Stop 中断路径 (toolCallCount=0) emit finish_reason=interrupted', () => {
    const events = readHookEvents();
    const stop = events.find((e) => e.hook_event_name === 'Stop');
    // 改为 toolCallCount=0 模拟中断场景 (ZCode 被 SIGTERM/SIGKILL 前未产出 tool_call)
    stop.toolCallCount = 0;
    const tmp = path.join(TMPDIR, 'transcript.jsonl');
    fs.copyFileSync(STOP_TRANSCRIPT_PATH, tmp);
    stop.transcript_path = tmp;
    stop.transcriptPath = tmp;

    const r = runHook('stop', stop);
    expect(r.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.length).toBe(1);
    const rec = records[0];
    expect(rec['gen_ai.response.finish_reasons']).toEqual(['interrupted']);
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
