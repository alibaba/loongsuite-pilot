#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindIngress } from './ingress.mjs';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const sessionId = process.env.POC_SESSION_ID;
const nativeTurnId = randomUUID();
const carrier = { traceparent: process.env.TRACEPARENT, tracestate: process.env.TRACESTATE };
const binding = bindIngress({ agentId: 'codex', sessionId, nativeTurnId, carrier, dataDir: process.env.POC_DATA_DIR });
const result = { sessionId, nativeTurnId, prompt, binding, resumed: process.argv.includes('resume') };
fs.writeFileSync(path.join(process.env.POC_DATA_DIR, `${process.env.POC_REQUEST_ID}.json`), JSON.stringify(result), { mode: 0o600 });
if (process.argv.includes('exec')) {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'fixture', type: 'agent_message', text: 'fixture response' } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 } })}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
