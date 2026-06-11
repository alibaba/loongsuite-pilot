import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { HookWatchdogConfig } from '../types/index.js';
import { directoryExists, fileExists, readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HookWatchdog');

const STARTUP_DELAY_MS = 30_000;
const REPAIR_TIMEOUT_MS = 30_000;

export interface PluginCheckTarget {
  agentId: string;
  settingsPath: string;
  expectedHooks: string[];
  /** Substrings that identify our hook command in settings.json */
  markers: string[];

  /** External command binary path (for plugin-type repair). Required if repairFn is not set. */
  binPath?: string;
  /** Arguments for the external install command. */
  installArgs?: string[];
  /** Direct repair function (for hook-type repair via HookManager). Takes precedence over binPath. */
  repairFn?: () => Promise<boolean>;
}

export interface CheckResult {
  checked: number;
  repaired: number;
  skipped: number;
}

export interface TargetResult {
  agentId: string;
  status: 'healthy' | 'repaired' | 'cooldown' | 'unavailable' | 'repair-failed';
  expected?: number;
  found?: number;
  missing?: string[];
}

/**
 * Periodically verifies that our hook commands are still registered in agent
 * settings files. Supports two repair strategies:
 *
 * - Command-based (plugin agents): spawns an external install command
 * - Function-based (hook agents): calls HookManager.deploy() directly
 *
 * When hooks go missing (e.g. overwritten by another tool sharing the same
 * settings file), the watchdog detects and restores them.
 */
export class HookWatchdog {
  private readonly config: HookWatchdogConfig;
  private readonly targets: PluginCheckTarget[];
  private readonly lastRepairAt: Map<string, number> = new Map();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HookWatchdogConfig, targets?: PluginCheckTarget[]) {
    this.config = config;
    this.targets = targets ?? HookWatchdog.defaultTargets();
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('hook-watchdog disabled');
      return;
    }
    logger.info('scheduling hook watchdog', {
      intervalMs: this.config.intervalMs,
      repairCooldownMs: this.config.repairCooldownMs,
      targets: this.targets.map(t => t.agentId),
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCheck();
      this.intervalTimer = setInterval(() => void this.runCheck(), this.config.intervalMs);
    }, STARTUP_DELAY_MS);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async runCheck(): Promise<CheckResult> {
    const summary: CheckResult = { checked: 0, repaired: 0, skipped: 0 };

    for (const target of this.targets) {
      try {
        const result = await this.checkTarget(target);
        if (result.status === 'unavailable') {
          summary.skipped++;
        } else if (result.status === 'repaired') {
          summary.repaired++;
        } else {
          summary.checked++;
        }
      } catch (err) {
        logger.error('hook-watchdog target failed', {
          agent: target.agentId,
          error: String(err),
        });
      }
    }

    return summary;
  }

  private async checkTarget(target: PluginCheckTarget): Promise<TargetResult> {
    const settingsDirOk = await directoryExists(path.dirname(target.settingsPath));
    if (!settingsDirOk) {
      logger.debug('hook-watchdog.skipped', {
        agent: target.agentId,
        reason: 'settings-dir-missing',
      });
      return { agentId: target.agentId, status: 'unavailable' };
    }

    if (!target.repairFn && target.binPath) {
      const binOk = await fileExists(target.binPath);
      if (!binOk) {
        logger.debug('hook-watchdog.skipped', {
          agent: target.agentId,
          reason: 'bin-missing',
        });
        return { agentId: target.agentId, status: 'unavailable' };
      }
    }

    const settings = await readJsonFile<Record<string, unknown>>(target.settingsPath);
    const missing = this.findMissingHooks(settings, target);
    const found = target.expectedHooks.length - missing.length;

    if (missing.length === 0) {
      logger.info('hook-watchdog.check', {
        agent: target.agentId,
        expected: target.expectedHooks.length,
        found,
        healthy: true,
      });
      return {
        agentId: target.agentId,
        status: 'healthy',
        expected: target.expectedHooks.length,
        found,
      };
    }

    const lastAt = this.lastRepairAt.get(target.agentId);
    if (lastAt !== undefined) {
      const sinceLast = Date.now() - lastAt;
      if (sinceLast < this.config.repairCooldownMs) {
        logger.debug('hook-watchdog.skipped', {
          agent: target.agentId,
          reason: 'cooldown',
          remainingMs: this.config.repairCooldownMs - sinceLast,
          missing,
        });
        return { agentId: target.agentId, status: 'cooldown', missing };
      }
    }

    logger.warn('hook-watchdog.repair', {
      agent: target.agentId,
      expected: target.expectedHooks.length,
      found,
      missing,
      action: target.repairFn ? 'hook-manager' : 'install',
    });

    const ok = await this.repairTarget(target);
    this.lastRepairAt.set(target.agentId, Date.now());

    if (!ok) {
      return { agentId: target.agentId, status: 'repair-failed', missing };
    }
    return { agentId: target.agentId, status: 'repaired', missing };
  }

  private findMissingHooks(
    settings: Record<string, unknown> | null,
    target: PluginCheckTarget,
  ): string[] {
    const missing: string[] = [];
    const hooksRoot = settings?.hooks as Record<string, unknown> | undefined;

    for (const event of target.expectedHooks) {
      const arr = hooksRoot?.[event];
      if (!Array.isArray(arr)) {
        missing.push(event);
        continue;
      }
      const hasOurs = arr.some(entry => this.entryContainsMarker(entry, target.markers));
      if (!hasOurs) missing.push(event);
    }

    return missing;
  }

  private entryContainsMarker(entry: unknown, markers: string[]): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;

    const cmd = typeof e.command === 'string' ? e.command : '';
    if (cmd && markers.some(m => cmd.includes(m))) return true;

    if (Array.isArray(e.hooks)) {
      return e.hooks.some(sub => {
        if (!sub || typeof sub !== 'object') return false;
        const c = (sub as Record<string, unknown>).command;
        return typeof c === 'string' && markers.some(m => c.includes(m));
      });
    }

    return false;
  }

  private async repairTarget(target: PluginCheckTarget): Promise<boolean> {
    if (target.repairFn) {
      try {
        return await target.repairFn();
      } catch (err) {
        logger.error('hook-watchdog.repair-failed', {
          agent: target.agentId,
          error: String(err),
        });
        return false;
      }
    }
    return this.repairViaCommand(target);
  }

  private repairViaCommand(target: PluginCheckTarget): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const child = spawn(process.execPath, [target.binPath!, ...target.installArgs!], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        logger.error('hook-watchdog.repair-timeout', {
          agent: target.agentId,
          timeoutMs: REPAIR_TIMEOUT_MS,
        });
        resolve(false);
      }, REPAIR_TIMEOUT_MS);

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error('hook-watchdog.repair-failed', {
          agent: target.agentId,
          error: String(err),
        });
        resolve(false);
      });

      child.on('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          logger.info('hook-watchdog.repair-ok', { agent: target.agentId });
          resolve(true);
        } else {
          logger.error('hook-watchdog.repair-failed', {
            agent: target.agentId,
            exitCode: code,
            stderr: stderr.slice(0, 500),
          });
          resolve(false);
        }
      });
    });
  }

  static defaultTargets(): PluginCheckTarget[] {
    return [
      {
        agentId: 'claude-code',
        settingsPath: resolveHome('~/.claude/settings.json'),
        expectedHooks: [
          'Stop',
          'SubagentStart',
          'SubagentStop',
        ],
        binPath: resolveHome(
          '~/.cache/opentelemetry.instrumentation.claude/package/bin/otel-claude-hook',
        ),
        installArgs: ['install', '--user', '--no-alias', '--quiet'],
        markers: ['otel-claude-hook', 'opentelemetry.instrumentation.claude'],
      },
      {
        agentId: 'codex',
        settingsPath: resolveHome('~/.codex/hooks.json'),
        expectedHooks: [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
        ],
        binPath: resolveHome(
          '~/.cache/opentelemetry.instrumentation.codex/package/bin/otel-codex-hook',
        ),
        installArgs: ['install'],
        markers: ['otel-codex-hook', 'opentelemetry.instrumentation.codex'],
      },
    ];
  }
}
