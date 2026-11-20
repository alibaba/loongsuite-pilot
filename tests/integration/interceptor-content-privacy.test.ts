import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputManager } from '../../src/core/input-manager.js';
import { InterceptResultLinker } from '../../src/core/intercept-result-linker.js';
import { ManagedRuleEngine } from '../../src/interceptor/managed/engine.js';
import { ShScriptRunner } from '../../src/interceptor/managed/sh-runner.js';
import { buildBlockedQoderPromptEntry } from '../../src/interceptor/blocked-prompt.js';
import { guardrailSnapshotFromVerdict } from '../../src/interceptor/guardrail.js';
import { ToolVerdictStore } from '../../src/interceptor/tool-verdict-store.js';
import { CollectionMethod } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import type { ManagedScriptRule } from '../../src/interceptor/managed/config.js';

const secret = 'Confidential customer acquisition terms: discount 37 percent';

describe.skipIf(process.platform === 'win32')('script reason content privacy', () => {
  it.each([
    { capture: false, action: 'block' as const }, { capture: true, action: 'block' as const },
    { capture: false, action: 'log' as const }, { capture: true, action: 'log' as const },
  ])('applies captureMessageContent=$capture to $action linked tools and blocked prompts', async ({ capture, action }) => {
    const root = await mkdtemp(join(tmpdir(), 'interceptor-content-'));
    const runner = new ShScriptRunner();
    const manager = new InputManager();
    const output = new MockFlusher();
    manager.setFlusher(output);
    manager.setAgentsConfig({ qoder: { captureMessageContent: capture } });
    manager.setMaskConfig({ mode: 'all', types: [] });
    const file = join(root, 'echo.sh');
    const node = `'${process.execPath.replace(/'/g, "'\\''")}'`;
    await writeFile(file, `exec ${node} -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify({matched:true,reason:JSON.parse(s).prompt})));'\n`);
    const rule: ManagedScriptRule = { kind: 'script', id: 'business-policy', version: '2', shell: 'sh',
      agents: ['qodercli'], events: ['PreToolUse', 'UserPromptSubmit'], action };
    const engine = new ManagedRuleEngine({ config: { rules: [rule] },
      rules: [{ rule, file, shell: 'sh' }], runners: { sh: runner } });
    try {
      const request = { agent: 'qodercli' as const, event: 'PreToolUse' as const,
        sessionId: 'private-session', toolUseId: 'private-tool', prompt: secret, raw: {} };
      const verdict = await engine.evaluate(request);
      expect(verdict.reason).toBe(secret);
      const prompt = action === 'block'
        ? [buildBlockedQoderPromptEntry({ ...request, event: 'UserPromptSubmit' }, Date.now(), verdict)] : [];
      await manager.flushPreparedEntries(prompt);

      const store = new ToolVerdictStore(join(root, 'verdicts.json'));
      store.put({ sessionId: request.sessionId, toolUseId: request.toolUseId, phase: 'PreToolUse' },
        guardrailSnapshotFromVerdict(verdict));
      manager.setInterceptResultLinker(new InterceptResultLinker(store, true));
      const input = Object.assign(new EventEmitter(), {
        id: 'qoder-tools', agentType: 'qoder', collectionMethod: CollectionMethod.HookJsonl,
        running: false, setWorkspacePolicy() {}, async stop() {},
      });
      manager.registerInput(input as any);
      input.emit('entries', [buildTestEntry({ 'event.name': 'tool.call', 'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.session.id': request.sessionId, 'gen_ai.tool.call.id': request.toolUseId })]);
      await manager.stopAll();

      const entries = output.batchCalls.flat().filter(entry => entry['gen_ai.guardrail.rule_id'] === rule.id);
      expect(entries.map(entry => entry['event.name']).sort()).toEqual(action === 'block'
        ? ['llm.request', 'tool.call'] : ['tool.call']);
      for (const entry of entries) {
        expect(entry).toMatchObject({ 'gen_ai.guardrail.action': action,
          'gen_ai.guardrail.rule_id': rule.id, 'gen_ai.guardrail.rule_version': rule.version });
        for (const field of ['reason', 'message', 'matched', 'enforcement', 'title', 'severity', 'match']) {
          expect(entry).not.toHaveProperty(`gen_ai.guardrail.${field}`);
        }
        if (!capture) expect(JSON.stringify(entry)).not.toContain(secret);
      }
    } finally {
      runner.stop();
      await manager.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});
