import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promptHash, promptKeyFromRequest, promptRequestId } from '../../src/interceptor/prompt-verdict.js';
import { ToolVerdictStore } from '../../src/interceptor/tool-verdict-store.js';
import { startInterceptorWorker, type InterceptorWorkerService } from '../../src/interceptor/worker-service.js';

const prompt = 'synthetic prompt ownership shutdown probe';
const sessionId = 'synthetic-shutdown-session';
const toolKey = { sessionId, toolUseId: 'synthetic-tool', phase: 'PreToolUse' as const };

async function setup(updateDiskBeforeExit = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-ownership-shutdown-'));
  const checkpoint = join(dataDir, 'interceptor', 'tool-verdicts.json');
  const now = Date.now();
  const initial = new ToolVerdictStore(checkpoint);
  const key = promptKeyFromRequest({ agent: 'qoder', event: 'UserPromptSubmit',
    sessionId, prompt, raw: {} })!;
  initial.put(key, { action: 'log', ruleId: 'synthetic-prompt-rule', ruleVersion: '4' }, new Date(now));
  initial.put(toolKey, { action: 'log', ruleId: 'old-tool-rule' }, new Date(now - 1000));
  await initial.checkpoint();
  const fixture = join(dataDir, 'controlled-worker.cjs');
  // A real thread owns the file until exit. The test controls the crash through
  // a private temporary marker, so no supervisor internals need to be mocked.
  await writeFile(fixture, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const checkpoint = path.join(workerData.dataDir, 'interceptor', 'tool-verdicts.json');",
    "fs.writeFileSync(path.join(workerData.dataDir, 'worker-started'), 'started');",
    "parentPort.postMessage({ type: 'ready', port: 19321, managedActive: false, records: workerData.records });",
    'const timer = setInterval(() => {',
    "  if (!fs.existsSync(path.join(workerData.dataDir, 'crash-now'))) return;",
    '  clearInterval(timer);',
    ...(updateDiskBeforeExit ? [
      "  const body = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));",
      "  const tool = body.records.find(record => record.toolUseId === 'synthetic-tool');",
      "  tool.action = 'block'; tool.ruleId = 'newer-disk-tool-rule';",
      '  tool.recordedAt = new Date(Date.now() + 1).toISOString();',
      "  fs.writeFileSync(checkpoint + '.writer.tmp', JSON.stringify(body));",
      "  fs.renameSync(checkpoint + '.writer.tmp', checkpoint);",
    ] : []),
    '  process.exit(1);',
    '}, 5);',
    "parentPort.on('message', command => {",
    "  if (command.type === 'sync' || command.type === 'status' || command.type === 'stop') {",
    "    parentPort.postMessage({ type: 'reply', id: command.id });",
    "    if (command.type === 'stop') { clearInterval(timer); parentPort.close(); }",
    '  }',
    '});',
  ].join('\n'));
  const lookup = { sessionId, agentType: 'qoder-app', promptHash: promptHash(prompt),
    requestId: promptRequestId('synthetic-native-A'), at: now + 184 };
  return { dataDir, checkpoint, fixture, lookup };
}

async function crashWorker(service: InterceptorWorkerService, dataDir: string) {
  expect(service.port).toBe(19321);
  await writeFile(join(dataDir, 'crash-now'), 'crash');
  // Port is cleared by the actual exit event. Stop is called immediately after
  // this wait, within the supervisor's one-second restart backoff.
  await vi.waitFor(() => expect(service.port).toBeNull(), { timeout: 750, interval: 5 });
}

describe('prompt ownership survives supervisor shutdown after writer exit', () => {
  it.each([false, true])('persists a late mirror binding without losing newer disk records (disk update=%s)', async diskUpdate => {
    const { dataDir, checkpoint, fixture, lookup } = await setup(diskUpdate);
    let service: InterceptorWorkerService | undefined;
    try {
      service = await startInterceptorWorker({ dataDir, mode: 'all', version: 'test', workerUrl: pathToFileURL(fixture) });
      await crashWorker(service, dataDir);
      expect(service.verdictStore.getPromptSnapshot(lookup)).toMatchObject({ action: 'log', ruleId: 'synthetic-prompt-rule' });
      const other = { ...lookup, requestId: promptRequestId('synthetic-native-B') };
      expect(service.verdictStore.getPromptSnapshot(other)).toBeNull();
      const stopping = service.stop();
      expect(service.stop()).toBe(stopping);
      await stopping;
      service = undefined;

      const restored = new ToolVerdictStore(checkpoint);
      restored.restore();
      // Check the persisted ownership before any lookup could create it anew.
      expect(restored.records().find(record => record.phase === 'UserPromptSubmit')).toMatchObject({
        binding: { requestId: lookup.requestId, agentType: 'qoder-app', at: lookup.at },
      });
      expect(restored.getPromptSnapshot(other)).toBeNull();
      expect(restored.getPromptSnapshot(lookup)).toMatchObject({ action: 'log', ruleId: 'synthetic-prompt-rule' });
      expect(restored.getSnapshot(toolKey)).toMatchObject(diskUpdate
        ? { action: 'block', ruleId: 'newer-disk-tool-rule' }
        : { action: 'log', ruleId: 'old-tool-rule' });
      expect(await readFile(checkpoint, 'utf8')).not.toContain(prompt);
    } finally {
      await service?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not rewrite an exited writer checkpoint when no new ownership was observed', async () => {
    const { dataDir, checkpoint, fixture } = await setup(true);
    let service: InterceptorWorkerService | undefined;
    try {
      service = await startInterceptorWorker({ dataDir, mode: 'all', version: 'test', workerUrl: pathToFileURL(fixture) });
      await crashWorker(service, dataDir);
      const before = await stat(checkpoint);
      const content = await readFile(checkpoint, 'utf8');
      await service.stop();
      service = undefined;
      expect(await readFile(checkpoint, 'utf8')).toBe(content);
      expect((await stat(checkpoint)).ino).toBe(before.ino);
      expect((await stat(checkpoint)).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await service?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps disabled mode from starting a writer or rewriting its checkpoint', async () => {
    const { dataDir, checkpoint, fixture } = await setup();
    let service: InterceptorWorkerService | undefined;
    try {
      const before = await stat(checkpoint);
      const content = await readFile(checkpoint, 'utf8');
      service = await startInterceptorWorker({ dataDir, mode: 'none', version: 'test', workerUrl: pathToFileURL(fixture) });
      expect(service.port).toBeNull();
      await service.stop();
      service = undefined;
      await expect(stat(join(dataDir, 'worker-started'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(checkpoint, 'utf8')).toBe(content);
      expect((await stat(checkpoint)).ino).toBe(before.ino);
      expect((await stat(checkpoint)).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await service?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
