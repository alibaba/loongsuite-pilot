import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('../../../../assets/plugins/shared/raw-jsonl-writer.mjs', () => ({
  appendRawJsonl: (dest, line) => fs.appendFileSync(dest, line),
}));

it('does not give an old native user message a second carrier-bearing turn after idle', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-invoke-attr-'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', directory);
  try {
    const { default: plugin } = await import('../../../../assets/plugins/mimo-code/plugin.mjs');
    const hooks = await plugin.server({ directory }, {});
    const sessionID = 'ses_invocation_probe';
    const user = id => ({ sessionID, id, role: 'user' });
    const input = id => hooks['chat.message']({ sessionID, messageID: id },
      { message: user(id), parts: [{ type: 'text', text: 'identical input' }] });
    const event = (type, properties) => hooks.event({ event: { type, properties } });
    const replay = id => event('message.updated', { info: user(id) });
    const idle = () => event('session.idle', { sessionID });

    await input('msg_A');
    await idle();
    await replay('msg_A'); // Same late user event that the native 0.1.17 reproducer observed.
    await input('msg_B');
    await replay('msg_A'); // An old id must not replace the newer active turn.
    await replay('msg_B');
    await idle();
    await replay('msg_B');
    await replay('msg_C'); // Native fallback remains valid for a distinct new message.

    const logDir = path.join(directory, 'logs', 'mimo-code');
    const rows = fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n').map(JSON.parse));
    expect(rows.map(row => [row['pilot.invocation.native_message_id'], row['gen_ai.turn.id']]))
      .toEqual([['msg_A', sessionID + ':t1'], ['msg_B', sessionID + ':t2'], ['msg_C', sessionID + ':t3']]);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
