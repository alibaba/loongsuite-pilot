import { describe, it, expect } from 'vitest';
import { buildAgentProbeRemoteBody, wrapInBase64Bash } from '../../scripts/e2e/lib/agent-probe-body.mjs';

describe('agent-probe-body', () => {
  it('wrapInBase64Bash produces decodable pipeline', () => {
    const line = wrapInBase64Bash('echo hi');
    expect(line).toContain('base64 -d');
    expect(line).toContain('bash --norc --noprofile -s');
  });

  it('splits on --- into preamble + isolated blocks', () => {
    const body = buildAgentProbeRemoteBody(`export PATH=/
---
echo one
---
echo two`);
    expect(body).toContain('multi-block');
    expect(body.split('base64 -d').length).toBeGreaterThanOrEqual(3);
  });

  it('single segment uses one inner bash', () => {
    const body = buildAgentProbeRemoteBody('echo only');
    expect(body).toContain('stdin-isolated inner bash');
    expect(body.split('base64 -d').length).toBe(2);
  });
});
