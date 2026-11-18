import { mkdir, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { StateStore } from '../../../checkpoints/state-store.js';
import { writeJsonFile } from '../../../utils/fs-utils.js';
import { createLogger } from '../../../utils/logger.js';
import type { FilePipelineOptions, Pipeline } from '../../types.js';
import { resolveMulticaDestination, type MulticaDestination, type MulticaSlsDefaults, type MulticaSlsFlusherConfig } from './destination.js';
import { sendMulticaRecords } from './sender.js';
import { errorKind } from './http.js';
import { MulticaActivationGate, type MulticaActivationResult, type MulticaCollectionMode } from './activation.js';
import { digest, envelope } from './records.js';
import { sourcePodLabels } from './pod-labels.js';
import { collectPprof } from './pprof.js';
import { collectApi, collectDaemonHealth, collectFileStat, collectLog, collectMetrics, type ApiSource } from './sources.js';
import { validateMulticaConfig, type CollectionResult, type MulticaInputConfig, type MulticaRecord, type SourceCheckpoint } from './types.js';

const logger = createLogger('MulticaPipeline');
interface PendingBatch { records: MulticaRecord[]; checkpoint?: SourceCheckpoint }
type MulticaPipelineOptions = Omit<FilePipelineOptions, 'config'> & {
  config: Omit<FilePipelineOptions['config'], 'flushers'> & { flushers?: MulticaSlsFlusherConfig[] };
  sls?: MulticaSlsDefaults;
  serviceNamePrefix?: string;
  collectionEnabled?: boolean;
};
export interface CollectionSummary {
  successfulSources: number;
  failedSources: number;
  collectionEnabled: boolean;
  collectionMode: MulticaCollectionMode;
  activationReason: string;
  detectionMisses: number;
  collectionStopped: boolean;
}

export class MulticaPipeline implements Pipeline {
  private readonly input: MulticaInputConfig;
  private readonly state: StateStore;
  private readonly spoolDir: string;
  private readonly destination: MulticaDestination;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private loaded = false;
  private inFlight?: Promise<CollectionSummary>;
  private background?: Promise<void>;
  private readonly activation: MulticaActivationGate;
  private lastActivation?: string;
  private readonly pendingProfiles = new Map<string, CollectionResult>();
  private readonly pprofFailures = new Map<string, {count: number; retryAt: number}>();

  constructor(private readonly opts: MulticaPipelineOptions, defaultMode?: MulticaCollectionMode,
    private readonly onActivation?: (state: MulticaActivationResult) => Promise<void>) {
    const input = opts.config.inputs[0] as MulticaInputConfig;
    this.input = {...input, Instance: opts.serviceNamePrefix?.trim() || input.Instance};
    if (this.input.Type !== 'input_multica') throw new Error('Expected input_multica');
    validateMulticaConfig(this.input);
    this.activation = new MulticaActivationGate(this.input, defaultMode);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(opts.config.configName)) throw new Error('Invalid configName');
    this.destination = resolveMulticaDestination(opts.config.flushers?.[0], opts.sls);
    const destinationId = digest(JSON.stringify([this.destination.Endpoint, this.destination.Project, this.destination.Logstore]));
    // A configuration change must not replay another destination's pending data
    // or reuse its log offsets. Legacy unscoped state is deliberately not adopted.
    const stateName = `${opts.config.configName}.${destinationId}.multica`;
    this.state = new StateStore(path.join(opts.stateDir, `${stateName}.json`));
    this.spoolDir = path.join(opts.stateDir, `${stateName}-pending`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  private schedule(delayMs = (this.input.IntervalSeconds ?? 30) * 1000): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.background = this.collectOnce().then(() => {}, error => {
        logger.error('Multica collection cycle failed', {configName: this.opts.config.configName, error_kind: errorKind(error)});
      }).finally(() => {
        this.background = undefined;
        this.schedule();
      });
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await (this.background ?? this.inFlight);
  }

  collectOnce(): Promise<CollectionSummary> {
    if (!this.inFlight) this.inFlight = this.cycle().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async cycle(): Promise<CollectionSummary> {
    const activation: MulticaActivationResult = this.opts.collectionEnabled === false
      ? {enabled: false, mode: 'off', reason: 'pipeline_disabled', consecutiveMisses: 0, stopped: false}
      : await this.activation.evaluate();
    await this.onActivation?.(activation);
    const summary: CollectionSummary = {successfulSources: 0, failedSources: 0,
      collectionEnabled: activation.enabled, collectionMode: activation.mode, activationReason: activation.reason,
      detectionMisses: activation.consecutiveMisses, collectionStopped: activation.stopped};
    const signature = JSON.stringify(activation);
    if (signature !== this.lastActivation) {
      logger.info('Multica collection activation', {configName: this.opts.config.configName, ...activation});
      this.lastActivation = signature;
    }
    // Gate before loading checkpoints or replaying pending batches as well as collecting new data.
    if (activation.stopped || activation.mode === 'off') this.running = false;
    if (!activation.enabled) return summary;
    if (!this.loaded) { await mkdir(this.spoolDir, {recursive: true, mode: 0o700}); await this.state.load(); this.loaded = true; }
    const run = async (name: string, collect: () => Promise<CollectionResult>) => {
      const success = await this.source(name, collect);
      summary[success ? 'successfulSources' : 'failedSources']++;
      return success;
    };
    for (const url of this.input.MetricsUrls ?? []) await run(`metrics:${url}`, () => collectMetrics(this.input, url));
    for (const url of this.input.DaemonHealthUrls ?? []) await run(`health:${url}`, () => collectDaemonHealth(this.input, url));
    for (const file of this.input.StatFiles ?? []) await run(`stat:${file}`, () => collectFileStat(file));
    for (const file of this.input.LogFiles ?? []) await run(`log:${file}`, () => collectLog(this.input, file, this.checkpoint(`log:${file}`)));
    if (this.input.ApiBase) for (const workspace of this.input.WorkspaceIds ?? []) {
      const api = async (source: Omit<ApiSource, 'workspace'>) => {
        const name = `api:${workspace}:${source.name}`;
        await run(name, () => collectApi(this.input, {...source, workspace}));
      };
      if (this.input.CollectEntityNames) {
        await api({name: 'workspace', path: `/api/workspaces/${encodeURIComponent(workspace)}`, recordType: 'workspace_snapshot', single: true});
        await api({name: 'projects', path: '/api/projects', recordType: 'project_snapshot', key: 'projects', pagination: 'offset'});
      }
      await api({name: 'issues', path: '/api/issues', recordType: 'issue_snapshot', key: 'issues', pagination: 'offset'});
      await api({name: 'issue_statuses', path: '/api/issue-statuses', recordType: 'issue_status_snapshot', key: 'statuses'});
      await api({name: 'agents', path: '/api/agents', recordType: 'agent_snapshot', discover: true});
      await api({name: 'runtimes', path: '/api/runtimes', recordType: 'runtime_snapshot'});
      await api({name: 'active_tasks', path: '/api/agent-task-snapshot', recordType: 'task_snapshot'});
      await api({name: 'autopilots', path: '/api/autopilots', recordType: 'autopilot_snapshot', key: 'autopilots', discover: true});
      await api({name: 'autopilot_quota', path: '/api/autopilots/usage', recordType: 'usage_snapshot', single: true, extra: {report_type: 'autopilot_quota'}});
      for (const agent of this.checkpoint(`api:${workspace}:agents`).entityIds ?? []) {
        await api({name: `tasks:${agent}`, path: `/api/agents/${encodeURIComponent(agent)}/tasks?include_usage=true`, recordType: 'task_snapshot', pagination: 'cursor'});
      }
      for (const autopilot of this.checkpoint(`api:${workspace}:autopilots`).entityIds ?? []) {
        await api({name: `triggers:${autopilot}`, path: `/api/autopilots/${encodeURIComponent(autopilot)}/runs`, recordType: 'trigger_snapshot', key: 'runs', pagination: 'offset', extra: {autopilot_id: autopilot}});
      }
      for (const report of ['usage/daily', 'usage/by-agent', 'agent-runtime', 'runtime/daily', 'failures/daily', 'failures/by-agent']) {
        await api({name: `dashboard:${report}`, path: `/api/dashboard/${report}?days=${this.input.UsageDays ?? 7}&tz=UTC`, recordType: 'usage_snapshot', extra: {report_type: report}});
      }
      for (const report of ['agent-activity-30d', 'agent-run-counts']) {
        await api({name: report, path: `/api/${report}`, recordType: 'usage_snapshot', extra: {report_type: report}});
      }
    }
    // Profiling is explicitly configured and much less frequent than business
    // polling. Capture after normal sources; ACKed checkpoints survive restart.
    // Failed delivery replays the existing profile batch without taking it again.
    if (this.input.PprofBaseUrl) for (const kind of this.input.PprofTypes ?? ['cpu', 'allocs']) {
      const name = `pprof:${this.input.PprofBaseUrl}:${kind}`;
      if ((this.checkpoint(name).pprofNextCaptureAtMs ?? 0) > Date.now()
        || (this.pprofFailures.get(name)?.retryAt ?? 0) > Date.now()) continue;
      const delivered = await run(name, async () => {
        // If spooling fails, retry the same bounded result instead of profiling
        // the application again. Durable pending data still takes precedence.
        const pending = this.pendingProfiles.get(name);
        if (pending) return pending;
        try {
          const profile = await collectPprof(this.input, kind);
          this.pendingProfiles.set(name, profile);
          this.pprofFailures.delete(name);
          return profile;
        } catch (error) {
          const count = Math.min((this.pprofFailures.get(name)?.count ?? 0) + 1, 4);
          this.pprofFailures.set(name, {count, retryAt: Date.now() + Math.min(300_000, 60_000 * 2 ** (count - 1))});
          throw error;
        }
      });
      if (delivered) this.pendingProfiles.delete(name);
    }
    logger.info('collection cycle complete', {...summary});
    return summary;
  }

  private checkpoint(name: string): SourceCheckpoint {
    return (this.state.get(name).extra?.checkpoint ?? {}) as SourceCheckpoint;
  }

  private async send(records: MulticaRecord[]): Promise<void> {
    if (!records.length) return;
    // Pending batches keep the environment they were collected in, including legacy batches.
    await sendMulticaRecords(this.destination, records, records[0].multica_env ?? records[0].instance);
  }

  private async source(name: string, collect: () => Promise<CollectionResult>): Promise<boolean> {
    const observed = Date.now();
    const labels = sourcePodLabels(this.input, name);
    const pendingPath = path.join(this.spoolDir, `${digest(name)}.json`);
    try {
      let pending: PendingBatch;
      try {
        pending = JSON.parse(await readFile(pendingPath, 'utf8')) as PendingBatch;
        if (!Array.isArray(pending.records)) throw new Error('Invalid pending batch');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const result = await collect();
        const rows = result.records.map(row => {
          const identity = row.log_identity;
          const record = {...row}; delete record.log_identity;
          return envelope(this.input, name, observed, record, identity, labels);
        });
        rows.push(envelope(this.input, name, observed, {record_type: 'collection_status', source_type: 'collector',
          success: 'true', record_count: String(result.records.length), truncated: String(result.truncated ?? false),
          duration_ms: String(Date.now() - observed), entity_id: name}, undefined, labels));
        pending = {records: rows, checkpoint: result.checkpoint};
        // A durable, sanitized batch makes retries across process restarts use identical IDs.
        await writeJsonFile(pendingPath, pending);
      }
      await this.send(pending.records);
      if (pending.checkpoint) this.state.update(name, {extra: {checkpoint: pending.checkpoint}});
      await this.state.save();
      await unlink(pendingPath);
      return true;
    } catch (error) {
      const kind = errorKind(error);
      logger.warn('source collection failed', {source: name, error_kind: kind});
      try {
        await this.send([envelope(this.input, name, observed, {record_type: 'collection_status', source_type: 'collector',
          success: 'false', error_kind: kind, duration_ms: String(Date.now() - observed), entity_id: name}, undefined, labels)]);
      } catch { /* The pending source batch remains on disk until SLS accepts it. */ }
      return false;
    }
  }
}
