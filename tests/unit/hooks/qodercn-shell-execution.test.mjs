import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';

const HOOK_DIR = resolve('assets/hooks');
const HOOK = 'qodercn-loongsuite-pilot-hook.sh';
const DASH_AVAILABLE = spawnSync('dash', ['-c', 'exit 0']).status === 0;
const LAUNCHERS = [
  { name: 'direct', command: script => [script] },
  { name: 'bash', command: script => ['bash', script] },
  { name: 'bash --posix', command: script => ['bash', '--posix', script] },
  { name: 'sh', command: script => ['sh', script] },
  { name: 'dash', command: script => ['dash', script], skip: !DASH_AVAILABLE },
  { name: 'inherited POSIXLY_CORRECT', command: script => ['sh', script],
    env: { POSIXLY_CORRECT: '1' } },
];
const INPUT = '{"prompt":"中文 payload with spaces"}\n\n';
const CAPTURE = `import fs from 'node:fs';
console.log(JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));
`;

async function withInstallation(run) {
  const root = mkdtempSync(join(tmpdir(), "pilot hook's shell-"));
  const data = join(root, '.loongsuite-pilot');
  const hooks = join(data, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(data, 'node-bin'), process.execPath + '\n');
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOONGSUITE_PILOT_DATA_DIR: data,
    LOONGSUITE_PILOT_CACHE_DIR: data,
  };
  delete env.BASH_ENV;
  delete env.ENV;
  delete env.POSIXLY_CORRECT;
  try { return await run({ root, data, hooks, env }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function execute(launcher, script, args, env, input = INPUT) {
  const [command, ...prefix] = launcher.command(script);
  return spawnSync(command, [...prefix, ...args], {
    env: { ...env, ...launcher.env }, input, encoding: 'utf8', timeout: 10_000,
  });
}

function expectSuccess(result) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe.skipIf(process.platform === 'win32')('Qoder CN Hook shell execution', () => {
  for (const launcher of LAUNCHERS) {
    it.skipIf(launcher.skip)(`hands stdin and the agent argument to Node via ${launcher.name}`, async () => {
      await withInstallation(({ hooks, env }) => {
        const script = join(hooks, HOOK);
        copyFileSync(join(HOOK_DIR, HOOK), script);
        chmodSync(script, 0o755);
        writeFileSync(join(hooks, 'qoder-hook-processor.mjs'), CAPTURE);
        const customAgent = "agent '中文 with spaces";
        const result = execute(launcher, script, [customAgent], env);
        expectSuccess(result);
        expect(JSON.parse(result.stdout)).toEqual({
          args: ['--agent-id', customAgent], stdin: INPUT,
        });
      });
    });
  }

  // Execute the shipped processor as well as the wrapper: an exit code of zero
  // alone could mean the wrapper silently skipped collection.
  for (const launcher of LAUNCHERS) {
    it.skipIf(launcher.skip)(`collects a Qoder CN transcript via ${launcher.name} without replay`, async () => {
      await withInstallation(async ({ data, hooks, env }) => {
        const script = join(hooks, HOOK);
        // Model an upgrade from the failing wrapper and run the real asset
        // installer, rather than assuming the patched source reaches users.
        writeFileSync(script, '#!/usr/bin/env bash\nset -euo pipefail\n');
        const install = spawnSync(process.execPath, [resolve('scripts/postinstall.js')], {
          env, encoding: 'utf8', timeout: 10_000,
        });
        expectSuccess(install);
        expect(readFileSync(script, 'utf8')).toBe(readFileSync(join(HOOK_DIR, HOOK), 'utf8'));
        const transcript = join(data, 'transcript.jsonl');
        const sessionId = 'qodercn-shell-test';
        const rows = [
          { type: 'user', uuid: 'u1', timestamp: '2026-10-20T10:00:00.000Z',
            sessionId, message: { role: 'user', content: 'shell compatibility prompt' } },
          { type: 'assistant', uuid: 'a1', timestamp: '2026-10-20T10:00:01.000Z',
            sessionId, message: { role: 'assistant', id: 'm1',
              content: [{ type: 'text', text: 'shell compatibility answer' }], stop_reason: 'end_turn' } },
          { type: 'last-prompt', sessionId, lastPrompt: 'shell compatibility prompt' },
        ];
        writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: data });
        expectSuccess(execute(launcher, script, [], env, payload));
        expect(readFileSync(join(hooks, 'qoder/hook-wakeup.mjs'), 'utf8'))
          .toBe(readFileSync(join(HOOK_DIR, 'qoder/hook-wakeup.mjs'), 'utf8'));
        const collector = new QoderTranscriptCollector({ dataDir: data, agentId: 'qoder-cn' });
        const first = await collector.collect({});
        const records = first.records;
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(record => record['gen_ai.session.id'] === sessionId)).toBe(true);
        expect(records.every(record => record['gen_ai.agent.type'] === 'qoder-cn')).toBe(true);
        const serialized = JSON.stringify(records);
        expect(serialized).toContain('shell compatibility prompt');
        expect(serialized).toContain('shell compatibility answer');
        expectSuccess(execute(launcher, script, [], env, payload));
        expect((await collector.collect(first.state)).records).toEqual([]);
        collector.stop();
      });
    });
  }
});
