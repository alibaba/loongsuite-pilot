import type { AgentActivityEntry } from '../types/index.js';
import type { CodexTurnJournal } from './codex-turn-journal.js';

/** The existing journal protocol can serve independent on-disk budgets. */
export type TurnJournal = Pick<CodexTurnJournal,
  'acceptsAgent' | 'accepts' | 'append' | 'loadBatches' | 'isAcknowledged' | 'acknowledge' | 'remove'>;

export class RoutedTurnJournal implements TurnJournal {
  constructor(private readonly journals: readonly TurnJournal[]) {}

  acceptsAgent(agent: string): boolean { return this.journals.some(journal => journal.acceptsAgent(agent)); }

  accepts(value: unknown): value is AgentActivityEntry {
    return this.journals.some(journal => journal.accepts(value));
  }

  async append(entries: AgentActivityEntry[]): Promise<void> {
    for (const journal of this.journals) {
      const own = entries.filter(entry => journal.accepts(entry));
      if (own.length) await journal.append(own);
    }
  }

  async *loadBatches(key?: string): ReturnType<TurnJournal['loadBatches']> {
    for (const journal of this.journals) yield* journal.loadBatches(key);
  }

  async isAcknowledged(entry: AgentActivityEntry): Promise<boolean> {
    const journal = this.journals.find(candidate => candidate.accepts(entry));
    return journal ? journal.isAcknowledged(entry) : false;
  }

  async acknowledge(entries: AgentActivityEntry[]): Promise<void> {
    for (const journal of this.journals) {
      const own = entries.filter(entry => journal.accepts(entry));
      if (own.length) await journal.acknowledge(own);
    }
  }

  async remove(entriesOrKey: AgentActivityEntry[] | string): Promise<void> {
    for (const journal of this.journals) {
      if (typeof entriesOrKey === 'string') await journal.remove(entriesOrKey);
      else {
        const own = entriesOrKey.filter(entry => journal.accepts(entry));
        if (own.length) await journal.remove(own);
      }
    }
  }
}
