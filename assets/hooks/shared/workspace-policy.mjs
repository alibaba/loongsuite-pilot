// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
/** Only explicit workspace metadata is accepted, never tool arguments or text. */
function strings(value) {
  if (Array.isArray(value))
    return value.filter((v) => typeof v === 'string');
  if (typeof value !== 'string' || !value)
    return [];
  if (value.startsWith('[')) {
    try {
      return strings(JSON.parse(value));
    }
    catch {
      return [];
    }
  }
  return [value];
}
export function validateExcludedWorkspaces(value) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !path.isAbsolute(v))) {
    throw new Error('privacy.excludeWorkspaces must be an array of absolute local directories');
  }
  return [...new Set(value)];
}
function absolutePath(value) {
  const expanded = value.startsWith('~/') ? `${os.homedir()}${path.sep}${value.slice(2)}` : value;
  return path.isAbsolute(expanded) ? expanded : undefined;
}
function normalize(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
// Resolve existing ancestors too: a workspace may have been removed since the event.
function real(value) {
  const suffix = [];
  let ancestor = value;
  for (;;) {
    try {
      ancestor = fs.realpathSync.native(ancestor);
      break;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        break;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return normalize(suffix.length ? path.join(ancestor, suffix.reverse().join(path.sep)) : ancestor);
}
function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
/** Shared by inputs and output dispatch. Unknown workspaces intentionally fail open. */
export class WorkspacePolicy {
  stateDirectory;
  roots;
  blocked = new Set();
  fingerprint;
  pendingMarkers = new Set();
  nextRetryAt = 0;
  nextWarningAt = 0;
  constructor(excluded = [], stateDirectory) {
    this.stateDirectory = stateDirectory;
    this.roots = validateExcludedWorkspaces(excluded).map(original => ({ original, lexical: normalize(original) }));
    this.fingerprint = this.hash(JSON.stringify(this.roots.map(root => root.lexical).sort()));
  }
  get enabled() { return this.roots.length > 0; }
  hash(value) { return createHash('sha256').update(value).digest('hex'); }
  excludes(directory) {
    if (!this.roots.length)
      return false;
    const original = absolutePath(directory);
    if (!original)
      return false;
    const lexical = normalize(original);
    if (this.roots.some(root => within(lexical, root.lexical)))
      return true;
    // The filesystem follows symlinks before processing later parent segments.
    const physical = real(original);
    return this.roots.some(root => within(physical, real(root.original)));
  }
  persistMarker(marker) {
    try {
      // One immutable marker per session; independent writers never overwrite
      // other sessions' decisions. The marker contains no user content.
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '', { mode: 0o600 });
      this.pendingMarkers.delete(marker);
    } catch {
      this.pendingMarkers.add(marker);
      const now = Date.now();
      this.nextRetryAt = now + 5000;
      if (now >= this.nextWarningAt) {
        this.nextWarningAt = now + 60000;
        try {
          process.stderr.write('[workspace-privacy] Cannot persist session exclusions; blocked in this process, restart/other-process protection may be unavailable. Retrying on subsequent events.\n');
        } catch { /* Diagnostics must not discard an otherwise valid batch. */ }
      }
    }
  }
  retryPendingMarkers() {
    if (!this.pendingMarkers.size || Date.now() < this.nextRetryAt) return;
    this.nextRetryAt = Date.now() + 5000;
    // Bounded work without a background timer that would keep hook processes alive.
    const batch = [];
    for (const marker of this.pendingMarkers) {
      batch.push(marker);
      if (batch.length === 8) break;
    }
    for (const marker of batch) {
      this.pendingMarkers.delete(marker);
      this.persistMarker(marker);
    }
  }
  allows(record, fallbackAgent = '') {
    if (!this.roots.length)
      return true;
    this.retryPendingMarkers();
    const agent = String(record['gen_ai.agent.type'] ?? fallbackAgent);
    const session = record['gen_ai.session.id'] ?? record.session_id ?? record.sessionId ?? record.conversation_id;
    const key = typeof session === 'string' && session ? this.hash(`${agent}\0${session}`) : undefined;
    const marker = key && this.stateDirectory ? path.join(this.stateDirectory, this.fingerprint, key) : undefined;
    if (key && (this.blocked.has(key) || (marker && fs.existsSync(marker))))
      return false;
    const directories = [
      ...strings(record['workspace.path']), ...strings(record.cwd), ...strings(record.workspace_roots),
    ];
    for (const [name, value] of Object.entries(record)) {
      if (/^agent\.[^.]+\.(cwd|workspace_roots)$/.test(name))
        directories.push(...strings(value));
    }
    if (!directories.some(directory => this.excludes(directory)))
      return true;
    if (key) {
      this.blocked.add(key);
      if (marker) this.persistMarker(marker);
    }
    return false;
  }
  filter(records, agent = '') {
    if (!this.roots.length) return records;
    // Preflight the whole batch so a trailing metadata-bearing event can suppress
    // earlier events of the same session before any side effects occur.
    for (const record of records)
      this.allows(record, agent);
    return records.filter(record => this.allows(record, agent));
  }
}
