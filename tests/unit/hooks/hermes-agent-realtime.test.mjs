import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../../../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py', import.meta.url));

// Read through another process while the producer still holds an active turn.
// No event-time sorting: these assertions exercise actual append visibility.
const driver = String.raw`
import importlib.util, json, os, pathlib, subprocess, sys
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
class Context:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
c = Context()
p.register(c)
def emit(hook, **kw): c.hooks[hook](**kw)
def read():
    code = "import pathlib,json,sys; print(json.dumps([json.loads(l) for f in pathlib.Path(sys.argv[1]).glob('logs/hermes-agent/*.jsonl') for l in f.read_text().splitlines()]))"
    return json.loads(subprocess.check_output([sys.executable, '-c', code, os.environ['LOONGSUITE_PILOT_DATA_DIR']]))
base = dict(session_id='s1', task_id='turn1', turn_id='turn1', model='test-model', provider='openai', platform='cli')
emit('pre_llm_call', **base, sender_id='im-user', user_message='hello', conversation_history=[dict(role='user', content='hello')])
before_api = read()
emit('pre_api_request', **base, api_call_count=1, api_request_id='request1')
first = read()
assert [r['event.name'] for r in first] == ['other', 'llm.request']
assert first[0]['agent.hermes.hook'] == 'turn_start'
assert first[0]['gen_ai.input.messages_delta'] == [dict(role='user', parts=[dict(type='text', content='hello')])]
assert first[0]['gen_ai.turn.id'] == 'turn1'
assert first[0]['time_unix_nano'] == first[1]['time_unix_nano']
assert first[1]['gen_ai.request.id'] == 'request1'
assert first[1]['gen_ai.session.id'] == 's1'
assert 'gen_ai.output.messages' not in first[1]
emit('post_api_request', **base, api_call_count=1, api_request_id='request1', finish_reason='tool_calls', usage=dict(input_tokens=10, output_tokens=3), response=dict(assistant_message=dict(role='assistant', content='', tool_calls=[dict(id='tool1', type='function', function=dict(name='terminal', arguments='{}'))])))
after_response = read()
emit('pre_tool_call', **base, tool_call_id='tool1', tool_name='terminal', args=dict(command='echo hi'))
after_call = read()
emit('post_tool_call', **base, tool_call_id='tool1', tool_name='terminal', result='hi', status='ok')
after_result = read()
# Missing pre-tool hook plus a partial write failure must retain the allocated
# tool identity when a later hook retries the result.
original_writer = p._write_records
def fail_result(records):
    if records[0]['event.name'] == 'tool.result': raise OSError('injected result failure')
    original_writer(records)
p._write_records = fail_result
emit('post_tool_call', **base, tool_call_id='post-only', tool_name='terminal', result='recovered', status='ok')
p._write_records = original_writer
emit('post_tool_call', **base, tool_call_id='post-only', tool_name='terminal', result='recovered', status='ok')
# Another session can append between calls; consumers must match request/session.
other = dict(base, session_id='s2', task_id='turn2', turn_id='turn2')
emit('pre_api_request', **other, api_call_count=1, api_request_id='other-request')
emit('pre_api_request', **base, api_call_count=2, api_request_id='request2')
second = read()
emit('api_request_error', **base, api_call_count=2, api_request_id='request2', error=dict(type='RateLimitError', message='retry'), retryable=True)
emit('pre_api_request', **base, api_call_count=3, api_request_id='request3')
emit('post_api_request', **base, api_call_count=3, api_request_id='request3', finish_reason='stop', usage=dict(input_tokens=12, output_tokens=2), response=dict(assistant_message=dict(role='assistant', content='done')))
before_end = read()
emit('post_llm_call', **base, assistant_response='done')
emit('on_session_end', session_id='s1')
final = read()
# A failed append at completion must not discard the turn. Retry its lifecycle.
original = p._write_records
def fail(records): raise OSError('injected write failure')
p._write_records = fail
emit('post_llm_call', **other)
retained = len(p._SESSIONS['s2']['turns'])
p._write_records = original
emit('post_llm_call', **other)
retry_final = read()
print(json.dumps(dict(before_api=before_api, first=first, after_response=after_response, after_call=after_call, after_result=after_result, second=second, before_end=before_end, final=final, retained=retained, retry_final=retry_final)))
`;

describe('Hermes request-boundary JSONL visibility', () => {
  it('keeps missing input retryable and excludes earlier-turn history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-empty-input-'));
    try {
      const scenario = String.raw`
import hashlib, importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
base = dict(session_id='s', task_id='t', turn_id='t', model='m', provider='openai')
# History ends at the preceding assistant: there is no current user input yet.
hooks['pre_llm_call'](**base, user_message='', conversation_history=[
    dict(role='user', content='previous turn'), dict(role='assistant', content='previous answer')])
hooks['pre_api_request'](**base, api_call_count=1)
turn = p._find_turn(p._SESSIONS['s'], base)
assert ('other', None, None) not in turn['emitted']
assert not turn.get('input_content_hash')
# The later native request supplies the real current user content in text blocks.
current = [dict(role='user', content='previous turn'),
           dict(role='assistant', content='previous answer'),
           dict(role='user', content=[dict(type='text', text='current '), dict(type='input_text', text='prompt')])]
hooks['pre_api_request'](**base, api_call_count=2, conversation_history=current)
hooks['pre_api_request'](**base, api_call_count=3)
records = [json.loads(line) for f in pathlib.Path(sys.argv[2]).glob('logs/hermes-agent/*.jsonl')
           for line in f.read_text().splitlines()]
inputs = [r for r in records if r.get('agent.hermes.hook') == 'turn_start']
assert len(inputs) == 1
assert inputs[0]['gen_ai.input.messages_delta'][0]['parts'][0]['content'] == 'current prompt'
assert inputs[0]['agent.pilot.correlation.content_hash'] == hashlib.sha256(b'current prompt').hexdigest()[:16]
assert [r['event.name'] for r in records] == ['llm.request', 'other', 'llm.request', 'llm.request']
assert all(r['gen_ai.turn.id'] == 't' for r in records)
`;
      const result = spawnSync('python3', ['-c', scenario, plugin, root], {
        encoding: 'utf8', env: {
          ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      expect(result.status, result.stderr || String(result.signal)).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('retries the turn input before the request without changing its identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-input-retry-'));
    try {
      const scenario = String.raw`
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
base = dict(session_id='s', task_id='t', turn_id='t', model='m', provider='openai')
hooks['pre_llm_call'](**base, user_message='hello')
failed = []
writer = p._write_records
def fail_input(records):
    failed.extend(records)
    raise OSError('injected input write failure')
p._write_records = fail_input
hooks['pre_api_request'](**base, api_call_count=1, api_request_id='request')
assert len(failed) == 1 and failed[0]['agent.hermes.hook'] == 'turn_start'
assert not p._find_turn(p._SESSIONS['s'], base)['emitted']
p._write_records = writer
hooks['post_api_request'](**base, api_call_count=1, api_request_id='request', finish_reason='stop',
    response=dict(assistant_message=dict(role='assistant', content='ok')))
hooks['post_llm_call'](**base)
hooks['on_session_finalize'](session_id='s')
records = [json.loads(line) for f in pathlib.Path(sys.argv[2]).glob('logs/hermes-agent/*.jsonl')
    for line in f.read_text().splitlines()]
assert [r['event.name'] for r in records] == ['other', 'llm.request', 'llm.response', 'other']
assert records[0]['event.id'] == failed[0]['event.id']
assert records[0]['span_id'] == failed[0]['span_id']
assert records[-1]['gen_ai.turn.end'] is True
`;
      const result = spawnSync('python3', ['-c', scenario, plugin, root], {
        encoding: 'utf8', env: {
          ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      expect(result.status, result.stderr).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('bounds failed evictions, keeps the current request active, and retries detached turns at exit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-eviction-'));
    try {
      const scenario = String.raw`
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.MAX_ACTIVE_TURNS = 2
p._report_internal_error = lambda *args: None
writer = p._write_records
def emit(i):
    p._safe_callback('pre_api_request')(session_id='bounded', task_id='t'+str(i), turn_id='t'+str(i), api_request_id='r'+str(i))
emit(0)
emit(1)
def fail(records): raise OSError('unwritable directory')
p._write_records = fail
for i in range(2, 8):
    emit(i)
    assert len(p._SESSIONS['bounded']['turns']) <= 2, 'active turns exceeded bound'
    assert len(p._EVICTED_TURNS) <= 2, 'retry turns exceeded bound'
    current = next(t for t in p._SESSIONS['bounded']['turns'].values() if t['observer_turn_id'] == 't'+str(i))
    assert len(current['apis']) == 1, 'failed eviction aborted the new request'
state = p._SESSIONS['bounded']
active = next(iter(state['turns'].values()))
identity = active['trace_id'], active['apis'][0]['span_id']
p._write_records = writer
# The previously oldest active request must not be closed by its own hook.
emit(6)
assert active in state['turns'].values()
assert active['trace_id'] == identity[0] and active['apis'][0]['span_id'] == identity[1]
p._flush_at_exit()
p._flush_at_exit()
records = [json.loads(line) for f in pathlib.Path(os.environ['LOONGSUITE_PILOT_DATA_DIR']).glob('logs/hermes-agent/*.jsonl') for line in f.read_text().splitlines()]
terminal = [r for r in records if r.get('gen_ai.turn.end')]
assert sorted(r['gen_ai.turn.id'] for r in terminal) == ['t4','t5','t6','t7']
assert len({r['event.id'] for r in records}) == len(records)
assert not p._EVICTED_TURNS and not p._SESSIONS
# Session eviction uses the same globally bounded retry area and must not keep
# the evicted session's other active turns reachable through each snapshot.
p.MAX_SESSIONS = 2
p._write_records = fail
for i in range(8):
    p._safe_callback('pre_api_request')(session_id='s'+str(i), turn_id='s'+str(i), api_request_id='sr'+str(i))
    assert len(p._SESSIONS) <= 2 and len(p._EVICTED_TURNS) <= 2
assert all(len(snapshot['turns']) == 1 for snapshot, turn in p._EVICTED_TURNS.values())
p._write_records = writer
p._flush_at_exit()
assert not p._EVICTED_TURNS and not p._SESSIONS
print(json.dumps({'terminal': len(terminal)}))
`;
      const result = spawnSync('python3', ['-c', scenario, plugin], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'), PYTHONDONTWRITEBYTECODE: '1' } });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).terminal).toBe(4);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('publishes request/tool IDs before completion, pairs responses, and retries final writes without duplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-realtime-'));
    try {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agents: { 'hermes-agent': { enabled: true, captureMessageContent: true } }, collectTrace: true }));
      const result = spawnSync('python3', ['-c', driver, plugin], { encoding: 'utf8', env: { ...process.env, HOME: root, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' } });
      expect(result.status, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.before_api).toEqual([]); // pre_llm_call is not a request boundary.
      expect(out.after_response.map(r => r['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
      expect(out.after_call.at(-1)['event.name']).toBe('tool.call');
      expect(out.after_result.at(-1)['event.name']).toBe('tool.result');
      expect(out.second.at(-1)['gen_ai.request.id']).toBe('request2');
      expect(out.before_end.some(r => r['gen_ai.turn.end'])).toBe(false);
      const turn = out.final.filter(r => r['gen_ai.turn.id'] === 'turn1');
      const requests = turn.filter(r => r['event.name'] === 'llm.request');
      const responses = turn.filter(r => r['event.name'] === 'llm.response');
      expect(requests).toHaveLength(3);
      expect(responses).toHaveLength(3);
      expect(new Set(requests.map(r => r.span_id)).size).toBe(3);
      for (const request of requests) {
        expect(request.trace_id).toMatch(/^[0-9a-f]{32}$/);
        expect(request.trace_id).not.toBe('0'.repeat(32));
        expect(request.span_id).toMatch(/^[0-9a-f]{16}$/);
        expect(request.span_id).not.toBe('0'.repeat(16));
        const response = responses.find(r => r['gen_ai.response.id'] === request['gen_ai.response.id']);
        expect(response.span_id).toBe(request.span_id);
        expect(response.trace_id).toBe(request.trace_id);
      }
      expect(turn.filter(r => r['gen_ai.turn.end'])).toHaveLength(1);
      expect(turn.filter(r => r['agent.hermes.hook'] === 'turn_start')).toHaveLength(1);
      const postOnly = turn.filter(r => r['gen_ai.tool.call.id'] === 'post-only');
      expect(postOnly.map(r => r['event.name'])).toEqual(['tool.call', 'tool.result']);
      expect(postOnly[0].span_id).toBe(postOnly[1].span_id);
      expect(new Set(out.retry_final.map(r => r['event.id'])).size).toBe(out.retry_final.length);
      expect(out.retained).toBe(1);
      const unfinished = out.retry_final.filter(r => r['gen_ai.turn.id'] === 'turn2');
      expect(unfinished.map(r => r['event.name'])).toEqual(['other', 'llm.request', 'other']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
