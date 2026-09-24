import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitVerdict, runHook, wrapHostReason } from '../../../src/interceptor/cli/hook.js';
import type { InterceptorAccessLogEntry } from '../../../src/interceptor/access-log.js';
import type { EvaluateHookResponse, InterceptorHealth } from '../../../src/interceptor/types.js';

function collectAccess(): { entries: InterceptorAccessLogEntry[]; writeAccessLog: (entry: InterceptorAccessLogEntry) => void } {
  const entries: InterceptorAccessLogEntry[] = [];
  return { entries, writeAccessLog: (entry) => { entries.push(entry); } };
}

function payload(event = 'UserPromptSubmit'): string {
  return JSON.stringify({ hook_event_name: event, prompt: 'hello', session_id: 's1' });
}

async function writeRuntime(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'interceptor-hook-'));
  const file = join(dir, 'runtime.json');
  await writeFile(file, `${JSON.stringify({
    service: 'loongsuite-pilot-interceptor',
    status: 'ok',
    pid: 4242,
    version: '1.0.2',
    daemon_port: 18791,
    packageVersion: '1.0.2',
    updatedAt: new Date().toISOString(),
    ...overrides,
  })}\n`);
  return file;
}

describe('interceptor hook CLI', () => {
  it('fail-opens on illegal stdin', async () => {
    const logs: string[] = [];
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder-auto'], {
      readStdin: async () => '{',
      writeStdout: (text) => stdout.push(text),
      log: (message) => logs.push(message),
      resolveSurface: () => 'qoder',
      writeAccessLog: access.writeAccessLog,
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(logs.some((line) => line.includes('parse'))).toBe(true);
    expect(access.entries[0]).toMatchObject({
      event: 'unknown',
      input: { rawText: '{' },
      result: { action: 'fail-open', error: 'failed to parse host stdin' },
    });
  });

  it('fail-opens when runtime is missing', async () => {
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath: join(tmpdir(), 'missing-interceptor-runtime.json'),
      writeAccessLog: access.writeAccessLog,
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(access.entries[0]).toMatchObject({
      event: 'UserPromptSubmit',
      input: { prompt: 'hello' },
      result: { action: 'fail-open', error: 'interceptor runtime missing' },
    });
  });

  it('fail-opens a tool hook before daemon evaluation without writing a verdict', async () => {
    const code = await runHook(['--agent', 'qodercli'], {
      readStdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_use_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: 'id' },
      }),
      writeStdout: () => undefined,
      log: () => undefined,
      runtimePath: join(tmpdir(), 'missing-interceptor-runtime.json'),
      writeAccessLog: () => undefined,
    });
    expect(code).toBe(0);
  });

  it('fail-opens when health identity does not match runtime', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: access.writeAccessLog,
      createClient: () => ({
        health: async (): Promise<InterceptorHealth> => ({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 1,
          version: 'other',
          daemon_port: 18791,
        }),
        checkHook: async (): Promise<EvaluateHookResponse> => ({ action: 'block', reason: 'x', evaluatedRules: [] }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(access.entries[0]).toMatchObject({
      event: 'UserPromptSubmit',
      result: { action: 'fail-open', error: 'daemon identity mismatch' },
    });
  });

  it('fail-opens when the daemon request throws', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: access.writeAccessLog,
      createClient: () => ({
        health: async () => {
          throw new Error('timeout');
        },
        checkHook: async (): Promise<EvaluateHookResponse> => ({ action: 'allow', evaluatedRules: [] }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(access.entries[0]).toMatchObject({
      event: 'UserPromptSubmit',
      result: { action: 'fail-open', error: 'timeout' },
    });
  });

  it('emits host stdout for successful tool hook evaluations', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const client = (action: EvaluateHookResponse['action']) => ({
      health: async (): Promise<InterceptorHealth> => ({
        service: 'loongsuite-pilot-interceptor',
        status: 'ok',
        pid: 4242,
        version: '1.0.2',
        daemon_port: 18791,
      }),
      checkHook: async (): Promise<EvaluateHookResponse> => ({
        action,
        reason: action === 'block' ? '[APIKEY_MASKED]' : undefined,
        evaluatedRules: ['apiKey'],
      }),
    });

    const allowCode = await runHook(['--agent', 'qwen-work-cn'], {
      readStdin: async () => JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'qwen-s1',
        tool_use_id: 'qwen-post-1',
        tool_name: 'Bash',
        tool_response: { stdout: 'ok' },
      }),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: () => undefined,
      createClient: () => client('allow'),
    });
    const denyCode = await runHook(['--agent', 'qoder'], {
      readStdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'qoder-s1',
        tool_use_id: 'qoder-pre-1',
        tool_name: 'Bash',
        tool_input: { command: 'id' },
      }),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: () => undefined,
      createClient: () => client('block'),
    });

    expect(allowCode).toBe(0);
    expect(denyCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('permissionDecision');
  });

  it('keeps stdout empty on allow', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: access.writeAccessLog,
      createClient: () => ({
        health: async (): Promise<InterceptorHealth> => ({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: 18791,
        }),
        checkHook: async (): Promise<EvaluateHookResponse> => ({ action: 'allow', evaluatedRules: [] }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(access.entries).toEqual([]);
  });

  it('writes the Desktop block JSON on a blocking verdict', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const access = collectAccess();
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: access.writeAccessLog,
      createClient: () => ({
        health: async (): Promise<InterceptorHealth> => ({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: 18791,
        }),
        checkHook: async (): Promise<EvaluateHookResponse> => ({
          action: 'block',
          reason: 'blocked',
          evaluatedRules: ['demo'],
        }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe(`${JSON.stringify({
      decision: 'block',
      reason: wrapHostReason('UserPromptSubmit', 'blocked'),
    })}\n`);
    expect(access.entries).toEqual([]);
  });

  it('wraps PreToolUse interceptor reasons for the host', () => {
    const chunks: string[] = [];
    emitVerdict(
      { agent: 'qoder', event: 'PreToolUse', raw: {} },
      'block',
      '内容非法',
      (text) => chunks.push(text),
    );
    expect(chunks.join('')).toBe(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: wrapHostReason('PreToolUse', '内容非法'),
      },
    })}\n`);
  });

  it('wraps PostToolUse interceptor reasons for the host', () => {
    const chunks: string[] = [];
    emitVerdict(
      { agent: 'qoder', event: 'PostToolUse', raw: {} },
      'block',
      '内容非法',
      (text) => chunks.push(text),
    );
    expect(chunks.join('')).toBe(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: wrapHostReason('PostToolUse', '内容非法'),
      },
    })}\n`);
  });

  it('does not emit stdout for unknown actions', () => {
    const chunks: string[] = [];
    emitVerdict(baseRequest(), 'maybe', 'x', (text) => chunks.push(text));
    expect(chunks).toEqual([]);
  });

  it('writes QwenWork UserPromptSubmit as decision=block without wrapping twice', () => {
    const chunks: string[] = [];
    emitVerdict(
      { agent: 'qwen-work-cn', event: 'UserPromptSubmit', raw: {} },
      'block',
      '[APIKEY_MASKED]',
      (text) => chunks.push(text),
    );
    expect(chunks.join('')).toBe(`${JSON.stringify({
      decision: 'block',
      reason: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
    })}\n`);
  });

  it('writes OpenClaw before_tool_call block JSON on a blocking verdict', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'openclaw'], {
      readStdin: async () => JSON.stringify({
        openclaw_hook: 'before_tool_call',
        toolName: 'exec',
        params: { command: 'env' },
        toolCallId: 'call_1',
      }),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: () => undefined,
      createClient: () => ({
        health: async (): Promise<InterceptorHealth> => ({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: 18791,
        }),
        checkHook: async (): Promise<EvaluateHookResponse> => ({
          action: 'block',
          reason: '[APIKEY_MASKED]',
          evaluatedRules: ['apiKey'],
        }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe(`${JSON.stringify({
      block: true,
      blockReason: wrapHostReason('PreToolUse', '[APIKEY_MASKED]'),
    })}\n`);
  });

  it('writes QwenWork UserPromptSubmit block JSON on a blocking verdict', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qwen-work-cn'], {
      readStdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'export KEY=sk-test',
        session_id: 's1',
      }),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      writeAccessLog: () => undefined,
      createClient: () => ({
        health: async (): Promise<InterceptorHealth> => ({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: 18791,
        }),
        checkHook: async (): Promise<EvaluateHookResponse> => ({
          action: 'block',
          reason: '[APIKEY_MASKED]',
          evaluatedRules: ['apiKey'],
        }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe(`${JSON.stringify({
      decision: 'block',
      reason: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
    })}\n`);
  });
});

describe('CLI host reason wrapping', () => {
  it('keeps the interceptor string as the xxx slot', () => {
    expect(wrapHostReason('UserPromptSubmit', '内容非法'))
      .toBe('检测到敏感信息：内容非法，本轮对话终止');
    expect(wrapHostReason('PreToolUse', '内容非法'))
      .toBe('检测到非预期行为：内容非法，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。');
    expect(wrapHostReason('PostToolUse', '内容非法'))
      .toBe('检测到非预期行为：内容非法，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。');
  });

  it('omits the detail slot when interceptor reason is missing', () => {
    expect(wrapHostReason('UserPromptSubmit')).toBe('检测到敏感信息，本轮对话终止');
    expect(wrapHostReason('PreToolUse', '  ')).toBe(
      '检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。',
    );
    expect(wrapHostReason('PostToolUse')).toBe(
      '检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。',
    );
  });
});

function baseRequest() {
  return {
    agent: 'qoder' as const,
    event: 'UserPromptSubmit' as const,
    raw: {},
  };
}
