import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { ClientType } from '../../src/types/index.js';
import { expectTurnStrategyParity } from '../helpers/turn-strategy-parity.js';
import { fixture as qwenFixture } from '../unit/hooks/qwen-code-cli/subagent-fixture.mjs';
import { assembleTurn } from '../../assets/hooks/cursor/react-assembler.mjs';
import { QoderCnInput } from '../../src/inputs/qoder-cn/qoder-cn-input.js';
import { QoderWorkInput } from '../../src/inputs/qoder-work/qoder-work-input.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const roots: string[] = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 3));
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-producer-strategy-')); roots.push(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', dir);
  vi.stubEnv('LOONGSUITE_USER_ID', 'synthetic-strategy-user');
  return dir;
}
function logs(dir: string, agent: string): AgentActivityEntry[] {
  const folder = path.join(dir, 'logs', agent);
  return fs.readdirSync(folder).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(folder, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
afterEach(() => { vi.unstubAllEnvs(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Additional shipped producers through the shared Pilot executor', () => {
  it('preserves the legacy Qoder CN IDE file-activity path', async () => {
    const dir = root();
    const history = path.join(dir, 'User', 'History', 'synthetic');
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, 'entries.json'), JSON.stringify({ resource: '/synthetic/file.ts',
      entries: [{ id: 'synthetic-edit', timestamp: Date.now(), source: 'qoder-completion' }] }));
    const input = new QoderCnInput({ stateStore: new MockStateStore() as any, dataRoot: dir,
      snapshotStorePath: path.join(dir, 'snapshot.json'), pollIntervalMs: 60_000 });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    try { await input.start(); } finally { await input.stop(); }
    expect(entries).toHaveLength(1);
    const parity = await expectTurnStrategyParity(entries, 'qoder-cn-legacy-ide-file-activity');
    expect(parity.currentKinds).toEqual({ AGENT: 1, ENTRY: 1 });
    expect(parity.decisions.every(choice => !choice.streamed)).toBe(true);
  });

  it.each([ClientType.QoderWork, ClientType.QoderWorkCN])('preserves the legacy %s Hook file-activity path', async agentType => {
    const dir = root();
    const today = new Date().toLocaleDateString('sv-SE');
    const logPrefix = agentType === ClientType.QoderWorkCN ? 'qoder-work-cn' : 'qoder-work';
    fs.writeFileSync(path.join(dir, `${logPrefix}-${today}.jsonl`), JSON.stringify({
      event_type: 'PostToolUse', tool_name: 'write_to_file', tool_input: { file_path: '/synthetic/file.ts', content: 'hello' },
      session_id: 'synthetic-session', user_id: 'synthetic-user', timestamp: Date.now(),
    }) + '\n');
    const input = new QoderWorkInput({ stateStore: new MockStateStore() as any, agentType, logDir: dir,
      logPrefix, pollIntervalMs: 60_000 });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    try { await input.start(); } finally { await input.stop(); }
    expect(entries).toHaveLength(1);
    const parity = await expectTurnStrategyParity(entries, `${logPrefix}-legacy-hook-file-activity`);
    expect(parity.currentKinds).toEqual({ AGENT: 1, ENTRY: 1 });
    expect(parity.decisions.every(choice => !choice.streamed)).toBe(true);
  });

  it.each(['cursor', 'cursor-cli'])('uses the actual %s hook assembler', async variant => {
    const time = Date.parse('2026-11-04T00:00:00Z');
    const event = (hook: string, delta: number, data = {}) => ({ _journal_ts: new Date(time + delta).toISOString(),
      hook_event: hook, conversation_id: 'synthetic-cursor', generation_id: 'synthetic-generation', model: 'synthetic-model', ...data });
    const { records } = assembleTurn([
      event('beforeSubmitPrompt', 0, { prompt: 'inspect a synthetic file', workspace_roots: ['/synthetic-project'] }),
      event('afterAgentThought', 100, { text: 'read the file', duration_ms: 50 }),
      event('preToolUse', 120, { tool_name: 'Read', tool_use_id: 'read-1', tool_input: { path: 'sample.json' } }),
      event('postToolUse', 180, { tool_name: 'Read', tool_use_id: 'read-1', tool_output: 'synthetic result', duration_ms: 60 }),
      event('afterAgentResponse', 250, { text: 'done' }), event('stop', 300),
    ], { stopConversationId: 'synthetic-cursor', variant });
    const parity = await expectTurnStrategyParity(records, `${variant}-native-hook-assembler`);
    expect(parity.currentKinds.LLM).toBeGreaterThan(0);
    expect(parity.currentKinds.TOOL).toBe(1);
  });

  it.each([false, true])('runs Pi extension native callbacks (custom identity=%s)', async custom => {
    const dir = root();
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const mod = await import(pathToFileURL(path.resolve('assets/plugins/pi-coding-agent/index.mjs')).href + '?impact=' + Date.now());
    const identity = custom ? { agentType: 'synthetic-pi-sdk-agent', agentId: 'custom', agentName: 'Synthetic PI SDK Agent',
      agentSystem: 'pi', framework: 'pi-coding-agent' } : undefined;
    (identity ? mod.createPiTelemetryExtension(identity) : mod.default)({
      on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
      getActiveTools: () => ['read'], getAllTools: () => [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    });
    const ctx = { cwd: dir, model: { provider: 'anthropic', id: 'synthetic-model' },
      sessionManager: { getSessionId: () => 'synthetic-pi-session' } };
    const emit = async (name: string, event = {}) => { await handlers.get(name)?.({ type: name, ...event }, ctx); await pause(); };
    await emit('session_start', { reason: 'startup' });
    await emit('before_agent_start', { prompt: 'Inspect the fixture', systemPrompt: 'Synthetic instructions' });
    const history: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Inspect the fixture' }] }];
    for (let index = 0; index < 3; index++) {
      await emit('turn_start', { turnIndex: index, timestamp: Date.now() });
      await emit('context', { messages: history });
      const message = { role: 'assistant', provider: 'anthropic', model: 'synthetic-model', responseId: `pi-response-${index}`,
        stopReason: index === 2 ? 'stop' : 'toolUse', timestamp: Date.now(),
        content: index === 2 ? [{ type: 'text', text: 'done' }]
          : [{ type: 'toolCall', id: `pi-tool-${index}`, name: 'read', arguments: { index } }],
        usage: { input: 100 + index, output: 10, cacheRead: 5, cacheWrite: 2, totalTokens: 117 + index },
      };
      await emit('message_end', { message }); history.push(message);
      if (index < 2) {
        await emit('tool_execution_start', { toolCallId: `pi-tool-${index}`, toolName: 'read', args: { index } });
        const result = { content: [{ type: 'text', text: `result-${index}` }] };
        await emit('tool_execution_end', { toolCallId: `pi-tool-${index}`, toolName: 'read', result, isError: index === 1 });
        history.push({ role: 'toolResult', toolCallId: `pi-tool-${index}`, toolName: 'read', content: result.content, isError: index === 1 });
      }
      await emit('turn_end', { turnIndex: index, message, toolResults: [] });
    }
    await emit('agent_end', { messages: history });
    const parity = await expectTurnStrategyParity(logs(dir, 'pi-coding-agent'), custom ? 'pi-sdk-custom-producer' : 'pi-coding-agent-producer');
    expect(parity.currentKinds.LLM).toBe(3); expect(parity.currentKinds.TOOL).toBe(2);
    expect(parity.decisions.every(choice => choice.streamed)).toBe(true);
  });

  it.each(['plugin_events', 'interrupted_turn_events'])('runs the MiMo plugin with native fixture %s', async fixture => {
    const dir = root();
    const plugin = (await import(pathToFileURL(path.resolve('assets/plugins/mimo-code/plugin.mjs')).href + '?impact=' + Date.now())).default;
    const hooks = await plugin.server({ sessionID: 'synthetic-mimo', cwd: dir }, {});
    const events = fs.readFileSync(path.resolve(`tests/unit/hooks/mimo-code/fixtures/${fixture}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    for (const event of events) { await hooks.event({ event }); await pause(); }
    const parity = await expectTurnStrategyParity(logs(dir, 'mimo-code'), 'mimo-native-' + fixture);
    expect(parity.currentKinds.LLM).toBeGreaterThan(0);
  });

  it('keeps Qwen foreground inline children on the batch executor', async () => {
    const dir = root();
    const native = qwenFixture(dir).run();
    const entries: AgentActivityEntry[] = [];
    for (const record of native) {
      const entry = await transformHookRecord(record, ClientType.QwenCodeCli, 'qwen-code-cli');
      if (entry) entries.push(entry);
    }
    const parity = await expectTurnStrategyParity(entries, 'qwen-cli-native-inline-children');
    expect(parity.currentKinds.LLM).toBe(5);
    expect(parity.currentKinds.AGENT).toBe(3);
    expect(parity.decisions.every(choice => !choice.streamed)).toBe(true);
  });

  it('streams the ordinary Qwen foreground native transcript', async () => {
    const dir = root();
    const f = qwenFixture(dir);
    fs.rmSync(f.children, { recursive: true, force: true });
    const entries: AgentActivityEntry[] = [];
    for (const record of f.run()) {
      const entry = await transformHookRecord(record, ClientType.QwenCodeCli, 'qwen-code-cli');
      if (entry) entries.push(entry);
    }
    const parity = await expectTurnStrategyParity(entries, 'qwen-cli-native-foreground');
    expect(parity.currentKinds.LLM).toBe(2);
    expect(parity.decisions.every(choice => choice.streamed)).toBe(true);
  });
});
