import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpCorrelateRetentionService } from '../../../src/core/upstream-link/acp-correlate-retention-service.js';

describe('AcpCorrelateRetentionService', () => {
  let dataDir: string;
  let dir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ret-'));
    dir = path.join(dataDir, 'acp-correlate');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeFile(name: string, ageMs: number): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{}\n');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
    return p;
  }

  it('deletes files older than ttlMs, keeps fresh ones', async () => {
    const stale = writeFile('old.jsonl', 48 * 3600_000); // 48h
    const staleLock = writeFile('old.env.lock', 48 * 3600_000);
    const fresh = writeFile('new.jsonl', 60_000); // 1min

    const svc = new AcpCorrelateRetentionService(dataDir, { enabled: true, ttlMs: 24 * 3600_000 });
    const result = await svc.runCleanup();

    expect(result.deleted).toBe(2);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleLock)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('no-ops when the directory is absent', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const svc = new AcpCorrelateRetentionService(dataDir, { enabled: true, ttlMs: 1000 });
    const result = await svc.runCleanup();
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });
});
