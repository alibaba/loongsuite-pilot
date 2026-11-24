import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';

interface Bounds {
  start?: bigint;
  end?: bigint;
  ambiguous?: boolean;
  resultStatus?: string;
  errorType?: string;
}

interface StepBounds extends Bounds {
  stepId: string;
}

function setBoundary(bounds: Bounds, edge: 'start' | 'end', value: bigint): void {
  if (bounds[edge] !== undefined && bounds[edge] !== value) bounds.ambiguous = true;
  bounds[edge] = value;
}

function hrTime(nanos: bigint): [number, number] {
  return [Number(nanos / 1_000_000_000n), Number(nanos % 1_000_000_000n)];
}

/** Index the source intervals once so batch and incremental exports retain
 * native sub-millisecond tool timings and a consistent containing span tree. */
export function prepareStrandsSpanTiming(records: AgentActivityEntry[]): (spans: readonly ReadableSpan[]) => void {
  const turn: Bounds = {};
  const steps = new Map<number, StepBounds>();
  const models = new Map<string, Bounds>();
  const tools = new Map<string, Bounds>();

  for (const record of records) {
    const rawTime = record.time_unix_nano;
    if (typeof rawTime !== 'string' || !/^[1-9]\d{18}$/.test(rawTime)) continue;
    const time = BigInt(rawTime);
    if (record['gen_ai.turn.start'] === true) setBoundary(turn, 'start', time);
    if (record['gen_ai.turn.end'] === true) setBoundary(turn, 'end', time);
    const event = record['event.name'];
    if (event === 'other') continue;
    const stepId = record['gen_ai.step.id'];
    const round = record['gen_ai.react.round'];
    if (typeof stepId !== 'string' || typeof round !== 'number') continue;
    const step: StepBounds = steps.get(round) ?? { stepId };
    if (step.stepId !== stepId) step.ambiguous = true;
    if (step.start === undefined || time < step.start) step.start = time;
    if (step.end === undefined || time > step.end) step.end = time;
    steps.set(round, step);

    if (event === 'llm.request' || event === 'llm.response') {
      const model = models.get(stepId) ?? {};
      setBoundary(model, event === 'llm.request' ? 'start' : 'end', time);
      models.set(stepId, model);
    }
    const toolId = record['gen_ai.tool.call.id'];
    if (typeof toolId === 'string' && (event === 'tool.call' || event === 'tool.result')) {
      const key = `${stepId}\0${toolId}`;
      const tool = tools.get(key) ?? {};
      setBoundary(tool, event === 'tool.call' ? 'start' : 'end', time);
      if (event === 'tool.result') {
        if (typeof record['tool.result.status'] === 'string') tool.resultStatus = record['tool.result.status'];
        if (typeof record['error.type'] === 'string') tool.errorType = record['error.type'];
      }
      tools.set(key, tool);
    }
  }

  return spans => {
    for (const span of spans) {
      const attrs = span.attributes;
      const kind = attrs['gen_ai.span.kind'];
      const stepId = attrs['gen_ai.step.id'];
      const round = attrs['gen_ai.react.round'];
      const toolId = attrs['gen_ai.tool.call.id'];
      let bounds: Bounds | undefined;
      if (kind === 'ENTRY' || kind === 'AGENT') bounds = turn;
      else if (kind === 'STEP' && typeof round === 'number') {
        const step = steps.get(round);
        if (step && !step.ambiguous) attrs['gen_ai.step.id'] = step.stepId;
        bounds = step;
      } else if (kind === 'LLM' && typeof stepId === 'string') bounds = models.get(stepId);
      else if (kind === 'TOOL' && typeof stepId === 'string' && typeof toolId === 'string') {
        bounds = tools.get(`${stepId}\0${toolId}`);
      }
      if (!bounds || bounds.ambiguous) continue;
      if (bounds.resultStatus) span.attributes['tool.result.status'] = bounds.resultStatus;
      if (bounds.resultStatus === 'failure') {
        Object.assign(span.status, { code: SpanStatusCode.ERROR });
        if (bounds.errorType) span.attributes['error.type'] = bounds.errorType;
      }
      if (bounds.start === undefined || bounds.end === undefined || bounds.end <= bounds.start) continue;
      const { start, end } = bounds;
      // SDK ReadableSpan times are readonly, including a getter for duration.
      Object.defineProperties(span, {
        startTime: { value: hrTime(start), configurable: true },
        endTime: { value: hrTime(end), configurable: true },
        duration: { value: hrTime(end - start), configurable: true },
      });
    }
  };
}
