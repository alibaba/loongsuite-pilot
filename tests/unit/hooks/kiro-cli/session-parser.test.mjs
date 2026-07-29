// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * session-parser.test.mjs — session JSONL 解析器单测。
 *
 * fixture 来源: researcher 调研报告中的真实 session JSONL (kiro-cli v2.8.0)
 *   ~/.kiro/sessions/cli/838a0f1b-1cfd-4421-972a-8807a1b20eb5.jsonl
 *   ~/.kiro/sessions/cli/838a0f1b-1cfd-4421-972a-8807a1b20eb5.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseSessionLines, readSessionJsonl } from '../../../../assets/hooks/kiro-cli/session-parser.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

function parseJsonl(raw) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('parseSessionLines', () => {
  let sidecar;
  let lines;

  beforeEach(() => {
    sidecar = JSON.parse(loadFixture('session_sidecar.json'));
    lines = parseJsonl(loadFixture('session_interactive.jsonl'));
  });

  it('提取 2 个 steps（1 ToolUse + 1 NotToolUse）', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].kind).toBe('ToolUse');
    expect(result.steps[1].kind).toBe('NotToolUse');
  });

  it('conversationId 从 sidecar rts_model_state 取', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.conversationId).toBe('838a0f1b-1cfd-4421-972a-8807a1b20eb5');
  });

  it('modelId 从 sidecar model_info 取', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.modelId).toBe('auto');
  });

  it('ToolUse step 的 tools 包含 read 和 shell（映射为 fs_read/execute_bash）', () => {
    const result = parseSessionLines(lines, sidecar);
    const toolStep = result.steps[0];
    expect(toolStep.tools).toHaveLength(2);
    expect(toolStep.tools[0].name).toBe('fs_read');
    expect(toolStep.tools[0].id).toBe('tooluse_qGfoBnoJaaIOUSzVkyVTwf');
    expect(toolStep.tools[1].name).toBe('execute_bash');
    expect(toolStep.tools[1].id).toBe('tooluse_NzHEPwReSjpoFDaMHj7hPW');
  });

  it('NotToolUse step 的 assistantText 包含最终回答', () => {
    const result = parseSessionLines(lines, sidecar);
    const finalStep = result.steps[1];
    expect(finalStep.assistantText).toContain('k57j05345.sqa.eu95');
    expect(finalStep.assistantText).toContain('/usr/bin/bash');
  });

  it('首轮 step 的 userPrompt 非空', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.steps[0].userPrompt).toContain('hostname');
  });

  it('后续 step 的 userPrompt 为空', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.steps[1].userPrompt).toBe('');
  });

  it('后续 step 的 toolUseResults 包含前一步 tool 的结果文本（role: "tool" 来源）', () => {
    const result = parseSessionLines(lines, sidecar);
    const step2 = result.steps[1];
    expect(Array.isArray(step2.toolUseResults)).toBe(true);
    expect(step2.toolUseResults.length).toBe(2);
    expect(step2.toolUseResults[0]).toContain('k57j05345.sqa.eu95');
    expect(step2.toolUseResults[1]).toContain('/usr/bin/bash');
  });

  it('首轮 step 的 toolUseResults 为空数组', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.steps[0].toolUseResults).toEqual([]);
  });

  it('json kind 工具结果提取干净文本（MCP @filesystem），不再 JSON.stringify', () => {
    // 构造一个 ToolResults 行，content 用 json kind（MCP 工具返回）
    const jsonLines = [
      ...lines,
      {
        kind: 'Prompt',
        data: {
          message_id: 'p-json',
          content: [{ kind: 'text', data: 'list dir' }],
          meta: { timestamp: 1782126960 },
        },
      },
      {
        kind: 'AssistantMessage',
        data: {
          message_id: 'am-json',
          content: [{ kind: 'toolUse', data: { toolUseId: 'tu-json', name: 'list_directory', input: { path: '/tmp' } } }],
        },
      },
      {
        kind: 'ToolResults',
        data: {
          message_id: 'tr-json',
          content: [{
            kind: 'toolResult',
            data: {
              toolUseId: 'tu-json',
              content: [{
                kind: 'json',
                // MCP 工具 json 响应：{content:[{type:text,text:...}], structuredContent:{...}}
                data: { content: [{ type: 'text', text: 'Allowed directories:\n/Users/tmp' }], structuredContent: { content: 'Allowed directories' } },
              }],
              status: 'success',
            },
          }],
        },
      },
      {
        kind: 'AssistantMessage',
        data: { message_id: 'am-json2', content: [{ kind: 'text', data: 'done' }] },
      },
    ];
    const jsonSidecar = JSON.parse(JSON.stringify(sidecar));
    jsonSidecar.session_state.conversation_metadata.user_turn_metadatas.push({
      loop_id: { agent_id: { name: 'kiro_default' }, rand: 3 },
      result: { Ok: { id: 'am-json2', role: 'assistant', content: [{ kind: 'text', data: 'done' }] } },
      message_ids: ['p-json', 'am-json', 'tr-json', 'am-json2'],
      total_request_count: 1,
      turn_duration: { secs: 5, nanos: 0 },
      end_timestamp: '2026-06-22T11:16:00.000000Z',
      metering_usage: [{ value: 0.01, unit: 'credit', unitPlural: 'credits' }],
      user_prompt_length: 8,
    });
    const result = parseSessionLines(jsonLines, jsonSidecar);
    // 找 toolUseId=tu-json 对应的后续 step（它的 toolUseResults 应含干净文本）
    const stepWithResult = result.steps.find((s) => s.toolUseResults && s.toolUseResults.length > 0 && s.toolUseResults.some((t) => t.includes('Allowed')));
    expect(stepWithResult).toBeTruthy();
    // 干净文本，不是 {"content":[...]} JSON 串
    expect(stepWithResult.toolUseResults[0]).toContain('Allowed directories:\n/Users/tmp');
    expect(stepWithResult.toolUseResults[0]).not.toContain('"content"');
  });

  it('时间均分：startTimeMs < endTimeMs，step 间不重叠', () => {
    const result = parseSessionLines(lines, sidecar);
    const [s1, s2] = result.steps;
    expect(s1.startTimeMs).toBeGreaterThan(0);
    expect(s1.endTimeMs).toBeGreaterThan(s1.startTimeMs);
    expect(s2.startTimeMs).toBeGreaterThanOrEqual(s1.endTimeMs);
    expect(s2.endTimeMs).toBeGreaterThan(s2.startTimeMs);
  });

  it('credits 从 metering_usage 取', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.credits).toHaveLength(2);
    expect(result.credits[0]).toBeCloseTo(0.0426, 3);
    expect(result.credits[1]).toBeCloseTo(0.0223, 3);
  });

  it('stepId 使用 AssistantMessage.message_id', () => {
    const result = parseSessionLines(lines, sidecar);
    expect(result.steps[0].stepId).toBe('2b7e8bd9-3f63-4f6d-891c-44e5e3d42123');
    expect(result.steps[1].stepId).toBe('cdd9d82f-d112-4a28-b92a-58abc327b282');
  });

  it('tool args 保留原始 input 结构', () => {
    const result = parseSessionLines(lines, sidecar);
    const readTool = result.steps[0].tools[0];
    expect(readTool.args).toHaveProperty('operations');
    expect(readTool.args.operations).toHaveLength(1);
  });

  it('空 lines 返回空 steps', () => {
    const result = parseSessionLines([], sidecar);
    expect(result.steps).toHaveLength(0);
  });

  it('空 sidecar 不崩溃', () => {
    const result = parseSessionLines(lines, {});
    expect(result.steps).toHaveLength(2);
    expect(result.conversationId).toBe('');
    expect(result.modelId).toBe('auto');
  });

  it('仅有 Prompt 行返回空 steps', () => {
    const promptOnly = lines.filter((l) => l.kind === 'Prompt');
    const result = parseSessionLines(promptOnly, sidecar);
    expect(result.steps).toHaveLength(0);
  });
});

describe('readSessionJsonl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-session-test-'));
    const sidecar = JSON.parse(loadFixture('session_sidecar.json'));
    const jsonlRaw = loadFixture('session_interactive.jsonl');
    const sid = sidecar.session_id;
    fs.writeFileSync(path.join(tmpDir, `${sid}.json`), JSON.stringify(sidecar));
    fs.writeFileSync(path.join(tmpDir, `${sid}.jsonl`), jsonlRaw);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('匹配 cwd 返回 steps', async () => {
    const result = await readSessionJsonl('/tmp/kiro_session_probe', { sessionDir: tmpDir });
    expect(result).not.toBeNull();
    expect(result.steps).toHaveLength(2);
    expect(result.source).toBe('session_jsonl');
  });

  it('同一 session 多次调用不跳过（session-level dedup 已移除，依赖 step-level dedup）', async () => {
    const result1 = await readSessionJsonl('/tmp/kiro_session_probe', { sessionDir: tmpDir });
    expect(result1).not.toBeNull();
    const result2 = await readSessionJsonl('/tmp/kiro_session_probe', { sessionDir: tmpDir });
    expect(result2).not.toBeNull();
    expect(result2.steps).toHaveLength(2);
    expect(result2.sessionId).toBe(result1.sessionId);
  });

  it('不匹配 cwd 返回 null', async () => {
    const result = await readSessionJsonl('/some/other/dir', { sessionDir: tmpDir });
    expect(result).toBeNull();
  });

  // 回归：移除冗余 `updatedAt <= since` 过滤后，session_jsonl 兜底链路即使
  // since >= updated_at 也不再跳过整条 session。修复交互式多轮采集「只有首个 turn
  // 上报」的 bug——此前 since 等于 saveSessionOffset 存的 updated_at 时 `<=` 恒真，
  // 整条 session 被 continue，永远到不了 step 级 dedup。
  // fixture updated_at 来自真实 sidecar（session_sidecar.json）。
  it('sinceUpdatedMs 等于 session updated_at 时返回全量（不再跳过）', async () => {
    const updatedAt = Date.parse('2026-06-22T11:15:53.386817252Z');
    const result = await readSessionJsonl('/tmp/kiro_session_probe', {
      sessionDir: tmpDir,
      sinceUpdatedMs: updatedAt,
    });
    expect(result).not.toBeNull();
    expect(result.steps).toHaveLength(2);
  });

  it('sinceUpdatedMs 大于 session updated_at（原 `<=` 恒真边界）仍返回全量', async () => {
    const updatedAt = Date.parse('2026-06-22T11:15:53.386817252Z');
    const result = await readSessionJsonl('/tmp/kiro_session_probe', {
      sessionDir: tmpDir,
      sinceUpdatedMs: updatedAt + 1,
    });
    expect(result).not.toBeNull();
    expect(result.steps).toHaveLength(2);
  });

  it('sessionId 在返回值中', async () => {
    const result = await readSessionJsonl('/tmp/kiro_session_probe', { sessionDir: tmpDir });
    expect(result.sessionId).toBe('838a0f1b-1cfd-4421-972a-8807a1b20eb5');
  });

  it('sessionDir 不存在返回 null', async () => {
    const result = await readSessionJsonl('/tmp/kiro_session_probe', {
      sessionDir: '/nonexistent/path',
    });
    expect(result).toBeNull();
  });

  it('空 cwd 返回 null', async () => {
    const result = await readSessionJsonl('', { sessionDir: tmpDir });
    expect(result).toBeNull();
  });

  it('JSONL 缺失返回 null', async () => {
    fs.unlinkSync(path.join(tmpDir, '838a0f1b-1cfd-4421-972a-8807a1b20eb5.jsonl'));
    const result = await readSessionJsonl('/tmp/kiro_session_probe', { sessionDir: tmpDir });
    expect(result).toBeNull();
  });
});
