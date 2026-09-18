// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotLogInput } from '../../../../src/inputs/copilot-log/copilot-log-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Fixture source: tests/unit/hooks/copilot/fixtures/events-session2.jsonl
// — real Copilot CLI v1.0.86 session capture by pilot-researcher-v2.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'hooks', 'copilot', 'fixtures');
const SESSION2 = path.join(FIXTURES, 'events-session2.jsonl');

function readRawEvents(filePath: string): any[] {
  return fsSync.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

async function makeInput(sessionDir: string): Promise<CopilotLogInput> {
  const stateFile = path.join(sessionDir, 'state.json');
  const stateStore = new StateStore(stateFile);
  await stateStore.load();
  return new CopilotLogInput({ stateStore, sessionDir });
}

async function writeSession(sessionDir: string, sessionId: string, events: any[]): Promise<string> {
  const sessionDirFull = path.join(sessionDir, sessionId);
  await fs.mkdir(sessionDirFull, { recursive: true });
  const eventsFile = path.join(sessionDirFull, 'events.jsonl');
  await fs.writeFile(eventsFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return eventsFile;
}

async function callCollect(input: CopilotLogInput): Promise<AgentActivityEntry[]> {
  const collect = (input as unknown as { collect: () => Promise<AgentActivityEntry[]> }).collect.bind(input);
  return collect();
}

describe('CopilotLogInput — CP5 v8 Bug #3: session.shutdown gate with 5-min timeout', () => {
  it('partial poll (no session.shutdown) → emits zero records; buffer holds them', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'copi-v8-'));
    tempDirs.push(tmp);
    const input = await makeInput(tmp);
    const raw = readRawEvents(SESSION2);
    const stripped = raw.filter(e => e.type !== 'session.shutdown');
    await writeSession(tmp, 'sess-1', stripped);

    const out1 = await callCollect(input);
    expect(out1.length).toBe(0);
    // Buffer should be holding records (STEP/LLM/TOOL would have been emitted
    // if not gated). Inspect via private map.
    const buffers = (input as unknown as { sessionBuffers: Map<string, { records: AgentActivityEntry[] }> }).sessionBuffers;
    expect(buffers.size).toBe(1);
    for (const buf of buffers.values()) {
      expect(buf.records.length).toBeGreaterThan(0);
    }
  });

  it('session.shutdown present → emits all records on first poll', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'copi-v8-'));
    tempDirs.push(tmp);
    const input = await makeInput(tmp);
    const raw = readRawEvents(SESSION2);
    await writeSession(tmp, 'sess-1', raw);

    const out1 = await callCollect(input);
    expect(out1.length).toBeGreaterThan(0);
    // At least one ENTRY record (event.name='other' + gen_ai.session.start_time)
    const entryAgent = out1.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
      && e['gen_ai.turn.start'] === undefined);
    expect(entryAgent.length).toBeGreaterThanOrEqual(1);
    // Buffer cleared after shutdown flush
    const buffers = (input as unknown as { sessionBuffers: Map<string, { records: AgentActivityEntry[] }> }).sessionBuffers;
    expect(buffers.size).toBe(0);
  });

  it('partial poll → next poll appends shutdown line → emits all records (re-parse)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'copi-v8-'));
    tempDirs.push(tmp);
    const input = await makeInput(tmp);
    const raw = readRawEvents(SESSION2);
    const stripped = raw.filter(e => e.type !== 'session.shutdown');
    const eventsFile = await writeSession(tmp, 'sess-1', stripped);

    const out1 = await callCollect(input);
    expect(out1.length).toBe(0);

    // Append shutdown event (simulating the file growing mid-session)
    const shutdownEvent = raw.find(e => e.type === 'session.shutdown');
    expect(shutdownEvent).toBeDefined();
    await fs.appendFile(eventsFile, JSON.stringify(shutdownEvent) + '\n');

    // Second poll: file grew, re-parse, shutdown now present → emit all
    const out2 = await callCollect(input);
    expect(out2.length).toBeGreaterThan(0);
    const entryAgent = out2.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
      && e['gen_ai.turn.start'] === undefined);
    expect(entryAgent.length).toBeGreaterThanOrEqual(1);
  });
});
