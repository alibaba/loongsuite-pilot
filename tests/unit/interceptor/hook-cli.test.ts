import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitVerdict, runHook } from '../../../src/interceptor/cli/hook.js';
import type { EvaluateHookResponse, InterceptorHealth } from '../../../src/interceptor/types.js';

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
    const code = await runHook(['--agent', 'qoder-auto'], {
      readStdin: async () => '{',
      writeStdout: (text) => stdout.push(text),
      log: (message) => logs.push(message),
      resolveSurface: () => 'qoder',
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(logs.some((line) => line.includes('parse'))).toBe(true);
  });

  it('fail-opens when runtime is missing', async () => {
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath: join(tmpdir(), 'missing-interceptor-runtime.json'),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
  });

  it('fail-opens when health identity does not match runtime', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
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
  });

  it('fail-opens when the daemon request throws', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
      createClient: () => ({
        health: async () => {
          throw new Error('timeout');
        },
        checkHook: async (): Promise<EvaluateHookResponse> => ({ action: 'allow', evaluatedRules: [] }),
      }),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
  });

  it('keeps stdout empty on allow', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
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
  });

  it('writes the Desktop block JSON on a blocking verdict', async () => {
    const runtimePath = await writeRuntime();
    const stdout: string[] = [];
    const code = await runHook(['--agent', 'qoder'], {
      readStdin: async () => payload(),
      writeStdout: (text) => stdout.push(text),
      log: () => undefined,
      runtimePath,
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
    expect(stdout.join('')).toBe(`${JSON.stringify({ decision: 'block', reason: 'blocked' })}\n`);
  });

  it('does not emit stdout for unknown actions', () => {
    const chunks: string[] = [];
    emitVerdict(baseRequest(), 'maybe', 'x', (text) => chunks.push(text));
    expect(chunks).toEqual([]);
  });
});

function baseRequest() {
  return {
    agent: 'qoder' as const,
    event: 'UserPromptSubmit' as const,
    raw: {},
  };
}
