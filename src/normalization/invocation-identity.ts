import type { AgentActivityEntry } from '../types/index.js';

/**
 * Internal transport fields written by invocation-scoped hooks/plugins.
 *
 * They deliberately live under agent.pilot.* so raw producer records can carry
 * them without colliding with canonical event fields. InputManager consumes and
 * removes both fields before any output sink sees the entry.
 *
 * Keep these values in sync with assets/hooks/shared/resource-context.mjs and
 * the standalone plugin parsers.
 */
export const INVOCATION_SESSION_ID_FIELD = 'agent.pilot.invocation.session.id';
export const INVOCATION_USER_ID_FIELD = 'agent.pilot.invocation.user.id';

const MAX_INVOCATION_ID_LENGTH = 512;

function consumeIdentityValue(entry: AgentActivityEntry, key: string): string | undefined {
  const raw = entry[key];
  delete entry[key];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value.length > 0 && value.length <= MAX_INVOCATION_ID_LENGTH
    ? value
    : undefined;
}

/**
 * Apply invocation-scoped identity with the shared precedence contract:
 *
 * invocation env > configured user id > agent-native id > fallback user id.
 *
 * Session identity has no collector-level configured fallback, so an injected
 * value replaces the native session id while native turn/step ids stay intact.
 */
export function applyInvocationIdentity(
  entry: AgentActivityEntry,
  configuredUserId: string,
  fallbackUserId: string,
): void {
  const sessionId = consumeIdentityValue(entry, INVOCATION_SESSION_ID_FIELD);
  const userId = consumeIdentityValue(entry, INVOCATION_USER_ID_FIELD);

  if (sessionId) {
    entry['gen_ai.session.id'] = sessionId;
  }

  if (userId) {
    entry['user.id'] = userId;
  } else if (configuredUserId) {
    entry['user.id'] = configuredUserId;
  } else if (!entry['user.id'] && fallbackUserId) {
    entry['user.id'] = fallbackUserId;
  }
}
