import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { EvaluateHookResponse, HookRequest } from '../types.js';
import { reportInterceptorDiagnostic, type InterceptorDiagnosticObserver } from '../diagnostics.js';
import {
  managedInterceptorPath,
  managedScriptFileName,
  managedScriptsDir,
  parseManagedInterceptorConfig,
  platformManagedShell,
  scriptRulesOf,
  type ManagedInterceptorConfig,
  type ManagedScriptRule,
} from './config.js';
import { ManagedRuleEngine, type ResolvedScriptRule, type ScriptRunners } from './engine.js';
import { PowerShellPool } from './powershell-pool.js';
import { ManagedRegexRunner } from './regex-runner.js';
import { ShScriptRunner } from './sh-runner.js';
import type { InterceptorRuleStatus } from '../status.js';

const logger = createLogger('ManagedInterceptor');

export const MANAGED_RELOAD_INTERVAL_MS = 3_000;

export interface ManagedInterceptorOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Test seam; `scriptsDir` is the real path the resolved files live under. */
  createRunners?: (scriptsDir: string, platform: NodeJS.Platform) => ScriptRunners;
  /** Shared script time budget per hook; defaults to MANAGED_SCRIPT_BUDGET_MS. */
  budgetMs?: number;
  /** Cap for one managed regex match. A stuck pattern is killed, not run on this thread. */
  regexTimeoutMs?: number;
  onActiveChange?: (active: boolean) => void;
  onDiagnostic?: InterceptorDiagnosticObserver;
}

interface Generation {
  key: string;
  engine: ManagedRuleEngine;
  rulesById: Map<string, ResolvedScriptRule>;
  files: Set<string>;
  runners: ScriptRunners;
  inflight: number;
  retired: boolean;
  status: Pick<InterceptorRuleStatus, 'effective' | 'pattern' | 'regex' | 'substring' | 'script' | 'audit' | 'enforce'>;
}

/**
 * Owns configs/managed/interceptor.json and the script directory. A new engine
 * generation is published only when every rule in it points at a file already
 * on disk, so a server-side version bump never leaves a window with neither the
 * old nor the new script enforcing.
 */
export class ManagedInterceptor {
  private readonly platform: NodeJS.Platform;
  private current: Generation | null = null;
  private readonly retired = new Set<Generation>();
  /** File names named by the latest valid rule list, kept even if not yet active. */
  private listedFiles = new Set<string>();
  private runners: ScriptRunners | null = null;
  private runnersDir: string | null = null;
  private readonly regex: ManagedRegexRunner;
  private timer: NodeJS.Timeout | null = null;
  private lastProblem: string | null = null;
  private lastResolution: string | null = null;
  private configuredRules = 0;
  private pendingScripts = 0;
  private unsupportedHttp = 0;

  constructor(private readonly opts: ManagedInterceptorOptions) {
    this.platform = opts.platform ?? process.platform;
    this.regex = new ManagedRegexRunner(opts.regexTimeoutMs);
  }

  get active(): boolean {
    return this.current !== null;
  }

  getRuleStatus(): InterceptorRuleStatus {
    return {
      configured: this.configuredRules, config_valid: this.lastProblem === null,
      pending_scripts: this.pendingScripts, unsupported_http: this.unsupportedHttp,
      ...(this.current?.status ?? { effective: 0, pattern: 0, regex: 0, substring: 0, script: 0, audit: 0, enforce: 0 }),
    };
  }

  start(intervalMs = MANAGED_RELOAD_INTERVAL_MS): void {
    this.reload();
    if (this.timer) return;
    this.timer = setInterval(() => this.reload(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const runners = new Set([this.runners, this.current?.runners, ...[...this.retired].map(generation => generation.runners)]);
    for (const set of runners) this.stopRunners(set);
    this.runners = null;
    this.runnersDir = null;
    this.regex.stop();
  }

  /**
   * Returns null when no managed rules are in effect. The generation is
   * captured synchronously, so a swap during evaluation does not affect it.
   */
  evaluate(request: HookRequest): Promise<EvaluateHookResponse> | null {
    const generation = this.current;
    if (!generation) return null;
    generation.inflight += 1;
    return generation.engine.evaluate(request).finally(() => {
      generation.inflight -= 1;
      if (generation.retired && generation.inflight === 0) this.cleanup(generation);
    });
  }

  reload(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(managedInterceptorPath(this.opts.dataDir), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastProblem = null;
        this.configuredRules = this.pendingScripts = this.unsupportedHttp = 0;
        this.listedFiles = new Set();
        this.publish(null);
        return;
      }
      this.reportProblem(`read failed: ${String(err)}`);
      return;
    }
    let config: ManagedInterceptorConfig;
    try {
      config = parseManagedInterceptorConfig(JSON.parse(raw.replace(/^\uFEFF/, '')), { allowLocalScriptCache: true });
    } catch (err) {
      // A bad file on disk keeps the generation already in memory.
      this.reportProblem(`invalid interceptor.json: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.lastProblem = null;
    this.apply(config);
  }

  private apply(config: ManagedInterceptorConfig): void {
    this.configuredRules = config.rules.length;
    this.unsupportedHttp = config.rules.filter(rule => rule.kind === 'http').length;
    const platformShell = platformManagedShell(this.platform);
    const scriptRules = scriptRulesOf(config);
    const localScripts = scriptRules.filter(rule => rule.shell === platformShell);
    const scriptsDir = resolveScriptsDir(this.opts.dataDir, config.scriptCache);
    this.listedFiles = new Set(scriptsDir ? localScripts.map(rule => path.join(scriptsDir, managedScriptFileName(rule))) : []);
    const effective: ManagedInterceptorConfig['rules'] = [];
    const rules: ResolvedScriptRule[] = [];
    const pending: string[] = [];
    for (const rule of config.rules) {
      if (rule.kind !== 'script') {
        effective.push(rule);
        continue;
      }
      if (rule.shell !== platformShell) continue;
      const file = scriptsDir ? this.resolveFile(scriptsDir, rule) : null;
      if (file) {
        rules.push({ rule, file, shell: rule.shell });
        effective.push(rule);
        continue;
      }
      pending.push(`${rule.id}@${rule.version}`);
      // Body of this version is not on disk yet. Keep the previous generation
      // whole (scope, version, title, message, and file) only while that
      // generation's own file is still there. A deleted script removes every
      // version file, so this does not keep running it. A cold start has no
      // in-memory generation; providers should leave the previous interceptor.json
      // in place until the new script file exists, so a restart loads that
      // whole generation instead of pairing new metadata with a missing file.
      const previous = this.current?.rulesById.get(rule.id);
      if (previous && previous.rule.version !== rule.version && scriptsDir
        && path.dirname(previous.file) === scriptsDir && this.resolveFile(scriptsDir, previous.rule)) {
        rules.push(previous);
        effective.push(previous.rule);
      }
    }
    this.pendingScripts = pending.length;
    this.logResolution(pending);

    const hasInline = effective.some(rule => rule.kind === 'pattern' || rule.kind === 'http');
    if (!hasInline && rules.length === 0) {
      this.publish(null);
      return;
    }
    const published: ManagedInterceptorConfig = { rules: effective };
    const key = JSON.stringify({
      rules: published.rules.map(rule => [
        rule.kind, rule.id, rule.version, rule.agents, rule.events, rule.action,
        rule.title ?? '', rule.message ?? '', rule.severity ?? '',
        rule.kind === 'pattern' ? [rule.match, rule.pattern] : null,
        rule.kind === 'script' ? rule.shell : null,
        rule.kind === 'http' ? rule.url : null,
      ]),
      scripts: rules.map(({ rule, file }) => [rule.id, rule.version, rule.shell, file]),
    });
    this.publish({ key, config: published, rules });
  }

  private publish(next: { key: string; config: ManagedInterceptorConfig; rules: ResolvedScriptRule[] } | null): void {
    const previous = this.current;
    if ((previous?.key ?? null) === (next?.key ?? null)) return;

    if (next) {
      const runners = next.rules.length > 0 ? this.ensureRunners(path.dirname(next.rules[0].file)) : {};
      this.current = {
        key: next.key,
        status: {
          effective: next.config.rules.filter(rule => rule.kind !== 'http').length,
          pattern: next.config.rules.filter(rule => rule.kind === 'pattern').length,
          regex: next.config.rules.filter(rule => rule.kind === 'pattern' && rule.match === 'regex').length,
          substring: next.config.rules.filter(rule => rule.kind === 'pattern' && rule.match === 'substring').length,
          script: next.rules.length,
          audit: next.config.rules.filter(rule => rule.kind !== 'http' && rule.action === 'log').length,
          enforce: next.config.rules.filter(rule => rule.kind !== 'http' && rule.action === 'block').length,
        },
        engine: new ManagedRuleEngine({
          config: next.config,
          rules: next.rules,
          runners,
          budgetMs: this.opts.budgetMs,
          regex: this.regex,
          regexTimeoutMs: this.opts.regexTimeoutMs,
          onDiagnostic: this.opts.onDiagnostic,
        }),
        rulesById: new Map(next.rules.map(resolved => [resolved.rule.id, resolved])),
        files: new Set(next.rules.map(resolved => resolved.file)),
        runners,
        inflight: 0,
        retired: false,
      };
      if (next.rules.some(({ shell }) => shell === 'powershell')) runners.powershell?.warm?.();
      const httpRules = next.config.rules.filter(rule => rule.kind === 'http');
      if (httpRules.length > 0) {
        logger.warn('managed HTTP rules are not implemented and will be skipped', {
          rules: httpRules.map(rule => `${rule.id}@${rule.version}`),
        });
      }
      logger.info('managed interceptor rules swapped in', {
        rules: next.config.rules.map(rule => `${rule.kind}:${rule.id}@${rule.version}`),
        scripts: next.rules.map(({ rule }) => `${rule.id}@${rule.version}`),
      });
    } else {
      this.current = null;
      logger.info('managed interceptor rules inactive; local interceptor.mode applies');
    }

    if (previous) {
      previous.retired = true;
      this.retired.add(previous);
      if (previous.inflight === 0) this.cleanup(previous);
    }
    if ((previous !== null) !== (this.current !== null)) this.opts.onActiveChange?.(this.current !== null);
  }

  /** Deletes old-version files once no request still runs on the generation that used them. */
  private cleanup(generation: Generation): void {
    this.retired.delete(generation);
    if (this.current?.runners !== generation.runners
      && ![...this.retired].some(other => other.runners === generation.runners)) {
      this.stopRunners(generation.runners);
      if (this.runners === generation.runners) {
        this.runners = null;
        this.runnersDir = null;
      }
    }
    for (const file of generation.files) {
      if (this.current?.files.has(file)) continue;
      if (this.listedFiles.has(file)) continue;
      if ([...this.retired].some(other => other.files.has(file))) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        // Already removed or never ours to remove; a stale file is never executed.
      }
    }
  }

  private resolveFile(scriptsDir: string, rule: ManagedScriptRule): string | null {
    const expected = path.join(scriptsDir, managedScriptFileName(rule));
    try {
      // Rejects symlinks too: the real path must be the file name directly under scripts/.
      const real = fs.realpathSync.native(expected);
      if (real !== expected || !fs.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  private ensureRunners(scriptsDir: string): ScriptRunners {
    if (this.runners && this.runnersDir === scriptsDir) return this.runners;
    // Retired generations keep their runners until their last request finishes.
    this.runnersDir = scriptsDir;
    this.runners = this.opts.createRunners
      ? this.opts.createRunners(scriptsDir, this.platform)
      : defaultRunners(scriptsDir, this.platform);
    return this.runners;
  }

  private stopRunners(runners: ScriptRunners | null | undefined): void {
    runners?.sh?.stop();
    runners?.powershell?.stop();
  }

  private reportProblem(problem: string): void {
    // Every failed load counts; the collector owns alarm cooldown and aggregation.
    reportInterceptorDiagnostic(this.opts.onDiagnostic, {
      code: 'config_rejected', source: 'cache', reason: 'cached interceptor config unreadable or invalid; previous generation kept',
    });
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    logger.warn('managed interceptor config ignored', { problem, active: this.active });
  }

  private logResolution(pending: string[]): void {
    const summary = JSON.stringify({ pending });
    if (summary === this.lastResolution) return;
    this.lastResolution = summary;
    if (pending.length > 0) logger.info('managed interceptor script bodies pending', { pending });
  }
}

function resolveScriptsDir(dataDir: string, scriptCache?: string): string | null {
  try {
    const base = fs.realpathSync.native(managedScriptsDir(dataDir));
    if (!scriptCache) return base;
    const expected = path.join(base, scriptCache);
    const real = fs.realpathSync.native(expected);
    return real === expected && fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function defaultRunners(scriptsDir: string, platform: NodeJS.Platform): ScriptRunners {
  return platform === 'win32'
    ? { powershell: new PowerShellPool({ scriptsDir }) }
    : { sh: new ShScriptRunner() };
}
