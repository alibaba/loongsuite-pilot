import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildJsonlValidationSh, JSONL_VALIDATOR_JS } from '../../scripts/e2e/lib/e2e-scenarios.mjs';

/** Run the embedded validator by piping its source into `node -` (mirrors how the remote bash runs it). */
function runValidator(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const r = spawnSync(process.execPath, ['-'], { env, input: JSONL_VALIDATOR_JS, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('buildJsonlValidationSh', () => {
  it('returns empty string when E2E_JSONL_VALIDATE=0', () => {
    expect(buildJsonlValidationSh({ E2E_JSONL_VALIDATE: '0' })).toBe('');
  });

  it('embeds base64 validator and references AgentActivityEntry schema', () => {
    const sh = buildJsonlValidationSh({});
    expect(sh).toContain('[jsonl-validate]');
    expect(sh).toContain('base64 -d | node -');
    expect(sh).toContain('E2E_JSONL_LOG_DIR');
    expect(sh).toContain('E2E_JSONL_STRICT');
  });

  it('validator source declares all REQUIRED AgentActivityEntry fields', () => {
    for (const key of [
      'time_unix_nano', 'event.id', 'user.id', 'event.name',
      'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
    ]) {
      expect(JSONL_VALIDATOR_JS).toContain(key);
    }
  });
});

describe('JSONL_VALIDATOR_JS (integration)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-validate-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(name, entries) {
    fs.writeFileSync(path.join(tmpDir, name), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  const goodEntry = (overrides = {}) => ({
    time_unix_nano: String(BigInt(Date.now()) * 1000000n),
    'event.id': 'evt-1',
    'user.id': 'u-1',
    'event.name': 'llm.request',
    'gen_ai.session.id': 'sess-1',
    'gen_ai.agent.type': 'claude',
    'gen_ai.provider.name': 'anthropic',
    ...overrides,
  });

  const graphEntry = (id, eventName, overrides = {}) => goodEntry({
    'event.id': id,
    'event.name': eventName,
    'gen_ai.turn.id': 'turn-1',
    ...overrides,
  });

  const validMultiToolGraph = () => [
    graphEntry('evt-1', 'llm.request', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.turn.start': true,
      'gen_ai.request.id': 'request-1',
      'gen_ai.request.model': 'model-synthetic',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'SYNTHETIC_INPUT' }] }],
    }),
    graphEntry('evt-2', 'llm.response', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1',
      'gen_ai.response.model': 'model-synthetic',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call-a' }] }],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 12,
    }),
    graphEntry('evt-3', 'tool.call', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'SyntheticRead',
      'gen_ai.tool.call.id': 'call-a',
      'gen_ai.tool.call.arguments': { path: '/workspace/example/a.txt' },
    }),
    graphEntry('evt-4', 'tool.call', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'SyntheticRead',
      'gen_ai.tool.call.id': 'call-b',
      'gen_ai.tool.call.arguments': { path: '/workspace/example/b.txt' },
    }),
    graphEntry('evt-5', 'tool.result', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'SyntheticRead',
      'gen_ai.tool.call.id': 'call-a',
      'gen_ai.tool.call.result': { ok: true },
      'gen_ai.tool.call.duration': 100,
      'tool.result.status': 'success',
    }),
    graphEntry('evt-6', 'tool.result', {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'SyntheticRead',
      'gen_ai.tool.call.id': 'call-b',
      'gen_ai.tool.call.result': { ok: true },
      'gen_ai.tool.call.duration': 200,
      'tool.result.status': 'success',
    }),
    graphEntry('evt-7', 'llm.request', {
      'gen_ai.step.id': 'step-2',
      'gen_ai.request.id': 'request-2',
      'gen_ai.request.model': 'model-synthetic',
      'gen_ai.input.messages_delta': [
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-a', result: { ok: true } }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-b', result: { ok: true } }] },
      ],
    }),
    graphEntry('evt-8', 'llm.response', {
      'gen_ai.step.id': 'step-2',
      'gen_ai.turn.end': true,
      'gen_ai.response.id': 'response-2',
      'gen_ai.response.model': 'model-synthetic',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'SYNTHETIC_OUTPUT' }] }],
      'gen_ai.usage.input_tokens': 13,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.total_tokens': 16,
    }),
  ];

  const runWorkBuddyValidator = () => runValidator({
    _JV_LOG_DIR: tmpDir,
    E2E_JSONL_AGENT_FILTER: 'workbuddy',
    E2E_JSONL_STRICT: '1',
  });

  it('validates a complete multi-tool graph and reports per-event field coverage', () => {
    writeJsonl('workbuddy-2026-05-11.jsonl', validMultiToolGraph());
    const r = runWorkBuddyValidator();
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK workbuddy-2026-05-11.jsonl');
    expect(r.out).toContain('missing_required=0');
    expect(r.out).toContain('tool.call count=2');
    expect(r.out).toContain('gen_ai.tool.call.id=2 (100.0%)');
  });

  it('detects missing required fields and exits 1 under STRICT', () => {
    writeJsonl('codex-2026-05-11.jsonl', [
      goodEntry(),
      { ...goodEntry(), 'user.id': undefined },
    ]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL codex-2026-05-11.jsonl');
    expect(r.out).toContain('missing_required=1');
    expect(r.out).toMatch(/category=missing_required fields=\[user\.id\]/);
  });

  it('honors E2E_JSONL_AGENT_FILTER', () => {
    writeJsonl('claude-2026-05-11.jsonl', [goodEntry()]);
    writeJsonl('codex-2026-05-11.jsonl', [{ ...goodEntry(), 'event.name': undefined }]);
    const r = runValidator({
      _JV_LOG_DIR: tmpDir,
      E2E_JSONL_AGENT_FILTER: 'claude',
      E2E_JSONL_STRICT: '1',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('claude-2026-05-11.jsonl');
    expect(r.out).not.toContain('codex-2026-05-11.jsonl');
  });

  it('reports bad event.name enum values', () => {
    writeJsonl('claude-code-2026-05-11.jsonl', [goodEntry({ 'event.name': 'gen_ai.model.request' })]);
    const diagnostic = runValidator({ _JV_LOG_DIR: tmpDir });
    expect(diagnostic.code).toBe(0);
    expect(diagnostic.out).toContain('bad_event_name=1');
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad_event_name=1');
  });

  it.each([
    {
      name: 'duplicate event IDs',
      mutate: entries => { entries[7]['event.id'] = entries[0]['event.id']; },
      category: 'duplicate_event_id=1',
    },
    {
      name: 'native JSON types and positive millisecond duration',
      mutate: entries => {
        entries[2]['gen_ai.tool.call.arguments'] = '{"path":"/workspace/example/a.txt"}';
        entries[4]['gen_ai.tool.call.duration'] = 0;
      },
      category: 'type_error=2',
    },
    {
      name: 'request/response pairing',
      mutate: entries => { entries.splice(1, 1); },
      category: 'model_pair_error=1',
    },
    {
      name: 'tool call/result pairing and name consistency',
      mutate: entries => { entries[4]['gen_ai.tool.name'] = 'DifferentSyntheticTool'; },
      category: 'tool_pair_error=1',
    },
    {
      name: 'turn start/end uniqueness',
      mutate: entries => { delete entries[7]['gen_ai.turn.end']; },
      category: 'turn_boundary_error=1',
    },
  ])('strictly rejects $name', ({ mutate, category }) => {
    const entries = validMultiToolGraph();
    mutate(entries);
    writeJsonl('workbuddy-2026-05-11.jsonl', entries);
    const r = runWorkBuddyValidator();
    expect(r.code).toBe(1);
    expect(r.out).toContain(category);
  });

  it('never prints prompt, tool payload, result, or user path values in validation errors', () => {
    const entries = validMultiToolGraph();
    entries[2]['gen_ai.tool.call.arguments'] =
      '{"secret":"SENSITIVE_MARKER_MUST_NOT_APPEAR","path":"/Users/private/person"}';
    writeJsonl('workbuddy-2026-05-11.jsonl', entries);
    const r = runWorkBuddyValidator();
    expect(r.code).toBe(1);
    expect(r.out).toContain('type_error=1');
    expect(r.out).not.toContain('SENSITIVE_MARKER_MUST_NOT_APPEAR');
    expect(r.out).not.toContain('/Users/private/person');
  });

  it('returns 0 with hint when log dir is empty (non-strict)', () => {
    const r = runValidator({ _JV_LOG_DIR: tmpDir });
    expect(r.code).toBe(0);
    expect(r.out).toContain('no .jsonl files');
  });

  it('default filter covers the L1 CLI coverage set and excludes IDE-only agents', () => {
    writeJsonl('claude-code-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-claude' })]);
    writeJsonl('codex-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-codex' })]);
    writeJsonl('qoder-cli-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-qoder-cli', 'gen_ai.agent.type': 'qoder-cli' })]);
    writeJsonl('cursor-cli-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-cursor-cli', 'gen_ai.agent.type': 'cursor-cli' })]);
    writeJsonl('qwen-code-cli-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-qwen', 'gen_ai.agent.type': 'qwen-code-cli' })]);
    writeJsonl('opencode-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-opencode', 'gen_ai.agent.type': 'opencode' })]);
    writeJsonl('qoder-2026-05-11.jsonl', [goodEntry({ 'event.id': 'evt-qoder' })]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('claude-code-2026-05-11.jsonl');
    expect(r.out).toContain('codex-2026-05-11.jsonl');
    expect(r.out).toContain('qoder-cli-2026-05-11.jsonl');
    expect(r.out).toContain('cursor-cli-2026-05-11.jsonl');
    expect(r.out).toContain('qwen-code-cli-2026-05-11.jsonl');
    expect(r.out).toContain('opencode-2026-05-11.jsonl');
    expect(r.out).not.toContain('qoder-2026-05-11.jsonl');
  });

  it('E2E_JSONL_AGENT_FILTER=all disables filtering', () => {
    writeJsonl('cursor-2026-05-11.jsonl', [goodEntry()]);
    const r = runValidator({ _JV_LOG_DIR: tmpDir, E2E_JSONL_AGENT_FILTER: 'all', E2E_JSONL_STRICT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('cursor-2026-05-11.jsonl');
  });
});
