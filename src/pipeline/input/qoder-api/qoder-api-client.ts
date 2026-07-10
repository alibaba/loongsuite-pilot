import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('QoderApiClient');

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class QoderApiHttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`Qoder API ${status} ${url}: ${body.slice(0, 256)}`);
  }
}

export interface QoderMember {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  joinedAt?: string;
  deletedAt?: string;
  [key: string]: unknown;
}

export interface ListMembersResponse {
  members: QoderMember[];
  maxResults?: number;
  nextToken?: string;
}

export interface QoderUsageEvent {
  timestamp: number;
  userId?: string;
  userEmail?: string;
  source?: string;
  operation?: string;
  modelTier?: string;
  credits?: number;
  cost?: number;
  [key: string]: unknown;
}

export interface ListUsageEventsResponse {
  usages: QoderUsageEvent[];
  maxResults?: number;
  nextCredits?: string;
  nextToken?: string;
}

export interface QoderQuotaSummary {
  usedValue?: number;
  limitValue?: number;
  unit?: string;
}

export interface QoderQuotaBlock {
  quotaSummary?: QoderQuotaSummary;
  [key: string]: unknown;
}

export interface QoderQuotaResponse {
  userId?: string;
  quotaKey?: string;
  planQuota?: QoderQuotaBlock;
  resourcePackageQuota?: QoderQuotaBlock | null;
  totalQuota?: QoderQuotaBlock;
  sharedQuota?: QoderQuotaBlock | null;
  lastResetAt?: string;
  nextResetAt?: string;
  status?: string;
  [key: string]: unknown;
}

export interface QoderChangeMetadata {
  fileName?: string;
  fileExtension?: string;
  linesAdded?: number;
  linesDeleted?: number;
}

export interface QoderChangeItem {
  changeId?: string;
  userId?: string;
  userEmail?: string;
  source?: string;
  model?: string;
  totalLinesAdded?: number;
  totalLinesDeleted?: number;
  metadata?: QoderChangeMetadata[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface QoderPagination {
  currentPage?: number;
  pageSize?: number;
  totalItems?: number;
  totalPages?: number;
}

export interface ListChangesResponse {
  success?: boolean;
  data?: {
    items?: QoderChangeItem[];
    pagination?: QoderPagination;
  };
}

export interface QoderCommitItem {
  commitHash?: string;
  userId?: string;
  userEmail?: string;
  repoName?: string;
  branchName?: string;
  isPrimaryBranch?: boolean;
  totalLinesAdded?: number;
  totalLinesDeleted?: number;
  ideNextLinesAdded?: number;
  ideNextLinesDeleted?: number;
  pluginNextLinesAdded?: number;
  pluginNextLinesDeleted?: number;
  ideAgentLinesAdded?: number;
  ideAgentLinesDeleted?: number;
  pluginAgentLinesAdded?: number;
  pluginAgentLinesDeleted?: number;
  cliAgentLinesAdded?: number;
  cliAgentLinesDeleted?: number;
  ideQuestLinesAdded?: number;
  ideQuestLinesDeleted?: number;
  ideInlineChatLinesAdded?: number;
  ideInlineChatLinesDeleted?: number;
  jbInlineChatLinesAdded?: number;
  jbInlineChatLinesDeleted?: number;
  nonAiLinesAdded?: number;
  nonAiLinesDeleted?: number;
  message?: string;
  commitTs?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface ListCommitsResponse {
  success?: boolean;
  data?: {
    items?: QoderCommitItem[];
    pagination?: QoderPagination;
  };
}

export interface QoderApiClientOptions {
  apiBase: string;
  apiKey: string;
  orgId: string;
  timeoutMs?: number;
}

/**
 * Qoder OpenAPI client for the pipeline input.
 * - Bearer auth via private apiKey (never exposed via getter or logged)
 * - Built-in exponential backoff for 5xx/429/network errors (3 attempts: 1s/2s/4s)
 * - 4xx errors thrown immediately so the caller can decide to halt
 */
export class QoderApiClient {
  readonly apiBase: string;
  readonly orgId: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: QoderApiClientOptions) {
    if (!opts.apiKey) throw new Error('QoderApiClient: apiKey is required');
    if (!opts.apiBase) throw new Error('QoderApiClient: apiBase is required');
    if (!opts.orgId) throw new Error('QoderApiClient: orgId is required');
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.orgId = opts.orgId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listMembers(
    orgId: string,
    opts: { nextToken?: string; maxResults?: number; includeDeleted?: boolean } = {},
  ): Promise<ListMembersResponse> {
    const query = this.toQuery({
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
      includeDeleted: opts.includeDeleted ? 'true' : undefined,
    });
    return this.request<ListMembersResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members${query}`,
    );
  }

  async listMemberUsageEvents(
    orgId: string,
    memberId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      maxResults?: number;
      nextCredits?: string;
    } = {},
  ): Promise<ListUsageEventsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      maxResults: opts.maxResults ?? 100,
      nextCredits: opts.nextCredits,
    });
    return this.request<ListUsageEventsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/usage-events${query}`,
    );
  }

  async getMemberQuota(
    orgId: string,
    memberId: string,
  ): Promise<QoderQuotaResponse> {
    return this.request<QoderQuotaResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/quota`,
    );
  }

  async listAiCodeChanges(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      page?: number;
      pageSize?: number;
      source?: string;
      userId?: string;
      userEmail?: string;
    } = {},
  ): Promise<ListChangesResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      page: opts.page,
      pageSize: opts.pageSize ?? 200,
      source: opts.source,
      userId: opts.userId,
      userEmail: opts.userEmail,
    });
    return this.request<ListChangesResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code-tracking/changes${query}`,
    );
  }

  async listAiCodeCommits(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      page?: number;
      pageSize?: number;
      repoName?: string;
      userId?: string;
      userEmail?: string;
    } = {},
  ): Promise<ListCommitsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      page: opts.page,
      pageSize: opts.pageSize ?? 200,
      repoName: opts.repoName,
      userId: opts.userId,
      userEmail: opts.userEmail,
    });
    return this.request<ListCommitsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code-tracking/commits${query}`,
    );
  }

  /** GET /v1/organizations/{org}/usage-events — organization-wide usage events */
  async listOrgUsageEvents(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      sources?: string;
      operations?: string;
      modelTiers?: string;
      maxResults?: number;
      nextToken?: string;
    } = {},
  ): Promise<ListUsageEventsResponse> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      sources: opts.sources,
      operations: opts.operations,
      modelTiers: opts.modelTiers,
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
    });
    return this.request<ListUsageEventsResponse>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/usage-events${query}`,
    );
  }

  /** GET /v1/organizations/{org}/members/{id}/usage-summary?groupBy=source|operation */
  async getMemberUsageSummary(
    orgId: string,
    memberId: string,
    opts: { startDate: string; endDate: string; groupBy: 'source' | 'operation' },
  ): Promise<{ summary?: Record<string, number> }> {
    const query = this.toQuery({
      startDate: opts.startDate,
      endDate: opts.endDate,
      groupBy: opts.groupBy,
    });
    return this.request<{ summary?: Record<string, number> }>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/usage-summary${query}`,
    );
  }

  /** GET /v1/organizations/{org}/resource-packages */
  async listResourcePackages(
    orgId: string,
    opts: {
      status?: string;
      orderBy?: string;
      order?: string;
      maxResults?: number;
      nextToken?: string;
    } = {},
  ): Promise<{
    resourcePackages?: Array<Record<string, unknown>>;
    maxResults?: number;
    nextToken?: string;
  }> {
    const query = this.toQuery({
      status: opts.status,
      orderBy: opts.orderBy,
      order: opts.order,
      maxResults: opts.maxResults ?? 100,
      nextToken: opts.nextToken,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/resource-packages${query}`,
    );
  }

  /** GET /v1/organizations/{org}/seat-month-batches (third-party purchases only) */
  async listSeatMonthBatches(
    orgId: string,
    opts: {
      status?: string;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<{
    seatMonthBatches?: Array<Record<string, unknown>>;
    pageSize?: number;
    nextToken?: string;
  }> {
    const query = this.toQuery({
      status: opts.status,
      pageSize: opts.pageSize ?? 100,
      pageToken: opts.pageToken,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/seat-month-batches${query}`,
    );
  }

  /** GET /v1/organizations/{org}/ai-code/stats/overview */
  async getAiCodeStatsOverview(
    orgId: string,
    opts: { startDate: string; endDate: string; repoName?: string; primaryBranchOnly?: boolean },
  ): Promise<Record<string, unknown>> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      repo_name: opts.repoName,
      primary_branch_only: opts.primaryBranchOnly ? 'true' : undefined,
    });
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/overview${query}`,
    );
  }

  /** GET /v1/organizations/{org}/ai-code/stats/daily-trend */
  async getAiCodeDailyTrend(
    orgId: string,
    opts: { startDate: string; endDate: string; repoName?: string; primaryBranchOnly?: boolean },
  ): Promise<{
    items?: Array<Record<string, unknown>>;
    extItems?: Array<Record<string, unknown>>;
    nextItems?: Array<Record<string, unknown>>;
  }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      repo_name: opts.repoName,
      primary_branch_only: opts.primaryBranchOnly ? 'true' : undefined,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/daily-trend${query}`,
    );
  }

  /** GET /v1/organizations/{org}/ai-code/stats/member-ranking */
  async getAiCodeMemberRanking(
    orgId: string,
    opts: { startDate: string; endDate: string; limit?: number },
  ): Promise<{ items?: Array<Record<string, unknown>> }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      limit: opts.limit ?? 100,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/stats/member-ranking${query}`,
    );
  }

  /** GET /v1/organizations/{org}/ai-code/repos */
  async listAiCodeRepos(
    orgId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      query?: string;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<{
    repos?: Array<Record<string, unknown>>;
    totalCount?: number;
    page?: number;
    perPage?: number;
  }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
      query: opts.query,
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/repos${query}`,
    );
  }

  /** GET /v1/organizations/{org}/ai-code/file-extensions */
  async listAiCodeFileExtensions(
    orgId: string,
    opts: { startDate?: string; endDate?: string } = {},
  ): Promise<{ fileExtensions?: Array<Record<string, unknown>> }> {
    const query = this.toQuery({
      start_date: opts.startDate,
      end_date: opts.endDate,
    });
    return this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(orgId)}/ai-code/file-extensions${query}`,
    );
  }

  private toQuery(params: Record<string, string | number | boolean | undefined>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length === 0 ? '' : `?${parts.join('&')}`;
  }

  private async request<T>(method: string, pathAndQuery: string): Promise<T> {
    const url = `${this.apiBase}${pathAndQuery}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const resp = await fetch(url, {
          method,
          headers: {
            // Authorization header value never logged.
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const err = new QoderApiHttpError(resp.status, url, text);
          if (
            !RETRYABLE_STATUS_CODES.has(resp.status) ||
            attempt === RETRY_MAX_ATTEMPTS - 1
          ) {
            throw err;
          }
          lastErr = err;
        } else {
          const json = (await resp.json()) as T;
          logger.debug('qoder api ok', {
            method,
            path: pathAndQuery,
            elapsedMs: Date.now() - startedAt,
          });
          return json;
        }
      } catch (err) {
        if (err instanceof QoderApiHttpError && !RETRYABLE_STATUS_CODES.has(err.status)) {
          throw err;
        }
        lastErr = err;
        if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn('qoder api retrying', {
        method,
        path: pathAndQuery,
        attempt: attempt + 1,
        delayMs: delay,
        error: redactError(lastErr),
      });
      await sleep(delay);
    }

    throw lastErr;
  }
}

function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Defensive: ensure no Authorization header value sneaks through.
  return msg.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
