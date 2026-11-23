/**
 * Minimal zero-dependency Protobuf wire decoder for Antigravity SQLite blobs.
 * Bounds-checked with a 10-byte varint cap so corrupted blobs fail cleanly.
 */

export type ProtoFieldValue =
  | { wire: 0; value: bigint }
  | { wire: 1; value: Uint8Array }
  | { wire: 2; value: Uint8Array }
  | { wire: 5; value: Uint8Array };

export interface ProtoField {
  number: number;
  wire: 0 | 1 | 2 | 5;
  value: bigint | Uint8Array;
}

const MAX_VARINT_BYTES = 10;
const MIN_VALID_TIMESTAMP_SEC = 1_577_836_800n; // 2020-01-01T00:00:00Z
const MAX_VALID_TIMESTAMP_SEC = 1n << 34n;      // year ~2514
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= buf.length) {
      throw new Error('truncated protobuf varint');
    }
    const byte = buf[pos++]!;
    const payload = BigInt(byte & 0x7f);
    if (shift === 63n && payload > 1n) {
      throw new Error('protobuf varint overflow');
    }
    value |= payload << shift;
    if ((byte & 0x80) === 0) {
      return [value, pos];
    }
    if (shift === 63n) {
      throw new Error('protobuf varint overflow');
    }
    shift += 7n;
  }
  throw new Error('protobuf varint overflow');
}

export function decodeProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const fieldNumberBig = tag >> 3n;
    if (fieldNumberBig <= 0n || fieldNumberBig > 0x1fffffffn) {
      throw new Error('invalid protobuf field number');
    }
    const number = Number(fieldNumberBig);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [val, next] = readVarint(buf, pos);
      pos = next;
      fields.push({ number, wire: 0, value: val });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('truncated protobuf fixed64');
      fields.push({ number, wire: 1, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const [lenBig, afterLen] = readVarint(buf, pos);
      pos = afterLen;
      const len = Number(lenBig);
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
        throw new Error('truncated protobuf length-delimited field');
      }
      fields.push({ number, wire: 2, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('truncated protobuf fixed32');
      fields.push({ number, wire: 5, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

export function fieldVarint(fields: readonly ProtoField[], number: number): number | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.number === number && f.wire === 0) {
      const big = f.value as bigint;
      if (big <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(big);
      }
    }
  }
  return undefined;
}

export function fieldVarintBig(fields: readonly ProtoField[], number: number): bigint | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.number === number && f.wire === 0) {
      return f.value as bigint;
    }
  }
  return undefined;
}

export function fieldBytes(fields: readonly ProtoField[], number: number): Uint8Array | undefined {
  for (const f of fields) {
    if (f.number === number && f.wire === 2) {
      return f.value as Uint8Array;
    }
  }
  return undefined;
}

export function fieldBytesAll(fields: readonly ProtoField[], number: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of fields) {
    if (f.number === number && f.wire === 2) {
      out.push(f.value as Uint8Array);
    }
  }
  return out;
}

export function fieldText(fields: readonly ProtoField[], number: number): string | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.number === number && f.wire === 2) {
      try {
        const decoded = textDecoder.decode(f.value as Uint8Array).trim();
        if (decoded.length > 0) return decoded;
      } catch {
        // Not valid UTF-8
      }
    }
  }
  return undefined;
}

export function decodePackedVarints(buf: Uint8Array): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [val, next] = readVarint(buf, pos);
    pos = next;
    if (val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      out.push(Number(val));
    }
  }
  return out;
}

/** Decode google.protobuf.Timestamp { 1: seconds, 2: nanos } into Unix ms. */
export function parseTimestampMs(buf: Uint8Array): number | undefined {
  const fields = decodeProtoFields(buf);
  const seconds = fieldVarintBig(fields, 1);
  if (seconds === undefined || seconds < MIN_VALID_TIMESTAMP_SEC || seconds > MAX_VALID_TIMESTAMP_SEC) {
    return undefined;
  }
  const nanosBig = fieldVarintBig(fields, 2) ?? 0n;
  const clampedNanos = nanosBig > 999_999_999n ? 999_999_999n : nanosBig;
  return Number(seconds * 1000n + clampedNanos / 1_000_000n);
}

/** Decode google.protobuf.Duration { 1: seconds, 2: nanos } into nanoseconds. */
export function parseDurationNs(buf: Uint8Array): number | undefined {
  const fields = decodeProtoFields(buf);
  const seconds = fieldVarintBig(fields, 1) ?? 0n;
  const nanos = fieldVarintBig(fields, 2) ?? 0n;
  if (seconds < 0n || nanos < 0n || nanos >= 1_000_000_000n || seconds > 86_400n) {
    return undefined;
  }
  const totalNs = seconds * 1_000_000_000n + nanos;
  if (totalNs <= 0n || totalNs > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(totalNs);
}
