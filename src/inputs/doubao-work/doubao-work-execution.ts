import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, doubaoRootAgentSpanId, type DoubaoLogEvent, type DoubaoPendingTurn } from './doubao-work-log.js';
import type { NativeGraph } from './doubao-work-native.js';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_MS = Date.UTC(2020, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_EXECUTIONS = 128;

export interface NativeExecution {
  executionKey: string;
  conversationId: string;
  queryMessageId: string;
  agentId: string;
  agentType: 'sub_agent' | 'organizer' | 'main_agent';
  sandboxId: string;
  startedAtMs: number;
  endedAtMs: number;
}

/** Er.start/end in the native entry-moa producer records these Date.now fields.
 * They describe the local sandbox lifecycle, including release-time capture,
 * not the entire cloud inference or a tool interval. Ignore all file contents. */
export function parseNativeExecution(value: unknown): NativeExecution | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const e = (value as Record<string, unknown>).execution;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return undefined;
  const row = e as Record<string, unknown>;
  const string = (name: string, pattern = ID) => typeof row[name] === 'string' && pattern.test(row[name]) ? row[name] as string : undefined;
  const executionKey = string('executionKey', UUID), conversationId = string('conversationId', /^\d{1,30}$/);
  const queryMessageId = string('queryMessageId', UUID), agentId = string('agentId'), sandboxId = string('sandboxId');
  const agentType = row.agentType;
  const startedAtMs = row.startedAtMs, endedAtMs = row.endedAtMs;
  if (!executionKey || !conversationId || !queryMessageId || !agentId || !sandboxId
    || (agentType !== 'sub_agent' && agentType !== 'organizer' && agentType !== 'main_agent')
    || typeof startedAtMs !== 'number' || typeof endedAtMs !== 'number'
    || !Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(endedAtMs)
    || startedAtMs < MIN_MS || endedAtMs >= MAX_MS || endedAtMs <= startedAtMs) return undefined;
  return { executionKey, conversationId, queryMessageId, agentId, agentType, sandboxId, startedAtMs, endedAtMs };
}

/** The client persists only executions with tracked file mutations. Scan only
 * a conversation identified in new frontend events; never enumerate history.
 * A partial/transient scan throws so callers preserve their checkpoint. */
export async function readNativeExecutions(snapshotRoot: string, conversationId: string): Promise<NativeExecution[]> {
  if (!/^\d{1,30}$/.test(conversationId)) return [];
  const canonical = await fs.realpath(snapshotRoot);
  const directories = async (folder: string, limit: number) => {
    const stat = await fs.lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !(await fs.realpath(folder)).startsWith(`${canonical}${path.sep}`)) throw new Error('Unsafe native execution directory');
    const items = (await fs.readdir(folder, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink());
    if (items.length > limit) throw new Error('Native execution directory limit exceeded');
    return items;
  };
  const accounts = (await fs.readdir(snapshotRoot, { withFileTypes: true })).filter(item => item.isDirectory() && /^\d{1,30}$/.test(item.name));
  if (accounts.length > 8) throw new Error('Native execution account limit exceeded');
  const result = new Map<string, NativeExecution>();
  let bytes = 0, files = 0, executions = 0;
  for (const account of accounts) {
    const folder = path.join(snapshotRoot, account.name, conversationId);
    let names;
    try { names = await directories(folder, MAX_EXECUTIONS); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of names) {
      if (!UUID.test(entry.name)) continue;
      if (++executions > MAX_EXECUTIONS) throw new Error('Native execution count limit exceeded');
      const executionDir = path.join(folder, entry.name);
      await directories(executionDir, 0); // Validate containment without following directory links.
      const records = await fs.readdir(executionDir, { withFileTypes: true });
      if (records.length > 64) throw new Error('Native execution record limit exceeded');
      for (const record of records) {
        if (!record.isFile() || record.isSymbolicLink() || !record.name.endsWith('.json') || !ID.test(record.name.slice(0, -5))) continue;
        if (++files > MAX_EXECUTIONS) throw new Error('Native execution file limit exceeded');
        const file = path.join(executionDir, record.name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || (bytes += stat.size) > MAX_SCAN_BYTES
          || !(await fs.realpath(file)).startsWith(`${canonical}${path.sep}`)) throw new Error('Native execution read limit exceeded');
        const handle = await fs.open(file, 'r');
        let value;
        try {
          const buffer = Buffer.alloc(stat.size), read = await handle.read(buffer, 0, buffer.length, 0);
          const after = await handle.stat();
          if (read.bytesRead !== buffer.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Native execution changed during read');
          value = JSON.parse(buffer.toString('utf8'));
        } finally { await handle.close(); }
        const e = parseNativeExecution(value);
        if (!e) continue;
        if (e.conversationId !== conversationId || e.executionKey !== entry.name || `${e.agentId}.json` !== record.name) throw new Error('Native execution path identity mismatch');
        const prior = result.get(e.executionKey);
        if (prior && JSON.stringify(prior) !== JSON.stringify(e)) throw new Error('Conflicting native execution identity');
        result.set(e.executionKey, e);
      }
    }
  }
  return [...result.values()];
}

export function nativeExecutionSpanId(scope: string, executionKey: string): string {
  return doubaoDigest(JSON.stringify(['doubao-native-execution', scope, executionKey])).slice(0, 16);
}

/** One independent AGENT per genuine native execution key. Missing intermediate
 * executions are collapsed to the observed root request, never synthesized.
 * Native parent identity is retained separately from the selected trace parent. */
export function buildNativeExecutionEvents(
  scope: string, root: DoubaoPendingTurn & { terminal: DoubaoLogEvent }, graph: NativeGraph,
  execution: NativeExecution, siblings: NativeExecution[], observedMs: number,
): AgentActivityEntry[] {
  const e = parseNativeExecution({ execution });
  if (!e || e.conversationId !== root.conversationId || !root.localMessageId || e.queryMessageId !== root.localMessageId
    || e.startedAtMs < root.queryMs || !graph.edges[e.agentId]) return [];
  const chain: string[] = [];
  let current = e.agentId;
  while (current !== graph.main) {
    if (chain.includes(current) || chain.length >= 8 || !graph.edges[current]) return [];
    chain.push(current); current = graph.edges[current].parent;
  }
  const rootEvents = buildDoubaoTaskEvents(scope, root, root.terminal, observedMs);
  if (!rootEvents.length) return [];
  const traceId = rootEvents[0].trace_id!;
  const edge = graph.edges[e.agentId];
  const parents = siblings.filter(p => parseNativeExecution({ execution: p }) && p.startedAtMs >= root.queryMs
    && p.agentId === edge.parent && p.executionKey !== e.executionKey
    && p.conversationId === e.conversationId && p.queryMessageId === e.queryMessageId && p.sandboxId === e.sandboxId);
  // Same-query ancestry plus one enclosing native execution is required. An
  // overlapping or ambiguous reconnect is not enough to assign a parent run.
  const parent = parents.length === 1 && parents[0].startedAtMs <= e.startedAtMs && parents[0].endedAtMs >= e.endedAtMs
    ? parents[0] : undefined;
  const identity = doubaoDigest(JSON.stringify([scope, traceId, e.executionKey]));
  const pending = { ...root, turnId: e.agentId, queryMs: e.startedAtMs, selectedSkills: undefined, selectedPartners: undefined };
  const terminal = { ...root.terminal, queryMs: e.startedAtMs, timeNano: (BigInt(e.endedAtMs) * 1_000_000n).toString(), clientOutcome: 'ended' as const };
  return buildDoubaoTaskEvents(scope, pending, terminal, observedMs).map((event, index) => ({
    ...event, trace_id: traceId, 'event.id': doubaoDigest(`${identity}:event:${index}`),
    'gen_ai.turn.id': `native-sandbox-execution:${e.executionKey}`,
    'gen_ai.agent.id': e.agentId, 'gen_ai.agent.name': e.agentId, 'gen_ai.agent.scope': 'subagent',
    'gen_ai.agent.parent.id': edge.parent, 'agent.pilot.parent.turn.id': root.turnId,
    parent_span_id: parent ? nativeExecutionSpanId(scope, parent.executionKey) : doubaoRootAgentSpanId(traceId),
    'loongsuite.doubao_work.agent_span_id': nativeExecutionSpanId(scope, e.executionKey),
    'loongsuite.doubao_work.observation_scope': 'native_sandbox_execution',
    'loongsuite.doubao_work.agent_boundary': 'native_sandbox_get_or_create_to_release',
    'loongsuite.doubao_work.timing_basis': 'native_execution_startedAtMs_endedAtMs',
    'loongsuite.doubao_work.relation_basis': 'native_create_agent_ancestry',
    'loongsuite.doubao_work.parent_resolution': parent ? 'same_query_native_execution' : 'root_request_ancestor',
    ...(parent ? { 'loongsuite.doubao_work.native_parent_execution_id': parent.executionKey } : {}),
    'loongsuite.doubao_work.native_execution_id': e.executionKey,
    'loongsuite.doubao_work.native_query_message_id': e.queryMessageId,
    'loongsuite.doubao_work.native_sandbox_id': e.sandboxId,
    'loongsuite.doubao_work.native_creation_call_id': edge.callId,
    'loongsuite.doubao_work.native_thread_id': edge.threadId,
    'loongsuite.doubao_work.native_ancestor_ids': [...chain.slice(1), graph.main],
    'loongsuite.doubao_work.root_turn_id': root.turnId,
    'loongsuite.doubao_work.root_agent_id': graph.main,
    resourceAttributes: { ...event.resourceAttributes, 'loongsuite.doubao_work.observation_scope': 'native_sandbox_execution' },
  }));
}
