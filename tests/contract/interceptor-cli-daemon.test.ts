import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist/interceptor/cli.cjs');
const DAEMON = join(process.cwd(), 'dist/interceptor/daemon.cjs');

function runProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  child: ChildProcess;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
    child.on('close', (code) => resolve({ code, stdout, stderr, child }));
  });
}

describe('interceptor cli/daemon contract', () => {
  let child: ChildProcess | undefined;
  const built = existsSync(CLI) && existsSync(DAEMON);

  afterEach(() => {
    child?.kill('SIGTERM');
    child = undefined;
  });

  it.skipIf(!built)('does not create runtime with empty switches and the CLI fails open', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-contract-off-'));
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({ interceptor: {} })}\n`);
    const env = {
      ...process.env,
      LOONGSUITE_PILOT_INTERCEPTOR_MODE: '',
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      AGENT_DATA_COLLECTION_CONFIG: join(dataDir, 'config.json'),
    };

    const disabled = await runProcess(process.execPath, [DAEMON], env);
    expect(disabled.code).toBe(0);
    expect(existsSync(join(dataDir, 'interceptor', 'runtime.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'interceptor', 'interceptor.pid'))).toBe(false);

    const allowed = await runProcess(process.execPath, [CLI, 'hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe('');
  });

  it.skipIf(!built)('evaluates online with mode all and fails open when the daemon is down', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-contract-'));
    await mkdir(join(dataDir, 'versions', '1.0.2'), { recursive: true });
    await writeFile(join(dataDir, 'current'), '1.0.2\n');
    await writeFile(join(dataDir, 'versions', '1.0.2', 'VERSION'), 'version=1.0.2\ngit_commit=test\n');
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({ interceptor: { mode: 'all' } })}\n`);
    await mkdir(join(dataDir, 'configs', 'managed'), { recursive: true });
    await writeFile(join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [
      {
        kind: 'pattern', id: 'contract-block', version: '1', agents: ['qoder'],
        events: ['UserPromptSubmit'], match: 'substring', keywords: ['CONTRACT_BLOCK'],
      },
      {
        kind: 'pattern', id: 'workbuddy-block', version: '1', agents: ['workbuddy'],
        events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
        match: 'substring', keywords: ['WORKBUDDY_BLOCK'], message: '本地策略',
      },
    ] } }));

    const env = {
      ...process.env,
      LOONGSUITE_PILOT_INTERCEPTOR_MODE: '',
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      AGENT_DATA_COLLECTION_CONFIG: join(dataDir, 'config.json'),
      LOONGSUITE_PILOT_CACHE_DIR: dataDir,
      INTERCEPTOR_CLI: '',
    };

    child = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const runtimePath = join(dataDir, 'interceptor', 'runtime.json');
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      if (existsSync(runtimePath)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    expect(runtime.service).toBe('loongsuite-pilot-interceptor');
    expect(runtime.status).toBe('ok');

    const allowed = await runProcess(process.execPath, [CLI, 'hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe('');

    const blocked = await runProcess(process.execPath, [CLI, 'hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'CONTRACT_BLOCK',
    }));
    expect(blocked.code).toBe(0);
    expect(JSON.parse(blocked.stdout).decision).toBe('block');

    const hookDir = join(dataDir, 'hooks');
    const cliDir = join(dataDir, 'versions', '1.0.2', 'dist', 'interceptor');
    const windows = process.platform === 'win32';
    const wrapper = windows ? 'interceptor-hook.ps1' : 'interceptor-hook.sh';
    const shellArgs = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : [];
    await mkdir(hookDir);
    await mkdir(cliDir, { recursive: true });
    await copyFile(CLI, join(cliDir, 'cli.cjs'));
    await copyFile(join('assets', 'hooks', wrapper), join(hookDir, wrapper));
    await writeFile(join(dataDir, 'node-bin'), process.execPath);
    async function workbuddyHook(event: string, payload: Record<string, unknown>, bom = ''): Promise<string> {
      const result = await runProcess(
        windows ? 'powershell.exe' : 'bash',
        [...shellArgs, join(hookDir, wrapper), '--agent', 'workbuddy', '--event', event],
        env,
        bom + JSON.stringify(payload),
      );
      expect(result.code).toBe(0);
      return result.stdout;
    }

    expect(await workbuddyHook('user-prompt-submit', { prompt: 'hello' })).toBe('');
    expect(await workbuddyHook('user-prompt-submit', { prompt: 'CONTRACT_BLOCK' })).toBe('');
    expect(await workbuddyHook('user-prompt-submit', {
      hook_event_name: 'Stop', prompt: 'WORKBUDDY_BLOCK',
    })).toBe('');
    const workbuddyPrompt = { prompt: 'WORKBUDDY_BLOCK' };
    expect(JSON.parse(await workbuddyHook('user-prompt-submit', workbuddyPrompt, '\uFEFF'))).toEqual({
      continue: false,
      stopReason: '检测到敏感信息：本地策略，本轮对话终止',
    });
    expect(JSON.parse(await workbuddyHook('pre-tool-use', {
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'WORKBUDDY_BLOCK' },
      session_id: 'wb-session', call_id: 'native-call', tool_use_id: 'other-id',
    }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('本地策略'),
      },
    });
    expect(JSON.parse(await workbuddyHook('post-tool-use', {
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { text: 'WORKBUDDY_BLOCK' },
      session_id: 'wb-session', tool_use_id: 'native-call',
    }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: expect.stringContaining('本地策略') },
    });

    child.kill('SIGTERM');
    await new Promise((resolve) => child?.once('exit', resolve));
    child = undefined;

    const down = await runProcess(process.execPath, [CLI, 'hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'CONTRACT_BLOCK',
    }));
    expect(down.code).toBe(0);
    expect(down.stdout).toBe('');
    // On Windows terminating the child does not run its shutdown checkpoint.
    if (!windows) {
      const checkpoint = JSON.parse(await readFile(join(dataDir, 'interceptor', 'tool-verdicts.json'), 'utf8'));
      for (const phase of ['PreToolUse', 'PostToolUse']) {
        expect(checkpoint.records).toContainEqual(expect.objectContaining({
          sessionId: 'wb-session', toolUseId: 'native-call', phase, action: 'block', ruleId: 'workbuddy-block',
        }));
      }
    }
    expect(await workbuddyHook('user-prompt-submit', workbuddyPrompt)).toBe('');
  }, 20_000);
});
