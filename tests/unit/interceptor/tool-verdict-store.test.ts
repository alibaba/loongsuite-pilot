import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  cleanupToolVerdicts,
  maybeCleanupToolVerdicts,
  readToolVerdict,
  writeToolVerdict,
} from '../../../src/interceptor/tool-verdict-store.js';

describe('tool verdict store', () => {
  it('isolates agent, session, and Pre/Post phases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const now = new Date('2026-09-23T08:00:00.000Z');
    expect(writeToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PreToolUse',
    }, 'allow', root, now)).toBe(true);
    expect(writeToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PostToolUse',
    }, 'deny', root, now)).toBe(true);

    expect(readToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PreToolUse',
    }, root, now)?.result).toBe('allow');
    expect(readToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PostToolUse',
    }, root, now)?.result).toBe('deny');
    expect(readToolVerdict({
      agent: 'qodercli',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PreToolUse',
    }, root, now)).toBeNull();
    expect(readToolVerdict({
      agent: 'qoder',
      sessionId: 's2',
      toolUseId: 'call-1',
      phase: 'PreToolUse',
    }, root, now)).toBeNull();
  });

  it('overwrites the same key atomically and preserves unknown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const now = new Date('2026-09-23T08:00:00.000Z');
    const key = {
      agent: 'openclaw' as const,
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PreToolUse' as const,
    };
    writeToolVerdict(key, 'allow', root, now);
    writeToolVerdict(key, 'unknown', root, now);
    expect(readToolVerdict(key, root, now)?.result).toBe('unknown');
  });

  it('removes expired buckets and enforces a hard record cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const now = new Date('2026-09-23T08:00:00.000Z');
    const oldDir = path.join(root, '2026-09-01');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'old.json'), '{}');
    for (let i = 0; i < 4; i += 1) {
      writeToolVerdict({
        agent: 'qwen-work-cn',
        sessionId: 's1',
        toolUseId: `call-${i}`,
        phase: 'PostToolUse',
      }, 'allow', root, now);
    }

    const result = cleanupToolVerdicts(root, now, 2);
    await expect(fs.stat(oldDir)).rejects.toThrow();
    const current = (await fs.readdir(path.join(root, '2026-09-23')))
      .filter(name => name.endsWith('.json'));
    expect(current).toHaveLength(2);
    expect(result.kept).toBe(2);
  });

  it('treats truncated or mismatched files as a miss', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const now = new Date('2026-09-23T08:00:00.000Z');
    const key = {
      agent: 'qoder' as const,
      sessionId: 's1',
      toolUseId: 'broken',
      phase: 'PreToolUse' as const,
    };
    writeToolVerdict(key, 'allow', root, now);
    const files = await fs.readdir(path.join(root, '2026-09-23'));
    await fs.writeFile(path.join(root, '2026-09-23', files[0]!), '{');
    expect(readToolVerdict(key, root, now)).toBeNull();
  });

  it('looks back across retained UTC buckets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const writtenAt = new Date('2026-09-20T08:00:00.000Z');
    const now = new Date('2026-09-23T08:00:00.000Z');
    const key = {
      agent: 'openclaw' as const,
      sessionId: 's1',
      toolUseId: 'old-call',
      phase: 'PostToolUse' as const,
    };
    writeToolVerdict(key, 'deny', root, writtenAt);
    expect(readToolVerdict(key, root, now)?.result).toBe('deny');
    expect(readToolVerdict(key, root, new Date('2026-09-28T08:00:00.000Z'))).toBeNull();
  });

  it('skips cleanup when another process holds the lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-verdict-'));
    const now = new Date('2026-09-23T08:00:00.000Z');
    const oldDir = path.join(root, '2026-09-01');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'old.json'), '{}');
    await fs.writeFile(path.join(root, '.cleanup-lock'), '');
    maybeCleanupToolVerdicts(root, now);
    await expect(fs.stat(oldDir)).resolves.toBeDefined();
  });
});
