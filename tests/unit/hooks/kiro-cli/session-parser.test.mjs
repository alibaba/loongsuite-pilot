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

  it('不匹配 cwd 返回 null', async () => {
    const result = await readSessionJsonl('/some/other/dir', { sessionDir: tmpDir });
    expect(result).toBeNull();
  });

  it('reportedSessions 跳过已上报 session', async () => {
    const reported = new Set(['838a0f1b-1cfd-4421-972a-8807a1b20eb5']);
    const result = await readSessionJsonl('/tmp/kiro_session_probe', {
      sessionDir: tmpDir,
      reportedSessions: reported,
    });
    expect(result).toBeNull();
  });

  it('sinceUpdatedMs 跳过旧 session', async () => {
    const futureMs = Date.parse('2030-01-01T00:00:00Z');
    const result = await readSessionJsonl('/tmp/kiro_session_probe', {
      sessionDir: tmpDir,
      sinceUpdatedMs: futureMs,
    });
    expect(result).toBeNull();
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
