/** Developer-only protocol projection. These are wire facts, never LLM spans. */
const limit = 64 * 1024;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value) ? value : undefined;
const text = value => typeof value === 'string' && Buffer.byteLength(value) <= limit ? value : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Decode complete SSE frames, including UTF-8 and CRLF split across packets.
 * Oversized or truncated frames are discarded as a whole, never parsed as tails.
 */
export class SseFrames {
  constructor(onFrame, maxBytes = 256 * 1024) {
    this.onFrame = onFrame;
    this.maxBytes = maxBytes;
    this.decoder = new TextDecoder();
    this.line = '';
    this.lines = [];
    this.size = 0;
    this.skipLf = false;
    this.discard = false;
    this.dropped = 0;
  }
  push(bytes) { this.consume(this.decoder.decode(bytes, { stream: true })); }
  consume(value) {
    for (const char of value) {
      if (this.skipLf) { this.skipLf = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        this.skipLf = char === '\r';
        if (this.line === '') this.flush();
        else if (!this.discard) this.lines.push(this.line);
        this.line = '';
        continue;
      }
      this.size += Buffer.byteLength(char);
      if (this.size > this.maxBytes) {
        if (!this.discard) this.dropped++;
        this.discard = true;
        // Retain one sentinel so a newline in an oversized line is not
        // mistaken for the blank line terminating its frame.
        this.line = '!';
        this.lines = [];
      } else if (!this.discard) this.line += char;
      else this.line = '!';
    }
  }
  flush() {
    if (!this.discard && this.lines.length) {
      const frame = { event: 'message', id: '', data: '' };
      const data = [];
      for (const line of this.lines) {
        const at = line.indexOf(':');
        const key = at < 0 ? line : line.slice(0, at);
        const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
        if (key === 'data') data.push(value);
        if (key === 'event') frame.event = value;
        if (key === 'id' && !value.includes('\0')) frame.id = value;
      }
      if (data.length) { frame.data = data.join('\n'); this.onFrame(frame); }
    }
    this.line = ''; this.lines = []; this.size = 0; this.discard = false;
  }
  end() {
    this.consume(this.decoder.decode());
    if (!this.discard && (this.line || this.lines.length)) this.dropped++;
    this.flushDiscarded();
  }
  flushDiscarded() { this.line = ''; this.lines = []; this.size = 0; this.discard = false; }
}

function block(value) {
  const source = object(value), content = object(source.content);
  const complex = object(content.complex_task_block);
  const related = object(complex.fetch_related_agents);
  return compact({
    blockId: id(source.block_id), parentId: id(source.parent_id),
    blockType: Number.isSafeInteger(source.block_type) ? source.block_type : undefined,
    patchType: Number.isSafeInteger(source.patch_type) ? source.patch_type : undefined,
    finished: typeof source.is_finish === 'boolean' ? source.is_finish : undefined,
    contentKeys: Object.keys(content).slice(0, 32),
    text: text(object(content.text_block).text),
    threadId: id(complex.thread_id), relatedMessageId: id(related.message_id),
    relatedKey: id(related.unique_key),
  });
}

function content(value) {
  const source = object(value), ext = object(source.ext);
  return compact({
    blocks: Array.isArray(source.content_block) ? source.content_block.slice(0, 128).map(block) : undefined,
    // Internal enums and context occupancy must not become standard model/usage.
    modelEnum: id(ext.model_id ?? ext.llm_model_type),
    contextWindowOccupancy: text(ext.context_window_usage),
    clientFinishReason: text(ext.finish_reason_chat),
    clientFinishTimeMs: id(ext.finish_time_ms),
  });
}

function message(value) {
  const source = object(value);
  return compact({ messageId: id(source.message_id), conversationId: id(source.conversation_id),
    replyTo: id(source.bot_reply_message_id), threadId: id(source.thread_id) });
}

export function projectFrame(frame) {
  let value;
  try { value = object(JSON.parse(frame.data)); } catch { return undefined; }
  const common = { event: frame.event, sequence: id(frame.id) };
  switch (frame.event) {
    case 'SSE_ACK': return compact({ ...common,
      conversationId: id(object(value.ack_client_meta).conversation_id),
      queries: Array.isArray(value.query_list) ? value.query_list.slice(0, 32).map(q => compact({
        questionId: id(object(q).question_id), localMessageId: id(object(q).local_message_id),
      })) : undefined });
    case 'STREAM_MSG_NOTIFY': return { ...common, ...message(value.meta), ...content(value.content) };
    case 'FULL_MSG_NOTIFY': return { ...common, ...message(value.message) };
    case 'STREAM_CHUNK': return compact({ ...common, messageId: id(value.message_id),
      patches: Array.isArray(value.patch_op) ? value.patch_op.slice(0, 128).map(p => compact({
        object: Number.isSafeInteger(object(p).patch_object) ? p.patch_object : undefined,
        type: Number.isSafeInteger(object(p).patch_type) ? p.patch_type : undefined,
        ...content(object(p).patch_value),
      })) : undefined });
    case 'CHUNK_DELTA': return compact({ ...common, text: text(value.text) });
    case 'FETCH_STREAM': return compact({ ...common, taskId: id(value.fetch_key), messageId: id(value.msg_id),
      fetchType: Number.isSafeInteger(value.fetch_type) ? value.fetch_type : undefined,
      appendScene: Number.isSafeInteger(value.append_scene) ? value.append_scene : undefined });
    case 'SSE_REPLY_END': return compact({ ...common,
      endType: Number.isSafeInteger(value.end_type) ? value.end_type : undefined,
      messageId: id(object(value.msg_finish_attr).msgid) });
    default: return { ...common, unprojected: true }; // No arbitrary server payload or metadata.
  }
}

export function scopedRequest(body, nonce, tasks = new Set(), explicitTasks = new Set()) {
  let source;
  try { source = object(JSON.parse(body)); } catch { return undefined; }
  if (tasks.has(source.task_id)) return { taskId: id(source.task_id), basis: 'observed_fetch_stream' };
  if (explicitTasks.has(source.task_id)) return { taskId: id(source.task_id), basis: 'explicit_task_scope' };
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const visibleText = raw => {
    const m = object(raw);
    return Array.isArray(m.content_block)
      ? m.content_block.slice(0, 128).map(b => object(object(b).content).text_block?.text).filter(v => typeof v === 'string').join('\n')
      : typeof m.content === 'string' ? m.content : '';
  };
  const own = messages.filter(m => visibleText(m).includes(nonce));
  if (!own.length || own.length > 32) return undefined;
  return compact({ basis: 'explicit_test_nonce', conversationId: id(object(source.client_meta).conversation_id),
    messages: own.map(m => compact({ localMessageId: id(m.local_message_id), content: text(visibleText(m)) })) });
}
