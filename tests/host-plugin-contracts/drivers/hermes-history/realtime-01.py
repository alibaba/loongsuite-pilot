
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
