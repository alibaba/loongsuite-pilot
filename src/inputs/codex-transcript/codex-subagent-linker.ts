import crypto from 'node:crypto';
import { codexToolSpanId } from './codex-transcript-builder.js';
import type {
  CodexExtractedTranscriptTurn,
  CodexTranscriptMeta,
  CodexTranscriptSourceRecord,
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
  /** Work binding established by Pilot; never treated as native explicit-ID evidence. */
  resolvedChildThreadId?: string;
  /** Stable logical work identity, independent of whether a tool result has arrived. */
  invocationId?: string;
  parentToolSpanId?: string;
  dispatchKind?: 'spawn' | 'followup' | 'input';
  workIndex?: number;
  /** Legacy restore input only; raw text is removed before storing descriptors. */
  workPrompt?: string;
  workFingerprint?: string;
  childTurnId?: string;
  agentNickname?: string;
  dispatchFailed?: boolean;
  associationConflict?: boolean;
  /** Derived lookup metadata; completeDescriptor never persists this projection. */
  resultFingerprints?: string[];
  resultTerminalObserved?: boolean;
  resultChildTurnIds?: string[];
  resultOutcomeKnown?: boolean;
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
  parentToolSpanId?: string;
  invocationId?: string;
  childTurnId?: string;
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

export const MAX_LINK_DESCRIPTORS = 10_000;

export interface CodexCompletedWorkResult {
  invocationId: string;
  childThreadId: string;
  childTurnId: string;
  fingerprint: string;
}

export interface CodexWorkTerminal {
  invocationId: string;
  childThreadId: string;
  childTurnId: string;
  terminalType: 'completed' | 'interrupted';
}

export interface CodexDelegationState {
  version: 1;
  spawns: CodexSpawnDescriptor[];
  children: CodexChildThreadDescriptor[];
  bindings: Array<{ childThreadId: string; childTurnId: string; invocationId: string }>;
  completedWorkResults?: CodexCompletedWorkResult[];
  workTerminals?: CodexWorkTerminal[];
}

/**
 * Recoverable creation lineage and per-work binding for Codex subagents.
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
  private readonly spawnsByParent = new Map<string, Map<string, CodexSpawnDescriptor>>();
  private readonly spawnsByChild = new Map<string, Map<string, CodexSpawnDescriptor>>();
  private readonly spawnsByParentPath = new Map<string, Map<string, CodexSpawnDescriptor>>();
  private readonly creationsByParentPath = new Map<string, Map<string, CodexSpawnDescriptor>>();
  private readonly childrenByParentPath = new Map<string, Map<string, CodexChildThreadDescriptor>>();
  private readonly bindingsByChild = new Map<string, Map<string, { childThreadId: string; childTurnId: string; invocationId: string }>>();
  private readonly completedWorkResults = new Map<string, CodexCompletedWorkResult>();
  private readonly resultsByInvocation = new Map<string, Map<string, CodexCompletedWorkResult>>();
  private readonly workTerminals = new Map<string, CodexWorkTerminal>();
  private readonly terminalsByInvocation = new Map<string, Map<string, CodexWorkTerminal>>();
  private cachedSnapshot?: CodexSubagentLinkSnapshot;
  private cachedState?: CodexDelegationState;
  private readonly bindings = new Map<string, { childThreadId: string; childTurnId: string; invocationId: string }>();

  registerSpawns(descriptors: CodexSpawnDescriptor[]): void {
    for (const value of descriptors) {
      const descriptor = completeDescriptor(value);
      const key = spawnKey(descriptor);
      const previous = this.spawns.get(key);
      this.storeSpawn(key, previous ? mergeSpawn(previous, descriptor) : descriptor);
    }
  }

  registerChild(meta: CodexTranscriptMeta): void {
    if (meta.threadSource !== 'subagent' || !meta.parentThreadId) return;
    this.storeChild({
      childThreadId: meta.threadId,
      parentThreadId: meta.parentThreadId,
      rootSessionId: meta.rootSessionId,
      depth: meta.depth,
      createdAtMs: meta.createdAtMs ?? 0,
      ...(meta.agentPath ? { agentPath: meta.agentPath } : {}),
      ...(meta.agentNickname ? { agentNickname: meta.agentNickname } : {}),
    });
  }

  hasThread(threadId: string): boolean {
    return this.children.has(threadId);
  }

  getDelegationsForParent(parentThreadId: string): CodexSpawnDescriptor[] {
    return [...(this.spawnsByParent.get(parentThreadId)?.values() ?? [])].map(spawn => {
      const results = spawn.invocationId ? this.resultsByInvocation.get(spawn.invocationId) : undefined;
      const terminals = spawn.invocationId ? this.terminalsByInvocation.get(spawn.invocationId) : undefined;
      const resultFacts = [...(results?.values() ?? [])];
      const terminalFacts = [...(terminals?.values() ?? [])];
      const completedTurns = new Set(resultFacts.map(result => workKey(result.childThreadId, result.childTurnId)));
      const terminalObserved = terminalFacts.length > 0 || resultFacts.length > 0;
      const knownChildId = spawn.childThreadId ?? spawn.resolvedChildThreadId;
      const knownChild = knownChildId ? this.children.get(knownChildId) : undefined;
      const copy = { ...spawn,
        resultTerminalObserved: terminalObserved,
        resultOutcomeKnown: terminalObserved && terminalFacts.every(terminal => terminal.terminalType === 'interrupted'
          || completedTurns.has(workKey(terminal.childThreadId, terminal.childTurnId))),
        resultChildTurnIds: [...new Set([
          ...terminalFacts.map(terminal => terminal.childTurnId),
          ...resultFacts.map(result => result.childTurnId),
        ])],
        ...(!spawn.agentPath && knownChild?.agentPath ? { agentPath: knownChild.agentPath } : {}),
        ...(!spawn.agentNickname && knownChild?.agentNickname ? { agentNickname: knownChild.agentNickname } : {}),
        ...(results?.size ? {
        resultFingerprints: [...new Set(resultFacts.map(result => result.fingerprint))],
      } : {}) };
      if (spawn.childThreadId || spawn.dispatchFailed || spawn.associationConflict) return copy;
      if (spawn.resolvedChildThreadId) return { ...copy, childThreadId: spawn.resolvedChildThreadId };
      const path = descriptorPath(spawn);
      if (path && isCreation(spawn)
        && this.creationsByParentPath.get(parentPathKey(spawn.parentThreadId, path))?.size !== 1) return copy;
      const children = path ? this.childrenByParentPath.get(parentPathKey(spawn.parentThreadId, path)) : undefined;
      const child = children?.size === 1 ? children.values().next().value : undefined;
      return { ...copy, ...(child ? {
        childThreadId: child.childThreadId,
        ...(!spawn.agentNickname && child.agentNickname ? { agentNickname: child.agentNickname } : {}),
      } : {}) };
    });
  }

  registerCompletedWorkResult(
    link: CodexSubagentLink,
    turn: CodexExtractedTranscriptTurn,
    records: CodexTranscriptSourceRecord[],
  ): void {
    if (!link.invocationId || link.confidence === 'orphan' || link.confidence === 'time_order'
      || link.childThreadId !== turn.sessionId
      || link.childTurnId !== undefined && link.childTurnId !== turn.transcriptTurnId) return;
    for (const source of records) {
      if (source.record.type !== 'event_msg') continue;
      const payload = asRecord(source.record.payload);
      if (!payload || payload.turn_id !== turn.transcriptTurnId) continue;
      const terminalType = payload.type === 'task_complete' && turn.status === 'completed' ? 'completed'
        : payload.type === 'turn_aborted' && turn.status === 'interrupted' ? 'interrupted' : undefined;
      if (!terminalType) continue;
      this.storeWorkTerminal({
        invocationId: link.invocationId,
        childThreadId: turn.sessionId,
        childTurnId: turn.transcriptTurnId,
        terminalType,
      });
      if (terminalType !== 'completed' || typeof payload.last_agent_message !== 'string') continue;
      this.storeCompletedWorkResult({
        invocationId: link.invocationId,
        childThreadId: turn.sessionId,
        childTurnId: turn.transcriptTurnId,
        // Result delivery is exact content equality; unlike work input matching,
        // whitespace normalization would conflate different runtime payloads.
        fingerprint: crypto.createHash('sha256').update(payload.last_agent_message).digest('hex'),
      });
    }
  }

  serialize(): CodexDelegationState {
    if (this.cachedState) return this.cachedState;
    return this.cachedState = {
      version: 1,
      spawns: [...this.spawns.values()].map(value => ({ ...value })),
      children: [...this.children.values()].map(value => ({ ...value })),
      bindings: [...this.bindings.values()].map(value => ({ ...value })),
      ...(this.completedWorkResults.size > 0 ? {
        completedWorkResults: [...this.completedWorkResults.values()].map(value => ({ ...value })),
      } : {}),
      ...(this.workTerminals.size > 0 ? {
        workTerminals: [...this.workTerminals.values()].map(value => ({ ...value })),
      } : {}),
    };
  }

  /** Restore persisted delegation facts; older checkpoints have no global state. */
  restore(value: unknown): void {
    const state = asRecord(value);
    if (state?.version !== 1) return;
    if (Array.isArray(state.spawns)) {
      this.registerSpawns(state.spawns.filter(isSpawnDescriptor));
    }
    if (Array.isArray(state.children)) {
      for (const value of state.children) {
        const child = asRecord(value);
        if (!child || !stringValue(child.childThreadId) || !stringValue(child.parentThreadId)
          || !stringValue(child.rootSessionId) || finiteNumber(child.depth) === undefined
          || finiteNumber(child.createdAtMs) === undefined) continue;
        this.storeChild({ ...child } as unknown as CodexChildThreadDescriptor);
      }
    }
    if (Array.isArray(state.bindings)) {
      for (const value of state.bindings) {
        const binding = asRecord(value);
        if (!binding || !stringValue(binding.childThreadId) || !stringValue(binding.childTurnId)
          || !stringValue(binding.invocationId)) continue;
        this.storeBinding({
          childThreadId: binding.childThreadId as string,
          childTurnId: binding.childTurnId as string,
          invocationId: binding.invocationId as string,
        });
      }
    }
    if (Array.isArray(state.completedWorkResults)) {
      for (const value of state.completedWorkResults) {
        const result = asRecord(value);
        if (!result || !stringValue(result.invocationId) || !stringValue(result.childThreadId)
          || !stringValue(result.childTurnId) || typeof result.fingerprint !== 'string'
          || !/^[a-f0-9]{64}$/.test(result.fingerprint)) continue;
        this.storeCompletedWorkResult({
          invocationId: result.invocationId as string,
          childThreadId: result.childThreadId as string,
          childTurnId: result.childTurnId as string,
          fingerprint: result.fingerprint,
        });
      }
    }
    if (Array.isArray(state.workTerminals)) {
      for (const value of state.workTerminals) {
        const terminal = asRecord(value);
        if (!terminal || !stringValue(terminal.invocationId) || !stringValue(terminal.childThreadId)
          || !stringValue(terminal.childTurnId)
          || terminal.terminalType !== 'completed' && terminal.terminalType !== 'interrupted') continue;
        this.storeWorkTerminal({
          invocationId: terminal.invocationId as string,
          childThreadId: terminal.childThreadId as string,
          childTurnId: terminal.childTurnId as string,
          terminalType: terminal.terminalType,
        });
      }
    }
  }

  /** Never infer current work from the last delegation sent to a session. */
  resolveWork(
    meta: CodexTranscriptMeta,
    turn: CodexExtractedTranscriptTurn,
    records: CodexTranscriptSourceRecord[],
    allowCreationFallback = false,
  ): CodexSubagentLink | undefined {
    this.registerChild(meta);
    const child = this.children.get(meta.threadId);
    if (!child) return undefined;
    const byIdentity = this.spawnsByChild.get(child.childThreadId);
    const byPath = child.agentPath
      ? this.spawnsByParentPath.get(parentPathKey(child.parentThreadId, child.agentPath)) : undefined;
    const available = new Map([...(byIdentity ?? []), ...(byPath ?? [])]);
    const candidates = [...available.values()].filter(spawn =>
      !spawn.dispatchFailed && !spawn.associationConflict
      && matchesChild(spawn, child) && spawn.spawnedAtMs <= turn.startedAtMs);
    const hasDirectInput = records.some(source => isDirectUserInput(source, turn.transcriptTurnId));
    const childBindings = this.bindingsByChild.get(meta.threadId);
    const hasPreviousBinding = !!childBindings?.size;
    // Text equality cannot prove provenance: an autonomous user can submit
    // exactly the same words as a previous delegation.
    if (hasDirectInput && !(allowCreationFallback && !hasPreviousBinding)) return undefined;
    const fingerprints = workFingerprints(turn, records);
    if (hasDirectInput && fingerprints.size > 0) return undefined;
    if (fingerprints.size > 1) return undefined;
    const creations = candidates.filter(spawn => !spawn.dispatchKind || spawn.dispatchKind === 'spawn');
    if (hasDirectInput && creations.length !== 1) return undefined;
    const explicit = candidates.filter(spawn => spawn.childTurnId === turn.transcriptTurnId);
    const matching = candidates.filter(spawn => spawn.workFingerprint !== undefined
      && fingerprints.has(spawn.workFingerprint));
    // More than one incoming message within a native turn cannot be stamped
    // uniformly. Leave it independent unless the runtime gives a precise turn.
    if (explicit.length > 1 || (explicit.length === 0 && matching.length > 1)) return undefined;
    const key = workKey(meta.threadId, turn.transcriptTurnId);
    const saved = this.bindings.get(key);
    let selected: CodexSpawnDescriptor | undefined = hasDirectInput ? creations[0] : explicit[0] ?? matching[0];
    if (!selected && fingerprints.size === 0 && saved) {
      selected = candidates.find(spawn => spawn.invocationId === saved.invocationId);
    }
    if (!selected && allowCreationFallback && !hasPreviousBinding) {
      const creation = candidates.filter(spawn => !spawn.dispatchKind || spawn.dispatchKind === 'spawn');
      if (creation.length === 1) selected = creation[0];
    }
    if (!selected && fingerprints.size === 0 && !hasDirectInput && !turn.prompt) {
      const previousBindings = [...(childBindings?.values() ?? [])];
      const previousIds = new Set(previousBindings.map(binding => binding.invocationId));
      // A continuation without fresh input can retain its proven work context.
      if (previousIds.size === 1) selected = candidates.find(spawn => previousIds.has(spawn.invocationId!));
    }
    if (!selected) return undefined;
    this.storeBinding({
      childThreadId: meta.threadId,
      childTurnId: turn.transcriptTurnId,
      invocationId: selected.invocationId!,
    });
    if (!selected.childThreadId && !selected.resolvedChildThreadId) {
      selected = { ...selected, resolvedChildThreadId: meta.threadId };
      this.storeSpawn(spawnKey(selected), selected);
    }
    return {
      ...linkedChild(child, selected, selected.childThreadId ? 'explicit_id' : 'agent_path'),
      childTurnId: turn.transcriptTurnId,
    };
  }

  snapshot(): CodexSubagentLinkSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const spawns = [...this.spawns.values()].filter(spawn => !spawn.dispatchFailed && !spawn.associationConflict
      && (!spawn.dispatchKind || spawn.dispatchKind === 'spawn'));
    const children = [...this.children.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.childThreadId.localeCompare(right.childThreadId));
    const explicit = new Map<string, Map<string, CodexSpawnDescriptor>>();
    const paths = new Map<string, Map<string, CodexSpawnDescriptor>>();
    const remaining = new Map<string, Map<string, CodexSpawnDescriptor>>();
    const eligibleParents = new Set<string>();
    for (const spawn of spawns) {
      eligibleParents.add(spawn.parentThreadId);
      const key = spawnKey(spawn);
      addIndexed(remaining, spawn.parentThreadId, key, spawn);
      if (spawn.childThreadId) addIndexed(explicit, parentPathKey(spawn.parentThreadId, spawn.childThreadId, false), key, spawn);
      const path = descriptorPath(spawn);
      if (path) addIndexed(paths, parentPathKey(spawn.parentThreadId, path), key, spawn);
    }
    const linksByChild = new Map<string, CodexSubagentLink>();
    const remove = (spawn: CodexSpawnDescriptor): void => {
      const key = spawnKey(spawn);
      removeIndexed(remaining, spawn.parentThreadId, key);
      if (spawn.childThreadId) removeIndexed(explicit, parentPathKey(spawn.parentThreadId, spawn.childThreadId, false), key);
      const path = descriptorPath(spawn);
      if (path) removeIndexed(paths, parentPathKey(spawn.parentThreadId, path), key);
    };
    // Resolve exact identities globally before any path can consume a spawn.
    for (const phase of ['explicit_id', 'agent_path'] as const) {
      for (const child of children) {
        if (linksByChild.has(child.childThreadId)) continue;
        const candidates = phase === 'explicit_id'
          ? explicit.get(parentPathKey(child.parentThreadId, child.childThreadId, false))
          : child.agentPath ? paths.get(parentPathKey(child.parentThreadId, child.agentPath)) : undefined;
        if (!candidates?.size) continue;
        if (candidates.size > 1) {
          linksByChild.set(child.childThreadId, orphanLink(child,
            phase === 'explicit_id' ? 'ambiguous_explicit_id' : 'ambiguous_agent_path'));
          continue;
        }
        const spawn = candidates.values().next().value!;
        remove(spawn);
        linksByChild.set(child.childThreadId, linkedChild(child, spawn, phase));
      }
    }
    // A deletable predecessor index avoids rescanning all unclaimed spawns for
    // each diagnostic time fallback. Tied latest timestamps remain ambiguous.
    const timelines = new Map<string, SpawnTimeline>();
    for (const [parent, candidates] of remaining) timelines.set(parent, new SpawnTimeline([...candidates.values()]));
    for (const child of children) {
      if (linksByChild.has(child.childThreadId)) continue;
      const spawn = timelines.get(child.parentThreadId)?.takePreceding(child.createdAtMs);
      if (spawn) linksByChild.set(child.childThreadId, linkedChild(child, spawn, 'time_order'));
      else linksByChild.set(child.childThreadId, orphanLink(child,
        eligibleParents.has(child.parentThreadId) ? 'no_candidate' : 'parent_not_found'));
    }
    const links = children.map(child => linksByChild.get(child.childThreadId)!);
    const linkedChildren = links.filter(link => link.confidence !== 'orphan').length;
    return this.cachedSnapshot = {
      detectedChildren: children.length,
      detectedSpawns: spawns.length,
      linkedChildren,
      orphanChildren: links.length - linkedChildren,
      links,
    };
  }

  private invalidate(): void {
    this.cachedSnapshot = undefined;
    this.cachedState = undefined;
  }

  private storeSpawn(key: string, descriptor: CodexSpawnDescriptor): void {
    const previous = this.spawns.get(key);
    if (previous && sameFacts(previous, descriptor)) return;
    if (previous) this.unindexSpawn(key, previous);
    this.spawns.set(key, descriptor);
    addIndexed(this.spawnsByParent, descriptor.parentThreadId, key, descriptor);
    const childId = descriptor.childThreadId ?? descriptor.resolvedChildThreadId;
    if (childId) addIndexed(this.spawnsByChild, childId, key, descriptor);
    const path = descriptorPath(descriptor);
    if (path) {
      const group = parentPathKey(descriptor.parentThreadId, path);
      addIndexed(this.spawnsByParentPath, group, key, descriptor);
      if (isCreation(descriptor) && !descriptor.dispatchFailed && !descriptor.associationConflict) {
        addIndexed(this.creationsByParentPath, group, key, descriptor);
      }
    }
    while (this.spawns.size > MAX_LINK_DESCRIPTORS) {
      const [oldestKey, oldest] = this.spawns.entries().next().value!;
      this.unindexSpawn(oldestKey, oldest);
      this.spawns.delete(oldestKey);
    }
    this.invalidate();
  }

  private unindexSpawn(key: string, spawn: CodexSpawnDescriptor): void {
    removeIndexed(this.spawnsByParent, spawn.parentThreadId, key);
    const childId = spawn.childThreadId ?? spawn.resolvedChildThreadId;
    if (childId) removeIndexed(this.spawnsByChild, childId, key);
    const path = descriptorPath(spawn);
    if (path) {
      const group = parentPathKey(spawn.parentThreadId, path);
      removeIndexed(this.spawnsByParentPath, group, key);
      removeIndexed(this.creationsByParentPath, group, key);
    }
  }

  private storeChild(child: CodexChildThreadDescriptor): void {
    const previous = this.children.get(child.childThreadId);
    if (previous && sameFacts(previous, child)) return;
    if (previous?.agentPath) removeIndexed(this.childrenByParentPath,
      parentPathKey(previous.parentThreadId, previous.agentPath), previous.childThreadId);
    this.children.set(child.childThreadId, child);
    if (child.agentPath) addIndexed(this.childrenByParentPath,
      parentPathKey(child.parentThreadId, child.agentPath), child.childThreadId, child);
    while (this.children.size > MAX_LINK_DESCRIPTORS) {
      const [key, oldest] = this.children.entries().next().value!;
      if (oldest.agentPath) removeIndexed(this.childrenByParentPath,
        parentPathKey(oldest.parentThreadId, oldest.agentPath), key);
      this.children.delete(key);
    }
    this.invalidate();
  }

  private storeBinding(binding: { childThreadId: string; childTurnId: string; invocationId: string }): void {
    const key = workKey(binding.childThreadId, binding.childTurnId);
    const previous = this.bindings.get(key);
    if (previous && sameFacts(previous, binding)) return;
    this.bindings.set(key, binding);
    addIndexed(this.bindingsByChild, binding.childThreadId, key, binding);
    while (this.bindings.size > MAX_LINK_DESCRIPTORS) {
      const [oldestKey, oldest] = this.bindings.entries().next().value!;
      removeIndexed(this.bindingsByChild, oldest.childThreadId, oldestKey);
      this.bindings.delete(oldestKey);
    }
    this.invalidate();
  }

  private storeCompletedWorkResult(result: CodexCompletedWorkResult): void {
    const key = JSON.stringify([result.invocationId, result.childThreadId, result.childTurnId, result.fingerprint]);
    if (this.completedWorkResults.has(key)) return;
    this.completedWorkResults.set(key, result);
    addIndexed(this.resultsByInvocation, result.invocationId, key, result);
    while (this.completedWorkResults.size > MAX_LINK_DESCRIPTORS) {
      const [oldestKey, oldest] = this.completedWorkResults.entries().next().value!;
      removeIndexed(this.resultsByInvocation, oldest.invocationId, oldestKey);
      this.completedWorkResults.delete(oldestKey);
    }
    this.cachedState = undefined;
  }

  private storeWorkTerminal(terminal: CodexWorkTerminal): void {
    const key = JSON.stringify([terminal.invocationId, terminal.childThreadId, terminal.childTurnId, terminal.terminalType]);
    if (this.workTerminals.has(key)) return;
    this.workTerminals.set(key, terminal);
    addIndexed(this.terminalsByInvocation, terminal.invocationId, key, terminal);
    while (this.workTerminals.size > MAX_LINK_DESCRIPTORS) {
      const [oldestKey, oldest] = this.workTerminals.entries().next().value!;
      removeIndexed(this.terminalsByInvocation, oldest.invocationId, oldestKey);
      this.workTerminals.delete(oldestKey);
    }
    this.cachedState = undefined;
  }
}

class SpawnTimeline {
  private readonly previous: number[];
  private readonly values: CodexSpawnDescriptor[];

  constructor(values: CodexSpawnDescriptor[]) {
    this.values = values.sort((left, right) => left.spawnedAtMs - right.spawnedAtMs);
    this.previous = this.values.map((_, index) => index);
  }

  takePreceding(createdAtMs: number): CodexSpawnDescriptor | undefined {
    let low = 0;
    let high = this.values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (createdAtMs <= 0 || this.values[middle].spawnedAtMs <= createdAtMs) low = middle + 1;
      else high = middle;
    }
    const index = this.find(low - 1);
    if (index < 0) return undefined;
    const before = this.find(index - 1);
    if (before >= 0 && this.values[before].spawnedAtMs === this.values[index].spawnedAtMs) return undefined;
    this.previous[index] = before;
    return this.values[index];
  }

  private find(index: number): number {
    let root = index;
    while (root >= 0 && this.previous[root] !== root) root = this.previous[root];
    while (index >= 0 && index !== root) {
      const next = this.previous[index];
      this.previous[index] = root;
      index = next;
    }
    return root;
  }
}

function addIndexed<T>(index: Map<string, Map<string, T>>, group: string, key: string, value: T): void {
  let entries = index.get(group);
  if (!entries) { entries = new Map(); index.set(group, entries); }
  entries.set(key, value);
}

function removeIndexed<T>(index: Map<string, Map<string, T>>, group: string, key: string): void {
  const entries = index.get(group);
  entries?.delete(key);
  if (entries?.size === 0) index.delete(group);
}

function sameFacts(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).every(key => a[key] === b[key]) && Object.keys(b).every(key => b[key] === a[key]);
}

function descriptorPath(spawn: CodexSpawnDescriptor): string | undefined {
  return spawn.agentPath ?? spawn.taskName;
}

function isCreation(spawn: CodexSpawnDescriptor): boolean {
  return !spawn.dispatchKind || spawn.dispatchKind === 'spawn';
}

function parentPathKey(parentThreadId: string, path: string, normalize = true): string {
  return JSON.stringify([parentThreadId, normalize ? normalizeAgentPath(path) : path]);
}

export function extractCodexSpawnDescriptors(
  turn: CodexExtractedTranscriptTurn,
  sourceRecords: CodexTranscriptSourceRecord[],
  parentTraceId: string,
): CodexSpawnDescriptor[] {
  const activities = new Map<string, Record<string, unknown>[]>();
  for (const source of sourceRecords) {
    if (source.record.type !== 'event_msg') continue;
    const payload = asRecord(source.record.payload);
    if (!payload || payload.type !== 'sub_agent_activity' || payload.kind !== 'started') continue;
    const callId = stringValue(payload.event_id) ?? stringValue(payload.call_id) ?? stringValue(payload.tool_call_id);
    if (!callId) continue;
    const list = activities.get(callId) ?? [];
    const activityIdentity = (record: Record<string, unknown>): string => JSON.stringify([
      record.agent_thread_id ?? record.agent_id, record.agent_path ?? record.task_path, record.turn_id,
    ]);
    if (!list.some(record => activityIdentity(record) === activityIdentity(payload))) list.push(payload);
    activities.set(callId, list);
  }

  const descriptors: CodexSpawnDescriptor[] = [];
  for (const step of turn.steps) {
    for (const tool of step.tools) {
      const name = tool.name.replace(/^.*[./]/, '');
      const dispatchKind = name === 'spawn_agent' ? 'spawn'
        : name === 'followup_task' ? 'followup'
          : name === 'send_input' ? 'input' : undefined;
      if (!dispatchKind) continue;
      const input = parsedRecord(tool.input);
      const output = parsedRecord(tool.output);
      const tasks = recordArray(input?.agents) ?? recordArray(input?.tasks);
      const resultTasks = recordArray(output?.agents) ?? recordArray(output?.tasks)
        ?? recordArray(tool.output);
      const activity = activities.get(tool.callId) ?? [];
      const count = Math.max(tasks?.length ?? 0, resultTasks?.length ?? 0, activity.length, 1);
      for (let index = 0; index < count; index++) {
        const task = tasks?.[index] ?? input;
        const result = resultTasks?.[index] ?? (count === 1 ? output : undefined);
        const activityMatch = selectWorkActivity(activity, result, task, count,
          !tasks && !resultTasks && count > 1 ? index : undefined);
        const started = activityMatch.record;
        const workPrompt = messageText(task?.message) ?? messageText(task?.prompt)
          ?? messageText(task?.input);
        // Queries, notification-only sends and cancellations do not start work.
        if (dispatchKind !== 'spawn' && (!workPrompt || task?.cancel === true
          || task?.notification === true || task?.notify_only === true
          || task?.notification_only === true)) continue;
        const childThreadId = stringValue(started?.agent_thread_id)
          ?? stringValue(started?.agent_id)
          ?? stringValue(result?.agent_id) ?? stringValue(result?.thread_id)
          ?? stringValue(result?.agent_thread_id)
          ?? (dispatchKind !== 'spawn' ? stringValue(task?.id) ?? stringValue(task?.agent_id)
            ?? stringValue(task?.thread_id) : undefined);
        const agentPath = stringValue(started?.agent_path)
          ?? stringValue(started?.task_path)
          ?? stringValue(result?.agent_path) ?? stringValue(result?.task_path)
          ?? stringValue(result?.task_name)
          ?? (dispatchKind !== 'spawn' ? stringValue(task?.target) : undefined);
        const taskName = stringValue(task?.task_name) ?? stringValue(task?.agent_path);
        descriptors.push(completeDescriptor({
          parentThreadId: turn.sessionId,
          parentTurnId: turn.transcriptTurnId,
          parentTraceId,
          parentToolCallId: tool.callId,
          spawnedAtMs: finiteNumber(started?.occurred_at_ms) ?? tool.startedAtMs,
          dispatchKind,
          workIndex: index,
          ...(taskName ? { taskName } : {}),
          ...(agentPath ? { agentPath } : {}),
          ...(childThreadId ? { childThreadId } : {}),
          ...(workPrompt ? { workPrompt } : {}),
          ...(activityMatch.conflict ? { associationConflict: true } : {}),
          ...(output?.error || output?.status === 'failed' || output?.status === 'rejected'
            || typeof tool.output === 'string' && /(?:spawn failed|spawn rejected|agent thread limit)/i.test(tool.output)
            ? { dispatchFailed: true } : {}),
          ...(stringValue(result?.nickname) ? { agentNickname: stringValue(result?.nickname) } : {}),
          ...(stringValue(started?.turn_id) ?? stringValue(result?.turn_id)
            ? { childTurnId: stringValue(started?.turn_id) ?? stringValue(result?.turn_id) } : {}),
        }));
      }
    }
  }
  return descriptors;
}

function linkedChild(
  child: CodexChildThreadDescriptor,
  spawn: CodexSpawnDescriptor,
  confidence: Exclude<CodexSubagentLinkConfidence, 'orphan'>,
): CodexSubagentLink {
  return {
    parentThreadId: spawn.parentThreadId,
    parentTurnId: spawn.parentTurnId,
    parentTraceId: spawn.parentTraceId,
    parentToolCallId: spawn.parentToolCallId,
    parentToolSpanId: spawn.parentToolSpanId,
    invocationId: spawn.invocationId,
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

function completeDescriptor(spawn: CodexSpawnDescriptor): CodexSpawnDescriptor {
  const {
    workPrompt, resultFingerprints: _resultFingerprints,
    resultTerminalObserved: _resultTerminalObserved, resultChildTurnIds: _resultChildTurnIds,
    resultOutcomeKnown: _resultOutcomeKnown,
    ...descriptor
  } = spawn;
  const fingerprint = descriptor.workFingerprint ?? (workPrompt ? workFingerprint(workPrompt) : undefined);
  return {
    ...descriptor,
    ...(fingerprint ? { workFingerprint: fingerprint } : {}),
    parentToolSpanId: spawn.parentToolSpanId
      ?? codexToolSpanId(spawn.parentThreadId, spawn.parentTurnId, spawn.parentToolCallId),
    invocationId: spawn.invocationId ?? crypto.createHash('sha256')
      .update(JSON.stringify(['codex-delegation', spawn.parentThreadId, spawn.parentTurnId,
        spawn.parentToolCallId, spawn.workIndex ?? 0])).digest('hex').slice(0, 32),
  };
}

function workKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function matchesChild(spawn: CodexSpawnDescriptor, child: CodexChildThreadDescriptor): boolean {
  if (spawn.childThreadId) return spawn.childThreadId === child.childThreadId;
  if (spawn.resolvedChildThreadId) return spawn.resolvedChildThreadId === child.childThreadId;
  if (spawn.parentThreadId !== child.parentThreadId || !child.agentPath) return false;
  const candidatePath = spawn.agentPath ?? spawn.taskName;
  return candidatePath !== undefined && normalizeAgentPath(candidatePath) === normalizeAgentPath(child.agentPath);
}

function workFingerprints(turn: CodexExtractedTranscriptTurn, records: CodexTranscriptSourceRecord[]): Set<string> {
  const plain = new Set<string>();
  const encrypted = new Set<string>();
  for (const source of records) {
    if (!isCodexAgentWorkMessage(source, turn.transcriptTurnId)) continue;
    const payload = asRecord(source.record.payload);
    if (!payload || payload.type !== 'agent_message' || source.record.type !== 'response_item') continue;
    const context = asRecord(payload.internal_chat_message_metadata_passthrough);
    const turnId = stringValue(context?.turn_id) ?? stringValue(payload.turn_id);
    if (turnId && turnId !== turn.transcriptTurnId) continue;
    if (Array.isArray(payload.content)) {
      for (const part of payload.content) {
        const content = asRecord(part);
        if (content?.type !== 'encrypted_content') continue;
        const opaque = stringValue(content.encrypted_content);
        if (opaque) encrypted.add(workFingerprint(opaque));
      }
    }
    const text = messageText(payload.content) ?? messageText(payload.message);
    if (text) plain.add(workFingerprint(text));
  }
  // The plaintext NEW_TASK wrapper is transport metadata. Equality uses only
  // opaque payloads when present; no decryption or payload persistence is needed.
  return encrypted.size > 0 ? encrypted : plain;
}

/** Result notifications continue existing work; only new work can replace its incoming context. */
export function isCodexWorkInput(source: CodexTranscriptSourceRecord, turnId: string): boolean {
  return isDirectUserInput(source, turnId) || isCodexAgentWorkMessage(source, turnId);
}

function isCodexAgentWorkMessage(source: CodexTranscriptSourceRecord, turnId: string): boolean {
  const payload = asRecord(source.record.payload);
  if (source.record.type !== 'response_item' || payload?.type !== 'agent_message') return false;
  const context = asRecord(payload.internal_chat_message_metadata_passthrough);
  const recordTurnId = stringValue(context?.turn_id) ?? stringValue(payload.turn_id);
  if (recordTurnId && recordTurnId !== turnId) return false;
  const text = messageText(payload.content) ?? messageText(payload.message);
  return text?.trimStart().match(/^Message Type:\s*(\S+)/)?.[1] !== 'FINAL_ANSWER';
}

function isDirectUserInput(source: CodexTranscriptSourceRecord, turnId: string): boolean {
  const payload = asRecord(source.record.payload);
  if (!payload) return false;
  const context = asRecord(payload.internal_chat_message_metadata_passthrough);
  const recordTurnId = stringValue(context?.turn_id) ?? stringValue(payload.turn_id);
  if (recordTurnId && recordTurnId !== turnId) return false;
  return source.record.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      && !isInjectedCodexContext(payload.content)
    || source.record.type === 'event_msg' && payload.type === 'user_message';
}

/** Codex can inject workspace instructions as role=user in a fresh isolated thread. */
function isInjectedCodexContext(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(part => {
    const item = asRecord(part);
    if (item?.type !== 'input_text' || typeof item.text !== 'string') return false;
    const text = item.text.trim();
    return /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/.test(text)
      || /^<environment_context>[\s\S]*<\/environment_context>$/.test(text);
  });
}

function selectWorkActivity(
  activities: Record<string, unknown>[],
  result: Record<string, unknown> | undefined,
  task: Record<string, unknown> | undefined,
  count: number,
  activityOnlyIndex?: number,
): { record?: Record<string, unknown>; conflict?: boolean } {
  if (activityOnlyIndex !== undefined) return { record: activities[activityOnlyIndex] };
  const childId = stringValue(result?.agent_id) ?? stringValue(result?.thread_id)
    ?? stringValue(result?.agent_thread_id) ?? stringValue(task?.agent_id) ?? stringValue(task?.thread_id)
    ?? stringValue(task?.id);
  if (childId) {
    const matching = activities.filter(activity =>
      (stringValue(activity.agent_thread_id) ?? stringValue(activity.agent_id)) === childId);
    if (matching.length === 1) return { record: matching[0] };
    if (matching.length > 1) return { conflict: true };
    // A single contradictory source is a conflict; other batch activities
    // can describe siblings and provide no evidence about this work.
    return { conflict: count === 1 && activities.length > 0 };
  }
  const path = stringValue(result?.agent_path) ?? stringValue(result?.task_path)
    ?? stringValue(result?.task_name) ?? stringValue(task?.agent_path)
    ?? stringValue(task?.task_path) ?? stringValue(task?.task_name) ?? stringValue(task?.target);
  const taskId = stringValue(result?.task_id) ?? stringValue(task?.task_id);
  if (path || taskId) {
    const matching = activities.filter(activity => {
      if (taskId && stringValue(activity.task_id) === taskId) return true;
      const activityPath = stringValue(activity.agent_path) ?? stringValue(activity.task_path)
        ?? stringValue(activity.task_name);
      return !!path && !!activityPath && normalizeAgentPath(path) === normalizeAgentPath(activityPath);
    });
    if (matching.length === 1) return { record: matching[0] };
    if (matching.length > 1) return { conflict: true };
    if (count === 1 && activities.length === 1) {
      const only = activities[0];
      const activityPath = stringValue(only.agent_path) ?? stringValue(only.task_path) ?? stringValue(only.task_name);
      const activityTaskId = stringValue(only.task_id);
      if (path && activityPath || taskId && activityTaskId) return { conflict: true };
    }
  }
  return count === 1 && activities.length === 1 ? { record: activities[0] } : {};
}

function workFingerprint(value: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(value)).digest('hex');
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value.map(part => {
      const record = asRecord(part);
      return stringValue(record?.text) ?? '';
    }).filter(Boolean).join('\n');
    return text || undefined;
  }
  return undefined;
}

function parsedRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return asRecord(value);
  try { return asRecord(JSON.parse(value)); } catch { return undefined; }
}

function recordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // Keep positions: filtered arrays could silently assign a result to another work.
  return value.map(item => asRecord(item) ?? {});
}

function isSpawnDescriptor(value: unknown): value is CodexSpawnDescriptor {
  const spawn = asRecord(value);
  return !!spawn && !!stringValue(spawn.parentThreadId) && !!stringValue(spawn.parentTurnId)
    && !!stringValue(spawn.parentTraceId) && !!stringValue(spawn.parentToolCallId)
    && finiteNumber(spawn.spawnedAtMs) !== undefined;
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
  return JSON.stringify([spawn.parentThreadId, spawn.parentTurnId, spawn.parentToolCallId, spawn.workIndex ?? 0]);
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
