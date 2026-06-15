import { EventEmitter } from 'node:events';
import { ClientType } from '../types/index.js';
import type { AnalyticsConfig, AgentDetectionEntry } from '../types/index.js';
import { AgentControlManager } from './agent-control-manager.js';
import { AgentDiscoveryService } from './agent-discovery-service.js';
import { InputManager } from './input-manager.js';
import { StateStore } from '../checkpoints/state-store.js';
import { HookManager } from '../hooks/hook-manager.js';
import { DeploymentManager } from '../deployment/deployment-manager.js';
import { detectAgent } from '../deployment/detect-utils.js';
import { createLogger } from '../utils/logger.js';
import { resolveHome, ensureDir, directoryExists, readJsonFile, writeJsonFile, fileExists, readInstalledVersion } from '../utils/fs-utils.js';
import * as path from 'node:path';
import * as fsSync from 'node:fs';

// Flushers
import { BaseFlusher } from '../flushers/base-flusher.js';
import { SlsFlusher } from '../flushers/sls-flusher.js';
import { JsonlFlusher } from '../flushers/jsonl-flusher.js';
import { HttpFlusher } from '../flushers/http-flusher.js';
import { MultiFlusher } from '../flushers/multi-flusher.js';
import { buildOtlpTraceConfig } from './config-loader.js';

// Concrete inputs
import { QoderSqliteInput } from '../inputs/qoder-sqlite/qoder-sqlite-input.js';
import { QoderCnSqliteInput } from '../inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { QoderCnInput } from '../inputs/qoder-cn/qoder-cn-input.js';
import { QoderCnTraceInput } from '../inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { QoderWorkInput } from '../inputs/qoder-work/qoder-work-input.js';
import { QoderWorkLogInput, resolveQoderWorkRoot } from '../inputs/qoder-work-log/qoder-work-log-input.js';
import { QoderWorkTraceInput as QoderWorkCNTraceInput } from '../inputs/qoder-work-log/qoder-work-trace-input.js';
import { QoderWorkSqliteInput } from '../inputs/qoder-work-sqlite/qoder-work-sqlite-input.js';
import { QoderWorkTraceInput } from '../inputs/qoder-work-trace/qoder-work-trace-input.js';
import { QoderCliInput } from '../inputs/qoder-cli/qoder-cli-input.js';
import { QoderCliSessionInput } from '../inputs/qoder-cli-session/qoder-cli-session-input.js';
import { QoderTraceInput } from '../inputs/qoder-trace/qoder-trace-input.js';
import { CursorHookInput } from '../inputs/cursor-hook/cursor-hook-input.js';
import { ClaudeCodeLogInput } from '../inputs/claude-code-log/claude-code-log-input.js';
import { CodexLogInput } from '../inputs/codex-log/codex-log-input.js';
import { OpenCodeLogInput } from '../inputs/opencode-log/opencode-log-input.js';
import { WukongInput } from '../inputs/wukong/wukong-input.js';

import { LogRetentionService } from './log-retention-service.js';
import { HookWatchdog, type PluginCheckTarget } from './hook-watchdog.js';
import { FileCollectionManager } from '../file-collection/file-collection-manager.js';
import { MetricsWriter } from '../metrics/metrics-writer.js';
import { AlarmManager } from '../metrics/alarm-manager.js';
import type { DataflowSnapshot } from '../metrics/metrics-collector.js';
import { RuntimeWriter, MetricsSummaryWriter, StatusBarAppManager } from '../status-bar/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveLocalIp } from '../utils/network-utils.js';

const logger = createLogger('Orchestrator');

const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

/**
 * Central orchestrator — the entry point that wires all sub-systems together.
 *
 * Startup sequence:
 *   1. Load configuration & state
 *   2. Build flushers (SLS + JSONL + HTTP)
 *   3. Install hooks into agent config files
 *   4. Register all inputs
 *   5. Start AgentDiscoveryService (fs.watch + polling)
 *   6. Emit 'started'
 */
export class Orchestrator extends EventEmitter {
  private static readonly LISTENER_AGENT_MAP: Record<string, string> = {
    'qoder-sqlite': 'qoder',
    'qoder-trace': 'qoder',
    'qoder-cn-trace': 'qoder-cn',
    'qoder-cn-sqlite': 'qoder-cn',
    'qoder-cn': 'qoder-cn',
    'qoder-work': 'qoder-work',
    'qoder-work-trace': 'qoder-work',
    'qoder-work-log': 'qoder-work',
    'qoder-work-sqlite': 'qoder-work',
    'qoder-work-cn-trace': 'qoder-work-cn',
    'qoder-work-cn-hook': 'qoder-work-cn',
    'qoder-work-cn-log': 'qoder-work-cn',
    'qoder-work-cn-sqlite': 'qoder-work-cn',
    'qoder-cli-hook': 'qoder',
    'qoder-cli-session': 'qoder',
    'cursor-hook': 'cursor',
    'claude-code-log': 'claude-code',
    'codex-log': 'codex',
    'opencode-log': 'opencode',
    'wukong': 'wukong',
  };

  private readonly config: AnalyticsConfig;
  private readonly dataDir: string;
  private agentControlManager!: AgentControlManager;
  private agentDiscoveryService!: AgentDiscoveryService;
  private inputManager!: InputManager;
  private stateStore!: StateStore;
  private flusher!: BaseFlusher;
  private logRetentionService!: LogRetentionService;
  private hookWatchdog!: HookWatchdog;
  private deploymentManager!: DeploymentManager;
  private fileCollectionManager: FileCollectionManager | null = null;
  private metricsWriter!: MetricsWriter;
  private alarmManager!: AlarmManager;
  private runtimeWriter: RuntimeWriter | null = null;
  private metricsSummaryWriter: MetricsSummaryWriter | null = null;
  private statusBarAppManager: StatusBarAppManager | null = null;
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
    this.flusher = await this.buildFlusher();

    // 4. Build InputManager & AlarmManager
    const version = readInstalledVersion(this.dataDir);
    this.alarmManager = new AlarmManager({ ip: resolveLocalIp(), version });

    this.inputManager = new InputManager();
    this.inputManager.setFlusher(this.flusher);
    this.inputManager.setConfiguredUserId(this.config.userId);
    this.inputManager.setAgentsConfig(this.config.agents);
    this.inputManager.setAlarmManager(this.alarmManager);
    this.inputManager.setMaskConfig(this.config.mask ?? { mode: 'none', types: [] });

    // 5. Deploy agent collection capabilities (hooks + plugins, best-effort)
    const pilotDir = this.resolvePilotDir();
    this.deploymentManager = new DeploymentManager({
      dataDir: this.dataDir,
      pilotDir,
    });
    await this.deploymentManager.deployAll();

    // 6. Register inputs & build detection entries
    const detectionEntries = await this.registerAllInputs();

    // 7. Build deployment detection entries for dynamic discovery
    const deployDetectionEntries = this.buildDeployDetectionEntries();

    // 8. Start AgentDiscoveryService (input entries + deploy detection entries)
    this.agentDiscoveryService = new AgentDiscoveryService([...detectionEntries, ...deployDetectionEntries]);
    this.agentDiscoveryService.on('agent:started', (id: string) => {
      logger.info('agent detected and started', { id });
    });
    this.agentDiscoveryService.on('agent:stopped', (id: string) => {
      logger.info('agent stopped', { id });
      this.alarmManager.record(
        'INPUT_STOP_ALARM', '3',
        `input ${id} stopped unexpectedly`,
        { input_name: id },
      );
    });
    await this.agentDiscoveryService.start();

    // 9. Start log retention service
    this.logRetentionService = new LogRetentionService(this.dataDir, this.config.retention);
    this.logRetentionService.start();

    // 10. Start hook watchdog (periodically restores hooks overwritten by other tools)
    const hookWatchdogTargets = [
      ...HookWatchdog.defaultTargets(),
      ...this.buildHookWatchdogTargets(),
    ];
    this.hookWatchdog = new HookWatchdog(this.config.hookWatchdog, hookWatchdogTargets);
    this.hookWatchdog.start();

    // 11. Start file collection pipelines (disabled by default)
    if (this.config.fileCollection.enabled) {
      this.fileCollectionManager = new FileCollectionManager({
        configDir: path.join(this.dataDir, 'configs', 'local'),
        stateDir: path.join(this.dataDir, 'state', 'file-collection'),
        failedLogDir: path.join(this.dataDir, 'logs', 'file-collection-failed'),
      });
      await this.fileCollectionManager.start();
    } else {
      logger.info('file collection disabled, skipping');
    }

    // 12. Start metrics writer (L1 + L2 every 10min, alarms every 30s → local JSONL + remote via sender.ts)
    const slsFlusher = this.getSlsFlusher();
    if (slsFlusher) slsFlusher.setAlarmManager(this.alarmManager);
    this.metricsWriter = new MetricsWriter({
      dataDir: this.dataDir,
      version,
      userId: this.config.userId,
      getSnapshot: () => this.buildDataflowSnapshot(),
      alarmManager: this.alarmManager,
    });
    await this.metricsWriter.start();

    // 12. Start status bar support (runtime.json + metrics summary + native app)
    if (this.config.statusBar.enabled) {
      const packageVersion = this.readPackageVersion();

      this.runtimeWriter = new RuntimeWriter(this.dataDir, this.config.statusBar, packageVersion);
      this.runtimeWriter.start();

      this.metricsSummaryWriter = new MetricsSummaryWriter(this.dataDir, this.config.statusBar);
      this.metricsSummaryWriter.start();

      if (process.platform === 'darwin') {
        this.statusBarAppManager = new StatusBarAppManager({ dataDir: this.dataDir, packageVersion });
        await this.statusBarAppManager.syncDesiredState(true).catch(err => {
          logger.warn('status bar app start failed (non-fatal)', { error: String(err) });
        });
      }
    }

    this.isRunning = true;
    this.emit('started');
    logger.info('orchestrator started', {
      inputs: detectionEntries.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info('stopping orchestrator');

    await this.fileCollectionManager?.stop();
    await this.metricsWriter?.stop();
    await this.statusBarAppManager?.stop('orchestrator-shutdown').catch(() => {});
    this.metricsSummaryWriter?.stop();
    this.runtimeWriter?.stop();
    this.hookWatchdog?.stop();
    this.logRetentionService?.stop();
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

  getDeploymentManager(): DeploymentManager {
    return this.deploymentManager;
  }

  /**
   * Set a fallback user id (typically resolved asynchronously).
   */
  setUserId(userId: string): void {
    this.inputManager?.setUserId(userId);
  }

  /**
   * Build detection entries for agent definitions that haven't been deployed yet.
   * When a new agent is discovered at runtime, triggers deploySingle().
   */
  private buildDeployDetectionEntries(): AgentDetectionEntry[] {
    const defs = this.deploymentManager.getDefinitions();
    const entries: AgentDetectionEntry[] = [];

    for (const def of defs) {
      const watchPaths = def.detection.paths.map(p =>
        p.startsWith('~') ? resolveHome(p) : p,
      );
      if (watchPaths.length === 0) continue;

      const entryId = `deploy:${def.id}`;
      entries.push({
        id: entryId,
        type: 'deploy-detection',
        watchPaths,
        isAvailable: () => detectAgent(def.detection),
        enabled: () => this.isAgentGatedEnabled(def.id),
        start: async () => {
          logger.info('new agent discovered, deploying', { agentId: def.id });
          await this.deploymentManager.deploySingle(def);
        },
        stop: async () => {},
        pollIntervalMs: 300_000,
      });
    }

    return entries;
  }

  private buildHookWatchdogTargets(): PluginCheckTarget[] {
    const defs = this.deploymentManager.getDefinitions();
    const targets: PluginCheckTarget[] = [];

    for (const def of defs) {
      if (def.deployMode !== 'hook' || !def.hook) continue;

      targets.push({
        agentId: def.id,
        settingsPath: def.hook.settingsPath,
        expectedHooks: def.hook.events,
        markers: [def.hook.hookCommand],
        repairFn: () => this.deploymentManager.deploySingle(def).then(r => r.success),
      });
    }

    return targets;
  }

  private async buildFlusher(): Promise<BaseFlusher> {
    const flushers: BaseFlusher[] = [];
    const cfg = this.config.flushers;

    if (cfg.sls?.enabled && this.config.collectLog !== false) {
      const r = new SlsFlusher(cfg.sls, this.dataDir);
      await r.start().catch(err => logger.warn('sls flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    if (cfg.jsonl?.enabled) {
      const r = new JsonlFlusher(cfg.jsonl);
      await r.start().catch(err => logger.warn('jsonl flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    if (cfg.http?.enabled) {
      const r = new HttpFlusher(cfg.http);
      await r.start().catch(err => logger.warn('http flusher start failed', { error: String(err) }));
      flushers.push(r);
    }

    const otlpTraceCfg = buildOtlpTraceConfig(this.config);
    if (otlpTraceCfg?.enabled) {
      try {
        const { OtlpTraceFlusher } = await import('../flushers/otlp-trace-flusher.js');
        const r = new OtlpTraceFlusher(otlpTraceCfg);
        flushers.push(r);
      } catch (err) {
        logger.warn('OtlpTraceFlusher unavailable, skipping', { error: String(err) });
      }
    }

    if (flushers.length === 0) {
      logger.warn('no flushers enabled, using JSONL fallback');
      const fallback = new JsonlFlusher({
        enabled: true,
        outputDir: path.join(this.dataDir, 'logs', 'output'),
        rotateDaily: true,
        maxFileSizeMb: 100,
      });
      await fallback.start().catch(err => logger.warn('jsonl fallback flusher start failed', { error: String(err) }));
      flushers.push(fallback);
    }

    return flushers.length === 1 ? flushers[0] : new MultiFlusher(flushers);
  }

  /**
   * Install hook scripts into agent configuration files.
   * Only installs if the target agent is present on disk.
   */
  private async installHooks(): Promise<void> {
    const hookManager = new HookManager(
      path.join(this.dataDir, 'hooks'),
      path.join(this.dataDir, 'logs'),
    );

    // --- Cursor hooks ---
    const cursorDir = resolveHome('~/.cursor');
    if (await directoryExists(cursorDir)) {
      const cursorHooksPath = resolveHome('~/.cursor/hooks.json');
      const existing = await readJsonFile<Record<string, unknown>>(cursorHooksPath);
      if (!existing) {
        await writeJsonFile(cursorHooksPath, { version: 1, hooks: {} });
      } else if (existing.version === undefined) {
        existing.version = 1;
        await writeJsonFile(cursorHooksPath, existing);
      }

      const defs = HookManager.buildCursorHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('cursor hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `cursor hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'cursor-hook' });
          }
        }
      }
    }

    // --- Qoder CLI hooks ---
    const qoderCliAvailable = await QoderCliInput.checkAvailability();
    if (qoderCliAvailable) {
      const defs = HookManager.buildQoderCliHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-cli hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-cli hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-cli-hook' });
          }
        }
      }
    }

    const qoderWorkAvailable = await QoderWorkInput.checkAvailability();
    if (qoderWorkAvailable) {
      const defs = HookManager.buildQoderWorkHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-work hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-work hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-work' });
          }
        }
      }
    }

    const qoderWorkCNAvailable = await directoryExists(resolveHome('~/.qoderworkcn'));
    if (qoderWorkCNAvailable) {
      const defs = HookManager.buildQoderWorkCNHooks(this.dataDir);
      for (const def of defs) {
        const installed = await hookManager.isHookInstalled(def);
        if (!installed) {
          const ok = await hookManager.installHook(def);
          if (ok) {
            const event = def.hookJsonPath[def.hookJsonPath.length - 1];
            logger.info('qoder-work-cn hook registered', { event });
          } else {
            this.alarmManager.record('HOOK_INSTALL_ALARM', '2',
              `qoder-work-cn hook install failed: ${def.hookJsonPath.join('.')}`,
              { input_name: 'qoder-work-cn' });
          }
        }
      }
    }
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

    // Qoder trace input mutual exclusion closure (used by sqlite/hook/session guards below)
    const qoderTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-trace',
        listenerCfg['qoder-trace']?.enabled ?? true,
      );

    // --- Qoder (SQLite token usage polling) — disabled when qoder-trace is enabled ---
    const qoderSqliteInput = new QoderSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderSqliteInput, {
        watchPaths: QoderSqliteInput.getWatchPaths(),
        isAvailable: QoderSqliteInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-sqlite',
            listenerCfg['qoder-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-sqlite']?.pollInterval,
      }),
    );

    // --- Qoder Work CN Trace (multi-source merge, supersedes hook/log/sqlite) ---
    const qoderWorkTraceInput = new QoderWorkTraceInput({
      stateStore: this.stateStore,
      logDir: path.join(this.dataDir, 'logs', 'qoder-work', 'history'),
    });
    this.inputManager.registerInput(qoderWorkTraceInput);
    const qoderWorkTraceEnabled = () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-work-trace',
        listenerCfg['qoder-work-trace']?.enabled ?? true,
      );
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkTraceInput, {
        watchPaths: QoderWorkTraceInput.getWatchPaths(),
        isAvailable: QoderWorkTraceInput.checkAvailability,
        enabled: qoderWorkTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-work-trace']?.pollInterval,
      }),
    );

    // QoderCN trace input mutual exclusion closure
    const qoderCnTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-cn-trace',
        listenerCfg['qoder-cn-trace']?.enabled ?? true,
      );

    // --- QoderCN (SQLite token usage polling) — disabled when qoder-cn-trace is enabled ---
    const qoderCnSqliteInput = new QoderCnSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCnSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnSqliteInput, {
        watchPaths: QoderCnSqliteInput.getWatchPaths(),
        isAvailable: QoderCnSqliteInput.checkAvailability,
        enabled: () => !qoderCnTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cn-sqlite',
            listenerCfg['qoder-cn-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cn-sqlite']?.pollInterval,
      }),
    );

    // --- QoderCN (IDE snapshot — file history + ai_tracker) — disabled when qoder-cn-trace is enabled ---
    const qoderCnInput = new QoderCnInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCnInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnInput, {
        watchPaths: QoderCnInput.getWatchPaths(),
        isAvailable: QoderCnInput.checkAvailability,
        enabled: () => !qoderCnTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cn']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cn',
            listenerCfg['qoder-cn']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cn']?.pollInterval,
      }),
    );

    // --- QoderCN Trace (multi-source merge, supersedes sqlite/ide) ---
    const qoderCnLogDir = path.join(this.dataDir, 'logs', 'qoder-cn', 'history');
    const qoderCnTraceInput = new QoderCnTraceInput({
      stateStore: this.stateStore,
      logDir: qoderCnLogDir,
    });
    this.inputManager.registerInput(qoderCnTraceInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCnTraceInput, {
        watchPaths: QoderCnTraceInput.getWatchPaths(),
        isAvailable: QoderCnTraceInput.checkAvailability,
        enabled: qoderCnTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-cn-trace']?.pollInterval,
      }),
    );

    // --- Qoder Work (Hook JSONL) — disabled when CN trace is active ---
    const qoderWorkLogDir = path.join(this.dataDir, 'logs', 'qoder-work', 'history');
    const qoderWorkInput = new QoderWorkInput({
      stateStore: this.stateStore,
      logDir: qoderWorkLogDir,
    });
    this.inputManager.registerInput(qoderWorkInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkInput, {
        watchPaths: QoderWorkInput.getWatchPaths(),
        isAvailable: QoderWorkInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work',
            listenerCfg['qoder-work']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work']?.pollInterval,
      }),
    );

    // --- Qoder Work (SDK Log tail) — disabled when CN trace is active ---
    const qoderWorkLogInput = new QoderWorkLogInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkLogInput, {
        watchPaths: QoderWorkLogInput.getWatchPaths(),
        isAvailable: QoderWorkLogInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-log']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-log',
            listenerCfg['qoder-work-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-log']?.pollInterval,
      }),
    );

    // --- Qoder Work (SQLite agents.db) — disabled when CN trace is active ---
    const qoderWorkSqliteInput = new QoderWorkSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkSqliteInput, {
        watchPaths: QoderWorkSqliteInput.getWatchPaths(),
        isAvailable: QoderWorkSqliteInput.checkAvailability,
        enabled: () => !qoderWorkTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-sqlite',
            listenerCfg['qoder-work-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-sqlite']?.pollInterval,
      }),
    );

    // --- Qoder Work CN ---
    const qoderWorkCNDataRoot = resolveQoderWorkRoot('cn');
    const qoderWorkCNLogDir = path.join(this.dataDir, 'logs', 'qoder-work-cn', 'history');
    const qoderWorkCNDetectionPath = resolveHome('~/.qoderworkcn');

    // --- Qoder Work CN (Trace: SDK Log + SQLite aggregation) ---
    const qoderWorkCNTraceInput = new QoderWorkCNTraceInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNTraceInput);
    const qoderWorkCNTraceEnabled = () =>
      this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-trace']) &&
      this.agentControlManager.resolveEnabled(
        'qoder-work-cn-trace',
        listenerCfg['qoder-work-cn-trace']?.enabled ?? false,
      );
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNTraceInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'logs')],
        isAvailable: () => directoryExists(path.join(qoderWorkCNDataRoot, 'logs')),
        enabled: qoderWorkCNTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-work-cn-trace']?.pollInterval,
      }),
    );

    // --- Qoder Work CN (Hook JSONL) — disabled when CN trace is active ---
    const qoderWorkCNHookInput = new QoderWorkInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      logDir: qoderWorkCNLogDir,
    });
    this.inputManager.registerInput(qoderWorkCNHookInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNHookInput, {
        watchPaths: [qoderWorkCNDetectionPath],
        isAvailable: () => directoryExists(qoderWorkCNDetectionPath),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-hook']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-hook',
            listenerCfg['qoder-work-cn-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-hook']?.pollInterval,
      }),
    );

    // --- Qoder Work CN (SDK Log tail) — disabled when CN trace is active ---
    const qoderWorkCNLogInput = new QoderWorkLogInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNLogInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'logs')],
        isAvailable: () => directoryExists(path.join(qoderWorkCNDataRoot, 'logs')),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-log']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-log',
            listenerCfg['qoder-work-cn-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-log']?.pollInterval,
      }),
    );

    // --- Qoder Work CN (SQLite agents.db) — disabled when CN trace is active ---
    const qoderWorkCNSqliteInput = new QoderWorkSqliteInput({
      stateStore: this.stateStore,
      agentType: ClientType.QoderWorkCN,
      dataRoot: qoderWorkCNDataRoot,
    });
    this.inputManager.registerInput(qoderWorkCNSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkCNSqliteInput, {
        watchPaths: [path.join(qoderWorkCNDataRoot, 'data')],
        isAvailable: () => fileExists(path.join(qoderWorkCNDataRoot, 'data', 'agents.db')),
        enabled: () => !qoderWorkCNTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-work-cn-sqlite']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-work-cn-sqlite',
            listenerCfg['qoder-work-cn-sqlite']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-work-cn-sqlite']?.pollInterval,
      }),
    );

    // --- Qoder Trace (multi-source merge, supersedes hook/session/sqlite) ---
    const qoderCliLogDir = path.join(this.dataDir, 'logs', 'qoder', 'history');
    const qoderTraceInput = new QoderTraceInput({
      stateStore: this.stateStore,
      logDir: qoderCliLogDir,
    });
    this.inputManager.registerInput(qoderTraceInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderTraceInput, {
        watchPaths: QoderTraceInput.getWatchPaths(),
        isAvailable: QoderTraceInput.checkAvailability,
        enabled: qoderTraceEnabled,
        pollIntervalMs: listenerCfg['qoder-trace']?.pollInterval,
      }),
    );

    // --- Qoder CLI (Hook JSONL) — disabled when qoder-trace is enabled ---
    const qoderCliInput = new QoderCliInput({
      stateStore: this.stateStore,
      logDir: qoderCliLogDir,
    });
    this.inputManager.registerInput(qoderCliInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliInput, {
        watchPaths: QoderCliInput.getWatchPaths(),
        isAvailable: QoderCliInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cli-hook']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cli-hook',
            listenerCfg['qoder-cli-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cli-hook']?.pollInterval,
      }),
    );

    // --- Qoder CLI (Native session segments) — disabled when qoder-trace is enabled ---
    const qoderCliSessionInput = new QoderCliSessionInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCliSessionInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliSessionInput, {
        watchPaths: QoderCliSessionInput.getWatchPaths(),
        isAvailable: QoderCliSessionInput.checkAvailability,
        enabled: () => !qoderTraceEnabled() &&
          this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-cli-session']) &&
          this.agentControlManager.resolveEnabled(
            'qoder-cli-session',
            listenerCfg['qoder-cli-session']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['qoder-cli-session']?.pollInterval,
      }),
    );

    // --- Cursor Hook (Hook JSONL) ---
    const cursorHookLogDir = path.join(this.dataDir, 'logs', 'cursor', 'history');
    const cursorHookInput = new CursorHookInput({
      stateStore: this.stateStore,
      logDir: cursorHookLogDir,
    });
    this.inputManager.registerInput(cursorHookInput);
    entries.push(
      this.inputManager.buildDetectionEntry(cursorHookInput, {
        watchPaths: [cursorHookLogDir],
        isAvailable: async () => directoryExists(cursorHookLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['cursor-hook']) &&
          this.agentControlManager.resolveEnabled(
            'cursor-hook',
            listenerCfg['cursor-hook']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['cursor-hook']?.pollInterval,
      }),
    );

    // --- Claude Code Log (OTel plugin JSONL) ---
    const claudeCodeLogDir = this.resolveClaudeCodeLogDir();
    const claudeCodeLogInput = new ClaudeCodeLogInput({
      stateStore: this.stateStore,
      logDir: claudeCodeLogDir,
    });
    this.inputManager.registerInput(claudeCodeLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(claudeCodeLogInput, {
        watchPaths: [claudeCodeLogDir],
        isAvailable: async () => directoryExists(claudeCodeLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['claude-code-log']) &&
          this.agentControlManager.resolveEnabled(
            'claude-code-log',
            listenerCfg['claude-code-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['claude-code-log']?.pollInterval,
      }),
    );

    // --- Codex Log (OTel plugin JSONL) ---
    const codexLogDir = this.resolveCodexLogDir();
    const codexLogInput = new CodexLogInput({
      stateStore: this.stateStore,
      logDir: codexLogDir,
    });
    this.inputManager.registerInput(codexLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(codexLogInput, {
        watchPaths: [codexLogDir],
        isAvailable: async () => directoryExists(codexLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['codex-log']) &&
          this.agentControlManager.resolveEnabled(
            'codex-log',
            listenerCfg['codex-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['codex-log']?.pollInterval,
      }),
    );

    // --- OpenCode Log (event_t plugin JSONL) ---
    const opencodeLogDir = path.join(this.dataDir, 'logs', 'opencode');
    const opencodeLogInput = new OpenCodeLogInput({
      stateStore: this.stateStore,
      logDir: opencodeLogDir,
    });
    this.inputManager.registerInput(opencodeLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(opencodeLogInput, {
        watchPaths: [opencodeLogDir],
        isAvailable: async () => directoryExists(opencodeLogDir),
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['opencode-log']) &&
          this.agentControlManager.resolveEnabled(
            'opencode-log',
            listenerCfg['opencode-log']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['opencode-log']?.pollInterval,
      }),
    );

    // --- Wukong (CLI API polling) ---
    const wukongInput = new WukongInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(wukongInput);
    entries.push(
      this.inputManager.buildDetectionEntry(wukongInput, {
        watchPaths: WukongInput.getWatchPaths(),
        isAvailable: WukongInput.checkAvailability,
        enabled: () => this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['wukong']) &&
          this.agentControlManager.resolveEnabled(
            'wukong',
            listenerCfg['wukong']?.enabled ?? true,
          ),
        pollIntervalMs: listenerCfg['wukong']?.pollInterval,
      }),
    );

    return entries;
  }

  private resolveCodexLogDir(): string {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'otel-config.json');
      const raw = fs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg.log_dir && typeof cfg.log_dir === 'string') {
        return cfg.log_dir.replace(/^~/, os.homedir());
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to read codex otel-config.json', { error: String(err) });
      }
    }
    return path.join(this.dataDir, 'logs', 'codex');
  }

  private resolveClaudeCodeLogDir(): string {
    try {
      const configPath = path.join(os.homedir(), '.claude', 'otel-config.json');
      const raw = fs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg.log_dir && typeof cfg.log_dir === 'string') {
        return cfg.log_dir.replace(/^~/, os.homedir());
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to read otel-config.json', { error: String(err) });
      }
    }
    return path.join(this.dataDir, 'logs', 'claude-code');
  }

  /**
   * Check whether an agent is allowed to run based on config.agents gate.
   * - No config.agents or empty: always true (backward compat)
   * - Otherwise: only if config.agents[agentId].enabled !== false
   */
  private isAgentGatedEnabled(agentId: string): boolean {
    const agents = this.config.agents;
    if (!agents || Object.keys(agents).length === 0) return true;
    return agents[agentId]?.enabled !== false;
  }

  /**
   * Resolve the package installation directory by reading the `current` pointer file.
   * Falls back to dataDir if the versioned layout is not in use.
   */
  private readPackageVersion(): string {
    try {
      const pilotDir = this.resolvePilotDir();
      const versionFile = path.join(pilotDir, 'VERSION');
      if (fsSync.existsSync(versionFile)) {
        const content = fsSync.readFileSync(versionFile, 'utf8');
        const match = content.match(/^version=(.+)$/m);
        if (match) return match[1].trim();
      }
    } catch {
      // ignore
    }
    return 'unknown';
  }

  private resolvePilotDir(): string {
    try {
      const currentFile = path.join(this.dataDir, 'current');
      const versionName = fsSync.readFileSync(currentFile, 'utf-8').trim();
      if (versionName) {
        const versionDir = path.join(this.dataDir, 'versions', versionName);
        if (fsSync.existsSync(versionDir)) {
          logger.debug('resolved pilotDir from current pointer', { pilotDir: versionDir });
          return versionDir;
        }
      }
    } catch {
      // current file doesn't exist — legacy or dev layout
    }

    const legacyPackageDir = path.join(this.dataDir, 'package');
    if (fsSync.existsSync(path.join(legacyPackageDir, 'dist', 'index.js'))) {
      return legacyPackageDir;
    }

    return this.dataDir;
  }

  private buildDataflowSnapshot(): DataflowSnapshot {
    const inputCounters = this.inputManager.getInputCounters();
    const activeIds = this.inputManager.getActiveInputIds();

    let sendEntriesTotal = 0;
    let receivedBytesTotal = 0;
    for (const counter of inputCounters.values()) {
      sendEntriesTotal += counter.outEvents;
      receivedBytesTotal += counter.inBytes;
    }

    // Aggregate flusher runner stats
    const flusherRunner = {
      inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
      totalDelayMs: 0, lastFlushTime: '', startTime: '',
    };

    const flushers = new Map<string, { inEntries: number; inBytes: number; outEntries: number; outFailed: number; totalDelayMs: number; lastFlushTime: string; startTime: string; flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>();

    // Get SLS flusher counters if available
    const slsFlusher = this.getSlsFlusher();
    if (slsFlusher) {
      for (const [epName, counter] of slsFlusher.getEndpointCounters()) {
        flusherRunner.inEntries += counter.inEntries;
        flusherRunner.inBytes += counter.inBytes;
        flusherRunner.outEntries += counter.outEntries;
        flusherRunner.outFailed += counter.outFailed;
        flusherRunner.totalDelayMs += counter.totalDelayMs;
        if (counter.lastFlushTime > flusherRunner.lastFlushTime) {
          flusherRunner.lastFlushTime = counter.lastFlushTime;
        }
        if (!flusherRunner.startTime || counter.startTime < flusherRunner.startTime) {
          flusherRunner.startTime = counter.startTime;
        }
        flushers.set(epName, {
          ...counter,
          flusherName: 'sls',
        });
      }
    }

    const inputs = new Map<string, { inEvents: number; inBytes: number; outEvents: number; outFailed: number; lastPollTime: string; startTime: string; type: string }>();
    const inputIdleMinutes = new Map<string, number>();
    for (const [id, counter] of inputCounters) {
      inputs.set(id, { ...counter });
      inputIdleMinutes.set(id, this.inputManager.getInputIdleMinutes(id));
    }

    const agentVersions = this.inputManager.getAgentVersions();

    return {
      sendEntriesTotal,
      receivedBytesTotal,
      inputCount: inputCounters.size,
      activeInputCount: activeIds.length,
      flusherRunner,
      inputs,
      flushers,
      agentVersions,
      inputIdleMinutes,
    };
  }

  private getSlsFlusher(): SlsFlusher | null {
    if (this.flusher instanceof SlsFlusher) return this.flusher;
    if (this.flusher instanceof MultiFlusher) {
      for (const f of this.flusher.getFlushers()) {
        if (f instanceof SlsFlusher) return f;
      }
    }
    return null;
  }

  getAlarmManager(): AlarmManager {
    return this.alarmManager;
  }
}


