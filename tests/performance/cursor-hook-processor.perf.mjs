#!/usr/bin/env node
/**
 * Manual performance runner for Cursor hook processor.
 *
 * Usage:
 *   npm run perf:cursor-hook
 *
 * Measures both the processor and the shell entrypoint, using real captured
 * Cursor payloads plus synthetic large tool outputs up to 20MB.
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
const shellPath = path.join(repoRoot, 'assets', 'hooks', 'cursor-loongsuite-pilot-hook.sh');

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${(bytes / 1024).toFixed(2)}KB`;
}

const raw = await fs.readFile(fixturePath, 'utf-8');
const realPayloads = raw
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

if (realPayloads.length === 0) {
  throw new Error(`No payloads found in ${fixturePath}`);
}

function makeLargeToolOutputPayload(label, targetBytes) {
  const base = {
    conversation_id: 'synthetic-conversation',
    generation_id: `synthetic-${label}`,
    model: 'gpt-5.5',
    tool_name: 'WebFetch',
    tool_input: {
      url: `https://example.test/${label}`,
    },
    tool_output: '',
    tool_use_id: `synthetic-tool-${label}`,
    session_id: 'synthetic-session',
    hook_event_name: 'postToolUse',
    cursor_version: 'synthetic',
  };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const contentBytes = Math.max(0, targetBytes - overhead - 64);
  base.tool_output = JSON.stringify({
    status: 'success',
    content: 'A'.repeat(contentBytes),
  });
  return JSON.stringify(base);
}

const syntheticCases = [
  { label: '10KB', bytes: 10 * 1024, iterations: 10 },
  { label: '1MB', bytes: 1024 * 1024, iterations: 5 },
  { label: '10MB', bytes: 10 * 1024 * 1024, iterations: 3 },
  { label: '20MB', bytes: 20 * 1024 * 1024, iterations: 2 },
];

function runCommand(command, args, payload, tmpDir) {
  return spawnSync(command, args, {
    input: payload,
    env: {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: tmpDir,
    },
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
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
      approxOneCoreCpuAt3PerSec: `${Math.min(100, (avgMs * 3 / 1000) * 100).toFixed(1)}%`,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function benchmarkCase(prefix, testCase, command, args) {
  const payload = makeLargeToolOutputPayload(testCase.label.toLowerCase(), testCase.bytes);
  return {
    payloadSize: formatBytes(Buffer.byteLength(payload)),
    ...(await benchmark(
      `${prefix}:${testCase.label}`,
      Array.from({ length: testCase.iterations }, () => payload),
      command,
      args,
    )),
  };
}

async function benchmarkRate(name, testCase, eventCount) {
  const payload = makeLargeToolOutputPayload(testCase.label.toLowerCase(), testCase.bytes);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-rate-perf-'));
  const timings = [];
  let failed = 0;
  const startedAt = performance.now();

  try {
    for (let i = 0; i < eventCount; i++) {
      const target = startedAt + (i * 1000 / 3);
      while (performance.now() < target) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10, target - performance.now())));
      }

      const started = performance.now();
      const result = runCommand('bash', [shellPath], payload, tmpDir);
      timings.push(performance.now() - started);
      if (result.status !== 0 || result.stdout.trim() !== '{}') failed += 1;
    }

    const elapsedMs = performance.now() - startedAt;
    const busyMs = timings.reduce((sum, value) => sum + value, 0);
    return {
      name,
      payloadSize: formatBytes(Buffer.byteLength(payload)),
      eventCount,
      failed,
      elapsed: formatMs(elapsedMs),
      avg: formatMs(busyMs / timings.length),
      max: formatMs(Math.max(...timings)),
      sequentialBusyPctOfWall: `${((busyMs / elapsedMs) * 100).toFixed(1)}%`,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const output = {
  fixture: path.relative(repoRoot, fixturePath),
  realPayloads: realPayloads.length,
  syntheticPayloads: syntheticCases.map(({ label, bytes }) => ({ label, targetSize: formatBytes(bytes) })),
  results: [
    await benchmark('processor:real', realPayloads, process.execPath, [processorPath]),
    await benchmark('shell:real', realPayloads, 'bash', [shellPath]),
    ...await Promise.all(syntheticCases.map(testCase =>
      benchmarkCase('processor', testCase, process.execPath, [processorPath]),
    )),
    ...await Promise.all(syntheticCases.map(testCase =>
      benchmarkCase('shell', testCase, 'bash', [shellPath]),
    )),
  ],
  rateResults: [
    await benchmarkRate('shell:10MB:3-per-sec', syntheticCases[2], 15),
    await benchmarkRate('shell:20MB:3-per-sec', syntheticCases[3], 9),
  ],
};

console.log(JSON.stringify(output, null, 2));
if (
  output.results.some(result => result.failed > 0) ||
  output.rateResults.some(result => result.failed > 0)
) process.exitCode = 1;
