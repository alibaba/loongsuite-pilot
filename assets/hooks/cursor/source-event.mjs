/**
 * source-event.mjs — Convert Cursor hook stdin payload to internal event.
 *
 * Sanitizes tool_use_id (strips \n suffix), extracts fields by hook event type,
 * and produces a flat internal event object for the event journal.
 */

export function sanitizeToolCallId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const idx = raw.indexOf('\n');
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim() || undefined;
}

export function toInternalEvent(payload) {
  const hookEvent = payload.hook_event_name || payload.hookEvent || payload.hookEventName || 'unknown';
  const conversationId = payload.conversation_id || payload.session_id || '';
  const sessionId = payload.session_id || payload.conversation_id || '';
  const generationId = payload.generation_id || undefined;
  const model = payload.model || undefined;

  const event = {
    _journal_ts: new Date().toISOString(),
    hook_event: hookEvent,
    conversation_id: conversationId,
    session_id: sessionId,
    generation_id: generationId,
    model,
  };

  switch (hookEvent) {
    case 'beforeSubmitPrompt':
      event.prompt = payload.prompt || undefined;
      event.composer_mode = payload.composer_mode || undefined;
      event.attachments = payload.attachments || undefined;
      break;

    case 'afterAgentThought':
      event.text = payload.text || undefined;
      event.duration_ms = toFiniteNumber(payload.duration_ms);
      break;

    case 'afterAgentResponse':
      event.text = payload.text || undefined;
      event.input_tokens = toFiniteNumber(payload.input_tokens);
      event.output_tokens = toFiniteNumber(payload.output_tokens);
      event.cache_read_tokens = toFiniteNumber(payload.cache_read_tokens);
      event.cache_write_tokens = toFiniteNumber(payload.cache_write_tokens);
      break;

    case 'preToolUse':
      event.tool_name = payload.tool_name || undefined;
      event.tool_use_id = sanitizeToolCallId(payload.tool_use_id);
      event.tool_input = payload.tool_input || undefined;
      event.cwd = payload.cwd || undefined;
      break;

    case 'postToolUse':
      event.tool_name = payload.tool_name || undefined;
      event.tool_use_id = sanitizeToolCallId(payload.tool_use_id);
      event.tool_input = payload.tool_input || undefined;
      event.tool_output = payload.tool_output || undefined;
      event.duration_ms = toFiniteNumber(payload.duration_ms) ?? toFiniteNumber(payload.duration);
      event.cwd = payload.cwd || undefined;
      break;

    case 'postToolUseFailure':
      event.tool_name = payload.tool_name || undefined;
      event.tool_use_id = sanitizeToolCallId(payload.tool_use_id);
      event.tool_input = payload.tool_input || undefined;
      event.error_message = payload.error_message || undefined;
      event.failure_type = payload.failure_type || undefined;
      event.is_interrupt = payload.is_interrupt || undefined;
      event.duration_ms = toFiniteNumber(payload.duration_ms) ?? toFiniteNumber(payload.duration);
      break;

    case 'stop':
      event.status = payload.status || undefined;
      event.loop_count = toFiniteNumber(payload.loop_count);
      event.input_tokens = toFiniteNumber(payload.input_tokens);
      event.output_tokens = toFiniteNumber(payload.output_tokens);
      event.cache_read_tokens = toFiniteNumber(payload.cache_read_tokens);
      event.cache_write_tokens = toFiniteNumber(payload.cache_write_tokens);
      break;

    case 'subagentStart':
      event.subagent_id = sanitizeToolCallId(payload.subagent_id);
      event.subagent_type = payload.subagent_type || undefined;
      event.parent_conversation_id = payload.parent_conversation_id || undefined;
      event.tool_call_id = sanitizeToolCallId(payload.tool_call_id);
      event.subagent_model = payload.subagent_model || undefined;
      event.is_parallel_worker = payload.is_parallel_worker || undefined;
      event.task = payload.task || undefined;
      break;

    case 'subagentStop':
      event.subagent_id = sanitizeToolCallId(payload.subagent_id);
      event.subagent_type = payload.subagent_type || undefined;
      event.parent_conversation_id = payload.parent_conversation_id || undefined;
      event.status = payload.status || undefined;
      event.duration_ms = toFiniteNumber(payload.duration_ms);
      event.message_count = toFiniteNumber(payload.message_count);
      event.tool_call_count = toFiniteNumber(payload.tool_call_count);
      event.loop_count = toFiniteNumber(payload.loop_count);
      event.task = payload.task || undefined;
      event.description = payload.description || undefined;
      event.error_message = payload.error_message || undefined;
      break;

    case 'sessionStart':
      event.is_background_agent = payload.is_background_agent;
      event.composer_mode = payload.composer_mode || undefined;
      break;

    default:
      break;
  }

  // common metadata
  event.cursor_version = payload.cursor_version || undefined;
  event.user_email = payload.user_email || undefined;
  event.workspace_roots = payload.workspace_roots || undefined;
  event.transcript_path = payload.transcript_path || undefined;

  return stripUndefined(event);
}

function toFiniteNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return undefined;
}

function stripUndefined(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) out[key] = val;
  }
  return out;
}
