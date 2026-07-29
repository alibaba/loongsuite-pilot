// AGENT span aggregation fields: processor emits gen_ai.agent.description +
// gen_ai.data_source.id on the first turn's "other" (prompt delta) record, and
// loadUsageBySession extracts cache_creation_input_tokens from unified.jsonl ctx
// when present (graceful fallback to 0 when absent — matches grok 0.2.101 fixture
// from researcher `47a8af1f` attachment `f1-inference-done-sample.json` which
// has prompt_tokens/cached_prompt_tokens/completion_tokens but no
// cache_creation_input_tokens).
//
// The flusher's AgentSpanEnrichingHandler scans turn records and mutates the
// AGENT invocation before stopInvokeAgent applies attributes, so these fields
// propagate to the OTLP AGENT span (the upstream @loongsuite/otel-util-genai
// library's buildInvokeAgentInvocation does not read them from records).
//
// Coverage:
//   - first turn "other" record carries gen_ai.agent.description + gen_ai.data_source.id
//   - second turn's "other" record does NOT carry them (AGENT span attrs are session-level, not per-turn)
//   - loadUsageBySession extracts cache_creation_input_tokens when ctx has it
//   - LLM response cache_creation.input_tokens reflects injected value when present
//   - LLM response cache_creation.input_tokens is 0 when ctx lacks it (graceful)
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/grok-build-hook-processor.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');

let DATA_DIR;
let SESSION_DIR;
let FAKE_HOME;
let GROK_LOG_DIR;

const SID = 's-agent-span-attrs';

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-agent-attrs-data-'));
  SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-agent-attrs-sess-'));
  FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-agent-attrs-home-'));
  GROK_LOG_DIR = path.join(FAKE_HOME, '.grok', 'logs');
  fs.mkdirSync(GROK_LOG_DIR, { recursive: true });
});

afterEach(() => {
  for (const d of [DATA_DIR, SESSION_DIR, FAKE_HOME]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function copyFixture(name) {
  const src = path.join(FIXTURES, name);
  const dst = path.join(SESSION_DIR, 'chat_history.jsonl');
  fs.copyFileSync(src, dst);
  return path.join(SESSION_DIR, 'updates.jsonl');
}

function runHook(payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, HOME: FAKE_HOME, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('error'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push(JSON.parse(t));
    }
  }
  return out;
}

describe('grok-build AGENT span aggregation fields — processor side', () => {
  test('first turn "other" record carries gen_ai.agent.description + gen_ai.data_source.id', () => {
    const transcriptPath = copyFixture('chat_history.single-llm-single-tool.jsonl');
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:00.000Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const otherFirst = records.find((rec) => rec['event.name'] === 'other');
    expect(otherFirst).toBeDefined();
    expect(otherFirst['gen_ai.agent.description']).toBe('Grok Build coding agent');
    expect(otherFirst['gen_ai.data_source.id']).toBe('grok-build');
  });

  test('every turn carries AGENT span attrs', () => {
    // First stop: emit turn 1 (AGENT attrs present on the "other" record)
    const transcriptPath = copyFixture('chat_history.three-turns.jsonl');
    // Pre-truncate to first turn only to control turn count
    const lines = fs.readFileSync(path.join(SESSION_DIR, 'chat_history.jsonl'), 'utf-8').split('\n').filter(Boolean);
    // Find the second user prompt_index boundary and truncate to first turn
    let firstTurnEnd = lines.length;
    for (let i = 1; i < lines.length; i++) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.type === 'user' && r.prompt_index === 1) { firstTurnEnd = i; break; }
      } catch {}
    }
    fs.writeFileSync(path.join(SESSION_DIR, 'chat_history.jsonl'), lines.slice(0, firstTurnEnd).join('\n') + '\n', 'utf-8');

    runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:00.000Z',
      cwd: '/tmp',
    });

    // Restore full fixture and append turn 2 onwards
    const full = fs.readFileSync(path.join(FIXTURES, 'chat_history.three-turns.jsonl'), 'utf-8').split('\n').filter(Boolean);
    fs.writeFileSync(path.join(SESSION_DIR, 'chat_history.jsonl'), full.join('\n') + '\n', 'utf-8');

    runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:01:00.000Z',
      cwd: '/tmp',
    });

    const records = readJsonlRecords();
    const otherRecs = records.filter((rec) => rec['event.name'] === 'other');
    expect(otherRecs.length).toBeGreaterThanOrEqual(2);
    // First turn's "other" record has AGENT span attrs
    expect(otherRecs[0]['gen_ai.agent.description']).toBe('Grok Build coding agent');
    expect(otherRecs[0]['gen_ai.data_source.id']).toBe('grok-build');
    // Each turn becomes an independent trace with its own AGENT span.
    expect(otherRecs[1]['gen_ai.agent.description']).toBe('Grok Build coding agent');
    expect(otherRecs[1]['gen_ai.data_source.id']).toBe('grok-build');
  });
});

describe('grok-build F1 loadUsageBySession — cache_creation_input_tokens extraction', () => {
  // Reuse the chat_history fixture from usage-injection tests (3 assistant records)
  function writeChatHistory() {
    const records = [
      { type: 'system', content: 'You are Grok.' },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nDo thing.\n</user_query>' }], prompt_index: 0, timestamp: '2026-07-17T10:00:00.000Z' },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'grok-3',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T10:00:02.000Z',
      },
    ];
    const target = path.join(SESSION_DIR, 'chat_history.jsonl');
    fs.writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    return path.join(SESSION_DIR, 'updates.jsonl');
  }

  test('cache_creation_input_tokens is extracted when ctx has it', () => {
    const transcriptPath = writeChatHistory();
    fs.writeFileSync(
      path.join(GROK_LOG_DIR, 'unified.jsonl'),
      JSON.stringify({
        ts: '2026-07-17T10:00:02.000Z',
        src: 'shell',
        sid: SID,
        msg: 'shell.turn.inference_done',
        ctx: { loop_index: 0, prompt_tokens: 1500, cached_prompt_tokens: 200, cache_creation_input_tokens: 75, completion_tokens: 30 },
      }) + '\n',
      'utf-8',
    );
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:02.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const llmResp = records.find((rec) => rec['event.name'] === 'llm.response');
    expect(llmResp).toBeDefined();
    expect(llmResp['gen_ai.usage.input_tokens']).toBe(1500);
    expect(llmResp['gen_ai.usage.cache_read.input_tokens']).toBe(200);
    expect(llmResp['gen_ai.usage.cache_creation.input_tokens']).toBe(75);
    expect(llmResp['gen_ai.usage.output_tokens']).toBe(30);
  });

  test('cache_creation_input_tokens defaults to 0 when ctx lacks it (graceful, matches grok 0.2.101 fixture)', () => {
    // grok 0.2.101 unified.jsonl ctx does NOT carry cache_creation_input_tokens
    // (researcher 47a8af1f attachment f1-inference-done-sample.json confirms:
    // ctx has prompt_tokens/cached_prompt_tokens/completion_tokens only).
    // The processor must not crash and should emit cache_creation.input_tokens=0.
    const transcriptPath = writeChatHistory();
    fs.writeFileSync(
      path.join(GROK_LOG_DIR, 'unified.jsonl'),
      JSON.stringify({
        ts: '2026-07-17T10:00:02.000Z',
        src: 'shell',
        sid: SID,
        msg: 'shell.turn.inference_done',
        ctx: { loop_index: 0, prompt_tokens: 1500, cached_prompt_tokens: 0, completion_tokens: 30 },
      }) + '\n',
      'utf-8',
    );
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:02.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const llmResp = records.find((rec) => rec['event.name'] === 'llm.response');
    expect(llmResp).toBeDefined();
    expect(llmResp['gen_ai.usage.cache_creation.input_tokens']).toBe(0);
  });
});
