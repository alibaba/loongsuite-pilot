import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { StateStore } from '../../../checkpoints/state-store.js';
import { createLogger, type BoundLogger } from '../../../utils/logger.js';
import { ensureDir } from '../../../utils/fs-utils.js';
import {
  QoderApiClient,
  QoderApiHttpError,
  type ListUsageEventsResponse,
  type QoderChangeItem,
  type QoderCommitItem,
  type QoderMember,
  type QoderQuotaResponse,
  type QoderUsageEvent,
} from './qoder-api-client.js';

const MEMBER_CONCURRENCY = 5;
const MAX_MEMBER_PAGES = 50;
const MAX_OFFSET_PAGES = 50;

export interface QoderApiInputOptions {
  client: QoderApiClient;
  orgId: string;
  configName: string;
  stateDir: string;
  interval: number;
  backfillDays: number;
}

interface WindowState {
  lastWindowEnd?: string;
}

/**
 * Standalone Qoder API collection input.
 *
 * Polls the Qoder OpenAPI on a configurable interval and returns raw API
 * records as flat-string rows. Uses a sliding window persisted in a
 * StateStore to avoid duplicate collection across restarts.
 */
export class QoderApiInput {
  private readonly client: QoderApiClient;
  private readonly orgId: string;
  private readonly configName: string;
  private readonly backfillDays: number;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly logger: BoundLogger;
  private stateLoaded = false;
  private fatalAuthError = false;
  private inFlight: Promise<Record<string, string>[]> | null = null;
  private pendingWindowEnd: string | null = null;

  constructor(opts: QoderApiInputOptions) {
    this.client = opts.client;
    this.orgId = opts.orgId;
    this.configName = opts.configName;
    this.backfillDays = opts.backfillDays;
    this.logger = createLogger(`QoderApiInput:${opts.configName}`);
    this.stateFilePath = path.join(opts.stateDir, `${opts.configName}.json`);
    this.stateStore = new StateStore(this.stateFilePath);
  }

  /** Returns true when a fatal auth error (401/403) has been detected. */
  hasFatalAuthError(): boolean {
    return this.fatalAuthError;
  }

  /**
   * Runs the full 16-step collection cycle and returns all collected rows.
   * Returns an empty array if a previous cycle is still running or auth has failed.
   */
  async collect(): Promise<Record<string, string>[]> {
    if (this.fatalAuthError) return [];
    if (this.inFlight) {
      this.logger.warn('previous cycle still running; skipping');
      return [];
    }
    this.inFlight = this.runCycle();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Called by the pipeline after rows have been successfully delivered to SLS.
   * Advances the collection window so the next cycle starts from the new position.
   * This ensures at-least-once semantics: if delivery fails, the window does not
   * advance and the same data will be re-collected (deduped by event_id).
   */
  async confirmCycle(): Promise<void> {
    if (this.pendingWindowEnd) {
      this.setWindowState({ lastWindowEnd: this.pendingWindowEnd });
      await this.stateStore.save();
      this.pendingWindowEnd = null;
    }
  }

  private async runCycle(): Promise<Record<string, string>[]> {
    // Ensure state store is loaded on first run.
    if (!this.stateLoaded) {
      await ensureDir(path.dirname(this.stateFilePath));
      await this.stateStore.load();
      this.stateLoaded = true;
    }

    const startedAt = Date.now();
    const windowEnd = new Date();
    const state = this.getWindowState();
    const backfillMs = this.backfillDays * 24 * 60 * 60 * 1000;
    const windowStart = state.lastWindowEnd
      ? new Date(state.lastWindowEnd)
      : new Date(windowEnd.getTime() - backfillMs);

    if (!state.lastWindowEnd) {
      this.logger.warn('first run backfill', {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        backfillDays: this.backfillDays,
      });
    }

    const startIso = windowStart.toISOString();
    const endIso = windowEnd.toISOString();
    const reportTs = endIso;

    let advanceWindow = true;
    const logs: Record<string, string>[] = [];
    const counts: Record<string, number> = {};
    const pushLog = (log: Record<string, string>): void => {
      logs.push(log);
      const kind = log.kind ?? 'unknown';
      counts[kind] = (counts[kind] ?? 0) + 1;
    };

    // For endpoints that cap window length (e.g. usage-summary <= 7 days),
    // clamp the lookback window.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const sevenDayStartIso = new Date(
      Math.max(windowStart.getTime(), windowEnd.getTime() - SEVEN_DAYS_MS + 60_000),
    ).toISOString();
    const ninetyDayStartIso = new Date(
      Math.max(windowStart.getTime(), windowEnd.getTime() - NINETY_DAYS_MS + 60_000),
    ).toISOString();

    // 1. Members
    let members: QoderMember[] = [];
    try {
      members = await this.fetchAllMembers();
    } catch (err) {
      advanceWindow = this.handleCycleError('listMembers', err) && advanceWindow;
    }

    // 2. Per-member usage + quota
    if (members.length > 0) {
      for (let i = 0; i < members.length; i += MEMBER_CONCURRENCY) {
        const batch = members.slice(i, i + MEMBER_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((m) =>
            this.fetchMemberData(m, startIso, endIso, reportTs).then(
              (memberLogs) => ({ memberId: m.id, memberLogs }),
            ),
          ),
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          const m = batch[j];
          if (r.status === 'fulfilled') {
            for (const log of r.value.memberLogs) pushLog(log);
          } else {
            advanceWindow = this.handleCycleError(
              `member ${m.id}`,
              r.reason,
            ) && advanceWindow;
          }
        }
      }
    }

    // 3. Org-level AI code changes
    try {
      const changeLogs = await this.fetchAllChanges(startIso, endIso, reportTs);
      for (const l of changeLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('listAiCodeChanges', err) && advanceWindow;
    }

    // 4. Org-level AI code commits
    try {
      const commitLogs = await this.fetchAllCommits(startIso, endIso, reportTs);
      for (const l of commitLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('listAiCodeCommits', err) && advanceWindow;
    }

    // 5. Org-level usage events (organization-wide, includes refunds/reversals)
    try {
      const orgUsageLogs = await this.fetchAllOrgUsageEvents(startIso, endIso, reportTs);
      for (const l of orgUsageLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('listOrgUsageEvents', err) && advanceWindow;
    }

    // 6. Per-member usage summary (groupBy=source, <= 7 day window)
    if (members.length > 0) {
      for (let i = 0; i < members.length; i += MEMBER_CONCURRENCY) {
        const batch = members.slice(i, i + MEMBER_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((m) =>
            this.client.getMemberUsageSummary(this.orgId, m.id, {
              startDate: sevenDayStartIso,
              endDate: endIso,
              groupBy: 'source',
            }).then((resp) => ({ m, resp })),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            pushLog(this.transformUsageSummary(
              'usage.member_summary_by_source',
              r.value.m,
              'source',
              r.value.resp,
              sevenDayStartIso,
              endIso,
              reportTs,
            ));
          } else {
            this.logger.warn('member summary by source failed', {
              error: redact(String(r.reason)),
            });
          }
        }
      }
    }

    // 7. Per-member usage summary (groupBy=operation, <= 7 day window)
    if (members.length > 0) {
      for (let i = 0; i < members.length; i += MEMBER_CONCURRENCY) {
        const batch = members.slice(i, i + MEMBER_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((m) =>
            this.client.getMemberUsageSummary(this.orgId, m.id, {
              startDate: sevenDayStartIso,
              endDate: endIso,
              groupBy: 'operation',
            }).then((resp) => ({ m, resp })),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            pushLog(this.transformUsageSummary(
              'usage.member_summary_by_operation',
              r.value.m,
              'operation',
              r.value.resp,
              sevenDayStartIso,
              endIso,
              reportTs,
            ));
          } else {
            this.logger.warn('member summary by operation failed', {
              error: redact(String(r.reason)),
            });
          }
        }
      }
    }

    // 8. Org resource packages
    try {
      const pkgLogs = await this.fetchAllResourcePackages(reportTs);
      for (const l of pkgLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('listResourcePackages', err) && advanceWindow;
    }

    // 9. Org seat-month batches (third-party only; 404 is OK)
    try {
      const batchLogs = await this.fetchAllSeatMonthBatches(reportTs);
      for (const l of batchLogs) pushLog(l);
    } catch (err) {
      if (err instanceof QoderApiHttpError && err.status === 404) {
        this.logger.debug('seat-month-batches not applicable to this org', {});
      } else {
        advanceWindow = this.handleCycleError('listSeatMonthBatches', err) && advanceWindow;
      }
    }

    // 10. AI code stats overview (<= 90 day window)
    try {
      const overview = await this.client.getAiCodeStatsOverview(this.orgId, {
        startDate: ninetyDayStartIso,
        endDate: endIso,
      });
      pushLog(this.transformStatsOverview(overview, ninetyDayStartIso, endIso, reportTs));
    } catch (err) {
      advanceWindow = this.handleCycleError('aiCodeStatsOverview', err) && advanceWindow;
    }

    // 11. AI code daily trend (<= 90 day window)
    try {
      const trend = await this.client.getAiCodeDailyTrend(this.orgId, {
        startDate: ninetyDayStartIso,
        endDate: endIso,
      });
      const trendLogs = this.transformDailyTrend(trend, ninetyDayStartIso, endIso, reportTs);
      for (const l of trendLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('aiCodeDailyTrend', err) && advanceWindow;
    }

    // 12. AI code member ranking (<= 90 day window)
    try {
      const ranking = await this.client.getAiCodeMemberRanking(this.orgId, {
        startDate: ninetyDayStartIso,
        endDate: endIso,
        limit: 100,
      });
      const rankingLogs = this.transformMemberRanking(ranking, ninetyDayStartIso, endIso, reportTs);
      for (const l of rankingLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('aiCodeMemberRanking', err) && advanceWindow;
    }

    // 13. AI code repos (paginated by page/per_page)
    try {
      const repoLogs = await this.fetchAllAiCodeRepos(ninetyDayStartIso, endIso, reportTs);
      for (const l of repoLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('aiCodeRepos', err) && advanceWindow;
    }

    // 14. AI code file extensions
    try {
      const extResp = await this.client.listAiCodeFileExtensions(this.orgId, {
        startDate: ninetyDayStartIso,
        endDate: endIso,
      });
      const extLogs = this.transformFileExtensions(extResp, ninetyDayStartIso, endIso, reportTs);
      for (const l of extLogs) pushLog(l);
    } catch (err) {
      advanceWindow = this.handleCycleError('aiCodeFileExtensions', err) && advanceWindow;
    }

    // 15. (Sending handled by pipeline, not here)

    // 16. Store pending window end — actual advancement happens in confirmCycle()
    //     after the pipeline confirms SLS delivery.
    this.pendingWindowEnd = advanceWindow ? endIso : null;

    this.logger.info('qoder-api cycle done', {
      windowStart: startIso,
      windowEnd: endIso,
      members: members.length,
      logs: logs.length,
      counts,
      advanced: advanceWindow,
      elapsedMs: Date.now() - startedAt,
    });

    return logs;
  }

  // ---------- fetch helpers ----------

  private async fetchAllMembers(): Promise<QoderMember[]> {
    const out: QoderMember[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const resp = await this.client.listMembers(this.orgId, {
        nextToken,
        maxResults: 100,
      });
      if (Array.isArray(resp.members)) {
        for (const m of resp.members) {
          if (m.status && m.status !== 'ENABLED') continue;
          out.push(m);
        }
      }
      nextToken = resp.nextToken && resp.nextToken !== '' ? resp.nextToken : undefined;
      if (!nextToken) break;
    }
    return out;
  }

  private async fetchMemberData(
    member: QoderMember,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];

    // Usage events (paginated by nextCredits)
    let nextCredits: string | undefined;
    let memberEventIndex = 0;
    for (let page = 0; page < MAX_OFFSET_PAGES; page++) {
      const resp: ListUsageEventsResponse = await this.client.listMemberUsageEvents(
        this.orgId,
        member.id,
        {
          startDate: startIso,
          endDate: endIso,
          maxResults: 100,
          nextCredits,
        },
      );
      const usages = resp.usages ?? [];
      for (const u of usages) {
        out.push(this.transformUsageEvent(u, member, startIso, endIso, reportTs, memberEventIndex++));
      }
      nextCredits =
        resp.nextCredits && resp.nextCredits !== '' ? resp.nextCredits : undefined;
      if (!nextCredits) break;
    }

    // Quota snapshot (single call)
    try {
      const quota = await this.client.getMemberQuota(this.orgId, member.id);
      out.push(this.transformQuotaSnapshot(quota, member, startIso, endIso, reportTs));
    } catch (err) {
      this.logger.warn('quota fetch failed (continuing)', {
        memberId: member.id,
        error: redact(String(err)),
      });
    }
    return out;
  }

  private async fetchAllChanges(
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    for (let page = 1; page <= MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listAiCodeChanges(this.orgId, {
        startDate: startIso,
        endDate: endIso,
        page,
        pageSize: 200,
      });
      const items = resp.data?.items ?? [];
      for (const c of items) {
        out.push(this.transformChange(c, startIso, endIso, reportTs));
      }
      const total = resp.data?.pagination?.totalPages ?? 1;
      if (page >= total || items.length === 0) break;
    }
    return out;
  }

  private async fetchAllCommits(
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    for (let page = 1; page <= MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listAiCodeCommits(this.orgId, {
        startDate: startIso,
        endDate: endIso,
        page,
        pageSize: 200,
      });
      const items = resp.data?.items ?? [];
      for (const c of items) {
        out.push(this.transformCommit(c, startIso, endIso, reportTs));
      }
      const total = resp.data?.pagination?.totalPages ?? 1;
      if (page >= total || items.length === 0) break;
    }
    return out;
  }

  private async fetchAllOrgUsageEvents(
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    let nextToken: string | undefined;
    let orgEventIndex = 0;
    for (let page = 0; page < MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listOrgUsageEvents(this.orgId, {
        startDate: startIso,
        endDate: endIso,
        maxResults: 100,
        nextToken,
      });
      const usages = resp.usages ?? [];
      for (const u of usages) {
        out.push(this.transformOrgUsageEvent(u, startIso, endIso, reportTs, orgEventIndex++));
      }
      nextToken = resp.nextToken && resp.nextToken !== '' ? resp.nextToken : undefined;
      if (!nextToken) break;
    }
    return out;
  }

  private async fetchAllResourcePackages(
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listResourcePackages(this.orgId, {
        maxResults: 100,
        nextToken,
      });
      const items = resp.resourcePackages ?? [];
      for (const p of items) {
        out.push(this.transformResourcePackage(p, reportTs));
      }
      nextToken = resp.nextToken && resp.nextToken !== '' ? resp.nextToken : undefined;
      if (!nextToken) break;
    }
    return out;
  }

  private async fetchAllSeatMonthBatches(
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listSeatMonthBatches(this.orgId, {
        pageSize: 100,
        pageToken,
      });
      const items = resp.seatMonthBatches ?? [];
      for (const b of items) {
        out.push(this.transformSeatMonthBatch(b, reportTs));
      }
      pageToken = resp.nextToken && resp.nextToken !== '' ? resp.nextToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  private async fetchAllAiCodeRepos(
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Promise<Record<string, string>[]> {
    const out: Record<string, string>[] = [];
    for (let page = 1; page <= MAX_OFFSET_PAGES; page++) {
      const resp = await this.client.listAiCodeRepos(this.orgId, {
        startDate: startIso,
        endDate: endIso,
        page,
        perPage: 100,
      });
      const items = resp.repos ?? [];
      for (const r of items) {
        out.push(this.transformAiCodeRepo(r, startIso, endIso, reportTs));
      }
      const totalCount = resp.totalCount ?? 0;
      const perPage = resp.perPage ?? 100;
      if (items.length === 0 || page * perPage >= totalCount) break;
    }
    return out;
  }

  // ---------- transformers ----------

  private transformUsageEvent(
    u: QoderUsageEvent,
    member: QoderMember,
    startIso: string,
    endIso: string,
    reportTs: string,
    index: number,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'usage.member_event',
      org_id: this.orgId,
      member_id: member.id ?? '',
      member_email: member.email ?? u.userEmail ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(u),
    };
    setIfPresent(log, 'event_ts_ms', u.timestamp);
    setIfPresent(log, 'source', u.source);
    setIfPresent(log, 'operation', u.operation);
    setIfPresent(log, 'model_tier', u.modelTier);
    setIfPresent(log, 'credits', u.credits);
    setIfPresent(log, 'cost', u.cost);
    log.event_id = sha256([
      'usage.member_event',
      this.orgId,
      member.id ?? '',
      String(u.timestamp ?? ''),
      u.source ?? '',
      u.operation ?? '',
      u.modelTier ?? '',
      String(u.credits ?? ''),
      String(index),
    ]);
    return log;
  }

  private transformQuotaSnapshot(
    q: QoderQuotaResponse,
    member: QoderMember,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'usage.member_quota',
      org_id: this.orgId,
      member_id: member.id ?? '',
      member_email: member.email ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(q),
    };
    setIfPresent(log, 'quota_key', q.quotaKey);
    setIfPresent(log, 'total_used', q.totalQuota?.quotaSummary?.usedValue);
    setIfPresent(log, 'total_limit', q.totalQuota?.quotaSummary?.limitValue);
    setIfPresent(log, 'plan_used', q.planQuota?.quotaSummary?.usedValue);
    setIfPresent(log, 'plan_limit', q.planQuota?.quotaSummary?.limitValue);
    setIfPresent(log, 'pack_used', q.resourcePackageQuota?.quotaSummary?.usedValue);
    setIfPresent(log, 'pack_limit', q.resourcePackageQuota?.quotaSummary?.limitValue);
    setIfPresent(log, 'shared_used', q.sharedQuota?.quotaSummary?.usedValue);
    setIfPresent(log, 'shared_limit', q.sharedQuota?.quotaSummary?.limitValue);
    setIfPresent(log, 'quota_status', q.status);
    setIfPresent(log, 'last_reset_at', q.lastResetAt);
    setIfPresent(log, 'next_reset_at', q.nextResetAt);
    log.event_id = sha256([
      'usage.member_quota',
      this.orgId,
      member.id ?? '',
      endIso.slice(0, 10),
    ]);
    return log;
  }

  private transformChange(
    c: QoderChangeItem,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'code.tracking_change',
      org_id: this.orgId,
      member_id: c.userId ?? '',
      member_email: c.userEmail ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(c),
    };
    setIfPresent(log, 'change_id', c.changeId);
    setIfPresent(log, 'change_source', c.source);
    setIfPresent(log, 'model', c.model);
    setIfPresent(log, 'lines_added', c.totalLinesAdded);
    setIfPresent(log, 'lines_deleted', c.totalLinesDeleted);
    setIfPresent(log, 'created_at', c.createdAt);
    if (Array.isArray(c.metadata)) {
      log.metadata_json = safeStringify(c.metadata);
    }
    log.event_id = sha256([
      'code.tracking_change',
      this.orgId,
      c.changeId ?? '',
      c.userId ?? '',
      c.createdAt ?? '',
    ]);
    return log;
  }

  private transformCommit(
    c: QoderCommitItem,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'code.tracking_commit',
      org_id: this.orgId,
      member_id: c.userId ?? '',
      member_email: c.userEmail ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(c),
    };
    setIfPresent(log, 'commit_hash', c.commitHash);
    setIfPresent(log, 'repo_name', c.repoName);
    setIfPresent(log, 'branch_name', c.branchName);
    setIfPresent(log, 'is_primary_branch', c.isPrimaryBranch);
    setIfPresent(log, 'total_added', c.totalLinesAdded);
    setIfPresent(log, 'total_deleted', c.totalLinesDeleted);
    setIfPresent(log, 'non_ai_added', c.nonAiLinesAdded);
    setIfPresent(log, 'non_ai_deleted', c.nonAiLinesDeleted);
    setIfPresent(log, 'ide_next_added', c.ideNextLinesAdded);
    setIfPresent(log, 'ide_next_deleted', c.ideNextLinesDeleted);
    setIfPresent(log, 'plugin_next_added', c.pluginNextLinesAdded);
    setIfPresent(log, 'plugin_next_deleted', c.pluginNextLinesDeleted);
    setIfPresent(log, 'ide_agent_added', c.ideAgentLinesAdded);
    setIfPresent(log, 'ide_agent_deleted', c.ideAgentLinesDeleted);
    setIfPresent(log, 'plugin_agent_added', c.pluginAgentLinesAdded);
    setIfPresent(log, 'plugin_agent_deleted', c.pluginAgentLinesDeleted);
    setIfPresent(log, 'cli_agent_added', c.cliAgentLinesAdded);
    setIfPresent(log, 'cli_agent_deleted', c.cliAgentLinesDeleted);
    setIfPresent(log, 'ide_quest_added', c.ideQuestLinesAdded);
    setIfPresent(log, 'ide_quest_deleted', c.ideQuestLinesDeleted);
    setIfPresent(log, 'ide_inline_chat_added', c.ideInlineChatLinesAdded);
    setIfPresent(log, 'ide_inline_chat_deleted', c.ideInlineChatLinesDeleted);
    setIfPresent(log, 'jb_inline_chat_added', c.jbInlineChatLinesAdded);
    setIfPresent(log, 'jb_inline_chat_deleted', c.jbInlineChatLinesDeleted);
    setIfPresent(log, 'commit_ts', c.commitTs);
    setIfPresent(log, 'commit_message', c.message);
    log.event_id = sha256([
      'code.tracking_commit',
      this.orgId,
      c.commitHash ?? '',
      c.userId ?? '',
      c.commitTs ?? '',
    ]);
    return log;
  }

  private transformOrgUsageEvent(
    u: QoderUsageEvent,
    startIso: string,
    endIso: string,
    reportTs: string,
    index: number,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'usage.org_event',
      org_id: this.orgId,
      member_id: u.userId ?? '',
      member_email: u.userEmail ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(u),
    };
    setIfPresent(log, 'event_ts_ms', u.timestamp);
    setIfPresent(log, 'source', u.source);
    setIfPresent(log, 'operation', u.operation);
    setIfPresent(log, 'model_tier', u.modelTier);
    setIfPresent(log, 'credits', u.credits);
    setIfPresent(log, 'cost', u.cost);
    log.event_id = sha256([
      'usage.org_event',
      this.orgId,
      u.userId ?? '',
      String(u.timestamp ?? ''),
      u.source ?? '',
      u.operation ?? '',
      u.modelTier ?? '',
      String(u.credits ?? ''),
      String(index),
    ]);
    return log;
  }

  private transformUsageSummary(
    kind: string,
    member: QoderMember,
    groupBy: 'source' | 'operation',
    resp: { summary?: Record<string, number> },
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const summary = resp.summary ?? {};
    let total = 0;
    for (const v of Object.values(summary)) {
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    const log: Record<string, string> = {
      kind,
      org_id: this.orgId,
      member_id: member.id ?? '',
      member_email: member.email ?? '',
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(resp),
      group_by: groupBy,
      summary_json: safeStringify(summary),
      total_credits: String(total.toFixed(4)),
      group_count: String(Object.keys(summary).length),
    };
    log.event_id = sha256([kind, this.orgId, member.id ?? '', endIso.slice(0, 10)]);
    return log;
  }

  private transformResourcePackage(
    p: Record<string, unknown>,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'usage.org_resource_package',
      org_id: this.orgId,
      report_ts: reportTs,
      raw_json: safeStringify(p),
    };
    setIfPresent(log, 'package_id', p.id);
    setIfPresent(log, 'package_name', p.name);
    setIfPresent(log, 'package_source', p.source);
    setIfPresent(log, 'package_status', p.status);
    setIfPresent(log, 'activated_at', p.activatedAt);
    setIfPresent(log, 'expires_at', p.expiresAt);
    setIfPresent(log, 'limit_value', p.limitValue);
    setIfPresent(log, 'used_value', p.usedValue);
    setIfPresent(log, 'remaining_value', p.remainingValue);
    setIfPresent(log, 'unit', p.unit);
    log.event_id = sha256([
      'usage.org_resource_package',
      this.orgId,
      String(p.id ?? ''),
      reportTs.slice(0, 10),
    ]);
    return log;
  }

  private transformSeatMonthBatch(
    b: Record<string, unknown>,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'usage.org_seat_month_batch',
      org_id: this.orgId,
      report_ts: reportTs,
      raw_json: safeStringify(b),
    };
    setIfPresent(log, 'batch_id', b.id);
    setIfPresent(log, 'redemption_code_id', b.redemptionCodeId);
    setIfPresent(log, 'batch_status', b.status);
    setIfPresent(log, 'source_channel', b.sourceChannel);
    setIfPresent(log, 'third_party_instance_id', b.thirdPartyInstanceId);
    setIfPresent(log, 'product_code', b.productCode);
    setIfPresent(log, 'report_required', b.reportRequired);
    setIfPresent(log, 'total_seat_months', b.totalSeatMonths);
    setIfPresent(log, 'used_seat_months', b.usedSeatMonths);
    setIfPresent(log, 'remaining_seat_months', b.remainingSeatMonths);
    setIfPresent(log, 'effective_at', b.effectiveAt);
    setIfPresent(log, 'expires_at', b.expiresAt);
    setIfPresent(log, 'created_at', b.createdAt);
    setIfPresent(log, 'updated_at', b.updatedAt);
    log.event_id = sha256([
      'usage.org_seat_month_batch',
      this.orgId,
      String(b.id ?? ''),
      reportTs.slice(0, 10),
    ]);
    return log;
  }

  private transformStatsOverview(
    o: Record<string, unknown>,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'code.stats_overview',
      org_id: this.orgId,
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(o),
    };
    setIfPresent(log, 'committed_total_lines_edit', o.committedTotalLinesEdit);
    setIfPresent(log, 'committed_ai_lines_edit', o.committedAiLinesEdit);
    setIfPresent(log, 'accepted_lines_edit', o.acceptedLinesEdit);
    setIfPresent(log, 'ai_share_rate', o.aiShareRate);
    setIfPresent(log, 'agent_edit_count', o.agentEditCount);
    setIfPresent(log, 'tab_completion_count', o.tabCompletionCount);
    setIfPresent(log, 'message_count', o.messageCount);
    log.event_id = sha256([
      'code.stats_overview',
      this.orgId,
      endIso.slice(0, 10),
    ]);
    return log;
  }

  private transformDailyTrend(
    trend: {
      items?: Array<Record<string, unknown>>;
      extItems?: Array<Record<string, unknown>>;
      nextItems?: Array<Record<string, unknown>>;
    },
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string>[] {
    const out: Record<string, string>[] = [];

    for (const it of trend.items ?? []) {
      const log: Record<string, string> = {
        kind: 'code.stats_daily_trend_share',
        org_id: this.orgId,
        window_start: startIso,
        window_end: endIso,
        report_ts: reportTs,
        raw_json: safeStringify(it),
      };
      setIfPresent(log, 'date', it.date);
      setIfPresent(log, 'ai_lines_added', it.aiLinesAdded);
      setIfPresent(log, 'other_lines_added', it.otherLinesAdded);
      setIfPresent(log, 'ai_share_rate', it.aiShareRate);
      setIfPresent(log, 'commit_count', it.commitCount);
      log.event_id = sha256([
        'code.stats_daily_trend_share',
        this.orgId,
        String(it.date ?? ''),
      ]);
      out.push(log);
    }

    for (const it of trend.extItems ?? []) {
      const log: Record<string, string> = {
        kind: 'code.stats_daily_trend_lang_ext',
        org_id: this.orgId,
        window_start: startIso,
        window_end: endIso,
        report_ts: reportTs,
        raw_json: safeStringify(it),
      };
      setIfPresent(log, 'date', it.date);
      setIfPresent(log, 'file_extension', it.fileExtension);
      setIfPresent(log, 'total_lines_added', it.totalLinesAdded);
      setIfPresent(log, 'ai_lines_added', it.aiLinesAdded);
      log.event_id = sha256([
        'code.stats_daily_trend_lang_ext',
        this.orgId,
        String(it.date ?? ''),
        String(it.fileExtension ?? ''),
      ]);
      out.push(log);
    }

    for (const it of trend.nextItems ?? []) {
      const log: Record<string, string> = {
        kind: 'code.stats_daily_trend_tab',
        org_id: this.orgId,
        window_start: startIso,
        window_end: endIso,
        report_ts: reportTs,
        raw_json: safeStringify(it),
      };
      setIfPresent(log, 'date', it.date);
      setIfPresent(log, 'next_suggested_count', it.nextSuggestedCount);
      setIfPresent(log, 'next_accepted_count', it.nextAcceptedCount);
      setIfPresent(log, 'next_accept_rate', it.nextAcceptRate);
      log.event_id = sha256([
        'code.stats_daily_trend_tab',
        this.orgId,
        String(it.date ?? ''),
      ]);
      out.push(log);
    }

    return out;
  }

  private transformMemberRanking(
    ranking: { items?: Array<Record<string, unknown>> },
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    for (const it of ranking.items ?? []) {
      const log: Record<string, string> = {
        kind: 'code.stats_member_ranking',
        org_id: this.orgId,
        member_id: typeof it.userId === 'string' ? it.userId : '',
        member_email: typeof it.email === 'string' ? it.email : '',
        window_start: startIso,
        window_end: endIso,
        report_ts: reportTs,
        raw_json: safeStringify(it),
      };
      setIfPresent(log, 'display_name', it.displayName);
      setIfPresent(log, 'total_lines_added', it.totalLinesAdded);
      setIfPresent(log, 'ai_lines_added', it.aiLinesAdded);
      setIfPresent(log, 'ai_share_rate', it.aiShareRate);
      setIfPresent(log, 'commit_count', it.commitCount);
      log.event_id = sha256([
        'code.stats_member_ranking',
        this.orgId,
        String(it.userId ?? ''),
        endIso.slice(0, 10),
      ]);
      out.push(log);
    }
    return out;
  }

  private transformAiCodeRepo(
    r: Record<string, unknown>,
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string> {
    const log: Record<string, string> = {
      kind: 'code.stats_repo',
      org_id: this.orgId,
      window_start: startIso,
      window_end: endIso,
      report_ts: reportTs,
      raw_json: safeStringify(r),
    };
    setIfPresent(log, 'repo_name', r.repoName);
    setIfPresent(log, 'commit_count', r.commitCount);
    setIfPresent(log, 'total_lines_added', r.totalLinesAdded);
    log.event_id = sha256([
      'code.stats_repo',
      this.orgId,
      String(r.repoName ?? ''),
      endIso.slice(0, 10),
    ]);
    return log;
  }

  private transformFileExtensions(
    resp: { fileExtensions?: Array<Record<string, unknown>> },
    startIso: string,
    endIso: string,
    reportTs: string,
  ): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    for (const e of resp.fileExtensions ?? []) {
      const log: Record<string, string> = {
        kind: 'code.stats_file_extension',
        org_id: this.orgId,
        window_start: startIso,
        window_end: endIso,
        report_ts: reportTs,
        raw_json: safeStringify(e),
      };
      setIfPresent(log, 'extension', e.extension);
      setIfPresent(log, 'change_count', e.changeCount);
      setIfPresent(log, 'total_lines_added', e.totalLinesAdded);
      setIfPresent(log, 'ai_share_rate', e.aiShareRate);
      log.event_id = sha256([
        'code.stats_file_extension',
        this.orgId,
        String(e.extension ?? ''),
        endIso.slice(0, 10),
      ]);
      out.push(log);
    }
    return out;
  }

  // ---------- state helpers ----------

  private getWindowState(): WindowState {
    const raw = this.stateStore.get('qoder-api-window');
    const extra = raw.extra as WindowState | undefined;
    return extra ?? {};
  }

  private setWindowState(next: WindowState): void {
    this.stateStore.update('qoder-api-window', {
      extra: { ...this.getWindowState(), ...next },
    });
  }

  private handleCycleError(stage: string, err: unknown): boolean {
    const message = redact(String(err));
    if (err instanceof QoderApiHttpError && (err.status === 401 || err.status === 403)) {
      this.fatalAuthError = true;
      this.logger.error('qoder-api authentication failed; halting input', {
        stage,
        status: err.status,
        message,
      });
      return false;
    }
    this.logger.warn('qoder-api stage failed', { stage, error: message });
    return false;
  }
}

// ---------- module-level helpers ----------

function setIfPresent(
  log: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    if (value.length === 0) return;
    log[key] = value;
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return;
    log[key] = String(value);
    return;
  }
  if (typeof value === 'boolean') {
    log[key] = value ? 'true' : 'false';
    return;
  }
  log[key] = safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sha256(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => p ?? '').join('\0'))
    .digest('hex');
}

function redact(s: string): string {
  return s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}
