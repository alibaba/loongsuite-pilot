// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const validId = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v) && !/^0+$/.test(v);

// Identity only; no prompts/tool payloads. One atomic file per native child run
// allows an independently resumed child to recover its originating TOOL.
export function createSubagentContexts(dataDir, reportError) {
  const directory = () => path.join(dataDir(), 'subagent-contexts', 'openclaw');
  const filename = id => path.join(directory(), crypto.createHash('sha256').update(id).digest('hex') + '.json');
  let pruned = false;
  return {
    read(id) {
      try {
        const v = JSON.parse(fs.readFileSync(filename(id), 'utf8'));
        if (v.runId === id && v.expiresAt > Date.now() && validId(v.traceId, 32) && validId(v.parentSpanId, 16)) return v;
      } catch { /* absent/partial/unreadable state never breaks the agent */ }
    },
    write(id, value) {
      let tmp;
      try {
        fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
        if (!pruned) {
          pruned = true;
          for (const name of fs.readdirSync(directory())) {
            const file = path.join(directory(), name);
            if (/^[a-f0-9]{64}\.json$/.test(name) && Date.now() - fs.statSync(file).mtimeMs > RETENTION_MS) fs.unlinkSync(file);
          }
        }
        tmp = filename(id) + '.' + crypto.randomUUID() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ ...value, runId: id, expiresAt: Date.now() + RETENTION_MS }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, filename(id));
      } catch (error) { reportError('subagent-context', error); }
      finally { if (tmp) try { fs.unlinkSync(tmp); } catch {} }
    },
  };
}

export function stampSubagent(record, parent) {
  return {
    ...record,
    trace_id: parent.traceId,
    parent_span_id: parent.parentSpanId,
    'gen_ai.agent.scope': 'subagent',
    'gen_ai.agent.parent.id': parent.sessionId,
    'gen_ai.subagent.parent_tool_call.id': parent.toolCallId,
    'agent.pilot.parent.turn.id': parent.turnId,
    'user.id': parent.userId,
    'agent.pilot.invocation.user.id': parent.userId,
    'agent.openclaw.user.id.source': 'parent',
    // A child has an initiating user, not a new channel sender.
    'agent.openclaw.sender.id': undefined,
  };
}
