import { ROOT_CONTEXT, type Context } from '@opentelemetry/api';
import {
  createEntryInvocation,
  createTraceParentContext,
  isValidTraceId,
  isValidSpanId,
  createInvokeAgentInvocation,
  createReactStepInvocation,
  createLLMInvocation,
  createExecuteToolInvocation,
  type ExtendedTelemetryHandler,
  type GenAIInvocation,
  type LLMInvocation,
  type GenAIError,
  type InputMessage,
  type OutputMessage,
  type MessagePart,
  type ToolDefinition,
} from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../types/index.js';

type Kind = 'entry' | 'agent' | 'step' | 'llm' | 'tool';
interface Pair {
  kind: Kind;
  start?: AgentActivityEntry;
  end?: AgentActivityEntry;
  invalid?: boolean;
}

function eventPhase(record: AgentActivityEntry): [Kind, 'start' | 'end'] | undefined {
  const boundary = record['agent.qwenpaw.boundary'];
  if (typeof boundary === 'string') {
    const match = /^(entry|agent|step)\.(start|end)$/.exec(boundary);
    if (match) return [match[1] as Kind, match[2] as 'start' | 'end'];
  }
  switch (record['event.name']) {
    case 'llm.request': return ['llm', 'start'];
    case 'llm.response': return ['llm', 'end'];
    case 'tool.call': return ['tool', 'start'];
    case 'tool.result': return ['tool', 'end'];
    default: return undefined;
  }
}

function string(record: AgentActivityEntry, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(record: AgentActivityEntry, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finishReason(reason: string): string {
  // Native QwenPaw uses interrupted; Pilot's GenAI contract uses cancelled.
  return reason === 'interrupted' ? 'cancelled' : reason;
}

function finishReasons(record: AgentActivityEntry): string[] | undefined {
  const value = record['gen_ai.response.finish_reasons'];
  const reasons = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    : string(record, 'response.finish_reasons')?.split(',');
  return reasons?.map(finishReason);
}

function terminalReason(record: AgentActivityEntry): string {
  if (record['agent.qwenpaw.cancelled'] === true || ['CancelledError', 'GeneratorExit'].includes(string(record, 'error.type') ?? '')) {
    return 'cancelled';
  }
  if (string(record, 'error.type') || string(record, 'error.message')) return 'error';
  return finishReasons(record)?.[0] ?? 'stop';
}

function scope(record: AgentActivityEntry): string {
  return JSON.stringify([record['gen_ai.session.id'], record['gen_ai.turn.id']]);
}

function spanKey(record: AgentActivityEntry, id: string): string {
  return `${scope(record)}:${id}`;
}

function timestamp(record: AgentActivityEntry): number {
  if (!/^\d+$/.test(record.time_unix_nano)) return NaN;
  const ns = BigInt(record.time_unix_nano);
  // Split before converting: epoch nanoseconds exceed Number's integer range.
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

function outputMessages(value: unknown, fallbackReason: string): OutputMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(message => ({
    ...message,
    finishReason: finishReason(message.finishReason || message.finish_reason || fallbackReason),
  }));
}

function toolDefinitions(value: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(definition => definition.type === 'function' && definition.function
    ? { type: 'function', ...definition.function }
    : definition);
}

/** Convert only observed, paired QwenPaw lifecycles; never synthesize a root or an end. */
export function convertQwenPawEvents(
  records: AgentActivityEntry[],
  handler: ExtendedTelemetryHandler,
  passthroughKeys: readonly string[] = [],
): { spanCount: number; warnings: string[] } {
  const pairs = new Map<string, Pair>();
  const warnings: string[] = [];
  for (const record of records) {
    const phase = eventPhase(record);
    if (!phase) continue;
    const id = string(record, 'agent.qwenpaw.span.id');
    if (!id || !/^[0-9a-f]{16}$/.test(id) || /^0+$/.test(id)) {
      warnings.push('QwenPaw event has no valid source span id');
      continue;
    }
    const key = spanKey(record, id);
    const pair = pairs.get(key) ?? { kind: phase[0] };
    const previous = pair[phase[1]];
    if (pair.kind !== phase[0] || (previous && previous['event.id'] !== record['event.id'])) {
      pair.invalid = true;
      warnings.push(`Conflicting QwenPaw lifecycle: ${id}`);
    } else {
      pair[phase[1]] = record;
    }
    pairs.set(key, pair);
  }

  const contexts = new Map<string, Context>();
  const visiting = new Set<string>();
  const skipped = new Set<string>();
  let spanCount = 0;
  function emit(key: string): Context | undefined {
    if (contexts.has(key)) return contexts.get(key);
    if (skipped.has(key)) return undefined;
    const pair = pairs.get(key);
    if (!pair || pair.invalid || !pair.start || !pair.end || visiting.has(key)) {
      skipped.add(key);
      warnings.push('Incomplete, conflicting, or cyclic QwenPaw lifecycle omitted');
      return undefined;
    }
    const { start, end, kind } = pair;
    const startTime = timestamp(start);
    const endTime = timestamp(end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) ||
        BigInt(end.time_unix_nano) < BigInt(start.time_unix_nano)) {
      skipped.add(key);
      warnings.push('QwenPaw lifecycle has invalid timestamps');
      return undefined;
    }
    const parentId = string(start, 'agent.qwenpaw.parent.id');
    if (parentId !== string(end, 'agent.qwenpaw.parent.id') || (kind !== 'entry' && !parentId)) {
      skipped.add(key);
      warnings.push('QwenPaw lifecycle has missing or inconsistent parent');
      return undefined;
    }
    visiting.add(key);
    // Only a root may attach to an external trace. Descendants must resolve
    // their explicit local parent, even when the incoming trace fields repeat.
    const traceId = start.trace_id;
    const externalParentId = start.parent_span_id;
    const rootContext = isValidTraceId(traceId) && isValidSpanId(externalParentId)
      ? createTraceParentContext(traceId, externalParentId)
      : ROOT_CONTEXT;
    const parentContext = parentId ? emit(spanKey(start, parentId)) : rootContext;
    visiting.delete(key);
    if (!parentContext) {
      skipped.add(key);
      return undefined;
    }

    if (parentId) {
      const parent = pairs.get(spanKey(start, parentId));
      if (parent?.start && parent.end &&
          (BigInt(start.time_unix_nano) < BigInt(parent.start.time_unix_nano) ||
           BigInt(end.time_unix_nano) > BigInt(parent.end.time_unix_nano))) {
        // Report source lifecycle bugs instead of stretching an observed STEP
        // to hide children emitted after it had already ended.
        warnings.push(`QwenPaw child exceeds observed parent lifetime: ${string(start, 'agent.qwenpaw.span.id')}`);
      }
    }

    // Normalization materializes absent optional fields as undefined on both
    // records. An absent end field must not erase request-only metadata. Real
    // end values (including empty arrays/null) still take precedence; stripped
    // content is never recovered from anything outside these normalized records.
    const merged: AgentActivityEntry = { ...start };
    for (const [name, value] of Object.entries(end)) {
      if (value !== undefined) merged[name] = value;
    }
    // Source protocol IDs reconstruct the tree above; only OTel span context
    // carries that relationship to exporters. Keep private QwenPaw metadata
    // local unless a caller explicitly selects a diagnostic passthrough key.
    const passthroughAttributes: Record<string, unknown> = {};
    for (const name of new Set([
      ...passthroughKeys, 'gen_ai.turn.id', 'gen_ai.step.id', 'gen_ai.agent.type',
      'gen_ai.agent.id', 'gen_ai.conversation.id',
    ])) {
      if (merged[name] !== undefined) passthroughAttributes[name] = merged[name];
    }
    const common: Partial<LLMInvocation> = {
      sessionId: string(merged, 'gen_ai.session.id'),
      userId: string(merged, 'user.id') ?? string(merged, 'gen_ai.user.id'),
      conversationId: string(merged, 'gen_ai.conversation.id'),
      agentName: string(merged, 'gen_ai.agent.name'),
      provider: string(merged, 'gen_ai.provider.name'),
      requestModel: string(merged, 'gen_ai.request.model'),
      responseModelName: string(merged, 'gen_ai.response.model'),
      responseId: string(merged, 'gen_ai.response.id'),
      inputMessages: (start['gen_ai.input.messages'] ?? end['gen_ai.input.messages']) as InputMessage[] | undefined,
      outputMessages: outputMessages(end['gen_ai.output.messages'], terminalReason(end)),
      systemInstruction: merged['gen_ai.system_instructions'] as MessagePart[] | undefined,
      toolDefinitions: toolDefinitions(merged['gen_ai.tool.definitions']),
      finishReasons: finishReasons(merged),
      temperature: number(merged, 'gen_ai.request.temperature'),
      topP: number(merged, 'gen_ai.request.top_p'),
      topK: number(merged, 'gen_ai.request.top_k'),
      frequencyPenalty: number(merged, 'gen_ai.request.frequency_penalty'),
      presencePenalty: number(merged, 'gen_ai.request.presence_penalty'),
      seed: number(merged, 'gen_ai.request.seed'),
      choiceCount: number(merged, 'gen_ai.request.choice.count'),
      stopSequences: merged['gen_ai.request.stop_sequences'] as string[] | undefined,
      outputType: string(merged, 'gen_ai.output.type'),
      serverAddress: string(merged, 'server.address'),
      serverPort: number(merged, 'server.port'),
      maxTokens: number(merged, 'gen_ai.request.max_tokens'),
      inputTokens: number(merged, 'gen_ai.usage.input_tokens'),
      outputTokens: number(merged, 'gen_ai.usage.output_tokens'),
      totalTokens: number(merged, 'gen_ai.usage.total_tokens'),
      usageCacheReadInputTokens: number(merged, 'gen_ai.usage.cache_read.input_tokens'),
      usageCacheCreationInputTokens: number(merged, 'gen_ai.usage.cache_creation.input_tokens'),
      passthroughAttributes,
    };
    const errorType = string(end, 'error.type');
    const errorMessage = string(end, 'error.message');
    const error: GenAIError | undefined = errorType || errorMessage || end['tool.result.status'] === 'error'
      ? { type: errorType ?? 'Error', message: errorMessage ?? 'QwenPaw invocation failed' }
      : undefined;
    const ttft = number(merged, 'gen_ai.response.time_to_first_token');
    const durationSeconds = Number(BigInt(end.time_unix_nano) - BigInt(start.time_unix_nano)) / 1e9;
    const validTtft = ttft !== undefined && ttft >= 0 && ttft / 1e9 <= durationSeconds ? ttft : undefined;
    const finish = <T extends GenAIInvocation & Partial<LLMInvocation>>(
      invocation: T,
      startFn: (inv: T, parent: Context, time: number) => T,
      stopFn: (inv: T, time: number) => T,
      failFn: (inv: T, error: GenAIError, time: number) => T,
    ): Context | undefined => {
      startFn(invocation, parentContext, startTime);
      // Public handlers initialize these to wall-clock processing time. The
      // historical event interval must instead drive duration/TTFT metrics.
      invocation.monotonicStartS = performance.now() / 1000 - durationSeconds;
      invocation.monotonicEndS = invocation.monotonicStartS + durationSeconds;
      if (validTtft !== undefined) {
        invocation.monotonicFirstTokenS = invocation.monotonicStartS + validTtft / 1e9;
      }
      if (error) failFn(invocation, error, endTime);
      else stopFn(invocation, endTime);
      spanCount++;
      return invocation.contextToken ?? undefined;
    };
    let ctx: Context | undefined;
    switch (kind) {
      case 'entry':
        ctx = finish(createEntryInvocation({ ...common, responseTimeToFirstToken: validTtft }),
          handler.startEntry.bind(handler), handler.stopEntry.bind(handler), handler.failEntry.bind(handler));
        break;
      case 'agent':
        ctx = finish(createInvokeAgentInvocation(common.provider ?? '', {
          ...common, provider: common.provider ?? '', agentId: string(merged, 'gen_ai.agent.id'),
        }), handler.startInvokeAgent.bind(handler), handler.stopInvokeAgent.bind(handler), handler.failInvokeAgent.bind(handler));
        break;
      case 'step':
        ctx = finish(createReactStepInvocation({
          ...common, round: number(merged, 'agent.qwenpaw.reasoning.round'),
          finishReason: string(end, 'gen_ai.react.finish_reason')
            ? finishReason(string(end, 'gen_ai.react.finish_reason')!)
            : finishReasons(end)?.[0],
        }),
          handler.startReactStep.bind(handler), handler.stopReactStep.bind(handler), handler.failReactStep.bind(handler));
        break;
      case 'llm':
        ctx = finish(createLLMInvocation(common),
          handler.startLlm.bind(handler), handler.stopLlm.bind(handler), handler.failLlm.bind(handler));
        break;
      case 'tool':
        ctx = finish(createExecuteToolInvocation(string(merged, 'gen_ai.tool.name') ?? '', {
          ...common,
          toolCallId: string(merged, 'gen_ai.tool.call.id'),
          toolDescription: string(merged, 'gen_ai.tool.description'),
          toolType: string(merged, 'gen_ai.tool.type'),
          skillId: string(merged, 'gen_ai.skill.id'),
          skillName: string(merged, 'gen_ai.skill.name'),
          skillDescription: string(merged, 'gen_ai.skill.description'),
          skillVersion: string(merged, 'gen_ai.skill.version'),
          toolCallArguments: start['gen_ai.tool.call.arguments'],
          toolCallResult: end['gen_ai.tool.call.result'],
        }), handler.startExecuteTool.bind(handler), handler.stopExecuteTool.bind(handler), handler.failExecuteTool.bind(handler));
        break;
    }
    if (ctx) contexts.set(key, ctx);
    return ctx;
  }
  for (const key of pairs.keys()) emit(key);
  return { spanCount, warnings };
}
