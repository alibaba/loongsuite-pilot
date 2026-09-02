import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { ClientType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const PLUGIN_PATH = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
const FIXTURE_PATH = path.resolve('tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl');

class TestHermesLogInput extends HermesLogInput {
  collectOnce(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }
}

describe('Hermes Agent plugin to trace flow', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('converts a real-derived tool turn into the expected seven-span tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-flow-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
      userId: 'plugin-config-user',
      agents: { 'hermes-agent': { captureMessageContent: true } },
    }));

    const driver = `
import importlib.util
import json
import pathlib
import sys

plugin_path = pathlib.Path(sys.argv[1])
fixture_path = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pilot_hermes_plugin", plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback

ctx = Context()
module.register(ctx)
for line in fixture_path.read_text(encoding="utf-8").splitlines():
    event = json.loads(line)
    ctx.hooks[event["hook"]](**event["payload"])
`;
    const run = spawnSync('python3', ['-c', driver, PLUGIN_PATH, FIXTURE_PATH], {
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: root,
        LOONGSUITE_PILOT_USER_ID: '',
        LOONGSUITE_USER_ID: '',
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);

    const input = new TestHermesLogInput({
      stateStore: new MockStateStore() as any,
      sessionDir: path.join(root, 'logs', 'hermes-agent'),
      pollIntervalMs: 60_000,
    });
    const flusher = new MockFlusher();
    const manager = new InputManager();
    manager.setAgentsConfig({ [ClientType.Hermes]: { captureMessageContent: true } });
    manager.setConfiguredUserId('collector-config-user');
    manager.setUserId('collector-fallback-user');
    manager.setFlusher(flusher);
    manager.registerInput(input);
    await manager.startInput(input.id);
    await manager.stopInput(input.id);

    expect(flusher.batchCalls).toHaveLength(1);
    const records = flusher.batchCalls[0];
    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'llm.request',
      'llm.response',
    ]);
    expect(records.every(record => record['user.id'] === 'fixture-user')).toBe(true);
    expect(records.every(record =>
      !('agent.pilot.invocation.user.id' in record))).toBe(true);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const converted = await convertEventLogToReadableSpans(records as EventLogRecord[], {
        strict: false,
      });
      expect(converted.warnings).toEqual([]);
      expect(converted.spans).toHaveLength(7);

      const kindCounts = converted.spans.reduce<Record<string, number>>((counts, span) => {
        const kind = String(span.attributes['gen_ai.span.kind']);
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
      }, {});
      expect(kindCounts).toEqual({ ENTRY: 1, AGENT: 1, STEP: 2, LLM: 2, TOOL: 1 });

      const byId = new Map(converted.spans.map(span => [span.spanContext().spanId, span]));
      const parentKind = (span: (typeof converted.spans)[number]): string | undefined =>
        span.parentSpanId
          ? String(byId.get(span.parentSpanId)?.attributes['gen_ai.span.kind'])
          : undefined;
      const parents = converted.spans.map(span => ({
        kind: String(span.attributes['gen_ai.span.kind']),
        parent: parentKind(span),
      }));
      expect(parents).toContainEqual({ kind: 'AGENT', parent: 'ENTRY' });
      expect(parents.filter(item => item.kind === 'STEP').every(item => item.parent === 'AGENT')).toBe(true);
      expect(parents.filter(item => item.kind === 'LLM').every(item => item.parent === 'STEP')).toBe(true);
      expect(parents).toContainEqual({ kind: 'TOOL', parent: 'STEP' });
      expect(new Set(converted.spans.map(span => span.spanContext().traceId)).size).toBe(1);
      expect(converted.spans.every(span =>
        span.attributes['gen_ai.user.id'] === 'fixture-user')).toBe(true);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });
});
