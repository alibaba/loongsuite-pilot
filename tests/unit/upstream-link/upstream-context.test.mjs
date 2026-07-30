import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordUpstreamContextOnce } from '../../../assets/hooks/shared/upstream-context.mjs';

const SID = 'ses_env_1';
const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('upstream-context.mjs (方案1 env hook helper)', () => {
  let dir;
  const savedTp = process.env.TRACEPARENT;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-env-'));
    delete process.env.TRACEPARENT;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTp === undefined) delete process.env.TRACEPARENT;
    else process.env.TRACEPARENT = savedTp;
  });

  const file = () => path.join(dir, 'acp-correlate', `${SID}.jsonl`);
  const lock = () => path.join(dir, 'acp-correlate', `${SID}.env.lock`);
  const readRecords = () =>
    fs.existsSync(file())
      ? fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  it('writes a session-level record from a valid TRACEPARENT', () => {
    process.env.TRACEPARENT = TP;
    recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'session', sessionId: SID, traceparent: TP });
    expect(fs.existsSync(lock())).toBe(true);
  });

  it('writes only once per session (O_CREAT|O_EXCL lock)', () => {
    process.env.TRACEPARENT = TP;
    recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    expect(readRecords()).toHaveLength(1);
  });

  it('does nothing when TRACEPARENT is absent', () => {
    recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(lock())).toBe(false);
  });

  it('rejects malformed / all-zero traceparent', () => {
    for (const bad of ['garbage', '00-xyz-abc-01', '00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-' + '0'.repeat(16) + '-01']) {
      process.env.TRACEPARENT = bad;
      recordUpstreamContextOnce({ agentId: 'qwen-code-cli', sessionId: SID, dataDir: dir });
    }
    expect(fs.existsSync(file())).toBe(false);
  });

  it('is fail-open on bad input (no throw)', () => {
    process.env.TRACEPARENT = TP;
    expect(() => recordUpstreamContextOnce({ agentId: 'x', sessionId: '', dataDir: dir })).not.toThrow();
    expect(() => recordUpstreamContextOnce({ agentId: 'x', sessionId: SID })).not.toThrow();
  });
});
