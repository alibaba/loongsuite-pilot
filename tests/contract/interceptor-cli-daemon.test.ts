import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist/interceptor/cli.cjs');
const DAEMON = join(process.cwd(), 'dist/interceptor/daemon.cjs');

function spawnNode(entry: string, args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  child: ChildProcess;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
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

  it.skipIf(!built)('allows when switches are empty and fail-opens when the daemon is down', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-contract-'));
    await mkdir(join(dataDir, 'versions', '1.0.2'), { recursive: true });
    await writeFile(join(dataDir, 'current'), '1.0.2\n');
    await writeFile(join(dataDir, 'versions', '1.0.2', 'VERSION'), 'version=1.0.2\ngit_commit=test\n');
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({ interceptor: {} })}\n`);

    const env = {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      AGENT_DATA_COLLECTION_CONFIG: join(dataDir, 'config.json'),
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

    const allowed = await spawnNode(CLI, ['hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe('');

    child.kill('SIGTERM');
    await new Promise((resolve) => child?.once('exit', resolve));
    child = undefined;

    const down = await spawnNode(CLI, ['hook', '--agent', 'qoder'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }));
    expect(down.code).toBe(0);
    expect(down.stdout).toBe('');
  }, 20_000);
});
