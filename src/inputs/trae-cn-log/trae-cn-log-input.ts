import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

const DEFAULT_HOOK_LOG_DIR = '~/.loongsuite-pilot/logs/trae-cn/history';
const DEFAULT_FILE_PATTERN = 'trae-cn-*.jsonl';
const DEFAULT_AUX_LOG_DIR = '~/.trae-cn/logs';

export interface TraeCnLogInputOptions extends SessionInputOptions {
  /** TRAE ai-agent stdout log directory (auxiliary source; best-effort). */
  auxLogDir?: string;
}

/**
 * TRAE-CN dual-source input — reads the JSONL produced by
 * `assets/hooks/trae-cn-hook-processor.mjs` as the primary source, with an
 * optional best-effort auxiliary pass over TRAE's own `ai-agent` stdout logs
 * (per user spec v2 §2.5.1 / §8.4) for tool action metadata.
 *
 * Primary records carry the full ENTRY→AGENT→STEP→LLM/TOOL span tree; aux
 * records only enrich existing primary records (deduped by
 * (session_id, tool_call_id) — the join key confirmed in §8.4). When
 * `auxLogDir` is absent or unparseable, the aux pass is a no-op and the
 * primary source alone is emitted.
 */
export class TraeCnLogInput extends BaseSessionInput {
  readonly id = 'trae-cn-log';
  readonly agentType = ClientType.TraeCn;

  private readonly auxLogDir: string;

  constructor(opts?: Partial<TraeCnLogInputOptions> & { stateStore: SessionInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      sessionDir: opts?.sessionDir ?? resolveHome(DEFAULT_HOOK_LOG_DIR),
      filePattern: opts?.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
    this.auxLogDir = opts?.auxLogDir ?? resolveHome(DEFAULT_AUX_LOG_DIR);
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_HOOK_LOG_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_HOOK_LOG_DIR)];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionDir);
    } catch {
      return [];
    }
    const prefix = this.filePattern.replace(/\*.*$/, '');
    const suffix = this.filePattern.replace(/^.*\*/, '');
    const filtered = names.filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
    return filtered.sort().map((n) => path.join(this.sessionDir, n));
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    _filePath: string,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.TraeCn, 'trae-cn');
  }

  /**
   * Auxiliary source: TRAE's own ai-agent stdout log. The hook payload lacks
   * trace_id (§2.7), so aux records cannot be joined to primary by span_id;
   * they're joined by (session_id, tool_call_id) per §8.4 and only enrich
   * primary records that already exist (synthesizing standalone TOOL spans
   * would break `structure.tool_under_step`).
   *
   * MVP scope: structured best-effort scan — when `auxLogDir` is absent or
   * unreadable, the aux pass is a no-op and primary records pass through
   * unchanged. The hook alone produces the full 5-layer span tree the
   * validator enforces.
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const primary = await super.collect();
    // Aux source is plumbed and structured but currently a no-op: TRAE ai-agent
    // stdout lines do not carry a stable join key back to the hook's
    // session_id without further implementation work (§8.4 — the join key is
    // `tool_use_id`, which the hook already emits). Re-enable here once the
    // aux parser is wired; the dedup guard is by (session_id, span_id) so
    // primary records always win.
    return primary;
  }
}
