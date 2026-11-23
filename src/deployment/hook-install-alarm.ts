export interface HookInstallAlarmReport {
  identity: string;
  ts: string;
  alarmSent?: boolean;
  agents: Array<{ id?: string; status: string; reason?: string | null }>;
}

export function hookInstallAlarmKey(report: Pick<HookInstallAlarmReport, 'identity' | 'ts'>): string {
  return `${report.identity}\0${report.ts}`;
}

/** True when this result still needs one HOOK_INSTALL_ALARM for its identity+ts. */
export function shouldRelayHookInstallAlarm(
  report: HookInstallAlarmReport | null | undefined,
  sentKeys: ReadonlySet<string>,
): boolean {
  if (!report) return false;
  if (report.alarmSent === true) return false;
  if (!report.agents.some(agent => agent.status === 'failed')) return false;
  return !sentKeys.has(hookInstallAlarmKey(report));
}
