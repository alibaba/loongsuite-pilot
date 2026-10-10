import type { CopilotEvent } from '../../../src/inputs/copilot/copilot-types.js';

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
let counter = 0;

export function resetFixtureIds(): void {
  counter = 0;
}

export function ev(type: string, data: Record<string, unknown>, atMs: number): CopilotEvent {
  counter += 1;
  const id = (n: number) => `evt-${String(n).padStart(4, '0')}`;
  return {
    type,
    id: id(counter),
    timestamp: new Date(atMs).toISOString(),
    parentId: counter > 1 ? id(counter - 1) : null,
    data,
  };
}

export function toJsonl(events: CopilotEvent[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

function head(): CopilotEvent[] {
  return [
    ev('session.start', {
      sessionId: 's-1', version: 1, producer: 'copilot-agent', copilotVersion: '0.0.0',
      startTime: new Date(T0).toISOString(), selectedModel: 'auto', context: { cwd: '/work/demo' },
    }, T0),
    ev('session.auto_mode_resolved', { chosenModel: 'model-a' }, T0 + 100),
  ];
}

function userMessage(text: string, interactionId: string, at: number): CopilotEvent {
  return ev('user.message', { content: text, interactionId, messageId: `m-${interactionId}`, turnId: '0' }, at);
}

export function textOnlyTurn(): CopilotEvent[] {
  resetFixtureIds();
  return [
    ...head(),
    userMessage('hello world', 'i-1', T0 + 1_000),
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
    ev('assistant.message', {
      messageId: 'am-1', content: 'hi there', model: 'model-a', apiCallId: 'api-1',
      interactionId: 'i-1', turnId: '0',
    }, T0 + 2_000),
    ev('assistant.turn_end', { turnId: '0' }, T0 + 2_100),
  ];
}

export function toolTurn(): CopilotEvent[] {
  resetFixtureIds();
  return [
    ...head(),
    userMessage('read a.txt', 'i-1', T0 + 1_000),
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
    ev('assistant.message', {
      messageId: 'am-1', content: '', model: 'model-a', apiCallId: 'api-1', interactionId: 'i-1', turnId: '0',
      toolRequests: [{ toolCallId: 'call-1', name: 'view', arguments: { path: 'a.txt' }, type: 'function' }],
    }, T0 + 2_000),
    ev('tool.execution_start', { toolCallId: 'call-1', toolName: 'view', arguments: { path: 'a.txt' }, turnId: '0' }, T0 + 2_100),
    ev('tool.execution_complete', { toolCallId: 'call-1', success: true, result: { content: 'file body' }, turnId: '0' }, T0 + 2_300),
    ev('assistant.turn_end', { turnId: '0' }, T0 + 2_400),
    ev('assistant.turn_start', { turnId: '1', interactionId: 'i-1' }, T0 + 2_500),
    ev('assistant.message', {
      messageId: 'am-2', content: 'done', model: 'model-a', apiCallId: 'api-2', interactionId: 'i-1', turnId: '1',
    }, T0 + 3_500),
    ev('assistant.turn_end', { turnId: '1' }, T0 + 3_600),
  ];
}

export function parallelToolTurn(): CopilotEvent[] {
  resetFixtureIds();
  return [
    ...head(),
    userMessage('read both', 'i-1', T0 + 1_000),
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
    ev('assistant.message', {
      messageId: 'am-1', content: '', model: 'model-a', apiCallId: 'api-1', interactionId: 'i-1', turnId: '0',
      toolRequests: [
        { toolCallId: 'call-a', name: 'view', arguments: { path: 'a' }, type: 'function' },
        { toolCallId: 'call-b', name: 'view', arguments: { path: 'b' }, type: 'function' },
      ],
    }, T0 + 2_000),
    ev('tool.execution_start', { toolCallId: 'call-a', toolName: 'view', arguments: { path: 'a' }, turnId: '0' }, T0 + 2_100),
    ev('tool.execution_start', { toolCallId: 'call-b', toolName: 'view', arguments: { path: 'b' }, turnId: '0' }, T0 + 2_110),
    ev('tool.execution_complete', { toolCallId: 'call-b', success: true, result: { content: 'B' }, turnId: '0' }, T0 + 2_200),
    ev('tool.execution_complete', { toolCallId: 'call-a', success: true, result: { content: 'A' }, turnId: '0' }, T0 + 2_400),
    ev('assistant.turn_end', { turnId: '0' }, T0 + 2_500),
  ];
}

export function failedToolTurn(): CopilotEvent[] {
  resetFixtureIds();
  return [
    ...head(),
    userMessage('read missing', 'i-1', T0 + 1_000),
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
    ev('assistant.message', {
      messageId: 'am-1', content: '', model: 'model-a', apiCallId: 'api-1', interactionId: 'i-1', turnId: '0',
      toolRequests: [{ toolCallId: 'call-x', name: 'view', arguments: { path: 'nope' }, type: 'function' }],
    }, T0 + 2_000),
    ev('tool.execution_start', { toolCallId: 'call-x', toolName: 'view', arguments: { path: 'nope' }, turnId: '0' }, T0 + 2_100),
    ev('tool.execution_complete', { toolCallId: 'call-x', success: false, error: { code: 'failure', message: 'boom' }, turnId: '0' }, T0 + 2_200),
  ];
}

export function modelErrorTurn(withEarlierStep = false): CopilotEvent[] {
  resetFixtureIds();
  const earlier = withEarlierStep ? [
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
    ev('assistant.message', {
      messageId: 'am-1', content: '', model: 'model-a', apiCallId: 'api-1', interactionId: 'i-1', turnId: '0',
      toolRequests: [{ toolCallId: 'call-x', name: 'view', arguments: { path: 'a' }, type: 'function' }],
    }, T0 + 2_000),
    ev('tool.execution_start', { toolCallId: 'call-x', toolName: 'view', arguments: { path: 'a' }, turnId: '0' }, T0 + 2_100),
    ev('tool.execution_complete', { toolCallId: 'call-x', success: true, result: { content: 'A' }, turnId: '0' }, T0 + 2_200),
    ev('assistant.turn_start', { turnId: '1', interactionId: 'i-1' }, T0 + 2_300),
  ] : [
    ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 1_100),
  ];
  return [
    ...head(),
    userMessage('do it', 'i-1', T0 + 1_000),
    ...earlier,
    ev('assistant.turn_end', { turnId: withEarlierStep ? '1' : '0' }, T0 + 60_000),
    ev('session.error', {
      errorType: 'query', message: 'Execution failed: CAPIError: 400 The requested model is not supported.',
    }, T0 + 60_100),
  ];
}

export function shutdownEvent(
  atMs: number,
  models: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalNanoAiu?: number;
  }>,
  session: { nanoAiu?: number; premiumRequests?: number } = {},
): CopilotEvent {
  const modelMetrics = Object.fromEntries(
    Object.entries(models).map(([model, m]) => [model, {
      usage: {
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens ?? 0,
        cacheWriteTokens: m.cacheWriteTokens ?? 0,
        reasoningTokens: m.reasoningTokens ?? 0,
      },
      totalNanoAiu: m.totalNanoAiu ?? 0,
    }]),
  );
  return ev('session.shutdown', {
    shutdownType: 'routine', totalApiDurationMs: 1, sessionStartTime: T0, codeChanges: {}, modelMetrics,
    ...(session.nanoAiu !== undefined ? { totalNanoAiu: session.nanoAiu } : {}),
    ...(session.premiumRequests !== undefined ? { totalPremiumRequests: session.premiumRequests } : {}),
  }, atMs);
}

/** session.usage_checkpoint: written once per interaction with the cumulative session cost. */
export function checkpointEvent(atMs: number, nanoAiu?: number, premiumRequests?: number): CopilotEvent {
  return ev('session.usage_checkpoint', {
    ...(nanoAiu !== undefined ? { totalNanoAiu: nanoAiu } : {}),
    ...(premiumRequests !== undefined ? { totalPremiumRequests: premiumRequests } : {}),
    modelCacheState: [],
    promptCacheBreakState: [],
  }, atMs);
}
