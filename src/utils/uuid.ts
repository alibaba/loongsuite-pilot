import { createHash, randomUUID } from 'node:crypto';

export function uuidV4(): string {
  return randomUUID();
}

function namespaceBytes(namespace: string): Buffer {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`uuid v5 namespace is not a UUID: ${namespace}`);
  }
  return Buffer.from(hex, 'hex');
}

/** RFC 4122 UUID version 5 (SHA-1 of namespace bytes + name). */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1').update(namespaceBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
