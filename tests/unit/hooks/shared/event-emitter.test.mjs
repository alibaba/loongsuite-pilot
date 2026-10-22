import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_HASH,
  hashStep,
  computeHash,
  shouldLogFullMessages,
  generateTraceId,
  generateSpanId,
} from '../../../../assets/hooks/shared/event-emitter.mjs';

describe('event-emitter chain hash', () => {
  it('INITIAL_HASH is 32 hex chars', () => {
    expect(INITIAL_HASH).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashStep is deterministic', () => {
    const h1 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    const h2 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashStep changes when message changes', () => {
    const h1 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    const h2 = hashStep(INITIAL_HASH, { role: 'user', content: 'bye' });
    expect(h1).not.toBe(h2);
  });

  it('computeHash matches step-by-step accumulation', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
    const expected = hashStep(hashStep(INITIAL_HASH, msgs[0]), msgs[1]);
    expect(computeHash(INITIAL_HASH, msgs)).toBe(expected);
  });

  it('shouldLogFullMessages true when chain is broken', () => {
    const delta = [{ role: 'user', content: 'x' }];
    // 假设 prev != initial,且 currentFullHash 不是从 prev + delta 算来 → 链断
    expect(shouldLogFullMessages(INITIAL_HASH, delta, 'fakehash')).toBe(true);
  });

  it('shouldLogFullMessages false when chain is consistent', () => {
    const delta = [{ role: 'user', content: 'x' }];
    const expected = computeHash(INITIAL_HASH, delta);
    expect(shouldLogFullMessages(INITIAL_HASH, delta, expected)).toBe(false);
  });
});

describe('event-emitter trace/span id', () => {
  it('generateTraceId returns 32 hex chars', () => {
    const t = generateTraceId();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generateSpanId returns 16 hex chars', () => {
    const s = generateSpanId();
    expect(s).toMatch(/^[0-9a-f]{16}$/);
  });

  it('successive calls return different ids', () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
    expect(generateSpanId()).not.toBe(generateSpanId());
  });
});

describe('writeJsonlRecords concurrency', () => {
  it('keeps every line valid JSON when two sessions append together', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-jsonl-'));
    const emitter = fileURLToPath(new URL('../../../../assets/hooks/shared/event-emitter.mjs', import.meta.url));
    const lines = 40;
    const pad = 'x'.repeat(2048);

    function writeSession(session) {
      const code = `
        import { writeJsonlRecords } from ${JSON.stringify(emitter)};
        const records = [];
        for (let i = 0; i < ${lines}; i++) {
          records.push({ session: ${JSON.stringify(session)}, i, pad: ${JSON.stringify(pad)} });
        }
        writeJsonlRecords(${JSON.stringify(logDir)}, 'grok-build', records);
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${session} exited ${code}`));
        });
      });
    }

    try {
      await Promise.all([writeSession('session-a'), writeSession('session-b')]);
      const files = fs.readdirSync(logDir).filter((name) => name.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const rows = fs.readFileSync(path.join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
      expect(rows).toHaveLength(lines * 2);
      const parsed = rows.map((line) => JSON.parse(line));
      expect(parsed.filter((row) => row.session === 'session-a')).toHaveLength(lines);
      expect(parsed.filter((row) => row.session === 'session-b')).toHaveLength(lines);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
