import { EventEmitter } from 'node:events';
import type { AnalyticsConfig, AgentDetectionEntry } from '../types/index.js';
import { AgentControlManager } from './agent-control-manager.js';
import { AgentDiscoveryService } from './agent-discovery-service.js';
import { InputManager } from './input-manager.js';
import { StateStore } from '../checkpoints/state-store.js';
import { HookManager } from '../hooks/hook-manager.js';
import { createLogger } from '../utils/logger.js';
import { resolveHome, ensureDir, directoryExists, readJsonFile, writeJsonFile } from '../utils/fs-utils.js';
import * as path from 'node:path';

// Flushers
import { BaseFlusher } from '../flushers/base-flusher.js';
import { SlsFlusher } from '../flushers/sls-flusher.js';
import { JsonlFlusher } from '../flushers/jsonl-flusher.js';
import { HttpFlusher } from '../flushers/http-flusher.js';
import { MultiFlusher } from '../flushers/multi-flusher.js';

// Concrete inputs
import { QoderSqliteInput } from '../inputs/qoder-sqlite/qoder-sqlite-input.js';
import { QoderWorkInput } from '../inputs/qoder-work/qoder-work-input.js';
import { QoderWorkLogInput } from '../inputs/qoder-work-log/qoder-work-log-input.js';
import { QoderWorkSqliteInput } from '../inputs/qoder-work-sqlite/qoder-work-sqlite-input.js';
import { QoderCliInput } from '../inputs/qoder-cli/qoder-cli-input.js';
import { QoderCliSessionInput } from '../inputs/qoder-cli-session/qoder-cli-session-input.js';
import { CursorHookInput } from '../inputs/cursor-hook/cursor-hook-input.js';
import { ClaudeCodeLogInput } from '../inputs/claude-code-log/claude-code-log-input.js';
import { CodexLogInput } from '../inputs/codex-log/codex-log-input.js';

import { LogRetentionService } from './log-retention-service.js';
import { PluginHookWatchdog } from './plugin-hook-watchdog.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

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
  private readonly config: AnalyticsConfig;
  private readonly dataDir: string;
  private agentControlManager!: AgentControlManager;
  private agentDiscoveryService!: AgentDiscoveryService;
  private inputManager!: InputManager;
  private stateStore!: StateStore;
  private flusher!: BaseFlusher;
  private logRetentionService!: LogRetentionService;
  private hookWatchdog!: PluginHookWatchdog;
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
    this.inputManager.setConfiguredUserId(this.config.userId);
    this.inputManager.setAgentsConfig(this.config.agents);

    // 5. Install hooks into agent config files (best-effort, non-blocking)
    await this.installHooks();

    // 6. Register inputs & build detection entries
    const detectionEntries = await this.registerAllInputs();

    // 7. Start AgentDiscoveryService
    this.agentDiscoveryService = new AgentDiscoveryService(detectionEntries);
    this.agentDiscoveryService.on('agent:started', (id: string) => {
      logger.info('agent detected and started', { id });
    });
    this.agentDiscoveryService.on('agent:stopped', (id: string) => {
      logger.info('agent stopped', { id });
    });
    await this.agentDiscoveryService.start();

    // 8. Start log retention service
    this.logRetentionService = new LogRetentionService(this.dataDir, this.config.retention);
    this.logRetentionService.start();

    // 9. Start plugin hook watchdog (periodically restores Claude/Codex hooks
    //    if other tools overwrite ~/.claude/settings.json or ~/.codex/hooks.json)
    this.hookWatchdog = new PluginHookWatchdog(this.config.hookWatchdog);
    this.hookWatchdog.start();

    this.isRunning = true;
    this.emit('started');
    logger.info('orchestrator started', {
      inputs: detectionEntries.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    logger.info('stopping orchestrator');

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

  /**
   * Set a fallback user id (typically resolved asynchronously).
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

    // --- Qoder (SQLite token usage polling) ---
    const qoderSqliteInput = new QoderSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderSqliteInput, {
        watchPaths: QoderSqliteInput.getWatchPaths(),
        isAvailable: QoderSqliteInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-sqlite',
          listenerCfg['qoder-sqlite']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-sqlite']?.pollInterval,
      }),
    );

    // --- Qoder Work (Hook JSONL) ---
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
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-work',
          listenerCfg['qoder-work']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-work']?.pollInterval,
      }),
    );

    // --- Qoder Work (SDK Log tail) ---
    const qoderWorkLogInput = new QoderWorkLogInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkLogInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkLogInput, {
        watchPaths: QoderWorkLogInput.getWatchPaths(),
        isAvailable: QoderWorkLogInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-work-log',
          listenerCfg['qoder-work-log']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-work-log']?.pollInterval,
      }),
    );

    // --- Qoder Work (SQLite agents.db) ---
    const qoderWorkSqliteInput = new QoderWorkSqliteInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderWorkSqliteInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderWorkSqliteInput, {
        watchPaths: QoderWorkSqliteInput.getWatchPaths(),
        isAvailable: QoderWorkSqliteInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
          'qoder-work-sqlite',
          listenerCfg['qoder-work-sqlite']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['qoder-work-sqlite']?.pollInterval,
      }),
    );

    // --- Qoder CLI (Hook JSONL) ---
    const qoderCliLogDir = path.join(this.dataDir, 'logs', 'qoder-cli', 'history');
    const qoderCliInput = new QoderCliInput({
      stateStore: this.stateStore,
      logDir: qoderCliLogDir,
    });
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

    // --- Qoder CLI (Native session segments) ---
    const qoderCliSessionInput = new QoderCliSessionInput({ stateStore: this.stateStore });
    this.inputManager.registerInput(qoderCliSessionInput);
    entries.push(
      this.inputManager.buildDetectionEntry(qoderCliSessionInput, {
        watchPaths: QoderCliSessionInput.getWatchPaths(),
        isAvailable: QoderCliSessionInput.checkAvailability,
        enabled: () => this.agentControlManager.resolveEnabled(
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
        enabled: () => this.agentControlManager.resolveEnabled(
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
        enabled: () => this.agentControlManager.resolveEnabled(
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
        enabled: () => this.agentControlManager.resolveEnabled(
          'codex-log',
          listenerCfg['codex-log']?.enabled ?? true,
        ),
        pollIntervalMs: listenerCfg['codex-log']?.pollInterval,
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
}
