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
assert len(first) == 1 and first[0]['event.name'] == 'llm.request'
assert first[0]['gen_ai.request.id'] == 'request1'
assert first[0]['gen_ai.session.id'] == 's1'
assert 'gen_ai.output.messages' not in first[0]
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
  it('publishes request/tool IDs before completion, pairs responses, and retries final writes without duplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-realtime-'));
    try {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agents: { 'hermes-agent': { enabled: true, captureMessageContent: true } }, collectTrace: true }));
      const result = spawnSync('python3', ['-c', driver, plugin], { encoding: 'utf8', env: { ...process.env, HOME: root, LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' } });
      expect(result.status, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.before_api).toEqual([]); // pre_llm_call is not a request boundary.
      expect(out.after_response.map(r => r['event.name'])).toEqual(['llm.request', 'llm.response']);
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
      const postOnly = turn.filter(r => r['gen_ai.tool.call.id'] === 'post-only');
      expect(postOnly.map(r => r['event.name'])).toEqual(['tool.call', 'tool.result']);
      expect(postOnly[0].span_id).toBe(postOnly[1].span_id);
      expect(new Set(out.retry_final.map(r => r['event.id'])).size).toBe(out.retry_final.length);
      expect(out.retained).toBe(1);
      const unfinished = out.retry_final.filter(r => r['gen_ai.turn.id'] === 'turn2');
      expect(unfinished.map(r => r['event.name'])).toEqual(['llm.request', 'other']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
