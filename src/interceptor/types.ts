export const SUPPORTED_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
export type HookEventName = (typeof SUPPORTED_HOOK_EVENTS)[number];
export const INTERCEPTOR_AGENTS = ['qoder', 'qodercli', 'openclaw', 'qwen-work-cn'] as const;
export type InterceptorAgent = (typeof INTERCEPTOR_AGENTS)[number];
export type QoderSurface = 'qoder' | 'qodercli';
export type VerdictAction = 'allow' | 'block';
export type RuleEnforcement = 'enforce' | 'audit';

/** One successfully matched managed rule, in evaluation order. */
export interface ManagedRuleMatch {
  matched: true;
  enforcement: RuleEnforcement;
  action: VerdictAction;
  ruleId: string;
  ruleVersion: string;
  reason: string;
  title?: string;
  message?: string;
}

export function isInterceptorAgent(value: unknown): value is InterceptorAgent {
  return value === 'qoder'
    || value === 'qodercli'
    || value === 'openclaw'
    || value === 'qwen-work-cn';
}

export interface HookRequest {
  agent: InterceptorAgent;
  event: HookEventName;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  toolUseId?: string;
  prompt?: string;
  raw: Record<string, unknown>;
}

export interface LocalRule {
  readonly id: string;
  supports(request: HookRequest): boolean;
  evaluate(request: HookRequest): Promise<RuleResult>;
}

export type RuleResult =
  | { matched: false }
  | { matched: true; reason: string };

export type { InterceptorConfig, InterceptorType } from '../types/index.js';

export interface EvaluateHookResponse {
  action: VerdictAction;
  /** Omitted when evaluation failed before any match could be established. */
  matched?: boolean;
  enforcement?: RuleEnforcement;
  /** Managed hits, including audits before a later enforced block or evaluation error. */
  matches?: ManagedRuleMatch[];
  /** Script stdout reason or builtin token. Telemetry uses this, not `message`. */
  reason?: string;
  ruleId?: string;
  /** Managed `rules[].version`. Builtin rules omit this. */
  ruleVersion?: string;
  /** Managed `rules[].title`. */
  title?: string;
  /** Managed `rules[].message`. Shown to the host in preference to `reason`. */
  message?: string;
  evaluatedRules: string[];
  /** The host is allowed because evaluation failed, not because rules passed. */
  failOpen?: true;
}

export interface HookEvaluator {
  evaluate(request: HookRequest): Promise<EvaluateHookResponse>;
}

export interface InterceptorHealth {
  service: typeof INTERCEPTOR_SERVICE;
  status: 'ok';
  pid: number;
  version: string;
  daemon_port: number;
}

export interface InterceptorRuntime {
  service: typeof INTERCEPTOR_SERVICE;
  status: 'ok';
  pid: number;
  version: string;
  daemon_port: number;
  packageVersion: string;
  gitCommit?: string;
  updatedAt: string;
}

export const INTERCEPTOR_SERVICE = 'loongsuite-pilot-interceptor';
export const INTERCEPTOR_DEFAULT_PORT = 18791;
export const INTERCEPTOR_HOOK_TIMEOUT_MS = 4_000;
export const INTERCEPTOR_EVENT_TIMEOUT_SEC: Record<HookEventName, number> = {
  UserPromptSubmit: 15,
  PreToolUse: 10,
  PostToolUse: 10,
};
