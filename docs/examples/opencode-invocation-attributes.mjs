import { randomUUID } from 'node:crypto';

/** OpenCode 1.14.29 V1: the trusted caller supplies a native ascending
 * messageID, then hands this body unchanged to POST /session/:id/message.
 * Serialize prompts within a session; distinct sessions can run concurrently.
 */
export async function withOpenCodeInvocation({
  store, scope = 'agent-gateway', invocationId = randomUUID(), attributes, body,
}, sendOnce) {
  if (typeof body?.messageID !== 'string' || !body.messageID.startsWith('msg_')) {
    throw new TypeError('OpenCode native messageID required');
  }
  let attributeStatus;
  try {
    attributeStatus = store.register({
      agent: 'opencode',
      scope,
      invocationId,
      selector: { kind: 'message', messageId: body.messageID },
      attributes,
    });
  } catch {
    attributeStatus = 'unavailable';
  }
  // No business attributes, lookup state or retries enter the host request.
  return { response: await sendOnce(body), attributeStatus };
}
