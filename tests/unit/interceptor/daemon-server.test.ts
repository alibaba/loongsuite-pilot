import { describe, expect, it } from 'vitest';
import { createInterceptorServer } from '../../../src/interceptor/daemon/server.js';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import type { InterceptorAccessLogEntry } from '../../../src/interceptor/access-log.js';
import { wrapHostReason } from '../../../src/interceptor/adapters/reason.js';
import { INTERCEPTOR_SERVICE, type HookRequest, type LocalRule } from '../../../src/interceptor/types.js';
import type { ToolVerdictAction, ToolVerdictKey } from '../../../src/interceptor/tool-verdict-store.js';
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
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictAction }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['demo'])),
      writeAccessLog: (entry: InterceptorAccessLogEntry) => {
        access.push(entry);
      },
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictAction) => {
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
          result: 'allow',
        },
        {
          key: {
            sessionId: 'open-session',
            toolUseId: 'open-pre-1',
            phase: 'PreToolUse',
          },
          result: 'block',
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
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictAction }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['demo'])),
      writeAccessLog: (entry: InterceptorAccessLogEntry) => {
        access.push(entry);
      },
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictAction) => {
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
        result: 'block',
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
    const verdicts: Array<{ key: ToolVerdictKey; result: ToolVerdictAction }> = [];
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], new Set(['boom'])),
      writeAccessLog: () => undefined,
      writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictAction) => {
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
});
