import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HookWatchdogConfig } from '../types/index.js';
import { directoryExists, fileExists, readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('HookWatchdog');

const STARTUP_DELAY_MS = 30_000;
const REPAIR_TIMEOUT_MS = 30_000;
const MAX_INTERCEPT_REPAIRS_PER_DAY = 3;

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

export interface InterceptCheckTarget {
  id: string;
  check: () => Promise<boolean>;
  repair: () => Promise<void>;
  precondition: () => Promise<boolean>;
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
  private readonly interceptTargets: InterceptCheckTarget[];
  private readonly lastRepairAt: Map<string, number> = new Map();
  private readonly dailyRepairCount: Map<string, number> = new Map();
  private dailyRepairResetDate = '';
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: HookWatchdogConfig,
    targets?: PluginCheckTarget[],
    interceptTargets?: InterceptCheckTarget[],
  ) {
    this.config = config;
    this.targets = targets ?? HookWatchdog.defaultTargets();
    this.interceptTargets = interceptTargets ?? [];
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

    await this.checkInterceptTargets(summary);

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

  // ─── Intercept self-healing ─────────────────────────────────────────────

  private async checkInterceptTargets(summary: CheckResult): Promise<void> {
    this.resetDailyCounterIfNeeded();

    for (const target of this.interceptTargets) {
      try {
        const preOk = await target.precondition();
        if (!preOk) {
          logger.debug('intercept-watchdog.skipped', { id: target.id, reason: 'precondition' });
          summary.skipped++;
          continue;
        }

        const healthy = await target.check();
        if (healthy) {
          logger.debug('intercept-watchdog.healthy', { id: target.id });
          summary.checked++;
          continue;
        }

        const lastAt = this.lastRepairAt.get(target.id);
        if (lastAt !== undefined && Date.now() - lastAt < this.config.repairCooldownMs) {
          logger.debug('intercept-watchdog.cooldown', { id: target.id });
          continue;
        }

        const dayKey = target.id;
        const count = this.dailyRepairCount.get(dayKey) ?? 0;
        if (count >= MAX_INTERCEPT_REPAIRS_PER_DAY) {
          logger.warn('intercept-watchdog.daily-limit', { id: target.id, count });
          continue;
        }

        logger.warn('intercept-watchdog.repairing', { id: target.id });
        await target.repair();
        this.lastRepairAt.set(target.id, Date.now());
        this.dailyRepairCount.set(dayKey, count + 1);
        summary.repaired++;
        logger.info('intercept-watchdog.repaired', { id: target.id });
      } catch (err) {
        logger.warn('intercept-watchdog.repair-failed', { id: target.id, error: String(err) });
      }
    }
  }

  private resetDailyCounterIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyRepairResetDate) {
      this.dailyRepairCount.clear();
      this.dailyRepairResetDate = today;
    }
  }

  // ─── Default targets (hardcoded, matching existing style) ───────────────

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

  static defaultInterceptTargets(dataDir: string): InterceptCheckTarget[] {
    const targets: InterceptCheckTarget[] = [];
    const home = os.homedir();

    // ── qoderwork-env: launchctl env + LaunchAgent plist (macOS only) ──
    if (process.platform === 'darwin') {
      const wrapperPath = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
      const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.loongsuite-pilot.qoderwork-env.plist');
      const plistLabel = 'com.loongsuite-pilot.qoderwork-env';

      targets.push({
        id: 'qoderwork-env',
        precondition: async () => {
          if (!await fileExists(wrapperPath)) return false;
          const sysApp = await directoryExists('/Applications/QoderWork.app');
          const userApp = await directoryExists(path.join(home, 'Applications', 'QoderWork.app'));
          return sysApp || userApp;
        },
        check: async () => {
          try {
            const { stdout } = await execFileAsync('launchctl', ['getenv', 'QODER_WORKER_RUNTIME_PATH']);
            if (stdout.trim() !== wrapperPath) return false;
            // Also verify plist exists — without it, env is lost on reboot.
            return fileExists(plistPath);
          } catch {
            return false;
          }
        },
        repair: async () => {
          await execFileAsync('launchctl', ['setenv', 'QODER_WORKER_RUNTIME_PATH', wrapperPath]);
          const plistContent = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            '<dict>',
            '    <key>Label</key>',
            `    <string>${plistLabel}</string>`,
            '    <key>ProgramArguments</key>',
            '    <array>',
            '        <string>/bin/launchctl</string>',
            '        <string>setenv</string>',
            '        <string>QODER_WORKER_RUNTIME_PATH</string>',
            `        <string>${wrapperPath}</string>`,
            '    </array>',
            '    <key>RunAtLoad</key>',
            '    <true/>',
            '</dict>',
            '</plist>',
            '',
          ].join('\n');
          await fs.mkdir(path.dirname(plistPath), { recursive: true });
          await fs.writeFile(plistPath, plistContent);
          // NOTE: launchctl load/unload is deprecated since macOS 10.11 in
          // favour of `launchctl bootstrap/bootout gui/<uid>`. We keep
          // load/unload for now because it still works reliably across all
          // supported macOS versions and avoids the uid lookup complexity.
          await execFileAsync('launchctl', ['unload', plistPath]).catch(() => {});
          await execFileAsync('launchctl', ['load', plistPath]).catch(() => {});
        },
      });
    }

    // ── Shell rc intercept targets (qodercli + claude-code) ──
    // Check BOTH .zshrc and .bashrc regardless of daemon's $SHELL — the
    // daemon is launchd-started and its $SHELL may not match the user's
    // interactive shell. Installer's remove function also scans all rc files.
    const rcPaths = [
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
    ];

    const rcTargets: Array<{
      id: string;
      marker: string;
      scriptName: string;
      blockFn: (scriptPath: string) => string;
    }> = [
      {
        id: 'qodercli-rc',
        marker: 'loongsuite-pilot BEGIN qodercli-intercept',
        scriptName: 'qodercli-token-intercept.mjs',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN qodercli-intercept',
          `qodercli() { BUN_OPTIONS="--preload=${p}" command qodercli "$@"; }`,
          '# loongsuite-pilot END qodercli-intercept',
        ].join('\n'),
      },
      {
        id: 'claude-code-rc',
        marker: 'loongsuite-pilot BEGIN claude-code-intercept',
        scriptName: 'claude-code-fetch-intercept.mjs',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN claude-code-intercept',
          `claude() { BUN_OPTIONS="--preload=${p} \${BUN_OPTIONS}" command claude "$@"; }`,
          '# loongsuite-pilot END claude-code-intercept',
        ].join('\n'),
      },
    ];

    for (const rc of rcTargets) {
      const scriptPath = path.join(dataDir, 'hooks', rc.scriptName);

      targets.push({
        id: rc.id,
        precondition: async () => {
          // Only check if the hook script was deployed by the installer.
          // We intentionally do NOT run `which <cli>` — the daemon process
          // is launchd-started with a minimal PATH that likely doesn't
          // include ~/.local/bin or npm global dirs, and shell wrapper
          // functions (qodercli/claude) are invisible to /usr/bin/which
          // in a non-interactive subprocess. Hook script existence is a
          // sufficient signal that the installer set this agent up.
          return fileExists(scriptPath);
        },
        check: async () => {
          // Check ALL common rc files — marker must exist in at least one.
          for (const rcPath of rcPaths) {
            try {
              const content = await fs.readFile(rcPath, 'utf-8');
              if (content.includes(rc.marker)) return true;
            } catch {
              // file doesn't exist, check next
            }
          }
          // Not found in any existing rc file. If no rc files exist at all,
          // there's nothing we can repair into, so treat as healthy.
          const anyRcExists = (await Promise.all(rcPaths.map(p => fileExists(p)))).some(Boolean);
          return !anyRcExists;
        },
        repair: async () => {
          // Append to ALL existing rc files that don't already have the marker.
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue; // never create rc files
            const content = await fs.readFile(rcPath, 'utf-8');
            if (content.includes(rc.marker)) continue; // already present
            await fs.appendFile(rcPath, rc.blockFn(scriptPath) + '\n');
          }
        },
      });
    }

    return targets;
  }
}
