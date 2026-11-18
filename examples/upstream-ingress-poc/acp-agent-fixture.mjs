import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import { bindIngress } from './ingress.mjs';

const sessions = new Set();
new AgentSideConnection(() => ({
  async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }; },
  async authenticate() { return {}; },
  async newSession() { const sessionId = randomUUID(); sessions.add(sessionId); return { sessionId }; },
  async prompt(params) {
    if (!sessions.has(params.sessionId)) throw new Error('unknown session');
    const nativeTurnId = randomUUID();
    const binding = bindIngress({ agentId: 'codex', sessionId: params.sessionId, nativeTurnId,
      carrier: params._meta, dataDir: process.env.POC_DATA_DIR });
    return { stopReason: 'end_turn', _meta: { nativeTurnId, recorded: binding.recorded } };
  },
  async cancel() {},
  async setSessionMode() { return {}; },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
