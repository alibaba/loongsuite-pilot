import { serialize } from 'node:v8';
import { DOUBAO_EPOCH } from './doubao-work-fixture.js';
import { chatCrc32c, readVarint } from '../../src/inputs/doubao-work/doubao-chat-table.js';

export function chatBatch(options: { sequence?: number; session?: string; finished?: boolean; output?: string;
  input?: string; reused?: boolean; conversation?: string; localMessage?: string; queryMs?: number;
  emptyStore?: boolean; deleteStore?: boolean } = {}): Buffer {
  const session = options.session ?? 'synthetic-chat-turn';
  const conversation = options.conversation ?? 'synthetic-conversation';
  const local = options.localMessage ?? 'synthetic-local-message';
  const text = (value: string, finished = true) => [{ block_type: 10000, is_finish: finished, content: { text_block: { text: value } } }];
  const task = {
    sessionId: session,
    requestQuery: { syncTask: { option: { unique_key: session, ...(options.reused ? {} : { conversation_mode: 1 }), agent_mode: 2,
      create_time_ms: options.queryMs ?? DOUBAO_EPOCH + 10 } } },
    sentMessages: { 'synthetic-query': { sessionId: session, uniqueId: local, extra: {
      user_type: 1, message_id: 'synthetic-query', conversation_id: conversation, content_blocks_v2: text(options.input ?? 'SYNTHETIC_CHAT_INPUT'),
    } } },
    receivedMessages: { 'synthetic-answer': { sessionId: session, extra: {
      user_type: 2, message_id: 'synthetic-answer', reply_id: 'synthetic-query', conversation_id: conversation,
      content_blocks_v2: text(options.output ?? 'SYNTHETIC_CHAT_OUTPUT', options.finished ?? true),
      ext: { is_finish: options.finished === false ? '0' : '1', model_id: '38', finish_time_ms: String(DOUBAO_EPOCH + 2000) },
    } } },
  };
  const keyText = Buffer.from('im-sdk:user:123456:default-chat-im-protocol-store', 'utf16le'); keyText.swap16();
  const key = Buffer.concat([Buffer.from([0, 2, 1, 1, 1]), encodeVarint(keyText.length / 2), keyText]);
  const value = Buffer.concat([Buffer.from([1]), Buffer.from('ff15fe000000000000000000000000', 'hex'),
    serialize({ state: { mainTaskDataMap: options.emptyStore ? {} : { [session]: task } }, version: 0 })]);
  const header = Buffer.alloc(12); header.writeBigUInt64LE(BigInt(options.sequence ?? 1)); header.writeUInt32LE(1, 8);
  if (options.deleteStore) return Buffer.concat([header, Buffer.from([0]), encodeVarint(key.length), key]);
  return Buffer.concat([header, Buffer.from([1]), encodeVarint(key.length), key, encodeVarint(value.length), value]);
}

export function chatTable(batch: Buffer, compressed = false): Buffer {
  const keyLength = readVarint(batch, 13);
  const key = batch.subarray(keyLength.end, keyLength.end + keyLength.value);
  let value = Buffer.alloc(0);
  if (batch[12] === 1) {
    const valueLength = readVarint(batch, keyLength.end + keyLength.value);
    value = batch.subarray(valueLength.end, valueLength.end + valueLength.value);
  }
  const tag = Buffer.alloc(8); tag.writeBigUInt64LE((batch.readBigUInt64LE(0) << 8n) | BigInt(batch[12]));
  const restart = Buffer.from('0000000001000000', 'hex');
  const entry = (k: Buffer, v: Buffer) => Buffer.concat([encodeVarint(0), encodeVarint(k.length), encodeVarint(v.length), k, v, restart]);
  const block = (data: Buffer, compress: boolean) => {
    let stored = data;
    if (compress) {
      const length = Buffer.alloc(4); length.writeUInt32LE(data.length - 1);
      stored = Buffer.concat([encodeVarint(data.length), Buffer.from([63 << 2]), length, data]);
    }
    const type = Buffer.from([compress ? 1 : 0]), crc = chatCrc32c(Buffer.concat([stored, type]));
    const checksum = Buffer.alloc(4); checksum.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
    return Buffer.concat([stored, type, checksum]);
  };
  const data = block(entry(Buffer.concat([key, tag]), value), compressed);
  const index = block(entry(Buffer.from('index'), Buffer.concat([encodeVarint(0), encodeVarint(data.length - 5)])), false);
  const footer = Buffer.alloc(48);
  Buffer.concat([encodeVarint(0), encodeVarint(0), encodeVarint(data.length), encodeVarint(index.length - 5)]).copy(footer);
  Buffer.from('57fb808b247547db', 'hex').copy(footer, 40);
  return Buffer.concat([data, index, footer]);
}

export function chatWal(records: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    let position = 0, first = true;
    while (position < record.length) {
      const remaining = 32768 - offset % 32768;
      if (remaining < 7) { chunks.push(Buffer.alloc(remaining)); offset += remaining; continue; }
      const length = Math.min(remaining - 7, record.length - position);
      const last = position + length === record.length;
      const type = first ? (last ? 1 : 2) : (last ? 4 : 3);
      const payload = record.subarray(position, position + length);
      const header = Buffer.alloc(7); header.writeUInt16LE(length, 4); header[6] = type;
      let crc = 0xffffffff;
      for (const byte of Buffer.concat([Buffer.from([type]), payload])) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      header.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
      chunks.push(header, payload); offset += 7 + length; position += length; first = false;
    }
  }
  return Buffer.concat(chunks);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
  bytes.push(value); return Buffer.from(bytes);
}
