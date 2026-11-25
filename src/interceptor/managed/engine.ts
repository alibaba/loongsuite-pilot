import * as fs from 'node:fs';
import { createLogger } from '../../utils/logger.js';
import { collectHookText } from '../rules/hook-text.js';
import { reportInterceptorDiagnostic, type InterceptorDiagnosticObserver } from '../diagnostics.js';
import {
  INTERCEPTOR_HOOK_TIMEOUT_MS,
  type EvaluateHookResponse,
  type HookEvaluator,
  type HookRequest,
  type ManagedRuleMatch,
} from '../types.js';
import {
  PATTERN_BLOCKED_REASON,
  buildSubstringMatchPlan,
  type SubstringMatchPlan,
  type ManagedInterceptorConfig,
  type ManagedPatternRule,
  type ManagedScriptRule,
  type ManagedShell,
} from './config.js';
import { ManagedRegexRunner, ManagedRegexCancelledError, ManagedRegexTimeoutError, MANAGED_REGEX_TIMEOUT_MS, MANAGED_REGEX_SLOW_MS } from './regex-runner.js';
import { parseScriptVerdict, type ScriptRunner } from './runner.js';

const logger = createLogger('ManagedInterceptor');

/** Leaves the hook client (INTERCEPTOR_HOOK_TIMEOUT_MS) time to receive the verdict. */
export const MANAGED_SCRIPT_BUDGET_MS = INTERCEPTOR_HOOK_TIMEOUT_MS - 500;

export interface ResolvedScriptRule {
  rule: ManagedScriptRule;
  shell: ManagedShell;
  /** Real path inside configs/managed/scripts/, checked when the generation was built. */
  file: string;
}

export type ScriptRunners = Partial<Record<ManagedShell, ScriptRunner>>;

export interface ManagedRuleEngineOptions {
  config: ManagedInterceptorConfig;
  rules: readonly ResolvedScriptRule[];
  runners: ScriptRunners;
  budgetMs?: number;
  /** Shared with the controller so stop() can kill a stuck match. */
  regex?: ManagedRegexRunner;
  regexTimeoutMs?: number;
  onDiagnostic?: InterceptorDiagnosticObserver;
}

/**
 * One managed rule set. A failing script only skips its own
 * rule; the next rule still runs.
 */
export class ManagedRuleEngine implements HookEvaluator {
  private readonly scriptsById: ReadonlyMap<string, ResolvedScriptRule>;
  private readonly regex: ManagedRegexRunner;
  private readonly regexTimeoutMs: number;
  private readonly patternPlans = new Map<ManagedPatternRule, string | SubstringMatchPlan>();

  constructor(private readonly opts: ManagedRuleEngineOptions) {
    this.scriptsById = new Map(opts.rules.map(resolved => [resolved.rule.id, resolved]));
    this.regexTimeoutMs = opts.regexTimeoutMs ?? MANAGED_REGEX_TIMEOUT_MS;
    this.regex = opts.regex ?? new ManagedRegexRunner(this.regexTimeoutMs);
    for (const rule of opts.config.rules) {
      if (rule.kind === 'pattern') {
        this.patternPlans.set(rule, rule.match === 'substring' ? buildSubstringMatchPlan(rule.keywords) : rule.pattern);
      }
    }
  }

  async evaluate(request: HookRequest): Promise<EvaluateHookResponse> {
    const deadline = Date.now() + (this.opts.budgetMs ?? MANAGED_SCRIPT_BUDGET_MS);
    let text: string | undefined;
    const requestText = (): string => text ??= collectHookText(request);
    const evaluatedRules: string[] = [];
    const matches: ManagedRuleMatch[] = [];
    let failed = false;
    const hit = (rule: ManagedPatternRule | ManagedScriptRule, reason: string): boolean => {
      matches.push({ matched: true, action: rule.action,
        reason, ruleId: rule.id, ruleVersion: rule.version,
        ...(rule.severity ? { severity: rule.severity } : {}),
        ...(rule.title ? { title: rule.title } : {}), ...(rule.message ? { message: rule.message } : {}) });
      return rule.action === 'block';
    };
    const result = (blocked = false): EvaluateHookResponse => {
      const representative = blocked ? matches[matches.length - 1] : matches[0];
      return { ...(representative ?? {}), action: blocked ? 'block' : 'allow',
        ...(representative ? { matched: true } : failed ? {} : { matched: false }),
        matches, evaluatedRules, ...(!blocked && failed ? { failOpen: true as const } : {}) };
    };

    for (const rule of this.opts.config.rules) {
      if (!rule.agents.includes(request.agent)) continue;
      if (!rule.events.includes(request.event)) continue;
      if (rule.kind === 'http') continue;
      if (Date.now() >= deadline) {
        failed = true;
        break;
      }
      if (rule.kind === 'pattern') {
        evaluatedRules.push(rule.id);
        const text = requestText();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          failed = true;
          break;
        }
        const started = performance.now();
        const limitMs = Math.min(remaining, this.regexTimeoutMs);
        try {
          const matched = await this.regex.test(this.patternPlans.get(rule)!, text, limitMs, durationMs => {
            if (durationMs >= MANAGED_REGEX_SLOW_MS) reportInterceptorDiagnostic(this.opts.onDiagnostic, {
              code: 'regex_slow', source: 'regex', reason: 'regular expression execution exceeded slow threshold',
              ruleId: rule.id, ruleVersion: rule.version, durationMs, limitMs: MANAGED_REGEX_SLOW_MS,
            });
          });
          // A queued result can arrive after the shared request deadline.
          if (Date.now() >= deadline) {
            failed = true;
            return result();
          }
          if (!matched) continue;
          if (hit(rule, PATTERN_BLOCKED_REASON)) return result(true);
          continue;
        } catch (err) {
          failed = true;
          if (err instanceof ManagedRegexCancelledError) continue;
          const timeout = err instanceof ManagedRegexTimeoutError;
          reportInterceptorDiagnostic(this.opts.onDiagnostic, {
            code: timeout ? 'regex_timeout' : 'regex_failed', source: 'regex',
            reason: timeout ? 'regular expression request budget exhausted (includes queue and worker startup)' : 'regular expression worker failed',
            ruleId: rule.id, ruleVersion: rule.version, durationMs: performance.now() - started, limitMs,
          });
          logger.warn('managed interceptor rule skipped', {
            ruleId: rule.id,
            version: rule.version,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      const resolved = this.scriptsById.get(rule.id);
      if (!resolved) continue;
      const { file, shell } = resolved;
      const runner = this.opts.runners[shell];
      if (!runner || !isPlainFile(file)) {
        failed = true;
        logger.warn('managed interceptor rule skipped', {
          ruleId: rule.id,
          version: rule.version,
          error: runner ? 'script file replaced or removed' : `no ${shell} runner`,
        });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failed = true;
        break;
      }
      evaluatedRules.push(rule.id);
      let run;
      try {
        run = await runner.run(file, JSON.stringify({ prompt: requestText() }), remaining);
      } catch (err) {
        failed = true;
        logger.warn('managed interceptor rule skipped', { ruleId: rule.id, version: rule.version, error: String(err) });
        continue;
      }
      const verdict = run.ok ? parseScriptVerdict(run.stdout) : null;
      if (!verdict) {
        failed = true;
        logger.warn('managed interceptor rule skipped', {
          ruleId: rule.id,
          version: rule.version,
          error: run.ok ? 'invalid stdout' : run.error,
        });
        continue;
      }
      if (verdict.matched && hit(rule, verdict.reason)) return result(true);
    }

    return result();
  }
}

/** The generation checked the path once; a symlink swapped in since then must not run. */
function isPlainFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
