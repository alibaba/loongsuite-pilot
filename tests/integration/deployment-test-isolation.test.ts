import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { agentHomeEnvironment } from '../helpers/isolated-agent-home.js';

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function snapshot(dir: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files[relative + path.sep] = 'directory';
      Object.assign(files, await snapshot(absolute, relative));
    } else {
      const stat = await fs.stat(absolute);
      files[relative] = JSON.stringify({
        content: await fs.readFile(absolute, 'utf8'),
        mode: stat.mode,
        mtime: stat.mtimeMs,
      });
    }
  }
  return files;
}

it('sets the native user home before worker threads start', () => {
  const home = os.homedir();
  expect(home).toBe(process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
  expect(path.basename(home)).toMatch(/^pilot-test-suite-home-/);
});

it('deployment tests leave the launching user home unchanged, including legacy plugins', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-test-isolation-'));
  const home = path.join(root, 'launching-user');
  const temp = path.join(root, 'tmp');
  await fs.mkdir(temp, { recursive: true });
  const fixtures: Record<string, string> = {
    '.claude/settings.json': JSON.stringify({ hooks: { Stop: [
      { hooks: [{ command: '/legacy/otel-claude-hook stop' }] },
    ] }, customer: 'keep' }),
    '.claude/otel-config.json': '{}',
    '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [
      { hooks: [{ command: '/legacy/otel-codex-hook stop' }] },
    ] } }),
    '.codex/config.toml': '[features]\ncodex_hooks = true\n',
    '.codex/otel-config.json': '{}',
    '.cache/opentelemetry.instrumentation.claude/fixture.txt': 'keep',
    '.cache/opentelemetry.instrumentation.codex/fixture.txt': 'keep',
    '.cursor/hooks.json': '{}',
    '.grok/hooks/loongsuite-pilot.json': '{}',
    '.config/opencode/opencode.json': '{"plugin":["customer-plugin"]}',
    '.pi/agent/settings.json': '{"extensions":["customer-extension"]}',
    '.hermes/plugins/loongsuite-pilot/.loongsuite-pilot-managed.json': '{}',
  };
  for (const rc of ['.bashrc', '.zshrc', '.bash_profile']) {
    fixtures[rc] = '# BEGIN otel-claude-hook\nexport LEGACY_FIXTURE=yes\n# END otel-claude-hook\n';
  }
  for (const [relative, content] of Object.entries(fixtures)) {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const before = await snapshot(home);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const vitest = path.join(repo, 'node_modules', 'vitest', 'vitest.mjs');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    vitest, 'run',
    'tests/unit/deployment/inject-command.test.ts',
    'tests/unit/deployment/deployment-manager.test.ts',
    'tests/unit/deployment/eager-vs-daemon-parity.test.ts',
    'tests/unit/core/orchestrator.test.ts',
    'tests/integration/opencode-watchdog-selfheal.test.ts',
    'tests/unit/deployment/isolated-agent-home.test.ts',
    '--pool=threads', '--maxWorkers=1', '--minWorkers=1', '--reporter=dot',
  ], {
    cwd: repo,
    timeout: 40_000,
    env: {
      ...process.env,
      ...agentHomeEnvironment(home),
      TMPDIR: temp, TMP: temp, TEMP: temp,
    },
  });
  expect(await snapshot(home), stdout + stderr).toEqual(before);
}, 45_000);
