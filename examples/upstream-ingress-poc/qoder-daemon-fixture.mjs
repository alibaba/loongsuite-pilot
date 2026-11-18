#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

let lastSession = '';
fs.appendFileSync(path.join(process.env.POC_DATA_DIR, 'qoder-daemon-starts'), 'start\n', { mode: 0o600 });
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const requestType = frame.request.type;
    let response = {};
    if (requestType === 'daemon.initialize') response = { daemon_protocol_version: frame.request.daemon_protocol_version,
      daemon_version: 'fixture', capabilities: ['multi_session_v2'] };
    if (requestType === 'daemon.open_session') {
      const args = frame.request.worker_args ?? [];
      const index = args.indexOf('--session-id');
      lastSession = index >= 0 ? args[index + 1] : randomUUID();
      response = undefined;
    }
    if (requestType === 'daemon.close_session' || requestType === 'daemon.shutdown') response = undefined;
    if (requestType === 'initialize') response = { commands: [], agents: [], output_style: 'default',
      available_output_styles: [], models: [], account: {}, capabilities: ['plan_mode_v1'] };
    const responseSession = frame.session_id ?? (requestType === 'daemon.open_session' ? lastSession : undefined);
    send({ type: 'control_response', ...(responseSession ? { session_id: responseSession } : {}),
      response: { subtype: 'success', request_id: frame.request_id, ...(response === undefined ? {} : { response }) } });
  }
  if (frame.type === 'user') {
    const sessionId = frame.session_id ?? lastSession;
    const prompt = Array.isArray(frame.message?.content)
      ? frame.message.content.filter(item => item.type === 'text').map(item => item.text).join('')
      : frame.message?.content;
    fs.writeFileSync(path.join(process.env.POC_DATA_DIR, `${frame.uuid}.json`),
      JSON.stringify({ sessionId, nativeTurnId: frame.uuid, prompt }), { mode: 0o600 });
    send({ type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
      result: 'fixture response', stop_reason: 'end_turn', total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId });
  }
}
