import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect, it, vi } from 'vitest';
import { deriveSpanId, toW3CTraceId } from '../../assets/hooks/shared/event-emitter.mjs';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { ZCodeHookInput } from '../../src/inputs/zcode-hook/zcode-hook-input.js';
import { ZCodeRolloutInput } from '../../src/inputs/zcode-rollout/zcode-rollout-input.js';

class TestHookInput extends ZCodeHookInput {
  async poll() { this.emit('entries', await this.collect()); }
}

class TestRolloutInput extends ZCodeRolloutInput {
  async poll() { this.emit('entries', await this.collect()); }
}

const fixtures = path.resolve('tests/unit/hooks/zcode/fixtures');

it.each([
  'hook-first', 'rollout-first', 'no-hook', 'continued-stop', 'legacy-envelope',
  'documented-stop', 'interrupted-eof', 'native-history-error', 'native-history-error-private',
])
  ('collects native ZCode records with %s delivery', async (order) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-zcode-dual-'));
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '');
  const state = new StateStore(path.join(root, 'state.json'));
  const logDir = path.join(root, 'logs', 'zcode');
  const rolloutDir = path.join(root, '.zcode', 'cli', 'rollout');
  const hook = new TestHookInput({ stateStore: state, logDir });
  const rollout = new TestRolloutInput({ stateStore: state, rolloutDir });
  const spans: ReadableSpan[] = [];
  const allowContent = order !== 'native-history-error-private';
  const useNativeError = order === 'native-history-error' || !allowContent;
  const flusher = new OtlpTraceFlusher({
    enabled: true, protocol: 'http/protobuf', serviceName: 'zcode-dual-source',
    endpoints: [{ endpoint: 'http://127.0.0.1:4318' }],
    captureMessageContent: allowContent,
  }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
    shutdown: async () => {},
  }));
  const manager = new InputManager();
  manager.setFlusher(flusher);
  manager.setUserId('collector-fallback-identity');
  manager.registerInput(hook);
  manager.registerInput(rollout);
  try {
    const rowText = await fs.readFile(path.join(fixtures, 'rollout-model-io-paired.jsonl'), 'utf8');
    const row = JSON.parse(rowText);
    if (order === 'interrupted-eof') {
      row.response.finishReason = null;
      row.response.toolCalls = [{ id: 'eof-observed-call', name: 'Read', input: {} }];
    }
    const rolloutRows = [row];
    const nativeCallId = 'call_123456789abcdef';
    const nativeError = 'synthetic file does not exist';
    const nativeDefinition = {
      name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } },
    };
    if (useNativeError) {
      const toolCall = { id: nativeCallId, name: 'Read', input: { path: 'synthetic-file' } };
      row.request.body = { tools: [{ type: 'function', function: nativeDefinition }] };
      row.response.finishReason = 'tool_calls';
      row.response.toolCalls = [toolCall];
      const nextTime = Date.parse(row.completedAt) + 1_000;
      rolloutRows.push({
        ...row, requestId: 'next-native-request',
        startedAt: new Date(nextTime).toISOString(), completedAt: new Date(nextTime + 500).toISOString(),
        request: { ...row.request, messages: [
          { role: 'assistant', toolCalls: [toolCall] },
          { role: 'tool', toolCallId: `${nativeCallId}987654321`, toolName: 'Read', isError: true, content: nativeError },
        ] },
        response: { ...row.response, responseId: 'next-native-response', finishReason: 'stop', toolCalls: [] },
      });
    }
    const traceId = toW3CTraceId(row.traceId);
    const rolloutPath = path.join(rolloutDir, `model-io-${row.sessionId}.jsonl`);
    const hookPayload = order === 'documented-stop'
      ? JSON.stringify({
          hook_event_name: 'Stop', session_id: row.sessionId, cwd: root,
          transcript_path: path.join(root, 'transcript.jsonl'), permission_mode: 'default',
          stop_hook_active: false, last_assistant_message: 'synthetic reply',
        })
      : await fs.readFile(path.join(fixtures, 'hook-stop-stdin-paired.json'), 'utf8');
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.mkdir(logDir, { recursive: true });
    const collect = async (source: 'hook' | 'rollout') => {
      if (source === 'hook') {
        const child = spawnSync(process.execPath, [path.resolve('assets/hooks/zcode-hook-processor.mjs'), 'stop'], {
          env: { ...process.env, HOME: root, LOONGSUITE_PILOT_DATA_DIR: root },
          input: hookPayload, encoding: 'utf8', timeout: 5_000,
        });
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout.trim()).toBe('{}');
        if (order === 'legacy-envelope') {
          const file = path.join(logDir, (await fs.readdir(logDir)).find(name => name.endsWith('.jsonl'))!);
          const envelope = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          delete envelope[0]['gen_ai.turn.id'];
          await fs.writeFile(file, envelope.map(record => JSON.stringify(record)).join('\n') + '\n');
        }
        await hook.poll();
      } else {
        await fs.writeFile(rolloutPath, rolloutRows.map(model => JSON.stringify(model) + '\n').join(''));
        await rollout.poll();
      }
      await manager.stopInput(source === 'hook' ? hook.id : rollout.id);
    };
    await collect(order === 'hook-first' ? 'hook' : 'rollout');
    expect(spans).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(spans).toHaveLength(0);
    if (order !== 'no-hook') await collect(order === 'hook-first' ? 'rollout' : 'hook');
    if (order === 'continued-stop') {
      await vi.advanceTimersByTimeAsync(35_000);
      const appendModel = async (requestId: string, seconds: number, response: object, request = row.request) => {
        const time = Date.parse(row.completedAt) + seconds * 1_000;
        await fs.appendFile(rolloutPath, JSON.stringify({
          ...row, requestId, request,
          startedAt: new Date(time).toISOString(),
          completedAt: new Date(time + 500).toISOString(),
          response: { ...row.response, responseId: requestId, ...response },
        }) + '\n');
        await rollout.poll();
        await manager.stopInput(rollout.id);
      };
      await appendModel('continued-tool', 1, {
        finishReason: 'tool-calls', toolCalls: [{ id: 'continued-call', name: 'Read', input: {} }],
      });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(spans).toHaveLength(0);
      await appendModel('continued-final', 3, { finishReason: 'stop', text: 'finished', toolCalls: [] }, {
        ...row.request, messages_sample_truncated: [{ role: 'tool', toolCallId: 'continued-call', content: 'observed' }],
      });
    }
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.waitFor(() => expect(spans.length).toBeGreaterThan(0));

    const byKind = (kind: string) => spans.filter(span => span.attributes['gen_ai.span.kind'] === kind);
    expect(new Set(spans.map(span => span.spanContext().traceId))).toEqual(new Set([traceId]));
    const steps = order === 'continued-stop' ? 3 : rolloutRows.length;
    expect(['ENTRY', 'AGENT', 'STEP', 'LLM'].map(kind => byKind(kind).length)).toEqual([1, 1, steps, steps]);
    expect(byKind('LLM')[0].parentSpanId).toBe(byKind('STEP')[0].spanContext().spanId);
    expect(byKind('STEP')[0].parentSpanId).toBe(byKind('AGENT')[0].spanContext().spanId);
    expect(byKind('AGENT')[0].parentSpanId).toBe(byKind('ENTRY')[0].spanContext().spanId);
    expect(byKind('ENTRY')[0].parentSpanId).toBeUndefined();
    if (allowContent) expect(byKind('LLM')[0].attributes['gen_ai.output.messages']).toContain('hello');
    if (order === 'continued-stop') {
      expect(byKind('TOOL')).toHaveLength(1);
      expect(byKind('TOOL')[0].attributes['gen_ai.tool.call.result']).toContain('observed');
    }
    if (useNativeError) {
      expect(byKind('TOOL')).toHaveLength(1);
      const [tool] = byKind('TOOL');
      expect(tool.attributes['gen_ai.tool.call.id']).toBe(nativeCallId);
      expect(tool.attributes['tool.result.status']).toBe('failure');
      expect(tool.attributes['error.type']).toBe('ToolError');
      expect(tool.status.code).toBe(SpanStatusCode.ERROR);
      expect(tool.parentSpanId).toBe(byKind('STEP')[0].spanContext().spanId);
      if (allowContent) {
        expect(byKind('LLM')[0].attributes['gen_ai.tool.definitions']).toContain(JSON.stringify({
          type: 'function', ...nativeDefinition,
        }));
        expect(tool.attributes['gen_ai.tool.call.result']).toContain(nativeError);
        expect(tool.attributes['error.message']).toBe(nativeError);
      } else {
        expect(byKind('LLM')[0].attributes['gen_ai.tool.definitions']).toBeUndefined();
        expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
        expect(tool.attributes['error.message']).toBeUndefined();
        expect(JSON.stringify(tool.status)).not.toContain(nativeError);
      }
    }
    if (order === 'interrupted-eof') {
      expect(byKind('LLM')[0].attributes['gen_ai.response.finish_reasons']).toContain('interrupted');
      expect(byKind('TOOL')).toHaveLength(1);
      expect(byKind('TOOL')[0].attributes['gen_ai.tool.call.id']).toBe('eof-observed-call');
      const tool = byKind('TOOL')[0];
      expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(tool.attributes['agent.zcode.tool.result_observed']).toBe(false);
      expect(tool.duration).toEqual([0, 1]);
      expect(tool.parentSpanId).toBe(byKind('STEP')[0].spanContext().spanId);
      expect(tool.endTime).toEqual(byKind('STEP')[0].endTime);
    }
    if (order !== 'no-hook' && order !== 'documented-stop') {
      expect(byKind('ENTRY')[0].spanContext().spanId).toBe(deriveSpanId('entry', row.sessionId));
      expect(byKind('AGENT')[0].spanContext().spanId).toBe(deriveSpanId('agent', row.sessionId, row.turnId));
    }
  } finally {
    await manager.stopAll();
    await flusher.shutdown();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  }
});
