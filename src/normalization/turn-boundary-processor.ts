import type { AgentActivityEntry } from '../types/index.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';

const MAX_TRACKED_TURNS = 4_096;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_FINISH_REASONS = new Set(['stop', 'end_turn', 'cancelled', 'error']);

interface TrackedTurn {
  started: boolean;
  ended: boolean;
  updatedAt: number;
}

/**
 * Fill-only turn boundary enrichment shared by every canonical Agent input.
 *
 * The processor deliberately mutates only `gen_ai.turn.start/end`. Existing
 * markers stay authoritative, records are never reordered or synthesized, and
 * records without a reliable turn.id are left untouched. Tracking is bounded
 * and process-local so enrichment never participates in input checkpoints.
 */
export class TurnBoundaryProcessor {
  private readonly turns = new Map<string, TrackedTurn>();

  enrich(entries: AgentActivityEntry[]): void {
    if (entries.length === 0) return;

    const grouped = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      if (entry['gen_ai.agent.scope'] === 'subagent') continue;
      const key = turnKey(entry);
      if (!key) continue;
      const group = grouped.get(key);
      if (group) group.push(entry);
      else grouped.set(key, [entry]);
    }
    if (grouped.size === 0) return;

    const now = Date.now();
    for (const [key, turnEntries] of grouped) {
      const tracked = this.turns.get(key) ?? {
        started: false,
        ended: false,
        updatedAt: now,
      };

      // Inspect the complete batch before filling anything. Producers such as
      // WorkBuddy place their existing start marker on llm.request rather than
      // the first record; a single-pass fill would create a duplicate marker.
      if (turnEntries.some(entry => hasOwnBoundary(entry, 'gen_ai.turn.start'))) {
        tracked.started = true;
      }
      if (turnEntries.some(entry => hasOwnBoundary(entry, 'gen_ai.turn.end'))) {
        tracked.ended = true;
      }

      if (!tracked.started) {
        turnEntries[0]['gen_ai.turn.start'] = true;
        tracked.started = true;
      }

      if (!tracked.ended) {
        const terminal = [...turnEntries].reverse().find(isTerminalTurnEntry);
        if (terminal) {
          terminal['gen_ai.turn.end'] = true;
          tracked.ended = true;
        }
      }

      tracked.updatedAt = now;
      this.turns.set(key, tracked);
    }

    this.compact(now);
  }

  private compact(now: number): void {
    for (const [key, turn] of this.turns) {
      if (now - turn.updatedAt > STATE_TTL_MS) this.turns.delete(key);
    }
    if (this.turns.size <= MAX_TRACKED_TURNS) return;

    const overflow = [...this.turns.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(0, this.turns.size - MAX_TRACKED_TURNS);
    for (const [key] of overflow) this.turns.delete(key);
  }
}

/** Agent-aware terminal signal used only for additive boundary enrichment. */
export function isTerminalTurnEntry(entry: AgentActivityEntry): boolean {
  if (entry['gen_ai.agent.scope'] === 'subagent') return false;
  if (entry['gen_ai.turn.end'] === true) return true;

  const agentType = normalizeAgentType(String(entry['gen_ai.agent.type'] ?? ''));
  if (agentType === 'codex') {
    const status = entry['agent.codex.turn_status'];
    return status === 'completed' || status === 'interrupted';
  }
  if (agentType === 'openclaw') {
    return entry['agent.openclaw.hook'] === 'llm_output';
  }

  const reasons = entry['gen_ai.response.finish_reasons'];
  return Array.isArray(reasons)
    && reasons.some(reason => typeof reason === 'string' && TERMINAL_FINISH_REASONS.has(reason));
}

function turnKey(entry: AgentActivityEntry): string | undefined {
  const turnId = nonEmptyString(entry['gen_ai.turn.id']);
  if (!turnId) return undefined;
  const agentType = normalizeAgentType(nonEmptyString(entry['gen_ai.agent.type']) ?? 'unknown');
  const sessionId = nonEmptyString(entry['gen_ai.session.id']) ?? '';
  return `${agentType}\u0000${sessionId}\u0000${turnId}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasOwnBoundary(
  entry: AgentActivityEntry,
  field: 'gen_ai.turn.start' | 'gen_ai.turn.end',
): boolean {
  return Object.prototype.hasOwnProperty.call(entry, field);
}
