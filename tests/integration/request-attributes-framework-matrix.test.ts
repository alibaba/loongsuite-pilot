import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { GrokBuildLogInput } from '../../src/inputs/grok-build-log/grok-build-log-input.js';
import { CodexTranscriptInput } from '../../src/inputs/codex-transcript/codex-transcript-input.js';
import { PiCodingAgentLogInput } from '../../src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { DshLogInput } from '../../src/inputs/dsh-log/dsh-log-input.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

type Framework = 'grok' | 'codex' | 'pi' | 'dsh';

// These tests execute production Hook processors or plugin callbacks, production
// Inputs and the Trace pipeline. Host events/logs are synthetic; no native CLI,
// model call, network exporter or customer environment is involved.
describe('request attributes across native producer/Input protocols', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  function installDsh(dir: string): void {
    const pluginDir = path.join(dir, 'plugins', 'dsh');
    const sharedDir = path.join(dir, 'plugins', 'shared');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.copyFileSync(path.resolve('assets/plugins/dsh/plugin.mjs'), path.join(pluginDir, 'plugin.mjs'));
    fs.copyFileSync(path.resolve('assets/plugins/shared/resource-context.mjs'), path.join(sharedDir, 'resource-context.mjs'));
    fs.writeFileSync(path.join(pluginDir, '.collection-enabled'), 'enabled\n');
  }

  async function produce(framework: Framework, dir: string, session: string, user: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('tests/fixtures/request-attributes/native-producer.mjs'), framework, dir, session, user], {
        env: { ...process.env, HOME: dir, LOONGSUITE_PILOT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${framework} producer ${session}: ${code} ${stderr}`)));
    });
  }

  async function collect(framework: Framework, dir: string, whileRunning?: () => Promise<void>) {
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = {
      export(batch, done) { spans.push(...batch); done({ code: 0 }); }, shutdown: async () => {},
    };
    const trace = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', dataDir: dir,
      serviceName: `request-attributes-${framework}`, spanAttributePassthroughPrefixes: ['memory.', 'multica.'],
      endpoints: [{ name: 'captured', endpoint: 'http://127.0.0.1:4318' }] }, undefined, () => exporter);
    const events = new MockFlusher('event-output');
    const manager = new InputManager();
    manager.setConfiguredUserId('collector-service-account');
    manager.setFlusher(new MultiFlusher([events, trace]));
    manager.setTraceLinker(new TraceLinker(new CorrelationStore(path.join(dir, 'acp-correlate'), {
      attributesEnabled: true, traceEnabled: false,
    }), { attributesEnabled: true, linkTrace: false, retries: 0 }));
    const store = new StateStore(path.join(dir, 'input-state.json'));
    await store.load();
    const options = { stateStore: store, pollIntervalMs: 50 };
    if (framework === 'codex') fs.mkdirSync(path.join(dir, 'native', 'codex', 'sessions'), { recursive: true });
    const input = framework === 'grok' ? new GrokBuildLogInput({ ...options, logDir: path.join(dir, 'logs', 'grok-build') })
      : framework === 'pi' ? new PiCodingAgentLogInput({ ...options, dataDir: dir })
        : framework === 'dsh' ? new DshLogInput({ ...options, sessionDir: path.join(dir, 'logs', 'dsh') })
          : new CodexTranscriptInput({ ...options, sessionDir: path.join(dir, 'native', 'codex', 'sessions'),
            wakeupDir: path.join(dir, 'state', 'codex', 'transcript-wakeups'),
            spanContextDir: path.join(dir, 'state', 'codex', 'transcript-span-contexts') });
    const rawEntries: AgentActivityEntry[] = [];
    // Snapshot before InputManager's event listener enqueues/mutates entries.
    input.on('entries', batch => rawEntries.push(...JSON.parse(JSON.stringify(batch))));
    manager.registerInput(input);
    try {
      await manager.startInput(input.id);
      if (whileRunning) {
        // Codex intentionally baselines historical transcripts on startup.
        // Start collection before the host sends requests, as in deployment.
        await whileRunning();
        await vi.waitFor(() => {
          expect(events.batchCalls.flat().filter(entry => entry['event.name'] === 'llm.response'))
            .toHaveLength(framework === 'pi' ? 24 : 12);
        }, { timeout: 10_000, interval: 25 });
      }
      await manager.stopAll();
      await trace.flush();
      await store.save();
      return { spans, entries: events.batchCalls.flat(), rawEntries };
    } finally { await manager.stopAll(); await trace.shutdown(); }
  }

  function evidence(framework: Framework, dir: string, result: Awaited<ReturnType<typeof collect>>): void {
    const evidenceRoot = process.env.PILOT_REQUEST_ATTRIBUTES_EVIDENCE_DIR;
    if (!evidenceRoot) return;
    const target = path.join(evidenceRoot, framework);
    fs.mkdirSync(target, { recursive: true });
    function jsonl(name: string, records: unknown[]) {
      fs.writeFileSync(path.join(target, name), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    }
    jsonl('adapter-events.jsonl', result.rawEntries);
    jsonl('events.jsonl', result.entries);
    jsonl('spans.jsonl', result.spans.map(span => ({
      name: span.name, kind: span.kind, traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId, parentSpanId: span.parentSpanId,
      startTime: span.startTime, endTime: span.endTime, duration: span.duration,
      status: span.status, attributes: span.attributes, resource: { attributes: span.resource.attributes },
      events: span.events, links: span.links, instrumentationLibrary: span.instrumentationLibrary,
    })));
    for (const source of ['logs', 'native', 'acp-correlate', path.join('state', 'codex')]) {
      const from = path.join(dir, source);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(target, 'source', source), { recursive: true });
    }
    fs.writeFileSync(path.join(target, 'summary.json'), JSON.stringify({
      framework, evidence: 'production producers and Inputs, synthetic host callbacks/transcripts, local capturing exporter',
      nativeAgentExecuted: false, modelRequested: false, cloudExported: false,
      concurrency: { nativeSessions: 4, businessUsers: 2, turnsPerSession: 3,
        prompt: 'identical across all sessions/turns', attributesByTurn: ['business user', 'empty placeholder', 'next business user'] },
      rawAdapterEvents: result.rawEntries.length, processedEvents: result.entries.length, exportedSpans: result.spans.length,
      agentSpans: result.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT').map(span => ({
        traceId: span.spanContext().traceId, attributes: span.attributes,
      })),
    }, null, 2) + '\n');
  }

  it.each<Framework>(['grok', 'codex', 'pi', 'dsh'])('%s keeps concurrent native sessions isolated, clears empty turns and resumes checkpoints', async framework => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pilot-request-${framework}-`));
    roots.push(dir);
    if (framework === 'dsh') installDsh(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ userId: 'producer-service-account', captureMessageContent: true }));
    const requests = Array.from({ length: 4 }, (_, index) => ({ session: `${framework}-session-${index}`, user: `business-user-${index % 2}` }));
    const result = await collect(framework, dir, () => Promise.all(
      requests.map(({ session, user }) => produce(framework, dir, session, user)),
    ).then(() => {}));
    evidence(framework, dir, result);
    const usedTraces = new Set<string>();
    for (const { session, user } of requests) {
      const entries = result.entries.filter(entry => entry['gen_ai.session.id'] === session);
      expect(entries.length, `no native Input output for ${session}`).toBeGreaterThan(0);
      const turns = [...new Set(entries.map(entry => String(entry['gen_ai.turn.id'])))];
      expect(turns, `${session}: producer must expose three native turns`).toHaveLength(3);
      if (framework === 'grok') {
        expect(turns).toEqual([0, 1, 2].map(index => `${session}-prompt-${index}`));
      } else if (framework === 'codex') {
        // Native Hook turn_id is namespaced by the transcript adapter.
        expect(turns).toEqual([0, 1, 2].map(index => `${session}:${session}-turn-${index}`));
      } else if (framework === 'dsh') {
        expect(turns).toEqual([1, 2, 3].map(index => `${session}:${index}`));
      } else {
        // The Pi extension creates this UUID internally. The caller cannot
        // predeclare it; this protocol exercises ordered prompt correlation.
        for (const turn of turns) expect(turn).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
      }
      for (const [index, turn] of turns.entries()) {
        const expectedUser = index === 1 ? undefined : index === 0 ? user : `${user}-next`;
        const expectedRequest = index === 1 ? undefined : `${session}-request-${index}`;
        const turnEntries = entries.filter(entry => entry['gen_ai.turn.id'] === turn);
        expect(turnEntries.every(entry => entry['memory.user_id'] === expectedUser
          && entry['memory.request_id'] === expectedRequest), `${session}/${turn}: entry attribution`).toBe(true);
        const traces = new Set(turnEntries.map(entry => String(entry.trace_id)));
        expect(traces.size).toBe(1);
        const traceId = [...traces][0];
        expect(usedTraces.has(traceId), `trace shared across requests: ${traceId}`).toBe(false);
        usedTraces.add(traceId);
        const spans = result.spans.filter(span => span.spanContext().traceId === traceId);
        expect(spans.length, `${session}/${turn}: missing exported spans`).toBeGreaterThan(0);
        expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')).toBe(true);
        expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
        expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toBe(true);
        if (framework === 'codex' || framework === 'pi') {
          expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toBe(true);
        }
        expect(spans.every(span => span.attributes['memory.user_id'] === expectedUser
          && span.attributes['memory.request_id'] === expectedRequest), `${session}/${turn}: span attribution`).toBe(true);
        if (framework === 'codex') {
          expect(spans.every(span => span.attributes['multica.issue.id'] === `${session}-hook-${index}`)).toBe(true);
        }
      }
    }
    expect(usedTraces.size).toBe(12);
    expect(result.spans.every(span => usedTraces.has(span.spanContext().traceId))).toBe(true);
    const replay = await collect(framework, dir);
    expect(replay.entries, 'checkpoint restart must not emit already accepted turns').toHaveLength(0);
    expect(replay.spans, 'checkpoint restart must not duplicate memory extraction input').toHaveLength(0);
  }, 30_000);
});
