/**
 * Hermetic adapter fixture, not a native Agent execution. The real Pilot
 * producers receive synthetic host callbacks/transcript files. No model runs.
 * Each worker is a separate process, as in concurrent customer Agent workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [framework, dataDir, session, owner] = process.argv.slice(2);
const root = process.cwd();
const prompt = 'Find my retained preference';
const baseTime = Date.now() - 60_000;
const contexts = path.join(dataDir, 'acp-correlate');
fs.mkdirSync(contexts, { recursive: true });
// Do not inherit request metadata from the developer's active Agent process.
delete process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
delete process.env.TRACEPARENT;

function annotate(index) {
  const attributes = index === 1 ? {} : {
    'memory.user_id': index === 0 ? owner : `${owner}-next`,
    'memory.request_id': `${session}-request-${index}`,
  };
  // Customer-side contract: persist one row before every send, including the
  // request that intentionally carries no attributes. Identical prompts are
  // ordered within one native session; independent sessions run concurrently.
  fs.appendFileSync(path.join(contexts, `${session}.jsonl`), JSON.stringify({
    type: 'turn', contentHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16), attributes,
  }) + '\n');
}
function append(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
async function hook(file, event, payload, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, file), event], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${event}: ${code} ${stderr}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function grok() {
  const grokHome = path.join(dataDir, 'native', 'grok');
  const directory = path.join(grokHome, 'sessions', encodeURIComponent('/workspace'), session);
  const updates = path.join(directory, 'updates.jsonl');
  const unified = path.join(dataDir, 'native', `${session}-unified.jsonl`);
  for (let index = 0; index < 3; index++) {
    annotate(index);
    const start = baseTime + index * 5000;
    const turn = `${session}-prompt-${index}`;
    append(path.join(directory, 'chat_history.jsonl'), [
      { type: 'user', prompt_index: index, content: `<user_query>${prompt}</user_query>`, timestamp: new Date(start).toISOString() },
      { type: 'assistant', content: `done ${index}`, model_id: 'grok-code-fast-1', timestamp: new Date(start + 1000).toISOString() },
    ]);
    append(updates, [{ timestamp: start / 1000 + 1,
      params: { _meta: { promptId: turn, agentTimestampMs: start + 1000, turnStartMs: start },
        update: { sessionUpdate: 'turn_completed', stopReason: 'end_turn', _meta: { promptIndex: index } } },
    }]);
    append(unified, [{ ts: new Date(start + 100).toISOString(), sid: session,
      msg: 'shell.turn.inference_start', ctx: { loop_index: index + 1 } }]);
    await hook('assets/hooks/grok-build-hook-processor.mjs', 'stop', {
      session_id: session, prompt_id: turn, transcript_path: updates, cwd: '/workspace',
      timestamp: new Date(start + 2000).toISOString(), stop_reason: 'end_turn',
    }, { GROK_HOME: grokHome, GROK_UNIFIED_LOG_PATH: unified });
  }
}

async function codex() {
  const transcript = path.join(dataDir, 'native', 'codex', 'sessions', `rollout-${session}.jsonl`);
  append(transcript, [{ timestamp: new Date(baseTime - 1000).toISOString(), type: 'session_meta',
    payload: { id: session, model_provider: 'openai' } }]);
  for (let index = 0; index < 3; index++) {
    annotate(index);
    const turn = `${session}-turn-${index}`;
    const env = { LOONGSUITE_PILOT_SPAN_ATTRIBUTES: `multica.issue.id=${session}-hook-${index}` };
    const payload = { session_id: session, turn_id: turn, transcript_path: transcript, cwd: '/workspace', prompt };
    await hook('assets/hooks/codex-hook-processor.mjs', 'user-prompt-submit', payload, env);
    const rows = [
      ['turn_context', { turn_id: turn, model: 'gpt-fixture', cwd: '/workspace' }],
      ['event_msg', { type: 'task_started', turn_id: turn }],
      ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      ['response_item', { type: 'function_call', call_id: `${turn}-tool`, name: 'exec_command', arguments: '{"cmd":"pwd"}' }],
      ['response_item', { type: 'function_call_output', call_id: `${turn}-tool`, output: '/workspace' }],
      ['event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
      ['event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: `done ${index}` }],
    ];
    append(transcript, rows.map(([type, payload], tick) => ({
      timestamp: new Date(baseTime + index * 10000 + tick * 100).toISOString(), type, payload,
    })));
    await hook('assets/hooks/codex-hook-processor.mjs', 'stop', payload, env);
  }
}

async function pi() {
  const handlers = new Map();
  const { default: install } = await import(pathToFileURL(path.join(root, 'assets/plugins/pi-coding-agent/index.mjs')).href);
  install({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ['read'],
    getAllTools: () => [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }] });
  const ctx = { cwd: '/workspace', model: { provider: 'anthropic', id: 'claude-fixture' },
    sessionManager: { getSessionId: () => session } };
  async function emit(name, payload = {}) {
    const fn = handlers.get(name);
    if (!fn) throw new Error(`Missing Pi host callback ${name}`);
    await fn({ type: name, ...payload }, ctx);
  }
  await emit('session_start', { reason: 'startup' });
  for (let index = 0; index < 3; index++) {
    annotate(index);
    await emit('before_agent_start', { prompt, systemPrompt: 'Fixture agent' });
    await emit('turn_start', { turnIndex: 0, timestamp: baseTime + index * 5000 });
    await emit('context', { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] });
    const toolCallId = `${session}-tool-${index}`;
    await emit('message_end', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-fixture',
      responseId: `${session}-tool-response-${index}`, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: { path: 'README.md' } }],
      usage: { input: 10, output: 2, totalTokens: 12 } } });
    await emit('tool_execution_start', { toolCallId, toolName: 'read', args: { path: 'README.md' } });
    await emit('tool_execution_end', { toolCallId, toolName: 'read', result: { content: [{ type: 'text', text: 'fixture' }] }, isError: false });
    await emit('turn_start', { turnIndex: 1, timestamp: Date.now() });
    await emit('context', { messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: { path: 'README.md' } }] },
      { role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: 'fixture' }] },
    ] });
    await emit('message_end', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-fixture',
      responseId: `${session}-response-${index}`, stopReason: 'stop',
      content: [{ type: 'text', text: `done ${index}` }], usage: { input: 12, output: 3, totalTokens: 15 } } });
  }
  await emit('session_shutdown');
}

async function dsh() {
  const plugin = path.join(dataDir, 'plugins', 'dsh', 'plugin.mjs');
  const handlers = new Map();
  const { default: install } = await import(pathToFileURL(plugin).href);
  install({ on: (name, fn) => handlers.set(name, fn), logger: () => ({ info() {} }) });
  if (!handlers.has('session/event')) throw new Error('DSH plugin did not register session/event');
  const hostSession = { id: session };
  handlers.get('session/created')(hostSession);
  let seq = 0;
  for (let index = 0; index < 3; index++) {
    annotate(index);
    const turn = index + 1;
    const rows = [
      ['turn/start', { turn }], ['step/start', { turn, step: 1 }],
      ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }],
      ['request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-fixture' } } }],
      ['request/context', {}],
      ['assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', text: `done ${index}` } }],
      ['assistant/chunk', { turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      ['assistant/message', { turn, step: 1, message: { id: `${session}-response-${index}`,
        content: [{ type: 'text', text: `done ${index}` }], source: { provider: 'deepseek', model: 'deepseek-fixture' } },
        usage: { inputTokens: 10, outputTokens: 2 } }],
      ['turn/end', { turn }],
    ];
    for (const [tick, [type, data]] of rows.entries()) {
      handlers.get('session/event')(hostSession, { seq: ++seq, time: baseTime + index * 5000 + tick * 100, type, data });
    }
  }
}

await ({ grok, codex, pi, dsh })[framework]();
