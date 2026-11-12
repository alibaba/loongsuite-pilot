import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plugin = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
const driver = String.raw`
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
root, case = pathlib.Path(sys.argv[2]), sys.argv[3]
base = dict(session_id='s', task_id='t', turn_id='t', model='m', provider='openai')
def emit(name, **kw): hooks[name](**base, **kw)
def read(): return [json.loads(line) for f in root.glob('logs/hermes-agent/*.jsonl') for line in f.read_text().splitlines()]
emit('pre_llm_call', user_message='', conversation_history=[])
if case == 'count': p.MAX_PENDING_INPUT_RECORDS = 1
if case == 'bytes': p.MAX_PENDING_INPUT_BYTES = 1
emit('pre_api_request', api_call_count=1, api_request_id='r1')
turn = p._find_turn(p._SESSIONS['s'], base)
first = next(r for r, _ in turn['pending_records'].values()) if turn['pending_records'] else read()[0]
request_id, request_span, request_time = first['event.id'], first['span_id'], first['time_unix_nano']
if case in ('unfinished', 'exit', 'terminal-text', 'response-history'):
    assert not read()
    if case in ('terminal-text', 'response-history'):
        extra = dict(conversation_history=[dict(role='user', content='previous'), dict(role='assistant', content='old'), dict(role='user', content='current')]) if case == 'response-history' else {}
        emit('post_api_request', api_call_count=1, finish_reason='stop', response=dict(assistant_message=dict(role='assistant', content='done')), **extra)
        if case == 'terminal-text': assert not read()
    if case == 'exit': p._flush_at_exit()
    elif case == 'terminal-text': emit('post_llm_call', user_message='current', assistant_response='done')
    else: emit('post_llm_call')
    rows = read()
    if case in ('terminal-text', 'response-history'):
        assert [r['event.name'] for r in rows] == ['other', 'llm.request', 'llm.response', 'other']
        assert rows[0]['gen_ai.input.messages_delta'][0]['parts'][0]['content'] == 'current'
    else:
        assert [r['event.name'] for r in rows] == ['llm.request', 'other']
    request = next(r for r in rows if r['event.name'] == 'llm.request')
    assert request['event.id'] == request_id and request['span_id'] == request_span
    assert request['time_unix_nano'] == request_time
    assert rows[-1]['gen_ai.turn.end'] is True
    assert not p._SESSIONS.get('s', {}).get('turns')
else:
    emit('post_api_request', api_call_count=1, finish_reason='tool_calls', usage=dict(input_tokens=10, output_tokens=3), response=dict(assistant_message=dict(role='assistant', content='working')))
    emit('pre_tool_call', tool_call_id='c', tool_name='terminal', args=dict(command='echo test'))
    emit('post_tool_call', tool_call_id='c', tool_name='terminal', result='test', status='ok')
    if case in ('count', 'bytes'):
        assert turn['input_resolution_closed'] and not turn['pending_records']
        assert turn['pending_bytes'] == 0
    else:
        assert not read(), 'completed response or tool escaped staging'
    writer, failed = p._write_records, []
    def fail_response(records):
        if records[0]['event.name'] == 'llm.response' and not failed:
            failed.extend(records)
            raise OSError('injected staged response failure')
        writer(records)
    if case == 'retry': p._write_records = fail_response
    emit('pre_api_request', api_call_count=2, conversation_history=[
        dict(role='user', content='previous'), dict(role='assistant', content='previous answer'), dict(role='user', content='current')])
    if case == 'retry':
        assert failed and len(read()) == 2
        assert [r['event.name'] for r in read()] == ['other', 'llm.request']
        assert read()[0]['agent.hermes.hook'] == 'turn_start'
    p._write_records = writer
    emit('post_api_request', api_call_count=2, finish_reason='stop', usage=dict(input_tokens=12, output_tokens=4), response=dict(assistant_message=dict(role='assistant', content='done')))
    emit('post_llm_call', assistant_response='done')
    rows = read()
    if case in ('count', 'bytes'):
        assert not any(r.get('agent.hermes.hook') == 'turn_start' for r in rows)
        assert len({r['trace_id'] for r in rows}) == 1
    else:
        assert rows[0]['agent.hermes.hook'] == 'turn_start'
        response = next(r for r in rows if r['event.name'] == 'llm.response')
        assert response['event.id'] == failed[0]['event.id'] and response['span_id'] == failed[0]['span_id']
    request = next(r for r in rows if r['event.name'] == 'llm.request')
    assert (request['event.id'], request['span_id'], request['time_unix_nano']) == (request_id, request_span, request_time)
    assert [r['event.name'] for r in rows if r['event.name'] != 'other'] == ['llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response']
    assert sum(r.get('gen_ai.usage.input_tokens', 0) for r in rows) == 22
    assert sum(r.get('gen_ai.usage.output_tokens', 0) for r in rows) == 7
    assert len({r['event.id'] for r in rows}) == len(rows)
    assert rows[-1]['gen_ai.turn.end'] is True
`;
it.each(['count', 'bytes', 'unfinished', 'exit', 'retry', 'terminal-text', 'response-history'])('bounds and safely drains Hermes input staging: %s', scenario => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-staging-'));
  try {
    const result = spawnSync('python3', ['-c', driver, plugin, root, scenario], {
      encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.stderr || String(result.signal)).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
