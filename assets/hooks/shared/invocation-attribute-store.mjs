// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { parseInvocationAttributes } from './invocation-attributes.mjs';
const require = createRequire(import.meta.url);
const DAY = 86400000, MAX_BYTES = 64 * 1024 * 1024;
// A resolved decision must outlive even the longest registration (7 + 7 days).
const DECISION_RETENTION = 14 * DAY;
export class InvocationAttributeStoreError extends Error {
  constructor(code) { super(`request context: ${code}`); this.code = code; }
}
function text(v) {
  if (typeof v !== 'string' || !v.length || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v))
    throw new InvocationAttributeStoreError('invalid_identity');
  return v;
}
export function isUsableInvocationId(v) {
  return typeof v === 'string' && v.length <= 512 && v.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(v)
    && !/^(unknown|null|undefined)$/i.test(v.trim());
}
function selectorKey(s) {
  if (s?.kind === 'message' && isUsableInvocationId(s.messageId)) return JSON.stringify(['message', s.messageId]);
  if (s?.kind === 'turn' && isUsableInvocationId(s.sessionId) && isUsableInvocationId(s.turnId) && s.sessionId !== s.turnId)
    return JSON.stringify(['turn', s.sessionId, s.turnId]);
  throw new InvocationAttributeStoreError('invalid_selector');
}
function identity(i) {
  const scope = text(i.scope ?? 'default'), agent = text(i.agent);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) throw new InvocationAttributeStoreError('invalid_agent');
  return { scope, agent };
}
function canonical(attrs) { return JSON.stringify(Object.fromEntries(Object.keys(attrs).sort().map(k => [k, attrs[k]]))); }
export function invocationAttributeRoot(dataDir) {
  return process.env.LOONGSUITE_PILOT_ATTRIBUTION_ROOT
    || path.join(dataDir || process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot'), 'state', 'invocation-attributes');
}
/** Small local transactions; no collector imports or caller business schema. */
export class InvocationAttributeStore {
  constructor({ root, now = Date.now, maxBytes = MAX_BYTES, maxPending = 256 } = {}) {
    this.root = root || invocationAttributeRoot(); this.now = now; this.maxPending = maxPending;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 131072)
      throw new InvocationAttributeStoreError('invalid_capacity');
    if (!path.isAbsolute(this.root)) throw new InvocationAttributeStoreError('invalid_root');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const privateMode = (stat) => process.platform === 'win32' || !(stat.mode & 0o077);
    const rootStat = fs.lstatSync(this.root);
    if (!rootStat.isDirectory() || !privateMode(rootStat))
      throw new InvocationAttributeStoreError('invalid_store_permissions');
    const file = path.join(this.root, 'invocations.sqlite');
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || fileStat.nlink !== 1 || !privateMode(fileStat))
      throw new InvocationAttributeStoreError('invalid_store_permissions');
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA max_page_count=${Math.max(32, Math.floor(maxBytes / 4096))};
      CREATE TABLE IF NOT EXISTS contexts (scope TEXT, agent TEXT, invocation TEXT, attrs TEXT NOT NULL,
        expires INTEGER NOT NULL, retain INTEGER NOT NULL, selector TEXT,
        PRIMARY KEY(scope,agent,invocation), UNIQUE(scope,agent,selector));
      CREATE TABLE IF NOT EXISTS decisions (scope TEXT, agent TEXT, selector TEXT, state TEXT NOT NULL,
        first_seen INTEGER NOT NULL, deadline INTEGER NOT NULL, attrs TEXT, invocation TEXT, retain INTEGER NOT NULL,
        PRIMARY KEY(scope,agent,selector));
      CREATE INDEX IF NOT EXISTS context_expiry ON contexts(retain);
      CREATE INDEX IF NOT EXISTS pending_context_decisions ON decisions(scope,agent,deadline) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS decision_expiry ON decisions(retain);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.lastPrune = this.now();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  put(i) { return this.transaction(() => this.putInside(i)); }
  putInside(i) {
    const { scope, agent } = identity(i), invocation = text(i.invocationId);
    const attrs = canonical(parseInvocationAttributes(i.attributes));
    const ttl = i.ttlMs ?? 2 * DAY;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 7 * DAY) throw new InvocationAttributeStoreError('invalid_ttl');
    const old = this.db.prepare('SELECT * FROM contexts WHERE scope=? AND agent=? AND invocation=?').get(scope, agent, invocation);
    if (old) {
      if (old.attrs !== attrs) throw new InvocationAttributeStoreError('conflict');
      if (old.expires <= this.now()) throw new InvocationAttributeStoreError('expired');
      return 'unchanged';
    }
    this.db.prepare('INSERT INTO contexts VALUES(?,?,?,?,?,?,NULL)').run(scope, agent, invocation, attrs,
      this.now() + ttl, this.now() + ttl + 7 * DAY);
    return 'stored';
  }
  bind(i) { return this.transaction(() => this.bindInside(i)); }
  bindInside(i) {
    const { scope, agent } = identity(i), invocation = text(i.invocationId), key = selectorKey(i.selector);
    const c = this.db.prepare('SELECT * FROM contexts WHERE scope=? AND agent=? AND invocation=?').get(scope, agent, invocation);
    if (!c) throw new InvocationAttributeStoreError('missing');
    if (c.expires <= this.now()) throw new InvocationAttributeStoreError('expired');
    const d = this.db.prepare('SELECT * FROM decisions WHERE scope=? AND agent=? AND selector=?').get(scope, agent, key);
    if (d && d.state !== 'pending' && d.invocation !== invocation) throw new InvocationAttributeStoreError('sealed');
    if (c.selector && c.selector !== key) throw new InvocationAttributeStoreError('conflict');
    if (c.selector === key) return 'unchanged';
    const occupied = this.db.prepare('SELECT invocation FROM contexts WHERE scope=? AND agent=? AND selector=?').get(scope, agent, key);
    if (occupied) throw new InvocationAttributeStoreError('conflict');
    if (d?.state === 'pending' && this.now() >= d.deadline) {
      this.db.prepare("UPDATE decisions SET state='timedOut',attrs='{}' WHERE scope=? AND agent=? AND selector=?").run(scope, agent, key);
      return 'sealed';
    }
    this.db.prepare('UPDATE contexts SET selector=? WHERE scope=? AND agent=? AND invocation=?').run(key, scope, agent, invocation);
    return 'bound';
  }
  register(i) { return this.transaction(() => { const put = this.putInside(i), bind = this.bindInside(i); return bind === 'sealed' ? bind : put; }); }
  resolve(i) {
    if (this.now() - this.lastPrune > 60000) { this.prune(); this.lastPrune = this.now(); }
    return this.transaction(() => {
      const { scope, agent } = identity(i), key = selectorKey(i.selector), now = this.now();
      let d = this.db.prepare('SELECT * FROM decisions WHERE scope=? AND agent=? AND selector=?').get(scope, agent, key);
      if (d && d.state !== 'pending') return { state: d.state, attributes: JSON.parse(d.attrs || '{}'), invocationId: d.invocation };
      const c = this.db.prepare('SELECT * FROM contexts WHERE scope=? AND agent=? AND selector=?').get(scope, agent, key);

      if (!d) {
        const wait = i.managed ? (i.waitMs ?? 5000) : 0;
        if (!Number.isSafeInteger(wait) || wait < 0 || wait > 60000) throw new InvocationAttributeStoreError('invalid_wait');
        const count = wait > 0 && !c
          ? this.db.prepare("SELECT count(*) AS n FROM decisions WHERE scope=? AND agent=? AND state='pending' AND deadline>?").get(scope, agent, now).n
          : 0;
        const state = !c && count >= this.maxPending ? 'capacityDegraded' : 'pending';
        this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,NULL,?)').run(scope, agent, key, state,
          now, now + wait, state === 'pending' ? null : '{}', now + DECISION_RETENTION);
        d = { state, deadline: now + wait };
        if (state !== 'pending') return { state, attributes: {} };
      }
      let state, attrs = '{}', invocation = null;
      if (c && c.expires > now) { attrs = c.attrs; invocation = c.invocation; state = attrs === '{}' ? 'noAttrs' : 'bound'; }
      else if (i.seal || now >= d.deadline) state = 'timedOut';
      else return { state: 'pending', attributes: {} };
      this.db.prepare('UPDATE decisions SET state=?,attrs=?,invocation=? WHERE scope=? AND agent=? AND selector=?')
        .run(state, attrs, invocation, scope, agent, key);
      return { state, attributes: JSON.parse(attrs), invocationId: invocation };
    });
  }
  /** Bounded physical reclamation after the advertised recovery window. */
  prune() {
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM contexts WHERE rowid IN (SELECT rowid FROM contexts WHERE retain<? LIMIT 256)').run(now);
      this.db.prepare('DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions WHERE retain<? LIMIT 256)').run(now);
    });
  }
  close() { this.db.close(); }
}
