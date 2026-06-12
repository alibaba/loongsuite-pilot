import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/codex-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-test-'));
  TRANSCRIPT = path.join(DATA_DIR, 'rollout.jsonl');
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

function runHook(subcommand, payload) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonl() {
  const dir = path.join(DATA_DIR, 'logs', 'codex');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function readState(sid) {
  const f = path.join(DATA_DIR, 'state', 'codex', 'sessions', `${sid}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null;
}

function writeFakeTranscript(records) {
  fs.writeFileSync(TRANSCRIPT, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('codex-hook-processor 端到端', () => {
  test('SessionStart → UserPromptSubmit → Stop 输出 system_instructions/tool.definitions', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: {
        model_provider: 'openai',
        base_instructions: { text: 'Codex base' },
        dynamic_tools: [{ namespace: 'app', name: 'auto_x', description: 'd', inputSchema: { type: 'object' } }],
      }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: {
        turn_id: 'turn-1', model: 'gpt-5.5', developer_instructions: 'dev ctx',
      }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80, reasoning_output_tokens: 0, total_tokens: 150 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx', prompt: 'hi', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx', turn_id: 'turn-1', last_assistant_message: 'hello back', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    expect(records.length).toBeGreaterThanOrEqual(2);

    // 字段命名 gen_ai.*
    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('cdx');
      expect(rec['gen_ai.agent.type']).toBe('codex');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    // system_instructions / tool.definitions 在 LLM step records 上出现 (9.6)
    const llmRecords = records.filter((r) =>
      (r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response') && r['gen_ai.step.id']);
    expect(llmRecords.length).toBeGreaterThan(0);
    for (const rec of llmRecords) {
      expect(Array.isArray(rec['gen_ai.system_instructions'])).toBe(true);
      expect(rec['gen_ai.system_instructions'].length).toBe(2); // base + developer
      expect(Array.isArray(rec['gen_ai.tool.definitions'])).toBe(true);
      expect(rec['gen_ai.tool.definitions'][0].name).toBe('app/auto_x');
    }

    // token 字段正确 (9.9 total_tokens 用源值)
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.usage.input_tokens']).toBe(100);
    expect(resp['gen_ai.usage.total_tokens']).toBe(150); // 源值,而非 input+output
    expect(Array.isArray(resp['gen_ai.response.finish_reasons'])).toBe(true);
  });

  test('Stop 后不 clearState,events 清空 + transcript_offset/lastUsage 持久化 (9.9)', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 2 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx2', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx2', prompt: 'q', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx2', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const state = readState('cdx2');
    expect(state).not.toBeNull();
    expect(state.events).toEqual([]);
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.transcript_last_token_usage?.inputTokens).toBe(1);
  });

  test('缺 session_id 不污染 state 目录', () => {
    runHook('post-tool-use', { tool_name: 'Bash' });
    const dir = path.join(DATA_DIR, 'state', 'codex', 'sessions');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0).toBe(0);
  });
});
