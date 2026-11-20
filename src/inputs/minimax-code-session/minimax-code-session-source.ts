import * as os from 'node:os';
import * as path from 'node:path';

export interface MinimaxCodeSessionManifest {
  sessionId: string;
}

type MinimaxCodeMessageRole = 'user' | 'assistant' | 'toolResult';

export interface MinimaxCodeSessionMessage {
  messageId: string;
  turnId: string;
  role: MinimaxCodeMessageRole;
  /**
   * The native message timestamp. For assistant messages the runtime sets it
   * when starting the model call, before any response output is observed.
   */
  timestampMs: number;
  message: Record<string, unknown>;
}

type MinimaxCodeHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd';

export interface MinimaxCodeHookObservation {
  event: MinimaxCodeHookEvent;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  workspace?: string;
  observedAtMs: number;
}

const HOOK_EVENTS = new Set<MinimaxCodeHookEvent>([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Only the current CLI data profile, independent of its installation directory. */
export function minimaxCodeProfileDir(env = process.env, home = os.homedir()): string | undefined {
  const profile = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim() || path.join(home, '.minimax');
  // A relative override belongs to the CLI's workspace, which the collector
  // cannot reliably infer when it is launched independently of the CLI.
  return path.isAbsolute(profile) ? path.normalize(profile) : undefined;
}

/** The native messages file is a sibling of this manifest, not a supplied path. */
export function parseMinimaxCodeSessionManifest(value: unknown): MinimaxCodeSessionManifest | undefined {
  const manifest = record(value);
  if (manifest?.schemaVersion !== 1 || manifest.source !== 'local-runtime'
    || manifest.layout !== 'v2-final-dated-session') return undefined;
  const sessionId = id(manifest.sessionId);
  return sessionId ? { sessionId } : undefined;
}

/** Current v2 canonical history. Old model-io files and internal custom rows are separate. */
export function parseMinimaxCodeSessionMessage(value: unknown): MinimaxCodeSessionMessage | undefined {
  const row = record(value);
  const message = record(row?.message);
  const role = message?.role;
  if (!message || (role !== 'user' && role !== 'assistant' && role !== 'toolResult')) return undefined;
  const messageId = id(row?.message_id);
  const turnId = id(row?.turn_id);
  const timestampMs = timestamp(message.timestamp);
  if (!messageId || !turnId || timestampMs === undefined) return undefined;
  return { messageId, turnId, role, timestampMs, message };
}

/**
 * MiniMax omits a source timestamp in command Hook JSON. Retain the Hook's
 * receipt time as an observation and avoid its temporary transcript projection.
 */
export function parseMinimaxCodeHookObservation(
  value: unknown, receivedAtMs: unknown,
): MinimaxCodeHookObservation | undefined {
  const payload = record(value);
  const event = payload?.hook_event_name;
  const sessionId = id(payload?.session_id);
  const observedAtMs = timestamp(receivedAtMs);
  if (typeof event !== 'string' || !HOOK_EVENTS.has(event as MinimaxCodeHookEvent)
    || !sessionId || observedAtMs === undefined) return undefined;
  const turnId = id(payload?.turn_id);
  const toolCallId = event === 'PreToolUse' || event === 'PostToolUse' ? id(payload?.tool_use_id) : undefined;
  if ((event !== 'SessionStart' && event !== 'SessionEnd' && !turnId)
    || ((event === 'PreToolUse' || event === 'PostToolUse') && !toolCallId)) return undefined;
  const cwd = payload?.cwd;
  const workspace = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.normalize(cwd) : undefined;
  return { event: event as MinimaxCodeHookEvent, sessionId, turnId, toolCallId, workspace, observedAtMs };
}
