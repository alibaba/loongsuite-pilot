export interface WorkBuddyRecord {
  type?: string;
  role?: string;
  id?: string;
  sessionId?: string;
  parentId?: string;
  callId?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  status?: string;
  timestamp?: number;
  cwd?: string;
  content?: Array<Record<string, unknown>>;
  rawContent?: Array<Record<string, unknown>>;
  message?: { usage?: Record<string, unknown> };
  providerData?: Record<string, unknown>;
}

export interface WorkBuddyHookEvent {
  eventName: string;
  observedAtMs: number;
  sessionId?: string;
  toolName?: string;
  toolCallId?: string;
}

export interface WorkBuddyBuildOptions {
  sessionId: string;
  hookEvents?: WorkBuddyHookEvent[];
}
