import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QoderTranscriptCollector } from '../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';
import { InputManager } from '../../src/core/input-manager.js';
import { InterceptResultLinker } from '../../src/core/intercept-result-linker.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { PROMPT_CORRELATION_FIELD, promptLookupFromEntry } from '../../src/interceptor/prompt-verdict.js';
import { ToolVerdictStore } from '../../src/interceptor/tool-verdict-store.js';
import { startInterceptorWorker, type InterceptorWorkerService } from '../../src/interceptor/worker-service.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';

// Artificial pattern fixture, never a credential or a private transcript.
const syntheticKey = 'LTAI' + '0'.repeat(16);
const prompt = `帮我看下 ${syntheticKey} 这个 key 能不能用，123`;
const sessionId = 'synthetic-app-session';
const nativeRequestId = 'synthetic-native-request';
const variants = [
  { name: 'App with product only on Stop', route: 'qoder', hookProduct: undefined, stopProduct: 'app', cliRows: true, agentType: 'qoder-app' },
  { name: 'CLI route', route: 'qodercli', hookProduct: undefined, stopProduct: 'cli', cliRows: true, agentType: 'qoder-cli' },
  { name: 'CLI product on generic route', route: 'qoder', hookProduct: 'cli', stopProduct: 'cli', cliRows: true, agentType: 'qoder-cli' },
  { name: 'App product on generic route', route: 'qoder', hookProduct: 'app', stopProduct: 'app', cliRows: true, agentType: 'qoder-app' },
  { name: 'IDE route and native rows', route: 'qoder', hookProduct: 'ide', stopProduct: undefined, cliRows: false, agentType: 'qoder' },
] as const;

describe.each(variants)('Qoder prompt audit reaches native JSONL output: $name', variant => {
  it.each([true, false])('preserves product identity and log evidence with captureMessageContent=%s', async capture => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-prompt-guardrail-'));
    const dataDir = join(root, 'data');
    const outputDir = join(root, 'output');
    const transcript = join(root, 'native.jsonl');
    const configDir = join(dataDir, 'configs', 'managed');
    const manager = new InputManager();
    const flusher = new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false, maxFileSizeMb: 10 });
    const collector = new QoderTranscriptCollector({ dataDir, agentId: 'qoder', stableMs: 0, settleMs: 0 });
    let service: InterceptorWorkerService | undefined;
    try {
      await mkdir(configDir, { recursive: true });
      // Use a literal keyword to exercise audit correlation.
      await writeFile(join(configDir, 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
        kind: 'pattern', id: 'synthetic-access-key', version: '7', agents: ['qoder', 'qodercli'],
        events: ['UserPromptSubmit'], match: 'substring', keywords: [syntheticKey], action: 'log',
      }] } }));
      const workerFile = join(root, 'interceptor-worker.cjs');
      await build({ entryPoints: [resolve('src/interceptor/worker.ts')], outfile: workerFile,
        bundle: true, platform: 'node', target: 'es2022', format: 'cjs', mainFields: ['module', 'main'],
        define: { __PROPRIETARY_BUILD__: 'false' }, logLevel: 'silent' });
      service = await startInterceptorWorker({ dataDir, version: 'test', mode: 'all',
        workerUrl: pathToFileURL(workerFile), managedReloadIntervalMs: 60_000 });
      expect(service.port).toEqual(expect.any(Number));
      expect(service.managedActive).toBe(true);
      const evaluate = async (body: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${service!.port}/v1/hooks/evaluate`, {
          method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
          body: JSON.stringify({ agent: variant.route, event: 'UserPromptSubmit', raw: {}, ...body }),
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await evaluate({ prompt: 'fixture prompt without a key' })).toMatchObject({
        action: 'allow', matched: false, evaluatedRules: ['synthetic-access-key'],
      });
      // request_set_id is absent; product may arrive only with the Stop Hook.
      expect(await evaluate({ sessionId, transcriptPath: transcript, cwd: root, prompt,
        raw: { session_id: sessionId, transcript_path: transcript, cwd: root,
          hook_event_name: 'UserPromptSubmit', permission_mode: 'yolo', prompt,
          ...(variant.hookProduct ? { parent_business_info: { product: variant.hookProduct } } : {}) } }))
        .toMatchObject({ action: 'allow', matched: true, ruleId: 'synthetic-access-key' });

      const at = Date.now();
      const rows = [
        { type: 'user', uuid: 'synthetic-user', ...(variant.cliRows ? { promptId: 'synthetic-prompt', entrypoint: 'cli' } : {}),
          requestSetId: nativeRequestId, humanInput: { text: prompt }, timestamp: new Date(at).toISOString(),
          message: { role: 'user', content: prompt } },
        { type: 'assistant', timestamp: new Date(at + 100).toISOString(), message: {
          id: 'synthetic-response', role: 'assistant', model: 'synthetic-model', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Synthetic response.' }],
        } },
        { type: 'last-prompt', lastPrompt: prompt },
      ];
      await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      // The owning Stop supplies App identity even though App native rows look like CLI rows.
      expect(publishQoderWakeup({ session_id: sessionId, transcript_path: transcript, hook_event_name: 'Stop',
        cwd: root, ...(variant.stopProduct ? { parent_business_info: { product: variant.stopProduct } } : {}) },
      { dataDir, agentId: 'qoder' })).toBe(true);
      const batch = await collector.collect({});
      const request = batch.records.find(record => record['event.name'] === 'llm.request') as AgentActivityEntry;
      expect(request).toMatchObject({ 'gen_ai.agent.type': variant.agentType });
      const lookup = promptLookupFromEntry(request)!;
      expect(lookup.requestId).toMatch(/^[a-f0-9]{64}$/);
      await service.syncVerdicts();
      if (variant.hookProduct || variant.route === 'qodercli') {
        // An explicitly known product cannot borrow another product's audit.
        for (const otherType of ['qoder', 'qoder-cli', 'qoder-app'].filter(type => type !== variant.agentType)) {
          expect(service.verdictStore.getPromptSnapshot({ ...lookup, agentType: otherType })).toBeNull();
        }
      }

      await flusher.start();
      manager.setFlusher(flusher);
      manager.setAgentsConfig({ qoder: { captureMessageContent: capture } });
      manager.setMaskConfig({ mode: 'all', types: [] });
      manager.setInterceptResultLinker(new InterceptResultLinker(service.verdictStore, true, () => service!.syncVerdicts()));
      const input = Object.assign(new EventEmitter(), {
        id: 'qoder-trace', agentType: ClientType.Qoder, collectionMethod: CollectionMethod.HookJsonl,
        running: false, setWorkspacePolicy() {}, async stop() {},
      });
      manager.registerInput(input as any);
      input.emit('entries', batch.records as unknown as AgentActivityEntry[]);
      await manager.stopAll();
      await flusher.shutdown();
      await collector.acknowledge(batch.state);

      const files = (await readdir(outputDir)).filter(name => name.endsWith('.jsonl'));
      expect(files).toEqual([`${variant.agentType}-all.jsonl`]);
      const outputText = await readFile(join(outputDir, files[0]!), 'utf8');
      const entries = outputText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        'gen_ai.agent.type': variant.agentType, 'gen_ai.guardrail.triggered': true, 'gen_ai.guardrail.action': 'log',
        'gen_ai.guardrail.rule_id': 'synthetic-access-key', 'gen_ai.guardrail.rule_version': '7',
      });
      for (const entry of entries) {
        expect(entry).not.toHaveProperty(PROMPT_CORRELATION_FIELD);
        for (const field of ['missingRequestId', 'missingAgentType', 'binding']) expect(entry).not.toHaveProperty(field);
        if (!capture) {
          expect(entry).not.toHaveProperty('gen_ai.input.messages');
          expect(entry).not.toHaveProperty('gen_ai.input.messages_delta');
        }
      }
      expect(outputText).not.toContain(syntheticKey);
      expect(outputText).not.toContain(nativeRequestId);
      if (capture) expect(JSON.stringify(requests[0]['gen_ai.input.messages_delta'])).toContain('这个 key 能不能用，123');
      else expect(outputText).not.toContain('这个 key 能不能用');

      // Ownership returns through FIFO IPC to the sole checkpoint writer.
      await service.syncVerdicts();
      await service.stop();
      service = undefined;
      const checkpoint = join(dataDir, 'interceptor', 'tool-verdicts.json');
      const checkpointText = await readFile(checkpoint, 'utf8');
      expect(checkpointText).not.toContain(prompt);
      expect(checkpointText).not.toContain(nativeRequestId);
      const restored = new ToolVerdictStore(checkpoint);
      restored.restore();
      expect(restored.getPromptSnapshot(lookup)).toMatchObject({ action: 'log', ruleId: 'synthetic-access-key', ruleVersion: '7' });
    } finally {
      collector.stop();
      await manager.stopAll();
      await service?.stop();
      await flusher.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
