import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe.runIf(process.platform === 'linux')('Hermes forked writer identity', () => {
  it('does not claim a PID from a parent-mounted procfs', () => {
    const plugin = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
    const driver = String.raw`
import importlib.util, json, os, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
real_read_text = pathlib.Path.read_text
def read_text(path, *args, **kwargs):
    if str(path) == '/proc/self/status':
        return 'Name:\tpython\nNSpid:\t999\t%s\n' % os.getpid()
    return real_read_text(path, *args, **kwargs)
with patch.object(pathlib.Path, 'read_text', read_text):
    print(json.dumps(p._process_identity()))
`;
    const result = spawnSync('python3', ['-c', driver, plugin], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('gives a child process its own source and owner even for an inherited turn', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fork-'));
    const plugin = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
    const driver = String.raw`
import importlib.util, json, os, pathlib, sys, time
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
state = p._session('shared')
turn = p._new_turn('shared', 'hello', '', 'shared-turn')
parent = p._common_fields(turn, state, 'llm.request', time.time_ns(), 'step', '')
p._write_records([parent])
child_pid = os.fork()
if child_pid == 0:
    record = p._common_fields(turn, state, 'llm.response', time.time_ns(), 'step', '')
    p._write_records([record])
    os._exit(0)
_, status = os.waitpid(child_pid, 0)
files = []
for filename in sorted((pathlib.Path(sys.argv[2]) / 'logs/hermes-agent').glob('*.jsonl')):
    for line in filename.read_text().splitlines():
        record = json.loads(line)
        files.append({'file': filename.name, 'event': record['event.name'], 'owner': record.get('agent.hermes.process')})
print(json.dumps({'parent': os.getpid(), 'child': child_pid, 'status': status, 'files': files}))
`;
    try {
      const result = spawnSync('python3', ['-c', driver, plugin, root], { encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' } });
      expect(result.status, result.stderr).toBe(0);
      const { parent, child, status, files } = JSON.parse(result.stdout);
      expect(status).toBe(0);
      expect(files).toHaveLength(2);
      const before = files.find(row => row.event === 'llm.request');
      const after = files.find(row => row.event === 'llm.response');
      expect(before.owner.pid).toBe(parent);
      expect(after.owner.pid).toBe(child);
      expect(before.file).not.toBe(after.file);
      expect(before.file).toBe(`hermes-agent-${before.owner.source_token}.jsonl`);
      expect(after.file).toBe(`hermes-agent-${after.owner.source_token}.jsonl`);
      expect(after.owner.source_token.startsWith(`${child}-`)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
