import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const standardNames = [
  'gen_ai.model.request', 'gen_ai.model.response', 'gen_ai.tool.call',
  'gen_ai.tool.result', 'gen_ai.agent.invoke', 'gen_ai.agent.result',
];
const historicalNames = ['llm.request', 'llm.response', 'tool.call', 'tool.result'];

describe('standard event validation scripts', () => {
  it('combines model/tool aliases once per source record and reports both Agent events', () => {
    const testHome = mkdtempSync(path.join(tmpdir(), 'pilot-field-coverage-'));
    const outputDir = path.join(testHome, '.loongsuite-pilot', 'logs', 'output');
    mkdirSync(outputDir, { recursive: true });
    const events = [...historicalNames, ...standardNames].map((eventName, index) => ({
      'event.id': `event-${index}`, 'event.name': eventName, 'user.id': 'test-user',
      'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'child-session',
      'gen_ai.turn.id': 'child-turn', 'gen_ai.step.id': 'child-step',
      'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'test-model',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [] }],
      'gen_ai.response.id': 'response', 'gen_ai.response.model': 'test-model',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'test' }] }],
      'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 1,
      'gen_ai.tool.name': 'test-tool', 'gen_ai.tool.call.id': 'call',
      'gen_ai.tool.call.arguments': {}, 'gen_ai.tool.call.duration': 1,
      'gen_ai.agent.invocation.id': 'outgoing',
      'gen_ai.agent.parent.invocation.id': 'incoming',
    }));
    const file = path.join(outputDir, 'codex-2026-10-16.jsonl');
    const original = events.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    writeFileSync(file, original);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../../../scripts/field-coverage.mjs', import.meta.url)),
      '--agents', 'codex', '--date', '2026-10-16', '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, HOME: testHome, USERPROFILE: testHome } });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.tables).toHaveLength(6);
    const counts = Object.fromEntries(report.tables.map(table => [table.eventName, table.rows[0].total]));
    expect(counts).toEqual({
      'llm.request': 2, 'llm.response': 2, 'tool.call': 2, 'tool.result': 2,
      'gen_ai.agent.invoke': 1, 'gen_ai.agent.result': 1,
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
