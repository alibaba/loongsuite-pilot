import { readFileSync } from 'node:fs';

export type ContainerIdentitySource = 'cgroup' | 'boot_id' | 'unknown';

export interface ContainerIdentity {
  /** cgroup container id, host boot_id, or `unknown`. */
  identity: string;
  source: ContainerIdentitySource;
}

const CGROUP_CONTAINER_ID = /[0-9a-f]{64}/;

/**
 * Same identity k8s-preload and native-deps-guard compare against.
 * A 64-hex id from this process's cgroup means the process is inside a
 * container. Outside one, the host boot_id is used. Host boot_id must never
 * be treated as a container scope: it stays stable across containers on the
 * same node.
 */
export function identityFromParts(
  cgroupText: string | undefined,
  bootIdText: string | undefined,
): ContainerIdentity {
  const match = cgroupText?.match(CGROUP_CONTAINER_ID);
  if (match) return { identity: match[0], source: 'cgroup' };
  const bootId = bootIdText?.trim();
  if (bootId) return { identity: bootId, source: 'boot_id' };
  return { identity: 'unknown', source: 'unknown' };
}

export function readContainerIdentity(
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): ContainerIdentity {
  let cgroupText: string | undefined;
  try {
    cgroupText = read('/proc/self/cgroup');
  } catch {
    // Not containerized, or /proc is unavailable.
  }
  if (cgroupText && CGROUP_CONTAINER_ID.test(cgroupText)) {
    return identityFromParts(cgroupText, undefined);
  }
  let bootIdText: string | undefined;
  try {
    bootIdText = read('/proc/sys/kernel/random/boot_id');
  } catch {
    // Non-Linux, or /proc is unavailable.
  }
  return identityFromParts(undefined, bootIdText);
}
