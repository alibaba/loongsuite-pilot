export const SUPPORTED_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
export type HookEventName = (typeof SUPPORTED_HOOK_EVENTS)[number];
export const INTERCEPTOR_AGENTS = ['qoder', 'qodercli', 'openclaw'] as const;
export type InterceptorAgent = (typeof INTERCEPTOR_AGENTS)[number];
export type QoderSurface = 'qoder' | 'qodercli';
export type VerdictAction = 'allow' | 'block';

export function isInterceptorAgent(value: unknown): value is InterceptorAgent {
  return value === 'qoder' || value === 'qodercli' || value === 'openclaw';
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
  reason?: string;
  ruleId?: string;
  evaluatedRules: string[];
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
  processStartToken?: string;
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
