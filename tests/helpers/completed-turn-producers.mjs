// Drive the shipped producer modules with synthetic host callbacks. These are
// producer integration fixtures, not evidence of native Agent/model execution.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupV2 } from '../../assets/plugins/opencode/v2.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function readRecords(dir) {
  return fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')).sort()
    .flatMap(file => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

export async function openCodeProducer({ calls = 8, cancelled = false, now = Date.now() } = {}) {
  const hooks = new Map(), records = [], pending = [], errors = [];
  let wake, seq = 0;
  const cleanup = await setupV2({
    location: { directory: '/synthetic-project' },
    session: { hook: async (name, callback) => { hooks.set(name, callback); return { dispose() {} }; } },
    event: { async *subscribe({ signal }) {
      signal.addEventListener('abort', () => wake?.(), { once: true });
      while (!signal.aborted) {
        if (pending.length) yield pending.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    } },
  }, {
    common: (session, state) => ({ 'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': session,
      'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId }),
    writeRecord: record => records.push(record), writeError: (...args) => errors.push(args),
    inferProviderName: id => id, recordUpstreamEnvOnce() {},
  });
  const send = async (type, data = {}) => {
    pending.push({ id: `fixture-event-${++seq}`, type, created: now + seq * 10,
      data: { sessionID: 'fixture-session', ...data } });
    wake?.(); await tick();
  };
  const history = [{ role: 'user', content: 'inspect the synthetic JSON file' }];
  try {
    for (let i = 0; i < calls; i++) {
      hooks.get('context')({ sessionID: 'fixture-session', system: [{ text: 'fixture instructions' }], messages: [...history] });
      const assistantMessageID = `response-${i}`;
      await send('session.step.started', { assistantMessageID, agent: 'build',
        model: { id: 'fixture-model', providerID: 'openai' }, started: now + (seq + 1) * 10 });
      await send('session.text.ended', { assistantMessageID, ordinal: 0, text: `output-${i}` });
      await send('session.reasoning.ended', { assistantMessageID, ordinal: 0, text: `reason-${i}` });
      if (cancelled && i === calls - 1) break;
      if (i < calls - 1) {
        for (let j = 0; j < 2; j++) {
          const id = `tool-${i}-${j}`;
          await send('session.tool.input.started', { assistantMessageID, id, name: 'read' });
          await send('session.tool.called', { assistantMessageID, id, input: { index: i, branch: j } });
          await send(j === 1 && i === 1 ? 'session.tool.failed' : 'session.tool.success', {
            assistantMessageID, id, content: [{ type: 'text', text: `result-${i}-${j}` }],
            ...(j === 1 && i === 1 ? { error: { name: 'FixtureReadError', message: 'synthetic missing file' } } : {}),
          });
        }
      }
      await send('session.step.ended', { assistantMessageID, finish: i < calls - 1 ? 'tool-calls' : 'stop',
        tokens: { input: 100 + i, output: 10 + i, reasoning: 2, cache: { read: 5, write: 3 } } });
      history.push({ role: 'assistant', content: `output-${i}` }, { role: 'user', content: `continue-${i}` });
    }
    await send(cancelled ? 'session.execution.interrupted' : 'session.execution.succeeded');
  } finally { cleanup(); }
  if (errors.length) throw new Error(JSON.stringify(errors));
  return records;
}

export function hermesProducer(root, calls = 8) {
  const script = String.raw`
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
h = {}; p.register(types.SimpleNamespace(register_hook=lambda name, cb: h.update({name: cb})))
base = dict(session_id='fixture-session', task_id='fixture-turn', turn_id='fixture-turn', model='fixture-model', provider='openai', platform='cli')
history = [dict(role='user', content='inspect the synthetic JSON file')]
h['pre_llm_call'](**base, user_message=history[0]['content'], conversation_history=history)
for i in range(int(sys.argv[2])):
    call = dict(base, api_call_count=i+1, api_request_id='request-'+str(i))
    h['pre_api_request'](**call, conversation_history=history)
    h['post_api_request'](**call, finish_reason='tool_calls' if i+1<int(sys.argv[2]) else 'stop',
        usage=dict(input_tokens=100+i, output_tokens=10+i, cache_read_tokens=5, cache_creation_tokens=3, reasoning_tokens=2),
        response=dict(assistant_message=dict(role='assistant', content='output-'+str(i))))
    if i+1<int(sys.argv[2]):
        tool = dict(base, tool_call_id='tool-'+str(i), tool_name='read')
        h['pre_tool_call'](**tool, args=dict(index=i, nested=dict(ok=True)))
        h['post_tool_call'](**tool, result='result-'+str(i), status='error' if i==1 else 'ok')
    history += [dict(role='assistant', content='output-'+str(i)), dict(role='user', content='continue-'+str(i))]
h['post_llm_call'](**base, assistant_response='done')
h['on_session_end'](session_id='fixture-session')
`;
  const result = spawnSync('python3', ['-c', script, path.join(repo, 'assets/plugins/hermes-agent/loongsuite-pilot/__init__.py'), String(calls)], {
    encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.signal));
  return readRecords(path.join(root, 'logs/hermes-agent'));
}

export function claudeProducer(root, calls = 8, now = Date.now()) {
  const stamp = delta => new Date(now + delta).toISOString();
  const transcript = [{ type: 'user', timestamp: stamp(0), promptId: 'fixture-prompt',
    message: { role: 'user', content: 'inspect the synthetic JSON file' } }];
  for (let i = 0; i < calls; i++) {
    const last = i === calls - 1;
    transcript.push({ type: 'assistant', timestamp: stamp(i * 100 + 10), message: {
      id: `response-${i}`, model: 'fixture-model', role: 'assistant',
      content: last ? [{ type: 'text', text: 'done' }]
        : [{ type: 'tool_use', id: `tool-${i}`, name: 'Read', input: { index: i, nested: { ok: true } } }],
      usage: { input_tokens: 100 + i, output_tokens: 10 + i, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      stop_reason: last ? 'end_turn' : 'tool_use',
    } });
    if (!last) transcript.push({ type: 'user', timestamp: stamp(i * 100 + 20), message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: `result-${i}`, is_error: i === 1 }],
    } });
  }
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'native-transcript.jsonl');
  fs.writeFileSync(file, transcript.map(JSON.stringify).join('\n') + '\n');
  const result = spawnSync(process.execPath, [path.join(repo, 'assets/hooks/claude-code-hook-processor.mjs'), 'stop'], {
    input: JSON.stringify({ session_id: 'fixture-session', prompt_id: 'fixture-prompt', transcript_path: file, stop_reason: 'end_turn' }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root }, encoding: 'utf8', timeout: 10000,
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.signal));
  return readRecords(path.join(root, 'logs/claude-code'));
}
