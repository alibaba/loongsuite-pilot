/**
 * Privacy compliance test: when config sets
 *   agents['qwen-code-cli'].captureMessageContent = false
 * the hook MUST strip sensitive content fields before writing JSONL.
 *
 * Sensitive fields (per docs/agent-onboarding.md Privacy Checklist + the
 * MESSAGE_CONTENT_FIELDS / MESSAGE_CONTENT_SOURCE_KEYS lists in
 * assets/hooks/agent-event-normalizer.mjs):
 *   gen_ai.input.messages / _delta
 *   gen_ai.output.messages
 *   gen_ai.tool.call.arguments
 *   gen_ai.tool.call.result
 *
 * Non-content fields (timestamps, ids, tokens, finish_reasons, etc.) MUST
 * stay so observability still works without revealing user/model content.
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/qwen-code-cli-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-policy-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-policy-tr-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

function writeConfig(captureMessageContent) {
  fs.writeFileSync(
    path.join(DATA_DIR, 'config.json'),
    JSON.stringify({
      agents: {
        'qwen-code-cli': { enabled: true, captureMessageContent },
      },
    }),
    'utf-8',
  );
}

function writeTranscript(sessionId, records) {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function runHookStop(sessionId, transcriptPath) {
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: '/work',
      stop_reason: 'end_turn',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readOutput() {
  const dir = path.join(DATA_DIR, 'logs', 'qwen-code-cli');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

// ─── shared fixture: a turn with prompt + assistant(text+functionCall) + tool_result ───

function sensitiveTurn(sid) {
  return [
    {
      uuid: 'u1', parentUuid: null, sessionId: sid,
      timestamp: '2026-06-18T08:00:00.000Z',
      type: 'user', cwd: '/work', version: '0.14.4',
      message: { role: 'user', parts: [{ text: 'SECRET_PROMPT_CONTENT' }] },
    },
    {
      uuid: 'a1', parentUuid: 'u1', sessionId: sid,
      timestamp: '2026-06-18T08:00:10.000Z',
      type: 'assistant', cwd: '/work', version: '0.14.4',
      model: 'qwen3.6-plus',
      message: {
        role: 'model',
        parts: [
          { text: 'SECRET_ASSISTANT_REASONING', thought: true },
          { text: 'SECRET_ASSISTANT_TEXT' },
          { functionCall: { name: 'Bash', args: { cmd: 'SECRET_TOOL_ARG' }, id: 'c1' } },
        ],
      },
      usageMetadata: {
        promptTokenCount: 100, candidatesTokenCount: 20,
        cachedContentTokenCount: 0, totalTokenCount: 120, thoughtsTokenCount: 5,
      },
      contextWindowSize: 131072,
    },
    {
      uuid: 'tr1', parentUuid: 'a1', sessionId: sid,
      timestamp: '2026-06-18T08:00:13.000Z',
      type: 'tool_result', cwd: '/work', version: '0.14.4',
      message: {
        role: 'user',
        parts: [{ functionResponse: { name: 'Bash', response: { stdout: 'SECRET_TOOL_OUTPUT' } } }],
      },
      toolCallResult: { callId: 'c1', status: 'success' },
    },
    {
      uuid: 'a2', parentUuid: 'tr1', sessionId: sid,
      timestamp: '2026-06-18T08:00:15.000Z',
      type: 'assistant', cwd: '/work', version: '0.14.4',
      model: 'qwen3.6-plus',
      message: { role: 'model', parts: [{ text: 'SECRET_FINAL_REPLY' }] },
      usageMetadata: {
        promptTokenCount: 200, candidatesTokenCount: 10,
        cachedContentTokenCount: 0, totalTokenCount: 210, thoughtsTokenCount: 0,
      },
    },
  ];
}

describe('captureMessageContent privacy policy', () => {
  test('captureMessageContent=false strips ALL sensitive content fields', () => {
    writeConfig(false);
    const sid = 'sess-policy-off';
    const tp = writeTranscript(sid, sensitiveTurn(sid));
    const r = runHookStop(sid, tp);
    expect(r.status).toBe(0);

    const records = readOutput();
    expect(records.length).toBeGreaterThan(0);

    // ─── No sensitive content field should survive ───
    for (const rec of records) {
      expect(rec['gen_ai.input.messages']).toBeUndefined();
      expect(rec['gen_ai.input.messages_delta']).toBeUndefined();
      expect(rec['gen_ai.output.messages']).toBeUndefined();
      expect(rec['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(rec['gen_ai.tool.call.result']).toBeUndefined();
    }

    // ─── Confirm no secret strings leak through nested objects either ───
    const fullJson = JSON.stringify(records);
    expect(fullJson).not.toMatch(/SECRET_PROMPT_CONTENT/);
    expect(fullJson).not.toMatch(/SECRET_ASSISTANT_TEXT/);
    expect(fullJson).not.toMatch(/SECRET_ASSISTANT_REASONING/);
    expect(fullJson).not.toMatch(/SECRET_TOOL_ARG/);
    expect(fullJson).not.toMatch(/SECRET_TOOL_OUTPUT/);
    expect(fullJson).not.toMatch(/SECRET_FINAL_REPLY/);

    // ─── Non-content observability fields MUST still be present ───
    const llmResponse = records.find((r) => r['event.name'] === 'llm.response');
    expect(llmResponse).toBeDefined();
    expect(llmResponse['gen_ai.usage.input_tokens']).toBe(100);
    expect(llmResponse['gen_ai.usage.output_tokens']).toBe(20);
    expect(llmResponse['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(llmResponse['gen_ai.request.model']).toBe('qwen3.6-plus');
    expect(llmResponse['gen_ai.provider.name']).toBe('qwen');
    expect(llmResponse.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(llmResponse['gen_ai.session.id']).toBe(sid);

    const toolCall = records.find((r) => r['event.name'] === 'tool.call');
    expect(toolCall['gen_ai.tool.name']).toBe('Bash');
    expect(toolCall['gen_ai.tool.call.id']).toBe('c1');

    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult['tool.result.status']).toBe('success');
    expect(toolResult['gen_ai.tool.call.id']).toBe('c1');
  });

  test('captureMessageContent=true (default) keeps content fields', () => {
    writeConfig(true);
    const sid = 'sess-policy-on';
    const tp = writeTranscript(sid, sensitiveTurn(sid));
    const r = runHookStop(sid, tp);
    expect(r.status).toBe(0);

    const records = readOutput();
    const llmResponse = records.find((r) => r['event.name'] === 'llm.response');
    expect(llmResponse['gen_ai.output.messages']).toBeDefined();
    // The reasoning + text + tool_call must all be in messages
    const fullJson = JSON.stringify(records);
    expect(fullJson).toMatch(/SECRET_ASSISTANT_TEXT/);
    expect(fullJson).toMatch(/SECRET_TOOL_ARG/);
    expect(fullJson).toMatch(/SECRET_TOOL_OUTPUT/);
  });

  test('config without agents.qwen-code-cli key defaults to capture (back-compat)', () => {
    // No config file at all — should default to capture
    const sid = 'sess-no-config';
    const tp = writeTranscript(sid, sensitiveTurn(sid));
    const r = runHookStop(sid, tp);
    expect(r.status).toBe(0);

    const fullJson = JSON.stringify(readOutput());
    expect(fullJson).toMatch(/SECRET_PROMPT_CONTENT/);
  });
});
