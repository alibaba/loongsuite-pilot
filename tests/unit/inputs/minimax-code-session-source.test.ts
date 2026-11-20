import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  minimaxCodeProfileDir,
  parseMinimaxCodeHookObservation,
  parseMinimaxCodeSessionManifest,
  parseMinimaxCodeSessionMessage,
} from '../../../src/inputs/minimax-code-session/minimax-code-session-source.js';

const fixtures = new URL('../../fixtures/minimax-code/', import.meta.url);
const readNative = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');
const readLines = (name: string) => readNative(name).trim().split('\n').map(line => JSON.parse(line));

describe('MiniMax Code v2 canonical session', () => {
  it('identifies the official CLI profile without using its installation directory', () => {
    const home = path.resolve('fixture-home');
    const explicit = path.join(home, 'explicit');
    const fallback = path.join(home, 'fallback');
    expect(minimaxCodeProfileDir({}, home)).toBe(path.join(home, '.minimax'));
    expect(minimaxCodeProfileDir({ MINIMAX_DATA_DIR: ` ${explicit} `, MAVIS_DATA_DIR: fallback }, home)).toBe(explicit);
    expect(minimaxCodeProfileDir({ MINIMAX_DATA_DIR: ' ', MAVIS_DATA_DIR: fallback }, home)).toBe(fallback);
    expect(minimaxCodeProfileDir({ MINIMAX_DATA_DIR: 'relative-profile' }, home)).toBeUndefined();
  });

  it('identifies the native session only from an accepted manifest layout', () => {
    const manifest = JSON.parse(readNative('manifest.json'));
    expect(parseMinimaxCodeSessionManifest(manifest)).toEqual({ sessionId: manifest.sessionId });
    expect(parseMinimaxCodeSessionManifest({ ...manifest, schemaVersion: 2 })).toBeUndefined();
    expect(parseMinimaxCodeSessionManifest({ ...manifest, source: 'cloud' })).toBeUndefined();
  });

  it('preserves ordered native identities and model data through an actual resumed tool turn', () => {
    const rows = readLines('messages.jsonl').flatMap(row => parseMinimaxCodeSessionMessage(row) ?? []);
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'toolResult', 'assistant']);
    expect(new Set(rows.map(row => row.messageId)).size).toBe(6);
    expect(new Set(rows.map(row => row.turnId)).size).toBe(2);
    expect(rows[3].message).toMatchObject({
      model: 'fixture-model',
      stopReason: 'toolUse',
      usage: { input: 9, output: 4, totalTokens: 13 },
      content: [{ type: 'toolCall', id: 'fixture-read-tool-v1', name: 'read' }],
    });
    expect(rows[4]).toMatchObject({
      turnId: rows[3].turnId, message: { toolCallId: 'fixture-read-tool-v1', toolName: 'read' },
    });
    expect(rows[5].timestampMs).toBeGreaterThan(rows[4].timestampMs);
    expect(parseMinimaxCodeSessionMessage({ type: 'model-io', turnId: 'turn' })).toBeUndefined();
    expect(parseMinimaxCodeSessionMessage({ turn_id: 'turn', message: { role: 'user', timestamp: 1 } })).toBeUndefined();
  });

  it('correlates real Hook observations using native session, turn and tool IDs', () => {
    const manifest = JSON.parse(readNative('manifest.json'));
    const events = readLines('hooks.jsonl').flatMap(row => parseMinimaxCodeHookObservation(row.payload, row.timeReceivedMs) ?? []);
    expect(events.map(event => event.event)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
    ]);
    expect(new Set(events.map(event => event.sessionId))).toEqual(new Set([manifest.sessionId]));
    const [pre, post, stop] = events.slice(-3);
    expect(pre).toMatchObject({ toolCallId: 'fixture-read-tool-v1', turnId: stop.turnId });
    expect(post).toMatchObject({ toolCallId: 'fixture-read-tool-v1', turnId: stop.turnId });
    expect(post.observedAtMs).toBeGreaterThanOrEqual(pre.observedAtMs);
    expect(pre).not.toHaveProperty('transcript_path');
    expect(parseMinimaxCodeHookObservation({ hook_event_name: 'Stop', session_id: 's' }, 100)).toBeUndefined();
    expect(parseMinimaxCodeHookObservation({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't' }, 100)).toBeUndefined();
  });
});
