// @ts-expect-error Shared with standalone Hooks and plugins; bundled by esbuild.
import { acquireRawSourceGate as acquire } from '../../assets/hooks/shared/raw-source-gate.mjs';

export function acquireRawSourceGate(directory: string): { release(): void } | null {
  return acquire(directory);
}
