import * as path from 'node:path';
import type { JsonValue } from '../../types/index.js';
import type {
  CodexExtractedAbortedTurn,
  CodexTokenUsage,
  CodexTokenUsageSample,
  CodexTranscriptMeta,
  CodexTimelineAssistantMessage,
  CodexTimelineEvent,
  CodexTimelineToolCall,
  CodexTimelineToolResult,
} from './codex-aborted-turn-types.js';
import { asRecord, stringValue, timestampMs } from './codex-aborted-turn-utils.js';

type CodexTimelineEventInput =
  | Omit<CodexTimelineAssistantMessage, 'sequence'>
  | Omit<CodexTimelineToolCall, 'sequence'>
  | Omit<CodexTimelineToolResult, 'sequence'>;

export function extractCodexTranscriptMeta(record: Record<string, unknown>): CodexTranscriptMeta | null {
  if (record.type !== 'session_meta') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;

  const baseInstructions = readInstructionText(payload.base_instructions);
  const definitions = Array.isArray(payload.dynamic_tools)
    ? toJsonValue(payload.dynamic_tools)
    : undefined;

  return {
    sessionId: stringValue(payload.id) ?? '',
    provider: stringValue(payload.model_provider) ?? 'openai',
    ...(baseInstructions ? { baseInstructions } : {}),
    ...(definitions !== undefined ? { toolDefinitions: definitions } : {}),
  };
}

export function extractAbortedTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
): CodexExtractedAbortedTurn | null {
  let currentTurnId = '';
  let startedAtMs: number | undefined;
  let abortedAtMs: number | undefined;
  let abortReason = 'interrupted';
  let model = 'unknown';
  let cwd: string | undefined;
  let developerInstructions: string | undefined;
  const promptParts: string[] = [];
  const timeline: CodexTimelineEvent[] = [];
  const toolCallIds = new Set<string>();
  const usageSamples: CodexTokenUsageSample[] = [];
  let lastUsage: CodexTokenUsage | undefined;
  let sequence = 0;

  const appendTimeline = (event: CodexTimelineEventInput): void => {
    const nextSequence = sequence++;
    if (event.kind === 'assistant_message') {
      timeline.push({
        kind: 'assistant_message',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        content: event.content,
      });
    } else if (event.kind === 'tool_call') {
      timeline.push({
        kind: 'tool_call',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        callId: event.callId,
        name: event.name,
        input: event.input,
      });
    } else {
      timeline.push({
        kind: 'tool_result',
        timestampMs: event.timestampMs,
        sequence: nextSequence,
        callId: event.callId,
        ...(event.output !== undefined ? { output: event.output } : {}),
      });
    }
  };

  for (const record of records) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const parsedTimestamp = timestampMs(record);
    const timestamp = parsedTimestamp ?? startedAtMs ?? Date.now();

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = stringValue(payload.turn_id);
      if (turnId === expectedTurnId) {
        currentTurnId = turnId;
        startedAtMs ??= timestamp;
      }
      continue;
    }

    if (record.type === 'turn_context') {
      const turnId = stringValue(payload.turn_id);
      if (turnId !== expectedTurnId) continue;
      currentTurnId = turnId;
      startedAtMs ??= timestamp;
      model = stringValue(payload.model) ?? model;
      cwd = stringValue(payload.cwd) ?? cwd;
      developerInstructions = stringValue(payload.developer_instructions) ?? developerInstructions;
      continue;
    }

    if (currentTurnId !== expectedTurnId) continue;

    if (record.type === 'event_msg') {
      if (payload.type === 'agent_message') {
        const message = stringValue(payload.message);
        if (message) appendTimeline({ kind: 'assistant_message', timestampMs: timestamp, content: message });
      } else if (payload.type === 'token_count') {
        const usage = extractLastTokenUsage(payload.info);
        if (usage && !sameUsage(lastUsage, usage)) {
          lastUsage = usage;
          usageSamples.push({ timestampMs: timestamp, sequence: sequence++, usage });
        }
      } else if (payload.type === 'turn_aborted' && stringValue(payload.turn_id) === expectedTurnId) {
        abortedAtMs = parsedTimestamp;
        abortReason = stringValue(payload.reason) ?? abortReason;
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    const itemType = stringValue(payload.type);
    if (itemType === 'message') {
      if (stringValue(payload.role) === 'user') {
        const text = extractMessageText(payload.content);
        if (text && !isTurnAbortedInjection(text)) promptParts.push(text);
      }
      continue;
    }

    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (!callId) continue;
      const inputField = itemType === 'custom_tool_call' ? payload.input : payload.arguments;
      appendTimeline({
        kind: 'tool_call',
        timestampMs: timestamp,
        callId,
        name: stringValue(payload.name) ?? (itemType === 'tool_search_call' ? 'tool_search' : 'unknown'),
        input: toJsonValue(parseMaybeJson(inputField)),
      });
      toolCallIds.add(callId);
      continue;
    }

    if (itemType === 'web_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `web_search:${timestamp}`;
      appendTimeline({
        kind: 'tool_call',
        timestampMs: timestamp,
        callId,
        name: 'web_search',
        input: toJsonValue(parseMaybeJson(payload.action)),
      });
      toolCallIds.add(callId);
      appendTimeline({
        kind: 'tool_result',
        timestampMs: timestamp,
        callId,
        output: toJsonValue({
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...(payload.action !== undefined ? { action: parseMaybeJson(payload.action) } : {}),
        }),
      });
      continue;
    }

    const outputType = itemType === 'function_call_output'
      || itemType === 'custom_tool_call_output'
      || itemType === 'tool_search_output';
    if (!outputType) continue;

    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) continue;
    if (!toolCallIds.has(callId)) continue;
    appendTimeline({
      kind: 'tool_result',
      timestampMs: timestamp,
      callId,
      output: itemType === 'tool_search_output'
        ? toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.execution !== undefined ? { execution: payload.execution } : {}),
        ...(payload.tools !== undefined ? { tools: parseMaybeJson(payload.tools) } : {}),
      })
        : toJsonValue(parseMaybeJson(payload.output)),
    });
  }

  if (abortedAtMs === undefined) return null;
  return {
    sessionId: meta?.sessionId || fallbackSessionId,
    transcriptTurnId: expectedTurnId,
    provider: meta?.provider ?? 'openai',
    model,
    ...(cwd ? { cwd } : {}),
    ...(promptParts.length > 0 ? { prompt: promptParts.join('\n\n') } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(meta?.baseInstructions ? { baseInstructions: meta.baseInstructions } : {}),
    ...(meta?.toolDefinitions !== undefined ? { toolDefinitions: meta.toolDefinitions } : {}),
    startedAtMs: startedAtMs ?? abortedAtMs,
    abortedAtMs,
    reason: abortReason,
    timeline,
    usageSamples,
  };
}

export function sessionIdFromTranscriptPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match?.[1] ?? base;
}

function readInstructionText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record && typeof record.text === 'string' && record.text) return record.text;
  return stringValue(value);
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string' && content) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(item => {
    if (typeof item === 'string') return [item];
    const record = asRecord(item);
    const text = record && stringValue(record.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isTurnAbortedInjection(text: string): boolean {
  return text.trimStart().startsWith('<turn_aborted>');
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const json = toJsonValue(item);
      return json === undefined ? [] : [json];
    });
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const json = toJsonValue(item);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function extractLastTokenUsage(value: unknown): CodexTokenUsage | undefined {
  const info = asRecord(value);
  const raw = info && asRecord(info.last_token_usage);
  if (!raw) return undefined;
  const inputTokens = numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.output_tokens);
  const cachedInputTokens = numberValue(raw.cached_input_tokens);
  const totalTokens = numberValue(raw.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const reasoningOutputTokens = numberValue(raw.reasoning_output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    totalTokens: totalTokens && totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sameUsage(left: CodexTokenUsage | undefined, right: CodexTokenUsage): boolean {
  return left !== undefined
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.totalTokens === right.totalTokens;
}
