
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
assert not list(pathlib.Path(sys.argv[2]).glob('logs/hermes-agent/*.jsonl'))
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
assert [r['event.name'] for r in records] == ['other', 'llm.request', 'llm.request', 'llm.request']
assert all(r['gen_ai.turn.id'] == 't' for r in records)
