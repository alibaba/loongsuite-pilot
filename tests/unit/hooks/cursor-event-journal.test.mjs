import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let dataDir;
let previousDataDir;
let journal;

async function importFreshJournal() {
  vi.resetModules();
  return import('../../../assets/hooks/cursor/event-journal.mjs');
}

describe('Cursor event journal', () => {
  beforeEach(async () => {
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-event-journal-'));
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    journal = await importFreshJournal();
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    } else {
      process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('rewrite preserves events appended after the read snapshot', () => {
    const completedTurnEvent = {
      _journal_ts: '2026-06-11T10:00:00.000Z',
      hook_event: 'beforeSubmitPrompt',
      conversation_id: 'completed-conv',
      generation_id: 'completed-turn',
      prompt: 'done',
    };
    const concurrentAppendEvent = {
      _journal_ts: '2026-06-11T10:00:01.000Z',
      hook_event: 'preToolUse',
      conversation_id: 'next-conv',
      generation_id: 'next-turn',
      tool_name: 'Read',
      tool_use_id: 'call-next-read',
    };

    journal.appendEvent(completedTurnEvent);
    const snapshot = journal.readAllEvents();

    journal.appendEvent(concurrentAppendEvent);
    journal.rewriteJournal([], snapshot);

    expect(journal.readAllEvents()).toEqual([concurrentAppendEvent]);
  });

  test('readAllEvents reads under the journal lock', () => {
    journal.appendEvent({
      _journal_ts: '2026-06-11T10:00:00.000Z',
      hook_event: 'beforeSubmitPrompt',
      conversation_id: 'locked-read-conv',
      generation_id: 'locked-read-turn',
      prompt: 'read safely',
    });

    const openSpy = vi.spyOn(fs, 'openSync');
    const events = journal.readAllEvents();

    expect(events).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledWith(
      path.join(journal.CURSOR_JOURNAL_DIR, 'event-journal.lock'),
      'wx',
    );

    openSpy.mockRestore();
  });

  test('lock timeout is longer than stale lock threshold', () => {
    expect(journal.CURSOR_JOURNAL_LOCK_TIMEOUT_MS).toBeGreaterThan(
      journal.CURSOR_JOURNAL_LOCK_STALE_MS,
    );
  });

  test('mergeConcurrentAppends deduplicates events regardless of property order', () => {
    // Event written to journal with one property order
    const eventOriginal = {
      _journal_ts: '2026-06-11T10:00:00.000Z',
      hook_event: 'preToolUse',
      conversation_id: 'dedup-conv',
      generation_id: 'gen-1',
      tool_name: 'Write',
      tool_use_id: 'call-write-1',
    };

    journal.appendEvent(eventOriginal);
    const snapshot = journal.readAllEvents();

    // No concurrent appends happened. The processor rewrites with the event
    // as a remaining event (same logical event, different property order —
    // simulating what happens when the remaining array is constructed from
    // an in-memory filter rather than the original file content).
    const eventReordered = {
      conversation_id: 'dedup-conv',
      tool_use_id: 'call-write-1',
      _journal_ts: '2026-06-11T10:00:00.000Z',
      generation_id: 'gen-1',
      hook_event: 'preToolUse',
      tool_name: 'Write',
    };

    // rewriteJournal with eventReordered as remaining. The merge should:
    // 1. Recognize the file's original event as matching the snapshot (same key)
    // 2. Write the remaining event without duplication
    journal.rewriteJournal([eventReordered], snapshot);

    const remaining = journal.readAllEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tool_use_id).toBe('call-write-1');
  });

  test('mergeConcurrentAppends does NOT deduplicate genuinely different events', () => {
    // Two different events that happen to share timestamp and hook_event
    const eventA = {
      _journal_ts: '2026-06-11T10:00:00.000Z',
      hook_event: 'preToolUse',
      conversation_id: 'dedup-conv-2',
      generation_id: 'gen-1',
      tool_name: 'Write',
      tool_use_id: 'call-write-A',
    };
    const eventB = {
      _journal_ts: '2026-06-11T10:00:00.000Z',
      hook_event: 'preToolUse',
      conversation_id: 'dedup-conv-2',
      generation_id: 'gen-1',
      tool_name: 'Read',
      tool_use_id: 'call-write-B',
    };

    journal.appendEvent(eventA);
    const snapshot = journal.readAllEvents();

    // Append a genuinely different event (different tool_use_id)
    journal.appendEvent(eventB);
    journal.rewriteJournal([], snapshot);

    const remaining = journal.readAllEvents();
    // eventB should NOT be deduplicated — it has a different tool_use_id
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tool_use_id).toBe('call-write-B');
  });
});
