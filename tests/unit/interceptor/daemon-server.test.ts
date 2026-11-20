import { describe, expect, it } from 'vitest';
import { createInterceptorServer } from '../../../src/interceptor/daemon/server.js';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import type { InterceptorAccessLogEntry } from '../../../src/interceptor/access-log.js';
import { wrapHostReason } from '../../../src/interceptor/adapters/reason.js';
import { INTERCEPTOR_SERVICE, type HookRequest, type LocalRule, type EvaluateHookResponse } from '../../../src/interceptor/types.js';
import { ToolVerdictStore, type ToolVerdictKey, type ToolVerdictSnapshot, type PromptVerdictKey, type PromptVerdictSnapshot } from '../../../src/interceptor/tool-verdict-store.js';
import { promptHash, promptRequestId } from '../../../src/interceptor/prompt-verdict.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

describe('interceptor daemon HTTP API', () => {
  it('observes all prompt attempts but only finalizes known allowed verdicts, retaining log evidence on fail-open', async () => {
    const records: Array<{ key: PromptVerdictKey; snapshot: PromptVerdictSnapshot }> = [];
    let verdict: EvaluateHookResponse = { action: 'allow', matched: true, ruleId: 'log-policy', ruleVersion: '4', evaluatedRules: [] };
    const server = createInterceptorServer({ port: 0, version: 'test',
      engine: { evaluate: async () => verdict },
      writePromptVerdict: (key, snapshot) => { records.push({ key, snapshot }); },
    });
    const port = await listen(server);
    const post = async (extra: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'qodercli', event: 'UserPromptSubmit', sessionId: 'session',
          prompt: 'synthetic prompt', raw: { request_set_id: 'host-id' }, ...extra }),
      });
      return response.json();
    };
    try {
      expect(await post()).toMatchObject({ action: 'allow' });
      expect(records[0].snapshot).toEqual({ action: 'unknown' });
      expect(records[1]).toMatchObject({ key: { phase: 'UserPromptSubmit', sessionId: 'session',
        agentType: 'qoder-cli', requestId: promptRequestId('host-id'), promptHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        snapshot: { action: 'log', ruleId: 'log-policy', ruleVersion: '4' } });
      expect(JSON.stringify(records)).not.toContain('synthetic prompt');
      expect(JSON.stringify(records)).not.toContain('host-id');
      verdict = { ...verdict, failOpen: true };
      await post();
      expect(records[3].snapshot).toMatchObject({ action: 'log', failOpen: true });
      verdict = { action: 'allow', matched: false, evaluatedRules: [] };
      await post();
      expect(records[5].snapshot).toEqual({ action: 'allow' });
      verdict = { action: 'allow', failOpen: true, evaluatedRules: [] };
      await post();
      verdict = { action: 'block', matched: true, evaluatedRules: [] };
      expect(await post()).toMatchObject({ action: 'block' });
      verdict = { action: 'allow', matched: true, evaluatedRules: [] };
      await post({ event: 'PreToolUse', toolUseId: 'tool' });
      await post({ sessionId: undefined });
      expect(records.slice(6).map(record => record.snapshot)).toEqual([{ action: 'unknown' }, { action: 'unknown' }]);
      expect(records).toHaveLength(8);
    } finally { server.close(); }
  });

  it.each(['qodercli', 'qwen-work-cn'] as const)('does not borrow an older log when a repeated %s prompt is pending or fails without a request id', async agent => {
    const store = new ToolVerdictStore('/tmp/unused-server-prompt-verdicts.json');
    const prompt = 'repeated synthetic prompt';
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const observed: PromptVerdictKey[] = [];
    const server = createInterceptorServer({ port: 0, version: 'test',
      engine: { evaluate: async () => {
        if (++calls === 1) return { action: 'allow', matched: true, ruleId: 'old', ruleVersion: '1', evaluatedRules: [] };
        started();
        await pending;
        throw new Error('synthetic evaluator failure');
      } },
      writePromptVerdict: (key, snapshot) => { observed.push(key); store.put(key, snapshot); },
    });
    const port = await listen(server);
    const endpoint = agent === 'qodercli' ? '/v1/hooks/evaluate' : '/v1/hooks/qwenwork';
    const payload = agent === 'qodercli'
      ? { agent, event: 'UserPromptSubmit', sessionId: 'session', prompt, raw: {} }
      : { hook_event_name: 'UserPromptSubmit', session_id: 'session', prompt };
    const post = () => fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const lookup = { sessionId: 'session', agentType: agent === 'qodercli' ? 'qoder-cli' : agent,
      promptHash: promptHash(prompt), at: Date.now() };
    try {
      expect((await post()).status).toBe(200);
      expect(store.getPromptSnapshot(lookup)).toMatchObject({ action: 'log', ruleId: 'old' });
      const failed = post();
      await entered;
      expect(store.getPromptSnapshot(lookup)).toBeNull();
      release();
      expect((await failed).status).toBe(agent === 'qodercli' ? 500 : 200);
      expect(store.getPromptSnapshot(lookup)).toBeNull();
      expect(store.records().map(record => record.action).sort()).toEqual(['log', 'unknown']);
      expect(observed[0].requestId).toBe(observed[1].requestId); // One generated key for begin/final.
      expect(observed[2].requestId).not.toBe(observed[0].requestId);
      expect(store.getPromptSnapshot({ ...lookup, requestId: observed[0].requestId }))
        .toMatchObject({ action: 'log', ruleId: 'old' });
      expect(store.getPromptSnapshot({ ...lookup, requestId: observed[2].requestId })).toBeNull();
    } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it.each([undefined, null])('preserves only blocked prompt delivery for managed hits when raw is %s', async raw => {
    const entries: AgentActivityEntry[] = [];
    const match = { matched: true as const, action: 'block' as const,
      ruleId: 'managed-rule', ruleVersion: '1', reason: 'blocked' };
    const server = createInterceptorServer({
      port: 0,
      version: 'test',
      engine: { evaluate: async () => ({ ...match, matches: [match] }) },
      writeAccessLog: () => undefined,
      emitBlockedPrompt: entry => { entries.push(entry); },
    });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'qoder', event: 'UserPromptSubmit',
          sessionId: 'session', prompt: 'blocked prompt', raw }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ action: 'block' });
      expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request']);
      expect(entries.map(entry => entry['gen_ai.agent.type'])).toEqual(['qoder-cli']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('serves health and writes access logs for allow and block', async () => {
    const rule: LocalRule = {
      id: 'demo',
      supports: () => true,
      evaluate: async (request) => (
        request.prompt === 'secret'
          || (request.toolInput && typeof request.toolInput === 'object'
            && (request.toolInput as { command?: string }).command === 'secret')
          ? { matched: true, reason: 'blocked by demo' }
          : { matched: false }
      ),
    };
    const access: InterceptorAccessLogEntry[] = [];
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictSnapshot }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['demo'])),
      writeAccessLog: (entry: InterceptorAccessLogEntry) => {
        access.push(entry);
      },
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictSnapshot) => {
        verdicts.push({ key, result });
      },
    };
    const server = createInterceptorServer(opts);
    const port = await listen(server);
    opts.port = port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(health.json()).resolves.toMatchObject({
        service: INTERCEPTOR_SERVICE,
        status: 'ok',
        version: '1.2.3',
        daemon_port: port,
      });

      const allowed = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qoder',
          event: 'PostToolUse',
          prompt: 'hello',
          toolName: 'Bash',
          toolResponse: { stdout: 'ok' },
          toolUseId: 'qoder-post-1',
          sessionId: 'qoder-session',
          raw: { hook_event_name: 'PostToolUse' },
        }),
      });
      await expect(allowed.json()).resolves.toMatchObject({ action: 'allow' });

      const blocked = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qoder',
          event: 'UserPromptSubmit',
          prompt: 'secret',
          raw: {},
        }),
      });
      await expect(blocked.json()).resolves.toMatchObject({
        action: 'block',
        reason: 'blocked by demo',
        ruleId: 'demo',
      });

      const openclaw = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'openclaw',
          event: 'PreToolUse',
          toolName: 'exec',
          toolInput: { command: 'secret' },
          toolUseId: 'open-pre-1',
          sessionId: 'open-session',
          raw: { openclaw_hook: 'before_tool_call' },
        }),
      });
      await expect(openclaw.json()).resolves.toMatchObject({
        action: 'block',
        reason: 'blocked by demo',
        ruleId: 'demo',
      });

      expect(access).toHaveLength(3);
      expect(access[0]).toMatchObject({
        event: 'PostToolUse',
        input: { prompt: 'hello', toolName: 'Bash', toolResponse: { stdout: 'ok' } },
        result: { action: 'allow' },
      });
      expect(access[1]).toMatchObject({
        event: 'UserPromptSubmit',
        input: { prompt: 'secret' },
        result: { action: 'block', reason: 'blocked by demo', ruleId: 'demo' },
      });
      expect(access[2]).toMatchObject({
        event: 'PreToolUse',
        agent: 'openclaw',
        result: { action: 'block', reason: 'blocked by demo', ruleId: 'demo' },
      });
      expect(verdicts).toEqual([
        {
          key: {
            sessionId: 'qoder-session',
            toolUseId: 'qoder-post-1',
            phase: 'PostToolUse',
          },
          result: { action: 'allow' },
        },
        {
          key: {
            sessionId: 'open-session',
            toolUseId: 'open-pre-1',
            phase: 'PreToolUse',
          },
          result: { action: 'block', ruleId: 'demo' },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('serves QwenWork HTTP hooks as 200 control JSON and fail-opens with {}', async () => {
    const rule: LocalRule = {
      id: 'demo',
      supports: () => true,
      evaluate: async (request) => (
        request.prompt === 'secret' || request.toolName === 'Bash'
          ? { matched: true, reason: '[APIKEY_MASKED]' }
          : { matched: false }
      ),
    };
    const access: InterceptorAccessLogEntry[] = [];
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictSnapshot }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['demo'])),
      writeAccessLog: (entry: InterceptorAccessLogEntry) => {
        access.push(entry);
      },
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictSnapshot) => {
        verdicts.push({ key, result });
      },
    };
    const server = createInterceptorServer(opts);
    const port = await listen(server);
    opts.port = port;
    try {
      const blocked = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'UserPromptSubmit',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'secret',
          session_id: 'session-xxxx',
        }),
      });
      expect(blocked.status).toBe(200);
      await expect(blocked.json()).resolves.toEqual({
        decision: 'block',
        reason: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
      });

      const preBlocked = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'PreToolUse',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'id' },
          tool_use_id: 'qwen-pre-1',
          session_id: 'qwen-session',
        }),
      });
      expect(preBlocked.status).toBe(200);
      await expect(preBlocked.json()).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: wrapHostReason('PreToolUse', '[APIKEY_MASKED]'),
        },
      });

      const malformed = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(malformed.status).toBe(200);
      await expect(malformed.json()).resolves.toEqual({});

      const allowed = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'hello',
        }),
      });
      expect(allowed.status).toBe(200);
      await expect(allowed.json()).resolves.toEqual({});

      const skipped = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'Stop' }),
      });
      expect(skipped.status).toBe(200);
      await expect(skipped.json()).resolves.toEqual({});
      expect(access.at(-1)).toMatchObject({
        result: { action: 'fail-open', error: 'unsupported hook event' },
      });
      expect(verdicts).toContainEqual({
        key: {
          sessionId: 'qwen-session',
          toolUseId: 'qwen-pre-1',
          phase: 'PreToolUse',
        },
        result: { action: 'block', ruleId: 'demo' },
      });
    } finally {
      server.close();
    }
  });

  it('does not store a verdict when a rule throws and still fail-opens the host', async () => {
    const rule: LocalRule = {
      id: 'boom',
      supports: () => true,
      evaluate: async () => {
        throw new Error('rule failed');
      },
    };
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictSnapshot }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['boom'])),
      writeAccessLog: () => undefined,
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictSnapshot) => {
        verdicts.push({ key, result });
      },
    };
    const server = createInterceptorServer(opts);
    const port = await listen(server);
    opts.port = port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qodercli',
          event: 'PreToolUse',
          toolName: 'Bash',
          toolUseId: 'cli-pre-1',
          sessionId: 'cli-session',
          raw: {},
        }),
      });
      await expect(response.json()).resolves.toMatchObject({
        action: 'allow',
        failOpen: true,
      });
      expect(verdicts).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('emits an llm.request only for a denied Qoder user prompt', async () => {
    const rule: LocalRule = {
      id: 'demo',
      supports: () => true,
      evaluate: async (request) => (
        request.prompt === 'secret'
          ? { matched: true, reason: 'blocked by demo' }
          : { matched: false }
      ),
    };
    const emitted: AgentActivityEntry[] = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['demo'])),
      writeAccessLog: () => undefined,
      emitBlockedPrompt: (entry: AgentActivityEntry) => {
        emitted.push(entry);
      },
    };
    const server = createInterceptorServer(opts);
    const port = await listen(server);
    opts.port = port;

    async function post(body: HookRequest) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<{ action?: string; failOpen?: boolean }>;
    }

    try {
      await expect(post({
        agent: 'qoder',
        event: 'UserPromptSubmit',
        prompt: 'secret',
        sessionId: 's-desktop',
        cwd: '/tmp/desktop',
        raw: {},
      })).resolves.toMatchObject({ action: 'block' });
      await expect(post({
        agent: 'qodercli',
        event: 'UserPromptSubmit',
        prompt: 'secret',
        sessionId: 's-cli',
        raw: {},
      })).resolves.toMatchObject({ action: 'block' });
      await expect(post({
        agent: 'qoder',
        event: 'UserPromptSubmit',
        prompt: 'hello',
        raw: {},
      })).resolves.toMatchObject({ action: 'allow' });
      await expect(post({
        agent: 'qoder',
        event: 'PreToolUse',
        prompt: 'secret',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        raw: {},
      })).resolves.toMatchObject({ action: 'block' });
      await expect(post({
        agent: 'openclaw',
        event: 'UserPromptSubmit',
        prompt: 'secret',
        raw: {},
      })).resolves.toMatchObject({ action: 'block' });

      expect(emitted).toHaveLength(2);
      expect(emitted[0]).toMatchObject({
        'event.name': 'llm.request',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.session.id': 's-desktop',
        'workspace.path': '/tmp/desktop',
        'agent.source': 'interceptor',
        'gen_ai.guardrail.action': 'block',
        'gen_ai.guardrail.rule_id': 'demo',
      });
      expect(emitted[1]).toMatchObject({
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.session.id': 's-cli',
        'gen_ai.guardrail.triggered': true,
      });
      expect(emitted[1]['workspace.path']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('does not emit when evaluation fail-opens, and a sink error still blocks the host', async () => {
    const throwing: LocalRule = {
      id: 'boom',
      supports: () => true,
      evaluate: async () => {
        throw new Error('rule failed');
      },
    };
    const emitted: AgentActivityEntry[] = [];
    const failOpenServer = createInterceptorServer({
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([throwing], new Set(['boom'])),
      writeAccessLog: () => undefined,
      emitBlockedPrompt: (entry) => {
        emitted.push(entry);
      },
    });
    const failOpenPort = await listen(failOpenServer);
    try {
      const response = await fetch(`http://127.0.0.1:${failOpenPort}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qodercli',
          event: 'UserPromptSubmit',
          prompt: 'secret',
          raw: {},
        }),
      });
      await expect(response.json()).resolves.toMatchObject({ action: 'allow', failOpen: true });
      expect(emitted).toEqual([]);
    } finally {
      failOpenServer.close();
    }

    const blocking: LocalRule = {
      id: 'demo',
      supports: () => true,
      evaluate: async () => ({ matched: true, reason: 'blocked by demo' }),
    };
    const server = createInterceptorServer({
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([blocking], new Set(['demo'])),
      writeAccessLog: () => undefined,
      emitBlockedPrompt: () => {
        throw new Error('sink failed');
      },
    });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qoder',
          event: 'UserPromptSubmit',
          prompt: 'secret',
          raw: {},
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ action: 'block', ruleId: 'demo' });
    } finally {
      server.close();
    }
  });

  it('does not emit a blocked QwenWork user prompt', async () => {
    const emitted: AgentActivityEntry[] = [];
    const server = createInterceptorServer({
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([{
        id: 'demo',
        supports: () => true,
        evaluate: async () => ({ matched: true, reason: 'blocked by demo' }),
      }], new Set(['demo'])),
      writeAccessLog: () => undefined,
      emitBlockedPrompt: (entry) => {
        emitted.push(entry);
      },
    });
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'secret',
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ decision: 'block' });
      expect(emitted).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('fail-opens an oversized evaluate body and keeps qwen on HTTP 200', async () => {
    const server = createInterceptorServer({
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([], new Set()),
      writeAccessLog: () => undefined,
    });
    const port = await listen(server);
    const body = `{"prompt":"${'x'.repeat(5 * 1024 * 1024)}"}`;
    try {
      const evaluated = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(evaluated.status).toBe(200);
      await expect(evaluated.json()).resolves.toMatchObject({
        action: 'allow',
        failOpen: true,
      });

      const qwen = await fetch(`http://127.0.0.1:${port}/v1/hooks/qwenwork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(qwen.status).toBe(200);
      await expect(qwen.json()).resolves.toEqual({});
    } finally {
      server.close();
    }
  });
});
