import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { bindProcessUpstreamTurn, bindUpstreamTurn, prepareUpstreamTurn, readUpstreamTurn, normalizeUpstreamCarrier, readUpstreamSession } from '../../../assets/hooks/shared/upstream-ingress.mjs';
import { recordUpstreamContextOnce } from '../../../assets/hooks/shared/upstream-context.mjs';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.ts';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.ts';
import { AcpCorrelateRetentionService } from '../../../src/core/upstream-link/acp-correlate-retention-service.ts';
import { createHash } from 'node:crypto';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const SECOND_TP = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
const cli = path.resolve('assets/hooks/shared/upstream-ingress-cli.mjs');
const processor = path.resolve('assets/hooks/claude-code-hook-processor.mjs');

describe('shared upstream ingress', () => {
  let dataDir;
  const savedTp = process.env.TRACEPARENT;
  const savedState = process.env.TRACESTATE;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ingress-')); });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (savedTp === undefined) delete process.env.TRACEPARENT; else process.env.TRACEPARENT = savedTp;
    if (savedState === undefined) delete process.env.TRACESTATE; else process.env.TRACESTATE = savedState;
  });
  const binding = (nativeTurnId = 'prompt-1', carrier = { traceparent: TP, tracestate: 'vendor=value' }, agentId = 'claude-code') => ({ dataDir, agentId, sessionId: 'session-1', nativeTurnId, carrier });
  const entry = (nativeTurnId, agentId = 'claude-code') => ({ 'event.name': 'other', 'gen_ai.session.id': 'session-1', 'gen_ai.turn.id': nativeTurnId,
    'gen_ai.agent.type': agentId, 'agent.pilot.correlation.native_turn_id': nativeTurnId, trace_id: 'local',
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'same input' }] }] });

  it('binds exact request identity, is idempotent and rejects conflicting reparenting', () => {
    expect(bindUpstreamTurn(binding())).toEqual({ recorded: true });
    expect(bindUpstreamTurn(binding())).toEqual({ recorded: true });
    expect(bindUpstreamTurn(binding('prompt-1', { traceparent: SECOND_TP }))).toEqual({ recorded: false, reason: 'conflict' });
    expect(readUpstreamTurn(path.join(dataDir, 'acp-correlate'), 'claude-code', 'session-1', 'prompt-1')).toEqual(binding().carrier);
    const file = fs.readdirSync(path.join(dataDir, 'acp-correlate'))[0];
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dataDir, 'acp-correlate', file)).mode & 0o777).toBe(0o600);
  });

  it('keeps identical concurrent prompts and Agent namespaces isolated and survives restart', async () => {
    bindUpstreamTurn(binding());
    bindUpstreamTurn(binding('prompt-2', { traceparent: SECOND_TP }));
    bindUpstreamTurn(binding('prompt-1', { traceparent: SECOND_TP }, 'opencode'));
    for (const entries of [[entry('prompt-2'), entry('prompt-1'), entry('prompt-1', 'opencode')], [entry('prompt-1')]]) {
      await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }).stamp(entries);
      for (const record of entries) expect(record.trace_id).toBe(record['gen_ai.agent.type'] === 'opencode' || record['gen_ai.turn.id'] === 'prompt-2'
        ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '4bf92f3577b34da6a3ce929d0e0e4736');
    }
  });

  it('links an exact native model request when the host omits the input hook', async () => {
    bindUpstreamTurn(binding('run-1', { traceparent: TP }, 'openclaw'));
    const request = { ...entry('run-1', 'openclaw'), 'event.name': 'llm.request' };
    const stranger = { ...entry('run-2', 'openclaw'), 'event.name': 'llm.request' };
    await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 })
      .stamp([request, stranger]);
    expect(request.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(stranger.trace_id).toBe('local');
  });

  it('allows each process request to claim one native turn on a resumed session', () => {
    const env = { TRACEPARENT: TP, TRACESTATE: 'vendor=value', LOONGSUITE_PILOT_INGRESS_REQUEST_ID: 'request-1' };
    expect(bindProcessUpstreamTurn({ ...binding(), env }).recorded).toBe(true);
    expect(bindProcessUpstreamTurn({ ...binding(), env }).recorded).toBe(true);
    expect(bindProcessUpstreamTurn({ ...binding('prompt-2'), env })).toEqual({ recorded: false, reason: 'conflict' });
    const secondEnv = { ...env, TRACEPARENT: SECOND_TP, LOONGSUITE_PILOT_INGRESS_REQUEST_ID: 'request-2' };
    expect(bindProcessUpstreamTurn({ ...binding('prompt-2'), env: secondEnv }).recorded).toBe(true);
    expect(readUpstreamTurn(path.join(dataDir, 'acp-correlate'), 'claude-code', 'session-1', 'prompt-2')?.traceparent).toBe(SECOND_TP);
  });

  it('waits for native identity after an adapter announces a pending binding', async () => {
    const bind = prepareUpstreamTurn(binding('prompt-2'));
    expect(bind).toBeTypeOf('function');
    const record = entry('prompt-2');
    const linker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 2, retryDelayMs: 10 });
    const stamping = linker.stamp([record]);
    expect(record.trace_id).toBe('local');
    expect(bind('prompt-2').recorded).toBe(true);
    await stamping;
    expect(record.trace_id).toBe(TP.split('-')[1]);
    const unbound = entry('prompt-3');
    await linker.stamp([unbound]);
    expect(unbound.trace_id).toBe('local');
  });

  it('rejects malformed carriers, corrupt/oversized/symlinked state and invalid identities without throwing', () => {
    for (const carrier of [null, { traceparent: 'garbage' }, { traceparent: TP, tracestate: '\r\nAuthorization: secret' }, { traceparent: TP, tracestate: 'a'.repeat(513) }]) {
      expect(bindUpstreamTurn(binding('prompt-1', carrier))).toEqual({ recorded: false, reason: 'invalid' });
    }
    expect(bindUpstreamTurn({ ...binding(), nativeTurnId: '' }).recorded).toBe(false);
    expect(bindUpstreamTurn({ ...binding(), dataDir: '/dev/null/not-a-directory' }).recorded).toBe(false);
    bindUpstreamTurn(binding());
    const file = path.join(dataDir, 'acp-correlate', fs.readdirSync(path.join(dataDir, 'acp-correlate'))[0]);
    fs.writeFileSync(file, '{');
    expect(readUpstreamTurn(path.dirname(file), 'claude-code', 'session-1', 'prompt-1')).toBeNull();
    expect(bindUpstreamTurn(binding()).reason).toBe('conflict');
    fs.writeFileSync(file, ' '.repeat(8193));
    expect(readUpstreamTurn(path.dirname(file), 'claude-code', 'session-1', 'prompt-1')).toBeNull();
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(dataDir, 'absent'), file);
    expect(readUpstreamTurn(path.dirname(file), 'claude-code', 'session-1', 'prompt-1')).toBeNull();
  });

  it('supports future-version W3C traceparent but rejects version-00 extra fields and zero IDs', () => {
    expect(normalizeUpstreamCarrier({ TRACEPARENT: TP.toUpperCase(), TRACESTATE: 'a=b' })).toEqual({ traceparent: TP, tracestate: 'a=b' });
    expect(normalizeUpstreamCarrier({ traceparent: TP.replace(/^00/, '01') + '-future' })).not.toBeNull();
    for (const traceparent of [TP + '-extra', TP.replace(/^00/, 'ff'), TP.replace('4bf92f3577b34da6a3ce929d0e0e4736', '0'.repeat(32))]) expect(normalizeUpstreamCarrier({ traceparent })).toBeNull();
  });

  it('offers a dependency-free language-neutral stdin CLI with bounded input', () => {
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(binding()), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ recorded: true });
    const invalid = spawnSync(process.execPath, [cli], { input: ' '.repeat(9000), encoding: 'utf8' });
    expect(JSON.parse(invalid.stdout).recorded).toBe(false);
  });

  it('captures env at UserPromptSubmit without tools and applies it to the first turn only', async () => {
    const result = spawnSync(process.execPath, [processor, 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'session-1', prompt_id: 'prompt-1' }),
      encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, TRACEPARENT: TP, TRACESTATE: 'vendor=value' } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    const records = [entry('prompt-1'), entry('prompt-2')];
    await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }).stamp(records);
    expect(records[0]['agent.pilot.upstream.tracestate']).toBe('vendor=value');
    expect(records[0].trace_id).toBe(TP.split('-')[1]);
    expect(records[1].trace_id).toBe('local');
  });

  it('recovers the complete env marker when the compatibility append did not finish', async () => {
    process.env.TRACEPARENT = TP;
    process.env.TRACESTATE = 'vendor=value';
    recordUpstreamContextOnce({ agentId: 'claude-code', sessionId: 'session-1', dataDir });
    const dir = path.join(dataDir, 'acp-correlate');
    fs.unlinkSync(path.join(dir, 'session-1.jsonl'));
    expect(readUpstreamSession(dir, 'session-1')).toEqual({ traceparent: TP, tracestate: 'vendor=value' });
    const record = entry('prompt-1');
    await new TraceLinker(new CorrelationStore(dir), { retries: 0 }).stamp([record]);
    expect(record.trace_id).toBe(TP.split('-')[1]);
  });

  it('does not apply a late binding to a published negative cache', async () => {
    const linker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 });
    await linker.stamp([entry('prompt-1')]);
    bindUpstreamTurn(binding());
    const record = entry('prompt-1');
    await linker.stamp([record]);
    expect(record.trace_id).toBe('local');
  });

  it('binds exact native input identity without content but does not use metadata to consume env', async () => {
    bindUpstreamTurn(binding());
    const exact = entry('prompt-1');
    delete exact['gen_ai.input.messages_delta'];
    const linker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 });
    await linker.stamp([exact]);
    expect(exact.trace_id).toBe(TP.split('-')[1]);
    process.env.TRACEPARENT = SECOND_TP;
    recordUpstreamContextOnce({ agentId: 'claude-code', sessionId: 'session-1', dataDir });
    const metadata = entry('missing-binding');
    delete metadata['gen_ai.input.messages_delta'];
    const first = entry('real-input');
    const freshLinker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 });
    await freshLinker.stamp([metadata, first]);
    expect(metadata.trace_id).toBe('local');
    expect(first.trace_id).toBe('local');
  });

  it('keeps pre-upgrade legacy claims authoritative after adding tracestate', () => {
    const dir = path.join(dataDir, 'acp-correlate');
    fs.mkdirSync(dir);
    const hash = createHash('sha256').update('same input').digest('hex').slice(0, 16);
    const identity = { type: 'turn', contentHash: hash, traceparent: TP };
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    fs.writeFileSync(path.join(dir, 'session-1.jsonl'), JSON.stringify({ ...identity, tracestate: 'vendor=value' }) + '\n');
    fs.writeFileSync(path.join(dir, `session-1.turn-context-0-${digest}.done`), JSON.stringify({ turnId: 'old-owner' }));
    expect(new CorrelationStore(dir).resolveTurnContext('session-1', 'same input', 'new-owner')).toBeNull();
    expect(new CorrelationStore(dir).resolveTurnContext('session-1', 'same input', 'old-owner')?.tracestate).toBe('vendor=value');
  });

  it('removes expired native bindings with the existing retention cadence', async () => {
    bindUpstreamTurn(binding());
    const dir = path.join(dataDir, 'acp-correlate');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const stale = new Date(Date.now() - 100000);
    fs.utimesSync(file, stale, stale);
    await new AcpCorrelateRetentionService(dataDir, { enabled: true, ttlMs: 1000 }).runCleanup();
    expect(readUpstreamTurn(dir, 'claude-code', 'session-1', 'prompt-1')).toBeNull();
  });
});
