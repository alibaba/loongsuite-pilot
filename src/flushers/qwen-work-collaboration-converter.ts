import { convertEventLogToTrace, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;

/** A collaboration card proves an Agent result, not a model response. */
export function convertQwenWorkCollaborationTurn(records: EventLogRecord[], options: Options) {
  const boundaries = records.filter(record => record['event.name'] === 'other'
    && record['agent.source'] === 'qwen-work-cn-collaboration');
  const start = boundaries.find(record => record['gen_ai.turn.start'] === true);
  const end = boundaries.find(record => record['gen_ai.turn.end'] === true);
  if (!start || !end || boundaries.length !== 2 || start['gen_ai.turn.id'] !== end['gen_ai.turn.id']
    || start['gen_ai.session.id'] !== end['gen_ai.session.id']) {
    return { spanCount: 0, traceIds: [], warnings: ['Incomplete Qwen Work collaboration turn'] };
  }
  const handler = options.handler;
  const wrapped = handler && new Proxy(handler, {
    get(target, key) {
      if (key === 'stopInvokeAgent' || key === 'stopEntry') {
        return (invocation: Parameters<ExtendedTelemetryHandler['stopInvokeAgent']>[0], endTime?: number) => {
          const output = end['gen_ai.output.messages'];
          if (Array.isArray(output)) invocation.outputMessages = output;
          return key === 'stopInvokeAgent' ? target.stopInvokeAgent(invocation, endTime) : target.stopEntry(invocation, endTime);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // The shared converter derives turn identity from user-input events. Content
  // policies can remove both input fields, so keep an empty marker only on the
  // conversion copy. It carries no message content and is never sent as an
  // AgentActivityEntry, but lets the converter retain the boundary's identity.
  const conversionBoundaries = start['gen_ai.input.messages'] || start['gen_ai.input.messages_delta']
    ? boundaries
    : boundaries.map(record => record === start ? { ...record, 'gen_ai.input.messages_delta': [] } : record);
  return convertEventLogToTrace(conversionBoundaries, { ...options, ...(wrapped ? { handler: wrapped } : {}) });
}
