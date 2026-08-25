import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraeAgentTrajectoryInput } from '../../../../src/inputs/trae-agent-trajectory/trae-agent-trajectory-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const FIXTURE = path.resolve(__dirname, 'fixtures/fixture_trajectory_qwen_max.json');
const CONVERTER_PATH = path.resolve(__dirname, '../../../../assets/hooks/trae-agent/trajectory-converter.mjs');

describe('TraeAgentTrajectoryInput - TypeScript smoke (CP4)', () => {
  let tmpDir: string;
  let trajectoryFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-ts-smoke-'));
    trajectoryFile = path.join(tmpDir, 'trajectory.json');
    await fs.copyFile(FIXTURE, trajectoryFile);
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('input.collect() emits 58 entries on first cycle and 0 on second (dedup)', async () => {
    const stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    // 15 LLM.req + 15 LLM.resp + 14 TOOL.call + 14 TOOL.result (step 15 has 0 tools)
    // No SESSION/STEP 'other' markers — the OTLP converter library synthesizes
    // ENTRY/AGENT/STEP from the LLM/TOOL records.
    expect(first.length).toBe(58);
    const eventCounts: Record<string, number> = {};
    for (const e of first) eventCounts[e['event.name'] as string] = (eventCounts[e['event.name'] as string] ?? 0) + 1;
    expect(eventCounts).toEqual({
      'llm.request': 15,
      'llm.response': 15,
      'tool.call': 14,
      'tool.result': 14,
    });
    // @ts-expect-error: protected
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second.length).toBe(0);
  });
});
