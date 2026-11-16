export interface UpstreamCarrier { traceparent: string; tracestate?: string }
export function normalizeUpstreamCarrier(carrier: unknown): UpstreamCarrier | null;
export function readUpstreamTurn(correlateDir: string, agentId: string, sessionId: string, nativeTurnId: string): UpstreamCarrier | null;
export function readUpstreamSession(correlateDir: string, sessionId: string): UpstreamCarrier | null;
export function bindUpstreamTurn(options: { agentId: string; sessionId: string; nativeTurnId: string; carrier: unknown; dataDir?: string }): { recorded: boolean; reason?: string };
