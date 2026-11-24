const TABLE_MAGIC = Buffer.from('57fb808b247547db', 'hex');
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;

/** Decode immutable LevelDB tables without opening the client's database. */
export function* chatTableEntries(table: Buffer): Generator<{ key: Buffer; value: Buffer; sequence: bigint }> {
  if (table.length < 48 || !table.subarray(-8).equals(TABLE_MAGIC)) throw new Error('Invalid Doubao chat table footer');
  const footer = table.length - 48;
  const metaOffset = readVarint(table, footer);
  const metaSize = readVarint(table, metaOffset.end);
  const indexOffset = readVarint(table, metaSize.end);
  const indexSize = readVarint(table, indexOffset.end);
  const index = tableBlock(table, indexOffset.value, indexSize.value);
  for (const entry of blockEntries(index)) {
    const offset = readVarint(entry.value, 0), size = readVarint(entry.value, offset.end);
    const block = tableBlock(table, offset.value, size.value);
    for (const record of blockEntries(block)) {
      if (record.key.length < 8) throw new Error('Invalid Doubao chat table key');
      const tag = record.key.readBigUInt64LE(record.key.length - 8);
      const type = Number(tag & 255n);
      if (type !== 0 && type !== 1) throw new Error('Invalid Doubao chat table value type');
      yield { key: record.key.subarray(0, -8), value: type === 1 ? record.value : Buffer.alloc(0), sequence: tag >> 8n };
    }
  }
}

function tableBlock(table: Buffer, offset: number, size: number): Buffer {
  if (size > MAX_BLOCK_BYTES || offset + size + 5 > table.length - 48) throw new Error('Invalid Doubao chat table block');
  const stored = table.subarray(offset, offset + size), compression = table[offset + size];
  if (chatCrc32c(table.subarray(offset, offset + size + 1)) !== unmaskChatCrc(table.readUInt32LE(offset + size + 1))) {
    throw new Error('Doubao chat table checksum mismatch');
  }
  if (compression === 0) return stored;
  if (compression === 1) return unsnappy(stored);
  throw new Error('Unsupported Doubao chat table compression');
}

function* blockEntries(block: Buffer): Generator<{ key: Buffer; value: Buffer }> {
  if (block.length < 8) throw new Error('Invalid Doubao chat table restart index');
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  if (!restarts || end < 0) throw new Error('Invalid Doubao chat table restart count');
  let position = 0, previous = Buffer.alloc(0);
  while (position < end) {
    const shared = readVarint(block, position), suffix = readVarint(block, shared.end), value = readVarint(block, suffix.end);
    position = value.end;
    if (shared.value > previous.length || position + suffix.value + value.value > end) throw new Error('Invalid Doubao chat table entry');
    const key = Buffer.concat([previous.subarray(0, shared.value), block.subarray(position, position + suffix.value)]);
    position += suffix.value;
    yield { key, value: block.subarray(position, position + value.value) };
    position += value.value;
    previous = key;
  }
}

function unsnappy(input: Buffer): Buffer {
  const length = readVarint(input, 0);
  if (length.value > MAX_BLOCK_BYTES) throw new Error('Doubao chat table expansion capacity exceeded');
  const output = Buffer.allocUnsafe(length.value);
  let position = length.end, written = 0;
  while (position < input.length) {
    const tag = input[position++], type = tag & 3;
    let count: number, offset = 0;
    if (type === 0) {
      const code = tag >> 2;
      count = code + 1;
      if (code >= 60) {
        const bytes = code - 59;
        if (position + bytes > input.length) throw new Error('Truncated Doubao chat table literal');
        count = input.readUIntLE(position, bytes) + 1;
        position += bytes;
      }
      if (position + count > input.length || written + count > output.length) throw new Error('Invalid Doubao chat table literal');
      input.copy(output, written, position, position + count);
      position += count;
    } else {
      const bytes = type === 1 ? 1 : type === 2 ? 2 : 4;
      if (position + bytes > input.length) throw new Error('Truncated Doubao chat table copy');
      count = type === 1 ? 4 + ((tag >> 2) & 7) : 1 + (tag >> 2);
      offset = type === 1 ? ((tag & 224) << 3) | input[position] : input.readUIntLE(position, bytes);
      position += bytes;
      if (!offset || offset > written || written + count > output.length) throw new Error('Invalid Doubao chat table copy');
      for (let index = 0; index < count; index++) output[written + index] = output[written + index - offset];
    }
    written += count;
  }
  if (written !== output.length) throw new Error('Invalid Doubao chat table expansion length');
  return output;
}

export function readVarint(buffer: Buffer, start: number): { value: number; end: number } {
  let value = 0;
  for (let position = start, shift = 0; position < buffer.length && shift <= 49; position++, shift += 7) {
    const byte = buffer[position]; value += (byte & 127) * 2 ** shift;
    if (!Number.isSafeInteger(value)) break;
    if (byte < 128) return { value, end: position + 1 };
  }
  throw new Error('Invalid Doubao chat length');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});

export function chatCrc32c(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function unmaskChatCrc(value: number): number {
  const rotated = (value - 0xa282ead8) >>> 0;
  return ((rotated >>> 17) | (rotated << 15)) >>> 0;
}
