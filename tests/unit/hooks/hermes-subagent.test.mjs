import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('captures the native child factory relation before parallel children start, without changing agent behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-subagent-'));
  try {
    const code = `
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
parent = p._SESSIONS['parent']['current_turn']
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
    turn = p._SESSIONS[child.session_id]['current_turn']
    return p._common_fields(turn, p._SESSIONS[child.session_id], 'other', 123, 's1', '1111111111111111')
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    records = list(pool.map(run, children))
hooks['pre_llm_call'](session_id='unrelated', turn_id='unrelated-turn')
assert p._SESSIONS['unrelated']['current_turn']['trace_id'] != parent['trace_id']
print(json.dumps({'records': records, 'trace': parent['trace_id'], 'span': parent['tools']['spawn-a'].get('span_id')}))
`;
    const result = spawnSync('python3', ['-c', code, path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py')], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HOME: root, LOONGSUITE_PILOT_DATA_DIR: root, LOONGSUITE_USER_ID: '', LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { records, trace, span } = JSON.parse(result.stdout);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(records.map(r => r['gen_ai.session.id'])).toEqual(['child-0', 'child-1']);
    expect(records.every(r => r.trace_id === trace && r.parent_span_id === span && r['user.id'] === 'user-a')).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
