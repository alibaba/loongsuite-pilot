import type {
  CodexExtractedTranscriptTurn,
  CodexTranscriptMeta,
  CodexTranscriptSourceRecord,
  CodexTranscriptTool,
} from './codex-transcript-types.js';
import { stringValue } from './codex-transcript-utils.js';

export type CodexSubagentLinkConfidence =
  | 'explicit_id'
  | 'agent_path'
  | 'time_order'
  | 'orphan';

export interface CodexSpawnDescriptor {
  parentThreadId: string;
  parentTurnId: string;
  parentTraceId: string;
  parentToolCallId: string;
  spawnedAtMs: number;
  taskName?: string;
  agentPath?: string;
  childThreadId?: string;
}

export interface CodexChildThreadDescriptor {
  childThreadId: string;
  parentThreadId: string;
  rootSessionId: string;
  depth: number;
  createdAtMs: number;
  agentPath?: string;
  agentNickname?: string;
}

export interface CodexSubagentLink {
  parentThreadId: string;
  parentTurnId?: string;
  parentTraceId?: string;
  parentToolCallId?: string;
  childThreadId: string;
  agentPath?: string;
  confidence: CodexSubagentLinkConfidence;
  orphanReason?: 'parent_not_found' | 'ambiguous_explicit_id' | 'ambiguous_agent_path' | 'no_candidate';
}

export interface CodexSubagentLinkSnapshot {
  detectedChildren: number;
  detectedSpawns: number;
  linkedChildren: number;
  orphanChildren: number;
  links: CodexSubagentLink[];
}

interface CandidateSelection {
  spawn?: CodexSpawnDescriptor;
  confidence?: Exclude<CodexSubagentLinkConfidence, 'orphan'>;
  orphanReason?: CodexSubagentLink['orphanReason'];
}

export const MAX_LINK_DESCRIPTORS = 10_000;

/**
 * In-memory linker for depth-one Codex subagents.
 *
 * The linker recalculates assignments as parent and child facts arrive. Only
 * explicit child ids and unambiguous agent paths are eligible for trace
 * fusion; time-order links remain available for diagnostics only. Spawn
 * identity is keyed by parentToolCallId, so repeated agent paths remain
 * distinct child lifecycles.
 */
export class CodexSubagentLinker {
  private readonly spawns = new Map<string, CodexSpawnDescriptor>();
  private readonly children = new Map<string, CodexChildThreadDescriptor>();

  registerSpawns(descriptors: CodexSpawnDescriptor[]): void {
    for (const descriptor of descriptors) {
      const key = spawnKey(descriptor);
      const previous = this.spawns.get(key);
      this.spawns.set(key, previous ? mergeSpawn(previous, descriptor) : descriptor);
      trimOldest(this.spawns, MAX_LINK_DESCRIPTORS);
    }
  }

  registerChild(meta: CodexTranscriptMeta): void {
    if (meta.threadSource !== 'subagent' || meta.depth !== 1 || !meta.parentThreadId) return;
    this.children.set(meta.threadId, {
      childThreadId: meta.threadId,
      parentThreadId: meta.parentThreadId,
      rootSessionId: meta.rootSessionId,
      depth: meta.depth,
      createdAtMs: meta.createdAtMs ?? 0,
      ...(meta.agentPath ? { agentPath: meta.agentPath } : {}),
      ...(meta.agentNickname ? { agentNickname: meta.agentNickname } : {}),
    });
    trimOldest(this.children, MAX_LINK_DESCRIPTORS);
  }

  hasThread(threadId: string): boolean {
    return this.children.has(threadId);
  }

  snapshot(): CodexSubagentLinkSnapshot {
    const spawns = [...this.spawns.values()];
    const children = [...this.children.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.childThreadId.localeCompare(right.childThreadId));
    const usedSpawnKeys = new Set<string>();
    const linksByChild = new Map<string, CodexSubagentLink>();

    // Apply priorities globally. Otherwise an earlier child that only has a
    // time-order fallback could consume the exact spawn of a later child.
    assignLinks(children, spawns, usedSpawnKeys, linksByChild, 'explicit_id');
    assignLinks(children, spawns, usedSpawnKeys, linksByChild, 'agent_path');
    assignLinks(children, spawns, usedSpawnKeys, linksByChild, 'time_order');

    for (const child of children) {
      if (linksByChild.has(child.childThreadId)) continue;
      const hasParentSpawn = spawns.some(spawn => spawn.parentThreadId === child.parentThreadId);
      linksByChild.set(child.childThreadId, orphanLink(
        child,
        hasParentSpawn ? 'no_candidate' : 'parent_not_found',
      ));
    }

    const links = children.map(child => linksByChild.get(child.childThreadId)!);

    const linkedChildren = links.filter(link => link.confidence !== 'orphan').length;
    return {
      detectedChildren: children.length,
      detectedSpawns: spawns.length,
      linkedChildren,
      orphanChildren: links.length - linkedChildren,
      links,
    };
  }
}

function assignLinks(
  children: CodexChildThreadDescriptor[],
  spawns: CodexSpawnDescriptor[],
  usedSpawnKeys: Set<string>,
  linksByChild: Map<string, CodexSubagentLink>,
  phase: Exclude<CodexSubagentLinkConfidence, 'orphan'>,
): void {
  for (const child of children) {
    if (linksByChild.has(child.childThreadId)) continue;
    const candidates = spawns.filter(spawn =>
      spawn.parentThreadId === child.parentThreadId && !usedSpawnKeys.has(spawnKey(spawn)));
    const selection = selectCandidateForPhase(child, candidates, phase);
    if (selection.orphanReason) {
      linksByChild.set(child.childThreadId, orphanLink(child, selection.orphanReason));
      continue;
    }
    if (!selection.spawn || !selection.confidence) continue;
    usedSpawnKeys.add(spawnKey(selection.spawn));
    linksByChild.set(child.childThreadId, linkedChild(child, selection.spawn, selection.confidence));
  }
}

export function extractCodexSpawnDescriptors(
  turn: CodexExtractedTranscriptTurn,
  sourceRecords: CodexTranscriptSourceRecord[],
  parentTraceId: string,
): CodexSpawnDescriptor[] {
  const activities = new Map<string, {
    childThreadId?: string;
    agentPath?: string;
    occurredAtMs?: number;
  }>();

  for (const source of sourceRecords) {
    if (source.record.type !== 'event_msg') continue;
    const payload = asRecord(source.record.payload);
    if (!payload || payload.type !== 'sub_agent_activity' || payload.kind !== 'started') continue;
    const callId = stringValue(payload.event_id);
    if (!callId) continue;
    const occurredAtMs = finiteNumber(payload.occurred_at_ms);
    activities.set(callId, {
      ...(stringValue(payload.agent_thread_id) ? { childThreadId: stringValue(payload.agent_thread_id)! } : {}),
      ...(stringValue(payload.agent_path) ? { agentPath: stringValue(payload.agent_path)! } : {}),
      ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
    });
  }

  const descriptors: CodexSpawnDescriptor[] = [];
  for (const step of turn.steps) {
    for (const tool of step.tools) {
      if (tool.name !== 'spawn_agent') continue;
      const activity = activities.get(tool.callId);
      const output = asRecord(tool.output);
      // A rejected spawn still has a function_call and an input task_name, but
      // it creates no child lifecycle. Only a started activity or a structured
      // successful result is eligible for linking/fusion.
      const resultAgentPath = stringValue(output?.agent_path) ?? stringValue(output?.task_name);
      if (!activity && !resultAgentPath) continue;
      const taskName = spawnTaskName(tool);
      descriptors.push({
        parentThreadId: turn.sessionId,
        parentTurnId: turn.transcriptTurnId,
        parentTraceId,
        parentToolCallId: tool.callId,
        spawnedAtMs: activity?.occurredAtMs ?? tool.startedAtMs,
        ...(taskName ? { taskName } : {}),
        ...(activity?.agentPath ? { agentPath: activity.agentPath } : {}),
        ...(activity?.childThreadId ? { childThreadId: activity.childThreadId } : {}),
      });
    }
  }
  return descriptors;
}

function selectCandidateForPhase(
  child: CodexChildThreadDescriptor,
  candidates: CodexSpawnDescriptor[],
  phase: Exclude<CodexSubagentLinkConfidence, 'orphan'>,
): CandidateSelection {
  if (phase === 'explicit_id') {
    const explicit = candidates.filter(spawn => spawn.childThreadId === child.childThreadId);
    if (explicit.length === 1) return { spawn: explicit[0], confidence: 'explicit_id' };
    if (explicit.length > 1) return { orphanReason: 'ambiguous_explicit_id' };
    return {};
  }

  if (phase === 'agent_path') {
    if (!child.agentPath) return {};
    const exactPath = candidates.filter(spawn => {
      const candidatePath = spawn.agentPath ?? spawn.taskName;
      return candidatePath !== undefined && normalizeAgentPath(candidatePath) === normalizeAgentPath(child.agentPath!);
    });
    if (exactPath.length === 1) return { spawn: exactPath[0], confidence: 'agent_path' };
    if (exactPath.length > 1) return { orphanReason: 'ambiguous_agent_path' };
    return {};
  }

  const preceding = candidates
    .filter(spawn => child.createdAtMs <= 0 || spawn.spawnedAtMs <= child.createdAtMs)
    .sort((left, right) => right.spawnedAtMs - left.spawnedAtMs || spawnKey(left).localeCompare(spawnKey(right)));
  if (preceding.length === 0) return candidates.length === 0 ? {} : { orphanReason: 'no_candidate' };
  if (preceding.length > 1 && preceding[0].spawnedAtMs === preceding[1].spawnedAtMs) {
    return { orphanReason: 'no_candidate' };
  }
  return { spawn: preceding[0], confidence: 'time_order' };
}

function linkedChild(
  child: CodexChildThreadDescriptor,
  spawn: CodexSpawnDescriptor,
  confidence: Exclude<CodexSubagentLinkConfidence, 'orphan'>,
): CodexSubagentLink {
  return {
    parentThreadId: child.parentThreadId,
    parentTurnId: spawn.parentTurnId,
    parentTraceId: spawn.parentTraceId,
    parentToolCallId: spawn.parentToolCallId,
    childThreadId: child.childThreadId,
    ...(child.agentPath ? { agentPath: child.agentPath } : {}),
    confidence,
  };
}

function orphanLink(
  child: CodexChildThreadDescriptor,
  orphanReason: NonNullable<CodexSubagentLink['orphanReason']>,
): CodexSubagentLink {
  return {
    parentThreadId: child.parentThreadId,
    childThreadId: child.childThreadId,
    ...(child.agentPath ? { agentPath: child.agentPath } : {}),
    confidence: 'orphan',
    orphanReason,
  };
}

function spawnTaskName(tool: CodexTranscriptTool): string | undefined {
  const output = asRecord(tool.output);
  const input = asRecord(tool.input);
  return stringValue(output?.task_name)
    ?? stringValue(output?.agent_path)
    ?? stringValue(input?.task_name)
    ?? stringValue(input?.agent_path);
}

function mergeSpawn(previous: CodexSpawnDescriptor, next: CodexSpawnDescriptor): CodexSpawnDescriptor {
  return {
    ...previous,
    ...next,
    taskName: next.taskName ?? previous.taskName,
    agentPath: next.agentPath ?? previous.agentPath,
    childThreadId: next.childThreadId ?? previous.childThreadId,
  };
}

function spawnKey(spawn: CodexSpawnDescriptor): string {
  return `${spawn.parentThreadId}:${spawn.parentToolCallId}`;
}

function normalizeAgentPath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  return trimmed.startsWith('/') ? trimmed : `/root/${trimmed.replace(/^root\//, '')}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trimOldest<T>(values: Map<string, T>, maxSize: number): void {
  while (values.size > maxSize) {
    const oldest = values.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}
