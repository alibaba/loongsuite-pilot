import { describe, expect, it } from 'vitest';
import { uuidV5 } from '../../../src/utils/uuid.js';

describe('uuidV5', () => {
  it('matches the RFC 4122 DNS example', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
      .toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});
