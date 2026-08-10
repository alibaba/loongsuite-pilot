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
  user_id: string;
  pid: number;
  cpu: string;
  mem: string;
  mem_heap: string;
  start_time: string;
  capture_message_disabled_agents: string;
  project: string;
  cms_workspace: string;
  metric_json: {
    input_count: string;
    active_input_count: string;
    open_fd: string;
    send_entries_ps: string;
    received_bytes_ps: string;
    send_entries_total: string;
    received_bytes_total: string;
  };
  flusher_runner: {
    in_entries_total: string;
    in_bytes_total: string;
    out_entries_total: string;
    out_failed_entries_total: string;
    last_flush_time: string;
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

export interface AlarmMetrics {
  category: 'alarm';
  input_name: string;
  instance_id: string;
  source_ip: string;
  user_id: string;
  succeed_events: string;
  failed_events: string;
  input_idle_minutes: string;
  __time__: number;
}

export interface InputMetrics {
  category: 'input';
  label: {
    input_name: string;
    input_type: string;
  };
  user_id: string;
  in_events_total: string;
  in_size_bytes: string;
  out_events_total: string;
  out_failed_events_total: string;
  last_poll_time: string;
  start_time: string;
  __time__: number;
}

export interface FlusherMetrics {
  category: 'flusher';
  label: {
    flusher_name: string;
    endpoint_name: string;
    project: string;
    logstore: string;
    mode: string;
  };
  user_id: string;
  in_entries_total: string;
  in_size_bytes: string;
  out_entries_total: string;
  out_failed_entries_total: string;
  total_delay_ms: string;
  last_flush_time: string;
  start_time: string;
  __time__: number;
}

export interface FlusherStats {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
}

export interface InputStats {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
}

export interface DataflowSnapshot {
  sendEntriesTotal: number;
  receivedBytesTotal: number;
  inputCount: number;
  activeInputCount: number;
  flusherRunner: FlusherStats;
  inputs: Map<string, InputStats & { type: string }>;
  flushers: Map<string, FlusherStats & { flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>;
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

export class MetricsCollector {
  private readonly version: string;
  private readonly userId: string;
  private readonly dataDir: string;
  private readonly canaryPolicy: string;
  private readonly agentsConfig: AgentsConfig;
  private readonly slsEndpoints: SlsEndpoint[];
  private readonly cmsWorkspace: string;
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  private readonly startTime: string;
  private readonly startTimestamp: number;
  private readonly instanceId: string;
  private readonly localIp: string;
  private readonly initType: string;

  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime = 0;
  private lastCollectTime = 0;
  private isFirstCpuSample = true;
  // null until the first L1 sample seeds the baseline; until then rates are reported as 0
  private prevSendEntries: number | null = null;
  private prevReceivedBytes: number | null = null;
  private l1CycleCount = 0;
  private updaterConsecutiveFailures = 0;
  private lastInfraHealth: InfraHealthSnapshot | null = null;

  constructor(opts: { version: string; userId: string; dataDir: string; canaryPolicy?: string; agentsConfig?: AgentsConfig; slsEndpoints?: SlsEndpoint[]; cmsWorkspace?: string; updaterLiveness?: (pidFile: string) => ProcessLiveness }) {
    this.version = opts.version;
    this.userId = opts.userId;
    this.dataDir = opts.dataDir;
    this.canaryPolicy = opts.canaryPolicy ?? '';
    this.agentsConfig = opts.agentsConfig ?? {};
    this.slsEndpoints = opts.slsEndpoints ?? [];
    this.cmsWorkspace = opts.cmsWorkspace ?? '';
    this.updaterLiveness = opts.updaterLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, UPDATER_PROCESS_PATTERNS));
    this.startTimestamp = Math.floor(Date.now() / 1000);
    this.startTime = formatTime(new Date());
    this.localIp = resolveLocalIp();
    this.instanceId = `${opts.userId}_${this.localIp}_${this.startTimestamp}`;
    this.initType = readInitType(opts.dataDir);
  }

  getUserId(): string {
    return this.userId;
  }

  collectL1(snapshot: DataflowSnapshot): L1Metrics {
    const now = Date.now();
    const cpuPercent = this.calcCpuPercent(now);
    const mem = process.memoryUsage();

    // First sample: seed the baseline and report 0 rates rather than dividing
    // a full cumulative count by a near-zero elapsed window.
    let entriesPs = '0.0';
    let bytesPs = '0.0';
    if (this.prevSendEntries === null || this.prevReceivedBytes === null) {
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    } else {
      const elapsedSec = Math.max((now - this.lastCollectTime) / 1000, 0.001);
      const entriesDelta = snapshot.sendEntriesTotal - this.prevSendEntries;
      const bytesDelta = snapshot.receivedBytesTotal - this.prevReceivedBytes;
      entriesPs = (entriesDelta / elapsedSec).toFixed(1);
      bytesPs = (bytesDelta / elapsedSec).toFixed(1);
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    }

    this.lastCollectTime = now;

    const health = this.collectInfraHealth();

    return {
      version: this.version,
      os_detail: `${os.type()}; ${os.release()}; ${os.arch()}`,
      hostname: os.hostname(),
      ip: this.localIp,
      instance_id: this.instanceId,
      user_id: this.userId,
      pid: process.pid,
      cpu: String(cpuPercent),
      mem: String(Math.round(mem.rss / 1024 / 1024)),
      mem_heap: String(Math.round(mem.heapUsed / 1024 / 1024)),
      start_time: this.startTime,
      capture_message_disabled_agents: this.buildCaptureMessageDisabledAgents(),
      project: this.buildProject(),
      cms_workspace: this.buildCmsWorkspace(),
      metric_json: {
        input_count: String(snapshot.inputCount),
        active_input_count: String(snapshot.activeInputCount),
        open_fd: String(getOpenFdCount()),
        send_entries_ps: entriesPs,
        received_bytes_ps: bytesPs,
        send_entries_total: String(snapshot.sendEntriesTotal),
        received_bytes_total: String(snapshot.receivedBytesTotal),
      },
      flusher_runner: {
        in_entries_total: String(snapshot.flusherRunner.inEntries),
        in_bytes_total: String(snapshot.flusherRunner.inBytes),
        out_entries_total: String(snapshot.flusherRunner.outEntries),
        out_failed_entries_total: String(snapshot.flusherRunner.outFailed),
        last_flush_time: snapshot.flusherRunner.lastFlushTime,
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

  collectL2Inputs(snapshot: DataflowSnapshot): InputMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: InputMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      results.push({
        category: 'input',
        label: {
          input_name: name,
          input_type: stats.type,
        },
        user_id: this.userId,
        in_events_total: String(stats.inEvents),
        in_size_bytes: String(stats.inBytes),
        out_events_total: String(stats.outEvents),
        out_failed_events_total: String(stats.outFailed),
        last_poll_time: stats.lastPollTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  collectL2Flushers(snapshot: DataflowSnapshot): FlusherMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: FlusherMetrics[] = [];

    for (const [epName, stats] of snapshot.flushers) {
      results.push({
        category: 'flusher',
        label: {
          flusher_name: stats.flusherName,
          endpoint_name: stats.endpoint,
          project: stats.project,
          logstore: stats.logstore,
          mode: stats.mode,
        },
        user_id: this.userId,
        in_entries_total: String(stats.inEntries),
        in_size_bytes: String(stats.inBytes),
        out_entries_total: String(stats.outEntries),
        out_failed_entries_total: String(stats.outFailed),
        total_delay_ms: String(stats.totalDelayMs),
        last_flush_time: stats.lastFlushTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  // Per-input health row. Global flusher stats (outFailed / latency) intentionally
  // live in collectL2Flushers — emitting them here would smear a single failing
  // endpoint across every input row and mislead downstream consumers.
  collectL2Alarms(snapshot: DataflowSnapshot): AlarmMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: AlarmMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      const idleMinutes = snapshot.inputIdleMinutes.get(name) ?? -1;
      results.push({
        category: 'alarm',
        input_name: name,
        instance_id: this.instanceId,
        source_ip: this.localIp,
        user_id: this.userId,
        succeed_events: String(stats.outEvents),
        failed_events: String(stats.outFailed),
        input_idle_minutes: String(idleMinutes),
        __time__: now,
      });
    }
    return results;
  }

  private buildCaptureMessageDisabledAgents(): string {
    const disabled: string[] = [];
    for (const [agentType, cfg] of Object.entries(this.agentsConfig)) {
      if (cfg.captureMessageContent === false) disabled.push(agentType);
    }
    disabled.sort();
    return disabled.join(' ');
  }

  private buildProject(): string {
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

    let updaterPidAlive = true;
    if (this.l1CycleCount > 2) {
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

