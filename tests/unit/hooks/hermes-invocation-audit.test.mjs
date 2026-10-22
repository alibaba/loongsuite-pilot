import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('audits native batch work, nested incoming, actual sync/async delivery and autonomous session reuse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-audit-'));
  try {
    const code = `
import importlib.util, json, types, sys, pathlib, concurrent.futures
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
tools = types.ModuleType('tools')
delegate = types.ModuleType('tools.delegate_tool')
notifications = types.ModuleType('tools.process_registry_notifications')
class Notification(str):
    @classmethod
    def for_delegation(cls, text, event): return cls(text)
notifications.TimelineNotification = Notification
def build_child(task_index, goal, context, toolsets, model, max_iterations, task_count, parent_agent):
    if goal == 'raise': raise ValueError('native failure')
    return types.SimpleNamespace(session_id='child-' + str(task_index))
hooks = {}
def run_child(task_index, goal, child=None, parent_agent=None):
    hooks['pre_llm_call'](session_id=child.session_id, turn_id=child.session_id+'-turn')
    turn = p._find_turn(p._SESSIONS[child.session_id], {'turn_id': child.session_id+'-turn'})
    fields = p._common_fields(turn, p._SESSIONS[child.session_id], 'tool.call', 123, 'step', '1111111111111111')
    if task_index == 0:
        hooks['pre_tool_call'](session_id=child.session_id, turn_id=child.session_id+'-turn', tool_name='delegate_task', tool_call_id='nested', args={'goal':'nested task'})
    return fields
delegate._build_child_agent = build_child
delegate._run_single_child = run_child
tools.delegate_tool = delegate
sys.modules.update({'tools':tools,'tools.delegate_tool':delegate,'tools.process_registry_notifications':notifications})
p.register(types.SimpleNamespace(register_hook=lambda n, cb: hooks.update({n:cb})))
hooks['pre_llm_call'](session_id='parent', turn_id='parent-turn', sender_id='user-a')
args = {'context':'shared context', 'tasks':[{'goal':'task one','context':'first-only context'},{'goal':'task two'}]}
hooks['pre_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='batch', args=args)
p._ACTIVE_DELEGATION.set(None) # Native isolated hook workers do not propagate callback writes.
children = [delegate._build_child_agent(i, 'task', None, [], None, 2, 2, types.SimpleNamespace(session_id='parent', _current_turn_id='parent-turn')) for i in range(2)]
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    fields = list(pool.map(lambda i: delegate._run_single_child(i, '', children[i]), range(2)))
hooks['post_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='batch', result={'results':[
    {'task_index':1,'status':'error','summary':None,'error':'failure'},
    {'task_index':0,'status':'ok','summary':'delivered sync result'}]})
# Replaying the same result must not create another logical result.
hooks['post_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='batch', result={'results':[
    {'task_index':0,'status':'ok','summary':'delivered sync result'}]})
hooks['pre_llm_call'](session_id='child-0', turn_id='autonomous-turn')
autonomous = p._find_turn(p._SESSIONS['child-0'], {'turn_id':'autonomous-turn'})
assert 'gen_ai.agent.parent.invocation.id' not in p._common_fields(autonomous,p._SESSIONS['child-0'],'other',123,'','')
hooks['pre_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='async', args={'goal':'async task'})
hooks['post_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='async', result={'status':'dispatched','delegation_id':'native-async'})
hooks['pre_tool_call'](session_id='parent', turn_id='parent-turn', tool_name='delegate_task', tool_call_id='poll', args={'action':'list'})
# Simulate collector/process state loss. Metadata on disk retains the binding.
p._SESSIONS.clear()
delivery = Notification.for_delegation('native formatted result',{'type':'async_delegation','delegation_id':'native-async','parent_session_id':'parent','results':[{'task_index':0,'status':'completed','summary':'late delivered result'}]})
hooks['pre_llm_call'](session_id='parent',turn_id='later-parent-turn',user_message=delivery)
hooks['pre_llm_call'](session_id='parent',turn_id='later-parent-turn',user_message=delivery)
rows = [json.loads(line) for f in (pathlib.Path(sys.argv[2])/'logs/hermes-agent').glob('*.jsonl') for line in f.read_text().splitlines()]
print(json.dumps({'rows':rows,'children':fields}))
`;
    const result = spawnSync('python3', ['-c', code, path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py'), root], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', LOONGSUITE_PILOT_DATA_DIR: root,
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', LOONGSUITE_USER_ID: '', LOONGSUITE_PILOT_USER_ID: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { rows, children } = JSON.parse(result.stdout);
    const invokes = rows.filter(r => r['event.name'] === 'gen_ai.agent.invoke');
    const results = rows.filter(r => r['event.name'] === 'gen_ai.agent.result');
    expect(invokes).toHaveLength(4); // two batch tasks, nested task, new async task; polling is excluded
    expect(invokes[0]['gen_ai.input.messages'][0].parts[0].content).toContain('shared context');
    expect(invokes[0]['gen_ai.input.messages'][0].parts[0].content).toContain('first-only context');
    expect(invokes[1]['gen_ai.input.messages'][0].parts[0].content).not.toContain('first-only context');
    expect(new Set(invokes.map(r => r['gen_ai.agent.invocation.id'])).size).toBe(4);
    expect(children.map(r => r['gen_ai.agent.parent.invocation.id'])).toEqual(invokes.slice(0, 2).map(r => r['gen_ai.agent.invocation.id']));
    const nested = invokes.find(r => r['gen_ai.session.id'] === 'child-0');
    expect(nested['gen_ai.agent.parent.invocation.id']).toBe(children[0]['gen_ai.agent.parent.invocation.id']);
    expect(results).toHaveLength(3);
    const late = results.find(r => r['gen_ai.turn.id'] === 'later-parent-turn');
    expect(late['gen_ai.output.messages'][0].parts[0].content).toBe('late delivered result');
    expect(late['gen_ai.agent.invocation.id']).toBe(invokes.at(-1)['gen_ai.agent.invocation.id']);
    expect(results.every(r => !r.span_id && !r['gen_ai.step.id'])).toBe(true);
    expect(new Set(rows.map(r => r['event.id'])).size).toBe(rows.length);
    const contextFiles = fs.readdirSync(path.join(root, 'subagent-contexts/hermes'));
    expect(contextFiles.map(n => fs.readFileSync(path.join(root, 'subagent-contexts/hermes', n), 'utf8')).join('')).not.toContain('task one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
