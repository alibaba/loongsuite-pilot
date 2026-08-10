import type { AgentActivityEntry, JsonValue } from '../types/index.js';
import type { MultimodalMetadataItem, UriPart } from './types.js';
import { MULTIMODAL_METADATA_FIELD } from './types.js';

const MESSAGE_FIELDS = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
] as const;

const TOOL_RESULT_FIELD = 'gen_ai.tool.call.result';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isUriPart(value: unknown): value is UriPart {
  const record = asRecord(value);
  return !!record
    && record.type === 'uri'
    && typeof record.uri === 'string';
}

export function attachMultimodalMetadata(
  entry: AgentActivityEntry,
  items: MultimodalMetadataItem[],
): void {
  if (items.length === 0) {
    delete entry[MULTIMODAL_METADATA_FIELD];
    return;
  }
  entry[MULTIMODAL_METADATA_FIELD] = items as unknown as JsonValue;
}

/**
 * Attach multimodal_metadata from uri parts already on the entry.
 * Dedupes by uri (first wins). No side cache — mime/modality live on the part.
 */
export function attachMultimodalMetadataForEntry(entry: AgentActivityEntry): void {
  const items: MultimodalMetadataItem[] = [];
  const seen = new Set<string>();
  for (const part of collectUriPartsFromEntry(entry)) {
    if (seen.has(part.uri)) continue;
    seen.add(part.uri);
    items.push({
      uri: part.uri,
      mime_type: part.mime_type || 'application/octet-stream',
      ...(part.modality ? { modality: part.modality } : {}),
    });
  }
  attachMultimodalMetadata(entry, items);
}

function collectUriPartsFromEntry(entry: AgentActivityEntry): UriPart[] {
  const parts: UriPart[] = [];
  for (const field of MESSAGE_FIELDS) {
    const value = entry[field];
    if (Array.isArray(value)) parts.push(...collectUriPartsFromMessages(value));
  }
  if (entry[TOOL_RESULT_FIELD] !== undefined) {
    parts.push(...collectUriPartsFromValue(entry[TOOL_RESULT_FIELD]));
  }
  return parts;
}

function collectUriPartsFromMessages(messages: unknown[]): UriPart[] {
  const parts: UriPart[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.parts)) continue;
    for (const part of record.parts) {
      if (isUriPart(part)) {
        parts.push(part);
        continue;
      }
      const partRecord = asRecord(part);
      if (partRecord?.type === 'tool_call_response') {
        parts.push(...collectUriPartsFromValue(partRecord.response));
      }
    }
  }
  return parts;
}

function collectUriPartsFromValue(value: unknown): UriPart[] {
  if (Array.isArray(value)) {
    return value.filter(isUriPart);
  }
  if (isUriPart(value)) return [value];
  return [];
}
