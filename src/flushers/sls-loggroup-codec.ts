export interface SlsLogEntryPayload {
  timestamp: number;
  content: Record<string, string>;
  timestampNsPart?: number;
}

export interface SlsLogGroupPayload {
  logs: SlsLogEntryPayload[];
  topic?: string;
  source?: string;
  tags?: Array<Record<string, string>>;
}

export function encodeSlsLogGroup(payload: SlsLogGroupPayload): Buffer {
  const parts: Buffer[] = [];

  for (const log of payload.logs) {
    parts.push(fieldBytes(1, encodeLog(log)));
  }
  if (payload.topic) parts.push(fieldBytes(3, payload.topic));
  if (payload.source) parts.push(fieldBytes(4, payload.source));
  for (const tag of payload.tags ?? []) {
    for (const [key, value] of Object.entries(tag)) {
      parts.push(fieldBytes(6, encodeKeyValue(key, value)));
    }
  }

  return Buffer.concat(parts);
}

function encodeLog(log: SlsLogEntryPayload): Buffer {
  const parts: Buffer[] = [
    fieldVarint(1, log.timestamp >>> 0),
  ];

  for (const [key, value] of Object.entries(log.content)) {
    parts.push(fieldBytes(2, encodeKeyValue(key, value)));
  }
  if (log.timestampNsPart !== undefined) {
    parts.push(fieldFixed32(4, log.timestampNsPart >>> 0));
  }

  return Buffer.concat(parts);
}

function encodeKeyValue(key: string, value: string): Buffer {
  return Buffer.concat([
    fieldBytes(1, key),
    fieldBytes(2, value),
  ]);
}

function fieldVarint(fieldNo: number, value: number | bigint): Buffer {
  return Buffer.concat([varint((fieldNo << 3) | 0), varint(value)]);
}

function fieldFixed32(fieldNo: number, value: number): Buffer {
  const out = Buffer.allocUnsafe(5);
  out[0] = (fieldNo << 3) | 5;
  out.writeUInt32LE(value >>> 0, 1);
  return out;
}

function fieldBytes(fieldNo: number, value: string | Buffer): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(body.length), body]);
}

function varint(value: number | bigint): Buffer {
  const out: number[] = [];
  let n = BigInt(value);
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}
