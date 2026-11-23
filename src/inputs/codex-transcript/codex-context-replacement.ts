import type { JsonValue } from '../../types/index.js';
import type { CodexContextReplacement } from './codex-transcript-types.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** Decode the installed native snapshot. Encrypted provider bytes never enter telemetry. */
export function codexContextReplacement(
  payload: Record<string, unknown>,
  fallbackVersion: string,
  mapMessage: (role: string, content: unknown) => JsonValue | null,
): CodexContextReplacement {
  const history = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
  const metadata = Array.isArray(payload.replacement_history_metadata) ? payload.replacement_history_metadata : [];
  const messages: JsonValue[] = [];
  const retainedMessageIds: string[] = [];
  let opaque = false;
  let partial = false;
  let sampledThroughSequence: number | undefined;
  for (const [index, value] of history.entries()) {
    const item = object(value);
    const info = object(metadata[index]);
    const retainedId = object(object(info?.retained_source)?.id)?.message_id;
    if (typeof retainedId === 'string' && retainedMessageIds.length < 256) retainedMessageIds.push(retainedId);
    const sampled = info?.sampled_through_sequence;
    if (typeof sampled === 'number' && Number.isSafeInteger(sampled) && sampled >= 0) {
      sampledThroughSequence = Math.max(sampledThroughSequence ?? 0, sampled);
    }
    if (!item) { partial = true; continue; }
    if (item.type === 'compaction') {
      const part: Record<string, JsonValue> = { type: 'compaction' };
      if (typeof item.id === 'string') part.id = item.id;
      if (typeof item.content === 'string') part.content = item.content;
      else opaque = true;
      messages.push({ role: 'user', parts: [part] });
      continue;
    }
    if (item.type === 'message' && typeof item.role === 'string') {
      if (Array.isArray(item.content) && item.content.some(value => {
        const type = object(value)?.type;
        return type !== 'input_text' && type !== 'output_text' && type !== 'text';
      })) partial = true;
      const message = object(mapMessage(item.role, item.content));
      if (!message) { partial = true; continue; }
      if (typeof item.id === 'string') message.id = item.id;
      // The native metadata marks the installed checkpoint message. Its role
      // and content stay in the exact replacement order.
      if (info?.compaction_without_file_error_sources === true) {
        const parts = message.parts as { type: string; content?: string }[];
        const text = parts.filter(part => part.type === 'text').map(part => part.content ?? '').join('\n');
        message.parts = [{ type: 'compaction',
          ...(typeof payload.compaction_response_id === 'string' ? { id: payload.compaction_response_id } : {}),
          content: text }];
      }
      messages.push(message as JsonValue);
      continue;
    }
    if (item.type === 'function_call' && typeof item.call_id === 'string') {
      let args: JsonValue = typeof item.arguments === 'string' ? item.arguments : null;
      try { if (typeof item.arguments === 'string') args = JSON.parse(item.arguments); } catch { /* Preserve native text. */ }
      messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: item.call_id,
        ...(typeof item.name === 'string' ? { name: item.name } : {}), arguments: args }] });
      continue;
    }
    if (item.type === 'function_call_output' && typeof item.call_id === 'string' && typeof item.output === 'string') {
      messages.push({ role: 'tool', parts: [{ type: 'tool_call_response', id: item.call_id, response: item.output }] });
      continue;
    }
    // Reasoning and multimodal items require their own representation. Mark the
    // snapshot partial instead of claiming a complete provider request.
    partial = true;
  }
  const withinBudget = Buffer.byteLength(JSON.stringify(messages), 'utf8') <= MAX_SNAPSHOT_BYTES;
  return {
    version: typeof payload.window_id === 'string' ? payload.window_id : fallbackVersion,
    ...(typeof payload.previous_window_id === 'string' ? { previousVersion: payload.previous_window_id } : {}),
    ...(messages.length && withinBudget ? { messages } : {}),
    contentAvailability: !messages.length || !withinBudget ? 'unavailable' : partial ? 'partial' : opaque ? 'opaque' : 'plaintext',
    retainedMessageIds,
    ...(sampledThroughSequence !== undefined ? { sampledThroughSequence } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
