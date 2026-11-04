import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectTurnStrategyParity } from '../../helpers/turn-strategy-parity.ts';

it('captures the native child factory relation before parallel children start, without changing agent behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-subagent-'));
  try {
    const code = `
import importlib.util, json, types, sys, concurrent.futures, pathlib, time
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
# Native model callbacks after the parent's in-memory state has disappeared.
for child in children:
    base = dict(session_id=child.session_id, turn_id=child.session_id+'-turn', model='synthetic-model', provider='openai')
    hooks['pre_llm_call'](**base, user_message='synthetic child task', conversation_history=[dict(role='user', content='synthetic child task')])
    hooks['pre_api_request'](**base, api_call_count=1, api_request_id=child.session_id+'-request')
    time.sleep(0.002)
    hooks['post_api_request'](**base, api_call_count=1, api_request_id=child.session_id+'-request', finish_reason='stop',
        usage=dict(input_tokens=10, output_tokens=2), response=dict(assistant_message=dict(role='assistant', content='synthetic result')))
    hooks['post_llm_call'](**base, assistant_response='synthetic result')
hooks['pre_llm_call'](session_id='unrelated', turn_id='unrelated-turn')
assert p._find_turn(p._SESSIONS['unrelated'], {'turn_id': 'unrelated-turn'})['trace_id'] != parent['trace_id']
child_events = [json.loads(line) for file in pathlib.Path(sys.argv[2]).glob('logs/hermes-agent/*.jsonl')
    for line in file.read_text().splitlines() if json.loads(line).get('gen_ai.agent.scope') == 'subagent']
print(json.dumps({'records': records, 'trace': parent['trace_id'], 'span': parent['tools']['spawn-a'].get('span_id'), 'childEvents': child_events}))
`;
    const result = spawnSync('python3', ['-c', code, path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py'), root], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HOME: root, LOONGSUITE_PILOT_DATA_DIR: root, LOONGSUITE_USER_ID: '', LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { records, trace, span, childEvents } = JSON.parse(result.stdout);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(records.map(r => r['gen_ai.session.id'])).toEqual(['child-0', 'child-1']);
    expect(records.every(r => r.trace_id === trace && r.parent_span_id === span && r['user.id'] === 'user-a')).toBe(true);
    const parity = await expectTurnStrategyParity(childEvents, 'hermes-native-late-parallel-subagents');
    expect(parity.currentKinds.LLM).toBe(2);
    expect(parity.currentKinds.AGENT).toBe(2);
    expect(parity.currentKinds.ENTRY).toBeUndefined();
    expect(parity.decisions.every(choice => choice.streamed)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
