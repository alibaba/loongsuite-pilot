import * as path from 'node:path';
import type { JsonValue } from '../../types/index.js';
import type {
  CodexPartialTurnExtraction,
  CodexExtractedTranscriptTurn,
  CodexTerminalStatus,
  CodexTranscriptMeta,
  CodexTranscriptSourceRecord,
  CodexTranscriptSourceRange,
  CodexTranscriptStep,
  CodexTranscriptTool,
  CodexTranscriptUsage,
} from './codex-transcript-types.js';
import { timestampMs } from './codex-transcript-utils.js';

export function extractCodexTranscriptMeta(record: Record<string, unknown>): CodexTranscriptMeta | null {
  if (record.type !== 'session_meta') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;

  const baseInstructions = readInstructionText(payload.base_instructions);
  const toolDefinitions = Array.isArray(payload.dynamic_tools)
    ? toJsonValue(payload.dynamic_tools)
    : undefined;
  return {
    sessionId: stringValue(payload.id) ?? '',
    provider: stringValue(payload.model_provider) ?? 'openai',
    ...(baseInstructions ? { baseInstructions } : {}),
    ...(toolDefinitions !== undefined ? { toolDefinitions } : {}),
  };
}

export function extractCodexTerminalTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
): CodexExtractedTranscriptTurn | null {
  return extractCodexTurn(toSourceRecords(records), meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: true,
  })?.turn ?? null;
}

export function extractCodexPartialTurn(
  records: Record<string, unknown>[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  } = {},
): CodexExtractedTranscriptTurn | null {
  return extractCodexTurn(toSourceRecords(records), meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: false,
    startedAtMs: opts.startedAtMs,
    model: opts.model,
    cwd: opts.cwd,
    developerInstructions: opts.developerInstructions,
  })?.turn ?? null;
}

export function extractCodexPartialTurnWithBoundaries(
  records: CodexTranscriptSourceRecord[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  } = {},
): CodexPartialTurnExtraction | null {
  return extractCodexTurn(records, meta, fallbackSessionId, expectedTurnId, {
    requireTerminal: false,
    startedAtMs: opts.startedAtMs,
    model: opts.model,
    cwd: opts.cwd,
    developerInstructions: opts.developerInstructions,
  });
}

interface StepEnvelope {
  step: CodexTranscriptStep;
  sourceRange: CodexTranscriptSourceRange;
  llmClosed: boolean;
  followedByAnotherWave: boolean;
}

function extractCodexTurn(
  records: CodexTranscriptSourceRecord[],
  meta: CodexTranscriptMeta | null,
  fallbackSessionId: string,
  expectedTurnId: string,
  opts: {
    requireTerminal: boolean;
    startedAtMs?: number;
    model?: string;
    cwd?: string;
    developerInstructions?: string;
  },
): CodexPartialTurnExtraction | null {
  let currentTurnId = opts.requireTerminal ? '' : expectedTurnId;
  let startedAtMs = opts.startedAtMs ?? 0;
  let terminalAtMs = 0;
  let status: CodexTerminalStatus | null = null;
  let sawTerminal = false;
  let finalText: string | undefined;
  let model = opts.model ?? 'unknown';
  let cwd = opts.cwd;
  let developerInstructions = opts.developerInstructions;
  let prompt: string | undefined;
  const promptParts: string[] = [];
  const inputMessages: JsonValue[] = [];
  const stepEnvelopes: StepEnvelope[] = [];
  const unmatchedTokenUsages: CodexTranscriptUsage[] = [];
  const toolSteps = new Map<string, StepEnvelope>();
  const webSearchStarts = new Map<string, number>();
  const webSearchEnds = new Map<string, number>();
  let currentStep: StepEnvelope | null = null;
  let lastUsage: CodexTranscriptUsage | undefined;
  let lastActivityAtMs = 0;

  const beginStep = (timestamp: number, source: CodexTranscriptSourceRecord): StepEnvelope => {
    if (!currentStep) {
      const previous = stepEnvelopes.at(-1);
      if (previous?.llmClosed) previous.followedByAnotherWave = true;
      currentStep = {
        step: {
          startedAtMs: timestamp,
          responseAtMs: timestamp,
          hasResponseEvidence: false,
          completedAtMs: timestamp,
          reasoning: [],
          tools: [],
        },
        sourceRange: {
          startOffset: source.startOffset,
          endOffset: source.endOffset,
        },
        llmClosed: false,
        followedByAnotherWave: false,
      };
    }
    return currentStep;
  };

  const touchStep = (envelope: StepEnvelope, source: CodexTranscriptSourceRecord): void => {
    envelope.sourceRange.startOffset = Math.min(envelope.sourceRange.startOffset, source.startOffset);
    envelope.sourceRange.endOffset = Math.max(envelope.sourceRange.endOffset, source.endOffset);
  };

  const stepToolsComplete = (step: CodexTranscriptStep): boolean => (
    step.tools.length > 0 && step.tools.every(tool => tool.completedAtMs !== undefined)
  );

  const flushCurrentStep = (force = false): void => {
    if (!currentStep) return;
    const step = currentStep.step;
    if (force || step.reasoning.length > 0 || step.tools.length > 0 || step.finalText) {
      stepEnvelopes.push(currentStep);
    }
    currentStep = null;
  };
  // TypeScript cannot infer mutations made by beginStep/flushCurrentStep through
  // their closures, so read the mutable step through an explicitly typed getter.
  const activeStep = (): StepEnvelope | null => currentStep;
  const appendPrompt = (value: string | undefined): void => {
    if (!value || promptParts.includes(value)) return;
    promptParts.push(value);
    prompt = promptParts.join('\n');
  };
  const markActivity = (timestamp: number): void => {
    if (timestamp > 0) lastActivityAtMs = timestamp;
  };

  for (const source of records) {
    const record = source.record;
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const timestamp = timestampMs(record, Date.now());

    if (record.type === 'turn_context') {
      const turnId = stringValue(payload.turn_id);
      if (turnId !== expectedTurnId) continue;
      currentTurnId = turnId;
      startedAtMs ||= timestamp;
      markActivity(timestamp);
      model = stringValue(payload.model) ?? model;
      cwd = stringValue(payload.cwd) ?? cwd;
      developerInstructions = stringValue(payload.developer_instructions) ?? developerInstructions;
      continue;
    }

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = stringValue(payload.turn_id);
      if (turnId === expectedTurnId) {
        currentTurnId = turnId;
        startedAtMs ||= timestamp;
        markActivity(timestamp);
      }
      continue;
    }

    if (currentTurnId !== expectedTurnId) continue;

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        appendPrompt(stringValue(payload.message));
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'agent_message') {
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const message = stringValue(payload.message);
        if (message) {
          const next = beginStep(lastActivityAtMs || timestamp, source);
          touchStep(next, source);
          const nextStep = next.step;
          nextStep.responseAtMs = timestamp;
          nextStep.hasResponseEvidence = true;
          if (nextStep.reasoning[nextStep.reasoning.length - 1] !== message) {
            nextStep.reasoning.push(message);
          }
        }
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'web_search_start') {
        const callId = stringValue(payload.call_id);
        if (callId) webSearchStarts.set(callId, timestamp);
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const next = beginStep(lastActivityAtMs || timestamp, source);
        touchStep(next, source);
        const nextStep = next.step;
        nextStep.responseAtMs = timestamp;
        nextStep.hasResponseEvidence = true;
        markActivity(timestamp);
        continue;
      }
      if (payload.type === 'web_search_end') {
        const callId = stringValue(payload.call_id);
        if (callId) {
          webSearchEnds.set(callId, timestamp);
          const envelope = toolSteps.get(callId);
          const step = envelope?.step;
          const tool = step?.tools.find(candidate => candidate.callId === callId);
          if (tool) {
            tool.completedAtMs = timestamp;
            step!.completedAtMs = Math.max(step!.completedAtMs, timestamp);
            touchStep(envelope!, source);
          }
        }
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = extractLastTokenUsage(payload.info);
        if (!usage) continue;
        const envelope = activeStep();
        if (envelope?.step.hasResponseEvidence) {
          envelope.step.tokenUsage = usage;
          envelope.step.completedAtMs = Math.max(envelope.step.completedAtMs, timestamp);
          envelope.llmClosed = true;
          touchStep(envelope, source);
          lastUsage = usage;
          markActivity(timestamp);
          flushCurrentStep();
        } else if (!sameUsage(lastUsage, usage)) {
          // Do not shift an unanchored sample onto a later response wave.
          unmatchedTokenUsages.push(usage);
          lastUsage = usage;
        }
        continue;
      }
      if (payload.type === 'task_complete' && stringValue(payload.turn_id) === expectedTurnId) {
        status = 'completed';
        sawTerminal = true;
        terminalAtMs = timestamp;
        finalText = stringValue(payload.last_agent_message);
        break;
      }
      if (payload.type === 'turn_aborted' && stringValue(payload.turn_id) === expectedTurnId) {
        status = 'interrupted';
        sawTerminal = true;
        terminalAtMs = timestamp;
        break;
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    const itemType = stringValue(payload.type);
    if (itemType === 'message') {
      const role = stringValue(payload.role);
      if (role === 'assistant') {
        const active = activeStep();
        if (active && stepToolsComplete(active.step)) flushCurrentStep();
        const envelope = beginStep(lastActivityAtMs || timestamp, source);
        touchStep(envelope, source);
        const step = envelope.step;
        step.responseId ??= stringValue(payload.id);
        step.responseAtMs = timestamp;
        step.hasResponseEvidence = true;
        const message = extractMessageText(payload.content);
        if (message && step.reasoning[step.reasoning.length - 1] !== message) {
          step.reasoning.push(message);
        }
      } else if (role) {
        const message = transcriptInputMessage(role, payload.content);
        if (message) {
          inputMessages.push(message);
          if (role === 'user') appendPrompt(message.parts[0]?.content);
        }
        markActivity(timestamp);
      }
      continue;
    }

    if (itemType === 'reasoning') {
      const active = activeStep();
      if (active && stepToolsComplete(active.step)) flushCurrentStep();
      const envelope = beginStep(lastActivityAtMs || timestamp, source);
      touchStep(envelope, source);
      const step = envelope.step;
      step.responseId ??= stringValue(payload.id);
      step.responseAtMs = timestamp;
      step.hasResponseEvidence = true;
      markActivity(timestamp);
      continue;
    }

    const call = transcriptToolCall(itemType, payload, timestamp);
    if (call) {
      const active = activeStep();
      if (active && stepToolsComplete(active.step)) flushCurrentStep();
      if (call.name === 'web_search') {
        call.startedAtMs = webSearchStarts.get(call.callId) ?? (lastActivityAtMs || timestamp);
        call.completedAtMs = webSearchEnds.get(call.callId) ?? timestamp;
      }
      const envelope = beginStep(lastActivityAtMs || call.startedAtMs, source);
      touchStep(envelope, source);
      const step = envelope.step;
      step.responseId ??= stringValue(payload.id);
      if (call.name !== 'web_search') {
        step.responseAtMs = step.tools.length === 0
          ? call.startedAtMs
          : Math.min(step.responseAtMs, call.startedAtMs);
        step.hasResponseEvidence = true;
      } else if (!step.hasResponseEvidence) {
        step.responseAtMs = call.name === 'web_search'
          ? call.completedAtMs ?? call.startedAtMs
          : call.startedAtMs;
        step.hasResponseEvidence = true;
      }
      step.tools.push(call);
      toolSteps.set(call.callId, envelope);
      markActivity(call.completedAtMs ?? timestamp);
      continue;
    }

    const toolOutput = transcriptToolOutput(itemType, payload);
    if (!toolOutput) continue;
    const envelope = toolSteps.get(toolOutput.callId);
    if (!envelope) continue;
    const step = envelope.step;
    const tool = step.tools.find(candidate => candidate.callId === toolOutput.callId);
    if (!tool) continue;
    tool.completedAtMs = timestamp;
    tool.output = toolOutput.output;
    step.completedAtMs = Math.max(step.completedAtMs, timestamp);
    touchStep(envelope, source);
    markActivity(timestamp);
  }

  if (opts.requireTerminal && (!status || !terminalAtMs)) return null;

  const finalActiveStep = activeStep();
  if (finalActiveStep && stepToolsComplete(finalActiveStep.step)) flushCurrentStep();
  if (!status && !opts.requireTerminal) {
    if (stepEnvelopes.length === 0 && !prompt) return null;
    terminalAtMs = lastActivityAtMs || startedAtMs || Date.now();
    status = 'completed';
  } else if (status === 'completed') {
    let terminalEnvelope = activeStep() ?? stepEnvelopes.at(-1) ?? null;
    if (!terminalEnvelope) {
      const terminalSource = records.at(-1) ?? {
        startOffset: 0,
        endOffset: 0,
        record: {},
      };
      terminalEnvelope = beginStep(lastActivityAtMs || startedAtMs || terminalAtMs, terminalSource);
      terminalEnvelope.step.responseAtMs = terminalAtMs;
    }
    if (terminalEnvelope) {
      const step = terminalEnvelope.step;
      if (finalText) {
        if (step.reasoning[step.reasoning.length - 1] === finalText) step.reasoning.pop();
        step.finalText = finalText;
      }
      step.completedAtMs = terminalAtMs;
      if (terminalEnvelope === activeStep()) flushCurrentStep(true);
    }
  } else if (activeStep()) {
    activeStep()!.step.completedAtMs = terminalAtMs;
    flushCurrentStep();
  }

  const resolvedStatus = status ?? 'completed';
  const steps = stepEnvelopes.map(envelope => envelope.step);
  const turn: CodexExtractedTranscriptTurn = {
    sessionId: meta?.sessionId || fallbackSessionId,
    transcriptTurnId: expectedTurnId,
    provider: meta?.provider ?? 'openai',
    model,
    status: resolvedStatus,
    startedAtMs: startedAtMs || terminalAtMs,
    terminalAtMs,
    ...(prompt ? { prompt } : {}),
    inputMessages,
    ...(cwd ? { cwd } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(meta?.baseInstructions ? { baseInstructions: meta.baseInstructions } : {}),
    ...(meta?.toolDefinitions !== undefined ? { toolDefinitions: meta.toolDefinitions } : {}),
    steps,
    unmatchedTokenUsages,
  };
  const committedEnvelopes = sawTerminal
    ? stepEnvelopes
    : leadingIncrementallyCommittableSteps(stepEnvelopes);
  return {
    turn,
    committedStepCount: committedEnvelopes.length,
    committedStepRanges: committedEnvelopes.map(envelope => ({ ...envelope.sourceRange })),
    consumedEndOffset: committedEnvelopes.at(-1)?.sourceRange.endOffset ?? records[0]?.startOffset ?? 0,
  };
}

function leadingIncrementallyCommittableSteps(envelopes: StepEnvelope[]): StepEnvelope[] {
  const committed: StepEnvelope[] = [];
  for (const envelope of envelopes) {
    if (!envelope.llmClosed) break;
    const toolsComplete = envelope.step.tools.length > 0
      && envelope.step.tools.every(tool => tool.completedAtMs !== undefined);
    if (!toolsComplete && !envelope.followedByAnotherWave) break;
    committed.push(envelope);
  }
  return committed;
}

function toSourceRecords(records: Record<string, unknown>[]): CodexTranscriptSourceRecord[] {
  return records.map((record, index) => ({
    startOffset: index,
    endOffset: index + 1,
    record,
  }));
}

export function sessionIdFromTranscriptPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match?.[1] ?? base;
}

function transcriptToolCall(
  itemType: string | undefined,
  payload: Record<string, unknown>,
  timestamp: number,
): CodexTranscriptTool | null {
  if (itemType === 'web_search_call') {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `web_search:${timestamp}`;
    return {
      callId,
      name: 'web_search',
      input: toJsonValue(parseMaybeJson(payload.action)),
      startedAtMs: timestamp,
      output: toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.action !== undefined ? { action: parseMaybeJson(payload.action) } : {}),
      }),
      completedAtMs: timestamp,
    };
  }
  if (itemType !== 'function_call' && itemType !== 'custom_tool_call' && itemType !== 'tool_search_call') return null;
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
  if (!callId) return null;
  const name = stringValue(payload.name) ?? (itemType === 'tool_search_call' ? 'tool_search' : 'unknown');
  const rawInput = itemType === 'custom_tool_call' ? payload.input : payload.arguments;
  return {
    callId,
    name,
    input: normalizeToolInput(name, parseMaybeJson(rawInput)),
    startedAtMs: timestamp,
  };
}

function transcriptToolOutput(
  itemType: string | undefined,
  payload: Record<string, unknown>,
): { callId: string; output?: JsonValue } | null {
  if (itemType !== 'function_call_output' && itemType !== 'custom_tool_call_output' && itemType !== 'tool_search_output') return null;
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
  if (!callId) return null;
  if (itemType === 'tool_search_output') {
    return {
      callId,
      output: toJsonValue({
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.execution !== undefined ? { execution: payload.execution } : {}),
        ...(payload.tools !== undefined ? { tools: parseMaybeJson(payload.tools) } : {}),
      }),
    };
  }
  return { callId, output: toJsonValue(parseMaybeJson(payload.output)) };
}

function normalizeToolInput(name: string, value: unknown): JsonValue | undefined {
  const input = toJsonValue(value);
  const record = asRecord(value);
  if (name === 'Bash' || name === 'exec_command') {
    const command = stringValue(record?.command) ?? stringValue(record?.cmd);
    if (!command) return input;
    return {
      command,
      ...(stringValue(record?.workdir) ? { workdir: stringValue(record?.workdir)! } : {}),
    };
  }
  if (name === 'apply_patch' && typeof value === 'string') return { command: value };
  return input;
}

function transcriptInputMessage(role: string, content: unknown): { role: string; parts: Array<{ type: 'text'; content: string }> } | null {
  const text = extractMessageText(content);
  return text ? { role, parts: [{ type: 'text', content: text }] } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readInstructionText(value: unknown): string | undefined {
  const record = asRecord(value);
  return stringValue(record?.text) ?? stringValue(value);
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string' && content) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(item => {
    if (typeof item === 'string') return [item];
    const record = asRecord(item);
    return stringValue(record?.text) ? [stringValue(record?.text)!] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
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
  if (Array.isArray(value)) return value.flatMap(item => {
    const json = toJsonValue(item);
    return json === undefined ? [] : [json];
  });
  const record = asRecord(value);
  if (!record) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const json = toJsonValue(item);
    if (json !== undefined) output[key] = json;
  }
  return output;
}

function extractLastTokenUsage(value: unknown): CodexTranscriptUsage | undefined {
  const info = asRecord(value);
  const raw = asRecord(info?.last_token_usage);
  if (!raw) return undefined;
  const inputTokens = numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = numberValue(raw.cached_input_tokens) ?? 0;
  const cacheCreationTokens = numberValue(raw.cache_creation_input_tokens) ?? 0;
  const totalTokens = numberValue(raw.total_tokens);
  const reasoningOutputTokens = numberValue(raw.reasoning_output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    totalTokens: totalTokens && totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sameUsage(left: CodexTranscriptUsage | undefined, right: CodexTranscriptUsage): boolean {
  return left !== undefined
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.cacheCreationTokens === right.cacheCreationTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.totalTokens === right.totalTokens;
}
