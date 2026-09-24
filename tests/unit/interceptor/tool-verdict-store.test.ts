import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  TOOL_VERDICT_TTL_MS,
  ToolVerdictStore,
} from '../../../src/interceptor/tool-verdict-store.js';

describe('tool verdict store', () => {
  it('keeps Pre and Post apart and overwrites the same key', () => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    const now = new Date('2026-09-23T08:00:00.000Z');
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', now);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PostToolUse' }, 'block', now);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'block', now);

    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBe('block');
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PostToolUse' }, now)).toBe('block');
    expect(store.get({ sessionId: 's2', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBeNull();
  });

  it('drops records older than 30 minutes', () => {
    const store = new ToolVerdictStore(checkpointFile());
    const writtenAt = new Date('2026-09-23T08:00:00.000Z');
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', writtenAt);
    const stillFresh = new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS);
    const expired = new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS + 1);
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, stillFresh)).toBe('allow');
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, expired)).toBeNull();
  });

  it('dumps one checkpoint file and restores it', () => {
    const file = checkpointFile();
    const now = new Date('2026-09-23T08:00:00.000Z');
    const store = new ToolVerdictStore(file);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', now);
    store.put({ toolUseId: 'call-2', phase: 'PostToolUse' }, 'block', now);
    store.dump(now);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema: number; records: unknown[] };
    expect(raw.schema).toBe(1);
    expect(raw.records).toEqual([
      {
        sessionId: 's1',
        toolUseId: 'call-1',
        phase: 'PreToolUse',
        action: 'allow',
        recordedAt: now.toISOString(),
      },
      {
        toolUseId: 'call-2',
        phase: 'PostToolUse',
        action: 'block',
        recordedAt: now.toISOString(),
      },
    ]);

    const restored = new ToolVerdictStore(file);
    restored.restore(now);
    expect(restored.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBe('allow');
    expect(restored.get({ toolUseId: 'call-2', phase: 'PostToolUse' }, now)).toBe('block');
  });

  it('ignores a corrupt or unknown checkpoint', () => {
    const file = checkpointFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{');
    const broken = new ToolVerdictStore(file);
    broken.restore();
    expect(broken.get({ toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ schema: 2, records: [] }));
    const unknown = new ToolVerdictStore(file);
    unknown.restore();
    expect(unknown.get({ toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();
  });

  it('does not restore records older than 30 minutes', () => {
    const file = checkpointFile();
    const writtenAt = new Date('2026-09-23T08:00:00.000Z');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: 1,
      records: [{
        sessionId: 's1',
        toolUseId: 'call-1',
        phase: 'PreToolUse',
        action: 'block',
        recordedAt: writtenAt.toISOString(),
      }],
    }));
    const store = new ToolVerdictStore(file);
    store.restore(new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS + 1));
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();
  });
});

function checkpointFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-verdict-')), 'tool-verdicts.json');
}
