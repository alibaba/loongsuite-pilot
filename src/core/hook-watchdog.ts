import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HookWatchdogConfig } from '../types/index.js';
import { directoryExists, fileExists } from '../utils/fs-utils.js';
import { readJsonDocument, type JsonSyntax } from '../utils/json-document.js';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('HookWatchdog');

const STARTUP_DELAY_MS = 30_000;
const REPAIR_TIMEOUT_MS = 30_000;
const MAX_INTERCEPT_REPAIRS_PER_DAY = 3;

export interface PluginCheckTarget {
  agentId: string;
  settingsPath: string;
  /** File syntax. Defaults to strict JSON. */
  settingsSyntax?: JsonSyntax;
  expectedHooks: string[];
  /** Substrings that identify our hook command in settings.json */
  markers: string[];

  /** External command binary path (for plugin-type repair). Required if repairFn is not set. */
  binPath?: string;
  /** Arguments for the external install command. */
  installArgs?: string[];
  /** Direct repair function (for hook-type repair via HookManager). Takes precedence over binPath. */
  repairFn?: () => Promise<boolean>;

  /**
   * Whether the owning agent is enabled by the user's selection
   * (config.agents[<id>].enabled). When this returns false the target is
   * neither checked nor repaired — a disabled agent must never have its hook
   * (re)injected. Omitted → treated as enabled (backward compatible).
   */
  enabled?: () => boolean | Promise<boolean>;
}

export interface InterceptCheckTarget {
  id: string;
  check: () => Promise<boolean>;
  repair: () => Promise<void>;
  precondition: () => Promise<boolean>;
  /**
   * Whether the owning agent is enabled by the user's selection
   * (config.agents[<id>].enabled). When this returns false the target is not
   * (re)injected — instead cleanup() runs (if provided) so the intercept is
   * removed rather than merely left in place. Omitted → treated as enabled
   * (backward compatible).
   */
  enabled?: () => boolean | Promise<boolean>;
  /**
   * Idempotent removal of an already-installed intercept, invoked when
   * enabled() is false. Lets "config disable" actually stop collection (not
   * just stop self-healing) — otherwise a wrapper written on a prior run would
   * keep intercepting for an agent the user has since turned off. Omitted →
   * disabled targets are simply skipped.
   */
  cleanup?: () => Promise<void>;
}

export interface MacRuntimeInterceptDefinition {
  id: string;
  envName: string;
  plistLabel: string;
  agentIds: string[];
  appNames: string[];
}

export interface WinRuntimeInterceptDefinition {
  id: string;
  envName: string;
  agentIds: string[];
  appInstallPaths: string[];
}

/**
 * Remove a marker-delimited block (inclusive of the BEGIN/END marker lines)
 * from rc-file content. Any line containing `begin` starts the cut and any
 * line containing `end` ends it; non-block lines are preserved verbatim.
 */
export function stripMarkerBlock(content: string, begin: string, end: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of content.split('\n')) {
    if (!inBlock && line.includes(begin)) { inBlock = true; continue; }
    if (inBlock && line.includes(end)) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

export function parseWindowsUserEnv(output: string, envName: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
    if (match?.[1]?.toLowerCase() === envName.toLowerCase()) return match[2]?.trim() ?? '';
  }
  return '';
}

function windowsPathsEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function readWindowsUserEnv(envName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reg.exe', [
      'query', 'HKCU\\Environment', '/v', envName,
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return parseWindowsUserEnv(stdout, envName);
  } catch {
    return '';
  }
}

async function broadcastWindowsUserEnv(envName: string, value: string | null): Promise<boolean> {
  const valueExpr = value === null ? '$null' : '$env:LOONGSUITE_PILOT_RUNTIME_ENV_VALUE';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `try { [Environment]::SetEnvironmentVariable($env:LOONGSUITE_PILOT_RUNTIME_ENV_NAME, ${valueExpr}, 'User'); exit 0 } catch { exit 1 }`,
  ].join('; ');
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        LOONGSUITE_PILOT_RUNTIME_ENV_NAME: envName,
        ...(value === null ? {} : { LOONGSUITE_PILOT_RUNTIME_ENV_VALUE: value }),
      },
    });
    return true;
  } catch {
    logger.warn('windows runtime environment persisted but broadcast failed', {
      envName,
      action: 'sign out and back in to refresh Explorer',
    });
    return false;
  }
}

async function setWindowsUserEnv(envName: string, value: string): Promise<void> {
  await execFileAsync('reg.exe', [
    'add', 'HKCU\\Environment', '/v', envName,
    '/t', 'REG_SZ', '/d', value, '/f',
  ], { timeout: 10_000, windowsHide: true });
  await broadcastWindowsUserEnv(envName, value);
}

async function removeWindowsUserEnv(envName: string): Promise<void> {
  await execFileAsync('reg.exe', [
    'delete', 'HKCU\\Environment', '/v', envName, '/f',
  ], { timeout: 10_000, windowsHide: true });
  await broadcastWindowsUserEnv(envName, null);
}

async function cleanupOwnedWindowsUserEnv(envName: string, wrapperPath: string): Promise<boolean> {
  const current = await readWindowsUserEnv(envName);
  if (current && windowsPathsEqual(current, wrapperPath)) {
    await removeWindowsUserEnv(envName);
    return true;
  }
  return false;
}

export interface CheckResult {
  checked: number;
  repaired: number;
  skipped: number;
}

export interface TargetResult {
  agentId: string;
  status: 'healthy' | 'repaired' | 'cooldown' | 'unavailable' | 'invalid-config' | 'repair-failed' | 'disabled';
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
  private readonly lastInvalidConfigByTarget: Map<string, string> = new Map();
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
    this.targets = targets ?? [];
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
        if (result.status === 'unavailable' || result.status === 'invalid-config' || result.status === 'disabled') {
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
    if (target.enabled && !(await target.enabled())) {
      logger.debug('hook-watchdog.skipped', {
        agent: target.agentId,
        reason: 'disabled',
      });
      return { agentId: target.agentId, status: 'disabled' };
    }

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

    const document = await readJsonDocument<Record<string, unknown>>(
      target.settingsPath,
      target.settingsSyntax ?? 'json',
    );
    if (document.status === 'error') {
      return this.reportInvalidConfig(target, document.error.message);
    }
    if (
      document.status === 'ok'
      && (!document.data || typeof document.data !== 'object' || Array.isArray(document.data))
    ) {
      return this.reportInvalidConfig(target, 'settings root must be a JSON object');
    }
    this.lastInvalidConfigByTarget.delete(this.invalidConfigTargetKey(target));
    const settings = document.status === 'ok' ? document.data : null;
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

  private reportInvalidConfig(target: PluginCheckTarget, error: string): TargetResult {
    const targetKey = this.invalidConfigTargetKey(target);
    const previous = this.lastInvalidConfigByTarget.get(targetKey);
    if (previous !== error) {
      logger.error('hook-watchdog.invalid-config', {
        agent: target.agentId,
        settingsPath: target.settingsPath,
        error,
      });
      this.lastInvalidConfigByTarget.set(targetKey, error);
    } else {
      logger.debug('hook-watchdog.invalid-config-suppressed', {
        agent: target.agentId,
        settingsPath: target.settingsPath,
      });
    }
    return { agentId: target.agentId, status: 'invalid-config' };
  }

  private invalidConfigTargetKey(target: PluginCheckTarget): string {
    return `${target.agentId}\0${target.settingsPath}`;
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
        // User-selection gate, checked before any check/repair so a disabled
        // agent never (re)injects and does not consume the cooldown / daily
        // budget. When disabled we also run cleanup() (idempotent) so an
        // intercept written on a prior run is removed — "config disable" stops
        // collection, not just self-healing.
        if (target.enabled && !(await target.enabled())) {
          if (target.cleanup) {
            try {
              await target.cleanup();
              logger.info('intercept-watchdog.disabled-cleanup', { id: target.id });
            } catch (err) {
              logger.warn('intercept-watchdog.cleanup-failed', { id: target.id, error: String(err) });
            }
          } else {
            logger.debug('intercept-watchdog.disabled', { id: target.id });
          }
          summary.skipped++;
          continue;
        }

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


  /**
   * Shell-rc intercept block definitions (qodercli + claude-code).
   *
   * blockFn must stay byte-identical to the block written by the installer
   * (deploy/installer-opensource.sh inject_*), so the marker-based idempotency
   * checks agree. The `if ! alias ... eval '...'` shape guards against
   * clobbering a user's own alias/function AND avoids a parse error: a bare
   * `<cli>()` token would fail to parse under an active alias because
   * interactive shells expand aliases at parse time (before the guard runs), so
   * the definition is deferred behind eval.
   *
   * Exposed as a pure, static seam so tests can render the exact block for any
   * path without touching HOME/fs (see hook-watchdog-intercept-shell.test.ts).
   *
   * `signature` is a substring unique to the CURRENT block shape. check()/
   * repair() use it — not just `marker` — to detect and migrate
   * an older block that shares the same marker (e.g. the released bare
   * `<cli>() {...}` form). Keep it byte-identical to the installer's grep.
   * `endMarker` bounds the block for removal/migration.
   */
  static interceptRcBlockDefs(): Array<{
    id: string;
    agentId: string;
    marker: string;
    endMarker: string;
    signature: string;
    scriptName: string;
    blockFn: (scriptPath: string) => string;
  }> {
    return [
      {
        id: 'qodercli-rc',
        agentId: 'qoder',
        marker: 'loongsuite-pilot BEGIN qodercli-intercept',
        endMarker: 'loongsuite-pilot END qodercli-intercept',
        signature: 'qodercli-runtime-wrapper.sh',
        scriptName: 'qodercli-runtime-wrapper.sh',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN qodercli-intercept',
          'if ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then',
          `  eval 'qodercli() { "${p}" "$@"; }'`,
          'fi',
          '# loongsuite-pilot END qodercli-intercept',
        ].join('\n'),
      },
      {
        id: 'claude-code-rc',
        agentId: 'claude-code',
        marker: 'loongsuite-pilot BEGIN claude-code-intercept',
        endMarker: 'loongsuite-pilot END claude-code-intercept',
        signature: 'if ! alias claude >/dev/null 2>&1',
        scriptName: 'claude-code-fetch-intercept.mjs',
        blockFn: (p) => [
          '',
          '# loongsuite-pilot BEGIN claude-code-intercept',
          'if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then',
          `  eval 'claude() { BUN_OPTIONS="--preload=${p} \${BUN_OPTIONS}" command claude "$@"; }'`,
          'fi',
          '# loongsuite-pilot END claude-code-intercept',
        ].join('\n'),
      },
    ];
  }

  static defaultInterceptTargets(
    dataDir: string,
    isAgentEnabled: (agentId: string) => boolean = () => true,
    // rcPaths is injectable so tests can exercise the real check()/repair()/
    // cleanup() closures against a temp dir instead of the developer's real rc
    // files. Production omits it and uses ~/.zshrc + ~/.bashrc.
    rcPathsOverride?: string[],
  ): InterceptCheckTarget[] {
    const targets: InterceptCheckTarget[] = [];
    const home = os.homedir();

    // ── QoderWork-family launchctl env + LaunchAgent plists (macOS only) ──
    if (process.platform === 'darwin') {
      const wrapperPath = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
      for (const def of HookWatchdog.macRuntimeInterceptDefs()) {
        const plistPath = path.join(home, 'Library', 'LaunchAgents', `${def.plistLabel}.plist`);
        const appPaths = def.appNames.flatMap(appName => [
          path.join('/Applications', appName),
          path.join(home, 'Applications', appName),
        ]);

        targets.push({
          id: def.id,
          enabled: () => def.agentIds.some(agentId => isAgentEnabled(agentId)),
          precondition: async () => {
            if (!await fileExists(wrapperPath)) return false;
            for (const appPath of appPaths) {
              if (await directoryExists(appPath)) return true;
            }
            return false;
          },
          check: async () => {
            try {
              const { stdout } = await execFileAsync('launchctl', ['getenv', def.envName]);
              if (stdout.trim() !== wrapperPath) return false;
              // Also verify plist exists — without it, env is lost on reboot.
              return fileExists(plistPath);
            } catch {
              return false;
            }
          },
          repair: async () => {
            await execFileAsync('launchctl', ['setenv', def.envName, wrapperPath]);
            const plistContent = [
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
              '<plist version="1.0">',
              '<dict>',
              '    <key>Label</key>',
              `    <string>${def.plistLabel}</string>`,
              '    <key>ProgramArguments</key>',
              '    <array>',
              '        <string>/bin/launchctl</string>',
              '        <string>setenv</string>',
              `        <string>${def.envName}</string>`,
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
          cleanup: async () => {
            // Each product-specific target only removes its own env/plist.
            try {
              const { stdout } = await execFileAsync('launchctl', ['getenv', def.envName]);
              if (stdout.trim() === wrapperPath) {
                await execFileAsync('launchctl', ['unsetenv', def.envName]).catch(() => {});
              }
            } catch {
              // getenv fails when unset — nothing to drop.
            }
            if (await fileExists(plistPath)) {
              await execFileAsync('launchctl', ['unload', plistPath]).catch(() => {});
              await fs.rm(plistPath, { force: true }).catch(() => {});
            }
          },
        });
      }
    }

    // ── QoderWork-family Windows User env vars ──
    // HKCU\Environment is permanent across reboots and inherited by every new
    // GUI process. Native reg.exe keeps this path compatible with CLM/WDAC.
    if (process.platform === 'win32') {
      const wrapperPath = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
      for (const def of HookWatchdog.winRuntimeInterceptDefs()) {
        targets.push({
          id: def.id,
          enabled: () => def.agentIds.some(agentId => isAgentEnabled(agentId)),
          precondition: async () => {
            if (!await fileExists(wrapperPath)) {
              let removed = false;
              try {
                removed = await cleanupOwnedWindowsUserEnv(def.envName, wrapperPath);
              } catch (err) {
                logger.debug('windows runtime override cleanup failed', {
                  envName: def.envName,
                  reason: 'wrapper-missing',
                  error: String(err),
                });
              }
              if (removed) {
                logger.warn('windows runtime wrapper missing; removed owned override', {
                  envName: def.envName,
                  wrapperPath,
                });
              }
              return false;
            }
            for (const appPath of def.appInstallPaths) {
              if (await directoryExists(appPath)) return true;
            }
            try {
              await cleanupOwnedWindowsUserEnv(def.envName, wrapperPath);
            } catch (err) {
              logger.debug('windows runtime override cleanup failed', {
                envName: def.envName,
                reason: 'app-missing',
                error: String(err),
              });
            }
            return false;
          },
          check: async () => {
            const current = await readWindowsUserEnv(def.envName);
            return windowsPathsEqual(current, wrapperPath);
          },
          repair: async () => {
            await setWindowsUserEnv(def.envName, wrapperPath);
          },
          cleanup: async () => {
            await cleanupOwnedWindowsUserEnv(def.envName, wrapperPath);
          },
        });
      }
    }

    // ── Shell rc intercept targets (qodercli + claude-code) ──
    // Check BOTH .zshrc and .bashrc regardless of daemon's $SHELL — the
    // daemon is launchd-started and its $SHELL may not match the user's
    // interactive shell. Installer's remove function also scans all rc files.
    const rcPaths = rcPathsOverride ?? [
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
    ];

    for (const rc of HookWatchdog.interceptRcBlockDefs()) {
      const scriptPath = path.join(dataDir, 'hooks', rc.scriptName);

      targets.push({
        id: rc.id,
        enabled: () => isAgentEnabled(rc.agentId),
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
          // Health is keyed on block CONTENT, not just the marker: an older
          // released block shares the same marker but lacks `signature`, and
          // must be migrated. A stale block anywhere → unhealthy (repair).
          let anyCurrent = false;
          let anyRcExists = false;
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue;
            anyRcExists = true;
            const content = await fs.readFile(rcPath, 'utf-8');
            if (content.includes(rc.marker)) {
              if (content.includes(rc.signature)) anyCurrent = true;
              else return false; // marker present but old shape → migrate
            }
          }
          if (anyCurrent) return true;
          // No block present anywhere. If no rc files exist, nothing to repair
          // into → healthy; otherwise repair() will append.
          return !anyRcExists;
        },
        repair: async () => {
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue; // never create rc files
            const content = await fs.readFile(rcPath, 'utf-8');
            if (content.includes(rc.marker)) {
              if (content.includes(rc.signature)) continue; // already current
              // Stale block: strip the old marker region, then append fresh.
              const stripped = stripMarkerBlock(content, rc.marker, rc.endMarker).replace(/\n+$/, '\n');
              await fs.writeFile(rcPath, stripped + rc.blockFn(scriptPath) + '\n');
            } else {
              await fs.appendFile(rcPath, rc.blockFn(scriptPath) + '\n');
            }
          }
        },
        cleanup: async () => {
          // Disabled agent: remove our block from every rc file (idempotent).
          for (const rcPath of rcPaths) {
            if (!await fileExists(rcPath)) continue;
            const content = await fs.readFile(rcPath, 'utf-8');
            if (!content.includes(rc.marker)) continue;
            const stripped = stripMarkerBlock(content, rc.marker, rc.endMarker).replace(/\n{3,}$/, '\n\n');
            await fs.writeFile(rcPath, stripped);
          }
        },
      });
    }

    return targets;
  }

  /** Keep the watchdog's product/env/app mapping aligned with the installer. */
  static macRuntimeInterceptDefs(): MacRuntimeInterceptDefinition[] {
    return [
      {
        id: 'qoderwork-env',
        envName: 'QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qoderwork-env',
        agentIds: ['qoder-work', 'qoder-work-cn'],
        appNames: ['QoderWork.app', 'QoderWork CN.app', 'QoderWorkCN.app'],
      },
      {
        id: 'qwenworkcn-env',
        envName: 'QW_QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qwenworkcn-env',
        agentIds: ['qwen-work-cn'],
        appNames: ['QwenWorkCN.app'],
      },
    ];
  }

  /** Windows product-specific User-level runtime overrides. */
  static winRuntimeInterceptDefs(): WinRuntimeInterceptDefinition[] {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      {
        id: 'qwenworkcn-win-env',
        envName: 'QW_QODER_WORKER_RUNTIME_PATH',
        agentIds: ['qwen-work-cn'],
        appInstallPaths: [path.join(localAppData, 'Programs', 'QwenWorkCN')],
      },
      {
        id: 'qoderwork-win-env',
        envName: 'QODER_WORKER_RUNTIME_PATH',
        agentIds: ['qoder-work', 'qoder-work-cn'],
        appInstallPaths: [
          path.join(localAppData, 'Programs', 'QoderWork'),
          path.join(localAppData, 'Programs', 'QoderWorkCN'),
          path.join(localAppData, 'Programs', 'QoderWork CN'),
        ],
      },
    ];
  }
}
