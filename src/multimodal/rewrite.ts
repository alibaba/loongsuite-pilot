import type { AgentActivityEntry, JsonValue } from '../types/index.js';
import type { MultimodalMetadataItem, UriPart } from './types.js';
import {
  INPUT_MULTIMODAL_METADATA_FIELD,
  OUTPUT_MULTIMODAL_METADATA_FIELD,
  TOOL_MULTIMODAL_METADATA_FIELD,
} from './types.js';

const INPUT_MESSAGE_FIELDS = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
] as const;

const OUTPUT_MESSAGE_FIELD = 'gen_ai.output.messages';
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
    delete entry[INPUT_MULTIMODAL_METADATA_FIELD];
    return;
  }
  entry[INPUT_MULTIMODAL_METADATA_FIELD] = items as unknown as JsonValue;
}

/** Summarize uri parts already on the entry into input, output, and tool metadata. */
export function attachMultimodalMetadataForEntry(entry: AgentActivityEntry): void {
  const inputParts: UriPart[] = [];
  for (const field of INPUT_MESSAGE_FIELDS) {
    const value = entry[field];
    if (Array.isArray(value)) inputParts.push(...collectUriPartsFromMessages(value));
  }
  writeMetadata(entry, INPUT_MULTIMODAL_METADATA_FIELD, metadataItems(inputParts));

  const output = entry[OUTPUT_MESSAGE_FIELD];
  writeMetadata(
    entry,
    OUTPUT_MULTIMODAL_METADATA_FIELD,
    metadataItems(Array.isArray(output) ? collectUriPartsFromMessages(output) : []),
  );

  writeMetadata(
    entry,
    TOOL_MULTIMODAL_METADATA_FIELD,
    metadataItems(
      entry[TOOL_RESULT_FIELD] !== undefined
        ? collectUriPartsFromValue(entry[TOOL_RESULT_FIELD])
        : [],
    ),
  );
}

function metadataItems(parts: UriPart[]): MultimodalMetadataItem[] {
  const items: MultimodalMetadataItem[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.uri)) continue;
    seen.add(part.uri);
    items.push({
      uri: part.uri,
      mime_type: part.mime_type || 'application/octet-stream',
      ...(part.modality ? { modality: part.modality } : {}),
    });
  }
  return items;
}

function writeMetadata(
  entry: AgentActivityEntry,
  field: typeof INPUT_MULTIMODAL_METADATA_FIELD
    | typeof OUTPUT_MULTIMODAL_METADATA_FIELD
    | typeof TOOL_MULTIMODAL_METADATA_FIELD,
  items: MultimodalMetadataItem[],
): void {
  if (items.length === 0) {
    delete entry[field];
    return;
  }
  entry[field] = items as unknown as JsonValue;
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
