import { pathToFileURL } from 'node:url';
const { setupV2 } = await import(pathToFileURL(process.argv[2]));
const methods = [async ({ cache, input }) => {
        const raw = [];
        const events = [];
        const now = Date.now() - 20000;
        const model = { id: 'gpt-test', providerID: 'openai' };
        const secret = 'sk-1234567890abcdefghijklmnop';
        const add = (type, data = {}) => events.push({
            id: `evt_synthetic_${events.length}`, type, created: now + events.length * 100,
            data: { sessionID: 'ses_synthetic', ...data },
        });
        add('session.execution.started');
        add('session.step.started', { assistantMessageID: 'msg_first', model, agent: 'build', started: now + 100 });
        for (const id of ['tool_a', 'tool_b']) {
            add('session.tool.input.started', { assistantMessageID: 'msg_first', id, name: 'read' });
            add('session.tool.called', { assistantMessageID: 'msg_first', id, input: { path: 'synthetic.txt' } });
        }
        add('session.step.streamed', { assistantMessageID: 'msg_first' });
        for (const id of ['tool_b', 'tool_a'])
            add('session.tool.success', { assistantMessageID: 'msg_first', id, content: [{ type: 'text', text: `synthetic result ${secret}` }] });
        const tokens = { input: 10, output: 5, reasoning: 0, ...(cache === undefined ? {} : { cache }) };
        add('session.step.ended', { assistantMessageID: 'msg_first', finish: 'tool-calls', tokens, cost: 0 });
        add('session.step.started', { assistantMessageID: 'msg_last', model, agent: 'build', started: now + events.length * 100 });
        add('session.text.ended', { assistantMessageID: 'msg_last', ordinal: 0, text: `synthetic answer ${secret}` });
        add('session.step.ended', { assistantMessageID: 'msg_last', finish: 'stop', tokens, cost: 0 });
        add('session.execution.succeeded');
        let done;
        const drained = new Promise(resolve => { done = resolve; });
        const cleanup = await setupV2({
            location: { directory: '/synthetic/project' },
            session: { hook: async (_name, cb) => { cb({ sessionID: 'ses_synthetic', system: [{ text: 'synthetic system' }], messages: [{ role: 'user', content: 'synthetic input' }] }); } },
            event: { async *subscribe() { for (const event of events)
                    yield event; done(); } },
        }, {
            common: (id, state) => ({
                'user.id': 'synthetic-user', 'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': id,
                'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId,
            }),
            writeRecord: (record) => raw.push(record), writeError: (where, error) => { throw new Error(`${where}: ${error}`); },
            inferProviderName: (id) => id, recordUpstreamEnvOnce() { },
        });
        await drained;
        cleanup();
        return raw;
    },
    async (terminal) => {
        const raw = [];
        const events = [];
        const now = Date.now() - 20000;
        const add = (type, data = {}) => events.push({
            id: `evt_parallel_${events.length}`, type, created: now + events.length * 100,
            data: { sessionID: 'ses_parallel', ...data },
        });
        add('session.execution.started');
        add('session.step.started', { assistantMessageID: 'msg_parallel', model: { id: 'gpt-test', providerID: 'openai' }, agent: 'build', started: now + 100 });
        for (const id of ['tool_a', 'tool_b']) {
            add('session.tool.input.started', { assistantMessageID: 'msg_parallel', id, name: 'read' });
            add('session.tool.called', { assistantMessageID: 'msg_parallel', id, input: { path: 'synthetic.txt' } });
        }
        add(terminal, terminal.endsWith('failed') ? { error: { name: 'APIError' } } : { reason: 'user' });
        let done;
        const drained = new Promise(resolve => { done = resolve; });
        const cleanup = await setupV2({
            location: { directory: '/synthetic/project' },
            session: { hook: async () => ({ dispose() { } }) },
            event: { async *subscribe() { for (const event of events)
                    yield event; done(); } },
        }, {
            common: (id, state) => ({
                'user.id': 'synthetic-user', 'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': id,
                'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId,
            }),
            writeRecord: (record) => raw.push(record),
            writeError: (where, error) => { throw new Error(`${where}: ${error}`); },
            inferProviderName: (id) => id, recordUpstreamEnvOnce() { },
        });
        await drained;
        cleanup();
        return raw;
    }];
const raw = await methods[Number(process.argv[3])](JSON.parse(process.argv[4]));
process.stdout.write(JSON.stringify(raw));
