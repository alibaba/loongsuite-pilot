import { EventEmitter } from 'node:events';
import type { AnalyticsConfig, AgentDetectionEntry } from '../types/index.js';
import { AgentControlManager } from './agent-control-manager.js';
import { AgentDiscoveryService } from './agent-discovery-service.js';
import { InputManager } from './input-manager.js';
import { StateStore } from '../checkpoints/state-store.js';
import { createLogger } from '../utils/logger.js';
import { resolveHome, ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';

// Flushers
import { BaseFlusher } from '../flushers/base-flusher.js';
import { SlsFlusher } from '../flushers/sls-flusher.js';
import { JsonlFlusher } from '../flushers/jsonl-flusher.js';
import { HttpFlusher } from '../flushers/http-flusher.js';
import { MultiFlusher } from '../flushers/multi-flusher.js';

// Concrete inputs
import { QoderInput } from '../inputs/qoder/qoder-input.js';
import { QoderWorkInput } from '../inputs/qoder-work/qoder-work-input.js';
import { QoderCliInput } from '../inputs/qoder-cli/qoder-cli-input.js';
import { OpenclawInput } from '../inputs/openclaw/openclaw-input.js';

const logger = createLogger('Orchestrator');

const DEFAULT_DATA_DIR = '~/.r2c';

/**
 * Central orchestrator — the entry point that wires all sub-systems together.
 *
 * Startup sequence:
 *   1. Load configuration & state
 *   2. Build flushers (SLS + JSONL + HTTP)
 *   3. Register all inputs
 *   4. Start AgentDiscoveryService (fs.watch + polling)
 *   5. Emit 'started'
 */
export class Orchestrator extends EventEmitter {
  private readonly config: AnalyticsConfig;
  private readonly dataDir: string;
  private agentControlManager!: AgentControlManager;
  private agentDiscoveryService!: AgentDiscoveryService;
  private inputManager!: InputManager;
  private stateStore!: StateStore;
  private flusher!: BaseFlusher;
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
    this.stateStore = new StateStore(path.join(this.dataDir, 'logs', 'input-state.json'));
    await this.stateStore.load();

    this.agentControlManager = new AgentControlManager(
      path.join(this.dataDir, 'agent-control.json'),
    );
    await this.agentControlManager.load();

    // 3. Build flushers
    this.flusher = this.buildFlusher();

    // 4. Build InputManager
    this.inputManager = new InputManager();
    this.inputManager.setFlusher(this.flusher);

    // 5. Register inputs & build detection entries
    const detectionEntries = await this.registerAllInputs();

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
      inputs: detectionEntries.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info('stopping orchestrator');

    await this.agentDiscoveryService?.stop();
    await this.inputManager?.stopAll();
    await this.flusher?.shutdown();
    await this.stateStore?.save();

    this.isRunning = false;
    this.emit('stopped');
    logger.info('orchestrator stopped');
  }

  getInputManager(): InputManager {
    return this.inputManager;
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
    this.inputManager?.setUserId(userId);
  }

  private buildFlusher(): BaseFlusher {
    const flushers: BaseFlusher[] = [];
    const cfg = this.config.flushers;

    if (cfg.sls?.enabled) {
      const r = new SlsFlusher(cfg.sls, this.dataDir);
      void (r as any).start?.();
      flushers.push(r);
    }

    if (cfg.jsonl?.enabled) {
      const r = new JsonlFlusher(cfg.jsonl);
      void (r as any).start?.();
      flushers.push(r);
    }

    if (cfg.http?.enabled) {
      const r = new HttpFlusher(cfg.http);
      void (r as any).start?.();
      flushers.push(r);
    }

    if (flushers.length === 0) {
      logger.warn('no flushers enabled, using JSONL fallback');
      const fallback = new JsonlFlusher({
        enabled: true,
        outputDir: path.join(this.dataDir, 'logs', 'output'),
        rotateDaily: true,
        maxFileSizeMb: 100,
      });
      void (fallback as any).start?.();
      flushers.push(fallback);
    }

    return flushers.length === 1 ? flushers[0] : new MultiFlusher(flushers);
  }

  /**
   * Register all built-in inputs. Returns detection entries for the
   * AgentDiscoveryService.
   *
   * To add a new agent: create a input class, add registration here.
   */
  private async registerAllInputs(): Promise<AgentDetectionEntry[]> {
    const entries: AgentDetectionEntry[] = [];
    const listenerCfg = this.config.listeners;

    // --- Qoder (IDE snapshot polling) ---
    const qoderInput = new QoderInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderInput, {
        watchPaths: QoderInput.getWatchPaths(),
        isAvailable: QoderInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder',
          listenerCfg.qoder?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg.qoder?.pollInterval,
      }),
    );

    // --- Qoder Work (SQLite polling) ---
    const qoderWorkInput = new QoderWorkInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkInput, {
        watchPaths: QoderWorkInput.getWatchPaths(),
        isAvailable: QoderWorkInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-work',
          listenerCfg['qoder-work']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-work']?.pollInterval,
      }),
    );

    // --- Qoder CLI (Hook JSONL) ---
    const qoderCliInput = new QoderCliInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCliInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliInput, {
        watchPaths: QoderCliInput.getWatchPaths(),
        isAvailable: QoderCliInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-cli-hook',
          listenerCfg['qoder-cli-hook']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-cli-hook']?.pollInterval,
      }),
    );

    // --- Openclaw (Session file polling — NEW agent) ---
    const openclawInput = new OpenclawInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(openclawInput);
    entries.push(
      this.inputManager.buildDetectionEntry(openclawInput, {
        watchPaths: OpenclawInput.getWatchPaths(),
        isAvailable: OpenclawInput.checkAvailability,
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
