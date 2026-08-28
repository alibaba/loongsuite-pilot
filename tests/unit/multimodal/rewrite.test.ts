import { describe, expect, it } from 'vitest';
import {
  attachMultimodalMetadata,
  attachMultimodalMetadataForEntry,
  isUriPart,
} from '../../../src/multimodal/rewrite.js';
import { MULTIMODAL_METADATA_FIELD } from '../../../src/multimodal/types.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function baseEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '0',
    'event.id': 'e1',
    'user.id': 'u1',
    'event.name': 'other',
    'gen_ai.session.id': 's1',
    'gen_ai.agent.type': 'codex',
    'gen_ai.provider.name': 'openai',
    ...overrides,
  };
}

describe('multimodal rewrite helpers', () => {
  it('isUriPart accepts only uri-shaped objects', () => {
    expect(isUriPart({ type: 'uri', uri: 'oss://b/k.png' })).toBe(true);
    expect(isUriPart({ type: 'blob', content: 'x' })).toBe(false);
    expect(isUriPart({ type: 'uri' })).toBe(false);
    expect(isUriPart(null)).toBe(false);
    expect(isUriPart('oss://b/k.png')).toBe(false);
  });

  it('attachMultimodalMetadata deletes field when items empty', () => {
    const entry = baseEntry({
      [MULTIMODAL_METADATA_FIELD]: [{ uri: 'oss://old' }] as never,
    });
    attachMultimodalMetadata(entry, []);
    expect(entry[MULTIMODAL_METADATA_FIELD]).toBeUndefined();
  });

  it('attachMultimodalMetadataForEntry skips when entry has no uri parts', () => {
    const entry = baseEntry({
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      ],
    });
    attachMultimodalMetadataForEntry(entry);
    expect(entry[MULTIMODAL_METADATA_FIELD]).toBeUndefined();
  });

  it('reads mime/modality from uri parts and dedupes by uri', () => {
    const uri = 'oss://bucket/mm/a.png';
    const entry = baseEntry({
      'gen_ai.input.messages': [
        {
          role: 'user',
          parts: [
            { type: 'uri', uri, mime_type: 'image/png', modality: 'image' },
            { type: 'uri', uri, mime_type: 'image/png', modality: 'image' },
            { type: 'uri', uri: 'oss://bucket/mm/b.png', mime_type: 'image/jpeg' },
            { type: 'text', content: 'hi' },
          ],
        },
      ],
    });

    attachMultimodalMetadataForEntry(entry);
    expect(entry[MULTIMODAL_METADATA_FIELD]).toEqual([
      { uri, mime_type: 'image/png', modality: 'image' },
      { uri: 'oss://bucket/mm/b.png', mime_type: 'image/jpeg' },
    ]);
  });

  it('collects uris from tool call results', () => {
    const uri = 'oss://bucket/mm/tool.png';
    const entry = baseEntry({
      'gen_ai.tool.call.result': [{ type: 'uri', uri, mime_type: 'image/png', modality: 'image' }],
    });
    attachMultimodalMetadataForEntry(entry);
    expect(entry[MULTIMODAL_METADATA_FIELD]).toEqual([
      { uri, mime_type: 'image/png', modality: 'image' },
    ]);
  });

  it('defaults mime_type when uri part omits it', () => {
    const entry = baseEntry({
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'uri', uri: 'oss://b/x.bin' }] },
      ],
    });
    attachMultimodalMetadataForEntry(entry);
    expect(entry[MULTIMODAL_METADATA_FIELD]).toEqual([
      { uri: 'oss://b/x.bin', mime_type: 'application/octet-stream' },
    ]);
  });
});
