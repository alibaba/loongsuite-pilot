import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { resolveDeploymentScope } from '../../../src/deployment/deployment-scope.js';
import type { ContainerIdentity } from '../../../src/utils/container-identity.js';

const container = (identity: string): ContainerIdentity => ({ identity, source: 'cgroup' });

describe('deployment scope', () => {
  const containerId = 'a'.repeat(64);

  it('enters recorded only for a named result in the same container', () => {
    expect(resolveDeploymentScope(container(containerId), {
      scope: 'detected',
      identity: containerId,
    })).toBe('auto');
    expect(resolveDeploymentScope(container(containerId), {
      scope: 'named',
      identity: containerId,
    })).toBe('recorded');
    expect(resolveDeploymentScope(container(containerId), {
      scope: 'named',
      identity: 'b'.repeat(64),
    })).toBe('auto');
    expect(resolveDeploymentScope(
      { identity: 'boot-1', source: 'boot_id' },
      { scope: 'named', identity: 'boot-1' },
    )).toBe('auto');
    expect(resolveDeploymentScope(container(containerId), null)).toBe('auto');
  });

  it('keeps build deploy and eager injection from writing the result file', () => {
    const deploy = fs.readFileSync('src/deployment/deploy-command.ts', 'utf8');
    const eager = fs.readFileSync('src/inject-hooks.ts', 'utf8');
    expect(deploy).not.toContain('runHookInstall');
    expect(eager).not.toContain('runHookInstall');
    expect(eager).not.toContain('hook-install-service');
  });
});
