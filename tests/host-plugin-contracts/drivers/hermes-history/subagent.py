
import importlib.util, json, types, sys, concurrent.futures
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
tools = types.ModuleType('tools')
delegate = types.ModuleType('tools.delegate_tool')
def build_child(task_index, goal, context, toolsets, model, max_iterations, task_count, parent_agent):
    if goal == 'raise': raise ValueError('native failure')
    return types.SimpleNamespace(session_id='child-' + str(task_index))
delegate._build_child_agent = build_child
tools.delegate_tool = delegate
sys.modules['tools'] = tools
sys.modules['tools.delegate_tool'] = delegate
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda n, cb: hooks.update({n: cb})))
hooks['pre_llm_call'](session_id='parent', turn_id='parent-turn', sender_id='user-a')
hooks['pre_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='spawn-a')
parent = p._find_turn(p._SESSIONS['parent'], {'turn_id': 'parent-turn'})
# A later overlapping turn and foreground finalize must not lose the exact parent.
hooks['pre_llm_call'](session_id='parent', turn_id='background-turn', sender_id='user-b')
hooks['on_session_finalize'](session_id='parent')
children = [delegate._build_child_agent(i, '', None, [], None, 2, 2, types.SimpleNamespace(session_id='parent')) for i in range(2)]
try:
    delegate._build_child_agent(9, 'raise', None, [], None, 2, 2, types.SimpleNamespace(session_id='parent'))
    raise AssertionError('native exception swallowed')
except ValueError: pass
# Simulate parent completion and state eviction before children run.
hooks['post_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='spawn-a', result={})
p._SESSIONS.clear()
def run(child):
    hooks['pre_llm_call'](session_id=child.session_id, turn_id=child.session_id+'-turn')
    turn = p._find_turn(p._SESSIONS[child.session_id], {'turn_id': child.session_id+'-turn'})
    return p._common_fields(turn, p._SESSIONS[child.session_id], 'other', 123, 's1', '1111111111111111')
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    records = list(pool.map(run, children))
hooks['pre_llm_call'](session_id='unrelated', turn_id='unrelated-turn')
assert p._find_turn(p._SESSIONS['unrelated'], {'turn_id': 'unrelated-turn'})['trace_id'] != parent['trace_id']
print(json.dumps({'records': records, 'trace': parent['trace_id'], 'span': parent['tools']['spawn-a'].get('span_id')}))
