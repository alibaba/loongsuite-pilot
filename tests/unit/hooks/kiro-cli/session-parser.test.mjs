// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * session-parser.test.mjs — session-parser.mjs 单元测试。
 *
 * fixture 来源: researcher 调研报告中的真实 session JSONL
 *   (kiro CLI v2 session store, interactive mode, session 838a0f1b)
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSessionEntries,
  buildStepsFromEntries,
  readSessionForCwd,
  resolveSessionDir,
} from '../../../../assets/hooks/kiro-cli/session-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SESSION = path.resolve(__dirname, 'fixtures/session_interactive.jsonl');
const FIXTURE_SIDECAR = path.resolve(__dirname, 'fixtures/session_sidecar.json');

// fixture 来源: researcher 调研报告中的真实 session (kiro CLI v2 session store)
const SESSION_ID = '838a0f1b-1cfd-4421-972a-8807a1b20eb5';
const SESSION_CWD = '/tmp/kiro_session_probe';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-session-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/**
 * 在 tmpDir 下搭建 session 目录（含 sidecar + jsonl），供 readSessionForCwd 读取。
 */
function setupSessionDir(sessionId, sidecarObj, jsonlContent) {
  const sessionDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(sidecarObj), 'utf-8');
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), jsonlContent, 'utf-8');
  return sessionDir;
}

describe('parseSessionEntries', () => {
  test('解析真实 fixture JSONL 为 4 条 entry', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const entries = parseSessionEntries(content);
    expect(entries).toHaveLength(4);
    expect(entries[0].kind).toBe('Prompt');
    expect(entries[1].kind).toBe('AssistantMessage');
    expect(entries[2].kind).toBe('ToolResults');
    expect(entries[3].kind).toBe('AssistantMessage');
  });

  test('跳过空行和格式错误行', () => {
    const content = '{"version":"v1","kind":"Prompt","data":{}}\n\ninvalid json\n{"version":"v1","kind":"AssistantMessage","data":{}}\n';
    const entries = parseSessionEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('Prompt');
    expect(entries[1].kind).toBe('AssistantMessage');
  });

  test('空内容返回空数组', () => {
    expect(parseSessionEntries('')).toHaveLength(0);
    expect(parseSessionEntries(null)).toHaveLength(0);
  });
});

describe('buildStepsFromEntries', () => {
  test('真实 fixture: 2 steps（1 ToolUse + 1 NotToolUse）', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    expect(steps).toHaveLength(2);

    const toolStep = steps.find((s) => s.kind === 'ToolUse');
    const responseStep = steps.find((s) => s.kind === 'NotToolUse');

    expect(toolStep).toBeDefined();
    expect(responseStep).toBeDefined();

    // ToolUse 步有 2 个工具
    expect(toolStep.tools).toHaveLength(2);
    expect(toolStep.tools.map((t) => t.name).sort()).toEqual(['execute_bash', 'fs_read']);
    expect(toolStep.assistantText).toBe('');

    // NotToolUse 步有文本
    expect(responseStep.tools).toHaveLength(0);
    expect(responseStep.assistantText).toContain('k57j05345.sqa.eu95');
  });

  test('工具名映射: read→fs_read, shell→execute_bash', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    const toolStep = steps.find((s) => s.kind === 'ToolUse');
    const toolNames = toolStep.tools.map((t) => t.name);
    expect(toolNames).toContain('fs_read');
    expect(toolNames).toContain('execute_bash');
    // 原始名被映射，不保留原名
    expect(toolNames).not.toContain('read');
    expect(toolNames).not.toContain('shell');
  });

  test('时间分布: 各 request 的 start/end 互不相同', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    for (const step of steps) {
      expect(step.endTimeMs).toBeGreaterThan(step.startTimeMs);
    }

    // 两个 step 的 startTimeMs 不同
    expect(steps[0].startTimeMs).not.toBe(steps[1].startTimeMs);
  });

  test('标注 kiro.time_precision 和 kiro.id_source', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    for (const step of steps) {
      expect(step.timePrecision).toBe('turn_estimate');
      expect(step.idSource).toBe('session_jsonl');
    }
  });

  test('step.id 使用 AssistantMessage.message_id', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    // fixture 中的两条 AssistantMessage 的 message_id
    expect(steps[0].stepId).toBe('2b7e8bd9-3f63-4f6d-891c-44e5e3d42123');
    expect(steps[1].stepId).toBe('cdd9d82f-d112-4a28-b92a-58abc327b282');
    // responseId 同 stepId
    expect(steps[0].responseId).toBe(steps[0].stepId);
  });

  test('首步带 userPrompt，后续步 userPrompt 为空', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    expect(steps[0].userPrompt).toContain('hostname');
    expect(steps[1].userPrompt).toBe('');
  });

  test('toolResultsMap 包含工具执行结果', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const entries = parseSessionEntries(content);
    const utm = sidecar.session_state.conversation_metadata.user_turn_metadatas;
    const steps = buildStepsFromEntries(entries, utm);

    const toolStep = steps.find((s) => s.kind === 'ToolUse');
    expect(toolStep.toolResultsMap.size).toBe(2);

    // 检查 fs_read 的结果
    const readTool = toolStep.tools.find((t) => t.name === 'fs_read');
    const readResult = toolStep.toolResultsMap.get(readTool.id);
    expect(readResult.resultText).toContain('k57j05345.sqa.eu95');
    expect(readResult.status).toBe('success');
  });

  test('未知工具名 pass-through（不崩溃）', () => {
    const entries = [
      {
        version: 'v1',
        kind: 'Prompt',
        data: {
          message_id: 'p1',
          content: [{ kind: 'text', data: 'test' }],
          meta: { timestamp: 1782126946 },
        },
      },
      {
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: 'a1',
          content: [
            {
              kind: 'toolUse',
              data: {
                toolUseId: 'tu1',
                name: 'some_unknown_tool',
                input: { param: 'value' },
              },
            },
          ],
        },
      },
    ];
    const utm = [
      { total_request_count: 1, end_timestamp: '2026-06-22T11:15:52.291Z', metering_usage: [] },
    ];

    const steps = buildStepsFromEntries(entries, utm);
    expect(steps).toHaveLength(1);
    expect(steps[0].tools[0].name).toBe('some_unknown_tool');
  });

  test('无 sidecar 时使用 Prompt 时间戳兜底', () => {
    const entries = [
      {
        version: 'v1',
        kind: 'Prompt',
        data: {
          message_id: 'p1',
          content: [{ kind: 'text', data: 'test' }],
          meta: { timestamp: 1782126946 },
        },
      },
      {
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: 'a1',
          content: [{ kind: 'text', data: 'answer' }],
        },
      },
    ];
    const steps = buildStepsFromEntries(entries, []);
    expect(steps).toHaveLength(1);
    expect(steps[0].startTimeMs).toBe(1782126946000);
    // 无 sidecar 时 endTimeMs 等于 startTimeMs（因为无 end_timestamp）
    // 但 step 仍应被创建
    expect(steps[0].kind).toBe('NotToolUse');
  });
});

describe('readSessionForCwd', () => {
  test('从 session 目录读取并返回 TranscriptData', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const sessionDir = setupSessionDir(SESSION_ID, sidecar, content);

    const result = readSessionForCwd(SESSION_CWD, { sessionDir, sinceUpdatedMs: 0 });

    expect(result).not.toBeNull();
    expect(result.source).toBe('session_jsonl');
    expect(result.conversationId).toBe(SESSION_ID);
    expect(result.steps).toHaveLength(2);
    expect(result.updatedMs).toBeGreaterThan(0);
    expect(result.modelId).toBe('auto');
  });

  test('sinceUpdatedMs 过滤旧 sidecar', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const sessionDir = setupSessionDir(SESSION_ID, sidecar, content);

    // sidecar updated_at 约 2026-06-22T11:15:53 → ~1782126953386ms
    // 用更大的 sinceMs 过滤掉
    const result = readSessionForCwd(SESSION_CWD, {
      sessionDir,
      sinceUpdatedMs: Date.now() + 1_000_000,
    });
    expect(result).toBeNull();
  });

  test('cwd 不匹配返回 null', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const sessionDir = setupSessionDir(SESSION_ID, sidecar, content);

    const result = readSessionForCwd('/nonexistent/path', { sessionDir });
    expect(result).toBeNull();
  });

  test('session 目录不存在返回 null', () => {
    const result = readSessionForCwd(SESSION_CWD, {
      sessionDir: path.join(tmpDir, 'no_such_dir'),
    });
    expect(result).toBeNull();
  });

  test('null cwd 返回 null', () => {
    expect(readSessionForCwd(null)).toBeNull();
    expect(readSessionForCwd('')).toBeNull();
  });

  test('credits 从 sidecar metering_usage 提取', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));
    const sessionDir = setupSessionDir(SESSION_ID, sidecar, content);

    const result = readSessionForCwd(SESSION_CWD, { sessionDir });
    expect(result).not.toBeNull();
    expect(result.credits).toHaveLength(1); // 1 turn
    expect(typeof result.credits[0]).toBe('number');
    expect(result.credits[0]).toBeGreaterThan(0);
  });

  test('多 session 取最新（按 updated_at）', () => {
    const content = fs.readFileSync(FIXTURE_SESSION, 'utf-8');
    const sidecar = JSON.parse(fs.readFileSync(FIXTURE_SIDECAR, 'utf-8'));

    const sessionDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });

    // 旧 session
    const oldSidecar = { ...sidecar, session_id: 'old-session', updated_at: '2026-06-22T10:00:00Z' };
    fs.writeFileSync(path.join(sessionDir, 'old-session.json'), JSON.stringify(oldSidecar));
    fs.writeFileSync(path.join(sessionDir, 'old-session.jsonl'), content);

    // 新 session
    const newSidecar = { ...sidecar, session_id: 'new-session', updated_at: '2026-06-22T12:00:00Z' };
    fs.writeFileSync(path.join(sessionDir, 'new-session.json'), JSON.stringify(newSidecar));
    fs.writeFileSync(path.join(sessionDir, 'new-session.jsonl'), content);

    const result = readSessionForCwd(SESSION_CWD, { sessionDir });
    expect(result).not.toBeNull();
    expect(result.conversationId).toBe('new-session');
  });
});
