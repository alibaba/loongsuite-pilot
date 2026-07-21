import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { contentHash } from '../../../src/utils/content-hash.js';

const SID = 'ses_abc123';
const TP1 = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TP2 = '00-2370c4052bf954474d8c490b9ccce247-6ec62402a158c33c-01';
const TP_SESS = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';

function turnRec(text: string, traceparent: string, prefixLen = 128) {
  return JSON.stringify({
    type: 'turn',
    sessionId: SID,
    contentHash: contentHash(text),
    contentPrefix: text.slice(0, prefixLen),
    traceparent,
  });
}

describe('CorrelationStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-corr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(lines: string[]): void {
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.join('\n') + '\n');
  }

  it('resolves by exact content hash', () => {
    write([turnRec('hello world', TP1)]);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn(SID, 'hello world')).toBe(TP1);
  });

  it('resolves by prefix when collected text was rewritten (e.g. @file appended)', () => {
    write([turnRec('analyze this', TP1)]);
    const store = new CorrelationStore(dir);
    // collected side appended a file reference; wire text is a prefix
    expect(store.resolveTurn(SID, 'analyze this@file:///x.py')).toBe(TP1);
  });

  it('consume-once: duplicate prompts get distinct records in order', () => {
    write([turnRec('OK', TP1), turnRec('HELLO', TP2), turnRec('OK', TP_SESS)]);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn(SID, 'OK')).toBe(TP1); // first OK
    expect(store.resolveTurn(SID, 'HELLO')).toBe(TP2);
    expect(store.resolveTurn(SID, 'OK')).toBe(TP_SESS); // second OK -> third record
    expect(store.resolveTurn(SID, 'OK')).toBeNull(); // no more
  });

  it('resolveSessionFirst returns once then null', () => {
    write([JSON.stringify({ type: 'session', sessionId: SID, traceparent: TP_SESS })]);
    const store = new CorrelationStore(dir);
    expect(store.resolveSessionFirst(SID)).toBe(TP_SESS);
    expect(store.resolveSessionFirst(SID)).toBeNull();
  });

  it('returns null for unknown session / no match', () => {
    write([turnRec('known', TP1)]);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn('ses_other', 'known')).toBeNull();
    expect(store.resolveTurn(SID, 'unknown text')).toBeNull();
  });

  it('ignores malformed lines without throwing', () => {
    write(['not json', turnRec('valid', TP1), '{"type":"turn"}']);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn(SID, 'valid')).toBe(TP1);
  });

  it('exact contentHash takes precedence over a prefix match', () => {
    // recordA matches "analyze" as a prefix; recordB is the exact hash of the
    // collected text. The exact record must win (and be the one consumed).
    write([turnRec('analyze', TP1, 7), turnRec('analyze this', TP2)]);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn(SID, 'analyze this')).toBe(TP2); // exact B, not prefix A
    expect(store.resolveTurn(SID, 'analyze xyz')).toBe(TP1); // A still available for a prefix hit
  });

  it('hasSession reflects file presence', () => {
    write([turnRec('x', TP1)]);
    const store = new CorrelationStore(dir);
    expect(store.hasSession(SID)).toBe(true);
    expect(store.hasSession('ses_missing')).toBe(false);
  });

  it('pruneIdle evicts sessions not accessed since the cutoff', () => {
    write([turnRec('OK', TP1)]);
    const store = new CorrelationStore(dir);
    expect(store.resolveTurn(SID, 'OK')).toBe(TP1); // consumes + records access
    // Nothing older than a past cutoff -> keep; record stays consumed.
    expect(store.pruneIdle(Date.now() - 60_000)).toBe(0);
    expect(store.resolveTurn(SID, 'OK')).toBeNull();
    // Evict everything older than the future -> state dropped, cursor resets.
    expect(store.pruneIdle(Date.now() + 1000)).toBe(1);
    expect(store.resolveTurn(SID, 'OK')).toBe(TP1);
  });
});
