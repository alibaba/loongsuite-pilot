import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('audits native batch work, nested incoming, actual sync/async delivery and autonomous session reuse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-audit-'));
  try {
    const code = `
import importlib.util, json, types, sys, pathlib, concurrent.futures, contextvars, asyncio
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
cli_module = types.ModuleType('hermes_cli.cli_chat_turn_mixin')
class CLIChatTurnMixin:
    def _chat_stage_user_message(self, agent, message):
        # Native CLI stages the row, then calls str(notification) before the
        # agent thread. The original object never reaches pre_llm_call.
        agent._pending_cli_user_message = {'role':'user','content':str(message)}
native_loop = types.ModuleType('agent.conversation_loop')
def run_conversation(agent, user_message):
    plain = user_message.encode('utf-8', 'replace').decode('utf-8')
    # Hooks execute in isolated copy_context workers in current Hermes.
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        pool.submit(contextvars.copy_context().run, hooks['pre_llm_call'],
                    session_id=agent.session_id, turn_id='later-parent-turn', user_message=plain).result()
    return {'final_response':'native return'}
native_loop.run_conversation = run_conversation
ingress = types.ModuleType('gateway.session_ingress')
ledger = types.ModuleType('tools.async_delegation')
ledger.get_durable_delegation = lambda id: {'state':'completed','result':{'results':[{'task_index':0,'status':'completed','summary':'gateway delivered result'}]}} if id == 'native-gateway' else None
async def execute_admission(authority, ref, row):
    if row.get('skip'): return 'not consumed'
    return await asyncio.to_thread(native_loop.run_conversation, types.SimpleNamespace(session_id=ref.session_id), 'native formatted result')
ingress.execute_admission = execute_admission
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
sys.modules.update({'tools':tools,'tools.delegate_tool':delegate,'tools.process_registry_notifications':notifications,
                    'hermes_cli.cli_chat_turn_mixin':cli_module,'agent.conversation_loop':native_loop,
                    'gateway.session_ingress':ingress,'tools.async_delegation':ledger})
p.register(types.SimpleNamespace(register_hook=lambda n, cb: hooks.update({n:cb})))
# Native plugin discovery can occur while this CLI module is still importing.
cli_module.CLIChatTurnMixin = CLIChatTurnMixin
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
agent = types.SimpleNamespace(session_id='parent')
cli = CLIChatTurnMixin()
# Formatting/staging is not delivery: no result until the native run consumes it.
cli._chat_stage_user_message(agent, delivery)
assert not any(json.loads(line).get('gen_ai.output.messages', [{}])[0].get('parts', [{}])[0].get('content') == 'late delivered result'
               for f in (pathlib.Path(sys.argv[2])/'logs/hermes-agent').glob('*.jsonl') for line in f.read_text().splitlines())
# Staging another input, or replacing the staged row, invalidates an old
# notification. A matching-looking ordinary string is never delivery proof.
cli._chat_stage_user_message(agent, str(delivery))
native_loop.run_conversation(agent, str(delivery))
cli._chat_stage_user_message(agent, delivery)
agent._pending_cli_user_message = dict(agent._pending_cli_user_message)
native_loop.run_conversation(agent, str(delivery))
assert sum(json.loads(line).get('event.name') == 'gen_ai.agent.result'
           for f in (pathlib.Path(sys.argv[2])/'logs/hermes-agent').glob('*.jsonl') for line in f.read_text().splitlines()) == 2
cli._chat_stage_user_message(agent, delivery)
assert native_loop.run_conversation(agent, str(delivery)) == {'final_response':'native return'}
cli._chat_stage_user_message(agent, delivery)
native_loop.run_conversation(agent, str(delivery))
hooks['pre_llm_call'](session_id='parent', turn_id='gateway-dispatch-turn')
hooks['pre_tool_call'](session_id='parent', turn_id='gateway-dispatch-turn', tool_name='delegate_task', tool_call_id='gateway', args={'goal':'gateway async task'})
hooks['post_tool_call'](session_id='parent', turn_id='gateway-dispatch-turn', tool_name='delegate_task', tool_call_id='gateway', result={'status':'dispatched','delegation_id':'native-gateway'})
p._SESSIONS.clear()
authority = types.SimpleNamespace(physical_target=lambda ref: ref.session_id)
ref = types.SimpleNamespace(session_id='parent')
admission = {'payload':{'local_automation_v1':{'identity':json.dumps(['async_delegation','native-gateway',''])}}}
assert asyncio.run(ingress.execute_admission(authority, ref, dict(admission, skip=True))) == 'not consumed'
# Native Gateway admission is structured; an ordinary lookalike prompt cannot
# establish consumption, and the wrong receiver cannot adopt this work.
native_loop.run_conversation(agent, 'native formatted result')
asyncio.run(ingress.execute_admission(authority, types.SimpleNamespace(session_id='other-parent'), admission))
assert sum(json.loads(line).get('event.name') == 'gen_ai.agent.result'
           for f in (pathlib.Path(sys.argv[2])/'logs/hermes-agent').glob('*.jsonl') for line in f.read_text().splitlines()) == 3
assert asyncio.run(ingress.execute_admission(authority, ref, admission)) == {'final_response':'native return'}
asyncio.run(ingress.execute_admission(authority, ref, admission))
assert p._GATEWAY_DELIVERY.get() is None
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
    expect(invokes).toHaveLength(5); // batch tasks, nested work, CLI and Gateway async work
    expect(invokes[0]['gen_ai.input.messages'][0].parts[0].content).toContain('shared context');
    expect(invokes[0]['gen_ai.input.messages'][0].parts[0].content).toContain('first-only context');
    expect(invokes[1]['gen_ai.input.messages'][0].parts[0].content).not.toContain('first-only context');
    expect(new Set(invokes.map(r => r['gen_ai.agent.invocation.id'])).size).toBe(5);
    expect(children.map(r => r['gen_ai.agent.parent.invocation.id'])).toEqual(invokes.slice(0, 2).map(r => r['gen_ai.agent.invocation.id']));
    const nested = invokes.find(r => r['gen_ai.session.id'] === 'child-0');
    expect(nested['gen_ai.agent.parent.invocation.id']).toBe(children[0]['gen_ai.agent.parent.invocation.id']);
    expect(results).toHaveLength(4);
    const late = results.find(r => r['gen_ai.output.messages']?.[0].parts[0].content === 'late delivered result');
    expect(late['gen_ai.output.messages'][0].parts[0].content).toBe('late delivered result');
    expect(late['gen_ai.agent.invocation.id']).toBe(invokes.at(-2)['gen_ai.agent.invocation.id']);
    const gateway = results.find(r => r['gen_ai.output.messages']?.[0].parts[0].content === 'gateway delivered result');
    expect(gateway['gen_ai.agent.invocation.id']).toBe(invokes.at(-1)['gen_ai.agent.invocation.id']);
    expect(gateway['gen_ai.turn.id']).toBe('later-parent-turn');
    expect(results.every(r => !r.span_id && !r['gen_ai.step.id'])).toBe(true);
    expect(new Set(rows.map(r => r['event.id'])).size).toBe(rows.length);
    const contextFiles = fs.readdirSync(path.join(root, 'subagent-contexts/hermes'));
    expect(contextFiles.map(n => fs.readFileSync(path.join(root, 'subagent-contexts/hermes', n), 'utf8')).join('')).not.toContain('task one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
