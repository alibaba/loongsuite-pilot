import type sqlite3 from 'sqlite3';

// Import only when a SQLite capability is queried. A top-level addon import would
// prevent unrelated Hook/session collectors from starting on a degraded runtime.
// Failed loads stay failed for this process; rebuild the addon and restart Pilot.
let runtime: Promise<typeof sqlite3> | undefined;
const startupFailureKey = Symbol.for('loongsuite-pilot.sqlite3.startup-failure');
const shared = globalThis as typeof globalThis & { [startupFailureKey]?: string };

// The guard is a separate CJS bundle; the collector is ESM. A process-local
// symbol shares its isolated probe result without reading stale files or env.
export function recordSqliteStartupFailure(reason: string): void {
  shared[startupFailureKey] = reason;
}

export function loadSqlite3(): Promise<typeof sqlite3> {
  if (shared[startupFailureKey]) {
    return Promise.reject(new Error(`SQLite capability unavailable: ${shared[startupFailureKey]}`));
  }
  runtime ??= import('sqlite3').then(module => module.default);
  return runtime;
}

export async function hasSqlite3(): Promise<boolean> {
  try {
    await loadSqlite3();
    return true;
  } catch {
    return false;
  }
}
