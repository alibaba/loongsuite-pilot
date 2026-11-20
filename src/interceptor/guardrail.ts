import type { AgentActivityEntry } from '../types/index.js';
import type { EvaluateHookResponse } from './types.js';
import { normalizeGuardrailFields } from '../normalization/guardrail-fields.js';

/** Internal verdict snapshot; telemetry projects it onto the compact public schema. */
export interface GuardrailSnapshot {
  action: 'allow' | 'block' | 'log';
  failOpen?: true;
  ruleId?: string;
  ruleVersion?: string;
}

export function guardrailSnapshotFromVerdict(verdict: EvaluateHookResponse): GuardrailSnapshot {
  return {
    action: verdict.action === 'block' ? 'block' : verdict.matched === true ? 'log' : 'allow',
    ...(verdict.failOpen ? { failOpen: true } : {}),
    ...(verdict.action === 'block' || verdict.matched === true ? pickRuleIdentity(verdict) : {}),
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
  normalizeGuardrailFields(entry);
  entry['gen_ai.guardrail.triggered'] = true;
  entry['gen_ai.guardrail.action'] = snapshot.action;
  if (snapshot.failOpen) entry['gen_ai.guardrail.fail_open'] = true;
  if (snapshot.action === 'allow') return;
  assignOptional(entry, 'gen_ai.guardrail.rule_id', snapshot.ruleId);
  if (typeof snapshot.ruleVersion === 'string') entry['gen_ai.guardrail.rule_version'] = snapshot.ruleVersion;
}

function pickRuleIdentity(verdict: EvaluateHookResponse): Omit<GuardrailSnapshot, 'action'> {
  return {
    ...(nonEmpty(verdict.ruleId) ? { ruleId: verdict.ruleId } : {}),
    ...(typeof verdict.ruleVersion === 'string' ? { ruleVersion: verdict.ruleVersion } : {}),
  };
}

function assignOptional(
  entry: AgentActivityEntry,
  key: 'gen_ai.guardrail.rule_id',
  value: string | undefined,
): void {
  if (nonEmpty(value)) entry[key] = value;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
