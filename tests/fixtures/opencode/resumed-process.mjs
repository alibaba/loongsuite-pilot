// Synthetic hook traffic through the real plugin in a fresh Node process.
import plugin from '../../../assets/plugins/opencode/plugin.mjs';

const hooks = await plugin.server({ directory: process.env.LOONGSUITE_PILOT_DATA_DIR }, {});
const sessionID = 'ses_resume_fixture';
const resumed = process.argv[2] === 'resume';
let time = Date.now() - 10_000;
const event = (type, properties) => hooks.event({ event: { type, properties } });
await hooks['chat.message']({ sessionID }, {
  message: { id: resumed ? 'user_second' : 'user_first', model: { providerID: 'openai', modelID: 'fixture-model' } },
  parts: [{ type: 'text', text: resumed ? 'Update the fixture' : 'Hello' }],
});
const steps = resumed ? [['read'], ['write', 'edit'], []] : [[]];
for (const [index, tools] of steps.entries()) {
  const messageID = `${resumed ? 'second' : 'first'}_${index}`;
  await event('message.part.updated', { sessionID, time: time += 100,
    part: { type: 'step-start', messageID } });
  for (const tool of tools) {
    const callID = `call_${messageID}_${tool}`;
    const start = time += 10;
    const part = { type: 'tool', messageID, callID, tool };
    await event('message.part.updated', { sessionID, part: { ...part,
      state: { status: 'running', input: { filePath: 'fixture.txt' }, time: { start } } } });
    await event('message.part.updated', { sessionID, part: { ...part,
      state: { status: 'completed', output: `${tool} completed`, time: { start, end: time += 20 } } } });
  }
  await event('message.updated', { info: { role: 'assistant', sessionID, id: messageID,
    modelID: 'fixture-model', providerID: 'openai', time: { completed: time += 10 },
    tokens: { input: 10, output: 2 } } });
}
await event('session.idle', { sessionID });
