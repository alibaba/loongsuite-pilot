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

/** Attach metadata for uri parts present on the entry (lookup by uri). */
export function attachMultimodalMetadataForEntry(
  entry: AgentActivityEntry,
  byUri: { readonly size: number; get(key: string): MultimodalMetadataItem | undefined },
): void {
  if (byUri.size === 0) return;
  const items: MultimodalMetadataItem[] = [];
  const seen = new Set<string>();
  for (const uri of collectUriStringsFromEntry(entry)) {
    if (seen.has(uri)) continue;
    const item = byUri.get(uri);
    if (!item) continue;
    seen.add(uri);
    items.push(item);
  }
  attachMultimodalMetadata(entry, items);
}

function collectUriStringsFromEntry(entry: AgentActivityEntry): string[] {
  const uris: string[] = [];
  for (const field of MESSAGE_FIELDS) {
    const value = entry[field];
    if (Array.isArray(value)) uris.push(...collectUriStringsFromMessages(value));
  }
  if (entry[TOOL_RESULT_FIELD] !== undefined) {
    uris.push(...collectUriStringsFromValue(entry[TOOL_RESULT_FIELD]));
  }
  return uris;
}

function collectUriStringsFromMessages(messages: unknown[]): string[] {
  const uris: string[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.parts)) continue;
    for (const part of record.parts) {
      if (isUriPart(part)) {
        uris.push(part.uri);
        continue;
      }
      const partRecord = asRecord(part);
      if (partRecord?.type === 'tool_call_response') {
        uris.push(...collectUriStringsFromValue(partRecord.response));
      }
    }
  }
  return uris;
}

function collectUriStringsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(isUriPart).map(part => part.uri);
  }
  if (isUriPart(value)) return [value.uri];
  return [];
}
