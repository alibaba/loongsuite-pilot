// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { enrichTurn, MAX_TRANSCRIPT_BYTES } from './transcript-parser.mjs';

const safeName = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
const MAX_AGENTS = 1000;
const MAX_DEPTH = 100;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const COLLECTION_KEY = 'agent.qwen-code-cli.subagent.collection';

// Scope native tool IDs without altering any message content. This also keeps
// the shared pair sanitizer / span-ID reservations safe across parallel agents.
export function scopedToolId(agentId, callId, runId = '') {
  return `qwen-child:${crypto.createHash('sha256').update(JSON.stringify([agentId, runId, callId])).digest('hex').slice(0, 32)}`;
}

/** Parse the child writer's split ROUND_TEXT / TOOL_CALL records as model rounds. */
export function parseSubagentRecords(source, meta) {
  const records = [];
  const seen = new Set();
  let round = null;
  let toolsOpen = false;
  const toolTimes = new Map();
  const activeCalls = new Map();
  let runId = '';
  for (const raw of source) {
    if (raw.agentId !== meta.agentId || raw.sessionId !== meta.parentSessionId) {
      throw new Error('identity_mismatch');
    }
    if (!raw.uuid || seen.has(raw.uuid)) continue;
    seen.add(raw.uuid);
    const r = structuredClone(raw);
    if (r.agentRunId) runId = r.agentRunId;
    const parts = r.message?.parts || [];
    for (const p of parts) {
      if (p.functionCall?.id) {
        const native = p.functionCall.id;
        p.functionCall.id = scopedToolId(meta.agentId, native, runId);
        activeCalls.set(native, p.functionCall.id);
        toolTimes.set(p.functionCall.id, { timestamp: r.timestamp, native });
      }
      if (p.functionResponse?.id) p.functionResponse.id = activeCalls.get(p.functionResponse.id) || scopedToolId(meta.agentId, p.functionResponse.id, runId);
    }
    if (r.toolCallResult?.callId) {
      r.toolCallResult.callId = activeCalls.get(r.toolCallResult.callId) || scopedToolId(meta.agentId, r.toolCallResult.callId, runId);
      // v0.21.1 does not write status for ordinary tool failures.
      if (parts.some(p => p.functionResponse?.response?.error)) r.toolCallResult.status = 'error';
    }
    if (r.type === 'assistant') {
      const toolOnly = parts.length > 0 && parts.every(p => p.functionCall);
      // ROUND_TEXT owns usage. Following TOOL_CALL records are fragments of
      // that response, not separate model invocations. After results/user/run
      // boundaries a tool-only response starts a new round with unknown usage.
      if (toolOnly && round && toolsOpen && r.agentRound === undefined) {
        round.message.parts.push(...parts);
      } else {
        round = r;
        round.model = r.model || meta.model || meta.persistedCliFlags?.model;
        records.push(round);
      }
      toolsOpen = true;
    } else {
      records.push(r);
      if (r.type === 'tool_result' || r.type === 'user' || r.subtype === 'agent_retry') toolsOpen = false;
    }
  }
  const userIndex = records.findIndex(r => r.type === 'user');
  if (userIndex < 0) throw new Error('missing_input');
  const turn = enrichTurn({ userRecord: records[userIndex], records: records.slice(userIndex + 1) }, undefined, true);
  // Fork bootstrap is context, not a new execution or extra model call.
  const bootstrap = records.find(r => r.subtype === 'agent_bootstrap')?.systemPayload?.history;
  if (Array.isArray(bootstrap) && turn.llmCalls.length) {
    turn.llmCalls[0].inputMessagesDeltaRecords.unshift(...bootstrap.map(message => ({
      type: message.role === 'model' ? 'assistant' : 'user', message,
    })));
  }
  for (const llm of turn.llmCalls) {
    llm.assistantUuid = `${meta.agentId}:${llm.assistantUuid}`;
    for (const tool of llm.declaredTools) {
      const native = toolTimes.get(tool.callId);
      tool.nativeCallId = native?.native;
      tool.timestamp = native?.timestamp;
    }
  }
  return turn;
}

/** One bounded inventory per parent Stop; no per-child Hook state or offsets. */
export function loadSubagentIndex(transcriptPath, sessionId) {
  const index = new Map();
  // Custom/legacy transcript layouts are not guessed.
  if (path.basename(path.dirname(transcriptPath)) !== 'chats') return { index, reason: 'metadata_unavailable' };
  const directory = path.join(path.dirname(path.dirname(transcriptPath)), 'subagents', safeName(sessionId));
  let names;
  try { names = fs.readdirSync(directory); }
  catch { return { index, reason: 'metadata_unavailable' }; }
  if (names.length > MAX_AGENTS * 3) return { index, reason: 'collection_limit' };
  let count = 0;
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
    if (++count > MAX_AGENTS) return { index: new Map(), reason: 'collection_limit' };
    try {
      const filename = path.join(directory, name);
      if (fs.statSync(filename).size > 1024 * 1024) continue;
      const meta = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (meta.parentSessionId !== sessionId || typeof meta.agentId !== 'string' ||
          typeof meta.toolUseId !== 'string' || !meta.toolUseId ||
          !(meta.parentAgentId === null || typeof meta.parentAgentId === 'string') ||
          name !== `agent-${safeName(meta.agentId)}.meta.json`) continue;
      const key = JSON.stringify([meta.parentAgentId, meta.toolUseId]);
      const list = index.get(key) || [];
      list.push({ meta, filename: filename.replace(/\.meta\.json$/, '.jsonl') });
      index.set(key, list);
    } catch { /* malformed/unavailable metadata is diagnosed on its parent tool */ }
  }
  return { index, reason: 'metadata_missing' };
}

/** Attach only children whose completed foreground invocation is in this turn. */
export function collectSubagents(rootTurn, rootRecords, inventory, buildRecords) {
  const output = [];
  const visited = new Set();
  let bytes = 0;
  const traceId = rootRecords[0]?.trace_id;
  const turnId = rootRecords[0]?.['gen_ai.turn.id'];
  function visit(turn, records, parentId, depth) {
    for (const llm of turn.llmCalls) for (const tool of llm.declaredTools) {
      const candidates = inventory.index.get(JSON.stringify([parentId, tool.nativeCallId || tool.callId])) || [];
      if (!candidates.length && tool.name !== 'agent') continue;
      const mark = (reason) => {
        for (const r of records) if (r['gen_ai.tool.call.id'] === tool.callId) r[COLLECTION_KEY] = reason;
      };
      if (candidates.length !== 1) { mark(candidates.length ? 'ambiguous_parent' : inventory.reason); continue; }
      const { meta, filename } = candidates[0];
      if (meta.isBackgrounded === true) { mark('unsupported_background'); continue; }
      if (meta.isBackgrounded !== false) { mark('unknown_execution_mode'); continue; }
      if (!tool.result || !TERMINAL.has(meta.status)) { mark('incomplete'); continue; }
      if (depth > MAX_DEPTH || visited.has(meta.agentId)) { mark('invalid_hierarchy'); continue; }
      try {
        const before = fs.statSync(filename);
        if (bytes + before.size > MAX_TRANSCRIPT_BYTES) { mark('collection_limit'); continue; }
        bytes += before.size;
        const text = fs.readFileSync(filename, 'utf8');
        const after = fs.statSync(filename);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
            (text.length && !text.endsWith('\n'))) { mark('incomplete'); continue; }
        const source = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
        // A resumed agent's old rounds must not be attributed to this call.
        const start = Date.parse(tool.timestamp || llm.timestamp);
        const end = Date.parse(tool.result.timestamp);
        if (!Number.isFinite(start) || !Number.isFinite(end)) { mark('missing_time_boundary'); continue; }
        const window = source.filter(r => {
          const t = Date.parse(r.timestamp);
          return t >= start && t <= end;
        });
        const childTurn = parseSubagentRecords(window, meta);
        if (!childTurn.llmCalls.length) { mark('no_model_records'); continue; }
        visited.add(meta.agentId);
        const child = buildRecords(childTurn, {
          traceId, turnId, stepPrefix: `${turnId}:agent:${meta.agentId}`,
          fields: {
            'gen_ai.agent.id': meta.agentId,
            'gen_ai.agent.name': meta.agentType || meta.subagentName || meta.agentId,
            'gen_ai.agent.scope': 'subagent',
            'gen_ai.agent.depth': depth,
            'gen_ai.agent.parent.id': parentId || rootRecords[0]['gen_ai.agent.id'],
            'gen_ai.subagent.parent_tool_call.id': tool.callId,
            'agent.qwen-code-cli.subagent.status': meta.status,
            'agent.qwen-code-cli.timing.source': 'transcript_boundary',
          },
          subagent: true,
        });
        mark('collected');
        visit(childTurn, child, meta.agentId, depth + 1);
        output.push(...child);
      } catch { mark('transcript_unavailable'); }
    }
  }
  visit(rootTurn, rootRecords, null, 1);
  return output;
}
