import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { extractCodexTerminalTurn } from '../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { buildCodexTranscriptEntries } from '../../src/inputs/codex-transcript/codex-transcript-builder.js';
import { contentHash } from '../../src/utils/content-hash.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const environment = '<environment_context>\n  <cwd>/probe</cwd>\n</environment_context>';
function message(text: string, turn: string, provenance?: string) {
  return { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text }],
    ...(provenance ? { internal_chat_message_metadata_passthrough: { turn_id: turn,
      content_item_metadata: [{ provenance: { type: provenance } }] } } : {}),
  } };
}
function turn(turnId: string, inputs: Record<string, unknown>[]) {
  return extractCodexTerminalTurn([
    { type: 'turn_context', payload: { turn_id: turnId, model: 'fixture-model' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    ...inputs,
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'done' } },
  ].map((record, index) => ({ timestamp: new Date(1794370000000 + index * 100).toISOString(), ...record })),
  null, 'native-session', turnId)!;
}

describe('Codex app-server request attributes use native user provenance', () => {
  it('does not shift the first request onto the next identical-input turn after native environment context', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-request-provenance-')); roots.push(root);
    const prompt = 'same user input';
    const attributes = [{ 'memory.user_id': 'U001' }, {}, { 'memory.user_id': 'U003' }];
    fs.writeFileSync(path.join(root, 'native-session.jsonl'), attributes.map(attributes => JSON.stringify({
      type: 'turn', contentHash: contentHash(prompt), attributes,
    })).join('\n') + '\n');
    const linker = new TraceLinker(new CorrelationStore(root, { attributesEnabled: true, traceEnabled: false }),
      { attributesEnabled: true, linkTrace: false, retries: 0 });
    for (const [index, expected] of ['U001', undefined, 'U003'].entries()) {
      const id = `turn-${index}`;
      const extracted = turn(id, [...(index === 0 ? [message(environment, id, 'harness')] : []), message(prompt, id, 'user')]);
      const entries = buildCodexTranscriptEntries(extracted);
      await linker.stamp(entries);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every(entry => entry['memory.user_id'] === expected), `turn ${index}`).toBe(true);
      if (index === 0) {
        // Correlation must not rewrite the user's visible/model context.
        expect(JSON.stringify(extracted.inputMessages)).toContain('environment_context');
        expect(extracted.prompt).toBe(`${environment}\n${prompt}`);
      }
    }
    const restored = new TraceLinker(new CorrelationStore(root, { attributesEnabled: true, traceEnabled: false }),
      { attributesEnabled: true, linkTrace: false, retries: 0 });
    const replay = buildCodexTranscriptEntries(turn('turn-0', [message(environment, 'turn-0', 'harness'), message(prompt, 'turn-0', 'user')]));
    await restored.stamp(replay);
    expect(replay.every(entry => entry['memory.user_id'] === 'U001')).toBe(true);
  });

  it('preserves literal environment XML when native provenance identifies it as user input', () => {
    const prompt = `${environment}\nthis entire text is user-authored`;
    const entries = buildCodexTranscriptEntries(turn('t', [message(environment, 't', 'harness'), message(prompt, 't', 'user')]));
    expect(entries[0]['agent.pilot.correlation.content_hash']).toBe(contentHash(prompt));
    expect(JSON.stringify(entries[0]['gen_ai.input.messages_delta'])).toContain('user-authored');
  });

  it('uses explicit user_message evidence without changing older displayed prompt semantics', () => {
    const extracted = turn('t', [message(environment, 't'),
      { type: 'event_msg', payload: { type: 'user_message', message: 'original request' } },
      message('original request', 't', 'user')]);
    const entries = buildCodexTranscriptEntries(extracted);
    expect(entries[0]['agent.pilot.correlation.content_hash']).toBe(contentHash('original request'));
    expect(extracted.prompt).toBe(`${environment}\noriginal request`);
  });

  it.each(['harness', 'unknown'])('does not invent user-only evidence from %s provenance', provenance => {
    const entries = buildCodexTranscriptEntries(turn('t', [message(environment, 't', provenance)]));
    expect(entries[0]['agent.pilot.correlation.content_hash']).toBeUndefined();
  });

  it('does not use user metadata explicitly attributed to a different native turn', () => {
    const entries = buildCodexTranscriptEntries(turn('t', [message('copied history', 'other-turn', 'user')]));
    expect(entries[0]['agent.pilot.correlation.content_hash']).toBeUndefined();
  });

  it('keeps content-item provenance aligned when harness and user parts share one native message', () => {
    const entries = buildCodexTranscriptEntries(turn('t', [{ type: 'response_item', payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: environment }, { type: 'input_text', text: 'actual request' }],
      internal_chat_message_metadata_passthrough: { turn_id: 't', content_item_metadata: [
        { provenance: { type: 'harness' } }, { provenance: { type: 'user' } },
      ] },
    } }]));
    expect(entries[0]['agent.pilot.correlation.content_hash']).toBe(contentHash('actual request'));
  });
});
