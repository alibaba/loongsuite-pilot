import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { CodeBuddyInput } from '../../../src/inputs/codebuddy/codebuddy-input.js';

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('CodeBuddyInput (hook boundary collector)', () => {
  it('emits no entries and records Stop boundaries into its state', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    const sessionDir = path.join(hookEventDir, 'conv-1-abcdef');
    await mkdir(sessionDir, { recursive: true });
    const stopAtMs = 1_733_000_000_000;
    await writeFile(path.join(sessionDir, '001.json'), JSON.stringify({
      hook_event_name: 'SessionStart', session_id: 'conv-1', observed_at_ms: stopAtMs - 5_000,
      transcript_path: '', cwd: 'C:/work',
    }));
    await writeFile(path.join(sessionDir, '002.json'), JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'conv-1', observed_at_ms: stopAtMs - 1_000,
      transcript_path: '', tool_name: 'Bash', tool_call_id: 't1',
    }));
    await writeFile(path.join(sessionDir, '003.json'), JSON.stringify({
      hook_event_name: 'Stop', session_id: 'conv-1', observed_at_ms: stopAtMs,
      transcript_path: '',
    }));
    // A second Stop for another session.
    await mkdir(path.join(hookEventDir, 'conv-2-123456'), { recursive: true });
    await writeFile(path.join(hookEventDir, 'conv-2-123456', '001.json'), JSON.stringify({
      hook_event_name: 'Stop', session_id: 'conv-2', observed_at_ms: stopAtMs + 60_000,
      transcript_path: '',
    }));

    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new CodeBuddyInput({ stateStore, hookEventDir });
    await (input as unknown as { onStart(): Promise<void> }).onStart();
    const entries = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    expect(entries).toEqual([]);

    // Boundaries survive in state and aggregate the latest Stop per session.
    const second = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    expect(second).toEqual([]);
    await (input as unknown as { onStop(): Promise<void> }).onStop();

    const boundaries = stateStore.get('codebuddy').extra?.['boundaries'] as
      Record<string, { stops: number[] }> | undefined;
    expect(boundaries?.['conv-1']?.stops).toEqual([stopAtMs]);
    expect(boundaries?.['conv-2']?.stops).toEqual([stopAtMs + 60_000]);
  });

  it('caps the Stop timeline per session', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    const sessionDir = path.join(hookEventDir, 'conv-1-abcdef');
    await mkdir(sessionDir, { recursive: true });
    // More Stops than the per-session cap (write over several cycles via
    // offsets: each file is read once, so the cap is exercised in one pass).
    const oversized = 80;
    for (let i = 0; i < oversized; i++) {
      await writeFile(path.join(sessionDir, `${String(i).padStart(3, '0')}.json`), JSON.stringify({
        hook_event_name: 'Stop', session_id: 'conv-1', observed_at_ms: 1_733_000_000_000 + i,
        transcript_path: '',
      }));
    }

    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new CodeBuddyInput({ stateStore, hookEventDir });
    await (input as unknown as { onStart(): Promise<void> }).onStart();
    await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    await (input as unknown as { onStop(): Promise<void> }).onStop();

    const boundaries = stateStore.get('codebuddy').extra?.['boundaries'] as
      Record<string, { stops: number[] }> | undefined;
    expect(boundaries?.['conv-1']?.stops.length).toBe(64);
    // Keeps the most recent ones.
    expect(boundaries?.['conv-1']?.stops.at(-1)).toBe(1_733_000_000_000 + oversized - 1);
  });

  it('records UserPromptSubmit as boundary evidence (abort produces no Stop)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    const sessionDir = path.join(hookEventDir, 'conv-1-abcdef');
    await mkdir(sessionDir, { recursive: true });
    const promptAtMs = 1_733_000_000_000;
    // A turn the user aborted: PreToolUse/PostToolUse observed, then the user
    // submitted the next prompt — CodeBuddy never emitted Stop for the run.
    await writeFile(path.join(sessionDir, '001.json'), JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', observed_at_ms: promptAtMs - 10_000,
      transcript_path: '', cwd: 'C:/work',
    }));
    await writeFile(path.join(sessionDir, '002.json'), JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'conv-1', observed_at_ms: promptAtMs - 8_000,
      transcript_path: '', tool_name: 'Bash', tool_call_id: 't1',
    }));
    await writeFile(path.join(sessionDir, '003.json'), JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 'conv-1', observed_at_ms: promptAtMs - 7_000,
      transcript_path: '', tool_name: 'Bash', tool_call_id: 't1',
    }));
    await writeFile(path.join(sessionDir, '004.json'), JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', observed_at_ms: promptAtMs,
      transcript_path: '',
    }));

    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new CodeBuddyInput({ stateStore, hookEventDir });
    await (input as unknown as { onStart(): Promise<void> }).onStart();
    const entries = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    expect(entries).toEqual([]);
    await (input as unknown as { onStop(): Promise<void> }).onStop();

    const boundaries = stateStore.get('codebuddy').extra?.['boundaries'] as
      Record<string, { stops: number[]; prompts: number[] }> | undefined;
    expect(boundaries?.['conv-1']?.stops).toEqual([]);
    expect(boundaries?.['conv-1']?.prompts).toEqual([promptAtMs - 10_000, promptAtMs]);
  });
});
