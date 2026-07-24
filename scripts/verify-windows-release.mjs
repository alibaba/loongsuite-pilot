#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const zipPath = path.resolve(process.argv[2] || 'loongsuite-pilot.zip');
const buffer = fs.readFileSync(zipPath);

if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
  throw new Error(`not a ZIP archive (missing PK local header): ${zipPath}`);
}

function findEndOfCentralDirectory() {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error(`invalid ZIP (end of central directory not found): ${zipPath}`);
}

function readEntries() {
  const eocd = findEndOfCentralDirectory();
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid ZIP central directory entry ${index}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`required ZIP entry missing: ${name}`);
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`invalid local ZIP header: ${name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  const content = entry.method === 0
    ? compressed
    : entry.method === 8
      ? zlib.inflateRawSync(compressed)
      : (() => { throw new Error(`unsupported ZIP compression method ${entry.method}: ${name}`); })();
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry size mismatch: ${name}`);
  }
  return content;
}

const entries = readEntries();
const root = 'loongsuite-pilot/';
const required = [
  `${root}VERSION`,
  `${root}scripts/loongsuite-pilot.ps1`,
  `${root}scripts/monitor-loongsuite-pilot.ps1`,
  `${root}assets/hooks/codex-loongsuite-pilot-hook.ps1`,
  `${root}assets/hooks/codex-hook-processor.mjs`,
  `${root}agents.d/codex.json`,
];
for (const name of required) {
  if (!entries.has(name)) throw new Error(`required ZIP entry missing: ${name}`);
}

const version = readEntry(entries, `${root}VERSION`).toString('utf8');
for (const field of ['version', 'git_commit', 'build_time']) {
  if (!new RegExp(`^${field}=\\S+`, 'm').test(version)) {
    throw new Error(`VERSION is missing ${field}`);
  }
}

console.log(JSON.stringify({
  zip: zipPath,
  entries: entries.size,
  requiredEntries: required.length,
  version: Object.fromEntries(
    version.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)),
  ),
}, null, 2));
