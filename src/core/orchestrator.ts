import { EventEmitter } from 'node:events';
import type { AnalyticsConfig, AgentDetectionEntry } from '../types/index.js';
import { AgentControlManager } from './agent-control-manager.js';
import { AgentDiscoveryService } from './agent-discovery-service.js';
import { CollectorManager } from './collector-manager.js';
import { StateStore } from '../persistence/state-store.js';
import { createLogger } from '../utils/logger.js';
import { resolveHome, ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';

// Reporters
import { BaseReporter } from '../reporters/base-reporter.js';
import { SlsReporter } from '../reporters/sls-reporter.js';
import { JsonlReporter } from '../reporters/jsonl-reporter.js';
import { HttpReporter } from '../reporters/http-reporter.js';
import { MultiReporter } from '../reporters/multi-reporter.js';

// Concrete collectors
import { QoderCollector } from '../collectors/qoder/qoder-collector.js';
import { QoderWorkCollector } from '../collectors/qoder-work/qoder-work-collector.js';
import { QoderCliCollector } from '../collectors/qoder-cli/qoder-cli-collector.js';
import { OpenclawCollector } from '../collectors/openclaw/openclaw-collector.js';

const logger = createLogger('Orchestrator');

const DEFAULT_DATA_DIR = '~/.r2c';

/**
 * Central orchestrator — the entry point that wires all sub-systems together.
 *
 * Startup sequence:
 *   1. Load configuration & state
 *   2. Build reporters (SLS + JSONL + HTTP)
 *   3. Register all collectors
 *   4. Start AgentDiscoveryService (fs.watch + polling)
 *   5. Emit 'started'
 */
export class Orchestrator extends EventEmitter {
  private readonly config: AnalyticsConfig;
  private readonly dataDir: string;
  private agentControlManager!: AgentControlManager;
  private agentDiscoveryService!: AgentDiscoveryService;
  private collectorManager!: CollectorManager;
  private stateStore!: StateStore;
  private reporter!: BaseReporter;
  private isRunning = false;

  constructor(config: AnalyticsConfig) {
    super();
    this.config = config;
    this.dataDir = resolveHome(config.dataDir || DEFAULT_DATA_DIR);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('already running');
      return;
    }

    logger.info('starting orchestrator');
    this.emit('starting');

    // 1. Ensure data directories
    await ensureDir(this.dataDir);
    await ensureDir(path.join(this.dataDir, 'logs'));

    // 2. Load state & agent-control config
    this.stateStore = new StateStore(path.join(this.dataDir, 'logs', 'collector-state.json'));
    await this.stateStore.load();

    this.agentControlManager = new AgentControlManager(
      path.join(this.dataDir, 'agent-control.json'),
    );
    await this.agentControlManager.load();

    // 3. Build reporters
    this.reporter = this.buildReporter();

    // 4. Build CollectorManager
    this.collectorManager = new CollectorManager();
    this.collectorManager.setReporter(this.reporter);

    // 5. Register collectors & build detection entries
    const detectionEntries = await this.registerAllCollectors();

    // 6. Start AgentDiscoveryService
    this.agentDiscoveryService = new AgentDiscoveryService(detectionEntries);
    this.agentDiscoveryService.on('agent:started', (id: string) => {
      logger.info('agent detected and started', { id });
    });
    this.agentDiscoveryService.on('agent:stopped', (id: string) => {
      logger.info('agent stopped', { id });
    });
    await this.agentDiscoveryService.start();

    this.isRunning = true;
    this.emit('started');
    logger.info('orchestrator started', {
      collectors: detectionEntries.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info('stopping orchestrator');

    await this.agentDiscoveryService?.stop();
    await this.collectorManager?.stopAll();
    await this.reporter?.shutdown();
    await this.stateStore?.save();

    this.isRunning = false;
    this.emit('stopped');
    logger.info('orchestrator stopped');
  }

  getCollectorManager(): CollectorManager {
    return this.collectorManager;
  }

  getAgentControlManager(): AgentControlManager {
    return this.agentControlManager;
  }

  getAgentDiscoveryService(): AgentDiscoveryService {
    return this.agentDiscoveryService;
  }

  /**
   * Set the user identity (typically resolved asynchronously).
   */
  setUserId(userId: string): void {
    this.collectorManager?.setUserId(userId);
  }

  private buildReporter(): BaseReporter {
    const reporters: BaseReporter[] = [];
    const cfg = this.config.reporters;

    if (cfg.sls?.enabled) {
      const r = new SlsReporter(cfg.sls, this.dataDir);
      void (r as any).start?.();
      reporters.push(r);
    }

    if (cfg.jsonl?.enabled) {
      const r = new JsonlReporter(cfg.jsonl);
      void (r as any).start?.();
      reporters.push(r);
    }

    if (cfg.http?.enabled) {
      const r = new HttpReporter(cfg.http);
      void (r as any).start?.();
      reporters.push(r);
    }

    if (reporters.length === 0) {
      logger.warn('no reporters enabled, using JSONL fallback');
      const fallback = new JsonlReporter({
        enabled: true,
        outputDir: path.join(this.dataDir, 'logs', 'output'),
        rotateDaily: true,
        maxFileSizeMb: 100,
      });
      void (fallback as any).start?.();
      reporters.push(fallback);
    }

    return reporters.length === 1 ? reporters[0] : new MultiReporter(reporters);
  }

  /**
   * Register all built-in collectors. Returns detection entries for the
   * AgentDiscoveryService.
   *
   * To add a new agent: create a collector class, add registration here.
   */
  private async registerAllCollectors(): Promise<AgentDetectionEntry[]> {
    const entries: AgentDetectionEntry[] = [];
    const listenerCfg = this.config.listeners;

    // --- Qoder (IDE snapshot polling) ---
    const qoderCollector = new QoderCollector({ stateStore: this.stateStore });
    this.collectorManager.registerCollector(qoderCollector);
    entries.push(
      this.collectorManager.buildDetectionEntry(qoderCollector, {
        watchPaths: QoderCollector.getWatchPaths(),
        isAvailable: QoderCollector.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder',
          listenerCfg.qoder?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg.qoder?.pollInterval,
      }),
    );

    // --- Qoder Work (SQLite polling) ---
    const qoderWorkCollector = new QoderWorkCollector({ stateStore: this.stateStore });
    this.collectorManager.registerCollector(qoderWorkCollector);
    entries.push(
      this.collectorManager.buildDetectionEntry(qoderWorkCollector, {
        watchPaths: QoderWorkCollector.getWatchPaths(),
        isAvailable: QoderWorkCollector.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-work',
          listenerCfg['qoder-work']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-work']?.pollInterval,
      }),
    );

    // --- Qoder CLI (Hook JSONL) ---
    const qoderCliCollector = new QoderCliCollector({ stateStore: this.stateStore });
    this.collectorManager.registerCollector(qoderCliCollector);
    entries.push(
      this.collectorManager.buildDetectionEntry(qoderCliCollector, {
        watchPaths: QoderCliCollector.getWatchPaths(),
        isAvailable: QoderCliCollector.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-cli-hook',
          listenerCfg['qoder-cli-hook']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-cli-hook']?.pollInterval,
      }),
    );

    // --- Openclaw (Session file polling — NEW agent) ---
    const openclawCollector = new OpenclawCollector({ stateStore: this.stateStore });
    this.collectorManager.registerCollector(openclawCollector);
    entries.push(
      this.collectorManager.buildDetectionEntry(openclawCollector, {
        watchPaths: OpenclawCollector.getWatchPaths(),
        isAvailable: OpenclawCollector.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'openclaw',
          listenerCfg.openclaw?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg.openclaw?.pollInterval,
      }),
    );

    return entries;
  }
}
