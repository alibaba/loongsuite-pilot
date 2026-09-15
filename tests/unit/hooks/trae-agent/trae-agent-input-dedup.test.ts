import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraeAgentTrajectoryInput } from '../../../../src/inputs/trae-agent-trajectory/trae-agent-trajectory-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Fixture source: researcher comment fe220457 attachment (52KB), extracted from a
// real trae-agent run with qwen-max via DashScope Anthropic-compatible proxy.
const FIXTURE_SRC = path.resolve(__dirname, 'fixtures/fixture_trajectory_qwen_max.json');
const CONVERTER_PATH = path.resolve(__dirname, '../../../../assets/hooks/trae-agent/trajectory-converter.mjs');

let tmpDir: string;
let trajectoryFile: string;
let stateFile: string;
let stateStore: StateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-input-test-'));
  trajectoryFile = path.join(tmpDir, 'trajectory.json');
  await fs.copyFile(FIXTURE_SRC, trajectoryFile);
  stateFile = path.join(tmpDir, 'state.json');
  stateStore = new StateStore(stateFile);
  await stateStore.load();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TraeAgentTrajectoryInput - incremental dedup (P0-2)', () => {
  test('first cycle emits all 15 steps; second cycle emits nothing', async () => {
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: call protected collect()
    const first = (await input.collect()) as AgentActivityEntry[];
    // 15 LLM.req + 15 LLM.resp + 14 TOOL.call + 14 TOOL.result = 58.
    // No SESSION/STEP 'other' markers — the OTLP converter library
    // synthesizes ENTRY/AGENT/STEP from these LLM/TOOL records.
    expect(first.length).toBe(58);
    const otherEvents = first.filter(e => e['event.name'] === 'other');
    expect(otherEvents.length).toBe(0);

    // @ts-expect-error: collect again — seen set should suppress everything
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second.length).toBe(0);
  });

  test('adding a new step (length grew) emits only the new step', async () => {
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);

    // Append a synthetic step 16 (no tool_calls) to the trajectory file
    const json = JSON.parse(await fs.readFile(trajectoryFile, 'utf8'));
    const newStep = {
      ...json.agent_steps[0],
      step_number: 16,
      timestamp: '2026-08-25T10:01:00.000000',
      tool_calls: [],
      tool_results: [],
      reflection: 'additional synthetic step',
    };
    json.agent_steps.push(newStep);
    json.llm_interactions.push({
      ...json.llm_interactions[0],
      timestamp: '2026-08-25T10:01:00.000000',
    });
    await fs.writeFile(trajectoryFile, JSON.stringify(json, null, 2));

    // @ts-expect-error
    const second = (await input.collect()) as AgentActivityEntry[];
    // 1 LLM.req + 1 LLM.resp + 0 TOOL = 2 (step 16 has 0 tool_calls)
    expect(second.length).toBe(2);
    const newStepReq = second.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(':s16'));
    expect(newStepReq).toBeDefined();
  });

  test('same step_numbers but mutated content with grown size stays suppressed', async () => {
    // Architect P0-2 forbids length-only dedup. The input dedups by step_number
    // (a monotonic id), so when step_numbers don't change AND no truncation
    // occurred, nothing re-emits — even if file content mutated.
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);

    // Mutate step 1's reflection (longer string → file size grows, NOT truncation).
    const json = JSON.parse(await fs.readFile(trajectoryFile, 'utf8'));
    json.agent_steps[0].reflection = 'x'.repeat(2000);
    await fs.writeFile(trajectoryFile, JSON.stringify(json, null, 2));

    // @ts-expect-error — same step_numbers, file grew (not truncation) → no emit.
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second.length).toBe(0);
  });

  test('content mutation that shrinks file size triggers truncation reset (full re-emit)', async () => {
    // Architect P0-2: truncation = size shrunk → reset seen set + session_reset marker.
    // This catches the "step 1's tool name changed from long to short" case where
    // length-only dedup would silently lose the mutation.
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);

    const json = JSON.parse(await fs.readFile(trajectoryFile, 'utf8'));
    // Replace 15 steps with only the first 2 — file shrinks, triggers reset.
    json.agent_steps = json.agent_steps.slice(0, 2);
    json.llm_interactions = json.llm_interactions.slice(0, 2);
    await fs.writeFile(trajectoryFile, JSON.stringify(json, null, 2));

    // @ts-expect-error — truncate fires → reset + session_reset stamping.
    const second = (await input.collect()) as AgentActivityEntry[];
    // 2 LLM.req + 2 LLM.resp + 2 TOOL.call + 2 TOOL.result = 8
    expect(second.length).toBe(8);
    // session_reset must be stamped on every record (the marker is the only
    // way downstream consumers learn the session restarted; no separate
    // SESSION 'other' event is emitted anymore).
    const stamped = second.filter(e => e['agent.trajectory.session_reset'] === true);
    expect(stamped.length).toBe(second.length);
  });

  test('truncation (size shrunk) clears seen set + sets sessionReset on every emitted record', async () => {
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);

    // Write a truncated trajectory (only first 3 steps).
    const json = JSON.parse(await fs.readFile(trajectoryFile, 'utf8'));
    json.agent_steps = json.agent_steps.slice(0, 3);
    json.llm_interactions = json.llm_interactions.slice(0, 3);
    await fs.writeFile(trajectoryFile, JSON.stringify(json, null, 2));

    // @ts-expect-error
    const second = (await input.collect()) as AgentActivityEntry[];
    // 3 LLM.req + 3 LLM.resp + 3 TOOL.call + 3 TOOL.result = 12
    expect(second.length).toBe(12);
    const stamped = second.filter(e => e['agent.trajectory.session_reset'] === true);
    expect(stamped.length).toBe(second.length);
  });

  test('missing trajectory file produces no entries (no crash)', async () => {
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile: path.join(tmpDir, 'nonexistent.json'),
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out).toEqual([]);
  });

  test('empty trajectory (no steps/interactions) produces no entries — no crash', async () => {
    // No SESSION root is emitted anymore; with no agent_steps there is
    // nothing to convert. The converter returns an empty entry list.
    await fs.writeFile(trajectoryFile, JSON.stringify({ task: '', start_time: '', provider: '' }));
    const input = new TraeAgentTrajectoryInput({
      stateStore,
      trajectoryFile,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out.length).toBe(0);
  });
});
