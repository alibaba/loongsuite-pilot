// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireRawSourceGate } from './raw-source-gate.mjs';
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export const RAW_SEGMENT_BYTES = 100 * 1024 * 1024;

/**
 * Never rename a source inode: checkpoints belong to stable filenames.
 * The atomic pointer selects the only writable segment; previous segments
 * remain readable until the collector has durably consumed them.
 */
export function appendRawJsonl(file, text, maxBytes = RAW_SEGMENT_BYTES, options = {}) {
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const pointer = file + '.active';
  const deadline = performance.now() + 15_000;
  let gate;
  while (!(gate = acquireRawSourceGate(path.dirname(file)))) {
    if (performance.now() >= deadline) throw new Error('Raw JSONL writer lock unavailable');
    Atomics.wait(LOCK_WAIT, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())));
  }
  try {
    let target = file;
    try {
      const name = fs.readFileSync(pointer, 'utf8');
      const prefix = path.basename(file, '.jsonl') + '.segment-';
      if (!name.startsWith(prefix) || !/\.segment-\d{12}-[a-f0-9]{32}\.jsonl$/.test(name)
        || path.basename(name) !== name) throw new Error('Invalid raw JSONL pointer');
      target = path.join(path.dirname(file), name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let size = 0;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid raw JSONL file');
      size = stat.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes && options.allowRotate !== false) {
      const previous = /\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$/.exec(target);
      const sequence = String(Number(previous?.[1] ?? 0) + 1).padStart(12, '0');
      target = file.slice(0, -6) + '.segment-' + sequence + '-' + crypto.randomUUID().replace(/-/g, '') + '.jsonl';
      // Publish an empty segment before its pointer. A crash here leaves a
      // harmless empty orphan, never an overwritten or renamed source.
      fs.closeSync(fs.openSync(target, 'wx', 0o600));
      // Stateful session inputs may need a request header in every new segment.
      if (options.prefix) fs.appendFileSync(target, options.prefix, 'utf8');
      const temp = pointer + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temp, path.basename(target), { mode: 0o600 });
        fs.renameSync(temp, pointer);
      } finally { try { fs.unlinkSync(temp); } catch {} }
    }
    const fd = fs.openSync(target, 'a', 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, text, 'utf8');
    } finally { fs.closeSync(fd); }
    // Only opt-in diagnostics may discard unconsumed content. Raw source
    // callers never set this option; their collector owns reclamation.
    if (options.diagnosticMaxBytes) {
      const stem = path.basename(file, '.jsonl');
      const files = fs.readdirSync(path.dirname(file)).filter(name =>
        name === path.basename(file) || (name.startsWith(stem + '.segment-')
          && /\.segment-\d{12}-[a-f0-9]{32}\.jsonl$/.test(name)));
      const candidates = files.sort().map(name => {
        const full = path.join(path.dirname(file), name);
        return { full, stat: fs.lstatSync(full) };
      }).filter(item => item.stat.isFile());
      let total = candidates.reduce((sum, item) => sum + item.stat.size, 0);
      for (const item of candidates) {
        if (total <= options.diagnosticMaxBytes) break;
        if (item.full === target) continue;
        fs.unlinkSync(item.full);
        total -= item.stat.size;
      }
    }
    return target;
  } finally { gate.release(); }
}
