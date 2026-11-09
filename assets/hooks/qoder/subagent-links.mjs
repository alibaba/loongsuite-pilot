// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';

export const QODER_DELEGATIONS_KEY = '__qoderDelegations';
const MAX_DELEGATIONS = 4096;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const qoderDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
const blocks = row => Array.isArray(row?.message?.content) ? row.message.content : [];
const callKey = (session, call) => JSON.stringify([session, call]);

export function qoderTaskNotification(row) {
  if (row?.type !== 'user' || row.isMeta !== true || row.origin?.kind !== 'task-notification') return;
  const content = typeof row.message?.content === 'string' ? row.message.content
    : blocks(row).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const body = /<task-notification>([\s\S]*)<\/task-notification>/.exec(content)?.[1];
  if (!body) return;
  const callId = /<tool-use-id>([a-zA-Z0-9_-]{1,512})<\/tool-use-id>/.exec(body)?.[1];
  const status = /<status>(completed|failed|cancelled|stopped)<\/status>/.exec(body)?.[1];
  const result = /<result>([\s\S]*)<\/result>/.exec(body)?.[1];
  return callId && status ? { callId, status, result } : undefined;
}

export function qoderTurnId(agentId, source, checkpoint, prompt) {
  return qoderDigest([agentId, source.sessionId, source.transcriptPath, checkpoint.inode,
    checkpoint.activeStart, prompt]);
}

/** Identifiers only. Native transcripts remain the sole owner of message bodies. */
export class QoderSubagentLinks {
  constructor(state = {}, now = Date.now(), warn = () => {}) {
    this.state = {};
    this.size = 0;
    this.now = now;
    this.warn = warn;
    this.byCall = new Map();
    const saved = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    for (const [id, link] of Object.entries(saved).slice(-MAX_DELEGATIONS)) {
      if (!link || link.id !== id || !/^[0-9a-f]{32}$/.test(id)
        || !text(link.sessionId) || !text(link.agentId) || !text(link.callId) || !text(link.turnId)
        || !/^[0-9a-f]{32}$/.test(link.traceId) || !/^[0-9a-f]{16}$/.test(link.spanId)
        || !Number.isFinite(link.at) || now - link.at > MAX_AGE_MS) {
        continue;
      }
      this.state[id] = link;
      this.size++;
      this.index(link);
    }
  }

  index(link) {
    const key = callKey(link.sessionId, link.callId);
    const matches = this.byCall.get(key) ?? [];
    matches.push(link);
    this.byCall.set(key, matches);
  }

  update(link, fields) {
    const updated = { ...link, ...fields };
    this.state = { ...this.state, [link.id]: updated };
    const key = callKey(link.sessionId, link.callId);
    this.byCall.set(key, this.byCall.get(key).map(item => item.id === link.id ? updated : item));
    return updated;
  }

  find(session, call, parentAgent, turnId) {
    const matches = (this.byCall.get(callKey(session, call)) ?? [])
      .filter(link => (!parentAgent || link.agentId === parentAgent) && (!turnId || link.turnId === turnId));
    return matches.length === 1 ? matches[0] : undefined;
  }

  register(source, checkpoint, row) {
    const added = [];
    if (row?.type !== 'assistant' || !checkpoint.turnId || !checkpoint.traceContext) return added;
    for (const block of blocks(row)) {
      if (!['Agent', 'Task'].includes(block?.name) || !text(block.id)
        || !block.input || typeof block.input !== 'object') continue;
      const id = qoderDigest(['qoder-delegation', source.sessionId,
        source.subagentId ?? source.sessionId, checkpoint.turnId, block.id]).slice(0, 32);
      if (this.state[id]) continue;
      if (this.size >= MAX_DELEGATIONS) {
        const finished = Object.values(this.state).find(link => link.resultEmitted && link.childComplete);
        if (!finished) { this.warn(source.key, 'subagent-link-capacity'); continue; }
        const { [finished.id]: _removed, ...remaining } = this.state;
        this.state = remaining;
        const key = callKey(finished.sessionId, finished.callId);
        const matches = this.byCall.get(key).filter(link => link.id !== finished.id);
        if (matches.length) this.byCall.set(key, matches); else this.byCall.delete(key);
        this.size--;
      }
      const link = { id, sessionId: source.sessionId, agentId: source.subagentId ?? source.sessionId,
        turnId: checkpoint.turnId, callId: block.id, toolName: block.name, traceId: checkpoint.traceContext.traceId,
        spanId: qoderDigest(['qoder-tool', source.sessionId, checkpoint.turnId, block.id]).slice(0, 16),
        ...(text(block.input.subagent_type) ? { peerName: block.input.subagent_type } : {}), at: this.now };
      this.state = { ...this.state, [id]: link };
      this.size++;
      this.index(link);
      added.push({ link, block });
    }
    return added;
  }

  /** Bind only a native delegated input. A direct input in a reused child is independent. */
  incoming(source, prompt) {
    if (!source.subagentId || prompt?.isDelegatedTask !== true || !text(prompt.parent_tool_use_id)) return;
    if (text(prompt.agentId) && prompt.agentId !== source.subagentId) return;
    return this.find(source.sessionId, prompt.parent_tool_use_id, text(prompt.parent_agent_id));
  }

  decorate(source, checkpoint, rows, records, complete = false) {
    const incoming = checkpoint.incoming;
    if (complete && incoming && this.state[incoming.id] && !this.state[incoming.id].childComplete) {
      this.update(this.state[incoming.id], { childComplete: true });
    }
    const results = new Map();
    for (const row of rows) {
      for (const block of blocks(row)) {
        if (block.type !== 'tool_result') continue;
        results.set(block.tool_use_id, row.toolUseResult);
        const link = this.find(source.sessionId, block.tool_use_id, source.subagentId ?? source.sessionId, checkpoint.turnId);
        if (link && text(row.toolUseResult?.agentId) && link.peerId !== row.toolUseResult.agentId) {
          this.update(link, { peerId: row.toolUseResult.agentId });
        }
      }
    }
    for (const record of records) {
      record.trace_id = checkpoint.traceContext.traceId;
      record['gen_ai.agent.id'] = source.subagentId ?? source.sessionId;
      if (source.subagentId) record['agent.qoder.subagent_id'] = source.subagentId;
      if (source.subagentName) record['gen_ai.agent.name'] = source.subagentName;
      if (incoming) {
        Object.assign(record, {
          'gen_ai.agent.scope': 'subagent',
          'gen_ai.agent.parent.id': incoming.agentId,
          'gen_ai.agent.parent.invocation.id': incoming.id,
          'gen_ai.subagent.parent_tool_call.id': incoming.callId,
          'agent.qoder.parent_turn_id': incoming.turnId,
          parent_span_id: incoming.spanId,
        });
      } else if (record['event.name'] === 'other' && checkpoint.traceContext.parentSpanId) {
        record.parent_span_id = checkpoint.traceContext.parentSpanId;
      }
      const call = record['gen_ai.tool.call.id'];
      const own = call && this.find(source.sessionId, call, source.subagentId ?? source.sessionId, checkpoint.turnId);
      if (own && own.turnId === checkpoint.turnId) {
        record.span_id = own.spanId;
        record['gen_ai.agent.invocation.id'] = own.id;
      }
    }
    const audit = [];
    for (const record of records) {
      const name = record['event.name'];
      if (name !== 'tool.call' && name !== 'tool.result') continue;
      const link = this.find(source.sessionId, record['gen_ai.tool.call.id'], source.subagentId ?? source.sessionId, checkpoint.turnId);
      if (!link || link.turnId !== checkpoint.turnId) continue;
      const result = results.get(link.callId);
      const peerId = text(result?.agentId);
      if (peerId) record['gen_ai.agent.peer.id'] = peerId;
      const event = { ...record, 'event.id': qoderDigest([link.id, name === 'tool.call' ? 'invoke' : 'result']),
        'event.name': name === 'tool.call' ? 'gen_ai.agent.invoke' : 'gen_ai.agent.result',
        'gen_ai.agent.invocation.id': link.id,
        ...(peerId ? { 'gen_ai.agent.peer.id': peerId } : {}),
        ...(text(result?.agentType) || link.peerName ? { 'gen_ai.agent.peer.name': text(result?.agentType) ?? link.peerName } : {}),
      };
      delete event['gen_ai.turn.start']; delete event['gen_ai.turn.end'];
      delete event['gen_ai.tool.call.arguments']; delete event['gen_ai.tool.call.result'];
      delete event['gen_ai.tool.call.duration'];
      if (name === 'tool.call') {
        if (link.invokeEmitted) continue;
        const input = record['gen_ai.tool.call.arguments'];
        if (typeof input?.prompt === 'string' && input.prompt.length) {
          event['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content: input.prompt }] }];
        }
      } else {
        if (link.resultEmitted) continue;
        // Accepted/background receipts are not delivered Agent results.
        if (!record['tool.result.status'] || (record['tool.result.status'] !== 'error'
          && (result?.kind !== 'agent-result' || !['completed', 'failed', 'cancelled', 'interrupted'].includes(result.state)))) continue;
        const content = typeof result?.content === 'string' ? result.content : record['gen_ai.tool.call.result'];
        if (typeof content === 'string') event['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content }] }];
      }
      audit.push(event);
      if (name === 'tool.result') this.update(link, { resultEmitted: true });
    }
    for (const row of rows) {
      const notification = qoderTaskNotification(row);
      if (!notification) continue;
      const link = this.find(source.sessionId, notification.callId, source.subagentId ?? source.sessionId);
      if (!link || link.resultEmitted || (notification.status === 'completed' && notification.result === undefined)) continue;
      const base = records.find(record => record['event.name'] === 'other') ?? records[0];
      if (!base || !Number.isFinite(Date.parse(row.timestamp))) continue;
      const event = { ...base,
        'event.id': qoderDigest([link.id, 'result']), 'event.name': 'gen_ai.agent.result',
        'gen_ai.agent.invocation.id': link.id, 'gen_ai.tool.call.id': link.callId,
        'gen_ai.tool.name': link.toolName,
        'tool.result.status': notification.status === 'completed' ? 'success' : 'error',
        ...(link.peerId ? { 'gen_ai.agent.peer.id': link.peerId } : {}),
        ...(link.peerName ? { 'gen_ai.agent.peer.name': link.peerName } : {}),
        time_unix_nano: String(BigInt(Date.parse(row.timestamp)) * 1_000_000n),
      };
      delete event['gen_ai.turn.start']; delete event['gen_ai.turn.end'];
      delete event['gen_ai.input.messages']; delete event['gen_ai.input.messages_delta'];
      if (notification.result !== undefined) event['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: notification.result }] }];
      audit.push(event);
      this.update(link, { resultEmitted: true });
    }
    return [...records, ...audit];
  }
}
