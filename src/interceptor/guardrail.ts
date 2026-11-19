import type { AgentActivityEntry } from '../types/index.js';
import type { EvaluateHookResponse, RuleEnforcement } from './types.js';

/** Snapshot of the winning rule, copied onto events and the tool-verdict store. */
export interface GuardrailSnapshot {
  action: 'allow' | 'block';
  matched?: boolean;
  enforcement?: RuleEnforcement;
  failOpen?: true;
  ruleId?: string;
  ruleVersion?: string;
  severity?: string;
  reason?: string;
  title?: string;
  message?: string;
}

export function guardrailSnapshotFromVerdict(verdict: EvaluateHookResponse): GuardrailSnapshot {
  return {
    action: verdict.action,
    ...(typeof verdict.matched === 'boolean' ? { matched: verdict.matched } : {}),
    ...(verdict.enforcement ? { enforcement: verdict.enforcement } : {}),
    ...(verdict.failOpen ? { failOpen: true } : {}),
    ...(verdict.action === 'block' || verdict.matched === true ? pickBlockMeta(verdict) : {}),
  };
}

/** Host/agent text: rule.message wins over the script reason. */
export function hostBlockDetail(message?: string, reason?: string): string | undefined {
  const fromMessage = message?.trim();
  if (fromMessage) return fromMessage;
  const fromReason = reason?.trim();
  return fromReason || undefined;
}

export function stampGuardrail(entry: AgentActivityEntry, snapshot: GuardrailSnapshot): void {
  entry['gen_ai.guardrail.triggered'] = true;
  entry['gen_ai.guardrail.action'] = snapshot.action;
  if (typeof snapshot.matched === 'boolean') entry['gen_ai.guardrail.matched'] = snapshot.matched;
  if (snapshot.enforcement) entry['gen_ai.guardrail.enforcement'] = snapshot.enforcement;
  if (snapshot.failOpen) entry['gen_ai.guardrail.fail_open'] = true;
  if (snapshot.action !== 'block' && snapshot.matched !== true) return;
  assignOptional(entry, 'gen_ai.guardrail.rule_id', snapshot.ruleId);
  assignOptional(entry, 'gen_ai.guardrail.rule_version', snapshot.ruleVersion);
  assignOptional(entry, 'gen_ai.guardrail.severity', snapshot.severity);
  assignOptional(entry, 'gen_ai.guardrail.reason', snapshot.reason);
  assignOptional(entry, 'gen_ai.guardrail.title', snapshot.title);
  assignOptional(entry, 'gen_ai.guardrail.message', snapshot.message);
}

function pickBlockMeta(verdict: EvaluateHookResponse): Omit<GuardrailSnapshot, 'action'> {
  return {
    ...(nonEmpty(verdict.ruleId) ? { ruleId: verdict.ruleId } : {}),
    ...(nonEmpty(verdict.ruleVersion) ? { ruleVersion: verdict.ruleVersion } : {}),
    ...(nonEmpty(verdict.severity) ? { severity: verdict.severity } : {}),
    ...(nonEmpty(verdict.reason) ? { reason: verdict.reason } : {}),
    ...(nonEmpty(verdict.title) ? { title: verdict.title } : {}),
    ...(nonEmpty(verdict.message) ? { message: verdict.message } : {}),
  };
}

function assignOptional(
  entry: AgentActivityEntry,
  key: 'gen_ai.guardrail.rule_id' | 'gen_ai.guardrail.rule_version'
    | 'gen_ai.guardrail.severity'
    | 'gen_ai.guardrail.reason' | 'gen_ai.guardrail.title' | 'gen_ai.guardrail.message',
  value: string | undefined,
): void {
  if (nonEmpty(value)) entry[key] = value;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
