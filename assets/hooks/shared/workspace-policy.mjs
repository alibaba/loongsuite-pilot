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
function normalize(value) {
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded))
    return undefined;
  const normalized = path.normalize(expanded);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
// Resolve existing ancestors too: a workspace may have been removed since the event.
function real(value) {
  try {
    return normalize(fs.realpathSync.native(value)) ?? value;
  }
  catch {
    const parent = path.dirname(value);
    return parent === value ? value : path.join(real(parent), path.basename(value));
  }
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
  constructor(excluded = [], stateDirectory) {
    this.stateDirectory = stateDirectory;
    this.roots = validateExcludedWorkspaces(excluded).map(v => normalize(v));
    this.fingerprint = this.hash(JSON.stringify([...this.roots].sort()));
  }
  get enabled() { return this.roots.length > 0; }
  hash(value) { return createHash('sha256').update(value).digest('hex'); }
  excludes(directory) {
    const candidate = normalize(directory);
    if (!candidate)
      return false;
    return this.roots.some(root => within(candidate, root) || within(real(candidate), real(root)));
  }
  allows(record, fallbackAgent = '') {
    if (!this.roots.length)
      return true;
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
      if (marker) {
        // One immutable marker per session: independent hook processes cannot
        // overwrite one another's decisions. Contains no directory or session text.
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, '', { mode: 0o600 });
      }
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
