import { parentPort, workerData } from 'node:worker_threads';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger, initFileLogging } from '../utils/logger.js';
import { startInterceptorService, type InterceptorService } from './daemon/lifecycle.js';
import { setManagedChildObserver } from './managed/child-lifecycle.js';
import { interceptorLogPath, interceptorToolVerdictPath } from './paths.js';
import { TOOL_VERDICT_MAX_RECORDS, ToolVerdictStore, type ToolVerdictRecord } from './tool-verdict-store.js';
import type { InterceptorWorkerCommand, InterceptorWorkerData, InterceptorWorkerMessage } from './worker-protocol.js';

const port = parentPort!;
const data = workerData as InterceptorWorkerData;
const logger = createLogger('InterceptorWorker');
const pending = new Map<string, { record: ToolVerdictRecord; seq: number }>();
const prompts: Array<{ entry: AgentActivityEntry; seq: number }> = [];
const evaluations: Array<{ entry: AgentActivityEntry; seq: number }> = [];
let droppedEvaluations = 0;
const barriers = new Map<number, number>();
let seq = 0;
let ackedSeq = 0;
let batchId = 0;
let inflight: { id: number; seq: number } | null = null;
let scheduled = false;
let stopping = false;
let service: InterceptorService;

function send(message: InterceptorWorkerMessage): void {
  port.postMessage(message);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; pump(); });
}

/** One unacknowledged batch at a time; a blocked collector cannot grow the MessagePort queue. */
function pump(): void {
  for (const [id, target] of barriers) {
    if (ackedSeq >= target || (!inflight && pending.size === 0 && !evaluations.length && !prompts.length)) {
      barriers.delete(id);
      send({ type: 'reply', id });
    }
  }
  if (inflight || stopping || (!pending.size && !prompts.length && !evaluations.length)) return;
  const records: ToolVerdictRecord[] = [];
  const evaluationEntries: AgentActivityEntry[] = [];
  const blockedPrompts: AgentActivityEntry[] = [];
  let lastSeq = ackedSeq;
  // Merge the bounded queues in sequence order so a barrier never skips an earlier event.
  while (records.length + evaluationEntries.length + blockedPrompts.length < 128) {
    const first = pending.entries().next().value;
    const nextRecord = first?.[1].seq ?? Infinity;
    const nextEvaluation = evaluations[0]?.seq ?? Infinity;
    const nextPrompt = prompts[0]?.seq ?? Infinity;
    const next = Math.min(nextRecord, nextEvaluation, nextPrompt);
    if (next === Infinity) break;
    if (next === nextRecord) {
      pending.delete(first![0]);
      records.push(first![1].record);
    } else if (next === nextEvaluation) {
      if (evaluationEntries.length === 32) break;
      evaluationEntries.push(evaluations.shift()!.entry);
    } else {
      if (blockedPrompts.length === 1) break;
      blockedPrompts.push(prompts.shift()!.entry);
    }
    lastSeq = next;
  }
  inflight = { id: ++batchId, seq: lastSeq };
  reportDrops();
  send({ type: 'events', id: batchId, records, blockedPrompts, evaluationEntries });
}

function reportDrops(): void {
  if (!droppedEvaluations) return;
  logger.warn('guardrail evaluation forwarding queue full', { dropped: droppedEvaluations });
  droppedEvaluations = 0;
}

function enqueue(record: ToolVerdictRecord): void {
  const key = JSON.stringify([record.sessionId, record.toolUseId, record.phase]);
  pending.delete(key);
  pending.set(key, { record, seq: ++seq });
  if (pending.size > TOOL_VERDICT_MAX_RECORDS) pending.delete(pending.keys().next().value!);
  schedule();
}

async function main(): Promise<void> {
  setManagedChildObserver(state => send({ type: 'child', state }));
  // Use a direct file stream. Worker stdout is forwarded through the blocked parent.
  process.env.LOONGSUITE_PILOT_STDOUT = '0';
  await initFileLogging(interceptorLogPath(data.dataDir));
  const store = new ToolVerdictStore(interceptorToolVerdictPath(data.dataDir));
  store.restore();
  store.merge(data.records);
  service = await startInterceptorService({
    ...data, verdictStore: store,
    onToolVerdict: enqueue,
    onStateChange: (listenPort, managedActive) => send({ type: 'state', port: listenPort, managedActive }),
    onManagedActiveChange: () => {
      // The listener state follows after reconcile; initial readiness carries the full state.
      if (service) send({ type: 'state', port: service.port, managedActive: service.managedActive });
    },
    emitBlockedPrompt: entry => {
      if (prompts.length < 8) prompts.push({ entry, seq: ++seq });
      else logger.warn('blocked prompt forwarding queue full; forwarding skipped');
      schedule();
    },
    emitEvaluation: entry => {
      if (evaluations.length < 256) evaluations.push({ entry, seq: ++seq });
      else droppedEvaluations++;
      schedule();
    },
  });
  let commands = Promise.resolve();
  port.on('message', (command: InterceptorWorkerCommand) => {
    if (command.type === 'ack') {
      if (inflight?.id === command.id) {
        ackedSeq = inflight.seq;
        inflight = null;
        pump();
      }
      return;
    }
    if (command.type === 'sync') {
      barriers.set(command.id, seq);
      pump();
      return;
    }
    commands = commands.then(async () => {
      try {
        if (command.type === 'reload') {
          await service.reloadManaged();
          send({ type: 'state', port: service.port, managedActive: service.managedActive });
        } else {
          stopping = true;
          await service.stop();
          // Drain the last verdicts accepted between the parent's barrier and HTTP close.
          reportDrops();
          send({ type: 'final', records: store.records(), blockedPrompts: prompts.splice(0).map(item => item.entry),
            evaluationEntries: evaluations.splice(0).map(item => item.entry) });
        }
        send({ type: 'reply', id: command.id });
        if (stopping) port.close();
      } catch (error) {
        send({ type: 'reply', id: command.id, error: String(error) });
      }
    });
  });
  send({ type: 'ready', port: service.port, managedActive: service.managedActive, records: store.records() });
}

void main().catch(error => {
  send({ type: 'fatal', error: String(error) });
  port.close();
  process.exitCode = 1;
});
