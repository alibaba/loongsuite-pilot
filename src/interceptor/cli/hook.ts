import { readFileSync } from 'node:fs';
import {
  accessInputFromHookRequest,
  accessInputFromPayload,
  buildAccessLogEntry,
  writeInterceptorAccessLog,
  type InterceptorAccessLogEntry,
} from '../access-log.js';
import { parseOpenClawHookRequest, renderOpenClawBlock } from '../adapters/openclaw.js';
import { parseHookRequest, renderQoderBlock } from '../adapters/qoder.js';
import { parseQwenWorkHookRequest, renderQwenWorkBlock } from '../adapters/qwenwork.js';
import { wrapHostReason } from '../adapters/reason.js';
import { interceptorRuntimePath } from '../paths.js';
import {
  isToolInterceptPhase,
  writeToolVerdict,
  type ToolInterceptResult,
  type ToolVerdictKey,
} from '../tool-verdict-store.js';
import { isInterceptorAgent, type HookRequest, type InterceptorRuntime } from '../types.js';
import { DaemonClient } from './daemon-client.js';
import { resolveQoderSurface } from './qoder-surface.js';

export interface HookCliDeps {
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  log: (message: string, extra?: Record<string, unknown>) => void;
  runtimePath?: string;
  resolveSurface?: () => ReturnType<typeof resolveQoderSurface>;
  createClient?: (port: number) => Pick<DaemonClient, 'checkHook' | 'health'>;
  writeAccessLog?: (entry: InterceptorAccessLogEntry) => void;
  writeToolVerdict?: (key: ToolVerdictKey, result: ToolInterceptResult) => boolean;
}

export async function runHook(args: string[], deps: HookCliDeps): Promise<number> {
  let raw: string;
  try {
    raw = await deps.readStdin();
  } catch {
    deps.log('failed to read stdin');
    recordFailOpen(deps, 'unknown', { rawText: '' }, 'failed to read stdin');
    return 0;
  }

  let payload: Record<string, unknown>;
  try {
    if (!raw.trim()) {
      deps.log('failed to parse host stdin');
      recordFailOpen(deps, 'unknown', { rawText: raw }, 'failed to parse host stdin');
      return 0;
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      deps.log('failed to parse host stdin');
      recordFailOpen(deps, 'unknown', { rawText: raw }, 'failed to parse host stdin');
      return 0;
    }
  } catch {
    deps.log('failed to parse host stdin');
    recordFailOpen(deps, 'unknown', { rawText: raw }, 'failed to parse host stdin');
    return 0;
  }

  const eventHint = flagValue(args, '--event');
  const eventName = typeof payload.hook_event_name === 'string'
    ? payload.hook_event_name
    : typeof payload.openclaw_hook === 'string'
      ? payload.openclaw_hook
      : (eventHint ?? 'unknown');
  const input = accessInputFromPayload(payload);

  const agentFlag = flagValue(args, '--agent');
  const surface = agentFlag === 'qoder-auto'
    ? (deps.resolveSurface ?? resolveQoderSurface)()
    : isInterceptorAgent(agentFlag)
      ? agentFlag
      : null;
  if (!surface) {
    deps.log('hook target is missing or unknown, fail-open');
    recordFailOpen(deps, eventName, input, 'hook target is missing or unknown');
    return 0;
  }

  const request = surface === 'openclaw'
    ? parseOpenClawHookRequest(payload, eventHint)
    : surface === 'qwen-work-cn'
      ? parseQwenWorkHookRequest(payload, eventHint)
      : parseHookRequest(payload, surface, eventHint);
  if (!request) {
    deps.log('skipping unsupported hook event');
    recordFailOpen(deps, eventName, input, 'unsupported hook event', surface);
    return 0;
  }

  const runtime = readRuntime(deps.runtimePath ?? interceptorRuntimePath());
  if (!runtime) {
    deps.log('interceptor runtime missing, fail-open');
    recordUnknownVerdict(deps, request);
    recordFailOpen(deps, request.event, accessInputFromHookRequest(request), 'interceptor runtime missing', request.agent, request.sessionId, request.toolUseId);
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
      recordUnknownVerdict(deps, request);
      recordFailOpen(
        deps,
        request.event,
        accessInputFromHookRequest(request),
        'daemon identity mismatch',
        request.agent,
        request.sessionId,
        request.toolUseId,
      );
      return 0;
    }
    const verdict = await client.checkHook(request);
    recordHostVerdict(
      deps,
      request,
      verdict.failOpen ? 'unknown' : verdict.action === 'block' ? 'deny' : 'allow',
    );
    emitVerdict(request, verdict.action, verdict.reason, deps.writeStdout);
  } catch (err) {
    deps.log('daemon hook request failed, fail-open', {
      error: err instanceof Error ? err.message : String(err),
    });
    recordUnknownVerdict(deps, request);
    recordFailOpen(
      deps,
      request.event,
      accessInputFromHookRequest(request),
      err instanceof Error ? err.message : String(err),
      request.agent,
      request.sessionId,
      request.toolUseId,
    );
  }
  return 0;
}

function recordUnknownVerdict(deps: HookCliDeps, request: HookRequest): void {
  recordHostVerdict(deps, request, 'unknown');
}

function recordHostVerdict(
  deps: HookCliDeps,
  request: HookRequest,
  result: ToolInterceptResult,
): void {
  if (!request.toolUseId || !isToolInterceptPhase(request.event)) return;
  try {
    (deps.writeToolVerdict ?? writeToolVerdict)({
      agent: request.agent,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      phase: request.event,
    }, result);
  } catch {
    // Fail-open diagnostics must not affect the host.
  }
}

function recordFailOpen(
  deps: HookCliDeps,
  event: string,
  input: InterceptorAccessLogEntry['input'],
  error: string,
  agent?: string,
  sessionId?: string,
  toolUseId?: string,
): void {
  try {
    const write = deps.writeAccessLog ?? writeInterceptorAccessLog;
    write(buildAccessLogEntry({
      event,
      agent,
      sessionId,
      toolUseId,
      input,
      result: { action: 'fail-open', error },
    }));
  } catch {
    // Access logs must never affect fail-open.
  }
}

export { wrapHostReason } from '../adapters/reason.js';

export function emitVerdict(
  request: HookRequest,
  action: string,
  reason: string | undefined,
  writeStdout: (text: string) => void,
): void {
  if (action !== 'block') return;
  writeStdout(
    request.agent === 'openclaw'
      ? renderOpenClawBlock(request, reason)
      : request.agent === 'qwen-work-cn'
        ? renderQwenWorkBlock(request, reason)
        : renderQoderBlock(request, wrapHostReason(request.event, reason)),
  );
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
