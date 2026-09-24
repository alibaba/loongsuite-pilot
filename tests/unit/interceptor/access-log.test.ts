import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESS_LOG_MAX_CHARS,
  accessInputFromHookRequest,
  buildAccessLogEntry,
  serializeAccessLogEntry,
  writeInterceptorAccessLog,
} from '../../../src/interceptor/access-log.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

describe('interceptor access log', () => {
  it('includes event, input, and result on each line', () => {
    const line = serializeAccessLogEntry(buildAccessLogEntry({
      event: 'PostToolUse',
      agent: 'qoder',
      toolUseId: 'call-1',
      input: {
        toolName: 'Bash',
        toolResponse: { stdout: 'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot' },
      },
      result: { action: 'block', reason: '[DATABASEURL_MASKED]', ruleId: 'databaseUrl' },
    }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('PostToolUse');
    expect(parsed.toolUseId).toBe('call-1');
    expect(parsed.input).toMatchObject({
      toolName: 'Bash',
      toolResponse: { stdout: 'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot' },
    });
    expect(parsed.result).toMatchObject({
      action: 'block',
      reason: '[DATABASEURL_MASKED]',
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('copies prompt, tool input, and tool response from a hook request', () => {
    const request: HookRequest = {
      agent: 'qodercli',
      event: 'PreToolUse',
      prompt: 'ignore',
      toolName: 'Bash',
      toolInput: { command: 'cat secrets' },
      toolResponse: { stdout: 'ok' },
      cwd: '/tmp',
      raw: { hook_event_name: 'PreToolUse' },
    };
    expect(accessInputFromHookRequest(request)).toEqual({
      prompt: 'ignore',
      toolName: 'Bash',
      toolInput: { command: 'cat secrets' },
      toolResponse: { stdout: 'ok' },
      cwd: '/tmp',
      raw: { hook_event_name: 'PreToolUse' },
    });
  });

  it('appends JSONL to the access log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interceptor-access-'));
    const file = join(dir, 'access.log');
    writeInterceptorAccessLog(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'hello' },
      result: { action: 'allow', evaluatedRules: [] },
    }), file);
    writeInterceptorAccessLog(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'secret' },
      result: { action: 'block', reason: '[APIKEY_MASKED]' },
    }), file);
    const text = await readFile(file, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).result).toMatchObject({ action: 'allow' });
    expect(JSON.parse(lines[1]!).result).toMatchObject({ action: 'block' });
  });

  it('truncates oversized input instead of dropping the line', () => {
    const huge = 'x'.repeat(ACCESS_LOG_MAX_CHARS);
    const line = serializeAccessLogEntry(buildAccessLogEntry({
      event: 'PostToolUse',
      input: { rawText: huge, toolResponse: huge },
      result: { action: 'allow' },
    }));
    expect(line.length).toBeLessThan(ACCESS_LOG_MAX_CHARS);
    expect(line).toContain('truncated');
    expect(JSON.parse(line).event).toBe('PostToolUse');
    expect(JSON.parse(line).result.action).toBe('allow');
  });
});
