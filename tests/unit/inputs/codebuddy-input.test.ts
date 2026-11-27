import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
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
    const stopAtMs = Date.now();
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
    const baseMs = Date.now();
    for (let i = 0; i < oversized; i++) {
      await writeFile(path.join(sessionDir, `${String(i).padStart(3, '0')}.json`), JSON.stringify({
        hook_event_name: 'Stop', session_id: 'conv-1', observed_at_ms: baseMs + i,
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
    expect(boundaries?.['conv-1']?.stops.at(-1)).toBe(baseMs + oversized - 1);
  });

  it('records UserPromptSubmit as boundary evidence (abort produces no Stop)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    const sessionDir = path.join(hookEventDir, 'conv-1-abcdef');
    await mkdir(sessionDir, { recursive: true });
    const promptAtMs = Date.now();
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

  it('deletes consumed event files and empty session dirs (consume-and-delete)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    const sessionDir = path.join(hookEventDir, 'conv-1-abcdef');
    await mkdir(sessionDir, { recursive: true });
    const stopAtMs = Date.now();
    await writeFile(path.join(sessionDir, '001.json'), JSON.stringify({
      hook_event_name: 'Stop', session_id: 'conv-1', observed_at_ms: stopAtMs,
      transcript_path: '',
    }));
    // A tmp file within the orphan grace window must survive, keeping its
    // session dir alive for the writer's in-flight rename.
    await writeFile(path.join(sessionDir, '.fresh.tmp'), '{}');

    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new CodeBuddyInput({ stateStore, hookEventDir });
    await (input as unknown as { onStart(): Promise<void> }).onStart();
    await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    await (input as unknown as { onStop(): Promise<void> }).onStop();

    // The consumed event file is gone; the grace-window tmp file remains.
    const leftovers = await readdir(sessionDir);
    expect(leftovers).toEqual(['.fresh.tmp']);
    // Boundaries were persisted before deletion, so the evidence survives.
    const boundaries = stateStore.get('codebuddy').extra?.['boundaries'] as
      Record<string, { stops: number[] }> | undefined;
    expect(boundaries?.['conv-1']?.stops).toEqual([stopAtMs]);
  });

  it('strips legacy offset state keys and prunes boundary entries past the retention window', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hook-'));
    const hookEventDir = path.join(root, 'state', 'codebuddy', 'hook-events');
    await mkdir(hookEventDir, { recursive: true });

    const stateStore = new StateStore(path.join(root, 'state.json'));
    // Simulate a pre-upgrade state: offset map + an ancient session boundary.
    const ancientMs = Date.now() - 40 * 24 * 60 * 60 * 1_000;
    stateStore.set('codebuddy', {
      extra: {
        codebuddyHookEventOffsets: { 'C:/old/001.json': 123 },
        codebuddyHookInitialized: true,
        boundaries: { 'ancient': { stops: [ancientMs], prompts: [] } },
      },
    } as unknown as Parameters<StateStore['set']>[1]);

    const input = new CodeBuddyInput({ stateStore, hookEventDir });
    await (input as unknown as { onStart(): Promise<void> }).onStart();
    await (input as unknown as { collect(): Promise<unknown[]> }).collect();
    await (input as unknown as { onStop(): Promise<void> }).onStop();

    const extra = stateStore.get('codebuddy').extra as Record<string, unknown>;
    expect(extra['codebuddyHookEventOffsets']).toBeUndefined();
    expect(extra['codebuddyHookInitialized']).toBeUndefined();
    const boundaries = extra['boundaries'] as Record<string, unknown>;
    // The 40-day-old session is past the retention window and dropped; a
    // fresh observation re-creates the entry with the next prompt.
    expect(boundaries['ancient']).toBeUndefined();
  });
});
