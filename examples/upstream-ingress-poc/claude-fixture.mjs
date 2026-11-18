#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const sessionId = process.env.POC_SESSION_ID;
const requestId = process.env.POC_REQUEST_ID;
const nativeTurnId = process.env.POC_OMIT_PROMPT_ID ? undefined : randomUUID();
const wirePath = path.join(process.env.POC_DATA_DIR, `${requestId}.json`);
const reader = readline.createInterface({ input: process.stdin });
let callbackId;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

reader.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    callbackId = message.request.hooks.UserPromptSubmit[0].hookCallbackIds[0];
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'user') {
    const prompt = message.message.content.map(part => part.text || '').join('');
    fs.writeFileSync(wirePath, JSON.stringify({ sessionId, nativeTurnId, prompt, args: process.argv.slice(2),
      traceparent: process.env.TRACEPARENT, tracestate: process.env.TRACESTATE }));
    send({ type: 'control_request', request_id: 'fixture-hook', request: {
      subtype: 'hook_callback', callback_id: callbackId, input: { hook_event_name: 'UserPromptSubmit',
        session_id: sessionId, ...(nativeTurnId ? { prompt_id: nativeTurnId } : {}),
        cwd: process.cwd(), transcript_path: process.env.POC_TRANSCRIPT_PATH, prompt } } });
  } else if (message.type === 'control_response' && message.response.request_id === 'fixture-hook') {
    send({ type: 'result', subtype: 'success', session_id: sessionId, uuid: randomUUID(),
      result: 'fixture response', is_error: false, duration_ms: 1, duration_api_ms: 1,
      num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
  }
});
