import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, doubaoRootAgentSpanId, type DoubaoPendingTurn, type DoubaoLogEvent, type DoubaoToolPair } from './doubao-work-log.js';

interface Edge { child: string; parent: string; callId: string; threadId: string }
export interface NativeGraph { main: string; edges: Record<string, Edge> }
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_AGENTS = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_PROFILES = 16;

/** Account switches use Chromium Profile N folders on Windows. Resolve only
 * the exact fresh conversation; never select an account by mtime or read its
 * login store. Duplicate conversations remain ambiguous and are not linked. */
export async function readNativeProfileGraph(userDataRoot: string, conversationId: string): Promise<NativeGraph | undefined> {
  if (!ID.test(conversationId)) return undefined;
  const canonical = await fs.realpath(userDataRoot);
  const profiles = (await fs.readdir(userDataRoot, { withFileTypes: true }))
    .filter(item => item.name === 'Default' || /^Profile \d+$/.test(item.name));
  if (profiles.length > MAX_PROFILES) return undefined;
  const matches: string[] = [];
  for (const profile of profiles) {
    if (!profile.isDirectory() || profile.isSymbolicLink()) return undefined;
    const sessions = path.join(userDataRoot, profile.name, '.doubaowork', 'agent_mode', 'workspace', '.sessions');
    const conversation = path.join(sessions, conversationId);
    try {
      const stat = await fs.lstat(conversation);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || !(await fs.realpath(conversation)).startsWith(`${canonical}${path.sep}`)) return undefined;
      matches.push(sessions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return matches.length === 1 ? readNativeGraph(matches[0], conversationId) : undefined;
}

/** Only native create_agent call/result identities are retained. Neither agent
 * prose nor filesystem/assignment timestamps are execution boundaries. */
export function parseNativeGraph(files: Record<string, string>): NativeGraph | undefined {
  const mains = Object.keys(files).filter(id => /^m_[a-zA-Z0-9]+$/.test(id));
  if (mains.length !== 1) return undefined;
  const edges: Record<string, Edge> = {};
  for (const [agent, content] of Object.entries(files)) {
    if (!ID.test(agent)) return undefined;
    const calls = new Set<string>();
    for (const line of content.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { return undefined; }
      if (!row || typeof row !== 'object') return undefined;
      if (Array.isArray(row.tool_calls)) for (const call of row.tool_calls) {
        if (call?.function?.name === 'create_agent' && typeof call.id === 'string' && ID.test(call.id)) calls.add(call.id);
      }
      if (row.role !== 'tool' || !calls.has(row.tool_call_id) || typeof row.content !== 'string'
        || !row.content.startsWith('create_agent ok\n')) continue;
      const field = (name: string) => new RegExp(`^${name}: ([a-zA-Z0-9_-]+)$`, 'm').exec(row.content)?.[1];
      const child = field('agent_id'), parent = field('parent_id'), threadId = field('thread_id');
      if (!child || !ID.test(child) || child === agent || !threadId || !/^\d{1,30}$/.test(threadId)
        || parent !== (agent === mains[0] ? 'main_agent' : agent)) return undefined;
      const edge = { child, parent: agent, callId: row.tool_call_id, threadId };
      if (edges[child] && JSON.stringify(edges[child]) !== JSON.stringify(edge)) return undefined;
      edges[child] = edge;
    }
  }
  return { main: mains[0], edges };
}

/** Read only the conversation already identified in fresh frontend records.
 * No SQLite locks, login stores, history scans, app patches or source writes. */
export async function readNativeGraph(sessionsRoot: string, conversationId: string): Promise<NativeGraph | undefined> {
  if (!ID.test(conversationId)) return undefined;
  const root = path.join(sessionsRoot, conversationId, 'agents');
  const canonical = await fs.realpath(root);
  const allowed = await fs.realpath(sessionsRoot);
  if (!canonical.startsWith(`${allowed}${path.sep}`)) return undefined;
  const names = (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && ID.test(item.name));
  if (names.length > MAX_AGENTS) return undefined;
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const entry of names) {
    const file = path.join(root, entry.name, 'system', 'trajectory.jsonl');
    let stat;
    try { stat = await fs.lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined;
    if (!(await fs.realpath(file)).startsWith(`${canonical}${path.sep}`)) return undefined;
    bytes += stat.size;
    if (bytes > MAX_SCAN_BYTES) return undefined;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length || (await handle.stat()).size !== stat.size) return undefined;
      const content = buffer.toString('utf8');
      if (content && !content.endsWith('\n')) return undefined;
      files[entry.name] = content;
    } finally { await handle.close(); }
  }
  return parseNativeGraph(files);
}

/** One immutable fragment per settled native tool. It describes only the
 * observed tool interval, never an inferred whole cloud Agent invocation.
 * Ancestors cover that same observed descendant interval and carry explicit
 * native creation edges; no fictional create_agent TOOL span is inserted. */
export function buildNativeToolFragment(
  scope: string, root: DoubaoPendingTurn & { terminal: DoubaoLogEvent }, graph: NativeGraph,
  pair: DoubaoToolPair, observedMs: number,
): AgentActivityEntry[] {
  const actor = pair.start.turnId;
  const call = pair.start.tool;
  if (!actor || !call || !pair.end.tool || actor === graph.main || !graph.edges[actor]) return [];
  const chain: Edge[] = [];
  const seen = new Set<string>();
  let current = actor;
  while (current !== graph.main) {
    const edge = graph.edges[current];
    if (!edge || seen.has(current) || chain.length >= 8) return [];
    chain.push(edge); seen.add(current); current = edge.parent;
  }
  const rootEvents = buildDoubaoTaskEvents(scope, root, root.terminal, observedMs);
  if (!rootEvents.length || BigInt(pair.start.timeNano) < BigInt(root.queryMs) * 1_000_000n) return [];
  const traceId = rootEvents[0].trace_id!;
  const fragment = doubaoDigest(JSON.stringify([scope, traceId, call.sandboxId, actor, call.id]));
  const fragmentPending = { ...root, firstOutput: undefined, selectedSkills: undefined, selectedPartners: undefined,
    turnId: actor, queryMs: Number(BigInt(pair.start.timeNano) / 1_000_000n) };
  const terminal = { ...root.terminal, queryMs: fragmentPending.queryMs, timeNano: pair.end.timeNano, clientOutcome: 'ended' as const };
  // The shared builder's millisecond guard cannot represent a sub-ms fragment;
  // validate the native pair here and preserve its full precision below.
  if (call.id !== pair.end.tool.id || call.name !== pair.end.tool.name || call.sandboxId !== pair.end.tool.sandboxId
    || call.phase !== 'received' || pair.end.tool.phase !== 'settled'
    || !pair.end.tool.status || BigInt(pair.end.timeNano) <= BigInt(pair.start.timeNano)) return [];
  const events = buildDoubaoTaskEvents(scope, fragmentPending, terminal, observedMs, [pair]);
  if (events.length !== 4) return [];
  const nativeIds = chain.map(edge => edge.child);
  const agentSpanId = doubaoDigest(`${fragment}:agent:${actor}`).slice(0, 16);
  return events.map((event, index) => ({
    ...event,
    time_unix_nano: index === 0 ? pair.start.timeNano : event.time_unix_nano,
    trace_id: traceId,
    'event.id': doubaoDigest(`${fragment}:event:${index}`),
    'gen_ai.turn.id': `native-tool-fragment:${fragment}`,
    'gen_ai.agent.id': actor,
    'gen_ai.agent.name': actor,
    'gen_ai.agent.scope': 'subagent',
    parent_span_id: chain.length > 1
      ? doubaoDigest(`${fragment}:agent:${chain[1].child}`).slice(0, 16) : doubaoRootAgentSpanId(traceId),
    ...(event['event.name'] === 'tool.call' || event['event.name'] === 'tool.result'
      ? { span_id: doubaoDigest(`${fragment}:tool`).slice(0, 16) } : {}),
    'loongsuite.doubao_work.observation_scope': 'native_local_tool_fragment',
    'loongsuite.doubao_work.agent_boundary': 'native_local_tool_interval',
    'loongsuite.doubao_work.agent_span_id': agentSpanId,
    'loongsuite.doubao_work.fragment_id': fragment,
    'loongsuite.doubao_work.root_turn_id': root.turnId,
    'loongsuite.doubao_work.root_agent_id': graph.main,
    'loongsuite.doubao_work.native_agent_ids': nativeIds,
    'loongsuite.doubao_work.native_parent_ids': chain.map(edge => edge.parent),
    'loongsuite.doubao_work.native_creation_call_ids': chain.map(edge => edge.callId),
    'loongsuite.doubao_work.native_thread_ids': chain.map(edge => edge.threadId),
    'gen_ai.agent.parent.id': chain[0].parent,
    'agent.pilot.parent.turn.id': root.turnId,
    'loongsuite.doubao_work.relation_basis': 'native_create_agent_ancestry',
    resourceAttributes: {
      ...event.resourceAttributes,
      'loongsuite.doubao_work.observation_scope': 'native_local_tool_fragment',
    },
  }));
}
