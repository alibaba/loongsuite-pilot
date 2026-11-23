import { createHash } from 'node:crypto';

/**
 * Stable content hash used to correlate an upstream traceparent record with a
 * collected turn's user-input text. Defined as the first 16 hex chars of the
 * SHA-256 of the raw text. Adapters writing correlation records MUST use the
 * exact same algorithm so exact-match lookups line up across the two sides.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
