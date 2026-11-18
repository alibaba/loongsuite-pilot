import type { AgentActivityEntry } from '../types/index.js';
import type { CodexTurnJournal } from './codex-turn-journal.js';
import { createLogger } from '../utils/logger.js';

/** The existing journal protocol can serve independent on-disk budgets. */
export type TurnJournal = Pick<CodexTurnJournal,
  'acceptsAgent' | 'accepts' | 'append' | 'loadBatches' | 'isAcknowledged' | 'acknowledge' | 'remove'>;

const logger = createLogger('RoutedTurnJournal');

export class RoutedTurnJournal implements TurnJournal {
  private readonly failed = new Map<TurnJournal, unknown>();

  constructor(
    private readonly journals: readonly TurnJournal[],
    private readonly isolated: readonly TurnJournal[] = [],
  ) {}

  private ensureAvailable(journal: TurnJournal): void {
    if (this.failed.has(journal)) {
      throw new Error('Isolated pending turn journal is unavailable; retain its source checkpoint until restart',
        { cause: this.failed.get(journal) });
    }
  }

  acceptsAgent(agent: string): boolean { return this.journals.some(journal => journal.acceptsAgent(agent)); }

  accepts(value: unknown): value is AgentActivityEntry {
    return this.journals.some(journal => journal.accepts(value));
  }

  async append(entries: AgentActivityEntry[]): Promise<void> {
    for (const journal of this.journals) {
      const own = entries.filter(entry => journal.accepts(entry));
      if (own.length) {
        this.ensureAvailable(journal);
        await journal.append(own);
      }
    }
  }

  async *loadBatches(key?: string): ReturnType<TurnJournal['loadBatches']> {
    for (const journal of this.journals) {
      if (this.failed.has(journal)) continue;
      try {
        yield* journal.loadBatches(key);
      } catch (error) {
        if (!this.isolated.includes(journal)) throw error;
        this.failed.set(journal, error);
        logger.error('isolated pending turn journal unavailable; its source must wait for recovery', { error: String(error) });
      }
    }
  }

  async isAcknowledged(entry: AgentActivityEntry): Promise<boolean> {
    const journal = this.journals.find(candidate => candidate.accepts(entry));
    if (!journal) return false;
    this.ensureAvailable(journal);
    return journal.isAcknowledged(entry);
  }

  async acknowledge(entries: AgentActivityEntry[]): Promise<void> {
    for (const journal of this.journals) {
      const own = entries.filter(entry => journal.accepts(entry));
      if (own.length) {
        this.ensureAvailable(journal);
        await journal.acknowledge(own);
      }
    }
  }

  async remove(entriesOrKey: AgentActivityEntry[] | string): Promise<void> {
    for (const journal of this.journals) {
      if (this.failed.has(journal)) continue;
      if (typeof entriesOrKey === 'string') await journal.remove(entriesOrKey);
      else {
        const own = entriesOrKey.filter(entry => journal.accepts(entry));
        if (own.length) await journal.remove(own);
      }
    }
  }
}
