import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatTime } from '../utils/time-utils.js';
import { resolveLocalIp } from '../utils/network-utils.js';
import { checkProcessLiveness, UPDATER_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import { createLogger } from '../utils/logger.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import type { AgentsConfig, SlsEndpoint } from '../types/index.js';

const logger = createLogger('MetricsCollector');

const MIN_NODE_MAJOR = 18;

export interface L1Metrics {
  version: string;
  os_detail: string;
  hostname: string;
  ip: string;
  instance_id: string;
  run_id: string;
  user_id: string;
  pid: number;
  cpu: string;
  mem: string;
  mem_heap: string;
  start_time: string;
  capture_message_disabled_agents: string;
  projects: string;
  cms_workspace: string;
  metric_json: {
    // Cached logical file sizes; sampled_at identifies the last complete scan.
    disk_data_bytes?: string;
    disk_logs_bytes?: string;
    disk_dir_sampled_at?: string;
    disk_dir_scan_ms?: string;
    disk_dir_status?: string;
    // Agent-dimensioned, not input-dimensioned: how many agents this host has
    // installed, and how many of those have ever produced data in this run.
    agent_count: string;
    active_agent_count: string;
    open_fd: string;
    /** Length of the window the flow values below cover. */
    window_ms: string;
    // The instance's whole-process volume, not one leg of it. This pair is what
    // a billing view aggregates, so read the asymmetry deliberately:
    //
    //   in_*  = what this pilot ingested — events collected from the installed
    //           agents, sized on the normalized entry before masking. Counted
    //           once per event no matter how many backends it later reaches.
    //   out_* = what this pilot actually wrote to its backends, summed over
    //           every destination (the pilot_pipeline flusher rows carry the
    //           per-destination split). One event fanned out to two endpoints
    //           counts twice here, because two writes happened.
    //
    // So out_events > in_events is normal under fan-out, and the two sides count
    // different units (agent events vs. SLS entries / OTLP spans). Both are
    // per-window values, drained on every report — SUM them over a time range,
    // never diff them.
    //
    // out_bytes is deliberately mixed-basis: it sums measured SLS payload bytes
    // with estimated OTLP span bytes, because the instance total has to cover
    // every destination. For a number that is only real bytes, sum out_bytes over
    // the flusher rows with bytes_basis = 'measured' instead.
    /** Raw file records presented to parsing/transformation in this window. */
    raw_in_records: string;
    /** Checkpointed raw file bytes before parsing/transformation in this window. */
    raw_in_bytes: string;
    /** Process-lifetime maximum temporary raw file read buffer. */
    raw_in_max_batch_bytes: string;
    in_events: string;
    in_bytes: string;
    out_events: string;
    out_bytes: string;
    in_events_ps: string;
    in_bytes_ps: string;
    out_events_ps: string;
    out_bytes_ps: string;
  };
  init_type: string;
  rollback_available: string;
  canary_policy: string;
  version_count: string;
  updater_pid_alive: string;
  node_bin_valid: string;
  current_version_valid: string;
  __time__: number;
}

/**
 * Fields every L2 row carries, whatever its type. Repeating the identity on each
 * row is what lets the three types be queried independently — filter on `type`
 * and group by host or agent, with no join back to another topic.
 */
interface L2Identity {
  hostname: string;
  ip: string;
  instance_id: string;
  run_id: string;
  user_id: string;
  /** Length of the window every flow value in this row covers. */
  window_ms: string;
  __time__: number;
}

/**
 * One row per agent that is installed (has a running input) or carried data this
 * window — zeros included. Reporting the installed-but-silent ones is what makes
 * `idle_minutes` answerable: the agent an idle alarm cares about is by definition
 * the one with no traffic, and a traffic-gated row can never describe it. It
 * stays cheap because discovery only starts an input once it has detected the
 * agent on this host, so this is a handful of rows per cycle, not one per agent
 * the build knows about.
 *
 * Ingress only, by design. Egress cannot be attributed to an agent — the
 * flushers batch and fan out across all of them — so it lives on the flusher
 * rows. How many inputs back the agent is likewise not reported: several inputs
 * can serve one agent (qoder owns sqlite/trace/cli-hook/cli-session), which is a
 * collection detail, not an agent-dimensioned metric.
 */
export interface AgentFlowMetrics extends L2Identity {
  type: 'agent';
  agent: string;
  raw_in_records: string;
  raw_in_bytes: string;
  /** Current-window maximum across this agent's instrumented inputs. */
  raw_in_max_batch_bytes: string;
  in_events: string;
  in_bytes: string;
  /** Events this agent produced that the dispatch to the flushers rejected. */
  failed_events: string;
  /** State, not a window value. -1 when the agent has never been active. */
  idle_minutes: string;
  last_poll_time: string;
  start_time: string;
}

/** One bounded, payload-free row per running or active Input. */
export interface InputFlowMetrics extends L2Identity {
  type: 'input';
  agent: string;
  input_name: string;
  source_kind: 'primary';
  collection_method: string;
  raw_read_calls: string;
  raw_read_bytes: string;
  raw_in_records: string;
  raw_in_bytes: string;
  raw_in_max_batch_bytes: string;
  raw_in_max_record_bytes: string;
  raw_backlog_bytes_max: string;
  parse_success_records: string;
  parse_failed_records: string;
  read_duration_ms: string;
  process_duration_ms: string;
  in_events: string;
  in_bytes: string;
  failed_events: string;
}

/**
 * One row per destination, not per backend family: two SLS logstores are two
 * rows, and a billing view can attribute every byte to the project and logstore
 * it was written to. Emitted for every configured destination even at zero
 * traffic, so "configured but silent" is visible rather than absent.
 *
 * The entry / byte / delay values are per-window, so average flush latency for
 * the window is total_delay_ms / (out_entries + failed_entries) — both flushers
 * add elapsed time on the failure path too.
 */
export interface FlusherFlowMetrics extends L2Identity {
  type: 'flusher';
  /** Backend family: sls, cms or otlp. */
  flusher: string;
  /**
   * Where the bytes landed in SLS. Populated for sls and cms rows (a CMS
   * destination resolves to an ARMS project and its fixed trace logstore), empty
   * for a plain OTLP backend whose storage is not ours to name. `mode` is the SLS
   * transport and stays empty for both OTLP families.
   */
  project: string;
  logstore: string;
  mode: string;
  /** SLS log entries or OTLP spans, depending on the flusher. */
  in_entries: string;
  in_bytes: string;
  out_entries: string;
  /**
   * Bytes actually written to this destination in the window — the billable
   * half of the pair, and the per-destination split of L1's
   * metric_json.out_bytes. Read it together with `bytes_basis`.
   */
  out_bytes: string;
  /**
   * How in_bytes / out_bytes were obtained: 'measured' is the serialized payload
   * size (SLS), 'estimated' is a per-span heuristic (OTLP/CMS, where the exporter
   * never hands back a wire size). Published so a byte comparison across rows can
   * refuse to mix the two — an estimated row is good for trends, not for billing.
   */
  bytes_basis: BytesBasis;
  failed_entries: string;
  total_delay_ms: string;
  last_flush_time: string;
  start_time: string;
}

/**
 * One reporting cycle's L2 output: ingress per agent, egress per destination.
 * No instance-total row — it would be the exact sum of these rows over one
 * window, which the query engine can do, and L1's metric_json already carries
 * the same four axes plus agent_count for the instance.
 */
export interface L2Metrics {
  agents: AgentFlowMetrics[];
  inputs: InputFlowMetrics[];
  flushers: FlusherFlowMetrics[];
}

export interface FlusherStats {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outBytes: number;
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
}

/**
 * What the reporting needs from an input counter. The counter also tracks the
 * dispatch handoff (outEvents / outBytes); nothing reads it here, because for a
 * successful batch it equals the ingress byte for byte and real egress is
 * measured at the flushers.
 */
export interface InputStats {
  sourceKind: 'primary';
  rawReadCalls: number;
  rawReadBytes: number;
  rawInRecords: number;
  rawInBytes: number;
  rawInMaxBatchBytes: number;
  rawInMaxRecordBytes: number;
  rawBacklogBytesMax: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  readDurationMs: number;
  processDurationMs: number;
  inEvents: number;
  inBytes: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
}

/** Backend family a destination belongs to. */
export type FlusherKind = 'sls' | 'cms' | 'otlp';

/**
 * Where a destination's byte counts come from. SLS serializes the payload itself
 * and counts real bytes ('measured'); the OTLP exporter owns the encoding and
 * never reports a wire size, so those rows carry a per-span estimate
 * ('estimated'). Reported per row so the two are never silently added up.
 */
export type BytesBasis = 'measured' | 'estimated';

/**
 * One write destination and what it has written. project / logstore are filled
 * for sls and cms and empty for a plain OTLP backend, and `mode` is SLS-only.
 */
export interface FlusherEndpointStats extends FlusherStats {
  kind: FlusherKind;
  project: string;
  logstore: string;
  mode: string;
  bytesBasis: BytesBasis;
}

export interface DataflowSnapshot {
  /**
   * Instance ingress, summed over the inputs. There is no matching egress total:
   * what the instance actually wrote is the flusher side, so both levels take
   * out_* from `flushers` and nothing has to keep two answers in sync.
   */
  rawInRecordsTotal: number;
  rawInBytesTotal: number;
  /** Current-window maximum across all instrumented inputs. */
  rawInMaxBatchBytes: number;
  inEventsTotal: number;
  inBytesTotal: number;
  /**
   * Keyed by the fixed input id. Each entry produces an Input detail row while
   * running or when it carried data in the just-finished window. `agent` is the
   * owning agent (several inputs can map to one agent), and `running` means
   * discovery detected the agent on this host and started collecting.
   */
  inputs: Map<string, InputStats & { type: string; agent: string; running: boolean }>;
  /**
   * Keyed by destination id (`kind:name`), one entry per destination rather
   * than one per family: billing attributes bytes to a project and logstore, and
   * a merged family bucket cannot answer that.
   */
  flushers: Map<string, FlusherEndpointStats>;
  inputIdleMinutes: Map<string, number>;
}

export interface NodeBinDiagnostic {
  originalPath: string;
  pathExists: boolean;
  pathExecutable: boolean;
}

export interface InfraHealthSnapshot {
  updaterPidAlive: boolean;
  currentVersionValid: boolean;
  nodeBinValid: boolean;
  nodeBinDiagnostic?: NodeBinDiagnostic;
  rollbackAvailable: boolean;
  versionCount: number;
  canaryPolicy: string;
  updaterConsecutiveFailures: number;
}

/** Ingress axes tracked per input. */
interface FlowTotals {
  rawInRecords: number;
  rawInBytes: number;
  inEvents: number;
  inBytes: number;
  outFailed: number;
}

interface InputRuntimeTotals extends FlowTotals {
  rawReadCalls: number;
  rawReadBytes: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  readDurationMs: number;
  processDurationMs: number;
}

/**
 * L1's four axes. The two halves come from opposite ends of the pipeline —
 * ingress from the inputs, egress from the flushers — which is what makes the
 * pair describe the instance rather than one leg of it.
 */
interface InstanceFlow {
  rawInRecords: number;
  rawInBytes: number;
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outBytes: number;
}

/** Egress axes tracked per destination. */
interface FlusherTotals {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outBytes: number;
  outFailed: number;
  totalDelayMs: number;
}

function zeroFlowTotals(): FlowTotals {
  return { rawInRecords: 0, rawInBytes: 0, inEvents: 0, inBytes: 0, outFailed: 0 };
}

function zeroInputRuntimeTotals(): InputRuntimeTotals {
  return {
    ...zeroFlowTotals(),
    rawReadCalls: 0,
    rawReadBytes: 0,
    parseSuccessRecords: 0,
    parseFailedRecords: 0,
    readDurationMs: 0,
    processDurationMs: 0,
  };
}

function zeroFlusherTotals(): FlusherTotals {
  return { inEntries: 0, inBytes: 0, outEntries: 0, outBytes: 0, outFailed: 0, totalDelayMs: 0 };
}

/** L1's egress: every write this instance made, across all destinations. */
function sumFlusherEgress(snapshot: DataflowSnapshot): { events: number; bytes: number } {
  let events = 0;
  let bytes = 0;
  for (const stats of snapshot.flushers.values()) {
    events += stats.outEntries;
    bytes += stats.outBytes;
  }
  return { events, bytes };
}

/**
 * Window value for one axis: current cumulative reading minus what was already
 * reported. Clamped at 0 so a counter that somehow goes backwards (an endpoint
 * dropping out of a merged sink bucket, say) reports no traffic instead of a
 * negative spike.
 */
function delta(current: number, baseline: number): number {
  return Math.max(0, current - baseline);
}

/**
 * Everything is reported per agent, so every input resolves to one agent key.
 * The snapshot already resolves `agent` (map, else the input's agentType, else
 * its id); the id fallback here is only for a hand-built snapshot. Deliberately
 * never `type` — that is the collection method, not an agent.
 */
function agentKeyOf(inputId: string, stats: { agent: string }): string {
  return stats.agent || inputId;
}

/**
 * The agent-dimensioned pair both levels report, computed the same way so the
 * two topics can never disagree:
 *
 * - installed: agents with at least one running input. Discovery only starts an
 *   input after it detects the agent on this host, so running == installed.
 * - active: installed agents that have collected at least once in this run
 *   (idle_minutes >= 0). State, not a window value — an installed agent that
 *   simply sees no traffic this window stays active, and `active <= installed`
 *   always holds.
 *
 * Inputs never surface on their own: several of them can back one agent (qoder
 * owns sqlite/trace/cli-hook/cli-session), which is an internal detail.
 */
function countAgents(snapshot: DataflowSnapshot): { installed: number; active: number } {
  const installed = new Set<string>();
  const active = new Set<string>();
  for (const [inputId, stats] of snapshot.inputs) {
    if (!stats.running) continue;
    const agent = agentKeyOf(inputId, stats);
    installed.add(agent);
    if ((snapshot.inputIdleMinutes.get(inputId) ?? -1) >= 0) active.add(agent);
  }
  return { installed: installed.size, active: active.size };
}

export class MetricsCollector {
  private readonly version: string;
  private readonly userId: string;
  private readonly dataDir: string;
  private readonly canaryPolicy: string;
  private readonly agentsConfig: AgentsConfig;
  private readonly slsEndpoints: SlsEndpoint[];
  private readonly cmsWorkspace: string;
  private readonly autoUpdateEnabled: boolean;
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  private readonly startTime: string;
  private readonly startTimestamp: number;
  private readonly instanceId: string;
  private readonly runId: string;
  private readonly hostname: string;
  private readonly localIp: string;
  private readonly initType: string;

  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime = 0;
  private lastCollectTime = 0;
  private isFirstCpuSample = true;
  /**
   * Reported values are per-window deltas, so every flow counter needs a
   * "already reported up to here" baseline. The underlying input / flusher
   * counters stay monotonic (they are the source of truth and are read by other
   * code); subtracting a baseline here is what makes a reported row drain.
   *
   * L1 and L2 run on independent timers over the same snapshot, so they must
   * keep separate baselines — a shared one would let whichever fires first
   * swallow the other's window.
   */
  private l1Baseline: InstanceFlow = {
    rawInRecords: 0,
    rawInBytes: 0,
    inEvents: 0,
    inBytes: 0,
    outEvents: 0,
    outBytes: 0,
  };
  private l2InputBaseline: Map<string, FlowTotals> = new Map();
  private l2InputDetailBaseline: Map<string, InputRuntimeTotals> = new Map();
  private l2FlusherBaseline: Map<string, FlusherTotals> = new Map();
  private l2LastCollectTime = 0;
  private l1CycleCount = 0;
  private updaterConsecutiveFailures = 0;
  private lastInfraHealth: InfraHealthSnapshot | null = null;

  constructor(opts: { version: string; userId: string; dataDir: string; canaryPolicy?: string; agentsConfig?: AgentsConfig; slsEndpoints?: SlsEndpoint[]; cmsWorkspace?: string; autoUpdateEnabled?: boolean; updaterLiveness?: (pidFile: string) => ProcessLiveness }) {
    this.version = opts.version;
    this.userId = opts.userId;
    this.dataDir = opts.dataDir;
    this.canaryPolicy = opts.canaryPolicy ?? '';
    this.agentsConfig = opts.agentsConfig ?? {};
    this.slsEndpoints = opts.slsEndpoints ?? [];
    this.cmsWorkspace = opts.cmsWorkspace ?? '';
    // Omitted means "an updater is expected", the host default. Only a caller that knows
    // otherwise — the orchestrator, reading the resolved config — passes false.
    this.autoUpdateEnabled = opts.autoUpdateEnabled ?? true;
    this.updaterLiveness = opts.updaterLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, UPDATER_PROCESS_PATTERNS));
    this.startTimestamp = Math.floor(Date.now() / 1000);
    this.startTime = formatTime(new Date());
    this.localIp = resolveLocalIp();
    this.hostname = os.hostname();
    // Stable install identity: restart- and IP-invariant, independently derivable
    // by any process on the host. Includes dataDir so multiple installs on one
    // machine (e.g. several OS users, each with their own ~/.loongsuite-pilot) do
    // not collide when hostname and configured userId coincide. dataDir is
    // base64url-encoded (not plaintext) but remains reversible: strip the
    // `${hostname}_${userId}_` prefix and base64url-decode to recover the path.
    const dataDirEncoded = Buffer.from(opts.dataDir, 'utf8').toString('base64url');
    this.instanceId = `${this.hostname}_${opts.userId}_${dataDirEncoded}`;
    // Per-incarnation id: distinguishes runs / detects restarts.
    this.runId = `${this.instanceId}_${this.startTimestamp}`;
    this.initType = readInitType(opts.dataDir);
  }

  getUserId(): string {
    return this.userId;
  }

  collectL1(snapshot: DataflowSnapshot): L1Metrics {
    const now = Date.now();
    const cpuPercent = this.calcCpuPercent(now);
    const mem = process.memoryUsage();

    // Drain: report what flowed since the previous L1 row, then move the
    // baseline up. The window opens at process start for the very first row.
    // Ingress is the input side, egress the flusher side — deliberately not the
    // input-side dispatch count, which only says "handed to the fan-out" and is
    // byte-identical to ingress.
    const egress = sumFlusherEgress(snapshot);
    const cumulative: InstanceFlow = {
      rawInRecords: snapshot.rawInRecordsTotal,
      rawInBytes: snapshot.rawInBytesTotal,
      inEvents: snapshot.inEventsTotal,
      inBytes: snapshot.inBytesTotal,
      outEvents: egress.events,
      outBytes: egress.bytes,
    };
    const flow = {
      rawInRecords: delta(cumulative.rawInRecords, this.l1Baseline.rawInRecords),
      rawInBytes: delta(cumulative.rawInBytes, this.l1Baseline.rawInBytes),
      inEvents: delta(cumulative.inEvents, this.l1Baseline.inEvents),
      inBytes: delta(cumulative.inBytes, this.l1Baseline.inBytes),
      outEvents: delta(cumulative.outEvents, this.l1Baseline.outEvents),
      outBytes: delta(cumulative.outBytes, this.l1Baseline.outBytes),
    };
    this.l1Baseline = cumulative;

    const hasPriorRow = this.lastCollectTime !== 0;
    const windowMs = Math.max(0, now - (this.lastCollectTime || this.startTimestamp * 1000));
    const elapsedSec = Math.max(windowMs / 1000, 0.001);
    this.lastCollectTime = now;
    // The first row is emitted right at startup, so its window is a few
    // milliseconds wide — dividing by it turns any pre-existing count into a
    // meaningless spike. Report the values, leave the rates at 0; window_ms is
    // published so a consumer that wants its own rate can compute one.
    const rate = (value: number): string => (hasPriorRow ? (value / elapsedSec).toFixed(1) : '0.0');

    const agents = countAgents(snapshot);
    const health = this.collectInfraHealth();

    return {
      version: this.version,
      os_detail: `${os.type()}; ${os.release()}; ${os.arch()}`,
      hostname: os.hostname(),
      ip: this.localIp,
      instance_id: this.instanceId,
      run_id: this.runId,
      user_id: this.userId,
      pid: process.pid,
      cpu: String(cpuPercent),
      mem: String(Math.round(mem.rss / 1024 / 1024)),
      mem_heap: String(Math.round(mem.heapUsed / 1024 / 1024)),
      start_time: this.startTime,
      capture_message_disabled_agents: this.buildCaptureMessageDisabledAgents(),
      projects: this.buildProjects(),
      cms_workspace: this.buildCmsWorkspace(),
      metric_json: {
        agent_count: String(agents.installed),
        active_agent_count: String(agents.active),
        open_fd: String(getOpenFdCount()),
        window_ms: String(windowMs),
        raw_in_records: String(flow.rawInRecords),
        raw_in_bytes: String(flow.rawInBytes),
        raw_in_max_batch_bytes: String(snapshot.rawInMaxBatchBytes),
        in_events: String(flow.inEvents),
        in_bytes: String(flow.inBytes),
        out_events: String(flow.outEvents),
        out_bytes: String(flow.outBytes),
        in_events_ps: rate(flow.inEvents),
        in_bytes_ps: rate(flow.inBytes),
        out_events_ps: rate(flow.outEvents),
        out_bytes_ps: rate(flow.outBytes),
      },
      init_type: this.initType,
      rollback_available: String(health.rollbackAvailable),
      canary_policy: health.canaryPolicy,
      version_count: String(health.versionCount),
      updater_pid_alive: String(health.updaterPidAlive),
      node_bin_valid: String(health.nodeBinValid),
      current_version_valid: String(health.currentVersionValid),
      __time__: Math.floor(now / 1000),
    };
  }

  /**
   * One cycle of L2: Agent aggregate rows, Input detail rows and destination
   * rows. All are produced by one call so they share one drain and one window;
   * collecting them separately would let whichever ran first consume the
   * window while the others reported different maxima or flow intervals.
   *
   * Returns null when there are no rows, so a freshly started
   * instance with no agents and no destinations ships nothing at all.
   */
  collectL2(snapshot: DataflowSnapshot): L2Metrics | null {
    const now = Date.now();
    const windowMs = Math.max(0, now - (this.l2LastCollectTime || this.startTimestamp * 1000));
    const identity = {
      hostname: os.hostname(),
      ip: this.localIp,
      instance_id: this.instanceId,
      run_id: this.runId,
      user_id: this.userId,
      window_ms: String(windowMs),
      __time__: Math.floor(now / 1000),
    };

    const agentRows = this.collectAgentRows(snapshot, identity);
    const inputRows = this.collectInputRows(snapshot, identity);
    const flusherRows = this.collectFlusherRows(snapshot, identity);
    // The row builders already drained the counters, so the window is spent
    // whether or not there is anything to ship.
    this.l2LastCollectTime = now;

    if (agentRows.length === 0 && inputRows.length === 0 && flusherRows.length === 0) return null;

    return { agents: agentRows, inputs: inputRows, flushers: flusherRows };
  }

  private collectInputRows(
    snapshot: DataflowSnapshot,
    identity: L2Identity,
  ): InputFlowMetrics[] {
    const rows: InputFlowMetrics[] = [];
    for (const [inputId, stats] of snapshot.inputs) {
      const base = this.l2InputDetailBaseline.get(inputId) ?? zeroInputRuntimeTotals();
      const flow = {
        rawReadCalls: delta(stats.rawReadCalls, base.rawReadCalls),
        rawReadBytes: delta(stats.rawReadBytes, base.rawReadBytes),
        rawInRecords: delta(stats.rawInRecords, base.rawInRecords),
        rawInBytes: delta(stats.rawInBytes, base.rawInBytes),
        parseSuccessRecords: delta(stats.parseSuccessRecords, base.parseSuccessRecords),
        parseFailedRecords: delta(stats.parseFailedRecords, base.parseFailedRecords),
        readDurationMs: delta(stats.readDurationMs, base.readDurationMs),
        processDurationMs: delta(stats.processDurationMs, base.processDurationMs),
        inEvents: delta(stats.inEvents, base.inEvents),
        inBytes: delta(stats.inBytes, base.inBytes),
        failedEvents: delta(stats.outFailed, base.outFailed),
      };
      this.l2InputDetailBaseline.set(inputId, {
        rawReadCalls: stats.rawReadCalls,
        rawReadBytes: stats.rawReadBytes,
        rawInRecords: stats.rawInRecords,
        rawInBytes: stats.rawInBytes,
        parseSuccessRecords: stats.parseSuccessRecords,
        parseFailedRecords: stats.parseFailedRecords,
        readDurationMs: stats.readDurationMs,
        processDurationMs: stats.processDurationMs,
        inEvents: stats.inEvents,
        inBytes: stats.inBytes,
        outFailed: stats.outFailed,
      });

      const carriedWindowData = Object.values(flow).some(value => value > 0)
        || stats.rawInMaxBatchBytes > 0
        || stats.rawInMaxRecordBytes > 0
        || stats.rawBacklogBytesMax > 0;
      if (!stats.running && !carriedWindowData) continue;

      rows.push({
        type: 'input',
        ...identity,
        agent: agentKeyOf(inputId, stats),
        input_name: inputId,
        source_kind: stats.sourceKind,
        collection_method: stats.type,
        raw_read_calls: String(flow.rawReadCalls),
        raw_read_bytes: String(flow.rawReadBytes),
        raw_in_records: String(flow.rawInRecords),
        raw_in_bytes: String(flow.rawInBytes),
        raw_in_max_batch_bytes: String(stats.rawInMaxBatchBytes),
        raw_in_max_record_bytes: String(stats.rawInMaxRecordBytes),
        raw_backlog_bytes_max: String(stats.rawBacklogBytesMax),
        parse_success_records: String(flow.parseSuccessRecords),
        parse_failed_records: String(flow.parseFailedRecords),
        read_duration_ms: String(Math.round(flow.readDurationMs)),
        process_duration_ms: String(Math.round(flow.processDurationMs)),
        in_events: String(flow.inEvents),
        in_bytes: String(flow.inBytes),
        failed_events: String(flow.failedEvents),
      });
    }
    return rows;
  }

  /**
   * Several inputs belong to one agent (qoder alone owns sqlite/trace/cli-hook/
   * cli-session), so counters are summed per agent. idle_minutes takes the
   * freshest (smallest non-negative) of the agent's inputs: the agent is only
   * as idle as its most recently active listener.
   *
   * An agent gets a row when it carried something in the window or when it is
   * installed (at least one running input) — an all-zero row for an installed
   * agent is the idle signal, not noise. Registered-but-never-started inputs
   * (every build registers one per agent it knows about) stay unreported.
   */
  private collectAgentRows(snapshot: DataflowSnapshot, identity: L2Identity): AgentFlowMetrics[] {
    const byAgent = new Map<string, {
      rawRecords: number;
      rawBytes: number;
      rawMaxBatchBytes: number;
      events: number;
      bytes: number;
      failed: number;
      idle: number;
      lastPoll: string;
      start: string;
    }>();

    for (const [inputId, stats] of snapshot.inputs) {
      // Drain per input, not per agent: an input registered mid-run (agent
      // discovery) has no baseline yet and must contribute everything it holds.
      // Drained unconditionally, before the traffic check — otherwise a stopped
      // input's stale counts would resurface the next time it starts.
      const base = this.l2InputBaseline.get(inputId) ?? zeroFlowTotals();
      const flow = {
        rawRecords: delta(stats.rawInRecords, base.rawInRecords),
        rawBytes: delta(stats.rawInBytes, base.rawInBytes),
        events: delta(stats.inEvents, base.inEvents),
        bytes: delta(stats.inBytes, base.inBytes),
        failed: delta(stats.outFailed, base.outFailed),
      };
      this.l2InputBaseline.set(inputId, {
        rawInRecords: stats.rawInRecords,
        rawInBytes: stats.rawInBytes,
        inEvents: stats.inEvents,
        inBytes: stats.inBytes,
        outFailed: stats.outFailed,
      });

      // A running input reports every cycle, traffic or not: idle_minutes is a
      // statement about silence, so the agent that has gone quiet — the one an
      // idle alarm is about — must still produce a row. An input discovery
      // stopped mid-window reports only what it collected while running, and a
      // stopped-and-silent one drops out entirely (its agent is gone, not idle).
      if (
        flow.rawRecords === 0 &&
        flow.rawBytes === 0 &&
        flow.events === 0 &&
        flow.failed === 0 &&
        !stats.running
      ) continue;

      const agent = agentKeyOf(inputId, stats);
      let acc = byAgent.get(agent);
      if (!acc) {
        acc = {
          rawRecords: 0,
          rawBytes: 0,
          rawMaxBatchBytes: 0,
          events: 0,
          bytes: 0,
          failed: 0,
          idle: -1,
          lastPoll: '',
          start: '',
        };
        byAgent.set(agent, acc);
      }
      acc.rawRecords += flow.rawRecords;
      acc.rawBytes += flow.rawBytes;
      acc.rawMaxBatchBytes = Math.max(acc.rawMaxBatchBytes, stats.rawInMaxBatchBytes);
      acc.events += flow.events;
      acc.bytes += flow.bytes;
      acc.failed += flow.failed;

      // Folded from the former pilot_alarm_metric topic. -1 means never active.
      const idle = snapshot.inputIdleMinutes.get(inputId) ?? -1;
      if (idle >= 0 && (acc.idle < 0 || idle < acc.idle)) acc.idle = idle;
      if (stats.lastPollTime > acc.lastPoll) acc.lastPoll = stats.lastPollTime;
      if (!acc.start || (stats.startTime && stats.startTime < acc.start)) acc.start = stats.startTime;
    }

    const rows: AgentFlowMetrics[] = [];
    for (const [agent, acc] of byAgent) {
      rows.push({
        type: 'agent',
        ...identity,
        agent,
        raw_in_records: String(acc.rawRecords),
        raw_in_bytes: String(acc.rawBytes),
        raw_in_max_batch_bytes: String(acc.rawMaxBatchBytes),
        in_events: String(acc.events),
        in_bytes: String(acc.bytes),
        failed_events: String(acc.failed),
        idle_minutes: String(acc.idle),
        last_poll_time: acc.lastPoll,
        start_time: acc.start,
      });
    }
    return rows;
  }

  /**
   * One row per destination, drained against that destination's own baseline.
   * Emitted whatever the traffic: destinations are configured, few, and a silent
   * one is a finding — unlike a silent agent, whose absence is the normal case.
   * last_flush_time / start_time stay as-is; they describe state, not the window.
   */
  private collectFlusherRows(snapshot: DataflowSnapshot, identity: L2Identity): FlusherFlowMetrics[] {
    const rows: FlusherFlowMetrics[] = [];
    for (const [id, stats] of snapshot.flushers) {
      const base = this.l2FlusherBaseline.get(id) ?? zeroFlusherTotals();
      rows.push({
        type: 'flusher',
        ...identity,
        flusher: stats.kind,
        project: stats.project,
        logstore: stats.logstore,
        mode: stats.mode,
        bytes_basis: stats.bytesBasis,
        in_entries: String(delta(stats.inEntries, base.inEntries)),
        in_bytes: String(delta(stats.inBytes, base.inBytes)),
        out_entries: String(delta(stats.outEntries, base.outEntries)),
        out_bytes: String(delta(stats.outBytes, base.outBytes)),
        failed_entries: String(delta(stats.outFailed, base.outFailed)),
        total_delay_ms: String(delta(stats.totalDelayMs, base.totalDelayMs)),
        last_flush_time: stats.lastFlushTime,
        start_time: stats.startTime,
      });
      this.l2FlusherBaseline.set(id, {
        inEntries: stats.inEntries,
        inBytes: stats.inBytes,
        outEntries: stats.outEntries,
        outBytes: stats.outBytes,
        outFailed: stats.outFailed,
        totalDelayMs: stats.totalDelayMs,
      });
    }
    return rows;
  }

  private buildCaptureMessageDisabledAgents(): string {
    const disabled: string[] = [];
    for (const [agentType, cfg] of Object.entries(this.agentsConfig)) {
      if (cfg.captureMessageContent === false) disabled.push(agentType);
    }
    disabled.sort();
    return disabled.join(' ');
  }

  private buildProjects(): string {
    const seen = new Set<string>();
    for (const ep of this.slsEndpoints) {
      if (ep.project) seen.add(ep.project);
    }
    return Array.from(seen).sort().join(' ');
  }

  private buildCmsWorkspace(): string {
    return this.cmsWorkspace;
  }

  private collectInfraHealth(): InfraHealthSnapshot {
    this.l1CycleCount++;

    // `true` here means "nothing to report", which is also what the first two cycles
    // report while the updater is still coming up. With auto-update disabled there is no
    // updater to come up at all — nothing registers a service for it and the updater
    // process exits immediately on a disabled config — so probing its pid would report a
    // permanent failure and UPDATER_NOT_RUNNING_ALARM would fire ~30min into every such
    // install's life, about a process nobody asked for.
    let updaterPidAlive = true;
    if (this.autoUpdateEnabled && this.l1CycleCount > 2) {
      updaterPidAlive = this.updaterLiveness(
        path.join(this.dataDir, 'loongsuite-pilot-updater.pid'),
      ).running;
      if (updaterPidAlive) {
        this.updaterConsecutiveFailures = 0;
      } else {
        this.updaterConsecutiveFailures++;
      }
    }

    const currentVersionValid = checkVersionPointer(this.dataDir);
    const nodeBinResult = checkNodeBin(this.dataDir);
    const rollbackAvailable = checkRollbackAvailable(this.dataDir);
    const versionCount = countVersions(this.dataDir);

    this.lastInfraHealth = {
      updaterPidAlive,
      currentVersionValid,
      nodeBinValid: nodeBinResult.valid,
      nodeBinDiagnostic: nodeBinResult.diagnostic,
      rollbackAvailable,
      versionCount,
      canaryPolicy: this.canaryPolicy,
      updaterConsecutiveFailures: this.updaterConsecutiveFailures,
    };

    return this.lastInfraHealth;
  }

  getLastInfraHealth(): InfraHealthSnapshot | null {
    return this.lastInfraHealth;
  }

  private calcCpuPercent(now: number): number {
    const cpuUsage = process.cpuUsage();

    if (this.isFirstCpuSample) {
      this.isFirstCpuSample = false;
      this.lastCpuUsage = cpuUsage;
      this.lastCpuTime = now;
      return 0;
    }

    let percent = 0;
    if (this.lastCpuUsage && this.lastCpuTime > 0) {
      const elapsedMs = now - this.lastCpuTime;
      if (elapsedMs > 0) {
        const userDelta = cpuUsage.user - this.lastCpuUsage.user;
        const systemDelta = cpuUsage.system - this.lastCpuUsage.system;
        percent = ((userDelta + systemDelta) / 1000 / elapsedMs) * 100;
      }
    }

    this.lastCpuUsage = cpuUsage;
    this.lastCpuTime = now;
    return Math.round(percent * 100) / 100;
  }
}

function getOpenFdCount(): number {
  if (os.platform() === 'linux' || os.platform() === 'darwin') {
    try {
      const fdDir = os.platform() === 'linux'
        ? `/proc/${process.pid}/fd`
        : `/dev/fd`;
      return fs.readdirSync(fdDir).length;
    } catch {
      return -1;
    }
  }
  return -1;
}

function readInitType(dataDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'init-type'), 'utf-8').trim();
    return raw || 'unknown';
  } catch {
    return 'unknown';
  }
}

function checkVersionPointer(dataDir: string): boolean {
  try {
    const current = fs.readFileSync(path.join(dataDir, 'current'), 'utf-8').trim();
    if (!current) return false;
    const resolved = path.resolve(path.join(dataDir, 'versions', current));
    if (!resolved.startsWith(path.join(dataDir, 'versions') + path.sep)) return false;
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function checkNodeBin(dataDir: string): { valid: boolean; diagnostic?: NodeBinDiagnostic } {
  const nodeBinFile = path.join(dataDir, 'node-bin');
  let originalPath = '';
  try {
    originalPath = fs.readFileSync(nodeBinFile, 'utf-8').trim();
  } catch {
    return { valid: false, diagnostic: { originalPath: '', pathExists: false, pathExecutable: false } };
  }

  if (originalPath && isExecutable(originalPath)) {
    return { valid: true };
  }

  const healed = healNodeBin(nodeBinFile);
  if (healed) return { valid: true };

  return {
    valid: false,
    diagnostic: {
      originalPath,
      pathExists: originalPath ? fs.existsSync(originalPath) : false,
      pathExecutable: originalPath ? isExecutable(originalPath) : false,
    },
  };
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function healNodeBin(nodeBinFile: string): boolean {
  const candidate = findNodeCandidate(path.dirname(nodeBinFile));
  if (!candidate) {
    logger.warn(`node-bin self-heal failed, no valid Node.js candidate found (version >= ${MIN_NODE_MAJOR} required)`);
    return false;
  }
  try {
    const dir = path.dirname(nodeBinFile);
    const tmpFile = path.join(dir, `.node-bin.${process.pid}.tmp`);
    fs.writeFileSync(tmpFile, candidate + '\n', 'utf-8');
    fs.renameSync(tmpFile, nodeBinFile);
    logger.info('node-bin self-healed', { newPath: candidate });
    return true;
  } catch {
    return false;
  }
}

function hasSuitableVersion(p: string): boolean {
  try {
    const out = execFileSync(p, ['--version'], { timeout: 3000, encoding: 'utf-8' });
    const m = /^v(\d+)\./.exec(out.trim());
    if (!m) return false;
    return Number(m[1]) >= MIN_NODE_MAJOR;
  } catch {
    return false;
  }
}

function compareNodeRuntimeDirs(a: string, b: string): number {
  const parse = (s: string): number[] =>
    s.replace(/^node-v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findNodeCandidate(dataDir?: string): string | null {
  const candidates: string[] = [];

  // Managed runtime node is immune to user node-manager churn — check it first.
  if (dataDir) {
    try {
      const runtimeDir = path.join(dataDir, 'runtime');
      const entries = fs.readdirSync(runtimeDir)
        .filter(e => e.startsWith('node-v'))
        .sort(compareNodeRuntimeDirs)
        .reverse();
      const binName = process.platform === 'win32' ? 'node.exe' : 'node';
      for (const e of entries) {
        candidates.push(path.join(runtimeDir, e, 'bin', binName));
        // Official Node.js win zip layout: node.exe at the archive root.
        if (process.platform === 'win32') {
          candidates.push(path.join(runtimeDir, e, binName));
        }
      }
    } catch { /* runtime dir not installed */ }
  }

  if (process.execPath && isExecutable(process.execPath) && hasSuitableVersion(process.execPath)) {
    candidates.push(fs.realpathSync(process.execPath));
  }

  const home = os.homedir();

  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      candidates.push(path.join(nvmDir, v, 'bin', 'node'));
    }
  } catch { /* nvm not installed */ }

  candidates.push(
    path.join(home, '.fnm', 'aliases', 'default', 'bin', 'node'),
    path.join(home, '.volta', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.local', 'bin', 'node'),
  );

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (dir) candidates.push(path.join(dir, 'node'));
  }

  for (const c of candidates) {
    if (isExecutable(c) && hasSuitableVersion(c)) {
      try {
        return fs.realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  return null;
}

function checkRollbackAvailable(dataDir: string): boolean {
  try {
    const previous = fs.readFileSync(path.join(dataDir, 'previous'), 'utf-8').trim();
    if (!previous) return false;
    const resolved = path.resolve(path.join(dataDir, 'versions', previous));
    if (!resolved.startsWith(path.join(dataDir, 'versions') + path.sep)) return false;
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function countVersions(dataDir: string): number {
  try {
    return fs.readdirSync(path.join(dataDir, 'versions')).filter(e => !e.startsWith('.')).length;
  } catch {
    return 0;
  }
}
