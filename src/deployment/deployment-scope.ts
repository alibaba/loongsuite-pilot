import type { ContainerIdentity } from '../utils/container-identity.js';

export type DeploymentScopeMode = 'auto' | 'recorded';

export interface DeploymentScopeResult {
  scope?: string;
  identity?: string;
}

/**
 * recorded only when this process is inside a container and the last named
 * `hook install` was for this same container. A full-detect result
 * (`scope: detected`) keeps auto, so agents installed later are still picked
 * up by deployAll. Host boot_id never enters recorded.
 */
export function resolveDeploymentScope(
  current: ContainerIdentity,
  result: DeploymentScopeResult | null | undefined,
): DeploymentScopeMode {
  if (current.source !== 'cgroup') return 'auto';
  if (!result || result.scope !== 'named') return 'auto';
  if (!result.identity || result.identity !== current.identity) return 'auto';
  return 'recorded';
}
