import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createCronContexts, MAX_CRON_CONTEXTS } from '../../../../assets/plugins/openclaw/cron-context.mjs';

describe('OpenClaw cron context recovery storage', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cron-context-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const value = runAtMs => ({ runAtMs, sessionKey: 'agent:main:test', sessionId: 'session',
    runId: 'native', turnId: 'turn', terminalEventId: 'end', traceId: '1234567890abcdef1234567890abcdef' });

  it('scans saved identities in bounded batches and retains old pending contexts', async () => {
    const contexts = createCronContexts(() => root, vi.fn());
    expect(contexts.write('first', value(100))).toBe(true);
    expect(contexts.write('second', value(200))).toBe(true);
    const dir = path.join(root, 'cron-contexts', 'openclaw');
    const old = path.join(dir, `${crypto.createHash('sha256').update('first').digest('hex')}.json`);
    const oldDate = new Date(Date.now() - 10 * 86400_000);
    fs.utimesSync(old, oldDate, oldDate);
    expect(contexts.write('third', value(300))).toBe(true);
    expect(contexts.read('first')?.runAtMs).toBe(100);
    const items = [];
    let more = true;
    while (more) {
      const batch = await contexts.listBatch(1);
      expect(batch.items.length).toBeLessThanOrEqual(1);
      items.push(...batch.items);
      more = batch.more;
    }
    expect(items.map(item => item.jobId).sort()).toEqual(['first', 'second', 'third']);
    await contexts.closeScan();
  });

  it('preserves existing pending contexts and fails open when its bounded store is full', () => {
    const errors = vi.fn();
    const contexts = createCronContexts(() => root, errors);
    expect(contexts.write('existing', value(100))).toBe(true);
    const dir = path.join(root, 'cron-contexts', 'openclaw');
    for (let i = 0; i < MAX_CRON_CONTEXTS - 1; i++) {
      fs.writeFileSync(path.join(dir, `${i.toString(16).padStart(64, '0')}.json`), '{}');
    }
    expect(contexts.write('new', value(200))).toBe(false);
    expect(contexts.read('existing')?.runAtMs).toBe(100);
    expect(contexts.write('existing', value(101))).toBe(true);
    expect(contexts.read('existing')?.runAtMs).toBe(101);
    expect(errors).toHaveBeenCalledWith('cron-context-write', expect.any(Error));
  });

  it('keeps corrupt files for diagnosis without logging them on every recovery scan', async () => {
    const errors = vi.fn();
    const contexts = createCronContexts(() => root, errors);
    expect(contexts.write('valid', value(100))).toBe(true);
    const dir = path.join(root, 'cron-contexts', 'openclaw');
    const bad = path.join(dir, `${'a'.repeat(64)}.json`);
    fs.writeFileSync(bad, '{');
    for (let i = 0; i < 2; i++) {
      const result = await contexts.listBatch();
      expect(result.items.map(item => item.jobId)).toEqual(['valid']);
    }
    expect(fs.existsSync(bad)).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
