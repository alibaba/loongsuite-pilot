import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESS_LOG_MAX_CHARS,
  accessInputFromHookRequest,
  buildAccessLogEntry,
  serializeAccessLogEntry,
  writeInterceptorAccessLog,
  InterceptorAccessLogWriter,
} from '../../../src/interceptor/access-log.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

describe('interceptor access log', () => {
  it('keeps audit matches and fail-open state while masking match metadata', () => {
    const line = serializeAccessLogEntry(buildAccessLogEntry({ event: 'PreToolUse', input: {}, result: {
      action: 'allow', matched: true, enforcement: 'audit', failOpen: true, matches: [{ matched: true, action: 'allow',
        enforcement: 'audit', ruleId: 'observed', ruleVersion: '1', reason: 'sk-1234567890abcdefghijklmnop' }],
    } }));
    expect(line).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(JSON.parse(line).result).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', failOpen: true,
      matches: [{ action: 'allow', matched: true, enforcement: 'audit', ruleId: 'observed', reason: '[APIKEY_MASKED]' }] });
  });
  it('drains an ordered bounded asynchronous queue and records overflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interceptor-async-audit-'));
    const file = join(dir, 'access.log');
    const writer = new InterceptorAccessLogWriter(file, 2);
    for (let i = 0; i < 3; i++) writer.enqueue(buildAccessLogEntry({
      event: 'UserPromptSubmit', sessionId: String(i), input: {}, result: { action: 'allow' },
    }));
    await writer.close();
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.sessionId)).toEqual(['0', '1', undefined]);
    expect(rows[2]).toMatchObject({ event: 'audit-overflow', result: { error: 'audit queue dropped 1 records' } });
  });
  it('includes event, input, and result on each line', () => {
    const line = serializeAccessLogEntry(buildAccessLogEntry({
      event: 'PostToolUse',
      agent: 'qoder',
      toolUseId: 'call-1',
      input: {
        toolName: 'Bash',
        toolResponse: { stdout: 'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot' },
      },
      result: { action: 'block', reason: '[DATABASEURL_BLOCKED]', ruleId: 'databaseUrl' },
    }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('PostToolUse');
    expect(parsed.toolUseId).toBe('call-1');
    expect(parsed.input).toMatchObject({
      toolName: 'Bash',
      toolResponse: { stdout: '[DATABASEURL_MASKED]' },
    });
    expect(parsed.result).toMatchObject({
      action: 'block',
      reason: '[DATABASEURL_BLOCKED]',
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('redacts secrets in the rule title and message', () => {
    const secret = 'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot';
    const line = serializeAccessLogEntry(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'hello' },
      result: {
        action: 'block',
        reason: secret,
        title: `label ${secret}`,
        message: `不要粘贴 ${secret}`,
      },
    }));
    expect(line).not.toContain('eMCyjl4XWcVzpXFb');
    expect(JSON.parse(line).result).toMatchObject({
      reason: '[DATABASEURL_MASKED]',
      title: 'label [DATABASEURL_MASKED]',
      message: '不要粘贴 [DATABASEURL_MASKED]',
    });
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
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('rotates the access log once it reaches the size limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interceptor-access-'));
    const file = join(dir, 'access.log');
    const limits = { maxBytes: 80, rotateCount: 2 };
    writeInterceptorAccessLog(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'first-line-long-enough' },
      result: { action: 'allow' },
    }), file, limits);
    writeInterceptorAccessLog(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'second-line-long-enough' },
      result: { action: 'allow' },
    }), file, limits);
    writeInterceptorAccessLog(buildAccessLogEntry({
      event: 'UserPromptSubmit',
      input: { prompt: 'third-line-long-enough' },
      result: { action: 'block' },
    }), file, limits);

    const current = (await readFile(file, 'utf8')).trim().split('\n');
    const rotated = (await readFile(`${file}.1`, 'utf8')).trim().split('\n');
    expect(JSON.parse(current[0]!).result.action).toBe('block');
    expect(JSON.parse(rotated[0]!).input.prompt).toBe('second-line-long-enough');
    await expect(readFile(`${file}.2`, 'utf8')).resolves.toContain('first-line-long-enough');
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
