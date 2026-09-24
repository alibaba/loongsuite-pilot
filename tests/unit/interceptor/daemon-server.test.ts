import { describe, expect, it } from 'vitest';
import { createInterceptorServer } from '../../../src/interceptor/daemon/server.js';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import type { InterceptorAccessLogEntry } from '../../../src/interceptor/access-log.js';
import { wrapHostReason } from '../../../src/interceptor/adapters/reason.js';
import { INTERCEPTOR_SERVICE, type LocalRule } from '../../../src/interceptor/types.js';
import type { ToolVerdictAction, ToolVerdictKey } from '../../../src/interceptor/tool-verdict-store.js';

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
          result: 'deny',
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
        result: 'deny',
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
});
