import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';

const EVENTS = new Set([
  'on_message_session_start', 'on_message_sending_start',
  'on_message_sending_end', 'general_agent_message_id_mapping', 'on_message_session_end',
  'flow_message_time',
]);
const EVENT_PREFILTER = /"eventName"\s*:\s*"(?:on_message_session_start|on_message_sending_start|on_message_sending_end|general_agent_message_id_mapping|on_message_session_end|flow_message_time)"/;
const MIN_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);
// Observed present_files implementation: path validation is dispatched through
// Bash under a separate helper ID, rather than the trajectory's tool-call ID.
// Do not count that implementation detail as another GenAI Bash invocation.
const PRESENT_FILES_INSPECTION = /^present-files-path-inspection-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isDoubaoPresentationInspection(name: string, id: string): boolean {
  return name === 'Bash' && PRESENT_FILES_INSPECTION.test(id);
}

export interface DoubaoLogEvent {
  name: string;
  timeNano: string;
  queryMs?: number;
  turnId?: string;
  conversationId?: string;
  localMessageId?: string;
  clientOutcome?: 'received' | 'ended' | 'error' | 'cancelled';
  selectedSkills?: string[];
  selectedPartners?: string[];
  firstOutput?: { eventId: string; durationMs: number; answerId: string; messageId: string };
  command?: { agentId: string; sandboxId: string; id: string };
  tool?: {
    id: string;
    name: string;
    sandboxId: string;
    phase: 'received' | 'settled';
    status?: 'success' | 'error' | 'cancelled';
  };
}

/** Only bounded identifiers are retained; no log payload, prompt or error text. */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value) ? value : undefined;
}

function epoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_EPOCH_MS && value < MAX_EPOCH_MS ? value : undefined;
}

function selectedNames(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some(item => !identifier(item))) return undefined;
    return [...new Set(parsed as string[])];
  } catch { return undefined; }
}

/** Chromium's header is local wall time; the filename supplies the missing year. */
function sourceTime(line: string, fileName: string): string | undefined {
  const fileDate = /^saman(_frontend)?_(\d{4})\.(\d{2})(\d{2})\.\d+\.log$/.exec(fileName);
  if (!fileDate) return undefined;
  // Match the observed producer and precision for each source family. Other
  // Chromium/repair logs are not evidence of a client lifecycle boundary.
  const header = fileDate[1]
    ? /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{6}):(?:INFO|WARNING|ERROR):FRONTEND\(0\)\]/.exec(line)
    : /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{3}):(?:INFO|WARNING|ERROR):CONSOLE\(0\)\]/.exec(line);
  if (!header) return undefined;
  const [, month, day, hour, minute, second, fraction] = header.map(Number);
  const micros = fileDate[1] ? fraction : fraction * 1000;
  const fileYear = Number(fileDate[2]);
  const fileAnchor = new Date(fileYear, Number(fileDate[3]) - 1, Number(fileDate[4])).getTime();
  const candidates = [fileYear - 1, fileYear, fileYear + 1].map(year =>
    new Date(year, month - 1, day, hour, minute, second, Math.floor(micros / 1000)));
  const date = candidates.sort((a, b) => Math.abs(a.getTime() - fileAnchor) - Math.abs(b.getTime() - fileAnchor))[0];
  if (date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  return (BigInt(date.getTime()) * 1_000_000n + BigInt(micros % 1000) * 1000n).toString();
}

/** Parse the embedded logger object, not the outer Chromium log wrapper. */
export function parseDoubaoLogLine(line: string, fileName: string): DoubaoLogEvent | undefined {
  // This exact producer reports local dispatch receipt and execution settlement.
  // Ignore sandbox API payloads, cloud commands and all other log namespaces.
  if (line.includes('[neotix] [agent-task]')
    && line.endsWith(', source: local-file-local-tools-sse-wiring.ts (0)')) {
    const begin = line.indexOf('"{');
    const end = line.lastIndexOf('}", source:');
    if (begin < 0 || end < begin) return undefined;
    let object;
    try { object = JSON.parse(line.slice(begin + 1, end + 1)); } catch { return undefined; }
    const data = object?.data;
    if (object?.event === 'command' && data?.name === 'sandbox' && data.status === 'received') {
      const agentId = identifier(data.agent_id);
      const sandboxId = identifier(data.sand_box_id);
      const id = identifier(data.command_id);
      const timeNano = sourceTime(line, fileName);
      return agentId && sandboxId && id && timeNano
        ? { name: 'native_sandbox_actor', timeNano, command: { agentId, sandboxId, id } } : undefined;
    }
    if (object?.event !== 'toolcall' || !data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const name = identifier(data.name);
    const sandboxId = identifier(data.sandbox_id);
    const received = data.status === 'received' && data.phase === undefined;
    const id = identifier(received ? data.tcid : data.toolCallID);
    const turnId = identifier(data.agent_id);
    const timeNano = sourceTime(line, fileName);
    const status = data.status === 'success' ? 'success'
      : data.status === 'error' || data.status === 'failed' ? 'error'
      : data.status === 'cancelled' ? 'cancelled' : undefined;
    if (!name || !sandboxId || !id || !timeNano || (received ? !turnId : data.phase !== 'execution_settled' || !status)) return undefined;
    if (isDoubaoPresentationInspection(name, id)) return undefined;
    return {
      name: received ? 'local_tool_received' : 'local_tool_settled', timeNano,
      ...(received ? { turnId } : {}),
      tool: { id, name, sandboxId, phase: received ? 'received' : 'settled', ...(status ? { status } : {}) },
    };
  }
  // Most SDK lines are unrelated and may carry large payloads. Reject them
  // before JSON allocation; the parsed event name is still checked below.
  if (!line.includes('[office-api-logger]') || !EVENT_PREFILTER.test(line)) return undefined;
  const begin = line.indexOf('{"version":');
  const end = line.lastIndexOf('}');
  if (begin < 0 || end < begin) return undefined;
  let object: Record<string, unknown>;
  try { object = JSON.parse(line.slice(begin, end + 1)); } catch { return undefined; }
  if (object.version !== 1 || typeof object.eventName !== 'string' || !EVENTS.has(object.eventName)) return undefined;
  if (!object.meta || typeof object.meta !== 'object' || Array.isArray(object.meta)) return undefined;
  const timeNano = sourceTime(line, fileName);
  if (!timeNano) return undefined;
  const meta = object.meta as Record<string, unknown>;
  if (object.eventName === 'flow_message_time') {
    const turnId = identifier(meta.task_session_id);
    const eventId = identifier(meta.event_instance_id);
    const answerId = identifier(meta.answer_id), messageId = identifier(meta.message_id);
    const durationMs = meta.duration;
    if (!turnId || !eventId || !answerId || !messageId
      || !eventId.startsWith(`${turnId}:sync:`) || !/^\d+:1$/.test(eventId.slice(`${turnId}:sync:`.length))
      || meta.metric_scene !== 'sse' || meta.ev_name !== 'cot_first_token' || meta.ev_type !== 'query_duration'
      || meta.task_stage !== 'sync' || meta.is_recovery !== false || meta.occurrence_index !== 1
      || typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 86_400_000) return undefined;
    return { name: 'native_first_model_output', turnId, timeNano,
      firstOutput: { eventId, durationMs, answerId, messageId } };
  }
  // These are per-request SDK sessions, not persistent conversations.
  const turnId = identifier(meta.chat_session_id);
  const queryMs = epoch(meta.query_send_timestamp);
  if (object.eventName !== 'general_agent_message_id_mapping' && (!turnId || queryMs === undefined)) return undefined;
  let clientOutcome: DoubaoLogEvent['clientOutcome'];
  if (object.eventName === 'on_message_session_end') {
    const cancelled = identifier(meta.cancel_source);
    clientOutcome = cancelled && cancelled !== 'none' && cancelled !== '0' ? 'cancelled'
      : (meta.session_success === '0' || meta.session_success === 0 || meta.session_success === false) ? 'error'
      : (meta.receive_success === '1' || meta.receive_success === 1 || meta.receive_success === true) ? 'received' : 'ended';
  }
  return {
    name: object.eventName, timeNano, queryMs, turnId, clientOutcome,
    conversationId: identifier(meta.conversation_id ?? meta.conversationId),
    localMessageId: identifier(meta.send_local_message_id ?? meta.localMessageId),
    selectedSkills: selectedNames(meta.mention_skill_list),
    selectedPartners: selectedNames(meta.mention_partner_list),
  };
}

export interface DoubaoPendingTurn {
  turnId: string;
  queryMs: number;
  conversationId?: string;
  localMessageId?: string;
  updatedMs: number;
  selectedSkills?: string[];
  selectedPartners?: string[];
  firstOutput?: DoubaoLogEvent;
  firstOutputConflict?: boolean;
}

export interface DoubaoToolPair { start: DoubaoLogEvent; end: DoubaoLogEvent }

export function doubaoDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A reserved root AGENT identity lets late local observations link after export. */
export function doubaoRootAgentSpanId(traceId: string): string {
  return doubaoDigest(`doubao-work:root-agent:${traceId}`).slice(0, 16);
}

/** Local tool events and a client first-output observation are source facts,
 * not evidence of model requests, ReAct boundaries or whole task success. */
export function buildDoubaoTaskEvents(
  scope: string, pending: DoubaoPendingTurn, terminal: DoubaoLogEvent, observedMs: number,
  tools: DoubaoToolPair[] = [],
): AgentActivityEntry[] {
  const conversationId = terminal.conversationId ?? pending.conversationId;
  if (!conversationId || terminal.queryMs !== pending.queryMs) return [];
  const start = BigInt(pending.queryMs) * 1_000_000n;
  const end = BigInt(terminal.timeNano);
  if (end <= start) return [];
  const identity = JSON.stringify([scope, conversationId, pending.turnId, pending.queryMs]);
  const outcome = terminal.clientOutcome ?? 'ended';
  const context = {
    ...(pending.selectedSkills?.length ? { 'loongsuite.doubao_work.selected_skills': pending.selectedSkills } : {}),
    ...(pending.selectedPartners?.length ? { 'loongsuite.doubao_work.selected_partners': pending.selectedPartners } : {}),
  };
  const common: AgentActivityEntry = {
    time_unix_nano: start.toString(),
    observed_time_unix_nano: (BigInt(observedMs) * 1_000_000n).toString(),
    'event.id': '', 'event.name': 'other', 'user.id': '',
    trace_id: doubaoDigest(identity).slice(0, 32),
    'gen_ai.session.id': conversationId,
    'gen_ai.turn.id': pending.turnId,
    'gen_ai.agent.type': 'doubao-work',
    'gen_ai.agent.id': 'doubao-work',
    'gen_ai.agent.name': 'Doubao Work',
    'gen_ai.agent.system': 'doubao',
    'gen_ai.framework': 'doubao-work',
    'gen_ai.provider.name': 'bytedance.doubao',
    'loongsuite.doubao_work.observation_scope': 'client_message',
    'loongsuite.doubao_work.business_outcome': 'unknown',
    'loongsuite.doubao_work.client_outcome': outcome,
    ...context,
    resourceAttributes: {
      'loongsuite.doubao_work.observation_scope': 'client_message',
      'loongsuite.doubao_work.business_outcome': 'unknown',
      'loongsuite.doubao_work.client_outcome': outcome,
      ...context,
    },
  };
  const toolEvents: AgentActivityEntry[] = tools.flatMap(pair => {
    const call = pair.start.tool;
    const result = pair.end.tool;
    if (!call || !result || call.phase !== 'received' || result.phase !== 'settled'
      || !result.status || call.id !== result.id || call.name !== result.name
      || call.sandboxId !== result.sandboxId || pair.start.turnId !== pending.turnId) return [];
    const toolStart = BigInt(pair.start.timeNano);
    const toolEnd = BigInt(pair.end.timeNano);
    // Do not stretch a client request to include background or orphan activity.
    if (toolStart < start || toolEnd > end || toolEnd <= toolStart) return [];
    const toolIdentity = `${identity}:tool:${call.sandboxId}:${call.id}`;
    const attributes = {
      ...common,
      span_id: doubaoDigest(toolIdentity).slice(0, 16),
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': call.id,
      'gen_ai.tool.type': 'function',
      'loongsuite.doubao_work.tool_boundary': 'client_received_to_execution_settled',
    };
    return [
      { ...attributes, 'event.name': 'tool.call', 'event.id': doubaoDigest(`${toolIdentity}:call`), time_unix_nano: pair.start.timeNano },
      {
        ...attributes, 'event.name': 'tool.result', 'event.id': doubaoDigest(`${toolIdentity}:result`), time_unix_nano: pair.end.timeNano,
        'gen_ai.tool.call.duration': Number(toolEnd - toolStart) / 1_000_000,
        'tool.result.status': result.status,
        ...(result.status === 'success' ? {} : {
          'error.type': result.status === 'cancelled' ? 'doubao.local_tool_cancelled' : 'doubao.local_tool_failed',
        }),
      },
    ];
  });
  const observationEvents: AgentActivityEntry[] = [];
  const mark = !pending.firstOutputConflict && pending.firstOutput;
  if (mark && mark.turnId === pending.turnId && mark.firstOutput) {
    const output = mark.firstOutput;
    // Installed producer: duration = SSE receiveTimestamp - querySendTimestamp.
    // The logger header is only an upper bound; polling/render time is unused.
    const response = start + BigInt(output.durationMs) * 1_000_000n;
    if (response <= BigInt(mark.timeNano) && response <= end) {
      const stepId = doubaoDigest(`${identity}:first-output:${output.eventId}`);
      const attributes = {
        ...common,
        'loongsuite.doubao_work.observation_scope': 'native_first_model_output',
        'loongsuite.doubao_work.observation_boundary': 'client_submit_to_first_cot_receipt',
        'loongsuite.doubao_work.timing_basis': 'native_query_send_plus_sse_duration',
        'loongsuite.doubao_work.observation_completeness': 'first_output_only',
        'loongsuite.doubao_work.native_event_instance_id': output.eventId,
        'loongsuite.doubao_work.native_answer_id': output.answerId,
        'loongsuite.doubao_work.native_query_message_id': output.messageId,
        'loongsuite.doubao_work.client_time_to_first_cot_ms': output.durationMs,
      };
      observationEvents.push({ ...attributes, 'event.name': 'other',
        'event.id': doubaoDigest(`${stepId}:observation`), time_unix_nano: response.toString() });
    }
  }
  return [
    {
      ...common, 'event.id': doubaoDigest(`${identity}:start`),
      'gen_ai.turn.start': true,
      // Existing converter contract: a content-free input boundary, not a prompt.
      'gen_ai.input.messages_delta': [],
    },
    ...[...observationEvents, ...toolEvents].sort((a, b) => BigInt(a.time_unix_nano) < BigInt(b.time_unix_nano) ? -1 : 1),
    {
      ...common, time_unix_nano: end.toString(),
      'event.id': doubaoDigest(`${identity}:end`), 'gen_ai.turn.end': true,
      ...(outcome === 'error' ? {
        'error.type': 'doubao.client_request_failed',
      } : outcome === 'cancelled' ? {
        'error.type': 'doubao.client_request_cancelled',
      } : {}),
    },
  ];
}
