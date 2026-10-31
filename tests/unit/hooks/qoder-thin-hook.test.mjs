import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const processor = fileURLToPath(new URL('../../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
let dataDir;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-thin-hook-')); });
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function sources(agentId) {
  const root = path.join(dataDir, 'state/qoder-transcripts', agentId, 'sources');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => path.join(root, name));
}

describe('Qoder thin installed entry point', () => {
  it.each(['qoder', 'qoder-cn'])('never opens transcript content or forks retry workers (%s)', agentId => {
    const transcript = path.join(dataDir, 'large.jsonl');
    fs.writeFileSync(transcript, '');
    fs.truncateSync(transcript, 128 * 1024 * 1024);
    const preload = path.join(dataDir, 'guard.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (file === process.env.TEST_TRANSCRIPT) throw new Error('transcript body opened by Hook');
        return read.call(this, file, ...args);
      };
      cp.spawn = () => { throw new Error('child process created by Hook'); };
      syncBuiltinESMExports();
    `);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const result = spawnSync(process.execPath, ['--import', preload, processor, '--agent-id', agentId], {
        input: JSON.stringify({ hook_event_name: event, session_id: 'session/../safe', transcript_path: transcript }),
        env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, TEST_TRANSCRIPT: transcript },
        encoding: 'utf8', timeout: 3000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('{}');
    }
    const found = sources(agentId);
    expect(found).toHaveLength(1);
    const source = JSON.parse(fs.readFileSync(path.join(found[0], 'source.json'), 'utf8'));
    expect(source.sessionId).toBe('session/../safe');
    expect(source.observedSize).toBe(128 * 1024 * 1024);
    const events = fs.readdirSync(path.join(found[0], 'events')).filter(name => name.endsWith('.json'));
    expect(events).toHaveLength(4);
    expect(events.map(name => JSON.parse(fs.readFileSync(path.join(found[0], 'events', name), 'utf8')).event).sort())
      .toEqual(['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  });

  it('coalesces duplicate wakeups at one file watermark without dropping distinct event facts', () => {
    const transcript = path.join(dataDir, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"type":"last-prompt"}\n');
    for (let index = 0; index < 8; index++) {
      const result = spawnSync(process.execPath, [processor, '--agent-id', 'qoder-cn'], {
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'same', transcript_path: transcript }),
        env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 3000,
      });
      expect(result.status).toBe(0);
    }
    const found = sources('qoder-cn');
    expect(found).toHaveLength(1);
    expect(fs.readdirSync(path.join(found[0], 'events')).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });
});
