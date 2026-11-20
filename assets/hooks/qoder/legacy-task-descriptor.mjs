// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

const OWNERSHIP_FIELDS = new Set(['sessionId', 'taskId', 'agentId', 'parentToolUseId', 'transcriptPath']);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SIMPLE_ESCAPES = Buffer.from('"\\/bfnrt');
const hexDigit = byte => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);

/** Preserve the descriptor JSON while replacing the native top-level result string with "". */
export class LegacyTaskDescriptor {
  constructor(capacity) {
    this.metadata = Buffer.allocUnsafe(capacity);
    this.length = 0;
    this.depth = 0;
    this.previous = undefined;
    this.string = false;
    this.escaped = false;
    this.result = false;
    this.escapeDigits = 0;
    this.keyStart = -1;
    this.key = undefined;
    this.ownershipFields = new Set();
  }

  write(chunk) {
    for (const byte of chunk) {
      if (this.result && !this.endResultString(byte)) continue;
      if (this.length === this.metadata.length) throw new Error('legacy-descriptor-metadata-limit');
      this.metadata[this.length++] = byte;
      if (this.string) {
        if (this.escaped) this.escaped = false;
        else if (byte === BACKSLASH) this.escaped = true;
        else if (byte === QUOTE) this.closeString();
      } else if (byte === QUOTE) {
        this.string = true;
        if (this.depth === 1 && (this.previous === 0x7b || this.previous === 0x2c)) this.keyStart = this.length - 1;
        this.result = this.depth === 1 && this.previous === 0x3a && this.key === 'result';
      } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        if (byte === 0x7b || byte === 0x5b) this.depth++;
        if (byte === 0x7d || byte === 0x5d) this.depth--;
        this.previous = byte;
      }
    }
  }

  endResultString(byte) {
    // The retained JSON parser cannot validate bytes that were elided.
    // Validate JSON string escapes and control bytes here across read blocks.
    if (this.escapeDigits > 0) {
      if (!hexDigit(byte)) throw new Error('invalid-legacy-descriptor-result');
      this.escapeDigits--;
    } else if (this.escaped) {
      if (byte === 0x75) this.escapeDigits = 4;
      else if (!SIMPLE_ESCAPES.includes(byte)) throw new Error('invalid-legacy-descriptor-result');
      this.escaped = false;
    } else if (byte === BACKSLASH) {
      this.escaped = true;
    } else if (byte < 0x20) {
      throw new Error('invalid-legacy-descriptor-result');
    } else if (byte === QUOTE) {
      this.result = false;
      return true;
    }
    return false;
  }

  closeString() {
    if (this.keyStart >= 0) {
      this.key = JSON.parse(this.metadata.toString('utf8', this.keyStart, this.length));
      if (OWNERSHIP_FIELDS.has(this.key)) {
        if (this.ownershipFields.has(this.key)) throw new Error('duplicate-legacy-descriptor-ownership');
        this.ownershipFields.add(this.key);
      }
      this.keyStart = -1;
    }
    this.string = false;
    this.previous = QUOTE;
  }

  finish() {
    const descriptor = JSON.parse(this.metadata.toString('utf8', 0, this.length));
    return Object.fromEntries([...OWNERSHIP_FIELDS].map(key => [key, descriptor?.[key]]));
  }
}
