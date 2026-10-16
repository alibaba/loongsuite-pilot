import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { baseEntry } from './copilot-entry-factory.js';
import type { CopilotBuildOptions, CopilotEvent, CopilotSessionCost, CopilotUsageTotals } from './copilot-types.js';

type Part = Record<string, JsonValue>;

interface Step {
  stepId: string;
  turnId: string;
  startMs: number;
  seed: string;
}

interface ToolStart {
  step: Step;
  startMs: number;
  name: string;
}

interface Ctx {
  opts: CopilotBuildOptions;
  out: AgentActivityEntry[];
  steps: Map<string, Step>;
  toolSteps: Map<string, Step>;
  tools: Map<string, ToolStart>;
  selectedModel?: string;
  autoModel?: string;
  cwd?: string;
  interactionId: string;
  firstStep: boolean;
  /** True from the prompt until a main-agent round ends the turn (answer or model error). */
  turnOpen: boolean;
  /** Pending request delta per agent scope: '' is the main agent, otherwise the parent tool call id. */
  deltas: Map<string, JsonValue[]>;
  /** Cumulative usage already reported, per model. */
  usage: Map<string, CopilotUsageTotals>;
  /** Session-wide cost already reported. */
  cost: CopilotSessionCost;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const scopeOf = (d: Record<string, unknown>): string => str(d.parentToolCallId) ?? '';
const json = (v: unknown): JsonValue | undefined => (v === undefined ? undefined : v as JsonValue);

/**
 * Copilot stores tool output as text. JSON text becomes a native value (schema gate). Text that
 * only looks like JSON (a file viewed by line range is cut mid-file) cannot be native, so it is
 * wrapped as a text part instead of being left as a string the gate would reject.
 */
function nativeValue(v: unknown): JsonValue | undefined {
  if (typeof v !== 'string') return json(v);
  const head = v.trimStart()[0];
  if (head !== '{' && head !== '[') return v;
  try {
    return JSON.parse(v) as JsonValue;
  } catch {
    return { type: 'text', content: v };
  }
}

export function buildCopilotEvents(events: CopilotEvent[], opts: CopilotBuildOptions): AgentActivityEntry[] {
  const ctx: Ctx = {
    opts, out: [], steps: new Map(), toolSteps: new Map(), tools: new Map(),
    selectedModel: opts.selectedModel, autoModel: opts.autoModel, cwd: opts.cwd,
    interactionId: '', firstStep: false, turnOpen: false, deltas: new Map(),
    usage: new Map(Object.entries(opts.priorUsage ?? {})),
    cost: { ...(opts.priorCost ?? {}) },
  };
  for (const event of events) {
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) continue;
    handle(ctx, event, at);
  }
  return ctx.out;
}

function handle(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  switch (event.type) {
    case 'session.start':
      ctx.selectedModel = str(d.selectedModel) ?? ctx.selectedModel;
      ctx.cwd = str(obj(d.context)?.cwd) ?? ctx.cwd;
      break;
    case 'session.auto_mode_resolved':
      ctx.autoModel = str(d.chosenModel) ?? ctx.autoModel;
      break;
    case 'user.message': startInteraction(ctx, event); break;
    case 'assistant.turn_start': startStep(ctx, event, at); break;
    case 'assistant.message': emitStep(ctx, event, at); break;
    case 'tool.execution_start': emitToolCall(ctx, event, at); break;
    case 'tool.execution_complete': emitToolResult(ctx, event, at); break;
    case 'session.error': emitModelError(ctx, event, at); break;
    case 'session.usage_checkpoint': emitCost(ctx, event, at, 'checkpoint'); break;
    case 'session.shutdown':
      emitCost(ctx, event, at, 'shutdown');
      emitUsageSummary(ctx, event, at);
      break;
    default: break;
  }
}

function push(ctx: Ctx, entry: AgentActivityEntry, subagent = false): void {
  if (ctx.cwd) entry['workspace.path'] = ctx.cwd;
  if (subagent) entry['gen_ai.agent.scope'] = 'subagent';
  ctx.out.push(entry);
}

function startInteraction(ctx: Ctx, event: CopilotEvent): void {
  const d = event.data;
  ctx.interactionId = str(d.interactionId) ?? str(d.messageId) ?? event.id;
  ctx.deltas = new Map([['', [{ role: 'user', parts: [{ type: 'text', content: str(d.content) ?? '' }] }]]]);
  ctx.firstStep = true;
  ctx.turnOpen = true;
  ctx.steps.clear();
  ctx.toolSteps.clear();
  ctx.tools.clear();
}

function newStep(nativeTurnId: string, turnId: string, startMs: number, seed: string): Step {
  return { stepId: `${turnId}:s${nativeTurnId}`, turnId, startMs, seed };
}

function startStep(ctx: Ctx, event: CopilotEvent, at: number): void {
  const nativeTurnId = str(event.data.turnId);
  if (nativeTurnId === undefined) return;
  const turnId = str(event.data.interactionId) ?? ctx.interactionId;
  ctx.steps.set(nativeTurnId, newStep(nativeTurnId, turnId, at, event.id));
}

function assistantParts(d: Record<string, unknown>): { parts: Part[]; toolParts: Part[] } {
  const parts: Part[] = [];
  const reasoning = str(d.reasoningText);
  if (reasoning) parts.push({ type: 'reasoning', content: reasoning });
  const text = str(d.content);
  if (text) parts.push({ type: 'text', content: text });
  const requests = Array.isArray(d.toolRequests) ? d.toolRequests : [];
  const toolParts: Part[] = [];
  for (const raw of requests) {
    const request = obj(raw);
    const id = str(request?.toolCallId);
    const name = str(request?.name);
    if (!request || !id || !name) continue;
    const part: Part = { type: 'tool_call', id, name };
    const args = json(request.arguments);
    if (args !== undefined) part.arguments = args;
    toolParts.push(part);
  }
  return { parts: [...parts, ...toolParts], toolParts };
}

function requestEntry(
  ctx: Ctx, step: Step, identity: { sessionId: string; turnId: string; stepId: string },
  delta: JsonValue[], subagent: boolean, apiCallId: string | undefined, responseModel: string | undefined,
): AgentActivityEntry {
  const request = baseEntry('llm.request', identity, `request:${step.seed}`, step.startMs);
  request['gen_ai.request.id'] = apiCallId ?? step.stepId;
  const requested = ctx.selectedModel ?? responseModel;
  if (requested) request['gen_ai.request.model'] = requested;
  if (ctx.firstStep && !subagent) request['gen_ai.turn.start'] = true;
  if (delta.length > 0) request['gen_ai.input.messages_delta'] = delta;
  return request;
}

/**
 * A model call that never answered leaves no assistant.message, only session.error. Without this
 * the prompt and the failure would both vanish from the log. The round that was waiting (or a
 * synthetic one when the error came before any round started) becomes an error response.
 */
function emitModelError(ctx: Ctx, event: CopilotEvent, at: number): void {
  if (!ctx.turnOpen) return;
  const pending = [...ctx.steps.values()].pop();
  const step = pending ?? newStep('error', ctx.interactionId, at, event.id);
  const identity = { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId };
  const request = requestEntry(ctx, step, identity, ctx.deltas.get('') ?? [], false, undefined, ctx.autoModel);
  const response = baseEntry('llm.response', identity, `response:${event.id}`, at);
  const model = ctx.autoModel ?? ctx.selectedModel;
  if (model) response['gen_ai.response.model'] = model;
  response['gen_ai.response.finish_reasons'] = ['error'];
  response['gen_ai.turn.end'] = true;
  response['error.type'] = str(event.data.errorType) ?? 'model_request_failed';
  const message = str(event.data.message);
  if (message) response['error.message'] = message;
  push(ctx, request);
  push(ctx, response);
  ctx.deltas.set('', []);
  ctx.steps.clear();
  ctx.firstStep = false;
  ctx.turnOpen = false;
}

function emitStep(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const nativeTurnId = str(d.turnId) ?? '';
  const turnId = str(d.interactionId) ?? ctx.interactionId;
  const scope = scopeOf(d);
  const subagent = scope !== '';
  const known = ctx.steps.get(nativeTurnId) ?? newStep(nativeTurnId, turnId, at, event.id);
  // A subagent restarts native turn numbering: keep its step id distinct from the parent's.
  const step = subagent ? { ...known, stepId: `${known.turnId}:${scope}:s${nativeTurnId}` } : known;
  const delta = ctx.deltas.get(scope) ?? [];
  const { parts, toolParts } = assistantParts(d);
  const identity = { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId };
  const responseModel = str(d.model) ?? ctx.autoModel ?? ctx.selectedModel;

  const request = requestEntry(ctx, step, identity, delta, subagent, str(d.apiCallId), responseModel);

  const finish = toolParts.length > 0 ? 'tool_call' : 'stop';
  const response = baseEntry('llm.response', identity, `response:${event.id}`, at);
  response['gen_ai.response.id'] = str(d.messageId) ?? event.id;
  if (responseModel) response['gen_ai.response.model'] = responseModel;
  response['gen_ai.response.finish_reasons'] = [finish];
  if (finish === 'stop' && !subagent) {
    response['gen_ai.turn.end'] = true;
    ctx.turnOpen = false;
  }
  if (parts.length > 0) response['gen_ai.output.messages'] = [{ role: 'assistant', parts, finish_reason: finish }];
  const outputTokens = d.outputTokens;
  if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
    response['gen_ai.usage.output_tokens'] = outputTokens;
  }

  push(ctx, request, subagent);
  push(ctx, response, subagent);
  for (const part of toolParts) ctx.toolSteps.set(String(part.id), step);
  ctx.deltas.set(scope, toolParts.length > 0 ? [{ role: 'assistant', parts: toolParts }] : []);
  if (!subagent) ctx.firstStep = false;
  ctx.steps.delete(nativeTurnId);
}

function emitToolCall(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const callId = str(d.toolCallId);
  const name = str(d.toolName);
  const step = (callId ? ctx.toolSteps.get(callId) : undefined) ?? ctx.steps.get(str(d.turnId) ?? '');
  if (!callId || !name || !step) return;
  ctx.tools.set(callId, { step, startMs: at, name });
  const entry = baseEntry(
    'tool.call',
    { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId },
    `tool-call:${callId}`,
    at,
  );
  entry['gen_ai.tool.name'] = name;
  entry['gen_ai.tool.call.id'] = callId;
  const args = json(d.arguments);
  if (args !== undefined) entry['gen_ai.tool.call.arguments'] = args;
  push(ctx, entry, str(d.parentToolCallId) !== undefined);
}

function emitToolResult(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const callId = str(d.toolCallId);
  const start = callId ? ctx.tools.get(callId) : undefined;
  if (!callId || !start) return;
  const success = d.success === true;
  const entry = baseEntry(
    'tool.result',
    { sessionId: ctx.opts.sessionId, turnId: start.step.turnId, stepId: start.step.stepId },
    `tool-result:${callId}`,
    at,
  );
  entry['gen_ai.tool.name'] = start.name;
  entry['gen_ai.tool.call.id'] = callId;
  entry['tool.result.status'] = success ? 'success' : 'failure';
  const content = nativeValue(obj(d.result)?.content);
  if (content !== undefined) entry['gen_ai.tool.call.result'] = content;
  if (!success) {
    entry['error.type'] = 'tool_execution_failed';
    const message = str(obj(d.error)?.message);
    if (message) entry['error.message'] = message;
  }
  const duration = at - start.startMs;
  if (duration > 0) entry['gen_ai.tool.call.duration'] = duration;
  push(ctx, entry, str(d.parentToolCallId) !== undefined);
  const scope = scopeOf(d);
  ctx.deltas.set(scope, [...(ctx.deltas.get(scope) ?? []), {
    role: 'tool', parts: [{ type: 'tool_call_response', id: callId, response: content ?? null }],
  }]);
  ctx.tools.delete(callId);
}

const numeric = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const USAGE_FIELDS: ReadonlyArray<readonly [keyof CopilotUsageTotals, string]> = [
  ['inputTokens', 'gen_ai.usage.input_tokens'],
  ['outputTokens', 'gen_ai.usage.output_tokens'],
  ['cacheReadTokens', 'gen_ai.usage.cache_read.input_tokens'],
  ['cacheWriteTokens', 'gen_ai.usage.cache_creation.input_tokens'],
  ['reasoningTokens', 'agent.copilot.usage.reasoning_tokens'],
  ['nanoAiu', 'agent.copilot.usage.model_nano_aiu'],
];

function totalsOf(metric: Record<string, unknown> | undefined): CopilotUsageTotals | undefined {
  const usage = obj(metric?.usage);
  if (!metric || !usage) return undefined;
  return {
    inputTokens: numeric(usage.inputTokens),
    outputTokens: numeric(usage.outputTokens),
    cacheReadTokens: numeric(usage.cacheReadTokens),
    cacheWriteTokens: numeric(usage.cacheWriteTokens),
    reasoningTokens: numeric(usage.reasoningTokens),
    nanoAiu: numeric(metric.totalNanoAiu),
  };
}

/** Only the fields the source actually reported. */
function definedOnly<T extends object>(totals: T): T {
  return Object.fromEntries(Object.entries(totals).filter(([, v]) => v !== undefined)) as T;
}

/** Current cumulative totals minus what was already reported; a counter going backwards means a reset. */
function incrementOf<K extends string>(
  fields: readonly K[],
  current: Partial<Record<K, number>>,
  prior: Partial<Record<K, number>> = {},
): Partial<Record<K, number>> {
  const reset = fields.some(field => {
    const now = current[field];
    return now !== undefined && now < (prior[field] ?? 0);
  });
  const base: Partial<Record<K, number>> = reset ? {} : prior;
  const out: Partial<Record<K, number>> = {};
  for (const field of fields) {
    const now = current[field];
    if (now !== undefined) out[field] = now - (base[field] ?? 0);
  }
  return out;
}

const USAGE_KEYS = USAGE_FIELDS.map(([field]) => field);

/**
 * Latest cumulative per-model totals after applying every session.shutdown in `events`.
 * The input stores this so a resumed session that repeats its totals is not counted twice.
 */
export function collectUsageTotals(
  events: CopilotEvent[],
  prior: Record<string, CopilotUsageTotals> = {},
): Record<string, CopilotUsageTotals> {
  const result: Record<string, CopilotUsageTotals> = { ...prior };
  for (const event of events) {
    if (event.type !== 'session.shutdown') continue;
    for (const [model, raw] of Object.entries(obj(event.data.modelMetrics) ?? {})) {
      const totals = totalsOf(obj(raw));
      if (totals) result[model] = { ...(result[model] ?? {}), ...definedOnly(totals) };
    }
  }
  return result;
}

/**
 * One session-level `other` entry per model. Copilot repeats its cumulative totals at every
 * shutdown (including after a resume), so each entry carries only the increment since the
 * previous summary of the session and the sum over a session stays correct.
 */
function emitUsageSummary(ctx: Ctx, event: CopilotEvent, at: number): void {
  for (const [model, raw] of Object.entries(obj(event.data.modelMetrics) ?? {})) {
    const totals = totalsOf(obj(raw));
    if (!totals) continue;
    const delta = incrementOf(USAGE_KEYS, totals, ctx.usage.get(model));
    ctx.usage.set(model, { ...(ctx.usage.get(model) ?? {}), ...definedOnly(totals) });
    const reported = USAGE_FIELDS.filter(([field]) => delta[field] !== undefined);
    if (reported.every(([field]) => delta[field] === 0)) continue;
    const entry = baseEntry('other', { sessionId: ctx.opts.sessionId }, `usage:${event.id}:${model}`, at);
    entry['gen_ai.response.model'] = model;
    entry['agent.copilot.usage.scope'] = 'session';
    for (const [field, key] of reported) entry[key] = delta[field] as number;
    push(ctx, entry);
  }
}

const COST_FIELDS: ReadonlyArray<readonly [keyof CopilotSessionCost, string]> = [
  ['nanoAiu', 'agent.copilot.usage.nano_aiu'],
  ['premiumRequests', 'agent.copilot.usage.premium_requests'],
];
const COST_KEYS = COST_FIELDS.map(([field]) => field);

function costTotalsOf(d: Record<string, unknown>): CopilotSessionCost {
  return { nanoAiu: numeric(d.totalNanoAiu), premiumRequests: numeric(d.totalPremiumRequests) };
}

/**
 * Latest cumulative session cost after applying every usage checkpoint and shutdown in `events`.
 * The input stores it so cost is never reported twice.
 */
export function collectSessionCost(events: CopilotEvent[], prior: CopilotSessionCost = {}): CopilotSessionCost {
  let result: CopilotSessionCost = { ...prior };
  for (const event of events) {
    if (event.type === 'session.usage_checkpoint' || event.type === 'session.shutdown') {
      result = { ...result, ...definedOnly(costTotalsOf(event.data)) };
    }
  }
  return result;
}

/**
 * Session-wide cost (Copilot's own billing unit and premium requests). Copilot writes a checkpoint
 * after every interaction, so this survives a host that never shuts down cleanly. Each entry carries
 * only the increment since the previous cost entry of the session, and a shutdown adds only what the
 * checkpoints had not covered, so summing a session's entries never double counts.
 */
function emitCost(ctx: Ctx, event: CopilotEvent, at: number, source: 'checkpoint' | 'shutdown'): void {
  const totals = costTotalsOf(event.data);
  const delta = incrementOf(COST_KEYS, totals, ctx.cost);
  ctx.cost = { ...ctx.cost, ...definedOnly(totals) };
  const reported = COST_FIELDS.filter(([field]) => delta[field] !== undefined);
  if (reported.every(([field]) => delta[field] === 0)) return;
  const entry = baseEntry('other', { sessionId: ctx.opts.sessionId }, `cost:${source}:${event.id}`, at);
  entry['agent.copilot.usage.scope'] = 'session';
  entry['agent.copilot.usage.source'] = source;
  if (source === 'checkpoint' && ctx.interactionId) entry['agent.copilot.usage.turn_id'] = ctx.interactionId;
  for (const [field, key] of reported) entry[key] = delta[field] as number;
  push(ctx, entry);
}
