import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup, qoderWakeupRoot } from '../../../assets/hooks/qoder/hook-wakeup.mjs';
import { qoderTaskNotification, QoderSubagentLinks } from '../../../assets/hooks/qoder/subagent-links.mjs';

const session = 'synthetic-session';
const epoch = Date.now() - 10_000;
const user = (id, call) => ({ type: 'user', uuid: id, timestamp: new Date(epoch).toISOString(),
  entrypoint: 'cli', message: { role: 'user', content: id },
  ...(call ? { isDelegatedTask: true, agentId: 'child', parent_tool_use_id: call } : {}) });
const model = (name, content, terminal = 'end_turn') => ({ type: 'assistant', timestamp: new Date(epoch + 100).toISOString(),
  entrypoint: 'cli', message: { id: name, model: 'synthetic-model', content, stop_reason: terminal } });
const end = [{ type: 'last-prompt' }];
let root, parent, child, collector, state, clock;
async function write(file, rows) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
function wake(id, event) { return publishQoderWakeup({ session_id: session, transcript_path: parent,
  hook_event_name: event, cwd: root, ...(id ? { agent_id: id, agent_type: 'reader' } : {}) }, { dataDir: root, agentId: 'qoder' }); }
async function collect() { const batch = await collector.collect(state); state = batch.state; return batch; }
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-child-boundary-')));
  parent = path.join(root, `${session}.jsonl`); child = path.join(root, session, 'subagents/agent-child.jsonl');
  clock = Date.now(); state = {};
  collector = new QoderTranscriptCollector({ dataDir: root, agentId: 'qoder', now: () => clock, stableMs: 0, settleMs: 0 });
});
afterEach(async () => { collector.stop(); await fs.rm(root, { recursive: true, force: true }); });

describe('Qoder native delegation boundaries', () => {
  it('discovers files before creation without copying the parent session into an invented child session', async () => {
    expect(wake('child', 'SubagentStart')).toBe(true);
    const directories = await fs.readdir(qoderWakeupRoot(root, 'qoder'));
    expect(directories).toHaveLength(2); // child plus still-running parent discovery
    const sources = await Promise.all(directories.map(id => fs.readFile(path.join(qoderWakeupRoot(root, 'qoder'), id, 'source.json'), 'utf8').then(JSON.parse)));
    const source = sources.find(value => value.subagentId === 'child');
    expect(source.sessionId).toBe(session);
    expect(source.transcriptPath).toBe(child);
    expect(sources.some(value => value.transcriptPath === parent)).toBe(true);
    expect(wake('../escape', 'SubagentStart')).toBe(false);
  });

  it('publishes invoke while the parent still runs, then closes the child only from its own native terminal', async () => {
    await write(parent, [user('parent'), model('dispatch', [{ type: 'tool_use', id: 'delegate', name: 'Agent', input: { prompt: 'child task' } }], 'tool_use')]);
    expect(wake('child', 'SubagentStart')).toBe(true);
    await write(child, [user('work', 'delegate'), model('child-result', [{ type: 'text', text: 'child output' }]), ...end]);
    const records = [];
    for (let i = 0; i < 4; i++) records.push(...(await collect()).records);
    expect(records.filter(row => row['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(1);
    expect(records.filter(row => row['gen_ai.agent.id'] === session && row['event.name'] === 'llm.response')).toHaveLength(0);
    expect(records.filter(row => row['gen_ai.agent.id'] === 'child' && row['event.name'] === 'llm.response')).toHaveLength(1);
    const invocation = records.find(row => row['event.name'] === 'gen_ai.agent.invoke')['gen_ai.agent.invocation.id'];
    expect(records.filter(row => row['gen_ai.agent.id'] === 'child').every(row => row['gen_ai.agent.parent.invocation.id'] === invocation)).toBe(true);
    expect((await collect()).metrics.bytesRead).toBe(0);
  });

  it('bounds missing-parent waiting, retains child execution, and never invents a relation', async () => {
    await write(child, [user('work', 'absent-parent-call'), model('child-result', [{ type: 'text', text: 'child output' }]), ...end]);
    wake('child', 'SubagentStop');
    expect((await collect()).records).toEqual([]);
    expect((await collect()).metrics.bytesRead).toBe(0);
    clock += 61_000;
    const records = [];
    for (let i = 0; i < 3; i++) records.push(...(await collect()).records);
    expect(records.some(row => row['event.name'] === 'llm.response')).toBe(true);
    expect(records.every(row => row['gen_ai.agent.parent.invocation.id'] === undefined)).toBe(true);
    collector.stop(); collector = new QoderTranscriptCollector({ dataDir: root, agentId: 'qoder', now: () => clock });
    expect((await collect()).records).toEqual([]);
  });

  it('does not interpret ordinary user text or unrelated background tools as Agent results', () => {
    const content = '<task-notification><tool-use-id>call</tool-use-id><status>completed</status><result>answer</result></task-notification>';
    expect(qoderTaskNotification({ type: 'user', message: { content } })).toBeUndefined();
    expect(qoderTaskNotification({ type: 'user', isMeta: true, origin: { kind: 'human' }, message: { content } })).toBeUndefined();
    expect(qoderTaskNotification({ type: 'user', isMeta: true, origin: { kind: 'task-notification' }, message: { content } })).toEqual({ callId: 'call', status: 'completed', result: 'answer' });
  });

  it('records distinct outgoing work for reused call IDs without guessing ambiguous child ownership', () => {
    const links = new QoderSubagentLinks();
    const source = { sessionId: session };
    const traces = { traceId: 'a'.repeat(32) };
    const row = model('dispatch', [{ type: 'tool_use', id: 'same-call', name: 'Agent', input: { prompt: 'private synthetic work' } }], 'tool_use');
    const invocations = [];
    for (const turnId of ['turn-a', 'turn-b']) {
      const checkpoint = { turnId, traceContext: traces };
      links.register(source, checkpoint, row);
      invocations.push(...links.decorate(source, checkpoint, [], [{ 'event.name': 'tool.call',
        'gen_ai.tool.call.id': 'same-call', 'gen_ai.tool.call.arguments': row.message.content[0].input }])
        .filter(event => event['event.name'] === 'gen_ai.agent.invoke'));
    }
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations.map(event => event['gen_ai.agent.invocation.id'])).size).toBe(2);
    expect(links.incoming({ ...source, subagentId: 'child' }, user('ambiguous', 'same-call'))).toBeUndefined();
    expect(JSON.stringify(links.state)).not.toContain('private synthetic work');
  });

  it('reclaims finished relations at capacity so new work continues', () => {
    const saved = {};
    for (let i = 1; i <= 4096; i++) {
      const id = i.toString(16).padStart(32, '0');
      saved[id] = { id, sessionId: session, agentId: session, callId: `call-${i}`, turnId: `turn-${i}`,
        traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), at: Date.now(), resultEmitted: true, childComplete: true };
    }
    const links = new QoderSubagentLinks(saved);
    const added = links.register({ sessionId: session }, { turnId: 'new-turn', traceContext: { traceId: 'c'.repeat(32) } },
      model('dispatch', [{ type: 'tool_use', id: 'new-call', name: 'Agent', input: { prompt: 'new task' } }], 'tool_use'));
    expect(added).toHaveLength(1);
    expect(Object.keys(links.state)).toHaveLength(4096);
    expect(links.find(session, 'new-call')).toBeDefined();
  });
});
