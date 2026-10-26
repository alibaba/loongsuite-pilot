export const DOUBAO_EPOCH = Date.parse('2026-10-25T03:00:00.000Z');
const date = new Date(DOUBAO_EPOCH);
const pad = (value: number, length = 2) => String(value).padStart(length, '0');
export const DOUBAO_FILE = `saman_frontend_${date.getFullYear()}.${pad(date.getMonth() + 1)}${pad(date.getDate())}.0.log`;

/** Entirely synthetic identifiers, metadata and message content. */
export function doubaoLine(name: string, meta: Record<string, unknown> = {}, elapsedMs = 3000): string {
  const at = new Date(DOUBAO_EPOCH + elapsedMs);
  const clock = `${pad(at.getMonth() + 1)}${pad(at.getDate())}/${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}123`;
  const payload = {
    version: 1, type: 'event', level: 'info', eventName: name,
    meta: {
      chat_session_id: 'synthetic-turn', query_send_timestamp: DOUBAO_EPOCH,
      conversation_id: 'synthetic-conversation', send_local_message_id: 'synthetic-local-message',
      session_success: '1', receive_success: '1',
      ...meta,
    },
  };
  return `[100:200:${clock}:INFO:FRONTEND(0)] [neotix] [office-api-logger] "[webview][unknown][flow-web][logifier-report]: ${JSON.stringify(payload)}", source: (0)\n`;
}

export function doubaoFirstOutputLine(meta: Record<string, unknown> = {}, elapsedMs = 1002): string {
  return doubaoLine('flow_message_time', {
    task_session_id: 'synthetic-turn', metric_scene: 'sse', ev_name: 'cot_first_token', ev_type: 'query_duration',
    event_instance_id: 'synthetic-turn:sync:6:1', task_stage: 'sync', is_recovery: false, occurrence_index: 1,
    duration: 1000, answer_id: 'synthetic-answer', message_id: 'synthetic-query', ...meta,
  }, elapsedMs);
}

export function doubaoToolLine(
  data: Record<string, unknown>, elapsedMs: number, extraMicros = 123,
): string {
  const at = new Date(DOUBAO_EPOCH + elapsedMs);
  const clock = `${pad(at.getMonth() + 1)}${pad(at.getDate())}/${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}${pad(extraMicros, 3)}`;
  const level = data.status === 'error' ? 'ERROR' : 'INFO';
  return `[100:200:${clock}:${level}:FRONTEND(0)] [neotix] [agent-task] "${JSON.stringify({ event: 'toolcall', data: {
    name: 'Read', sandbox_id: 'synthetic-sandbox', status: 'received',
    tcid: 'synthetic-call', agent_id: 'synthetic-turn', ...data,
  } })}", source: local-file-local-tools-sse-wiring.ts (0)\n`;
}

export function doubaoCommandLine(agent: string, sandbox: string, elapsedMs = 50): string {
  return doubaoToolLine({ name: 'sandbox', agent_id: agent, sand_box_id: sandbox, command_id: `command-${agent}` }, elapsedMs)
    .replace('"event":"toolcall"', '"event":"command"');
}

const createdAgent = (call: string, child: string, parent: string, thread: string) => [
  { role: 'assistant', tool_calls: [{ id: call, function: { name: 'create_agent', arguments: { subtask: 'SYNTHETIC_PRIVATE' } } }] },
  { role: 'tool', tool_call_id: call, content: `create_agent ok\nagent_id: ${child}\nparent_id: ${parent}\nthread_id: ${thread}\nagent_type: organizer\nsubtask: SYNTHETIC_PRIVATE` },
].map(row => JSON.stringify(row)).join('\n') + '\n';

export const DOUBAO_NATIVE_FILES = {
  m_nativeMain: createdAgent('native-root-create', 'o_nativeOrg', 'main_agent', '101'),
  o_nativeOrg: createdAgent('native-child-create', 's_nativeLeaf', 'o_nativeOrg', '102'),
};
