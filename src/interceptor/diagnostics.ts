import type { AlarmManager } from '../metrics/alarm-manager.js';

export interface InterceptorDiagnostic {
  code: 'config_rejected' | 'config_pull_failed' | 'config_apply_failed' | 'regex_slow' | 'regex_timeout' | 'regex_failed';
  source: 'remote' | 'cache' | 'regex';
  /** Fixed diagnostic text only; never include downloaded content, patterns or hook text. */
  reason: string;
  version?: string;
  ruleId?: string;
  ruleVersion?: string;
  durationMs?: number;
  limitMs?: number;
}

export type InterceptorDiagnosticObserver = (diagnostic: InterceptorDiagnostic, count?: number) => void;

export const INTERCEPTOR_ALARM_COOLDOWN_MS = 10 * 60_000;

/** Collector-owned cooldown survives interceptor Worker restarts. Keys are fixed codes, not rule IDs. */
export class InterceptorAlarmReporter {
  private readonly windows = new Map<InterceptorDiagnostic['code'], { emittedAt: number; suppressed: number }>();

  constructor(private readonly manager: AlarmManager, private readonly now = () => performance.now()) {}

  readonly record: InterceptorDiagnosticObserver = (diagnostic, count = 1) => {
    const now = this.now();
    const previous = this.windows.get(diagnostic.code);
    if (previous && now - previous.emittedAt < INTERCEPTOR_ALARM_COOLDOWN_MS) {
      previous.suppressed += count;
      return;
    }
    recordInterceptorDiagnostic(this.manager, diagnostic, count + (previous?.suppressed ?? 0));
    this.windows.set(diagnostic.code, { emittedAt: now, suppressed: 0 });
  };
}

/** Monitoring failures must never change config publication or hook verdicts. */
export function reportInterceptorDiagnostic(observer: InterceptorDiagnosticObserver | undefined, diagnostic: InterceptorDiagnostic, count = 1): void {
  try { observer?.(diagnostic, count); } catch { /* Best effort self-monitoring. */ }
}

export function recordInterceptorDiagnostic(manager: AlarmManager, diagnostic: InterceptorDiagnostic, count = 1): void {
  manager.record(diagnostic.source === 'regex' ? 'INTERCEPTOR_REGEX_ALARM' : 'MANAGED_CONFIG_ALARM',
    '2', JSON.stringify(diagnostic), { input_name: 'interceptor', endpoint_name: diagnostic.code }, count);
}
