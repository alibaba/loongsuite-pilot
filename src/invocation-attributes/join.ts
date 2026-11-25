import { setTimeout as delay } from 'node:timers/promises';
import {
  nativeInvocationMessageId, projectInvocationAttributes, isInvocationAttributeKey,
} from '../../assets/hooks/shared/invocation-attributes.mjs';
import {
  isUsableInvocationId, type InvocationAttributeStore, type NativeInvocationSelector,
} from '../../assets/hooks/shared/invocation-attribute-store.mjs';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type { InvocationAttributeConfig } from './config.js';

const logger = createLogger('InvocationAttributeJoin');
const maxSelectors = 1024;

/**
 * Joins at the common Collector boundary before customer-facing identity rewrites.
 * There is deliberately no text, timestamp, global environment or Trace ID key.
 */
export class InvocationAttributeJoin {
  constructor(private readonly store: InvocationAttributeStore | null, private readonly config: InvocationAttributeConfig) {}

  async apply(inputId: string, entries: AgentActivityEntry[]): Promise<void> {
    const config = Object.hasOwn(this.config.sources, inputId) ? this.config.sources[inputId] : undefined;
    if (!config) return;
    const { scope, waitMs, attributePrefixes } = config;
    const owned = (key: string): boolean => attributePrefixes.some(prefix => key.startsWith(prefix));
    const pending = new Map<string, { agent: string; selector: NativeInvocationSelector; rows: AgentActivityEntry[] }>();
    let reportFailure = false;
    for (const row of entries) {
      // A configured managed namespace cannot inherit process defaults, even on
      // a missing join/explicit empty snapshot. Structural/native fields stay intact.
      if (attributePrefixes.length) {
        for (const key of Object.keys(row)) if (owned(key) && isInvocationAttributeKey(key)) delete row[key];
      }
      if (!this.store) continue;
      const agent = row['gen_ai.agent.type'], sessionId = row['gen_ai.session.id'], turnId = row['gen_ai.turn.id'];
      if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) continue;
      const messageId = nativeInvocationMessageId(row);
      const selector: NativeInvocationSelector | undefined =
        config.selector === 'message'
          ? isUsableInvocationId(messageId) ? { kind: 'message', messageId } : undefined
          // Several Hook paths fall back to sessionId when the per-turn ID is absent.
          : isUsableInvocationId(sessionId) && isUsableInvocationId(turnId) && sessionId !== turnId
            ? { kind: 'turn', sessionId, turnId } : undefined;
      if (!selector) continue;
      const key = JSON.stringify([agent, selector]);
      const existing = pending.get(key);
      if (existing) existing.rows.push(row);
      else pending.set(key, { agent, selector, rows: [row] });
    }
    const store = this.store;
    if (!store) return;
    const deadline = performance.now() + waitMs;
    let pass = 0;
    while (pending.size) {
      const seal = waitMs === 0 || pass++ >= Math.ceil(waitMs / 25) + 1 || performance.now() >= deadline;
      let index = 0;
      for (const [key, group] of pending) {
        try {
          const result = store.resolve({
            agent: group.agent, scope, selector: group.selector, managed: waitMs > 0,
            waitMs, seal: seal || index++ >= maxSelectors,
          });
          if (result.state === 'pending') continue;
          const attrs = attributePrefixes.length === 0 ? result.attributes
            : Object.fromEntries(Object.entries(result.attributes).filter(([key]) => owned(key)));
          for (const row of group.rows) projectInvocationAttributes(row, attrs);
        } catch {
          // A corrupt/busy/full metadata store must not turn into loss of base
          // telemetry. No identity or data from another invocation is substituted.
          reportFailure = true;
        }
        pending.delete(key);
      }
      if (pending.size) await delay(25);
    }
    if (reportFailure) logger.warn('invocation attribute store unavailable for one or more entries', { inputId });
  }

  close(): void { this.store?.close(); }
}
