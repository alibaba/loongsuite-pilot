import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, type DoubaoPendingTurn, type DoubaoLogEvent, type DoubaoToolPair } from './doubao-work-log.js';
import { parseNativeContent, type NativeContent } from './doubao-work-content.js';

interface Edge { child: string; parent: string; callId: string; threadId: string }
export interface NativeGraph { main: string; edges: Record<string, Edge>; content?: NativeContent }
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_AGENTS = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_PROFILES = 16;

/** Account switches use Chromium Profile N folders on Windows. Resolve only
 * the exact fresh conversation; never select an account by mtime or read its
 * login store. Duplicate conversations remain ambiguous and are not linked. */
export async function readNativeProfileGraph(userDataRoot: string, conversationId: string, captureContent = false): Promise<NativeGraph | undefined> {
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
  return matches.length === 1 ? readNativeGraph(matches[0], conversationId, captureContent) : undefined;
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
export async function readNativeGraph(sessionsRoot: string, conversationId: string, captureContent = false): Promise<NativeGraph | undefined> {
  if (!ID.test(conversationId)) return undefined;
  const root = path.join(sessionsRoot, conversationId, 'agents');
  const canonical = await fs.realpath(root);
  const allowed = await fs.realpath(sessionsRoot);
  if (!canonical.startsWith(`${allowed}${path.sep}`)) return undefined;
  const names = (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && ID.test(item.name));
  if (names.length > MAX_AGENTS) return undefined;
  const files: Record<string, string> = {};
  const assignments: Record<string, string> = {};
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
    if (captureContent) {
      const assignment = path.join(root, entry.name, 'system', 'assignment.md');
      try {
        const assignmentStat = await fs.lstat(assignment);
        if (!assignmentStat.isFile() || assignmentStat.isSymbolicLink() || assignmentStat.size > MAX_FILE_BYTES
          || !(await fs.realpath(assignment)).startsWith(`${canonical}${path.sep}`)) return undefined;
        bytes += assignmentStat.size;
        if (bytes > MAX_SCAN_BYTES) return undefined;
        const input = await fs.open(assignment, 'r');
        try {
          const buffer = Buffer.alloc(assignmentStat.size);
          const { bytesRead } = await input.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== buffer.length || (await input.stat()).size !== assignmentStat.size) return undefined;
          assignments[entry.name] = buffer.toString('utf8');
        } finally { await input.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const graph = parseNativeGraph(files);
  if (!graph || !captureContent) return graph;
  const content = parseNativeContent(files, assignments);
  return content ? { ...graph, content } : undefined;
}

/** Timed local tool facts are logs, not synthetic Agent invocations. */
export function buildNativeToolEvents(
  scope: string, root: DoubaoPendingTurn & { terminal: DoubaoLogEvent }, graph: NativeGraph,
  pair: DoubaoToolPair, observedMs: number,
): AgentActivityEntry[] {
  const actor = pair.start.turnId, call = pair.start.tool, end = pair.end.tool;
  if (!actor || !call || !end || !graph.edges[actor]
    || call.id !== end.id || call.name !== end.name || call.sandboxId !== end.sandboxId
    || call.phase !== 'received' || end.phase !== 'settled' || !end.status
    || BigInt(pair.start.timeNano) < BigInt(root.queryMs) * 1_000_000n
    || BigInt(pair.end.timeNano) <= BigInt(pair.start.timeNano)) return [];
  const seen = new Set<string>();
  let current = actor;
  while (current !== graph.main) {
    if (seen.has(current) || seen.size >= 8 || !graph.edges[current]) return [];
    seen.add(current); current = graph.edges[current].parent;
  }
  const common = buildDoubaoTaskEvents(scope, root, root.terminal, observedMs)[0];
  if (!common) return [];
  const { 'gen_ai.turn.start': _start, 'gen_ai.input.messages_delta': _input, 'gen_ai.turn.id': _turn, ...base } = common;
  const identity = doubaoDigest(JSON.stringify([scope, common.trace_id, call.sandboxId, actor, call.id]));
  const metadata = {
    ...base, 'gen_ai.agent.id': actor, 'gen_ai.agent.name': actor,
    'gen_ai.tool.name': call.name, 'gen_ai.tool.call.id': call.id, 'gen_ai.tool.type': 'function',
    'loongsuite.doubao_work.observation_scope': 'native_local_tool',
    'loongsuite.doubao_work.trace_role': 'log_only',
    'loongsuite.doubao_work.root_turn_id': root.turnId,
    'loongsuite.doubao_work.tool_boundary': 'client_received_to_execution_settled',
    'loongsuite.doubao_work.native_creator_agent_id': graph.edges[actor].parent,
    'loongsuite.doubao_work.native_thread_id': graph.edges[actor].threadId,
  };
  return [
    { ...metadata, 'event.name': 'tool.call', 'event.id': doubaoDigest(`${identity}:call`), time_unix_nano: pair.start.timeNano },
    { ...metadata, 'event.name': 'tool.result', 'event.id': doubaoDigest(`${identity}:result`), time_unix_nano: pair.end.timeNano,
      'tool.result.status': end.status,
      'gen_ai.tool.call.duration': Number(BigInt(pair.end.timeNano) - BigInt(pair.start.timeNano)) / 1_000_000,
      ...(end.status === 'success' ? {} : { 'error.type': end.status === 'cancelled' ? 'doubao.local_tool_cancelled' : 'doubao.local_tool_failed' }) },
  ];
}
