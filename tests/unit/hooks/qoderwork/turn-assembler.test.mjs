import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSEMBLER_PATH = path.resolve(__dirname, '../../../../assets/hooks/qoderwork-turn-assembler.mjs');

// These are red-light tests. The module qoderwork-turn-assembler.mjs is added in
// commit 2; this file pins down the contract that the persistent assembler must
// uphold so that hook-processor.mjs can reuse the same primitives.

const importAssembler = () => import(ASSEMBLER_PATH);

describe('qoderwork-turn-assembler pure helpers', () => {
  test('openPending creates a pending turn keyed by promptId with seqs reset', async () => {
    const { openPending } = await importAssembler();
    const turn = openPending({
      promptId: 'turn-X',
      userText: 'Hello',
      userTimestampNano: '1000000000',
      nowMs: 1718_000_000_000,
    });
    expect(turn.promptId).toBe('turn-X');
    expect(turn.turnId).toBe('turn-X');
    expect(turn.userText).toBe('Hello');
    expect(turn.nextStepSeq).toBe(1);
    expect(turn.userTextEmitted).toBe(false);
    expect(Array.isArray(turn.pendingToolCalls)).toBe(true);
    expect(turn.pendingToolCalls.length).toBe(0);
    expect(turn.createdAtMs).toBe(1718_000_000_000);
    expect(turn.updatedAtMs).toBe(1718_000_000_000);
  });

  test('appendAssistant accumulates rows and bumps updatedAtMs only', async () => {
    const { openPending, appendAssistant } = await importAssembler();
    const turn = openPending({
      promptId: 'turn-Y',
      userText: 'go',
      userTimestampNano: '1000000000',
      nowMs: 1000,
    });
    const row1 = { type: 'assistant', uuid: 'a1' };
    const row2 = { type: 'assistant', uuid: 'a2' };
    const updated = appendAssistant(turn, row1, { nowMs: 1500 });
    expect(updated.updatedAtMs).toBe(1500);
    expect(updated.createdAtMs).toBe(1000);
    expect(updated.currentWaveRows.map((r) => r.uuid)).toEqual(['a1']);
    const updated2 = appendAssistant(updated, row2, { nowMs: 2000 });
    expect(updated2.currentWaveRows.map((r) => r.uuid)).toEqual(['a1', 'a2']);
  });

  test('waveEnded returns true when the current row carries an end stop_reason', async () => {
    const { waveEnded } = await importAssembler();
    expect(waveEnded({ message: { stop_reason: 'end_turn' } })).toBe(true);
    expect(waveEnded({ message: { stop_reason: 'tool_use' } })).toBe(true);
    expect(waveEnded({ message: { stop_reason: 'stop_sequence' } })).toBe(true);
    expect(waveEnded({ message: { stop_reason: 'max_tokens' } })).toBe(true);
    expect(waveEnded({ message: { stop_reason: undefined } })).toBe(false);
    expect(waveEnded({ message: {} })).toBe(false);
    expect(waveEnded({})).toBe(false);
  });

  test('closePending clears the pending turn and returns the closed snapshot', async () => {
    const { openPending, appendAssistant, closePending } = await importAssembler();
    const opened = openPending({
      promptId: 'turn-Z',
      userText: 'x',
      userTimestampNano: '1000000000',
      nowMs: 1000,
    });
    const withAssistant = appendAssistant(opened, { type: 'assistant', uuid: 'a1' }, { nowMs: 1500 });
    const closed = closePending(withAssistant, { reason: 'new_prompt', nowMs: 2000 });
    expect(closed.promptId).toBe('turn-Z');
    expect(closed.closedAtMs).toBe(2000);
    expect(closed.reason).toBe('new_prompt');
  });

  test('isPendingExpired honours TTL parameter', async () => {
    const { isPendingExpired } = await importAssembler();
    const turn = { updatedAtMs: 1000 };
    expect(isPendingExpired(turn, { nowMs: 1000 + 30 * 60 * 1000, ttlMs: 60 * 60 * 1000 })).toBe(false);
    expect(isPendingExpired(turn, { nowMs: 1000 + 90 * 60 * 1000, ttlMs: 60 * 60 * 1000 })).toBe(true);
    // 自定义 TTL（4h）
    expect(isPendingExpired(turn, { nowMs: 1000 + 90 * 60 * 1000, ttlMs: 4 * 60 * 60 * 1000 })).toBe(false);
  });
});
