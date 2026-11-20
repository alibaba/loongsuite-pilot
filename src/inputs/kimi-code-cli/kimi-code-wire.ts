import { createHash } from 'node:crypto';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { ClientType, type AgentActivityEntry, type JsonValue } from '../../types/index.js';
import { uuidV5 } from '../../utils/uuid.js';

type WireRecord = Record<string, unknown>;
const EVENT_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

interface ToolCall {
  id: string;
  uuid: string;
  name: string;
  time: number;
  args?: JsonValue;
  result?: { time: number; output?: JsonValue; failed: boolean };
}

interface Step {
  number: number;
  begin: number;
  responseTime?: number;
  responseId?: string;
  end?: number;
  model?: string;
  finishReason?: string;
  usage?: WireRecord;
  parts: JsonValue[];
  tools: ToolCall[];
}

interface Turn {
  nativeId: string;
  promptId: string;
  begin: number;
  input: JsonValue[];
  steps: Step[];
}

function object(value: unknown): WireRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as WireRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function turnID(value: unknown): string | undefined {
  const id = integer(value);
  return id === undefined ? string(value) : String(id);
}

function textPart(value: unknown): JsonValue | undefined {
  const part = object(value);
  const text = string(part?.text ?? part?.think);
  if (!text) return undefined;
  if (part?.type === 'text') return { type: 'text', content: text };
  if (part?.type === 'think') return { type: 'reasoning', content: text };
  return undefined;
}

function observeResponse(step: Step, time: number): void {
  if (time >= step.begin) step.responseTime = Math.min(step.responseTime ?? time, time);
}

export class KimiCodeWireTurn {
  private active?: Turn;
  lastCompletedTurn?: { promptId: string; endTime: number };

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly cutoff: number,
    private readonly captureContent: boolean,
    private readonly acceptedPrompt?: string,
  ) {}

  get hasActiveTurn(): boolean { return this.active !== undefined; }

  discardActiveTurn(): void { this.active = undefined; }

  accept(record: WireRecord): AgentActivityEntry[] {
    if (record.agentId !== 'main') return [];
    const time = integer(record.time);
    if (time === undefined) return [];
    if (record.type === 'turn.prompt') {
      const nativeId = turnID(record.turnId);
      const promptId = string(record.promptId);
      this.active = nativeId !== undefined && promptId && promptId !== this.acceptedPrompt
        && time >= this.cutoff && object(record.origin)?.kind === 'user'
        ? {
          nativeId, promptId, begin: time, steps: [],
          input: this.captureContent && Array.isArray(record.input) ? record.input.flatMap(part => textPart(part) ?? []) : [],
        }
        : undefined;
      return [];
    }

    const turn = this.active;
    if (!turn) return [];
    if (record.type === 'turn.ended' && turnID(record.turnId) === turn.nativeId) {
      this.active = undefined;
      if (time < turn.begin) return [];
      this.lastCompletedTurn = { promptId: turn.promptId, endTime: time };
      return this.entries(turn);
    }
    const step = turn.steps.at(-1);
    if (record.type === 'usage.record' && record.usageScope === 'turn' && step && step.end === undefined) {
      step.model = string(record.model);
      observeResponse(step, time);
    }
    const event = object(record.event);
    if (record.type !== 'context.append_loop_event' || !event) return [];
    if (event.type === 'tool.result') {
      const tool = turn.steps.flatMap(item => item.tools).find(call =>
        call.id === event.toolCallId && call.uuid === event.parentUuid);
      const result = object(event.result);
      if (tool && result && time >= tool.time) {
        tool.result = {
          time, failed: result.isError === true,
          output: this.captureContent && typeof result.output === 'string' ? result.output : undefined,
        };
      }
      return [];
    }
    if (turnID(event.turnId) !== turn.nativeId) return [];
    const stepNumber = integer(event.step);
    if (stepNumber === undefined) return [];
    if (event.type === 'step.begin') {
      turn.steps.push({ number: stepNumber, begin: time, parts: [], tools: [] });
    } else if (step && stepNumber === step.number && step.end === undefined) {
      this.acceptStepEvent(step, event, time);
    }
    return [];
  }

  private acceptStepEvent(step: Step, event: WireRecord, time: number): void {
    if (event.type === 'content.part') {
      const responseTime = integer(event.startedAt);
      observeResponse(step, responseTime ?? time);
      if (this.captureContent) {
        const part = textPart(event.part);
        if (part) step.parts.push(part);
      }
    } else if (event.type === 'tool.call') {
      const id = string(event.toolCallId);
      const uuid = string(event.uuid);
      const name = string(event.name);
      if (id && uuid && name) {
        step.tools.push({
          id, uuid, name, time,
          args: this.captureContent ? object(event.args) as JsonValue | undefined : undefined,
        });
      }
    } else if (event.type === 'step.end') {
      step.end = time;
      step.usage = object(event.usage);
      step.responseId = string(event.messageId);
      const reason = string(event.finishReason);
      step.finishReason = reason === 'tool_use' ? 'tool_call' : reason;
    }
  }

  private entries(turn: Turn): AgentActivityEntry[] {
    const completeSteps = turn.steps.filter(step => step.responseTime !== undefined && step.end !== undefined);
    const entries: AgentActivityEntry[] = [];
    const turnId = `${this.sessionId}:${turn.promptId}`;
    const traceId = createHash('sha256').update(turnId).digest('hex').slice(0, 32);
    for (const [index, step] of completeSteps.entries()) {
      const stepId = `${turnId}:${index + 1}`;
      const base = {
        trace_id: traceId,
        'gen_ai.agent.type': ClientType.KimiCodeCli,
        'gen_ai.agent.id': this.sessionId,
        'gen_ai.session.id': this.sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': step.responseId ?? stepId,
        'gen_ai.request.model': step.model,
        'workspace.path': this.cwd,
      };
      const previousTools = completeSteps[index - 1]?.tools ?? [];
      const lastToolResult = previousTools.reduce((latest, tool) => Math.max(latest, tool.result?.time ?? 0), 0);
      const requestTime = index === 0 ? turn.begin : lastToolResult > 0 && lastToolResult <= step.begin
        ? lastToolResult : step.begin;
      const toolResponses: JsonValue[] = this.captureContent ? previousTools.flatMap(tool => tool.result?.output === undefined ? [] : [{
        role: 'tool', parts: [{ type: 'tool_call_response', id: tool.id, response: tool.result.output }],
      }]) : [];
      const inputMessages = index === 0 && turn.input.length ? [{ role: 'user', parts: turn.input }] : toolResponses;
      entries.push(buildAgentActivityEntry({
        ...base, timestamp: requestTime, 'event.name': 'llm.request',
        'event.id': uuidV5(`${stepId}:request`, EVENT_NAMESPACE),
        'gen_ai.turn.start': index === 0,
        'gen_ai.input.messages_delta': inputMessages.length ? inputMessages : undefined,
      }));
      const outputParts: JsonValue[] = this.captureContent ? [...step.parts, ...step.tools.map(tool => ({
        type: 'tool_call', id: tool.id, name: tool.name,
        ...(tool.args === undefined ? {} : { arguments: tool.args }),
      }))] : [];
      const input = integer(step.usage?.inputOther);
      const cacheRead = integer(step.usage?.inputCacheRead);
      const cacheCreation = integer(step.usage?.inputCacheCreation);
      const output = integer(step.usage?.output);
      const inputTotal = input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheCreation ?? 0);
      entries.push(buildAgentActivityEntry({
        ...base, timestamp: step.responseTime!, 'event.name': 'llm.response',
        'event.id': uuidV5(`${stepId}:response`, EVENT_NAMESPACE),
        'gen_ai.turn.end': index === completeSteps.length - 1,
        'gen_ai.response.model': step.model,
        'response.finish_reasons': step.finishReason,
        'gen_ai.usage.input_tokens': inputTotal,
        'gen_ai.usage.total_tokens': inputTotal === undefined || output === undefined ? undefined : inputTotal + output,
        'gen_ai.usage.output_tokens': output,
        'gen_ai.usage.cache_read.input_tokens': cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
        'gen_ai.output.messages': outputParts.length ? [{ role: 'assistant', parts: outputParts }] : undefined,
      }));
      // Tool results are attributed only by the native parent UUID and call ID.
      for (const tool of step.tools) {
        const toolFields = { ...base, 'gen_ai.tool.name': tool.name, 'gen_ai.tool.call.id': tool.id };
        entries.push(buildAgentActivityEntry({
          ...toolFields, timestamp: tool.time, 'event.name': 'tool.call',
          'event.id': uuidV5(`${stepId}:${tool.uuid}:call`, EVENT_NAMESPACE),
          'gen_ai.tool.call.arguments': tool.args,
        }));
        if (tool.result) entries.push(buildAgentActivityEntry({
          ...toolFields, timestamp: tool.result.time, 'event.name': 'tool.result',
          'event.id': uuidV5(`${stepId}:${tool.uuid}:result`, EVENT_NAMESPACE),
          'gen_ai.tool.call.result': tool.result.output,
          'tool.result.status': tool.result.failed ? 'failure' : 'success',
          'gen_ai.tool.call.duration': tool.result.time > tool.time ? tool.result.time - tool.time : undefined,
        }));
      }
    }
    return entries;
  }
}
