import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseCollector, type CollectorOptions } from './base-collector.js';
import {
  buildAgentActivityEntryFromPayload,
  type RawAgentActivityPayload,
} from '../../normalization/payload-normalizer.js';

export interface HttpPushCollectorOptions extends CollectorOptions {
  /** A default userId if the incoming payload lacks one. */
  fallbackUserId?: string;
}

/**
 * Base collector for HTTP push reception.
 * Does not poll — entries are pushed in from the local HTTP server.
 *
 * Subclass can override transformPushPayload() for custom normalization.
 */
export abstract class BaseHttpPushCollector extends BaseCollector {
  readonly collectionMethod = CollectionMethod.HttpPush;

  protected readonly fallbackUserId: string;
  private readonly pendingEntries: AgentActivityEntry[] = [];

  constructor(opts: HttpPushCollectorOptions) {
    super(opts);
    this.fallbackUserId = opts.fallbackUserId ?? '';
  }

  /**
   * Called by the HTTP server when a payload is received.
   * This is the push ingestion point.
   */
  async ingestPayload(payload: RawAgentActivityPayload): Promise<void> {
    const entry = await this.transformPushPayload(payload);
    if (entry) {
      this.pendingEntries.push(entry);
      this.emit('entries', [entry]);
    }
  }

  /**
   * Batch ingest.
   */
  async ingestPayloads(payloads: RawAgentActivityPayload[]): Promise<void> {
    for (const p of payloads) {
      await this.ingestPayload(p);
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const entries = this.pendingEntries.splice(0);
    return entries;
  }

  /**
   * Convert a push payload into an AgentActivityEntry.
   * Default uses buildAgentActivityEntryFromPayload; override for custom logic.
   */
  protected async transformPushPayload(
    payload: RawAgentActivityPayload,
  ): Promise<AgentActivityEntry | null> {
    return buildAgentActivityEntryFromPayload(payload, this.fallbackUserId);
  }
}
