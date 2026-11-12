import { it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { InputRuntimeAccumulator } from '../../../../src/inputs/base/input-runtime-metrics.js';

it.each([true, false])('advances across a large fork record; initially terminated=%s', async terminated => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-search-progress-'));
  try {
    const file = path.join(root, 'rollout.jsonl');
    const large = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(17 * 1024 * 1024) } });
    await fs.writeFile(file, large + (terminated ? '\n' : ''));
    const input = new CodexTranscriptInput({ stateStore: new StateStore(path.join(root, 'state.json')), sessionDir: root, wakeupDir: path.join(root, 'wakeups') });
    // Exercise bootstrap in isolation: the owned turn follows copied history.
    const probe = input as any;
    const checkpoint: any = { scanOffset: 0, forkBootstrap: { state: 'live-pending', searchOffset: 0, initialTurnId: 'owned' } };
    const prepare = async () => {
      probe.activeRuntimeAccumulator = new InputRuntimeAccumulator();
      const stat = await fs.stat(file);
      const result = await probe.prepareCopiedTranscript(file, stat.size, { threadId: 'fork' }, checkpoint);
      return { result, metrics: probe.activeRuntimeAccumulator.finish(0) };
    };
    await prepare();
    if (terminated) expect(checkpoint.forkBootstrap.searchOffset).toBe(Buffer.byteLength(large) + 1);
    const quiet = await prepare();
    expect(quiet.metrics.rawReadBytes).toBe(0);
    // Completing a partial line must wake the search; it must not skip the anchor.
    await fs.appendFile(file, (terminated ? '' : '\n') + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'owned' } }) + '\n');
    let resumed = await prepare();
    if (!resumed.result.ready) resumed = await prepare();
    expect(resumed.result.ready).toBe(true);
    expect(checkpoint.scanOffset).toBe(Buffer.byteLength(large) + 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
