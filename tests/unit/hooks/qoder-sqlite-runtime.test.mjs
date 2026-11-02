import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
describe.each(['qoder', 'qodercn'])('%s SQLite runtime selection', name => {
  it('distinguishes unavailable SQLite from lock contention and preserves the Hook protocol', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-no-sqlite-')); roots.push(root);
    const transcript = path.join(root, 'native.jsonl'); fs.writeFileSync(transcript, '');
    const agent = name === 'qoder' ? 'qoder' : 'qoder-cn';
    const result = spawnSync(process.execPath, ['--no-experimental-sqlite', path.resolve('assets/hooks/qoder-hook-processor.mjs'), '--agent-id', agent], {
      input: JSON.stringify({ session_id: 'synthetic-runtime', transcript_path: transcript, hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('{}'); expect(result.stderr).toBe('');
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, 'state/qoder-transcripts', agent, 'capacity.json'), 'utf8'));
    expect(diagnostic.reason).toBe('runtime-sqlite-unavailable');
  });
  it.each([['18.20.8', false], ['20.19.0', false], ['22.12.0', false], ['22.13.0', true],
    ['22.22.2', true], ['23.3.0', false], ['23.4.0', true], ['24.0.0', true]])('validates managed runtime %s without spawning it', (version, accepted) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-sqlite-runtime-')); roots.push(root);
    const node = path.join(root, 'runtime', 'node-v' + version, 'bin/node'); fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const source = fs.readFileSync(path.resolve('assets/hooks', name + '-loongsuite-pilot-hook.sh'), 'utf8');
    const functions = ['node_is_suitable', 'node_major_from_runtime_path', 'node_is_app_bundle']
      .map(fn => source.match(new RegExp(fn + '\\(\\) \\{[\\s\\S]*?\\n\\}'))[0]).join('\n');
    const result = spawnSync('bash', ['-c', 'MIN_NODE_MAJOR=22\n' + functions + '\nnode_is_suitable "$1"', 'test', node], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
  });
});
