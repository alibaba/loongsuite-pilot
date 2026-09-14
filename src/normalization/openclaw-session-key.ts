// Native routing identity, distinct from the conversation UUID. Never truncate
// an identity: invalid/oversized values are omitted rather than made ambiguous.
export const OPENCLAW_SESSION_KEY = 'agent.openclaw.session_key';
export const OPENCLAW_SESSION_KEY_AMBIGUOUS = 'agent.openclaw.session_key.ambiguous';

export function isOpenClawSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
