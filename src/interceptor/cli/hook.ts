import { readFileSync } from 'node:fs';
import { parseHookRequest, renderQoderBlock } from '../adapters/qoder.js';
import { interceptorRuntimePath } from '../paths.js';
import type { HookRequest, InterceptorRuntime } from '../types.js';
import { DaemonClient } from './daemon-client.js';
import { resolveQoderSurface } from './qoder-surface.js';

export interface HookCliDeps {
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  log: (message: string, extra?: Record<string, unknown>) => void;
  runtimePath?: string;
  resolveSurface?: () => ReturnType<typeof resolveQoderSurface>;
  createClient?: (port: number) => Pick<DaemonClient, 'checkHook' | 'health'>;
}

export async function runHook(args: string[], deps: HookCliDeps): Promise<number> {
  let raw: string;
  try {
    raw = await deps.readStdin();
  } catch {
    deps.log('failed to read stdin');
    return 0;
  }

  let payload: Record<string, unknown>;
  try {
    if (!raw.trim()) {
      deps.log('failed to parse host stdin');
      return 0;
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      deps.log('failed to parse host stdin');
      return 0;
    }
  } catch {
    deps.log('failed to parse host stdin');
    return 0;
  }

  const agentFlag = flagValue(args, '--agent');
  const surface = agentFlag === 'qoder-auto'
    ? (deps.resolveSurface ?? resolveQoderSurface)()
    : agentFlag === 'qoder' || agentFlag === 'qodercli'
      ? agentFlag
      : null;
  if (!surface) {
    deps.log('hook target is missing or unknown, fail-open');
    return 0;
  }

  const request = parseHookRequest(payload, surface, flagValue(args, '--event'));
  if (!request) {
    deps.log('skipping unsupported hook event');
    return 0;
  }

  const runtime = readRuntime(deps.runtimePath ?? interceptorRuntimePath());
  if (!runtime) {
    deps.log('interceptor runtime missing, fail-open');
    return 0;
  }

  const client = (deps.createClient ?? ((port: number) => new DaemonClient(port)))(runtime.daemon_port);
  try {
    const health = await client.health();
    if (health.version !== runtime.version || health.pid !== runtime.pid) {
      deps.log('daemon identity mismatch, fail-open', {
        runtimeVersion: runtime.version,
        healthVersion: health.version,
        runtimePid: runtime.pid,
        healthPid: health.pid,
      });
      return 0;
    }
    const verdict = await client.checkHook(request);
    emitVerdict(request, verdict.action, verdict.reason, deps.writeStdout);
  } catch (err) {
    deps.log('daemon hook request failed, fail-open', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return 0;
}

export function emitVerdict(
  request: HookRequest,
  action: string,
  reason: string | undefined,
  writeStdout: (text: string) => void,
): void {
  if (action !== 'block') return;
  writeStdout(renderQoderBlock(request, reason ?? 'Blocked by security policy'));
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function readRuntime(filePath: string): InterceptorRuntime | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as InterceptorRuntime;
    if (parsed.service !== 'loongsuite-pilot-interceptor') return null;
    if (parsed.status !== 'ok') return null;
    if (!Number.isInteger(parsed.daemon_port) || parsed.daemon_port < 1 || parsed.daemon_port > 65535) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
