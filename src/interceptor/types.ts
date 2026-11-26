export const SUPPORTED_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
export type HookEventName = (typeof SUPPORTED_HOOK_EVENTS)[number];
export const INTERCEPTOR_AGENTS = [
  'qoder', 'qodercli', 'qoder-cn', 'qoderclicn', 'openclaw', 'qwen-work-cn', 'workbuddy',
] as const;
export type InterceptorAgent = (typeof INTERCEPTOR_AGENTS)[number];
export type QoderSurface = 'qoder' | 'qodercli' | 'qoder-cn' | 'qoderclicn';
export type VerdictAction = 'allow' | 'block';
export type RuleAction = 'block' | 'log';

/** One successfully matched managed rule, in evaluation order. */
export interface ManagedRuleMatch {
  matched: true;
  action: RuleAction;
  ruleId: string;
  ruleVersion: string;
  severity?: string;
  reason: string;
  title?: string;
  message?: string;
}

export function isInterceptorAgent(value: unknown): value is InterceptorAgent {
  return (INTERCEPTOR_AGENTS as readonly unknown[]).includes(value);
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

export type { InterceptorConfig } from '../types/index.js';

export interface EvaluateHookResponse {
  action: VerdictAction;
  /** Omitted when evaluation failed before any match could be established. */
  matched?: boolean;
  /** Managed hits, including audits before a later enforced block or evaluation error. */
  matches?: ManagedRuleMatch[];
  /** Managed rule reason. Telemetry uses this, not `message`. */
  reason?: string;
  ruleId?: string;
  /** Managed `rules[].version`. */
  ruleVersion?: string;
  /** Optional risk label from managed `rules[].severity`. */
  severity?: string;
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
