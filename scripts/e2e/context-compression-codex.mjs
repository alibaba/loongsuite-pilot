#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  workspace: { type: 'string' },
  codex: { type: 'string', default: 'codex' },
  limit: { type: 'string', default: '6000' },
} });
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
const workspace = values.workspace
  ? path.resolve(values.workspace)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-codex-compression-'));
await fs.mkdir(workspace, { recursive: true });
if ((await fs.readdir(workspace)).length > 0) throw new Error('The harness workspace must be empty');

for (let phase = 1; phase <= 4; phase++) {
  const requirements = Array.from({ length: 160 }, (_, index) =>
    `Requirement ${index + 1} phase ${phase}: retain identity for tenant zone-${index % 7}, report request latency, and keep field code ${100000 + phase * 1000 + index} available for review.`);
  await fs.writeFile(path.join(workspace, `phase-${phase}.txt`),
    `Service AmberBridge, region cn-hangzhou, phase ${phase}.\n${requirements.join('\n')}\n`);
}
const prompt = 'Complete this contained observability experiment in one turn. Read phase-1.txt, phase-2.txt, phase-3.txt and phase-4.txt sequentially using four separate shell tool invocations. Read one file per invocation, briefly confirm each phase and continue. Do not delegate. After phase 4, write result.txt with the service name and deployment region, then respond with both. Confine file changes to this directory.';
await fs.writeFile(path.join(workspace, 'prompt.txt'), prompt);
const events = await fs.open(path.join(workspace, 'events.jsonl'), 'wx');
const stderr = await fs.open(path.join(workspace, 'stderr.log'), 'wx');
const child = spawn(values.codex, ['exec', '-C', workspace, '--skip-git-repo-check', '--json', '--color', 'never',
  '-c', `model_auto_compact_token_limit=${limit}`,
  '-c', 'model_auto_compact_token_limit_scope="body_after_prefix"',
  '-s', 'workspace-write', '-o', path.join(workspace, 'final.txt'), '-'],
{ stdio: ['pipe', events.fd, stderr.fd] });
child.stdin.end(prompt);
const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 190000);
let code;
try {
  code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
} finally {
  clearTimeout(timer);
  clearTimeout(killTimer);
  await Promise.all([events.close(), stderr.close()]);
}
if (code !== 0) throw new Error(`Codex exited with ${code}. Evidence is in ${workspace}`);
const output = (await fs.readFile(path.join(workspace, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const sessionId = output.find(record => record.type === 'thread.started')?.thread_id;
if (!sessionId) throw new Error('Codex did not report a native session ID');
const dates = new Set([new Date().toISOString().slice(0, 10), new Date().toLocaleDateString('sv-SE')]);
let transcript;
for (const date of dates) {
  const directory = path.join(os.homedir(), '.codex', 'sessions', ...date.split('-'));
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const name = names.find(name => name.endsWith(`${sessionId}.jsonl`));
  if (name) { transcript = path.join(directory, name); break; }
}
if (!transcript) throw new Error(`Native rollout for ${sessionId} was not found`);
const native = (await fs.readFile(transcript, 'utf8')).trim().split('\n').map(JSON.parse);
const turns = native.filter(record => record.payload?.type === 'task_started').map(record => record.payload.turn_id);
const compressions = native.filter(record => record.payload?.type === 'item_completed'
  && record.payload.item?.type === 'ContextCompaction').map(record => ({
  id: record.payload.item.id, turnId: record.payload.turn_id,
  startedAtMs: record.payload.started_at_ms, completedAtMs: record.payload.completed_at_ms,
}));
const result = await fs.readFile(path.join(workspace, 'result.txt'), 'utf8');
const summary = { workspace, transcript, sessionId, turns, compressions, result };
await fs.writeFile(path.join(workspace, 'summary.json'), JSON.stringify(summary, null, 2));
if (turns.length !== 1 || compressions.length === 0 || compressions.some(item => item.turnId !== turns[0])) {
  throw new Error(`Expected automatic compression within one native turn. Inspect ${workspace}`);
}
if (!result.includes('AmberBridge') || !result.includes('cn-hangzhou')) throw new Error('The final result lost the requested facts');
console.log(JSON.stringify(summary, null, 2));
