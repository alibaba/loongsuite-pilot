#!/usr/bin/env node
/**
 * Manual performance runner for Cursor hook processor.
 *
 * Usage:
 *   npm run perf:cursor-hook
 *
 * Measures both the processor and the shell entrypoint, using real captured
 * Cursor payloads plus synthetic large tool outputs.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const fixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'cursor-hook',
  'raw-cursor-hooks-2026-04-30.jsonl',
);
const processorPath = path.join(repoRoot, 'assets', 'hooks', 'cursor-hook-processor.mjs');
const shellPath = path.join(repoRoot, 'assets', 'hooks', 'cursor-aac-hook.sh');

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

const raw = await fs.readFile(fixturePath, 'utf-8');
const realPayloads = raw
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

if (realPayloads.length === 0) {
  throw new Error(`No payloads found in ${fixturePath}`);
}

function makeLargeToolOutputPayload(label, bytes) {
  const article = 'A'.repeat(bytes);
  return JSON.stringify({
    conversation_id: 'synthetic-conversation',
    generation_id: `synthetic-${label}`,
    model: 'gpt-5.5',
    tool_name: 'WebFetch',
    tool_input: {
      url: `https://example.test/${label}`,
    },
    tool_output: JSON.stringify({
      status: 'success',
      content: article,
    }),
    tool_use_id: `synthetic-tool-${label}`,
    session_id: 'synthetic-session',
    hook_event_name: 'postToolUse',
    cursor_version: 'synthetic',
  });
}

const syntheticPayloads = [
  makeLargeToolOutputPayload('100kb', 100 * 1024),
  makeLargeToolOutputPayload('1mb', 1024 * 1024),
  makeLargeToolOutputPayload('5mb', 5 * 1024 * 1024),
];

function runCommand(command, args, payload, tmpDir) {
  return spawnSync(command, args, {
    input: payload,
    env: {
      ...process.env,
      AAC_DATA_DIR: tmpDir,
    },
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 16,
  });
}

async function benchmark(name, payloads, command, args) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-perf-'));
  const timings = [];
  let failed = 0;

  try {
    for (const payload of payloads) {
      const started = performance.now();
      const result = runCommand(command, args, payload, tmpDir);
      timings.push(performance.now() - started);

      if (result.status !== 0 || result.stdout.trim() !== '{}') {
        failed += 1;
      }
    }

    const totalMs = timings.reduce((sum, value) => sum + value, 0);
    const avgMs = totalMs / timings.length;
    return {
      name,
      payloads: payloads.length,
      failed,
      total: formatMs(totalMs),
      avg: formatMs(avgMs),
      p50: formatMs(percentile(timings, 50)),
      p95: formatMs(percentile(timings, 95)),
      p99: formatMs(percentile(timings, 99)),
      max: formatMs(Math.max(...timings)),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const output = {
  fixture: path.relative(repoRoot, fixturePath),
  realPayloads: realPayloads.length,
  syntheticPayloads: syntheticPayloads.map(payload => `${Math.round(Buffer.byteLength(payload) / 1024)}KB`),
  results: [
    await benchmark('processor:real', realPayloads, process.execPath, [processorPath]),
    await benchmark('shell:real', realPayloads, 'bash', [shellPath]),
    await benchmark('processor:synthetic-large', syntheticPayloads, process.execPath, [processorPath]),
    await benchmark('shell:synthetic-large', syntheticPayloads, 'bash', [shellPath]),
  ],
};

console.log(JSON.stringify(output, null, 2));
if (output.results.some(result => result.failed > 0)) process.exitCode = 1;
