// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * skill-read.test.mjs — 显式 /skill 根 SKILL.md Read span 采集/去重/兜底合成。
 *
 * Fixture 结构来源: 真实 transcript(skill_fixture.json,来自真实 transcript
 * 598899dc t2, skill e2e-build-push) 的三层连续记录:
 *   1. assistant tool_use name=Skill, input={skill}, id=toolu_...
 *   2. user tool_result(同 id) content="Launching skill: <name>"
 *   3. user isMeta:true, sourceToolUseID=<skill id>,
 *      text="Base directory for this skill: <绝对路径>\n\n# <标题>\n\n<SKILL.md 全文>"
 * 根 SKILL.md 路径+内容只在 isMeta 注入里;Claude 不产生根 SKILL.md 原生 Read。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../../../../assets/hooks/claude-code/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

// ─── transcript 记录构造器(结构对齐 skill_fixture.json) ───

function userPrompt(promptId, text, ts) {
  return { type: 'user', promptId, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function skillToolUse(id, skillName, ts, msgId) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      id: msgId,
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: skillName } }],
      usage: { input_tokens: 2, output_tokens: 144, cache_read_input_tokens: 45475, cache_creation_input_tokens: 1841 },
      stop_reason: 'tool_use',
    },
  };
}

function skillToolResult(id, skillName, ts) {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Launching skill: ${skillName}` }] },
  };
}

// isMeta 注入。text 首行 = "Base directory for this skill: <baseDir>"。
function skillMetaInjection(sourceToolUseID, baseDir, ts) {
  return {
    type: 'user',
    isMeta: true,
    sourceToolUseID,
    timestamp: ts,
    message: { role: 'user', content: `Base directory for this skill: ${baseDir}\n\n# Title\n\nskill body...` },
  };
}

function readToolUse(id, filePath, ts, msgId) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      id: msgId,
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'tool_use',
    },
  };
}

function readToolResult(id, ts, content = 'file contents') {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

function finalAnswer(msgId, text, ts) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      id: msgId,
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    },
  };
}

function writeTranscript(sessionId, records) {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function appendTranscript(file, records) {
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function runHook(subcommand, payload) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'claude-code');
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      const t = line.trim();
      if (t) records.push(JSON.parse(t));
    }
  }
  return records;
}

function toolCalls(records, name) {
  return records.filter((r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.name'] === name);
}

function toolResults(records, name) {
  return records.filter((r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.name'] === name);
}

function llmResponseForStep(records, stepId) {
  return records.find((r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === stepId);
}

function outputToolCalls(llmResp) {
  const msgs = llmResp?.['gen_ai.output.messages'] || [];
  const assistant = msgs.find((m) => m && m.role === 'assistant');
  return (assistant?.parts || []).filter((p) => p && p.type === 'tool_call');
}

const SYNTH_PREFIX = 'toolu_skillread_';
const BASE_DIR = '/abs/workdir/.claude/skills/e2e-build-push';
const ROOT_SKILL = `${BASE_DIR}/SKILL.md`;

// ─── parser 级: isMeta 注入 → skillRootByToolId 捕获 ───

describe('transcript-parser: skillRootByToolId 捕获', () => {
  test('isMeta 注入被解析成 sourceToolUseID → 根 SKILL.md 路径', () => {
    const file = writeTranscript('p_sess', [
      userPrompt('p1', '/e2e-build-push run it', '2026-07-27T02:00:00.000Z'),
      skillToolUse('toolu_skill_1', 'e2e-build-push', '2026-07-27T02:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill_1', 'e2e-build-push', '2026-07-27T02:00:02.000Z'),
      skillMetaInjection('toolu_skill_1', BASE_DIR, '2026-07-27T02:00:02.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T02:00:03.000Z'),
    ]);
    const { turns } = parseClaudeTranscript(file, 0);
    expect(turns.length).toBe(1);
    expect(turns[0].skillRootByToolId.get('toolu_skill_1')).toBe(ROOT_SKILL);
  });

  test('baseDir 带尾斜杠会被去掉', () => {
    const file = writeTranscript('p_sess2', [
      userPrompt('p1', '/foo', '2026-07-27T02:00:00.000Z'),
      skillToolUse('toolu_skill_2', 'foo', '2026-07-27T02:00:01.000Z', 'msg_s'),
      skillMetaInjection('toolu_skill_2', `${BASE_DIR}/`, '2026-07-27T02:00:02.000Z'),
      finalAnswer('msg_f', 'ok', '2026-07-27T02:00:03.000Z'),
    ]);
    const { turns } = parseClaudeTranscript(file, 0);
    expect(turns[0].skillRootByToolId.get('toolu_skill_2')).toBe(ROOT_SKILL);
  });

  test('非 skill 的 isMeta(text 不以前缀开头)不进 map', () => {
    const file = writeTranscript('p_sess3', [
      userPrompt('p1', 'hi', '2026-07-27T02:00:00.000Z'),
      {
        type: 'user', isMeta: true, sourceToolUseID: 'toolu_x', timestamp: '2026-07-27T02:00:00.500Z',
        message: { role: 'user', content: 'System reminder: something unrelated' },
      },
      finalAnswer('msg_f', 'ok', '2026-07-27T02:00:01.000Z'),
    ]);
    const { turns } = parseClaudeTranscript(file, 0);
    expect(turns[0].skillRootByToolId.size).toBe(0);
  });

  test('isMeta 缺 sourceToolUseID 不进 map', () => {
    const file = writeTranscript('p_sess4', [
      userPrompt('p1', '/foo', '2026-07-27T02:00:00.000Z'),
      { type: 'user', isMeta: true, timestamp: '2026-07-27T02:00:00.500Z', message: { role: 'user', content: `Base directory for this skill: ${BASE_DIR}` } },
      finalAnswer('msg_f', 'ok', '2026-07-27T02:00:01.000Z'),
    ]);
    const { turns } = parseClaudeTranscript(file, 0);
    expect(turns[0].skillRootByToolId.size).toBe(0);
  });
});

// ─── 端到端: 六场景 ───

describe('claude-code hook: /skill 根 SKILL.md Read span', () => {
  test('场景1: /skill + 一个原生根 Read → 不合成,仅保留真实 Read', () => {
    const t = writeTranscript('s1', [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
      readToolUse('toolu_realread', ROOT_SKILL, '2026-07-27T03:00:03.000Z', 'msg_read'),
      readToolResult('toolu_realread', '2026-07-27T03:00:04.000Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:05.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's1', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    const reads = toolCalls(recs, 'Read');
    expect(reads.length).toBe(1);
    expect(reads[0]['gen_ai.tool.call.id']).toBe('toolu_realread');
    expect(reads.some((x) => x['gen_ai.tool.call.id'].startsWith(SYNTH_PREFIX))).toBe(false);
    expect(toolCalls(recs, 'Skill').length).toBe(1);
    // 有真实根 Read → 不注入合成 tool_call 到任何 LLM 输出侧
    const allInjected = recs
      .filter((r) => r['event.name'] === 'llm.response')
      .flatMap((r) => outputToolCalls(r))
      .filter((p) => (p.id || '').startsWith(SYNTH_PREFIX));
    expect(allInjected.length).toBe(0);
  });

  test('场景2: /skill + 多个不同 ID 的重复根 Read → 全保留,不合成', () => {
    const t = writeTranscript('s2', [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
      readToolUse('toolu_read_a', ROOT_SKILL, '2026-07-27T03:00:03.000Z', 'msg_ra'),
      readToolResult('toolu_read_a', '2026-07-27T03:00:03.500Z'),
      readToolUse('toolu_read_b', ROOT_SKILL, '2026-07-27T03:00:04.000Z', 'msg_rb'),
      readToolResult('toolu_read_b', '2026-07-27T03:00:04.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:05.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's2', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    const reads = toolCalls(recs, 'Read');
    expect(reads.length).toBe(2);
    const ids = reads.map((x) => x['gen_ai.tool.call.id']).sort();
    expect(ids).toEqual(['toolu_read_a', 'toolu_read_b']);
    expect(reads.some((x) => x['gen_ai.tool.call.id'].startsWith(SYNTH_PREFIX))).toBe(false);
  });

  test('场景3: /skill 无原生 Read → 兜底合成一条,call/result 同 id,挂 Skill owner step', () => {
    const t = writeTranscript('s3', [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:05.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's3', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    const readCalls = toolCalls(recs, 'Read');
    const readResults = toolResults(recs, 'Read');
    expect(readCalls.length).toBe(1);
    expect(readResults.length).toBe(1);
    const callId = readCalls[0]['gen_ai.tool.call.id'];
    expect(callId.startsWith(SYNTH_PREFIX)).toBe(true);
    expect(readResults[0]['gen_ai.tool.call.id']).toBe(callId); // call/result 同 id → OTLP 一个 span
    expect(readCalls[0]['gen_ai.tool.call.arguments']).toEqual({ file_path: ROOT_SKILL });
    // owner step == Skill 声明所在 step
    const skillCall = toolCalls(recs, 'Skill')[0];
    expect(readCalls[0]['gen_ai.step.id']).toBe(skillCall['gen_ai.step.id']);
    // 时间戳非零(取 Skill 的 call/result)
    expect(readCalls[0].time_unix_nano).not.toBe('0');

    // 参照 cursor PR #193: owner step 的 LLM span output.messages 挂上同 id/name=Read 的 tool_call
    const ownerResp = llmResponseForStep(recs, readCalls[0]['gen_ai.step.id']);
    expect(ownerResp).toBeDefined();
    const injected = outputToolCalls(ownerResp).find((p) => p.id === callId);
    expect(injected).toBeDefined();
    expect(injected.name).toBe('Read');
    expect(injected.arguments).toEqual({ file_path: ROOT_SKILL });
    // owner step 输出侧仍保留原 Skill tool_call(未覆盖)
    expect(outputToolCalls(ownerResp).some((p) => p.name === 'Skill')).toBe(true);
  });

  test('场景3b: 合成 call id 确定性(相同 client+turnId+rootPath 两次运行 id 相同)', () => {
    const records = [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:05.000Z'),
    ];
    // 两个独立 DATA_DIR、相同 session_id(→ 相同 turnId :t1)+相同根路径 → 同确定性 id。
    const idFromFreshDataDir = () => {
      const prevDataDir = DATA_DIR;
      DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-det-'));
      try {
        const t = writeTranscript('det', records);
        runHook('stop', { session_id: 'det', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
        return toolCalls(readJsonlRecords(), 'Read')[0]['gen_ai.tool.call.id'];
      } finally {
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
        DATA_DIR = prevDataDir;
      }
    };
    const id1 = idFromFreshDataDir();
    const id2 = idFromFreshDataDir();
    expect(id1.startsWith(SYNTH_PREFIX)).toBe(true);
    expect(id1).toBe(id2);
  });

  test('场景4: 根 SKILL.md + references 同读 → references 保留,不重复合成', () => {
    const refPath = `${BASE_DIR}/references/guide.md`;
    const t = writeTranscript('s4', [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
      readToolUse('toolu_root', ROOT_SKILL, '2026-07-27T03:00:03.000Z', 'msg_root'),
      readToolResult('toolu_root', '2026-07-27T03:00:03.500Z'),
      readToolUse('toolu_ref', refPath, '2026-07-27T03:00:04.000Z', 'msg_ref'),
      readToolResult('toolu_ref', '2026-07-27T03:00:04.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:05.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's4', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    const reads = toolCalls(recs, 'Read');
    const ids = reads.map((x) => x['gen_ai.tool.call.id']).sort();
    expect(ids).toEqual(['toolu_ref', 'toolu_root']); // 真实根 + references 都在,零合成
    expect(reads.some((x) => x['gen_ai.tool.call.id'].startsWith(SYNTH_PREFIX))).toBe(false);
  });

  test('场景5: 普通文件重复读(无 /skill)→ 都保留,不误删,无合成', () => {
    const t = writeTranscript('s5', [
      userPrompt('p1', 'read the file twice', '2026-07-27T03:00:00.000Z'),
      readToolUse('toolu_n1', '/abs/workdir/foo.txt', '2026-07-27T03:00:01.000Z', 'msg_n1'),
      readToolResult('toolu_n1', '2026-07-27T03:00:01.500Z'),
      readToolUse('toolu_n2', '/abs/workdir/foo.txt', '2026-07-27T03:00:02.000Z', 'msg_n2'),
      readToolResult('toolu_n2', '2026-07-27T03:00:02.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:03.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's5', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    expect(toolCalls(recs, 'Read').length).toBe(2);
    expect(toolCalls(recs, 'Skill').length).toBe(0);
    expect(recs.some((x) => (x['gen_ai.tool.call.id'] || '').startsWith(SYNTH_PREFIX))).toBe(false);
  });

  test('场景6: 无 /skill 普通对话 → 不产生任何 Skill/合成 Read', () => {
    const t = writeTranscript('s6', [
      userPrompt('p1', 'hello', '2026-07-27T03:00:00.000Z'),
      finalAnswer('msg_final', 'hi there', '2026-07-27T03:00:01.000Z'),
    ]);
    const r = runHook('stop', { session_id: 's6', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r.status).toBe(0);
    const recs = readJsonlRecords();
    expect(toolCalls(recs, 'Read').length).toBe(0);
    expect(toolCalls(recs, 'Skill').length).toBe(0);
  });

  // architect P1-3: 跨 hook-run / 延迟真实 Read 边界。
  // 真实根 Read 落在后一次 hook 分块(turnId 不同),前一块已合成 → 去重键
  // client+turnId+rootPath 不同 → 无法跨 build 抑制。此为已知边界(architect 定为非 P0)。
  test('场景7: 跨 hook-run 延迟真实 Read — 记录当前边界行为', () => {
    const t = writeTranscript('s7', [
      userPrompt('p1', '/e2e-build-push', '2026-07-27T03:00:00.000Z'),
      skillToolUse('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:01.000Z', 'msg_skill'),
      skillToolResult('toolu_skill', 'e2e-build-push', '2026-07-27T03:00:02.000Z'),
      skillMetaInjection('toolu_skill', BASE_DIR, '2026-07-27T03:00:02.500Z'),
    ]);
    // 第一次 hook run: 只有 Skill,尚无真实根 Read → 兜底合成一条
    let r1 = runHook('stop', { session_id: 's7', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r1.status).toBe(0);
    const afterRun1 = readJsonlRecords();
    const synthAfter1 = toolCalls(afterRun1, 'Read').filter((x) => x['gen_ai.tool.call.id'].startsWith(SYNTH_PREFIX));
    expect(synthAfter1.length).toBe(1);
    const synthTurn = synthAfter1[0]['gen_ai.turn.id'];

    // 第二次 hook run: 追加延迟的真实根 Read(落在新分块,新 turnId)
    appendTranscript(t, [
      readToolUse('toolu_lateroot', ROOT_SKILL, '2026-07-27T03:00:06.000Z', 'msg_late'),
      readToolResult('toolu_lateroot', '2026-07-27T03:00:06.500Z'),
      finalAnswer('msg_final', 'done', '2026-07-27T03:00:07.000Z'),
    ]);
    let r2 = runHook('stop', { session_id: 's7', stop_reason: 'end_turn', transcript_path: t, cwd: '/abs/workdir' });
    expect(r2.status).toBe(0);
    const afterRun2 = readJsonlRecords();
    // 真实根 Read 已出现(其真实 id)
    const realLate = toolCalls(afterRun2, 'Read').find((x) => x['gen_ai.tool.call.id'] === 'toolu_lateroot');
    expect(realLate).toBeDefined();
    // 已知边界: 合成 Read 与延迟真实 Read 落在不同 turn(无法跨 build 去重)
    expect(realLate['gen_ai.turn.id']).not.toBe(synthTurn);
  });
});
