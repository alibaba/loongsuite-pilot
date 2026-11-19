import { pathToFileURL } from 'node:url';
import { InterceptResultLinker } from '../../src/core/intercept-result-linker.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { startInterceptorWorker } from '../../src/interceptor/worker-service.js';
import { ToolVerdictStore, type ToolVerdictKey } from '../../src/interceptor/tool-verdict-store.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

// A real process stands in for the collector; the test drives HTTP from outside
// this process so a blocked test event loop cannot hide a blocked server.
const dataDir = process.argv[2]!;
const output = new JsonlFlusher({ enabled: true, outputDir: `${dataDir}/output`, rotateDaily: false, maxFileSizeMb: 10 });
await output.start();
const writes = new Set<Promise<void>>();
let outputError: unknown;
function forward(entry: AgentActivityEntry): Promise<void> {
  const writing = output.send(entry).catch(error => { outputError = error; });
  writes.add(writing);
  void writing.finally(() => writes.delete(writing));
  return writing;
}
const store = new ToolVerdictStore(`${dataDir}/interceptor/tool-verdicts.json`);
const service = await startInterceptorWorker({
  dataDir,
  version: 'worker-isolation-test',
  gitCommit: 'worker-test',
  mode: process.argv[4] === 'none' ? 'none' : 'all',
  verdictStore: store,
  emitBlockedPrompt: forward,
  emitEvaluation: forward,
  workerUrl: process.argv[3] === 'default' ? undefined : pathToFileURL(process.argv[3]!),
});

process.send?.({ type: 'ready', port: service.port, pid: process.pid });
process.on('message', (message: { type: string; id: number; key?: ToolVerdictKey; durationMs?: number }) => {
  void handle(message).catch((error) => {
    process.send?.({ type: 'error', id: message.id, error: String(error) });
  });
});

async function handle(message: { type: string; id: number; key?: ToolVerdictKey; durationMs?: number }): Promise<void> {
  if (message.type === 'block') {
    const durationMs = message.durationMs ?? 5_000;
    process.send?.({ type: 'blocking', id: message.id, durationMs });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
    process.send?.({ type: 'unblocked', id: message.id });
  } else if (message.type === 'linked') {
    await service.syncVerdicts();
    const entry = {
      'event.name': message.key!.phase === 'PostToolUse' ? 'tool.result' : 'tool.call',
      'gen_ai.agent.type': 'qoder',
      'gen_ai.session.id': message.key!.sessionId,
      'gen_ai.tool.call.id': message.key!.toolUseId,
    } as AgentActivityEntry;
    await new InterceptResultLinker(store, true).enrich([entry]);
    process.send?.({ type: 'linked', id: message.id, entry });
  } else if (message.type === 'reload') {
    await service.reloadManaged();
    process.send?.({ type: 'reloaded', id: message.id, port: service.port, managedActive: service.managedActive });
  } else if (message.type === 'drain') {
    await service.syncVerdicts();
    await service.flushEvents();
    await Promise.all(writes);
    if (outputError) throw outputError;
    process.send?.({ type: 'drained', id: message.id });
  } else if (message.type === 'stop') {
    await service.stop();
    await Promise.all(writes);
    await output.shutdown();
    if (outputError) throw outputError;
    process.send?.({ type: 'stopped', id: message.id });
    process.disconnect();
  }
}
