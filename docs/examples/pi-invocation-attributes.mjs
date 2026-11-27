import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** For a host creating its own Pi SDK AgentSession.
 * Pass the installed Pilot extension factory and InvocationAttributeStore.
 * Use the returned extension in DefaultResourceLoader.extensionFactories.
 */
export function createPiInvocationBridge({ createPiTelemetryExtension, store, scope = 'agent-gateway' }) {
  const current = new AsyncLocalStorage();
  const extension = createPiTelemetryExtension({
    onInvocationStart({ sessionId, turnId }) {
      const request = current.getStore();
      if (!request || request.sessionId !== sessionId) return;
      const status = store.register({
        agent: 'pi-coding-agent',
        scope,
        invocationId: request.invocationId,
        selector: { kind: 'turn', sessionId, turnId },
        attributes: request.attributes,
      });
      if (status === 'sealed') throw new Error('Pilot invocation already resolved');
    },
  });

  return {
    extension,
    // The caller supplies authenticated, JSON scalar business values; choose
    // a distinct request scope for every top-level AgentSession.prompt call.
    run({ sessionId, attributes, invocationId = randomUUID() }, promptOnce) {
      return current.run({
        sessionId,
        attributes: Object.freeze({ ...attributes }),
        invocationId,
      }, promptOnce);
    },
  };
}
