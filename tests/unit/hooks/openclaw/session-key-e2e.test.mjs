import { describe, it, expect } from 'vitest';
import { assertOpenClawSessionKey } from '../../../../scripts/e2e/openclaw-assertions.mjs';

describe('session key acceptance oracle', () => {
  const key = 'agent.openclaw.session_key';
  function evidence() {
    return { sessionKey: 'agent:main:test', rawEvents: [{ [key]: 'agent:main:test' }],
      events: [{ [key]: 'agent:main:test' }], spans: [{ attributes: { [key]: 'agent:main:test' }, resource: {} }] };
  }
  it('accepts native/log/span parity', () => expect(() => assertOpenClawSessionKey(evidence())).not.toThrow());
  it.each(['rawEvents', 'events', 'spans'])('rejects missing %s key', field => {
    const data = evidence(); data[field] = [{}];
    expect(() => assertOpenClawSessionKey(data)).toThrow();
  });
  it('rejects Resource contamination', () => {
    const data = evidence(); data.spans[0].resource[key] = data.sessionKey;
    expect(() => assertOpenClawSessionKey(data)).toThrow();
  });
});
