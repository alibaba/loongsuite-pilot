import { createRequire } from 'node:module';

let runtime;
export function sharedTraceRuntime(dataDir) {
  try {
    runtime ??= createRequire(import.meta.url)('./trace-context.cjs');
    return { api: runtime, store: new runtime.TraceContextRuntime(dataDir) };
  } catch { return null; }
}
