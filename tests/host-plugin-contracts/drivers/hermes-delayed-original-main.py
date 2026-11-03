
import importlib.util, json, pathlib, sys, types
plugin, fixture, root, stage, initial = sys.argv[1:]
spec = importlib.util.spec_from_file_location('pilot', plugin)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
events = [json.loads(line) for line in pathlib.Path(fixture).read_text().splitlines()]
full = next(e['payload']['conversation_history'] for e in events if e['hook'] == 'post_llm_call')
prior = [dict(role='user', content='Previous prompt'), dict(role='assistant', content='Previous answer')]
def read():
    return [json.loads(line) for f in pathlib.Path(root).glob('logs/hermes-agent/*.jsonl') for line in f.read_text().splitlines()]
clock = p.time.time_ns()
batches, seen = [], 0
for e in events:
    payload = dict(e['payload'])
    if e['hook'] == 'pre_llm_call':
        payload['user_message'] = ''
        payload['conversation_history'] = []
        if initial == 'missing': payload.pop('conversation_history')
    if e['hook'] == 'post_api_request':
        assistant = [m for m in full if m['role'] == 'assistant'][payload['api_call_count'] - 1]
        payload['response'] = dict(assistant_message=assistant)
    boundary = (stage == 'request' and e['hook'] == 'pre_api_request' and payload.get('api_call_count') == 2) or (stage == 'terminal' and e['hook'] == 'post_llm_call')
    if boundary:
        assert not read(), 'request/response/tool escaped before input was known'
    if e['hook'] == 'pre_api_request' and payload.get('api_call_count') == 2 and stage == 'request':
        payload['conversation_history'] = prior + full[:-1]
    if e['hook'] == 'post_llm_call': payload['conversation_history'] = prior + full
    # One poll every 15 source seconds, including after request, response and tool.
    clock += 15_000_000_000
    p.time.time_ns = lambda: clock
    hooks[e['hook']](**payload)
    records = read()
    batches.append(records[seen:])
    seen = len(records)
pathlib.Path(root, 'batches.json').write_text(json.dumps(batches))
